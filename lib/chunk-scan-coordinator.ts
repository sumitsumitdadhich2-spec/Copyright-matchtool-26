import { getScan, saveScan, addLog, listScans } from './store'
import type { Scan } from './types'

/**
 * 1-second monitor interval for zero-delay chunk queue handoff.
 */
export const CHUNK_QUEUE_POLL_MS = 1000

export interface ChunkScanWaiter {
  scanId: string
  scanTitle: string
  ticket: number
  enqueuedAt: number
  resolve: (releaseFn: () => void) => void
  reject: (err: Error) => void
  onWait?: (msg: string, position: number, ticket: number, activeScanId: string | null) => void
  isStopping?: () => boolean
}

export interface ChunkScanQueueStatus {
  activeScanId: string | null
  activeScanTitle: string | null
  activeTicket: number | null
  activeSince: number | null
  queueLength: number
  waitingScans: Array<{
    scanId: string
    scanTitle: string
    ticket: number
    position: number
    enqueuedAt: number
    waitSec: number
  }>
  myPosition: number | null
  myTicket: number | null
}

export interface BlockingTicketInfo {
  scanId: string
  scanTitle: string
  ticket: number
  reason: string
}

interface GlobalCoordinatorState {
  nextTicketCounter: number
  ticketsByScanId: Map<string, number>
  skippedOrCompletedTickets: Set<string>
  activeKeySlotsByScanId: Map<string, number>
  activeAssignedKeysByScanId: Map<string, number[]>
  externalWindowCompletionChecker?: (scanId: string) => { done: boolean; reason?: string } | null
}

const gState: GlobalCoordinatorState = (() => {
  const g = globalThis as unknown as { __cmtCoordState?: GlobalCoordinatorState }
  if (!g.__cmtCoordState) {
    g.__cmtCoordState = {
      nextTicketCounter: 0,
      ticketsByScanId: new Map<string, number>(),
      skippedOrCompletedTickets: new Set<string>(),
      activeKeySlotsByScanId: new Map<string, number>(),
      activeAssignedKeysByScanId: new Map<string, number[]>(),
    }
  }
  return g.__cmtCoordState
})()

/**
 * Register a callback from StudioParallelManager so the 1s monitor can check
 * live in-memory window states without circular imports.
 */
export function registerParallelWindowCompletionChecker(
  checker: (scanId: string) => { done: boolean; reason?: string } | null,
): void {
  gState.externalWindowCompletionChecker = checker
}

export function registerSchedulerChunkChecker(
  _checker: (scanId: string) => boolean,
): void {
  // Handled by strict ticket + parallel window completion checker
}

function isScanTerminalOnDisk(scan: Scan | null | undefined): boolean {
  if (!scan) return true
  if (scan.status === 'done' || scan.status === 'stopped' || scan.status === 'error') {
    return true
  }
  if (scan.chunkWindowsDone || scan.pipelineStage === 'done' || scan.pipelineStage === 'stopped' || scan.pipelineStage === 'error') {
    return true
  }
  if (
    scan.geminiPrescan?.status === 'error' &&
    scan.status !== 'scanning' &&
    scan.status !== 'verifying'
  ) {
    return true
  }
  return false
}

function isScanActivelyInPipeline(scan: Scan | null | undefined): boolean {
  if (!scan) return false
  if (gState.skippedOrCompletedTickets.has(scan.id)) return false
  if (isScanTerminalOnDisk(scan)) return false
  const hasAssignedTicket = Boolean(
    (scan.chunkTicket && scan.chunkTicket > 0) || gState.ticketsByScanId.has(scan.id),
  )
  const hasPrescanActive = Boolean(
    scan.geminiPrescan &&
      (scan.geminiPrescan.status === 'preparing' ||
        scan.geminiPrescan.status === 'uploading' ||
        scan.geminiPrescan.status === 'scanning' ||
        scan.geminiPrescan.status === 'backup' ||
        scan.geminiPrescan.status === 'starting_scan'),
  )
  const isScanning =
    scan.status === 'chunking' || scan.status === 'scanning' || scan.status === 'verifying'
  const hasActivePipelineStage = Boolean(
    scan.pipelineStage &&
      scan.pipelineStage !== 'done' &&
      scan.pipelineStage !== 'stopped' &&
      scan.pipelineStage !== 'error' &&
      hasAssignedTicket,
  )
  return hasPrescanActive || isScanning || hasActivePipelineStage
}

/**
 * Assign a persistent ticket number `scan.chunkTicket = 1, 2, 3...` to a scan.
 * If no other scans are currently active in the pipeline when a new batch begins,
 * the ticket sequence starts cleanly at Ticket #1.
 */
export function ensureScanChunkTicket(scanId: string): number {
  const existingMem = gState.ticketsByScanId.get(scanId)
  const scan = getScan(scanId)
  if (scan?.chunkTicket && scan.chunkTicket > 0) {
    gState.ticketsByScanId.set(scanId, scan.chunkTicket)
    if (scan.chunkTicket > gState.nextTicketCounter) {
      gState.nextTicketCounter = scan.chunkTicket
    }
    return scan.chunkTicket
  }
  if (existingMem && existingMem > 0) {
    if (scan) {
      scan.chunkTicket = existingMem
      saveScan(scan)
    }
    return existingMem
  }

  // Check if any OTHER scan is currently active in the pipeline
  const allSummaries = listScans()
  let maxActiveTicket = 0
  let anyOtherActive = false
  for (const sum of allSummaries) {
    if (sum.id === scanId) continue
    const s = getScan(sum.id)
    if (isScanActivelyInPipeline(s)) {
      anyOtherActive = true
      const t = s?.chunkTicket || gState.ticketsByScanId.get(sum.id) || 0
      if (t > maxActiveTicket) maxActiveTicket = t
    }
  }
  // Also check in-memory tickets for scans that just started in the same millisecond
  for (const [otherId, t] of gState.ticketsByScanId.entries()) {
    if (otherId === scanId) continue
    if (gState.skippedOrCompletedTickets.has(otherId)) continue
    const s = getScan(otherId)
    if (s && !isScanTerminalOnDisk(s)) {
      anyOtherActive = true
      if (t > maxActiveTicket) maxActiveTicket = t
    }
  }

  if (!anyOtherActive && globalChunkScanCoordinator.getStatus().activeScanId === null && !globalChunkScanCoordinator.hasWaitingScans()) {
    gState.nextTicketCounter = 0
    gState.ticketsByScanId.clear()
    gState.skippedOrCompletedTickets.clear()
  }

  const nextTicket = Math.max(gState.nextTicketCounter, maxActiveTicket) + 1
  gState.nextTicketCounter = nextTicket
  gState.ticketsByScanId.set(scanId, nextTicket)
  gState.skippedOrCompletedTickets.delete(scanId)

  if (scan) {
    scan.chunkTicket = nextTicket
    saveScan(scan)
  }
  return nextTicket
}

/**
 * Allocate the lowest free API key-pair slot to an active scan:
 *   Slot #1 -> Keys [1, 2] (0-based indices 0, 1)
 *   Slot #2 -> Keys [3, 4] (0-based indices 2, 3)
 *   Slot #3 -> Keys [5, 6] (0-based indices 4, 5)
 */
export function allocateScanKeyPair(
  scanId: string,
  forceReallocate = false,
): { keySlot: number; keyPair: [number, number] } {
  const scan = getScan(scanId)

  // Clean up any stale slots in memory whose scans have finished/stopped/errored/deleted
  for (const [otherId] of gState.activeKeySlotsByScanId.entries()) {
    if (otherId === scanId) continue
    const otherScan = getScan(otherId)
    if (!otherScan || isScanTerminalOnDisk(otherScan) || otherScan.keySlotReleased) {
      gState.activeKeySlotsByScanId.delete(otherId)
      gState.activeAssignedKeysByScanId.delete(otherId)
    }
  }

  const usedSlotsByOthers = new Set<number>()
  for (const [otherId, slot] of gState.activeKeySlotsByScanId.entries()) {
    if (otherId !== scanId) usedSlotsByOthers.add(slot)
  }
  for (const sum of listScans()) {
    if (sum.id === scanId) continue
    const s = getScan(sum.id)
    if (s && !isScanTerminalOnDisk(s) && !s.keySlotReleased && s.keySlot && s.keySlot > 0) {
      usedSlotsByOthers.add(s.keySlot)
    }
  }

  if (!forceReallocate) {
    const existingMemSlot = gState.activeKeySlotsByScanId.get(scanId)
    if (existingMemSlot && existingMemSlot > 0 && !usedSlotsByOthers.has(existingMemSlot)) {
      const pair: [number, number] = [2 * existingMemSlot - 1, 2 * existingMemSlot]
      if (scan && (scan.keySlot !== existingMemSlot || !scan.keyPair)) {
        scan.keySlot = existingMemSlot
        scan.keyPair = pair
        scan.keySlotReleased = false
        saveScan(scan)
      }
      return { keySlot: existingMemSlot, keyPair: pair }
    }
    if (
      scan &&
      scan.keySlot &&
      scan.keySlot > 0 &&
      !scan.keySlotReleased &&
      !usedSlotsByOthers.has(scan.keySlot)
    ) {
      const slot = scan.keySlot
      const pair: [number, number] = [2 * slot - 1, 2 * slot]
      gState.activeKeySlotsByScanId.set(scanId, slot)
      if (!scan.keyPair || scan.keyPair[0] !== pair[0] || scan.keyPair[1] !== pair[1]) {
        scan.keyPair = pair
        saveScan(scan)
      }
      return { keySlot: slot, keyPair: pair }
    }
  }

  let slot = 1
  while (usedSlotsByOthers.has(slot)) {
    slot += 1
  }
  const keyPair: [number, number] = [2 * slot - 1, 2 * slot]
  gState.activeKeySlotsByScanId.set(scanId, slot)
  gState.activeAssignedKeysByScanId.set(scanId, [...keyPair])

  if (scan) {
    scan.keySlot = slot
    scan.keyPair = keyPair
    scan.keySlotReleased = false
    saveScan(scan)
  }

  return { keySlot: slot, keyPair }
}

/**
 * Release a scan's API key-pair slot when the scan finishes, stops, errors, or is deleted.
 */
export function releaseScanKeyPair(scanId: string): void {
  gState.activeKeySlotsByScanId.delete(scanId)
  gState.activeAssignedKeysByScanId.delete(scanId)
  const scan = getScan(scanId)
  if (scan && !scan.keySlotReleased) {
    scan.keySlotReleased = true
    saveScan(scan)
  }
}

/**
 * Ensure both `chunkTicket` and `keySlot`/`keyPair` are assigned for a scan as soon as its pipeline starts.
 */
export function ensureScanTicketAndKeyPair(scanId: string): {
  chunkTicket: number
  keySlot: number
  keyPair: [number, number]
} {
  const chunkTicket = ensureScanChunkTicket(scanId)
  const { keySlot, keyPair } = allocateScanKeyPair(scanId)
  return { chunkTicket, keySlot, keyPair }
}

/**
 * Returns true if `keyIdx1Based` (1, 2, 3...) belongs to any OTHER active scan's keyPair or assigned keys.
 */
export function isKeyInOtherActiveScanPair(keyIdx1Based: number, excludeScanId: string): boolean {
  for (const [otherId, slot] of gState.activeKeySlotsByScanId.entries()) {
    if (otherId === excludeScanId) continue
    const otherScan = getScan(otherId)
    if (otherScan && (isScanTerminalOnDisk(otherScan) || otherScan.keySlotReleased)) {
      gState.activeKeySlotsByScanId.delete(otherId)
      gState.activeAssignedKeysByScanId.delete(otherId)
      continue
    }
    const pair: [number, number] = [2 * slot - 1, 2 * slot]
    if (pair[0] === keyIdx1Based || pair[1] === keyIdx1Based) return true
    const assigned = gState.activeAssignedKeysByScanId.get(otherId)
    if (assigned && assigned.includes(keyIdx1Based)) return true
  }

  for (const sum of listScans()) {
    if (sum.id === excludeScanId) continue
    const s = getScan(sum.id)
    if (!s || isScanTerminalOnDisk(s) || s.keySlotReleased) continue
    if (s.keyPair && (s.keyPair[0] === keyIdx1Based || s.keyPair[1] === keyIdx1Based)) {
      return true
    }
    if (s.keySlot && s.keySlot > 0) {
      const k1 = 2 * s.keySlot - 1
      const k2 = 2 * s.keySlot
      if (k1 === keyIdx1Based || k2 === keyIdx1Based) return true
    }
  }

  return false
}

/**
 * Select the 2 API keys for `scanId` based on its allocated `keySlot` (`[2*slot - 1, 2*slot]`).
 * If either key in the assigned pair is quota-exhausted (`totalRemaining <= 0`),
 * falls back to the highest-remaining-quota key that is NOT in any other active scan's keyPair.
 */
export function selectScanKeyPairWithFallback<
  T extends {
    keyIdx: number
    apiKey: string
    totalRemaining: number
    hasCachedUploads?: boolean
    isActiveInOtherScan?: boolean
  },
>(
  scanId: string,
  allCandidates: T[],
): {
  keySlot: number
  keyPair: [number, number]
  selected: T[]
} {
  const { keySlot, keyPair } = allocateScanKeyPair(scanId)
  const selected: T[] = []

  const cand1 = allCandidates.find((c) => c.keyIdx === keyPair[0])
  const cand2 = allCandidates.find((c) => c.keyIdx === keyPair[1])

  if (cand1 && cand1.totalRemaining > 0) {
    selected.push(cand1)
  }
  if (cand2 && cand2.totalRemaining > 0 && !selected.some((s) => s.keyIdx === cand2.keyIdx)) {
    selected.push(cand2)
  }

  if (selected.length < 2) {
    // Fallback candidates: must have remaining quota > 0 and MUST NOT belong to any other active scan's keyPair
    const fallbackPool = allCandidates
      .filter(
        (c) =>
          c.totalRemaining > 0 &&
          !selected.some((s) => s.keyIdx === c.keyIdx) &&
          !isKeyInOtherActiveScanPair(c.keyIdx, scanId) &&
          !c.isActiveInOtherScan,
      )
      .sort((a, b) => {
        if (b.totalRemaining !== a.totalRemaining) return b.totalRemaining - a.totalRemaining
        if (Boolean(b.hasCachedUploads) !== Boolean(a.hasCachedUploads)) {
          return b.hasCachedUploads ? 1 : -1
        }
        return a.keyIdx - b.keyIdx
      })

    for (const fb of fallbackPool) {
      if (selected.length >= 2) break
      selected.push(fb)
    }
  }

  // Last-resort fallback if all keys have 0 counter quota or fewer than 2 keys are configured:
  // still prefer the assigned pair or keys not in another active scan's pair
  if (selected.length === 0) {
    if (cand1) selected.push(cand1)
    if (cand2 && !selected.some((s) => s.keyIdx === cand2.keyIdx)) selected.push(cand2)
    if (selected.length === 0) {
      const nonConflicting = allCandidates.filter(
        (c) => !isKeyInOtherActiveScanPair(c.keyIdx, scanId),
      )
      for (const c of nonConflicting.length > 0 ? nonConflicting : allCandidates) {
        if (selected.length >= 2) break
        selected.push(c)
      }
    }
  }

  const finalSelected = selected.slice(0, 2)
  gState.activeAssignedKeysByScanId.set(
    scanId,
    finalSelected.map((s) => s.keyIdx),
  )

  return {
    keySlot,
    keyPair,
    selected: finalSelected,
  }
}

/**
 * Mark a scan's ticket as skipped/completed (called on stop, error, or delete)
 * so no subsequent ticket ever waits for it.
 */
export function skipScanTicket(scanId: string, reason = 'Scan stopped/errored/deleted'): void {
  gState.skippedOrCompletedTickets.add(scanId)
  releaseScanKeyPair(scanId)
  globalChunkScanCoordinator.removeFromQueue(scanId)
  globalChunkScanCoordinator.releaseChunkScanLock(scanId, true, reason)
}

/**
 * Global Chunk Scan Coordinator:
 * - Only chunk windows scan waits for the ticket lock.
 * - Upload, 480p compress, window minute finder, and backup minute finder run in parallel across scans.
 * - Strict ticket ordering: Ticket #1 runs chunk windows first, then Ticket #2, then Ticket #3.
 *   Even if Ticket #2 finishes backup minute finder before Ticket #1, Ticket #2 waits until Ticket #1
 *   completes chunk windows (or Ticket #1 is stopped / errors / deleted).
 * - Polls every CHUNK_QUEUE_POLL_MS = 1000 ms for zero-delay handoff.
 */
class ChunkScanCoordinator {
  private activeScanId: string | null = null
  private activeScanTitle: string | null = null
  private activeScanTicket: number | null = null
  private activeSince: number | null = null
  private waitQueue: ChunkScanWaiter[] = []
  private monitorTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startMonitor()
  }

  private startMonitor() {
    if (this.monitorTimer) return
    this.monitorTimer = setInterval(() => {
      this.tickMonitor()
    }, CHUNK_QUEUE_POLL_MS)
    if (this.monitorTimer && typeof this.monitorTimer === 'object' && 'unref' in this.monitorTimer) {
      this.monitorTimer.unref()
    }
  }

  /**
   * Check if there is any lower-ticket scan (`otherTicket < myTicket`) that is still active
   * in the pipeline (upload / compress / minute finder / backup finder / chunk queue / chunk scan)
   * and has not yet finished its chunk windows or been stopped/errored/deleted.
   */
  public findBlockingLowerTicketScan(
    myScanId: string,
    myTicket: number,
  ): BlockingTicketInfo | null {
    // 1. If activeScanId is currently holding the lock and is a different scan
    if (this.activeScanId && this.activeScanId !== myScanId) {
      const activeTicket =
        this.activeScanTicket ?? gState.ticketsByScanId.get(this.activeScanId) ?? 1
      return {
        scanId: this.activeScanId,
        scanTitle: this.activeScanTitle || this.activeScanId,
        ticket: activeTicket,
        reason: 'chunk scan chal raha hai',
      }
    }

    // 2. Check waiters in waitQueue with lower ticket
    for (const w of this.waitQueue) {
      if (w.scanId === myScanId) continue
      if (w.ticket < myTicket && !gState.skippedOrCompletedTickets.has(w.scanId)) {
        const s = getScan(w.scanId)
        if (!isScanTerminalOnDisk(s)) {
          return {
            scanId: w.scanId,
            scanTitle: w.scanTitle || s?.customName || s?.shortName || w.scanId,
            ticket: w.ticket,
            reason: 'queue me pehle hai',
          }
        }
      }
    }

    // 3. Check all scans on disk / memory that have a lower ticket and are still in minute finder / backup finder
    const candidateIds = new Set<string>()
    for (const [id, t] of gState.ticketsByScanId.entries()) {
      if (id !== myScanId && t < myTicket) candidateIds.add(id)
    }
    for (const sum of listScans()) {
      if (sum.id !== myScanId && sum.chunkTicket && sum.chunkTicket < myTicket) {
        candidateIds.add(sum.id)
      }
    }

    let lowestBlocking: BlockingTicketInfo | null = null
    for (const otherId of candidateIds) {
      if (gState.skippedOrCompletedTickets.has(otherId)) continue
      const s = getScan(otherId)
      if (!s || isScanTerminalOnDisk(s)) {
        gState.skippedOrCompletedTickets.add(otherId)
        continue
      }
      if (!isScanActivelyInPipeline(s)) continue

      const t = s.chunkTicket || gState.ticketsByScanId.get(otherId) || 0
      if (t <= 0 || t >= myTicket) continue

      const title = s.customName || s.shortName || s.id
      if (!lowestBlocking || t < lowestBlocking.ticket) {
        lowestBlocking = {
          scanId: otherId,
          scanTitle: title,
          ticket: t,
          reason: 'chal raha hai',
        }
      }
    }

    return lowestBlocking
  }

  /**
   * 1-second monitor loop:
   * 1) Checks if the currently active chunk scan has completed all its chunk windows (or stopped/errored/deleted)
   *    and immediately releases the lock if so.
   * 2) Prunes stopped/deleted waiters from waitQueue.
   * 3) Grants the lock to the lowest-ticket waiter as soon as no lower-ticket scan is blocking.
   */
  public tickMonitor() {
    try {
      if (this.activeScanId) {
        const check = this.evaluateScanChunkCompletion(this.activeScanId)
        if (check.shouldRelease) {
          console.log(
            `[ChunkScanCoordinator] 1s Monitor: Auto-releasing chunk lock from scan ${this.activeScanId} (${check.reason})`,
          )
          this.forceReleaseLock(this.activeScanId, check.reason)
        }
      }

      if (this.waitQueue.length > 0) {
        const stillValid: ChunkScanWaiter[] = []
        for (const w of this.waitQueue) {
          const s = getScan(w.scanId)
          const stoppedByCallback = w.isStopping?.() === true
          const stoppedInStore = !s || s.status === 'stopped' || s.status === 'error' || s.status === 'done'
          if (stoppedByCallback || stoppedInStore || gState.skippedOrCompletedTickets.has(w.scanId)) {
            this.clearScanQueueBadge(w.scanId)
            w.reject(new Error('Scan stopped while waiting in chunk scan queue'))
          } else {
            stillValid.push(w)
          }
        }
        this.waitQueue = stillValid
        this.sortQueueByTicket()
        this.syncQueueBadgesOnDisk()
      }

      if (!this.activeScanId && this.waitQueue.length > 0) {
        this.grantNextInQueue()
      }
    } catch (err) {
      console.error('[ChunkScanCoordinator] Monitor tick error:', err)
    }
  }

  private evaluateScanChunkCompletion(scanId: string): {
    shouldRelease: boolean
    reason: string
  } {
    const scan = getScan(scanId)
    if (!scan) {
      return { shouldRelease: true, reason: 'Scan deleted from store' }
    }
    if (scan.status === 'done' || scan.status === 'stopped' || scan.status === 'error') {
      return { shouldRelease: true, reason: `Scan status is '${scan.status}'` }
    }
    if (scan.chunkWindowsDone) {
      return { shouldRelease: true, reason: 'All chunk windows reached terminal status' }
    }

    if (gState.externalWindowCompletionChecker) {
      const ext = gState.externalWindowCompletionChecker(scanId)
      if (ext?.done) {
        return {
          shouldRelease: true,
          reason: ext.reason || 'All Studio parallel chunk windows reached terminal status',
        }
      }
    }

    // For legacy API engine scans: check if all selected segments' chunks are in terminal state
    if (scan.chunkScanEngine === 'api') {
      const segments = (scan.shortSegments || []).filter((s) => s.selected !== false)
      if (segments.length > 0) {
        let totalActiveChunks = 0
        let finishedChunks = 0
        for (const seg of segments) {
          for (const c of seg.chunks || []) {
            if (c.status === 'skipped') continue
            totalActiveChunks++
            if (
              c.status === 'match' ||
              c.status === 'no_match' ||
              c.status === 'failed' ||
              c.status === 'cancelled' ||
              c.status === 'policy_blocked'
            ) {
              finishedChunks++
            }
          }
        }
        if (totalActiveChunks > 0 && finishedChunks >= totalActiveChunks) {
          return {
            shouldRelease: true,
            reason: `All ${finishedChunks}/${totalActiveChunks} chunks finished`,
          }
        }
      }
    }

    return { shouldRelease: false, reason: 'Chunks still in progress' }
  }

  private sortQueueByTicket() {
    this.waitQueue.sort((a, b) => a.ticket - b.ticket)
  }

  private syncQueueBadgesOnDisk() {
    const total = this.waitQueue.length
    this.waitQueue.forEach((w, idx) => {
      const pos = idx + 1
      const blocking = this.findBlockingLowerTicketScan(w.scanId, w.ticket)
      const activeId = blocking?.scanId || this.activeScanId
      const activeTitle =
        blocking?.scanTitle || this.activeScanTitle || (blocking ? `#${blocking.ticket}` : null)
      const waitTicket = blocking?.ticket ?? this.activeScanTicket ?? 1

      if (w.onWait) {
        w.onWait(
          `Chunk windows ke liye wait (Ticket #${w.ticket}, Scan ${activeTitle || `#${waitTicket}`} chal raha hai)`,
          pos,
          w.ticket,
          activeId,
        )
      }

      try {
        const s = getScan(w.scanId)
        if (s) {
          const prevPos = s.chunkQueue?.position
          const prevActive = s.chunkQueue?.activeScanId
          const prevStage = s.pipelineStage
          s.chunkTicket = w.ticket
          s.pipelineStage = 'waiting_chunk_ticket'
          s.waitingForTicket = waitTicket
          s.waitingForScanTitle = activeTitle
          s.chunkQueue = {
            ticket: w.ticket,
            position: pos,
            totalWaiting: total,
            activeScanId: activeId,
            activeScanTitle: activeTitle,
            enqueuedAt: w.enqueuedAt,
          }
          if (
            prevPos !== pos ||
            prevActive !== activeId ||
            prevStage !== 'waiting_chunk_ticket'
          ) {
            saveScan(s)
          }
        }
      } catch {
        /* ignore */
      }
    })
  }

  private clearScanQueueBadge(scanId: string) {
    try {
      const s = getScan(scanId)
      if (s && (s.chunkQueue || s.waitingForTicket || s.waitingForScanTitle)) {
        delete s.chunkQueue
        s.waitingForTicket = null
        s.waitingForScanTitle = null
        saveScan(s)
      }
    } catch {
      /* ignore */
    }
  }

  public getStatus(forScanId?: string): ChunkScanQueueStatus {
    const now = Date.now()
    const waitingScans = this.waitQueue.map((w, idx) => ({
      scanId: w.scanId,
      scanTitle: w.scanTitle,
      ticket: w.ticket,
      position: idx + 1,
      enqueuedAt: w.enqueuedAt,
      waitSec: Math.max(0, Math.round((now - w.enqueuedAt) / 1000)),
    }))
    const mine = forScanId ? waitingScans.find((w) => w.scanId === forScanId) : undefined
    return {
      activeScanId: this.activeScanId,
      activeScanTitle: this.activeScanTitle,
      activeTicket: this.activeScanTicket,
      activeSince: this.activeSince,
      queueLength: this.waitQueue.length,
      waitingScans,
      myPosition: mine ? mine.position : null,
      myTicket: mine ? mine.ticket : (forScanId ? (gState.ticketsByScanId.get(forScanId) ?? null) : null),
    }
  }

  /**
   * Acquire exclusive global lock for the Chunk Windows Scan phase in strict ticket order.
   */
  public async acquireChunkScanLock(params: {
    scanId: string
    scanTitle?: string
    onWait?: (msg: string, position: number, ticket: number, activeScanId: string | null) => void
    isStopping?: () => boolean
  }): Promise<() => void> {
    const { scanId, scanTitle = scanId, onWait, isStopping } = params
    const ticket = ensureScanChunkTicket(scanId)

    // Re-entrant if this scan already holds the lock
    if (this.activeScanId === scanId) {
      return () => this.releaseChunkScanLock(scanId)
    }

    // Check if any active scan holds the lock right now, and whether it already finished
    if (this.activeScanId) {
      const check = this.evaluateScanChunkCompletion(this.activeScanId)
      if (check.shouldRelease) {
        this.forceReleaseLock(this.activeScanId, check.reason)
      }
    }

    // Strict ticket order check: can only acquire immediately if no active scan holds the lock,
    // waitQueue has no lower ticket, AND no lower-ticket scan is still active in minute/backup finder!
    const blocking = this.findBlockingLowerTicketScan(scanId, ticket)
    if (!this.activeScanId && !blocking && this.waitQueue.length === 0) {
      this.activeScanId = scanId
      this.activeScanTitle = scanTitle
      this.activeScanTicket = ticket
      this.activeSince = Date.now()
      this.clearScanQueueBadge(scanId)
      const s = getScan(scanId)
      if (s) {
        s.chunkTicket = ticket
        s.pipelineStage = 'chunk_scanning'
        s.waitingForTicket = null
        s.waitingForScanTitle = null
        addLog(
          s,
          'info',
          `[Chunk Scan Lock] Acquired global chunk scan lock immediately (Ticket #${ticket}). Starting chunk windows scan...`,
        )
        saveScan(s)
      }
      return () => this.releaseChunkScanLock(scanId)
    }

    // Check if already queued in waitQueue
    const existingIdx = this.waitQueue.findIndex((w) => w.scanId === scanId)
    if (existingIdx >= 0) {
      this.waitQueue.splice(existingIdx, 1)
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: ChunkScanWaiter = {
        scanId,
        scanTitle,
        ticket,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        onWait,
        isStopping,
      }
      this.waitQueue.push(waiter)
      this.sortQueueByTicket()
      this.syncQueueBadgesOnDisk()

      const pos = this.waitQueue.findIndex((w) => w.scanId === scanId) + 1
      const currentBlocking = this.findBlockingLowerTicketScan(scanId, ticket)
      const waitTitle =
        currentBlocking?.scanTitle ||
        this.activeScanTitle ||
        (currentBlocking ? `#${currentBlocking.ticket}` : '#1')
      const s = getScan(scanId)
      if (s) {
        s.chunkTicket = ticket
        s.pipelineStage = 'waiting_chunk_ticket'
        s.waitingForTicket = currentBlocking?.ticket ?? this.activeScanTicket ?? 1
        s.waitingForScanTitle = waitTitle
        addLog(
          s,
          'info',
          `[Chunk Scan Queue] Chunk windows ke liye wait (Ticket #${ticket}, Queue #${pos}) — Scan "${waitTitle}" chal raha hai (1s monitor active).`,
        )
        saveScan(s)
      }
    })
  }

  private grantNextInQueue() {
    if (this.activeScanId || this.waitQueue.length === 0) return

    this.sortQueueByTicket()

    // Pick the lowest-ticket waiter
    const next = this.waitQueue[0]
    if (!next) return

    // Check if a lower-ticket scan is still active in minute/backup finder
    const blocking = this.findBlockingLowerTicketScan(next.scanId, next.ticket)
    if (blocking) {
      this.syncQueueBadgesOnDisk()
      return
    }

    // Pop from waitQueue and grant lock immediately
    this.waitQueue.shift()
    this.activeScanId = next.scanId
    this.activeScanTitle = next.scanTitle
    this.activeScanTicket = next.ticket
    this.activeSince = Date.now()
    this.clearScanQueueBadge(next.scanId)
    this.syncQueueBadgesOnDisk()

    try {
      const s = getScan(next.scanId)
      if (s) {
        s.chunkTicket = next.ticket
        s.pipelineStage = 'chunk_scanning'
        s.waitingForTicket = null
        s.waitingForScanTitle = null
        addLog(
          s,
          'success',
          `[Chunk Scan Lock] Turn arrived for Ticket #${next.ticket}! Acquired global chunk scan lock — starting chunk windows scan now.`,
        )
        saveScan(s)
      }
    } catch {
      /* ignore */
    }

    next.resolve(() => this.releaseChunkScanLock(next.scanId))
  }

  private forceReleaseLock(scanId: string, reason: string) {
    if (this.activeScanId !== scanId) return
    gState.skippedOrCompletedTickets.add(scanId)
    this.activeScanId = null
    this.activeScanTitle = null
    this.activeScanTicket = null
    this.activeSince = null
    this.clearScanQueueBadge(scanId)
    console.log(`[ChunkScanCoordinator] Lock released from ${scanId}: ${reason}`)
    this.grantNextInQueue()
  }

  public releaseChunkScanLock(
    scanId: string,
    forceImmediate = true,
    reason = 'Chunk windows scan completed',
  ) {
    gState.skippedOrCompletedTickets.add(scanId)
    if (this.activeScanId !== scanId) return
    if (forceImmediate) {
      this.forceReleaseLock(scanId, reason)
      return
    }
    this.forceReleaseLock(scanId, reason)
  }

  public removeFromQueue(scanId: string) {
    const idx = this.waitQueue.findIndex((w) => w.scanId === scanId)
    if (idx >= 0) {
      const [removed] = this.waitQueue.splice(idx, 1)
      this.clearScanQueueBadge(scanId)
      this.syncQueueBadgesOnDisk()
      removed.reject(new Error('Removed from chunk scan queue'))
    }
  }

  public hasWaitingScans(): boolean {
    return this.waitQueue.length > 0
  }
}

const globalForChunkCoordinator = globalThis as unknown as {
  __cmtChunkScanCoordinator?: ChunkScanCoordinator
}

export const globalChunkScanCoordinator =
  globalForChunkCoordinator.__cmtChunkScanCoordinator ?? new ChunkScanCoordinator()

if (!globalForChunkCoordinator.__cmtChunkScanCoordinator) {
  globalForChunkCoordinator.__cmtChunkScanCoordinator = globalChunkScanCoordinator
}
