import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { DATA_DIR, MEDIA_DIR } from './paths'
import { addLog, getScan, saveScan } from './store'
import {
  StudioBrowserController,
  globalStudioUploadGate,
  inspectChromeProcesses,
  killAllLeftoverChromeProcessesOnceOnStartup,
  killWorkerChromeProcessesByProfileDir,
  readDevShmUsedMb,
  type StudioStepLog,
} from './studio-automation'
import {
  ensureStudioMovieUploadedToDriveIfNeeded,
  ensureStudioShortReady,
  prepareStudioMovie360pAndDrive,
  verifyStudioMovie360pFile,
} from './media'
import { probeDuration } from './ffmpeg'
import { CancelToken, FfmpegCancelled } from './ffmpeg-pool'
import {
  cleanStaleWindowClipPartials,
  ensureWindowClip,
  type WindowClipResult,
} from './studio-window-clips'
import {
  buildParallelWindowsFromMinuteInput,
  clipMatchToShortSegment,
  deriveChunkIndexForMovieTime,
  mergeParallelWindowResults,
  splitParallelWindowInHalf,
  type ParallelMergedReport,
  type ParallelWindowSpec,
} from './studio-window-planner'
import {
  DEFAULT_STUDIO_CONCURRENCY,
  DEFAULT_STUDIO_MINUTE_INPUT,
  DEFAULT_STUDIO_UPLOAD_GATE,
  loadStudioUserConfig,
} from './studio-settings'
import {
  DEFAULT_STUDIO_MODEL_NAME,
  getEffectiveModel,
} from './studio-model-state'
import {
  ensureScanChunkTicket,
  globalChunkScanCoordinator,
  registerParallelWindowCompletionChecker,
  releaseScanKeyPair,
  skipScanTicket,
} from './chunk-scan-coordinator'
import { computeShortCoverage } from './short-coverage'
import type { ChunkMatch, Scan } from './types'

export type ParallelWindowStatus =
  | 'QUEUED'
  | 'ASSIGNED'
  | 'WAITING_FOR_WORKER'
  | 'WAITING_FOR_UPLOAD_GATE'
  | 'WAITING_FOR_RAM'
  | 'SETUP'
  | 'RUNNING'
  | 'VALIDATING'
  | 'RETRYING'
  | '403_WAIT'
  | 'DONE'
  | 'PROHIBITED'
  | 'FAILED'
  | 'NEEDS_ATTENTION'
  | 'STOPPED'
  | 'SKIPPED'

export type ParallelLogLevel = 'INFO' | 'SUCCESS' | 'RETRY' | '403' | 'ERROR' | 'STOPPED'

export interface ParallelCombinedLogEntry {
  seq: number
  t: number
  elapsedSec: number
  runId?: string | null
  scanId: string
  scanName: string
  workerId: string // "W01".."W10" or "SYS"
  windowId: string | null
  windowNumber: number | null
  windowRange: string | null
  level: ParallelLogLevel
  step: string
  message: string
}

export interface ParallelResourceSnapshot {
  t: number
  elapsedSec: number
  runId?: string | null
  ramUsedPercent: number
  freeDiskGb: number
  devShmUsedMb?: number
  activeWorkers: number
  slotsInUse: number
  totalSlots: number
  chromeProcessCount: number
  chromeProcsPerWorker?: Record<string, number>
  chromeRssMbPerWorker?: Record<string, number>
  note?: string
}

export interface ParallelRunInfo {
  runId: string
  startedAt: number
  finishedAt: number | null
}

export interface ParallelMediaVerificationInfo {
  scanId: string
  shortPath: string | null
  shortSizeBytes: number | null
  shortDurationSec: number | null
  movie360Path: string | null
  movie360SizeBytes: number | null
  movie360DurationSec: number | null
  verifiedAt: number | null
}

export interface ParallelCompressionProgressInfo {
  active: boolean
  progress: number
  statusText: string
  sizeBytes?: number | null
  error?: string | null
}

export interface ParallelSlotPoolSummary {
  totalSlots: number
  inUseSlots: number
  byScan: Array<{
    scanId: string
    scanLabel: string
    count: number
  }>
  summaryText: string // e.g. "slots: 4/10 in use (Scan A: 2, Scan B: 2)"
}

export interface ParallelWindowState extends ParallelWindowSpec {
  status: ParallelWindowStatus
  workerId: string | null
  modelName: string
  stage: string
  tokens: number | null
  attempt: number
  maxAttempts: number
  permRetry: number
  startedAt: number | null
  finishedAt: number | null
  elapsedSec: number
  matchCount: number
  notFoundCount?: number
  summaryText: string
  rawResponseText?: string
  matches?: ChunkMatch[]
  error?: string | null
}

export interface ParallelWorkerCardSnapshot {
  workerId: string // "W01" .. "W10"
  workerIndex: number // 1 .. 10
  profileDirName: string // "studio-chrome-profile-w01"
  active: boolean
  leasedByScanId: string | null
  leasedByScanLabel: string | null
  leasedByOtherScan: boolean
  status: ParallelWindowStatus | 'IDLE'
  windowId: string | null
  windowNumber: number | null
  windowRange: string | null
  runLabel: string | null
  modelName: string
  stage: string
  tokens: number | null
  elapsedSec: number
  attempt: number
  maxAttempts: number
  permRetry: number
  summaryText: string | null
  screenshotBase64: string | null
  screenshotAt: number | null
  chromeProcessCount?: number
  chromeRssMb?: number
  logs: StudioStepLog[]
}

export interface ParallelScanLiveSnapshot {
  active: boolean
  starting: boolean
  paused: boolean
  waitingForWorkerSlots: boolean
  hasResumableState: boolean
  compressing360p: ParallelCompressionProgressInfo | null
  mediaInfo: ParallelMediaVerificationInfo | null
  scanId: string
  scanName: string
  username: string | null
  currentRunId?: string | null
  runHistory?: ParallelRunInfo[]
  minuteInput: string
  minuteInputSource: 'auto' | 'manual'
  foundMinutesInput: string
  movieDurationSec: number | null
  concurrency: number
  measuredTokenRate: number | null
  startedAt: number | null
  finishedAt: number | null
  elapsedSec: number
  activeWorkersCount: number
  doneCount: number
  queuedCount: number
  failedCount: number
  prohibitedCount: number
  needsAttentionCount: number
  totalWindows: number
  clipsReady: number
  clipsTotal: number
  clipsExtracting: boolean
  ramUsedPercent: number
  freeDiskGb: number
  devShmUsedMb?: number
  chromeProcessCount: number
  chromeProcsPerWorker: Record<string, number>
  chromeRssMbPerWorker?: Record<string, number>
  resourceWarning: string | null
  slotPool: ParallelSlotPoolSummary
  workers: ParallelWorkerCardSnapshot[]
  windows: ParallelWindowState[]
  mergedReport: ParallelMergedReport | null
  combinedLogs: ParallelCombinedLogEntry[]
  totalLogLinesOnDisk: number
  resourceSnapshots: ParallelResourceSnapshot[]
}

interface PersistedParallelState {
  version: 2
  scanId: string
  scanName: string
  username: string
  currentRunId?: string | null
  runHistory?: ParallelRunInfo[]
  minuteInput: string
  minuteInputSource?: 'auto' | 'manual'
  concurrency: number
  hasStartedRun?: boolean
  mediaInfo?: ParallelMediaVerificationInfo | null
  shortLocalPath: string | null
  shortYoutubeUrl: string | null
  shortDriveFileName: string | null
  shortDurationSec: number
  movieLocalPath: string | null
  movieDriveFileName: string | null
  movieDurationSec: number
  startedAt: number | null
  finishedAt: number | null
  updatedAt: number
  windows: ParallelWindowState[]
  resourceSnapshots?: ParallelResourceSnapshot[]
}

const LEGACY_PARALLEL_STATE_FILE = path.join(DATA_DIR, 'studio-parallel-state.json')
const LEGACY_PARALLEL_STATE_MIGRATED_FILE = path.join(DATA_DIR, 'studio-parallel-state.json.migrated')
const BASE_PROFILE_NAME = 'studio-chrome-profile'
const MAX_LOG_FILE_BYTES = 50 * 1024 * 1024 // 50 MB rotation cap
const UI_COMBINED_LOG_LIMIT = 2000
export const LAUNCH_STAGGER_MS = 20_000
export const MAX_PARALLEL_CLIP_EXTRACTIONS = 2

export function readSystemRamUsedPercent(): number {
  try {
    if (fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/i)
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/i)
      if (totalMatch && availMatch) {
        const total = Number(totalMatch[1])
        const avail = Number(availMatch[1])
        if (total > 0) {
          return Math.round(((total - avail) / total) * 100)
        }
      }
    }
  } catch {
    /* fallback to os module */
  }
  const total = os.totalmem()
  const free = os.freemem()
  if (total <= 0) return 0
  return Math.round(((total - free) / total) * 100)
}

export function readFreeDiskGb(): number {
  try {
    const stat = fs.statfsSync(DATA_DIR)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    return Math.round((freeBytes / 1024 ** 3) * 10) / 10
  } catch {
    return 50
  }
}

export function readChromeProcessCount(): number {
  return inspectChromeProcesses().totalCount
}

export function readChromeProcsPerWorker(maxWorkers = 10): {
  totalProcs: number
  perWorkerProcs: Record<string, number>
  perWorkerRssMb: Record<string, number>
} {
  const info = inspectChromeProcesses()
  const perWorkerProcs: Record<string, number> = {}
  const perWorkerRssMb: Record<string, number> = {}
  const count = Math.max(1, Math.min(20, maxWorkers))
  for (let i = 1; i <= count; i++) {
    const wId = `W${String(i).padStart(2, '0')}`
    perWorkerProcs[wId] = info.perWorkerCount?.[wId] || 0
    perWorkerRssMb[wId] = info.perWorkerRssMb?.[wId] || 0
  }
  for (const [wId, c] of Object.entries(info.perWorkerCount ?? {})) {
    if (c > 0 && !(wId in perWorkerProcs)) {
      perWorkerProcs[wId] = c
      perWorkerRssMb[wId] = info.perWorkerRssMb?.[wId] || 0
    }
  }
  return {
    totalProcs: info.totalCount ?? 0,
    perWorkerProcs,
    perWorkerRssMb,
  }
}

export function resolveScanDisplayLabel(scanId: string): string {
  if (!scanId || scanId === 'default') return 'Default Scan'
  try {
    const scan = getScan(scanId)
    if (scan) {
      const title =
        scan.customName?.trim() ||
        scan.movieName?.replace(/\.[^.]+$/, '') ||
        scan.shortName?.replace(/\.[^.]+$/, '') ||
        ''
      const shortId = scanId.slice(0, 6)
      return title ? `${title.slice(0, 22)} (#${shortId})` : `Scan #${shortId}`
    }
  } catch {
    /* ignore */
  }
  return `Scan #${scanId.slice(0, 8)}`
}

export function resolveScanMovieDurationSec(scan?: Scan | null): number | null {
  if (!scan) return null
  if (typeof scan.movieDuration === 'number' && scan.movieDuration > 0) {
    return scan.movieDuration
  }
  if (typeof scan.movieTrimEnd === 'number' && scan.movieTrimEnd > 0) {
    return scan.movieTrimEnd
  }
  if (
    scan.geminiPrescan?.movieCopy?.trimEnd &&
    scan.geminiPrescan.movieCopy.trimEnd > 0
  ) {
    return scan.geminiPrescan.movieCopy.trimEnd
  }
  return null
}

/**
 * Format sorted 0-based movie minute numbers into compact ranges (e.g. "8-24,45-50"),
 * filtering out any minute that starts at or after movieDurationSec.
 */
export function formatCompactMinuteRanges(
  minutes: number[],
  movieDurationSec?: number | null,
): string {
  const maxDur = movieDurationSec && movieDurationSec > 0 ? movieDurationSec : null
  const valid = [...new Set(minutes)]
    .filter((m) => Number.isFinite(m) && m >= 0 && (maxDur === null || m * 60 < maxDur))
    .map((m) => Math.floor(m))
    .sort((a, b) => a - b)

  if (valid.length === 0) return ''
  const parts: string[] = []
  let i = 0
  while (i < valid.length) {
    let j = i
    while (j + 1 < valid.length && valid[j + 1] === valid[j] + 1) {
      j += 1
    }
    parts.push(i === j ? `${valid[i]}` : `${valid[i]}-${valid[j]}`)
    i = j + 1
  }
  return parts.join(',')
}

/**
 * Extract THIS scan's own "Minutes found" list (already includes ±1 min buffer from window scan).
 * Returns [] if the window scan has not produced found minutes yet.
 */
export function extractScanFoundMinutes(scan?: Scan | null): number[] {
  if (!scan) return []
  const prescan = scan.geminiPrescan
  if (prescan?.appliedMinutes && prescan.appliedMinutes.length > 0) {
    return [...prescan.appliedMinutes]
  }
  if (prescan?.minuteSuggestions && prescan.minuteSuggestions.length > 0) {
    return prescan.minuteSuggestions.map((s) => s.minute)
  }
  if (scan.mergePipeline?.approvedMinutes && scan.mergePipeline.approvedMinutes.length > 0) {
    return [...scan.mergePipeline.approvedMinutes]
  }
  if (
    scan.mergePipeline?.minuteSuggestions &&
    scan.mergePipeline.minuteSuggestions.length > 0
  ) {
    return scan.mergePipeline.minuteSuggestions.map((s) => s.minute)
  }
  const segMins = (scan.shortSegments || [])
    .filter((s) => s.selected !== false && Array.isArray(s.movieMinutes) && s.movieMinutes.length > 0)
    .flatMap((s) => s.movieMinutes!)
  if (segMins.length > 0) {
    return segMins
  }
  return []
}

export function extractScanFoundMinutesCompact(scan?: Scan | null): string {
  const mins = extractScanFoundMinutes(scan)
  const dur = resolveScanMovieDurationSec(scan)
  return formatCompactMinuteRanges(mins, dur)
}

/**
 * Clone base profile `data/studio-chrome-profile` into `data/studio-chrome-profile-wXX`
 * excluding SingletonLock/SingletonCookie/SingletonSocket and heavy browser cache folders.
 */
function syncWorkerProfileFromBase(slotIndex: number): string {
  const workerSuffix = String(slotIndex).padStart(2, '0')
  const profileDirName = `${BASE_PROFILE_NAME}-w${workerSuffix}`
  const baseDir = path.join(DATA_DIR, BASE_PROFILE_NAME)
  const targetDir = path.join(DATA_DIR, profileDirName)

  fs.mkdirSync(DATA_DIR, { recursive: true })

  const baseCookiesPath = path.join(baseDir, 'Default', 'Cookies')
  const targetCookiesPath = path.join(targetDir, 'Default', 'Cookies')

  const shouldCopyFromBase =
    fs.existsSync(baseDir) &&
    (!fs.existsSync(targetDir) ||
      (fs.existsSync(baseCookiesPath) &&
        (!fs.existsSync(targetCookiesPath) ||
          fs.statSync(baseCookiesPath).mtimeMs > fs.statSync(targetCookiesPath).mtimeMs)))

  if (shouldCopyFromBase) {
    try {
      fs.mkdirSync(targetDir, { recursive: true })
      const entries = fs.readdirSync(baseDir)
      const skipTopLevel = new Set([
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'RunningChromeVersion',
        'BrowserMetrics',
        'Crashpad',
        'GrShaderCache',
        'ShaderCache',
        'GraphiteDawnCache',
      ])
      for (const entry of entries) {
        if (skipTopLevel.has(entry) || entry.startsWith('Singleton')) continue
        const srcPath = path.join(baseDir, entry)
        const dstPath = path.join(targetDir, entry)
        if (entry === 'Default') {
          fs.mkdirSync(dstPath, { recursive: true })
          const defEntries = fs.readdirSync(srcPath)
          const skipDef = new Set([
            'Cache',
            'Code Cache',
            'GPUCache',
            'DawnCache',
            'Service Worker',
            'LOCK',
          ])
          for (const dEntry of defEntries) {
            if (skipDef.has(dEntry)) continue
            try {
              execFileSync('cp', ['-a', path.join(srcPath, dEntry), path.join(dstPath, dEntry)], {
                stdio: 'ignore',
              })
            } catch {
              /* ignore locked file during copy */
            }
          }
        } else {
          try {
            execFileSync('cp', ['-a', srcPath, dstPath], { stdio: 'ignore' })
          } catch {
            /* ignore locked file */
          }
        }
      }
    } catch {
      fs.mkdirSync(targetDir, { recursive: true })
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(targetDir, lockName), { force: true })
    } catch {
      /* ignore */
    }
  }

  return profileDirName
}

function mapStepToWindowStatus(step: string): ParallelWindowStatus {
  const s = (step || '').toLowerCase()
  if (s.includes('needs attention')) return 'NEEDS_ATTENTION'
  if (s.includes('policy_blocked') || s.includes('prohibited')) return 'PROHIBITED'
  if (s.includes('waiting for upload gate')) return 'WAITING_FOR_UPLOAD_GATE'
  if (s.includes('waiting for ram')) return 'WAITING_FOR_RAM'
  if (s.includes('waiting for worker')) return 'WAITING_FOR_WORKER'
  if (s.includes('permission denied') || s.includes('403 ->') || s.includes('403 permission_denied')) {
    return '403_WAIT'
  }
  if (s.includes('retry [')) return 'RETRYING'
  if (s.includes('validate') || s.includes('copy')) return 'VALIDATING'
  if (s.includes('running ')) return 'RUNNING'
  return 'SETUP'
}

export function classifyParallelLogLevel(
  rawLevel: 'info' | 'warn' | 'error' | 'success',
  step: string,
  detail?: string,
): ParallelLogLevel {
  const combined = `${step || ''} ${detail || ''}`.toLowerCase()
  if (
    combined.includes('error [crash]') ||
    combined.includes('target crashed') ||
    combined.includes('page crashed')
  ) {
    return 'ERROR'
  }
  if (
    combined.includes('403') ||
    combined.includes('permission_denied') ||
    combined.includes('permission denied') ||
    combined.includes('hard reset') ||
    combined.includes('browser restart')
  ) {
    return '403'
  }
  if (
    combined.includes('stopped by user') ||
    combined.includes('stopping') ||
    combined.includes('window stopped') ||
    combined.includes('scan stopped')
  ) {
    return 'STOPPED'
  }
  if (
    combined.includes('retry [') ||
    combined.includes('retrying') ||
    combined.includes('split') ||
    combined.includes('context-limit')
  ) {
    return 'RETRY'
  }
  if (rawLevel === 'error' || combined.includes('error [') || combined.includes('failed')) {
    return 'ERROR'
  }
  if (rawLevel === 'success' || combined.includes('success [') || combined.includes('done by')) {
    return 'SUCCESS'
  }
  return 'INFO'
}

// ============================================================================
// GLOBAL PROFILE SLOT POOL (studio-chrome-profile-w01 .. wNN)
// Ensures two scans NEVER use the same worker profile slot at the same time,
// and total active workers across all scans never exceed maxTotalSlots (default 10).
// ============================================================================

export interface ProfileSlotEntry {
  slotIndex: number // 1..20
  workerId: string // "W01".."W20"
  profileDirName: string // "studio-chrome-profile-w01"
  controller: StudioBrowserController
  leasedByScanId: string | null
  leasedByScanLabel: string | null
  leasedWindowId: string | null
  leasedWindowNumber: number | null
  leasedWindowRange: string | null
  leasedAt: number | null
  everLaunched: boolean
}

class GlobalProfileSlotPool {
  private slots = new Map<number, ProfileSlotEntry>()
  private maxTotalSlots: number = DEFAULT_STUDIO_CONCURRENCY
  private lastLaunchAt = 0

  public setMaxTotalSlots(limit: number) {
    if (Number.isFinite(limit) && limit >= 1) {
      this.maxTotalSlots = Math.max(1, Math.min(20, Math.round(limit)))
    }
  }

  public getMaxTotalSlots(): number {
    return this.maxTotalSlots
  }

  public getOrCreateSlot(slotIndex: number): ProfileSlotEntry {
    let slot = this.slots.get(slotIndex)
    if (!slot) {
      const workerId = `W${String(slotIndex).padStart(2, '0')}`
      const profileDirName = syncWorkerProfileFromBase(slotIndex)
      const controller = new StudioBrowserController({
        profileDirName,
        workerTag: `[${workerId}]`,
      })
      slot = {
        slotIndex,
        workerId,
        profileDirName,
        controller,
        leasedByScanId: null,
        leasedByScanLabel: null,
        leasedWindowId: null,
        leasedWindowNumber: null,
        leasedWindowRange: null,
        leasedAt: null,
        everLaunched: false,
      }
      this.slots.set(slotIndex, slot)
    }
    return slot
  }

  /**
   * Try to lease a free profile slot in [1 .. totalPoolLimit].
   * Prefers `preferredSlotIndex` if free (so a scan reuses its warm browser),
   * otherwise picks the lowest free slot index.
   * Returns null if all slots in the pool are currently leased.
   */
  public tryAcquireSlot(params: {
    scanId: string
    scanLabel: string
    windowId: string
    windowNumber: number
    windowRange: string
    preferredSlotIndex?: number | null
    poolLimit?: number
  }): ProfileSlotEntry | null {
    const limit = Math.max(1, Math.min(20, params.poolLimit || this.maxTotalSlots))
    let inUseCount = 0
    for (const s of this.slots.values()) {
      if (s.leasedByScanId !== null) {
        inUseCount += 1
      }
    }
    if (inUseCount >= limit) {
      return null
    }

    const candidates: number[] = []
    if (
      params.preferredSlotIndex &&
      params.preferredSlotIndex >= 1 &&
      params.preferredSlotIndex <= limit
    ) {
      candidates.push(params.preferredSlotIndex)
    }
    for (let i = 1; i <= limit; i++) {
      if (!candidates.includes(i)) candidates.push(i)
    }

    for (const idx of candidates) {
      const slot = this.getOrCreateSlot(idx)
      if (slot.leasedByScanId === null) {
        slot.leasedByScanId = params.scanId
        slot.leasedByScanLabel = params.scanLabel
        slot.leasedWindowId = params.windowId
        slot.leasedWindowNumber = params.windowNumber
        slot.leasedWindowRange = params.windowRange
        slot.leasedAt = Date.now()
        return slot
      }
    }
    return null
  }

  /**
   * Enforce a global stagger when a slot launches Chrome for the first time
   * so multiple scans starting concurrently never spike CPU/disk at the same second.
   */
  public reserveLaunchStaggerDelayMs(slotIndex: number): number {
    const slot = this.getOrCreateSlot(slotIndex)
    if (slot.everLaunched) return 0
    slot.everLaunched = true
    const now = Date.now()
    if (this.lastLaunchAt === 0 || now >= this.lastLaunchAt + LAUNCH_STAGGER_MS) {
      this.lastLaunchAt = now
      return 0
    }
    const nextAt = this.lastLaunchAt + LAUNCH_STAGGER_MS
    this.lastLaunchAt = nextAt
    return Math.max(0, nextAt - now)
  }

  public releaseSlot(slotIndex: number, scanId?: string) {
    const slot = this.slots.get(slotIndex)
    if (!slot) return
    if (scanId && slot.leasedByScanId && slot.leasedByScanId !== scanId) {
      return
    }
    slot.controller.setPaused(false)
    slot.controller.setStepLogListener(undefined)
    slot.controller.setScanContextTag('')
    slot.leasedByScanId = null
    slot.leasedByScanLabel = null
    slot.leasedWindowId = null
    slot.leasedWindowNumber = null
    slot.leasedWindowRange = null
    slot.leasedAt = null
  }

  public async closeAndReleaseSlot(slotIndex: number, scanId?: string): Promise<void> {
    const slot = this.slots.get(slotIndex)
    if (!slot) return
    if (scanId && slot.leasedByScanId && slot.leasedByScanId !== scanId) {
      return
    }
    slot.controller.setPaused(false)
    slot.controller.setStepLogListener(undefined)
    slot.controller.setScanContextTag('')
    try {
      await slot.controller.closeContext()
    } catch {
      await killWorkerChromeProcessesByProfileDir(slot.profileDirName).catch(() => {})
    }
    if (!scanId || !slot.leasedByScanId || slot.leasedByScanId === scanId) {
      slot.leasedByScanId = null
      slot.leasedByScanLabel = null
      slot.leasedWindowId = null
      slot.leasedWindowNumber = null
      slot.leasedWindowRange = null
      slot.leasedAt = null
    }
  }

  public releaseAllSlotsForScan(scanId: string) {
    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId === scanId) {
        this.releaseSlot(slot.slotIndex, scanId)
      }
    }
  }

  public async closeAndReleaseAllSlotsForScan(scanId: string): Promise<void> {
    const closePromises: Promise<void>[] = []
    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId === scanId) {
        closePromises.push(this.closeAndReleaseSlot(slot.slotIndex, scanId))
      } else if (slot.leasedByScanId === null) {
        // Also ensure any unleased slot has 0 leftover zombie Chrome processes
        closePromises.push(
          slot.controller.closeContext().catch(() => {
            return killWorkerChromeProcessesByProfileDir(slot.profileDirName).then(() => {})
          }),
        )
      }
    }
    await Promise.allSettled(closePromises)
  }

  public getLeasedSlotsForScan(scanId: string): ProfileSlotEntry[] {
    const out: ProfileSlotEntry[] = []
    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId === scanId) {
        out.push(slot)
      }
    }
    return out.sort((a, b) => a.slotIndex - b.slotIndex)
  }

  public getSummary(poolLimit?: number): ParallelSlotPoolSummary {
    const totalSlots = Math.max(1, Math.min(20, poolLimit || this.maxTotalSlots))
    const byScanMap = new Map<string, { scanId: string; scanLabel: string; count: number }>()
    let inUseSlots = 0

    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId) {
        inUseSlots += 1
        const existing = byScanMap.get(slot.leasedByScanId)
        if (existing) {
          existing.count += 1
        } else {
          byScanMap.set(slot.leasedByScanId, {
            scanId: slot.leasedByScanId,
            scanLabel: slot.leasedByScanLabel || resolveScanDisplayLabel(slot.leasedByScanId),
            count: 1,
          })
        }
      }
    }

    const byScan = Array.from(byScanMap.values())
    const breakdown =
      byScan.length > 0
        ? ` (${byScan.map((s) => `${s.scanLabel}: ${s.count}`).join(', ')})`
        : ''
    const summaryText = `slots: ${inUseSlots}/${totalSlots} in use${breakdown}`

    return {
      totalSlots,
      inUseSlots,
      byScan,
      summaryText,
    }
  }
}

const globalForParallelStudio = globalThis as unknown as {
  __cmtGlobalProfileSlotPool?: GlobalProfileSlotPool
  __cmtStudioParallelManagers?: Map<string, StudioParallelManager>
  __cmtStudioParallelRestored?: boolean
}

export const globalProfileSlotPool: GlobalProfileSlotPool =
  globalForParallelStudio.__cmtGlobalProfileSlotPool ||
  (globalForParallelStudio.__cmtGlobalProfileSlotPool = new GlobalProfileSlotPool())

// ============================================================================
// PER-SCAN STUDIO PARALLEL MANAGER
// Each scanId has its own StudioParallelManager instance, its own state file
// `data/scans/<scanId>/parallel-state.json`, and its own JSONL log file
// `data/scans/<scanId>/parallel-log.jsonl`.
// ============================================================================

export class StudioParallelManager {
  public readonly scanId: string
  private scanName: string
  private windows: ParallelWindowState[] = []
  private active = false
  private starting = false
  private hasStartedRun = false
  private paused = false
  private stoppingAll = false
  private waitingForWorkerSlots = false
  private compressing360p: ParallelCompressionProgressInfo | null = null
  private mediaInfo: ParallelMediaVerificationInfo | null = null
  private stoppedWindowIds = new Set<string>()
  private username: string | null = null
  private currentRunId: string | null = null
  private runHistory: ParallelRunInfo[] = []
  private minuteInput: string = ''
  private minuteInputSource: 'auto' | 'manual' = 'auto'
  private foundMinutesInput: string = ''
  private concurrency: number = DEFAULT_STUDIO_CONCURRENCY
  private maxTotalPoolSlots: number = DEFAULT_STUDIO_CONCURRENCY
  private measuredTokenRate: number | null = null
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private shortLocalPath: string | null = null
  private shortYoutubeUrl: string | null = null
  private shortDriveFileName: string | null = null
  private shortDurationSec: number = 150
  private movieLocalPath: string | null = null
  private movieDriveFileName: string | null = null
  private movieDurationSec: number = 0
  private resourceWarning: string | null = null
  private combinedLogs: ParallelCombinedLogEntry[] = []
  private nextLogSeq = 1
  private totalLogLinesOnDisk = 0
  private resourceSnapshots: ParallelResourceSnapshot[] = []
  private lastResourceSnapAt = 0
  private resourceTimer: ReturnType<typeof setInterval> | null = null
  private onMatchCallback?: (windowState: ParallelWindowState, matches: ChunkMatch[]) => Promise<void>
  private onLogCallback?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  private usingOriginalMovieClips = false
  private clipCancelToken: CancelToken | null = null
  private windowClipPromises = new Map<string, Promise<WindowClipResult>>()
  private startWindowClipTask?: (w: ParallelWindowState) => Promise<WindowClipResult>
  private clipsReady = 0
  private clipsTotal = 0
  private clipsExtracting = false
  private clipExtractActiveCount = 0
  private clipExtractWaitQueue: Array<() => void> = []

  constructor(scanId: string) {
    killAllLeftoverChromeProcessesOnceOnStartup()
    this.scanId = scanId || 'default'
    this.scanName = resolveScanDisplayLabel(this.scanId)
    this.migrateStaleScanStateOnce()
    this.tryRestorePersistedState()
    this.tryLoadCombinedLogsFromDisk()
  }

  public getCurrentRunId(): string | null {
    return this.currentRunId
  }

  public getRunHistory(): ParallelRunInfo[] {
    return this.runHistory
  }

  public getScanDir(): string {
    return path.join(DATA_DIR, 'scans', this.scanId)
  }

  public getScanMediaDir(): string {
    return path.join(MEDIA_DIR, this.scanId)
  }

  public isPathStrictlyInsideThisScanMediaDir(candidatePath?: string | null): boolean {
    if (!candidatePath || !this.scanId || this.scanId === 'default') return false
    const scanMediaDir = path.resolve(this.getScanMediaDir())
    const resolvedCandidate = path.resolve(candidatePath)
    return resolvedCandidate.startsWith(scanMediaDir + path.sep)
  }

  public getStateFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-state.json')
  }

  public getLogFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-log.jsonl')
  }

  public getRotatedLogFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-log.1.jsonl')
  }

  /**
   * One-time migration to clear stale global default studioMinuteInput ("7,8,9,10,...,71-100")
   * and stale 18-window parallel-state for scan 2238bf22dd532047 (and any scan that had the old
   * global default prefilled without manual edit).
   */
  private migrateStaleScanStateOnce() {
    if (!this.scanId || this.scanId === 'default') return
    try {
      const scanDir = this.getScanDir()
      const markerFile = path.join(scanDir, '.migrated-stale-minutes-v2')
      if (fs.existsSync(markerFile)) return

      const scan = getScan(this.scanId)
      const foundCompact = extractScanFoundMinutesCompact(scan)
      const isTargetStaleScan = this.scanId === '2238bf22dd532047'
      const hasOldGlobalDefaultOnScan =
        scan?.studioMinuteInput?.trim() === DEFAULT_STUDIO_MINUTE_INPUT &&
        scan?.studioMinuteInputSource !== 'manual'

      let hasOldGlobalDefaultInStateFile = false
      const stateFile = this.getStateFilePath()
      if (fs.existsSync(stateFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<PersistedParallelState>
          if (
            parsed?.minuteInput?.trim() === DEFAULT_STUDIO_MINUTE_INPUT &&
            parsed?.minuteInputSource !== 'manual' &&
            foundCompact !== DEFAULT_STUDIO_MINUTE_INPUT
          ) {
            hasOldGlobalDefaultInStateFile = true
          }
        } catch {
          /* ignore */
        }
      }

      if (isTargetStaleScan || hasOldGlobalDefaultOnScan || hasOldGlobalDefaultInStateFile) {
        for (const f of [
          stateFile,
          path.join(scanDir, 'parallel-windows.json'),
          path.join(scanDir, 'parallel-merged-report.json'),
          path.join(scanDir, 'parallel-merged-report.txt'),
        ]) {
          try {
            if (fs.existsSync(f)) fs.rmSync(f, { force: true })
          } catch {
            /* ignore */
          }
        }

        if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
          try {
            const legacy = JSON.parse(fs.readFileSync(LEGACY_PARALLEL_STATE_FILE, 'utf8'))
            if (
              legacy?.scanId === this.scanId ||
              legacy?.minuteInput?.trim() === DEFAULT_STUDIO_MINUTE_INPUT
            ) {
              fs.renameSync(LEGACY_PARALLEL_STATE_FILE, LEGACY_PARALLEL_STATE_MIGRATED_FILE)
            }
          } catch {
            /* ignore */
          }
        }

        if (scan) {
          scan.studioMinuteInput = foundCompact || null
          scan.studioMinuteInputSource = 'auto'
          saveScan(scan, { immediate: true })
        }

        this.windows = []
        this.hasStartedRun = false
        this.minuteInput = foundCompact
        this.minuteInputSource = 'auto'
        this.foundMinutesInput = foundCompact
        this.startedAt = null
        this.finishedAt = null
      }

      fs.mkdirSync(scanDir, { recursive: true })
      fs.writeFileSync(markerFile, String(Date.now()), 'utf8')
    } catch {
      /* ignore migration error */
    }
  }

  private refreshScanMetadataFromStore() {
    this.scanName = resolveScanDisplayLabel(this.scanId)
    if (this.scanId && this.scanId !== 'default') {
      try {
        const scan = getScan(this.scanId)
        if (scan) {
          const dur = resolveScanMovieDurationSec(scan)
          if (dur && dur > 0) {
            this.movieDurationSec = dur
          }
          if (scan.shortDuration && scan.shortDuration > 0) {
            this.shortDurationSec = scan.shortDuration
          }
          if (
            typeof scan.studioParallelConcurrency === 'number' &&
            scan.studioParallelConcurrency >= 1 &&
            !this.active &&
            !this.starting
          ) {
            this.concurrency = scan.studioParallelConcurrency
          }

          const foundCompact = extractScanFoundMinutesCompact(scan)
          this.foundMinutesInput = foundCompact

          // Never allow old global DEFAULT_STUDIO_MINUTE_INPUT to masquerade as scan's minuteInput unless manually set
          if (
            scan.studioMinuteInput?.trim() === DEFAULT_STUDIO_MINUTE_INPUT &&
            scan.studioMinuteInputSource !== 'manual' &&
            foundCompact !== DEFAULT_STUDIO_MINUTE_INPUT
          ) {
            scan.studioMinuteInput = foundCompact || null
            scan.studioMinuteInputSource = 'auto'
            saveScan(scan)
          }

          const source: 'auto' | 'manual' =
            scan.studioMinuteInputSource === 'manual' ? 'manual' : 'auto'
          this.minuteInputSource = source

          if (!this.active && !this.starting) {
            if (source === 'auto') {
              this.minuteInput = foundCompact
              if ((scan.studioMinuteInput || '') !== foundCompact) {
                scan.studioMinuteInput = foundCompact || null
                scan.studioMinuteInputSource = 'auto'
                saveScan(scan)
              }
            } else {
              this.minuteInput = (scan.studioMinuteInput ?? this.minuteInput ?? '').trim()
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private tryRestorePersistedState() {
    try {
      const primaryFile = this.getStateFilePath()
      const legacyScanWindowsFile = path.join(this.getScanDir(), 'parallel-windows.json')
      let raw: Partial<PersistedParallelState> | null = null
      let migratedFromLegacyGlobal = false

      if (fs.existsSync(primaryFile)) {
        raw = JSON.parse(fs.readFileSync(primaryFile, 'utf8'))
      } else if (fs.existsSync(legacyScanWindowsFile)) {
        raw = JSON.parse(fs.readFileSync(legacyScanWindowsFile, 'utf8'))
      } else if (
        this.scanId &&
        this.scanId !== 'default' &&
        fs.existsSync(LEGACY_PARALLEL_STATE_FILE)
      ) {
        // Strict one-time migration: ONLY migrate to the scanId written inside data/studio-parallel-state.json,
        // then immediately rename it to data/studio-parallel-state.json.migrated so it never touches any other scan.
        try {
          const legacyGlobal = JSON.parse(fs.readFileSync(LEGACY_PARALLEL_STATE_FILE, 'utf8'))
          if (legacyGlobal && legacyGlobal.scanId === this.scanId) {
            raw = legacyGlobal
            migratedFromLegacyGlobal = true
            try {
              fs.renameSync(LEGACY_PARALLEL_STATE_FILE, LEGACY_PARALLEL_STATE_MIGRATED_FILE)
            } catch {
              /* ignore rename error */
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (raw && raw.scanId && raw.scanId !== this.scanId) {
        // Never allow another scan's state file to load into this scan
        raw = null
      }

      if (raw && Array.isArray(raw.windows) && raw.windows.length > 0) {
        this.username = raw.username || 'admin'
        this.scanName = raw.scanName || resolveScanDisplayLabel(this.scanId)
        this.currentRunId = raw.currentRunId ?? null
        this.runHistory = Array.isArray(raw.runHistory) ? raw.runHistory : []
        this.minuteInputSource = raw.minuteInputSource === 'manual' ? 'manual' : 'auto'
        this.minuteInput =
          raw.minuteInput && raw.minuteInput.trim() !== DEFAULT_STUDIO_MINUTE_INPUT
            ? raw.minuteInput.trim()
            : raw.minuteInputSource === 'manual'
              ? (raw.minuteInput || '').trim()
              : ''
        this.concurrency = raw.concurrency || DEFAULT_STUDIO_CONCURRENCY

        // Strictly accept saved paths ONLY if they belong to data/media/<this.scanId>/
        this.shortLocalPath = this.isPathStrictlyInsideThisScanMediaDir(raw.shortLocalPath)
          ? (raw.shortLocalPath ?? null)
          : null
        this.shortYoutubeUrl = raw.shortYoutubeUrl ?? null
        this.shortDriveFileName = raw.shortDriveFileName ?? null
        this.shortDurationSec = raw.shortDurationSec || 150
        this.movieLocalPath =
          this.isPathStrictlyInsideThisScanMediaDir(raw.movieLocalPath) &&
          path.basename(raw.movieLocalPath || '') === 'movie_360p.mp4'
            ? (raw.movieLocalPath ?? null)
            : null
        this.movieDriveFileName = raw.movieDriveFileName ?? null
        this.movieDurationSec = raw.movieDurationSec || 0
        this.startedAt = raw.startedAt || null
        this.finishedAt = raw.finishedAt || null
        this.mediaInfo =
          raw.mediaInfo && raw.mediaInfo.scanId === this.scanId ? raw.mediaInfo : null
        this.resourceSnapshots = Array.isArray(raw.resourceSnapshots)
          ? raw.resourceSnapshots.map((s) => ({
              ...s,
              chromeProcessCount:
                typeof s.chromeProcessCount === 'number' ? s.chromeProcessCount : 0,
            }))
          : []

        const anyWindowRan = raw.windows.some(
          (w) =>
            w.status === 'DONE' ||
            w.status === 'PROHIBITED' ||
            w.status === 'FAILED' ||
            w.status === 'RETRYING' ||
            (typeof w.attempt === 'number' && w.attempt > 0) ||
            w.startedAt !== null,
        )
        this.hasStartedRun =
          typeof raw.hasStartedRun === 'boolean' ? raw.hasStartedRun : anyWindowRan

        // Any window that was in-flight when container restarted goes back to QUEUED; DONE stays DONE
        this.windows = raw.windows.map((w) => {
          if (
            w.status === 'ASSIGNED' ||
            w.status === 'SETUP' ||
            w.status === 'RUNNING' ||
            w.status === 'VALIDATING' ||
            w.status === 'RETRYING' ||
            w.status === '403_WAIT' ||
            w.status === 'WAITING_FOR_WORKER' ||
            w.status === 'WAITING_FOR_UPLOAD_GATE' ||
            w.status === 'WAITING_FOR_RAM'
          ) {
            return {
              ...w,
              status: 'QUEUED',
              workerId: null,
              stage: 'queued (resumed)',
            }
          }
          return {
            ...w,
            workerId: null,
          }
        })

        if (migratedFromLegacyGlobal) {
          this.persistStateToDisk()
        }
      }

      this.refreshScanMetadataFromStore()
    } catch {
      /* ignore corrupt state file */
    }
  }

  /**
   * True ONLY if this scan has its own `data/scans/<scanId>/parallel-state.json` on disk
   * from an actual started run and has at least one DONE or incomplete (QUEUED/FAILED/RETRYING) window.
   */
  public hasResumableStateOnDisk(): boolean {
    if (!this.scanId || this.scanId === 'default') return false
    if (!fs.existsSync(this.getStateFilePath())) return false
    if (this.windows.length === 0) return false
    const anyDoneOrAttempted =
      this.hasStartedRun ||
      this.windows.some(
        (w) =>
          w.status === 'DONE' ||
          w.status === 'PROHIBITED' ||
          w.status === 'FAILED' ||
          w.status === 'RETRYING' ||
          (typeof w.attempt === 'number' && w.attempt > 0) ||
          w.startedAt !== null,
      )
    if (!anyDoneOrAttempted) return false
    return this.windows.some(
      (w) =>
        w.status === 'DONE' ||
        w.status === 'PROHIBITED' ||
        w.status === 'QUEUED' ||
        w.status === 'FAILED' ||
        w.status === 'RETRYING' ||
        w.status === 'STOPPED' ||
        w.status === 'NEEDS_ATTENTION',
    )
  }

  private tryLoadCombinedLogsFromDisk() {
    try {
      const logFile = this.getLogFilePath()
      if (!fs.existsSync(logFile)) return
      const content = fs.readFileSync(logFile, 'utf8')
      const lines = content.split('\n').filter((l) => l.trim().length > 0)
      this.totalLogLinesOnDisk = lines.length
      const tail = lines.slice(-UI_COMBINED_LOG_LIMIT)
      const parsed: ParallelCombinedLogEntry[] = []
      for (const line of tail) {
        try {
          const obj = JSON.parse(line) as ParallelCombinedLogEntry
          if (obj && typeof obj.t === 'number') {
            parsed.push(obj)
            if (typeof obj.seq === 'number' && obj.seq >= this.nextLogSeq) {
              this.nextLogSeq = obj.seq + 1
            }
          }
        } catch {
          /* skip malformed line */
        }
      }
      this.combinedLogs = parsed
    } catch {
      /* ignore */
    }
  }

  /**
   * Read ALL combined logs from disk (including rotated .1.jsonl if present) for full PDF export.
   */
  public readAllCombinedLogsFromDisk(): ParallelCombinedLogEntry[] {
    const out: ParallelCombinedLogEntry[] = []
    const files = [this.getRotatedLogFilePath(), this.getLogFilePath()]
    for (const file of files) {
      try {
        if (!fs.existsSync(file)) continue
        const raw = fs.readFileSync(file, 'utf8')
        const lines = raw.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as ParallelCombinedLogEntry
            if (parsed && typeof parsed.t === 'number') {
              out.push(parsed)
            }
          } catch {
            /* skip malformed line */
          }
        }
      } catch {
        /* ignore read error */
      }
    }
    if (out.length === 0 && this.combinedLogs.length > 0) {
      return [...this.combinedLogs]
    }
    return out.sort((a, b) => a.t - b.t || a.seq - b.seq)
  }

  public appendCombinedLog(params: {
    workerId: string
    windowId?: string | null
    windowNumber?: number | null
    windowRange?: string | null
    level: ParallelLogLevel
    step: string
    message: string
    t?: number
  }): ParallelCombinedLogEntry {
    const now = params.t || Date.now()
    const elapsedSec = this.startedAt ? Math.max(0, Math.round((now - this.startedAt) / 1000)) : 0
    const entry: ParallelCombinedLogEntry = {
      seq: this.nextLogSeq++,
      t: now,
      elapsedSec,
      runId: this.currentRunId ?? null,
      scanId: this.scanId,
      scanName: this.scanName,
      workerId: params.workerId || 'SYS',
      windowId: params.windowId ?? null,
      windowNumber: params.windowNumber ?? null,
      windowRange: params.windowRange ?? null,
      level: params.level,
      step: params.step,
      message: params.message,
    }

    this.combinedLogs.push(entry)
    if (this.combinedLogs.length > UI_COMBINED_LOG_LIMIT) {
      this.combinedLogs.splice(0, this.combinedLogs.length - UI_COMBINED_LOG_LIMIT)
    }
    this.totalLogLinesOnDisk += 1

    try {
      const scanDir = this.getScanDir()
      fs.mkdirSync(scanDir, { recursive: true })
      const logFile = this.getLogFilePath()
      if (this.totalLogLinesOnDisk % 200 === 0 && fs.existsSync(logFile)) {
        const st = fs.statSync(logFile)
        if (st.size >= MAX_LOG_FILE_BYTES) {
          const rotated = this.getRotatedLogFilePath()
          try {
            fs.renameSync(logFile, rotated)
          } catch {
            /* ignore rotation race */
          }
        }
      }
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* ignore disk append error */
    }

    return entry
  }

  private recordResourceSnapshotIfNeeded(force = false, note?: string) {
    const now = Date.now()
    if (!force && now - this.lastResourceSnapAt < 10_000) return
    this.lastResourceSnapAt = now

    const slotSummary = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
    const activeForThisScan = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId).length
    const chromeStats = readChromeProcsPerWorker(Math.max(this.concurrency, slotSummary.totalSlots))
    const snap: ParallelResourceSnapshot = {
      t: now,
      elapsedSec: this.startedAt ? Math.max(0, Math.round((now - this.startedAt) / 1000)) : 0,
      runId: this.currentRunId ?? null,
      ramUsedPercent: readSystemRamUsedPercent(),
      freeDiskGb: readFreeDiskGb(),
      devShmUsedMb: readDevShmUsedMb(),
      activeWorkers: activeForThisScan,
      slotsInUse: slotSummary.inUseSlots,
      totalSlots: slotSummary.totalSlots,
      chromeProcessCount: chromeStats.totalProcs,
      chromeProcsPerWorker: chromeStats.perWorkerProcs,
      chromeRssMbPerWorker: chromeStats.perWorkerRssMb,
      ...(note ? { note } : {}),
    }
    this.resourceSnapshots.push(snap)
    if (this.resourceSnapshots.length > 400) {
      this.resourceSnapshots.splice(0, this.resourceSnapshots.length - 400)
    }
  }

  private startResourceSnapshotTimer() {
    this.stopResourceSnapshotTimer()
    this.resourceTimer = setInterval(() => {
      if (this.active || this.starting) {
        this.recordResourceSnapshotIfNeeded(true)
      }
    }, 10_000)
  }

  private stopResourceSnapshotTimer() {
    if (this.resourceTimer) {
      clearInterval(this.resourceTimer)
      this.resourceTimer = null
    }
  }

  private persistStateToDisk() {
    try {
      const scanDir = this.getScanDir()
      fs.mkdirSync(scanDir, { recursive: true })
      const payload: PersistedParallelState = {
        version: 2,
        scanId: this.scanId,
        scanName: this.scanName,
        username: this.username || 'admin',
        currentRunId: this.currentRunId,
        runHistory: this.runHistory,
        minuteInput: this.minuteInput,
        minuteInputSource: this.minuteInputSource,
        concurrency: this.concurrency,
        hasStartedRun: this.hasStartedRun,
        mediaInfo: this.mediaInfo,
        shortLocalPath: this.shortLocalPath,
        shortYoutubeUrl: this.shortYoutubeUrl,
        shortDriveFileName: this.shortDriveFileName,
        shortDurationSec: this.shortDurationSec,
        movieLocalPath: this.movieLocalPath,
        movieDriveFileName: this.movieDriveFileName,
        movieDurationSec: this.movieDurationSec,
        startedAt: this.startedAt,
        finishedAt: this.finishedAt,
        updatedAt: Date.now(),
        windows: this.windows,
        resourceSnapshots: this.resourceSnapshots,
      }
      const jsonStr = JSON.stringify(payload, null, 2)
      fs.writeFileSync(this.getStateFilePath(), jsonStr, 'utf8')
      fs.writeFileSync(path.join(scanDir, 'parallel-windows.json'), jsonStr, 'utf8')

      const report = this.getMergedReport()
      const reportJsonPath = path.join(scanDir, 'parallel-merged-report.json')
      const reportTxtPath = path.join(scanDir, 'parallel-merged-report.txt')
      if (report && report.totalShortSegments > 0) {
        fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8')
        fs.writeFileSync(reportTxtPath, report.formattedTxt, 'utf8')
      } else {
        try {
          if (fs.existsSync(reportJsonPath)) fs.rmSync(reportJsonPath, { force: true })
          if (fs.existsSync(reportTxtPath)) fs.rmSync(reportTxtPath, { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore disk write error */
    }
  }

  private persistMinuteInputOnScanRecord(
    minuteInput: string,
    concurrency: number,
    source?: 'auto' | 'manual',
  ) {
    if (!this.scanId || this.scanId === 'default') return
    try {
      const scan = getScan(this.scanId)
      if (scan) {
        scan.studioMinuteInput = minuteInput || null
        if (source) {
          scan.studioMinuteInputSource = source
        }
        scan.studioParallelConcurrency = concurrency
        saveScan(scan)
      }
    } catch {
      /* ignore */
    }
  }

  public isRunning(): boolean {
    return this.active || this.starting
  }

  public getWindows(): ParallelWindowState[] {
    return this.windows
  }

  public getResourceSnapshots(): ParallelResourceSnapshot[] {
    return this.resourceSnapshots
  }

  public getMediaInfo(): ParallelMediaVerificationInfo | null {
    return this.mediaInfo
  }

  public getMergedReport(): ParallelMergedReport | null {
    if (this.windows.length === 0) return null
    return mergeParallelWindowResults({
      windows: this.windows,
    })
  }

  /**
   * Reset this scan's minuteInput back to its own "Minutes found" compact range and set source='auto'.
   */
  public resetMinuteInputToFound(): {
    minuteInput: string
    minuteInputSource: 'auto'
    foundMinutesInput: string
  } {
    this.refreshScanMetadataFromStore()
    this.minuteInputSource = 'auto'
    this.minuteInput = this.foundMinutesInput
    this.persistMinuteInputOnScanRecord(this.minuteInput, this.concurrency, 'auto')
    return {
      minuteInput: this.minuteInput,
      minuteInputSource: 'auto',
      foundMinutesInput: this.foundMinutesInput,
    }
  }

  /**
   * Build / preview the windows from minuteInput for THIS scan, clearing stale windows/state, and persist config.
   */
  public previewPlan(
    minuteInput?: string,
    concurrency?: number,
    movieDurationSec?: number,
    options?: { source?: 'auto' | 'manual' },
  ): ParallelWindowState[] {
    this.refreshScanMetadataFromStore()
    if (options?.source) {
      this.minuteInputSource = options.source
    }
    if (minuteInput !== undefined) {
      const trimmed = minuteInput.trim()
      this.minuteInput = trimmed
      if (!options?.source) {
        this.minuteInputSource =
          trimmed && trimmed !== this.foundMinutesInput ? 'manual' : 'auto'
      }
    } else if (this.minuteInputSource === 'auto') {
      this.minuteInput = this.foundMinutesInput
    }
    if (concurrency !== undefined && Number.isFinite(Number(concurrency))) {
      this.concurrency = Math.max(1, Math.min(20, Math.round(Number(concurrency))))
    }
    if (movieDurationSec !== undefined && movieDurationSec > 0) {
      this.movieDurationSec = movieDurationSec
    }

    this.persistMinuteInputOnScanRecord(
      this.minuteInput,
      this.concurrency,
      this.minuteInputSource,
    )

    const effectiveMovieDur =
      this.movieDurationSec && this.movieDurationSec > 0 ? this.movieDurationSec : undefined
    const { windows } = buildParallelWindowsFromMinuteInput(this.minuteInput, effectiveMovieDur)
    if (!this.active && !this.starting) {
      // Clear old parallel state (stale windows, failed counts, merged report) for this scan
      this.startedAt = null
      this.finishedAt = null
      this.hasStartedRun = false
      this.stoppedWindowIds.clear()
      this.waitingForWorkerSlots = false
      this.resourceWarning = null
      this.resourceSnapshots = []
      this.clipsReady = 0
      this.clipsTotal = 0
      this.clipsExtracting = false
      this.windows = windows.map((w) => ({
        ...w,
        status: 'QUEUED',
        workerId: null,
        modelName: DEFAULT_STUDIO_MODEL_NAME,
        stage: 'queued',
        tokens: null,
        attempt: 0,
        maxAttempts: 5,
        permRetry: 0,
        startedAt: null,
        finishedAt: null,
        elapsedSec: 0,
        matchCount: 0,
        summaryText: 'Queued',
        error: null,
      }))
      this.persistStateToDisk()
    }
    return this.windows
  }

  /**
   * Verify and (if needed) compress `data/media/<scanId>/movie_360p.mp4` and verify `short.mp4`
   * strictly inside `data/media/<scanId>/` BEFORE launching any parallel worker.
   * Never falls back to raw `movie.mp4` or another scan's media directory.
   */
  private async verifyAndEnsureScanMediaReadyBeforeStart(): Promise<ParallelMediaVerificationInfo> {
    if (!this.scanId || this.scanId === 'default') {
      throw new Error('Cannot start Parallel Scan without a valid scanId')
    }

    const scan = getScan(this.scanId)
    if (!scan) {
      throw new Error(`Scan ${this.scanId} not found in store`)
    }

    // 1. Verify short media strictly from data/media/<this.scanId>/
    const shortReady = await ensureStudioShortReady(this.scanId)
    if (!this.isPathStrictlyInsideThisScanMediaDir(shortReady.localPath)) {
      throw new Error(
        `Short media path (${shortReady.localPath}) is not inside data/media/${this.scanId}/`,
      )
    }

    const expectedMovieDuration =
      resolveScanMovieDurationSec(scan) ||
      (this.movieDurationSec > 0 ? this.movieDurationSec : null)

    // 2. Check existing data/media/<this.scanId>/movie_360p.mp4
    let movieCheck = await verifyStudioMovie360pFile(this.scanId, expectedMovieDuration)

    if (!movieCheck.valid) {
      const reasonMsg = movieCheck.reason || 'movie_360p.mp4 missing or invalid'
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'INFO',
        step: 'compress 360p start',
        message: `movie_360p.mp4 check failed (${reasonMsg}) -> running 360p compression pipeline for scan ${this.scanId} (no fallback to raw movie.mp4)`,
      })

      this.compressing360p = {
        active: true,
        progress: 0,
        statusText: 'Compressing movie 360p... 0%',
        sizeBytes: null,
        error: null,
      }

      const pollTimer = setInterval(() => {
        try {
          const latestScan = getScan(this.scanId)
          const m360 = latestScan?.movie360p
          if (m360 && this.compressing360p?.active) {
            const pct = Math.max(0, Math.min(100, Math.round(m360.progress || 0)))
            const sizePart =
              m360.sizeBytes && m360.sizeBytes > 0
                ? ` (${(m360.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`
                : ''
            this.compressing360p = {
              active: true,
              progress: pct,
              statusText: `Compressing movie 360p... ${pct}%${sizePart}`,
              sizeBytes: m360.sizeBytes ?? null,
              error: m360.error ?? null,
            }
          }
        } catch {
          /* ignore */
        }
      }, 1000)

      try {
        await prepareStudioMovie360pAndDrive(this.scanId)
      } finally {
        clearInterval(pollTimer)
      }

      if (this.stoppingAll) {
        this.compressing360p = null
        throw new Error('STOPPED BY USER')
      }

      const postScan = getScan(this.scanId)
      const prepState = postScan?.movie360p
      if (prepState?.status === 'error') {
        const errMsg =
          prepState.error || 'Failed to compress movie_360p.mp4 (<= 390 MB required)'
        this.compressing360p = {
          active: false,
          progress: 0,
          statusText: `360p compression failed: ${errMsg}`,
          error: errMsg,
        }
        throw new Error(`360p compression failed for scan ${this.scanId}: ${errMsg}`)
      }

      movieCheck = await verifyStudioMovie360pFile(this.scanId, expectedMovieDuration)
      if (!movieCheck.valid) {
        const errMsg =
          movieCheck.reason || 'movie_360p.mp4 verification failed after compression'
        this.compressing360p = {
          active: false,
          progress: 0,
          statusText: `360p verification failed: ${errMsg}`,
          error: errMsg,
        }
        throw new Error(`360p verification failed for scan ${this.scanId}: ${errMsg}`)
      }
    }

    this.compressing360p = null

    if (!this.isPathStrictlyInsideThisScanMediaDir(movieCheck.filePath)) {
      throw new Error(
        `Movie 360p path (${movieCheck.filePath}) is not inside data/media/${this.scanId}/`,
      )
    }

    const verifiedInfo: ParallelMediaVerificationInfo = {
      scanId: this.scanId,
      shortPath: shortReady.localPath,
      shortSizeBytes: shortReady.sizeBytes,
      shortDurationSec: shortReady.durationSec,
      movie360Path: movieCheck.filePath,
      movie360SizeBytes: movieCheck.sizeBytes,
      movie360DurationSec: movieCheck.durationSec,
      verifiedAt: Date.now(),
    }

    return verifiedInfo
  }

  /**
   * Start or resume a Parallel Window Scan for THIS scanId using the Global Profile Slot Pool.
   * Idempotent: if already active or starting for this scan, ignores duplicate Start requests.
   */
  public async startParallelScan(params: {
    username: string
    scanId?: string | null
    minuteInput?: string
    minuteInputSource?: 'auto' | 'manual'
    concurrency?: number
    shortLocalPath?: string | null
    shortYoutubeUrl?: string | null
    shortDriveFileName?: string | null
    shortDurationSec?: number
    movieLocalPath?: string | null
    movieDriveFileName?: string | null
    movieDurationSec?: number
    resumeExisting?: boolean
    onWindowMatches?: (windowState: ParallelWindowState, matches: ChunkMatch[]) => Promise<void>
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<{ totalWindows: number; concurrency: number; scanId: string; alreadyRunning?: boolean }> {
    // 6. Double-start prevention: idempotent per-scan guard
    if (this.active || this.starting) {
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'INFO',
        step: 'duplicate start ignored',
        message: `Ignored duplicate Start click for ${this.scanName} (already running/starting)`,
      })
      return {
        totalWindows: this.windows.length,
        concurrency: this.concurrency,
        scanId: this.scanId,
        alreadyRunning: true,
      }
    }

    this.starting = true
    this.stoppingAll = false
    this.paused = false

    try {
      this.refreshScanMetadataFromStore()
      const cfg = await loadStudioUserConfig(params.username)
      this.username = params.username

      if (params.minuteInputSource) {
        this.minuteInputSource = params.minuteInputSource
      }
      if (params.minuteInput !== undefined && params.minuteInput.trim()) {
        const trimmed = params.minuteInput.trim()
        this.minuteInput = trimmed
        if (!params.minuteInputSource) {
          this.minuteInputSource =
            trimmed !== this.foundMinutesInput ? 'manual' : 'auto'
        }
      } else if (!this.minuteInput) {
        this.minuteInput = this.foundMinutesInput
        this.minuteInputSource = 'auto'
      }

      if (!this.minuteInput || !this.minuteInput.trim()) {
        throw new Error('Pehle window scan poora chalao (Minutes found khali hai)')
      }

      const globalMaxSlots = Math.max(
        1,
        Math.min(20, Number(cfg.studioConcurrency || DEFAULT_STUDIO_CONCURRENCY)),
      )
      this.maxTotalPoolSlots = globalMaxSlots
      globalProfileSlotPool.setMaxTotalSlots(globalMaxSlots)

      const uploadGateLimit = Math.max(
        1,
        Math.min(10, Number(cfg.studioUploadGateConcurrency || DEFAULT_STUDIO_UPLOAD_GATE)),
      )
      globalStudioUploadGate.setMaxConcurrent(uploadGateLimit)

      this.concurrency = Math.max(
        1,
        Math.min(
          20,
          Number(params.concurrency ?? this.concurrency ?? cfg.studioConcurrency ?? DEFAULT_STUDIO_CONCURRENCY),
        ),
      )

      this.persistMinuteInputOnScanRecord(
        this.minuteInput,
        this.concurrency,
        this.minuteInputSource,
      )

      this.measuredTokenRate = cfg.studioMeasuredTokenRate ?? null
      if (params.onWindowMatches) this.onMatchCallback = params.onWindowMatches
      if (params.onLog) this.onLogCallback = params.onLog

      // Build/update windows list upfront so the UI shows the planned windows even if 360p compression runs first
      const savedWindowsHadOverlap =
        this.windows.length > 1 &&
        this.windows.some(
          (w, idx) =>
            idx > 0 &&
            w.runIndex === this.windows[idx - 1].runIndex &&
            w.startSec < this.windows[idx - 1].endSec,
        )
      if (savedWindowsHadOverlap) {
        this.appendCombinedLog({
          workerId: 'SYS',
          level: 'INFO',
          step: 'rebuilt windows',
          message: 'rebuilt windows: saved windows had overlap',
        })
        this.onLogCallback?.('info', 'rebuilt windows: saved windows had overlap')
      }

      const canResume =
        !savedWindowsHadOverlap &&
        Boolean(params.resumeExisting) &&
        this.hasResumableStateOnDisk() &&
        this.windows.length > 0 &&
        this.windows.some(
          (w) =>
            w.status === 'DONE' ||
            w.status === 'PROHIBITED' ||
            w.status === 'QUEUED' ||
            w.status === 'FAILED' ||
            w.status === 'RETRYING' ||
            w.status === 'STOPPED' ||
            w.status === 'NEEDS_ATTENTION',
        )

      const initialEffectiveModel =
        (await getEffectiveModel(cfg.studioModelName)) ||
        cfg.studioModelName ||
        DEFAULT_STUDIO_MODEL_NAME

      if (!canResume) {
        const effectiveMovieDur =
          this.movieDurationSec && this.movieDurationSec > 0 ? this.movieDurationSec : undefined
        const { windows } = buildParallelWindowsFromMinuteInput(
          this.minuteInput,
          effectiveMovieDur,
        )
        this.windows = windows.map((w) => ({
          ...w,
          status: 'QUEUED',
          workerId: null,
          modelName: initialEffectiveModel,
          stage: 'queued',
          tokens: null,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          startedAt: null,
          finishedAt: null,
          elapsedSec: 0,
          matchCount: 0,
          summaryText: 'Queued',
          error: null,
        }))
        this.startedAt = Date.now()
        this.finishedAt = null
      } else {
        for (const w of this.windows) {
          if (w.status !== 'DONE' && w.status !== 'PROHIBITED' && w.status !== 'SKIPPED') {
            w.status = 'QUEUED'
            w.workerId = null
            w.stage = 'queued'
            w.error = null
          }
        }
        this.startedAt = Date.now()
        this.finishedAt = null
      }

      // Generate a fresh runId on every Start so PDF exports default to the latest run only
      const newRunId = `run-${Date.now()}`
      this.currentRunId = newRunId
      this.runHistory.push({
        runId: newRunId,
        startedAt: this.startedAt || Date.now(),
        finishedAt: null,
      })
      if (this.runHistory.length > 50) {
        this.runHistory.splice(0, this.runHistory.length - 50)
      }

      // 1. Pre-check short media & check whether movie_360p.mp4 is already verified
      if (!this.scanId || this.scanId === 'default') {
        throw new Error('Cannot start Parallel Scan without a valid scanId')
      }
      const scanRecord = getScan(this.scanId)
      if (!scanRecord) {
        throw new Error(`Scan ${this.scanId} not found in store`)
      }

      const shortReady = await ensureStudioShortReady(this.scanId)
      if (!this.isPathStrictlyInsideThisScanMediaDir(shortReady.localPath)) {
        throw new Error(
          `Short media path (${shortReady.localPath}) is not inside data/media/${this.scanId}/`,
        )
      }

      const expectedMovieDuration =
        resolveScanMovieDurationSec(scanRecord) ||
        (this.movieDurationSec > 0 ? this.movieDurationSec : null)

      const rawMoviePath = path.join(this.getScanMediaDir(), 'movie.mp4')
      const hasOriginalMovie =
        fs.existsSync(rawMoviePath) &&
        (() => {
          try {
            return fs.statSync(rawMoviePath).size > 0
          } catch {
            return false
          }
        })()

      const startWindowClipExtractionForWindow = (w: ParallelWindowState): Promise<WindowClipResult> => {
        const existing = this.windowClipPromises.get(w.id)
        if (existing) return existing

        if (w.status === 'QUEUED') {
          w.stage = 'Extracting clip...'
          w.summaryText = 'Extracting window clip...'
        }
        const token = this.clipCancelToken ?? undefined

        const runWithSemaphore = async (): Promise<WindowClipResult> => {
          await this.acquireClipExtractSlot()
          try {
            const t0 = Date.now()
            const clipRes = await ensureWindowClip(
              this.scanId,
              {
                windowNumber: w.windowNumber,
                startSec: w.startSec,
                endSec: w.endSec,
              },
              { token },
            )
            const sizeBytes = (() => {
              try {
                return fs.statSync(clipRes.clipPath).size
              } catch {
                return 0
              }
            })()
            const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
            const extractSec = ((Date.now() - t0) / 1000).toFixed(1)
            const endFrame = clipRes.clipStartFrame + clipRes.frameCount
            if (w.status === 'QUEUED' && w.stage === 'Extracting clip...') {
              if (clipRes.cached) {
                w.stage = 'Clip ready (cached)'
                w.summaryText = `Clip ready (cached, ${sizeMb} MB)`
              } else {
                w.stage = `Clip ready (extracted, ${sizeMb} MB, ${extractSec} s)`
                w.summaryText = `Clip ready (extracted, ${sizeMb} MB, ${extractSec} s)`
              }
            }
            this.clipsReady = Math.min(this.clipsTotal, this.clipsReady + 1)
            if (this.clipsReady >= this.clipsTotal) {
              this.clipsExtracting = false
            }
            const winRange = `${w.startFormatted}–${w.endFormatted}`
            this.appendCombinedLog({
              workerId: 'SYS',
              windowId: w.id,
              windowNumber: w.windowNumber,
              windowRange: winRange,
              level: 'INFO',
              step: clipRes.cached ? 'Clip ready (cached)' : 'Clip ready (extracted)',
              message: clipRes.cached
                ? `Window #${w.windowNumber} (${winRange}): Clip ready (cached, ${sizeMb} MB, frames ${clipRes.clipStartFrame}-${endFrame}) -> ${path.basename(clipRes.clipPath)}`
                : `Window #${w.windowNumber} (${winRange}): Clip ready (extracted, ${sizeMb} MB, ${extractSec} s, frames ${clipRes.clipStartFrame}-${endFrame}) -> ${path.basename(clipRes.clipPath)}`,
            })
            this.persistStateToDisk()
            return clipRes
          } finally {
            this.releaseClipExtractSlot()
          }
        }

        const p = runWithSemaphore()

        // Prevent unhandled rejection when background extraction fails before a worker awaits it
        p.catch(() => {})
        this.windowClipPromises.set(w.id, p)
        return p
      }
      this.startWindowClipTask = startWindowClipExtractionForWindow

      const finalizeMediaAndLaunchWorkers = (verifiedMedia: ParallelMediaVerificationInfo) => {
        this.mediaInfo = verifiedMedia
        this.shortLocalPath = verifiedMedia.shortPath
        this.shortYoutubeUrl = null
        this.shortDriveFileName = null
        if (verifiedMedia.shortDurationSec && verifiedMedia.shortDurationSec > 0) {
          this.shortDurationSec = verifiedMedia.shortDurationSec
        }
        this.movieLocalPath = verifiedMedia.movie360Path
        const latestScanForDrive = getScan(this.scanId)
        this.movieDriveFileName =
          !this.usingOriginalMovieClips && cfg.studioAttachMovieFromDrive
            ? (latestScanForDrive?.movie360p?.driveFileName ?? null)
            : null
        if (verifiedMedia.movie360DurationSec && verifiedMedia.movie360DurationSec > 0) {
          this.movieDurationSec = verifiedMedia.movie360DurationSec
        }

        if (this.usingOriginalMovieClips) {
          this.clipCancelToken?.cancel()
          this.clipCancelToken = new CancelToken()
          this.windowClipPromises.clear()
          this.clipExtractWaitQueue = []
          this.clipExtractActiveCount = 0
          cleanStaleWindowClipPartials(this.scanId)
        } else {
          this.clipsReady = 0
          this.clipsTotal = 0
          this.clipsExtracting = false
          for (const w of this.windows) {
            if (w.status === 'QUEUED') {
              w.stage = 'queued'
              w.summaryText = 'Queued'
            }
          }
        }

        const shortSizeMb = verifiedMedia.shortSizeBytes
          ? (verifiedMedia.shortSizeBytes / (1024 * 1024)).toFixed(2)
          : '0'
        const movieSizeMb = verifiedMedia.movie360SizeBytes
          ? (verifiedMedia.movie360SizeBytes / (1024 * 1024)).toFixed(2)
          : '0'

        this.hasStartedRun = true
        this.active = true
        this.starting = false
        this.paused = false
        this.stoppingAll = false
        this.waitingForWorkerSlots = false
        this.stoppedWindowIds.clear()
        this.recordResourceSnapshotIfNeeded(true, `Parallel scan started (${newRunId})`)
        this.startResourceSnapshotTimer()

        if (this.usingOriginalMovieClips) {
          const orderedWindows = [...this.windows]
            .filter(
              (w) =>
                w.status !== 'DONE' &&
                w.status !== 'PROHIBITED' &&
                w.status !== 'SKIPPED',
            )
            .sort((a, b) => a.priorityRank - b.priorityRank || a.windowNumber - b.windowNumber)
          this.clipsReady = 0
          this.clipsTotal = orderedWindows.length
          this.clipsExtracting = orderedWindows.length > 0
          for (const w of orderedWindows) {
            startWindowClipExtractionForWindow(w)
          }
        }

        this.persistStateToDisk()

        this.appendCombinedLog({
          workerId: 'SYS',
          level: 'INFO',
          step: 'media verified',
          message: this.usingOriginalMovieClips
            ? `runId=${newRunId} | scanId=${this.scanId} | short=${verifiedMedia.shortPath} (${shortSizeMb} MB, ${(verifiedMedia.shortDurationSec || 0).toFixed(1)}s) | original_movie=${verifiedMedia.movie360Path} (${movieSizeMb} MB, ${(verifiedMedia.movie360DurationSec || 0).toFixed(1)}s, per-window clip mode)`
            : `runId=${newRunId} | scanId=${this.scanId} | short=${verifiedMedia.shortPath} (${shortSizeMb} MB, ${(verifiedMedia.shortDurationSec || 0).toFixed(1)}s) | movie_360p=${verifiedMedia.movie360Path} (${movieSizeMb} MB, ${(verifiedMedia.movie360DurationSec || 0).toFixed(1)}s)`,
        })

        this.appendCombinedLog({
          workerId: 'SYS',
          level: 'INFO',
          step: 'parallel scan start',
          message: `Started Parallel Window Scan (${newRunId}) for ${this.scanName} (${this.windows.length} windows, scan concurrency=${this.concurrency}, global pool max=${this.maxTotalPoolSlots}, uploadGate=${uploadGateLimit}, lowMemFlags=${Boolean(cfg.studioLowMemoryChromeFlags)}, disableDevShm=${cfg.studioDisableDevShmUsage !== false}, attachDrive=${Boolean(!this.usingOriginalMovieClips && cfg.studioAttachMovieFromDrive)}, clipMode=${this.usingOriginalMovieClips}, minutes="${this.minuteInput}")`,
        })

        this.runWorkerPoolLoop().catch((err) => {
          const msg = (err as Error).message
          this.appendCombinedLog({
            workerId: 'SYS',
            level: 'ERROR',
            step: 'worker pool error',
            message: `Parallel worker pool error: ${msg}`,
          })
          this.onLogCallback?.('error', `Parallel worker pool error: ${msg}`)
        })
      }

      if (hasOriginalMovie) {
        this.usingOriginalMovieClips = true
        this.compressing360p = null
        const rawStat = fs.statSync(rawMoviePath)
        const rawDurationSec = await probeDuration(rawMoviePath)
        if (!Number.isFinite(rawDurationSec) || rawDurationSec <= 0) {
          throw new Error(`Could not probe duration of original movie at ${rawMoviePath}`)
        }
        this.movieDurationSec = rawDurationSec
        if (!canResume) {
          const { windows } = buildParallelWindowsFromMinuteInput(
            this.minuteInput,
            rawDurationSec,
          )
          this.windows = windows.map((w) => ({
            ...w,
            status: 'QUEUED',
            workerId: null,
            modelName: initialEffectiveModel,
            stage: 'Extracting clip...',
            tokens: null,
            attempt: 0,
            maxAttempts: 5,
            permRetry: 0,
            startedAt: null,
            finishedAt: null,
            elapsedSec: 0,
            matchCount: 0,
            summaryText: 'Extracting window clip...',
            error: null,
          }))
        }
        finalizeMediaAndLaunchWorkers({
          scanId: this.scanId,
          shortPath: shortReady.localPath,
          shortSizeBytes: shortReady.sizeBytes,
          shortDurationSec: shortReady.durationSec,
          movie360Path: rawMoviePath,
          movie360SizeBytes: rawStat.size,
          movie360DurationSec: rawDurationSec,
          verifiedAt: Date.now(),
        })
      } else {
        this.usingOriginalMovieClips = false
        this.appendCombinedLog({
          workerId: 'SYS',
          level: 'INFO',
          step: 'original movie missing',
          message: `WARN: Original movie.mp4 missing at ${rawMoviePath} -> falling back to movie_360p.mp4 flow`,
        })
        this.onLogCallback?.(
          'warn',
          `Original movie.mp4 missing at ${rawMoviePath} -> falling back to movie_360p.mp4 flow`,
        )
        const initialMovieCheck = await verifyStudioMovie360pFile(
          this.scanId,
          expectedMovieDuration,
        )
        if (initialMovieCheck.valid) {
          // movie_360p.mp4 is already valid on persistent disk -> launch workers immediately without re-compressing
          this.compressing360p = null
          finalizeMediaAndLaunchWorkers({
            scanId: this.scanId,
            shortPath: shortReady.localPath,
            shortSizeBytes: shortReady.sizeBytes,
            shortDurationSec: shortReady.durationSec,
            movie360Path: initialMovieCheck.filePath,
            movie360SizeBytes: initialMovieCheck.sizeBytes,
            movie360DurationSec: initialMovieCheck.durationSec,
            verifiedAt: Date.now(),
          })
        } else {
          throw new Error(
            `Source movie file missing at ${rawMoviePath} and no valid movie_360p.mp4 found`,
          )
        }
      }

      return {
        totalWindows: this.windows.length,
        concurrency: this.concurrency,
        scanId: this.scanId,
      }
    } catch (err) {
      this.starting = false
      this.active = false
      this.stopResourceSnapshotTimer()
      const msg = err instanceof Error ? err.message : String(err)
      if (this.scanId && this.scanId !== 'default') {
        skipScanTicket(this.scanId, `Parallel Scan start failed: ${msg}`)
      }
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'ERROR',
        step: 'parallel start failed',
        message: `Parallel Scan start aborted for ${this.scanName}: ${msg}`,
      })
      throw err
    }
  }

  public async waitForCompletion(): Promise<ParallelMergedReport | null> {
    while (this.active || this.starting) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    return this.getMergedReport()
  }

  private async acquireClipExtractSlot(): Promise<void> {
    if (this.clipExtractActiveCount < MAX_PARALLEL_CLIP_EXTRACTIONS) {
      this.clipExtractActiveCount += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.clipExtractWaitQueue.push(resolve)
    })
  }

  private releaseClipExtractSlot(): void {
    const next = this.clipExtractWaitQueue.shift()
    if (next) {
      next()
    } else {
      this.clipExtractActiveCount = Math.max(0, this.clipExtractActiveCount - 1)
    }
  }

  /**
   * 5. Atomic, synchronous window claim:
   * Picks the next highest-priority QUEUED / WAITING_FOR_WORKER window and immediately marks
   * `status = 'ASSIGNED'` and `workerId = laneClaimTag` in the same synchronous turn so two
   * worker lanes can NEVER claim the same window (e.g. Window #13).
   */
  private claimNextQueuedWindow(laneClaimTag: string): ParallelWindowState | null {
    if (this.stoppingAll) return null
    const candidates = this.windows
      .filter(
        (w) =>
          (w.status === 'QUEUED' || w.status === 'WAITING_FOR_WORKER') &&
          !w.workerId &&
          !this.stoppedWindowIds.has(w.id),
      )
      .sort((a, b) => a.priorityRank - b.priorityRank || a.windowNumber - b.windowNumber)

    const chosen = candidates[0] || null
    if (!chosen) return null

    chosen.status = 'ASSIGNED'
    chosen.workerId = laneClaimTag
    chosen.stage = 'assigned'
    chosen.summaryText = `Assigned to ${laneClaimTag}`
    return chosen
  }

  private releaseClaimedWindow(win: ParallelWindowState | null, reason = 'queued') {
    if (!win) return
    if (
      win.status === 'ASSIGNED' ||
      win.status === 'WAITING_FOR_WORKER' ||
      win.status === 'WAITING_FOR_RAM'
    ) {
      win.status = 'QUEUED'
      win.workerId = null
      win.stage = reason
      win.summaryText = 'Queued'
    }
  }

  /**
   * Finalize the Scan record in store as soon as all Studio parallel windows settle:
   * - Normal Verifier is OFF (`scan.verifierEnabled = false`)
   * - Window scan stitched matches become final `scan.matches` (`verified: true`)
   * - `scan.status = 'done'`, `scan.report` built immediately (`partial: undefined`)
   * - API key-pair slot is freed (`releaseScanKeyPair`)
   */
  private finalizeScanRecordOnCompletion() {
    if (!this.scanId || this.scanId === 'default') return
    try {
      const scan = getScan(this.scanId)
      if (!scan) return

      const mergedReport = this.getMergedReport()
      const finalMatches: ChunkMatch[] = []
      const defaultModel =
        this.windows.find((w) => w.modelName)?.modelName || DEFAULT_STUDIO_MODEL_NAME

      if (mergedReport && mergedReport.segments.length > 0) {
        for (const seg of mergedReport.segments) {
          if (
            (seg.status === 'FOUND' || seg.status === 'CONFLICT') &&
            seg.primaryMovieStartSec !== null &&
            seg.primaryMovieEndSec !== null &&
            seg.primaryMovieEndSec > seg.primaryMovieStartSec
          ) {
            const cIdx = deriveChunkIndexForMovieTime(scan, seg.primaryMovieStartSec)
            finalMatches.push({
              chunkIndex: cIdx,
              shortStart: Number(seg.shortStartSec.toFixed(3)),
              shortEnd: Number(seg.shortEndSec.toFixed(3)),
              movieStart: Number(seg.primaryMovieStartSec.toFixed(3)),
              movieEnd: Number(seg.primaryMovieEndSec.toFixed(3)),
              description: seg.description || 'Matched scene',
              model: defaultModel,
              verified: true,
              origin: 'chunk',
            })
          }
        }
      }

      // Also include any direct window matches not already represented in finalMatches
      for (const w of this.windows) {
        if (w.status !== 'DONE' || !Array.isArray(w.matches)) continue
        for (const m of w.matches) {
          const cIdx = deriveChunkIndexForMovieTime(scan, m.movieStart)
          const isDup = finalMatches.some(
            (ex) =>
              Math.abs(ex.shortStart - m.shortStart) < 1.2 &&
              Math.abs(ex.movieStart - m.movieStart) < 2.0,
          )
          if (!isDup) {
            finalMatches.push({
              ...m,
              chunkIndex: cIdx,
              model: m.model || w.modelName || defaultModel,
              verified: true,
              origin: m.origin || 'chunk',
            })
          }
        }
      }

      finalMatches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
      scan.matches = finalMatches
      scan.verifierEnabled = false
      scan.candidateGroups = []

      // Update per-minute shortSegments & chunks so ChunkResultsPanel, ReportPanel, ComparePanel, and RenderPanel are 100% ready
      const trimStart = scan.movieTrimStart ?? 0
      const maxChunk = Math.max(0, (scan.chunkCount || 1) - 1)
      if (!Array.isArray(scan.shortSegments) || scan.shortSegments.length === 0) {
        const shortDur = scan.shortDuration || this.shortDurationSec || 60
        const segCount = Math.max(1, Math.ceil(shortDur / 60))
        scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
          index: i,
          start: i * 60,
          end: Math.min((i + 1) * 60, shortDur),
          status: 'done' as const,
          chunks: Array.from({ length: scan.chunkCount || 1 }, (__, ci) => ({
            index: ci,
            status: 'cancelled' as const,
            attempts: 0,
          })),
        }))
      }

      for (const seg of scan.shortSegments) {
        if (!Array.isArray(seg.chunks) || seg.chunks.length < (scan.chunkCount || 0)) {
          seg.chunks = Array.from({ length: scan.chunkCount || 0 }, (_, ci) => ({
            index: ci,
            status: 'cancelled' as const,
            attempts: 0,
          }))
        }
        seg.matches = []
        for (const m of finalMatches) {
          const clipped = clipMatchToShortSegment(m, seg.start, seg.end, scan)
          if (clipped) {
            seg.matches.push({ ...clipped, verified: true })
          }
        }
        for (const c of seg.chunks) {
          if (c.status === 'pending' || c.status === 'scanning') {
            c.status = 'cancelled'
          }
        }
      }

      // Map each window's status and raw output onto covered 60s chunks
      for (const w of this.windows) {
        const cStart = Math.max(0, Math.floor((w.startSec - trimStart) / 60))
        const cEnd = Math.min(maxChunk, Math.floor(Math.max(0, w.endSec - 0.001 - trimStart) / 60))
        for (const seg of scan.shortSegments) {
          if (seg.selected === false) continue
          for (let ci = cStart; ci <= cEnd; ci++) {
            const ch = seg.chunks[ci]
            if (!ch) continue
            const segMatchesForChunk = (seg.matches || []).filter((m) => m.chunkIndex === ci)
            ch.matches = segMatchesForChunk
            ch.model = w.modelName || defaultModel
            ch.attempts = Math.max(1, w.attempt || 1)
            if (w.status === 'DONE') {
              ch.status = segMatchesForChunk.length > 0 ? 'match' : 'no_match'
              if (w.rawResponseText) {
                ch.rawOutputs = [
                  {
                    model: w.modelName || defaultModel,
                    t: w.finishedAt || Date.now(),
                    text: w.rawResponseText.slice(0, 20_000),
                    status: 'success',
                  },
                ]
              }
            } else if (w.status === 'PROHIBITED') {
              ch.status = 'policy_blocked'
              ch.error = w.error || 'PROHIBITED CONTENT (skipped, no retry)'
            } else if (w.status === 'FAILED') {
              ch.status = 'failed'
              ch.error = w.error || 'Window failed'
            }
          }
        }
      }

      for (const seg of scan.shortSegments) {
        seg.status = this.stoppingAll ? 'pending' : 'done'
      }
      if (scan.shortSegments.length > 0) {
        const curSeg =
          scan.shortSegments[scan.currentShortSegment ?? 0] || scan.shortSegments[0]
        if (curSeg) scan.chunks = curSeg.chunks
      }

      const now = Date.now()
      const doneWins = this.windows.filter((w) => w.status === 'DONE').length
      const failedWins = this.windows.filter((w) => w.status === 'FAILED').length
      const modelsUsed = Array.from(
        new Set(this.windows.map((w) => w.modelName).filter(Boolean)),
      )
      if (modelsUsed.length === 0) modelsUsed.push( DEFAULT_STUDIO_MODEL_NAME )

      if (this.stoppingAll) {
        scan.status = 'stopped'
        scan.pipelineStage = 'stopped'
        scan.waitingForTicket = null
        scan.waitingForScanTitle = null
      } else {
        scan.chunkWindowsDone = true
        scan.status = 'done'
        scan.pipelineStage = 'done'
        scan.waitingForTicket = null
        scan.waitingForScanTitle = null
        scan.finishedAt = now
      }

      scan.report = {
        totalScanTimeMs: Math.max(0, (scan.finishedAt || now) - (scan.startedAt || this.startedAt || now)),
        chunksScanned: doneWins,
        chunksFailed: failedWins,
        chunksPending: 0,
        partial: this.stoppingAll ? true : undefined,
        modelsUsed,
        matches: scan.matches,
        groupsTotal: 0,
        groupsConfirmed: scan.matches.length,
        groupsRejected: 0,
        groupsUnverified: 0,
        groupsPending: 0,
        matchesRejectedKept: 0,
        originCounts: { chunk: scan.matches.length },
        coverage: computeShortCoverage(scan),
        prefilterMode: scan.geminiPrescan?.appliedMinutes?.length ? 'gemini' : 'full',
      }

      addLog(
        scan,
        this.stoppingAll ? 'warn' : 'success',
        this.stoppingAll
          ? `Studio parallel chunk scan stopped (${doneWins}/${this.windows.length} windows done, ${scan.matches.length} matches ready).`
          : `Studio parallel chunk scan complete (${doneWins}/${this.windows.length} windows done): ${scan.matches.length} final match(es) — Normal Verifier OFF (chunk result final). Report & Export ready!`,
      )
      releaseScanKeyPair(this.scanId)
      saveScan(scan, { immediate: true })
    } catch (err) {
      console.error('[StudioParallelManager] finalizeScanRecordOnCompletion error:', err)
    }
  }

  private async runWorkerPoolLoop(): Promise<void> {
    let releaseChunkLock: (() => void) | null = null
    try {
      // 1. Acquire strict ticket lock in globalChunkScanCoordinator before launching any Chrome worker
      if (this.scanId && this.scanId !== 'default') {
        let loggedTicketWait = false
        releaseChunkLock = await globalChunkScanCoordinator.acquireChunkScanLock({
          scanId: this.scanId,
          scanTitle: this.scanName || this.scanId,
          onWait: (msg, pos, ticket) => {
            this.waitingForWorkerSlots = true
            for (const w of this.windows) {
              if (w.status === 'QUEUED') {
                w.stage = msg
                w.summaryText = `Waiting in Chunk Queue #${pos} (Ticket #${ticket})`
              }
            }
            if (!loggedTicketWait) {
              loggedTicketWait = true
              this.appendCombinedLog({
                workerId: 'SYS',
                level: 'INFO',
                step: 'ticket queue wait',
                message: msg,
              })
              this.onLogCallback?.('info', msg)
            }
            this.persistStateToDisk()
          },
          isStopping: () => this.stoppingAll,
        })
      }

      if (this.stoppingAll) return

      // 2. Ensure previous scan's Chrome slots in globalProfileSlotPool are 100% released before launching workers
      while (!this.stoppingAll) {
        const poolSnap = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
        const otherScanUsingSlots = poolSnap.byScan.some(
          (entry) => entry.scanId !== this.scanId && entry.count > 0,
        )
        if (!otherScanUsingSlots) break
        this.waitingForWorkerSlots = true
        await new Promise((r) => setTimeout(r, 250))
      }

      if (this.stoppingAll) return
      this.waitingForWorkerSlots = false

      if (this.scanId && this.scanId !== 'default') {
        const s = getScan(this.scanId)
        if (s) {
          s.status = 'scanning'
          s.pipelineStage = 'chunk_scanning'
          s.waitingForTicket = null
          s.waitingForScanTitle = null
          if (!s.startedAt) s.startedAt = Date.now()
          saveScan(s)
        }
      }

      const workerCount = this.concurrency
      const workerPromises: Promise<void>[] = []

      for (let laneIdx = 1; laneIdx <= workerCount; laneIdx++) {
        workerPromises.push(this.runSingleWorkerLane(laneIdx))
      }

      await Promise.allSettled(workerPromises)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!this.stoppingAll && !/stopped/i.test(msg)) {
        this.appendCombinedLog({
          workerId: 'SYS',
          level: 'ERROR',
          step: 'worker pool error',
          message: `Parallel worker pool error: ${msg}`,
        })
      }
    } finally {
      this.stopResourceSnapshotTimer()
      // CRITICAL: Release all Chrome windows/slots in globalProfileSlotPool FIRST before releasing the chunk lock!
      await globalProfileSlotPool.closeAndReleaseAllSlotsForScan(this.scanId)
      if (globalProfileSlotPool.getSummary(this.maxTotalPoolSlots).inUseSlots === 0) {
        const info = inspectChromeProcesses()
        if (info.totalCount > 0) {
          const cleanupPromises: Promise<unknown>[] = []
          for (const wKey of Object.keys(info.perWorkerCount ?? {})) {
            if ((info.perWorkerCount?.[wKey] || 0) > 0) {
              const num = wKey.replace(/^W/i, '').padStart(2, '0')
              cleanupPromises.push(
                killWorkerChromeProcessesByProfileDir(`${BASE_PROFILE_NAME}-w${num}`),
              )
            }
          }
          await Promise.allSettled(cleanupPromises)
        }
      }

      this.active = false
      this.starting = false
      this.waitingForWorkerSlots = false
      this.clipsExtracting = false
      this.clipsReady = 0
      this.clipsTotal = 0
      this.finishedAt = Date.now()
      if (this.currentRunId) {
        const rEntry = this.runHistory.find((r) => r.runId === this.currentRunId)
        if (rEntry) rEntry.finishedAt = this.finishedAt
      }
      this.recordResourceSnapshotIfNeeded(true, 'Parallel scan finished')
      this.persistStateToDisk()

      const doneCount = this.windows.filter((w) => w.status === 'DONE').length
      const prohibitedCount = this.windows.filter((w) => w.status === 'PROHIBITED').length
      const failedCount = this.windows.filter((w) => w.status === 'FAILED').length
      const finalChromeStats = readChromeProcsPerWorker(this.concurrency)
      this.appendCombinedLog({
        workerId: 'SYS',
        level: failedCount > 0 ? 'ERROR' : 'SUCCESS',
        step: 'parallel scan finished',
        message: `Parallel Window Scan finished for ${this.scanName} (runId=${this.currentRunId || 'n/a'}): ${doneCount}/${this.windows.length} DONE, ${prohibitedCount} PROHIBITED, ${failedCount} FAILED, chromeProcs=${finalChromeStats.totalProcs}`,
      })

      // Finalize scan record (status='done', report built, verifier OFF, key pair released)
      this.finalizeScanRecordOnCompletion()

      // Immediately release chunk scan lock so the next ticket in queue starts with zero delay!
      if (releaseChunkLock) {
        try {
          releaseChunkLock()
        } catch {
          /* ignore */
        }
      }
      if (this.scanId && this.scanId !== 'default') {
        if (this.stoppingAll) {
          skipScanTicket(this.scanId, 'Parallel scan stopped by user')
        } else {
          globalChunkScanCoordinator.releaseChunkScanLock(
            this.scanId,
            true,
            `All ${this.windows.length} Studio parallel windows completed`,
          )
        }
      }
    }
  }

  private async runSingleWorkerLane(laneIndex: number): Promise<void> {
    let preferredSlotIndex: number | null = laneIndex <= this.maxTotalPoolSlots ? laneIndex : null
    const laneClaimTag = `LANE-${String(laneIndex).padStart(2, '0')}`

    while (!this.stoppingAll) {
      while (this.paused && !this.stoppingAll) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (this.stoppingAll) break

      // Atomically claim a window before any async wait so no other lane can pick it
      const claimedWin = this.claimNextQueuedWindow(laneClaimTag)
      if (!claimedWin) {
        const anyInFlight = this.windows.some(
          (w) =>
            w.status === 'ASSIGNED' ||
            w.status === 'WAITING_FOR_WORKER' ||
            w.status === 'WAITING_FOR_RAM' ||
            w.status === 'WAITING_FOR_UPLOAD_GATE' ||
            w.status === 'SETUP' ||
            w.status === 'RUNNING' ||
            w.status === 'VALIDATING' ||
            w.status === 'RETRYING' ||
            w.status === '403_WAIT',
        )
        const anyQueued = this.windows.some(
          (w) => w.status === 'QUEUED' && !this.stoppedWindowIds.has(w.id),
        )
        if (!anyQueued && !anyInFlight) {
          break
        }
        if (!anyQueued && anyInFlight) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        break
      }

      // Resource check before leasing a slot and starting window (Disk & RAM < 70%)
      const freeDiskGb = readFreeDiskGb()
      if (freeDiskGb < 5) {
        this.resourceWarning = `WARN: Low disk space (${freeDiskGb} GB free < 5 GB)`
        this.recordResourceSnapshotIfNeeded(true, this.resourceWarning)
        this.appendCombinedLog({
          workerId: 'SYS',
          windowId: claimedWin.id,
          windowNumber: claimedWin.windowNumber,
          windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
          level: 'ERROR',
          step: 'WARN [low-disk]',
          message: this.resourceWarning,
        })
      }

      // 4b. Only start a new worker/Chrome when RAM < 70% (was 85%)
      let ramPct = readSystemRamUsedPercent()
      let loggedWaitingForRam = false
      while (ramPct >= 70 && !this.stoppingAll && !this.paused) {
        const totalInUseAcrossScans = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots).inUseSlots
        // If 0 workers are running anywhere and baseline OS RAM is between 70-88%, allow 1 worker so scan doesn't deadlock
        if (totalInUseAcrossScans === 0 && ramPct < 88) {
          break
        }
        claimedWin.status = 'WAITING_FOR_RAM'
        claimedWin.stage = `WAITING FOR RAM (${ramPct}% >= 70%)`
        claimedWin.summaryText = `WAITING FOR RAM (${ramPct}%)`
        this.resourceWarning = `WAITING FOR RAM: ${ramPct}% used (threshold 70% for new worker launch)`
        this.recordResourceSnapshotIfNeeded(false, this.resourceWarning)
        if (!loggedWaitingForRam) {
          loggedWaitingForRam = true
          this.appendCombinedLog({
            workerId: 'SYS',
            windowId: claimedWin.id,
            windowNumber: claimedWin.windowNumber,
            windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
            level: 'INFO',
            step: 'WAITING FOR RAM',
            message: `RAM is ${ramPct}% (>= 70%) — waiting before starting worker for Window #${claimedWin.windowNumber}`,
          })
        }
        await new Promise((r) => setTimeout(r, 2500))
        ramPct = readSystemRamUsedPercent()
      }

      if (this.stoppingAll || this.stoppedWindowIds.has(claimedWin.id)) {
        this.releaseClaimedWindow(claimedWin)
        if (this.stoppingAll) break
        continue
      }
      if (this.paused) {
        this.releaseClaimedWindow(claimedWin)
        continue
      }

      // Lease a free worker slot from the GLOBAL Profile Slot Pool for `claimedWin`
      let leasedSlot: ProfileSlotEntry | null = null
      let loggedWaitingForSlot = false

      while (!this.stoppingAll && !this.paused && !this.stoppedWindowIds.has(claimedWin.id)) {
        leasedSlot = globalProfileSlotPool.tryAcquireSlot({
          scanId: this.scanId,
          scanLabel: this.scanName,
          windowId: claimedWin.id,
          windowNumber: claimedWin.windowNumber,
          windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
          preferredSlotIndex,
          poolLimit: this.maxTotalPoolSlots,
        })

        if (leasedSlot) {
          this.waitingForWorkerSlots = false
          preferredSlotIndex = leasedSlot.slotIndex
          break
        }

        // All global profile slots are currently in use
        this.waitingForWorkerSlots = true
        claimedWin.status = 'WAITING_FOR_WORKER'
        claimedWin.stage = 'WAITING FOR WORKER (global slot pool full)'
        claimedWin.summaryText = 'WAITING FOR WORKER (slots full)'
        if (!loggedWaitingForSlot) {
          loggedWaitingForSlot = true
          const poolSnap = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
          this.appendCombinedLog({
            workerId: 'SYS',
            windowId: claimedWin.id,
            windowNumber: claimedWin.windowNumber,
            windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
            level: 'INFO',
            step: 'WAITING FOR WORKER',
            message: `Waiting for free profile slot (${poolSnap.summaryText})`,
          })
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (!leasedSlot) {
        this.releaseClaimedWindow(claimedWin)
        if (this.stoppingAll) break
        continue
      }

      // Assert no other slot is concurrently leased for the same windowId
      const duplicateLeases = globalProfileSlotPool
        .getLeasedSlotsForScan(this.scanId)
        .filter((s) => s.leasedWindowId === claimedWin.id && s.slotIndex !== leasedSlot!.slotIndex)
      if (duplicateLeases.length > 0) {
        globalProfileSlotPool.releaseSlot(leasedSlot.slotIndex, this.scanId)
        throw new Error(
          `Assertion failed: Window #${claimedWin.windowNumber} (${claimedWin.id}) already leased by ${duplicateLeases.map((d) => d.workerId).join(',')}`,
        )
      }

      // Bind the claimed window to the leased worker ID immediately
      claimedWin.workerId = leasedSlot.workerId
      claimedWin.status = 'ASSIGNED'
      claimedWin.stage = `assigned to ${leasedSlot.workerId}`

      try {
        // Global stagger on first browser launch for this slot
        const staggerMs = globalProfileSlotPool.reserveLaunchStaggerDelayMs(leasedSlot.slotIndex)
        if (staggerMs > 0) {
          const waitSec = Math.round(staggerMs / 1000)
          this.appendCombinedLog({
            workerId: leasedSlot.workerId,
            windowId: claimedWin.id,
            windowNumber: claimedWin.windowNumber,
            windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
            level: 'INFO',
            step: 'stagger wait',
            message: `Waiting ${waitSec}s stagger before launching ${leasedSlot.workerId} (${leasedSlot.profileDirName})`,
          })
          const waitEnd = Date.now() + staggerMs
          while (Date.now() < waitEnd && !this.stoppingAll) {
            await new Promise((r) => setTimeout(r, 500))
          }
        }

        if (this.stoppingAll) {
          this.releaseClaimedWindow(claimedWin)
          break
        }

        await this.executeWindowOnSlot(leasedSlot, claimedWin)

        if ((claimedWin.status as ParallelWindowStatus) === 'NEEDS_ATTENTION') {
          this.appendCombinedLog({
            workerId: leasedSlot.workerId,
            windowId: claimedWin.id,
            windowNumber: claimedWin.windowNumber,
            windowRange: `${claimedWin.startFormatted}–${claimedWin.endFormatted}`,
            level: 'ERROR',
            step: 'worker halted',
            message: `Halted ${leasedSlot.workerId} due to NEEDS ATTENTION on Window #${claimedWin.windowNumber}`,
          })
          break
        }
      } finally {
        await globalProfileSlotPool.closeAndReleaseSlot(leasedSlot.slotIndex, this.scanId)
      }
    }
  }

  private async executeWindowOnSlot(
    slot: ProfileSlotEntry,
    win: ParallelWindowState,
  ): Promise<void> {
    const workerId = slot.workerId
    const ctrl = slot.controller
    const windowRangeStr = `${win.startFormatted}–${win.endFormatted}`
    const jobScanScope = `parallel-${this.scanId}-${win.id}`
    const shortScanTag = `[${this.scanName}]`

    ctrl.clearStop({ scanId: jobScanScope, username: this.username })
    ctrl.setScanContextTag(shortScanTag)

    // Wire real-time step listener so every single step logged by StudioBrowserController
    // is recorded in this scan's Combined Log & parallel-log.jsonl with workerId + scanName + windowRange
    ctrl.setStepLogListener((stepEntry: StudioStepLog) => {
      const classified = classifyParallelLogLevel(stepEntry.level, stepEntry.step, stepEntry.detail)
      const cleanStep = stepEntry.step
        .replace(new RegExp(`^\\[${workerId}\\]\\s*`, 'i'), '')
        .replace(shortScanTag, '')
        .trim()
      const msg = stepEntry.detail ? `${cleanStep}: ${stepEntry.detail}` : cleanStep
      this.appendCombinedLog({
        workerId,
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: windowRangeStr,
        level: classified,
        step: cleanStep,
        message: msg,
        t: stepEntry.t,
      })
      this.recordResourceSnapshotIfNeeded(false)
    })

    win.status = 'SETUP'
    win.workerId = workerId
    win.startedAt = Date.now()
    win.finishedAt = null
    win.error = null
    win.summaryText = `Running on ${workerId} (${slot.profileDirName})...`
    this.persistStateToDisk()

    const cfg = await loadStudioUserConfig(this.username || 'admin')
    const jobLabel = `[${this.scanName}] Window #${win.windowNumber} (${windowRangeStr})`

    let windowClip: WindowClipResult | null = null
    if (this.usingOriginalMovieClips) {
      win.stage = 'Extracting clip...'
      win.summaryText = `Extracting clip on ${workerId}...`
      this.persistStateToDisk()
      try {
        const clipPromise =
          this.windowClipPromises.get(win.id) ||
          (this.startWindowClipTask
            ? this.startWindowClipTask(win)
            : ensureWindowClip(
                this.scanId,
                {
                  windowNumber: win.windowNumber,
                  startSec: win.startSec,
                  endSec: win.endSec,
                },
                { token: this.clipCancelToken ?? undefined },
              ))
        const clipWaitStart = Date.now()
        windowClip = await clipPromise
        const sizeBytes = (() => {
          try {
            return fs.statSync(windowClip.clipPath).size
          } catch {
            return 0
          }
        })()
        const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
        const extractSec = ((Date.now() - clipWaitStart) / 1000).toFixed(1)
        win.stage = windowClip.cached
          ? 'Clip ready (cached)'
          : `Clip ready (extracted, ${sizeMb} MB, ${extractSec} s)`
        win.summaryText = 'Clip ready'
        this.persistStateToDisk()
      } catch (clipErr) {
        if (
          clipErr instanceof FfmpegCancelled ||
          this.stoppingAll ||
          this.stoppedWindowIds.has(win.id)
        ) {
          win.status = 'STOPPED'
          win.workerId = null
          win.stage = 'stopped'
          win.summaryText = 'STOPPED BY USER'
          this.persistStateToDisk()
          return
        }
        const errMsg = clipErr instanceof Error ? clipErr.message : String(clipErr)
        win.status = 'FAILED'
        win.workerId = null
        win.finishedAt = Date.now()
        win.elapsedSec = win.startedAt ? Math.round((win.finishedAt - win.startedAt) / 1000) : 0
        win.stage = 'clip extract failed'
        win.error = errMsg
        win.summaryText = `FAILED — Clip extraction failed: ${errMsg.slice(0, 120)}`
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'clip extract failed',
          message: `Window #${win.windowNumber} (${windowRangeStr}) clip extraction failed: ${errMsg}`,
        })
        this.onLogCallback?.(
          'error',
          `[${workerId}]${shortScanTag} Window #${win.windowNumber} clip extraction failed: ${errMsg}`,
        )
        this.windowClipPromises.delete(win.id)
        this.persistStateToDisk()
        return
      }
    }

    let effectiveMovieDriveFileName: string | null = null
    if (!windowClip && cfg.studioAttachMovieFromDrive) {
      effectiveMovieDriveFileName =
        this.movieDriveFileName || getScan(this.scanId)?.movie360p?.driveFileName || null
      if (!effectiveMovieDriveFileName) {
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'INFO',
          step: 'uploading movie to Drive',
          message: `Attach movie from Google Drive is ON -> ensuring movie_360p.mp4 is uploaded to Drive folder "CMT"...`,
        })
        effectiveMovieDriveFileName = await ensureStudioMovieUploadedToDriveIfNeeded(
          this.scanId,
          this.username || 'admin',
        )
        if (effectiveMovieDriveFileName) {
          this.movieDriveFileName = effectiveMovieDriveFileName
          this.appendCombinedLog({
            workerId,
            windowId: win.id,
            windowNumber: win.windowNumber,
            windowRange: windowRangeStr,
            level: 'INFO',
            step: 'drive movie ready',
            message: `Using Google Drive movie file "${effectiveMovieDriveFileName}" for AI Studio attachment`,
          })
        } else {
          this.appendCombinedLog({
            workerId,
            windowId: win.id,
            windowNumber: win.windowNumber,
            windowRange: windowRangeStr,
            level: 'INFO',
            step: 'drive movie fallback',
            message: `Google Drive movie unavailable (not connected or upload failed) -> falling back to local movie_360p.mp4`,
          })
        }
      }
    }

    try {
      const effectiveWinModel =
        (await getEffectiveModel(cfg.studioModelName)) ||
        cfg.studioModelName ||
        DEFAULT_STUDIO_MODEL_NAME
      win.modelName = effectiveWinModel

      const result = await ctrl.runWindowJob({
        username: this.username || 'admin',
        scanId: jobScanScope,
        jobLabel,
        modelName: cfg.studioModelName || DEFAULT_STUDIO_MODEL_NAME,
        thinkingLevel: cfg.studioThinkingLevel,
        maxOutputTokens: cfg.studioMaxOutputTokens || 65536,
        maxInputTokens: cfg.studioMaxInputTokens,
        pageRecycleInterval: cfg.studioPageRecycleInterval || 5,
        shortYoutubeUrl: null,
        shortDriveFileName: null,
        shortLocalPath: this.shortLocalPath,
        shortStartSec: 0,
        shortEndSec: this.shortDurationSec,
        movieDriveFileName: effectiveMovieDriveFileName,
        movieLocalPath: windowClip ? windowClip.clipPath : this.movieLocalPath,
        movieStartSec: win.startSec,
        movieEndSec: win.endSec,
        windowClip: windowClip
          ? {
              clipPath: windowClip.clipPath,
              clipStartFrame: windowClip.clipStartFrame,
              clipStartSec: windowClip.clipStartSec,
              frameCount: windowClip.frameCount,
              durationSec: windowClip.durationSec,
            }
          : null,
        parallelMode: true,
        maxAttempts: 5,
        measuredTokenRate: this.measuredTokenRate ?? cfg.studioMeasuredTokenRate ?? null,
        onLog: (level, msg) => {
          this.onLogCallback?.(level, `[${workerId}]${shortScanTag} ${msg}`)
        },
      })

      if (result.status === 'shrink_needed') {
        const nextNum = this.windows.length + 1
        const [half1, half2] = splitParallelWindowInHalf(win, nextNum)
        const makeState = (spec: ParallelWindowSpec): ParallelWindowState => ({
          ...spec,
          status: 'QUEUED',
          workerId: null,
          modelName: effectiveWinModel,
          stage: 'queued (split)',
          tokens: null,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          startedAt: null,
          finishedAt: null,
          elapsedSec: 0,
          matchCount: 0,
          summaryText: 'Queued (split from context-limit)',
          error: null,
        })

        const stateHalf1 = makeState(half1)
        const stateHalf2 = makeState(half2)
        const idx = this.windows.findIndex((w) => w.id === win.id)
        if (idx !== -1) {
          this.windows.splice(idx, 1, stateHalf1, stateHalf2)
        } else {
          this.windows.push(stateHalf1, stateHalf2)
        }
        if (this.usingOriginalMovieClips && this.startWindowClipTask) {
          this.clipsTotal += 2
          this.clipsExtracting = true
          this.startWindowClipTask(stateHalf1)
          this.startWindowClipTask(stateHalf2)
        }
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'RETRY',
          step: 'window split',
          message: `Split Window #${win.windowNumber} (${windowRangeStr}) into #${half1.windowNumber} (${half1.startFormatted}–${half1.endFormatted}) and #${half2.windowNumber} (${half2.startFormatted}–${half2.endFormatted}) due to context token limit (${result.tokenCount})`,
        })
        this.persistStateToDisk()
        return
      }

      const meta = ctrl.getActiveRunMeta()
      const notFoundMatches = (result.rawText.match(/NOT\s+FOUND\s+IN\s+THIS\s+CHUNK/gi) || []).length
      win.status = 'DONE'
      win.modelName = meta.modelName
      win.tokens = result.tokenCount
      win.attempt = meta.attempt
      win.permRetry = meta.permRetry
      win.finishedAt = Date.now()
      win.elapsedSec = win.startedAt ? Math.round((win.finishedAt - win.startedAt) / 1000) : 0
      win.rawResponseText = result.rawText
      win.matches = result.matches
      win.matchCount = result.matches.length
      win.notFoundCount = notFoundMatches
      win.stage = 'done'
      win.summaryText =
        result.matches.length > 0 ? `${result.matches.length} matches` : '0 matches'
      this.persistStateToDisk()

      this.appendCombinedLog({
        workerId,
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: windowRangeStr,
        level: 'SUCCESS',
        step: 'window DONE',
        message: `Window #${win.windowNumber} (${windowRangeStr}) DONE in ${win.elapsedSec}s — ${win.matchCount} matches, ${notFoundMatches} notFound, model=${win.modelName}, tokens=${win.tokens ?? 'N/A'}`,
      })

      if (this.onMatchCallback) {
        await this.onMatchCallback(win, result.matches).catch(() => {})
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const meta = ctrl.getActiveRunMeta()
      win.modelName = meta.modelName
      win.tokens = meta.tokenCount
      win.attempt = meta.attempt
      win.permRetry = meta.permRetry
      win.finishedAt = Date.now()
      win.elapsedSec = win.startedAt ? Math.round((win.finishedAt - win.startedAt) / 1000) : 0

      const isUserStop =
        msg === 'STOPPED BY USER' ||
        /stopped by user/i.test(msg) ||
        this.stoppedWindowIds.has(win.id) ||
        this.stoppingAll

      if (isUserStop) {
        if ((win.status as string) !== 'SKIPPED') {
          win.status = 'STOPPED'
          win.stage = 'stopped'
          win.summaryText = 'STOPPED BY USER'
          win.error = 'STOPPED BY USER'
        }
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'STOPPED',
          step: 'window STOPPED',
          message: `Window #${win.windowNumber} (${windowRangeStr}) stopped by user`,
        })
      } else if (msg.startsWith('NEEDS_ATTENTION:')) {
        win.status = 'NEEDS_ATTENTION'
        win.stage = 'needs attention'
        win.summaryText = msg.replace(/^NEEDS_ATTENTION:\s*/, '')
        win.error = msg
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'NEEDS ATTENTION',
          message: msg,
        })
      } else if (
        msg.startsWith('POLICY_BLOCKED:') ||
        /(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(msg)
      ) {
        win.status = 'PROHIBITED'
        win.stage = 'prohibited'
        win.summaryText = 'PROHIBITED CONTENT (skipped, no retry)'
        win.error = msg
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'window PROHIBITED',
          message: `Window #${win.windowNumber} (${windowRangeStr}): PROHIBITED CONTENT (skipped, no retry)`,
        })
      } else {
        win.status = 'FAILED'
        win.stage = 'failed'
        win.summaryText = msg.slice(0, 120)
        win.error = msg
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'window FAILED',
          message: `Window #${win.windowNumber} (${windowRangeStr}) failed: ${msg}`,
        })
      }
      this.persistStateToDisk()
    } finally {
      if (
        win.status === 'DONE' ||
        win.status === 'PROHIBITED' ||
        win.status === 'FAILED'
      ) {
        if (windowClip?.clipPath) {
          try {
            if (fs.existsSync(windowClip.clipPath)) {
              fs.unlinkSync(windowClip.clipPath)
            }
          } catch {
            /* ignore clip unlink error */
          }
        }
        this.windowClipPromises.delete(win.id)
      }
      ctrl.setStepLogListener(undefined)
      ctrl.setScanContextTag('')
      // Ensure this worker's Chrome is completely closed and any leftover processes are killed on DONE/PROHIBITED/FAILED/STOPPED
      await ctrl.closeContext().catch(() => {})
      this.recordResourceSnapshotIfNeeded(true, `Worker ${workerId} Chrome closed (${win.status})`)
    }
  }

  public pauseAll() {
    this.paused = true
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      slot.controller.setPaused(true)
    }
    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'INFO',
      step: 'pause all',
      message: `Paused Parallel Window Scan for ${this.scanName}`,
    })
  }

  public resumeAll() {
    this.paused = false
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      slot.controller.setPaused(false)
    }
    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'INFO',
      step: 'resume all',
      message: `Resumed Parallel Window Scan for ${this.scanName}`,
    })
  }

  public stopAll() {
    this.stoppingAll = true
    this.paused = false
    this.waitingForWorkerSlots = false
    this.compressing360p = null
    this.clipsExtracting = false
    this.clipsReady = 0
    this.clipsTotal = 0
    this.clipCancelToken?.cancel()
    this.stopResourceSnapshotTimer()

    // Only stop slots leased by THIS scan! Unpause first ("Pause se stop") and kill worker Chrome processes.
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      slot.controller.setPaused(false)
      if (slot.leasedWindowId) {
        const jobScanScope = `parallel-${this.scanId}-${slot.leasedWindowId}`
        slot.controller.requestStop({ scanId: jobScanScope })
      } else {
        slot.controller.requestStop()
      }
    }
    void globalProfileSlotPool.closeAndReleaseAllSlotsForScan(this.scanId).then(() => {
      this.recordResourceSnapshotIfNeeded(true, 'Stopped by user (worker Chrome processes closed)')
      this.persistStateToDisk()
    })

    for (const w of this.windows) {
      if (
        w.status === 'QUEUED' ||
        w.status === 'ASSIGNED' ||
        w.status === 'WAITING_FOR_WORKER' ||
        w.status === 'WAITING_FOR_RAM' ||
        w.status === 'WAITING_FOR_UPLOAD_GATE'
      ) {
        w.status = 'STOPPED'
        w.workerId = null
        w.stage = 'stopped'
        w.summaryText = 'STOPPED BY USER'
      }
    }
    this.active = false
    this.starting = false
    this.finishedAt = Date.now()
    if (this.currentRunId) {
      const rEntry = this.runHistory.find((r) => r.runId === this.currentRunId)
      if (rEntry) rEntry.finishedAt = this.finishedAt
    }
    this.persistStateToDisk()
    if (this.scanId && this.scanId !== 'default') {
      skipScanTicket(this.scanId, 'Stopped all parallel windows')
    }

    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'STOPPED',
      step: 'stop all',
      message: `Stopped all parallel windows for ${this.scanName}`,
    })
  }

  public stopWindow(windowId: string) {
    this.stoppedWindowIds.add(windowId)
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return

    if (
      win.status === 'QUEUED' ||
      win.status === 'ASSIGNED' ||
      win.status === 'WAITING_FOR_WORKER' ||
      win.status === 'WAITING_FOR_RAM'
    ) {
      win.status = 'STOPPED'
      win.workerId = null
      win.stage = 'stopped'
      win.summaryText = 'STOPPED BY USER'
      this.persistStateToDisk()
      this.appendCombinedLog({
        workerId: 'SYS',
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: `${win.startFormatted}–${win.endFormatted}`,
        level: 'STOPPED',
        step: 'stop window',
        message: `Stopped queued Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`,
      })
      return
    }

    const jobScanScope = `parallel-${this.scanId}-${win.id}`
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      if (slot.leasedWindowId === windowId) {
        slot.controller.setPaused(false)
        slot.controller.requestStop({ scanId: jobScanScope })
        void slot.controller.closeContext().catch(() => {})
      }
    }
  }

  public skipWindow(windowId: string) {
    this.stoppedWindowIds.add(windowId)
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return
    const prevStatus = win.status
    win.status = 'SKIPPED'
    win.stage = 'skipped'
    win.summaryText = 'Skipped by user'
    this.persistStateToDisk()

    this.appendCombinedLog({
      workerId: win.workerId || 'SYS',
      windowId: win.id,
      windowNumber: win.windowNumber,
      windowRange: `${win.startFormatted}–${win.endFormatted}`,
      level: 'STOPPED',
      step: 'skip window',
      message: `Skipped Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`,
    })

    if (
      prevStatus === 'ASSIGNED' ||
      prevStatus === 'WAITING_FOR_UPLOAD_GATE' ||
      prevStatus === 'WAITING_FOR_RAM' ||
      prevStatus === 'SETUP' ||
      prevStatus === 'RUNNING' ||
      prevStatus === 'VALIDATING' ||
      prevStatus === 'RETRYING' ||
      prevStatus === '403_WAIT'
    ) {
      const jobScanScope = `parallel-${this.scanId}-${win.id}`
      const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
      for (const slot of leased) {
        if (slot.leasedWindowId === windowId) {
          slot.controller.setPaused(false)
          slot.controller.requestStop({ scanId: jobScanScope })
          void slot.controller.closeContext().catch(() => {})
        }
      }
    }
  }

  public async retryWindow(windowId: string, username?: string) {
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return
    this.stoppedWindowIds.delete(windowId)
    this.windowClipPromises.delete(windowId)
    win.status = 'QUEUED'
    win.workerId = null
    win.stage = 'queued (retry)'
    win.error = null
    win.summaryText = 'Queued for retry'
    this.persistStateToDisk()

    this.appendCombinedLog({
      workerId: 'SYS',
      windowId: win.id,
      windowNumber: win.windowNumber,
      windowRange: `${win.startFormatted}–${win.endFormatted}`,
      level: 'RETRY',
      step: 'manual retry window',
      message: `Re-queued Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted}) for retry`,
    })

    if (!this.active && !this.starting) {
      await this.startParallelScan({
        username: username || this.username || 'admin',
        scanId: this.scanId,
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        resumeExisting: true,
      })
    } else if (this.usingOriginalMovieClips && this.startWindowClipTask) {
      this.clipsTotal += 1
      this.clipsExtracting = this.clipsReady < this.clipsTotal
      this.startWindowClipTask(win)
    }
  }

  public async retryFailedWindows(username?: string) {
    let count = 0
    const retriedWins: ParallelWindowState[] = []
    for (const w of this.windows) {
      if (
        w.status === 'FAILED' ||
        w.status === 'STOPPED' ||
        w.status === 'NEEDS_ATTENTION'
      ) {
        this.stoppedWindowIds.delete(w.id)
        this.windowClipPromises.delete(w.id)
        w.status = 'QUEUED'
        w.workerId = null
        w.stage = 'queued (retry)'
        w.error = null
        w.summaryText = 'Queued for retry'
        count++
        retriedWins.push(w)
      }
    }
    this.persistStateToDisk()

    if (count > 0) {
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'RETRY',
        step: 'retry failed windows',
        message: `Re-queued ${count} failed/stopped window(s) for ${this.scanName}`,
      })
    }

    if (count > 0 && !this.active && !this.starting) {
      await this.startParallelScan({
        username: username || this.username || 'admin',
        scanId: this.scanId,
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        resumeExisting: true,
      })
    } else if (count > 0 && this.usingOriginalMovieClips && this.startWindowClipTask) {
      this.clipsTotal += count
      this.clipsExtracting = this.clipsReady < this.clipsTotal
      for (const w of retriedWins) {
        this.startWindowClipTask(w)
      }
    }
    return count
  }

  public async retryProhibitedWindows(username?: string) {
    let count = 0
    const retriedWins: ParallelWindowState[] = []
    for (const w of this.windows) {
      if (w.status === 'PROHIBITED') {
        this.stoppedWindowIds.delete(w.id)
        this.windowClipPromises.delete(w.id)
        w.status = 'QUEUED'
        w.workerId = null
        w.stage = 'queued (retry)'
        w.error = null
        w.summaryText = 'Queued for retry'
        count++
        retriedWins.push(w)
      }
    }
    this.persistStateToDisk()

    if (count > 0) {
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'RETRY',
        step: 'retry prohibited windows',
        message: `Re-queued ${count} prohibited window(s) for ${this.scanName}`,
      })
    }

    if (count > 0 && !this.active && !this.starting) {
      await this.startParallelScan({
        username: username || this.username || 'admin',
        scanId: this.scanId,
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        resumeExisting: true,
      })
    } else if (count > 0 && this.usingOriginalMovieClips && this.startWindowClipTask) {
      this.clipsTotal += count
      this.clipsExtracting = this.clipsReady < this.clipsTotal
      for (const w of retriedWins) {
        this.startWindowClipTask(w)
      }
    }
    return count
  }

  public async getLiveSnapshot(captureThumbnails = true): Promise<ParallelScanLiveSnapshot> {
    this.refreshScanMetadataFromStore()
    const slotPool = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
    const leasedByThisScan = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)

    // Sync live in-flight window telemetry from slots currently leased by THIS scan
    for (const slot of leasedByThisScan) {
      if (!slot.leasedWindowId) continue
      const win = this.windows.find((w) => w.id === slot.leasedWindowId)
      if (win) {
        if (
          win.status === 'DONE' ||
          win.status === 'PROHIBITED' ||
          win.status === 'FAILED' ||
          win.status === 'STOPPED' ||
          win.status === 'SKIPPED' ||
          win.status === 'NEEDS_ATTENTION'
        ) {
          continue
        }
        const meta = slot.controller.getActiveRunMeta()
        win.modelName = meta.modelName
        win.tokens = meta.tokenCount
        win.attempt = meta.attempt
        win.maxAttempts = meta.maxAttempts
        win.permRetry = meta.permRetry
        win.stage = meta.currentStep
        win.status = mapStepToWindowStatus(meta.currentStep)
        win.elapsedSec = win.startedAt ? Math.round((Date.now() - win.startedAt) / 1000) : 0
      }
    }

    const workerCards: ParallelWorkerCardSnapshot[] = []
    const totalCards = Math.max(this.concurrency, slotPool.totalSlots || DEFAULT_STUDIO_CONCURRENCY)
    const chromeStats = readChromeProcsPerWorker(totalCards)

    for (let i = 1; i <= totalCards; i++) {
      const slot = globalProfileSlotPool.getOrCreateSlot(i)
      const isLeasedByThisScan = slot.leasedByScanId === this.scanId
      const isLeasedByOtherScan =
        slot.leasedByScanId !== null && slot.leasedByScanId !== this.scanId
      const activeWin =
        isLeasedByThisScan && slot.leasedWindowId
          ? this.windows.find((w) => w.id === slot.leasedWindowId) || null
          : null
      const wProcs = chromeStats.perWorkerProcs[slot.workerId] || 0
      const wRssMb = chromeStats.perWorkerRssMb[slot.workerId] || 0

      if (isLeasedByThisScan) {
        const snap = await slot.controller.getSnapshot(
          captureThumbnails && Boolean(activeWin),
          {
            quality: 38,
            minIntervalMs: 3000,
            maxLogs: 200,
          },
        )
        const meta = slot.controller.getActiveRunMeta()
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: true,
          leasedByScanId: this.scanId,
          leasedByScanLabel: this.scanName,
          leasedByOtherScan: false,
          status: activeWin ? activeWin.status : 'SETUP',
          windowId: activeWin?.id ?? slot.leasedWindowId,
          windowNumber: activeWin?.windowNumber ?? slot.leasedWindowNumber,
          windowRange: activeWin
            ? `${activeWin.startFormatted}–${activeWin.endFormatted}`
            : slot.leasedWindowRange,
          runLabel: activeWin?.runLabel ?? null,
          modelName: activeWin?.modelName || meta.modelName || 'Gemini 3.8 Flash',
          stage: activeWin ? meta.currentStep : snap.currentStep || 'running',
          tokens: activeWin ? meta.tokenCount : snap.tokenCount,
          elapsedSec: activeWin?.elapsedSec ?? snap.elapsedSec,
          attempt: activeWin?.attempt ?? meta.attempt,
          maxAttempts: activeWin?.maxAttempts ?? meta.maxAttempts,
          permRetry: activeWin?.permRetry ?? meta.permRetry,
          summaryText: activeWin?.summaryText ?? null,
          screenshotBase64: snap.screenshotBase64,
          screenshotAt: snap.screenshotAt,
          chromeProcessCount: wProcs,
          chromeRssMb: wRssMb,
          logs: slot.controller.getLogs(200),
        })
      } else if (isLeasedByOtherScan) {
        // Slot is currently leased by a DIFFERENT scan: never leak the other scan's window controls or screenshot as ours
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: false,
          leasedByScanId: slot.leasedByScanId,
          leasedByScanLabel: slot.leasedByScanLabel,
          leasedByOtherScan: true,
          status: 'IDLE',
          windowId: null,
          windowNumber: null,
          windowRange: null,
          runLabel: null,
          modelName: 'Gemini 3.8 Flash',
          stage: `In use by ${slot.leasedByScanLabel || slot.leasedByScanId}`,
          tokens: null,
          elapsedSec: 0,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          summaryText: `Busy (${slot.leasedByScanLabel || slot.leasedByScanId})`,
          screenshotBase64: null,
          screenshotAt: null,
          chromeProcessCount: wProcs,
          chromeRssMb: wRssMb,
          logs: [],
        })
      } else {
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: false,
          leasedByScanId: null,
          leasedByScanLabel: null,
          leasedByOtherScan: false,
          status: this.waitingForWorkerSlots ? 'WAITING_FOR_WORKER' : 'IDLE',
          windowId: null,
          windowNumber: null,
          windowRange: null,
          runLabel: null,
          modelName: 'Gemini 3.8 Flash',
          stage: this.waitingForWorkerSlots ? 'WAITING FOR WORKER' : 'idle',
          tokens: null,
          elapsedSec: 0,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          summaryText: null,
          screenshotBase64: null,
          screenshotAt: null,
          chromeProcessCount: wProcs,
          chromeRssMb: wRssMb,
          logs: [],
        })
      }
    }

    // Also reflect scan.movie360p compression state if active in store
    let liveCompressing360p = this.compressing360p
    if (!liveCompressing360p && this.scanId && this.scanId !== 'default') {
      try {
        const s = getScan(this.scanId)
        if (s?.movie360p?.status === 'compressing') {
          const pct = Math.max(0, Math.min(100, Math.round(s.movie360p.progress || 0)))
          liveCompressing360p = {
            active: true,
            progress: pct,
            statusText: `Compressing movie 360p... ${pct}%`,
            sizeBytes: s.movie360p.sizeBytes ?? null,
            error: s.movie360p.error ?? null,
          }
        }
      } catch {
        /* ignore */
      }
    }

    const activeWorkersCount = leasedByThisScan.length
    const doneCount = this.windows.filter((w) => w.status === 'DONE').length
    const queuedCount = this.windows.filter(
      (w) =>
        w.status === 'QUEUED' ||
        w.status === 'ASSIGNED' ||
        w.status === 'WAITING_FOR_WORKER' ||
        w.status === 'WAITING_FOR_RAM' ||
        w.status === 'WAITING_FOR_UPLOAD_GATE',
    ).length
    const failedCount = this.windows.filter(
      (w) => w.status === 'FAILED' || w.status === 'STOPPED',
    ).length
    const prohibitedCount = this.windows.filter((w) => w.status === 'PROHIBITED').length
    const needsAttentionCount = this.windows.filter((w) => w.status === 'NEEDS_ATTENTION').length
    const elapsedSec =
      this.startedAt && (this.active || this.starting)
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : this.startedAt && this.finishedAt
          ? Math.max(0, Math.round((this.finishedAt - this.startedAt) / 1000))
          : this.windows.reduce((acc, w) => Math.max(acc, w.elapsedSec || 0), 0)

    return {
      active: this.active,
      starting: this.starting,
      paused: this.paused,
      waitingForWorkerSlots: this.waitingForWorkerSlots,
      hasResumableState: this.hasResumableStateOnDisk(),
      compressing360p: liveCompressing360p,
      mediaInfo: this.mediaInfo,
      scanId: this.scanId,
      scanName: this.scanName,
      username: this.username,
      currentRunId: this.currentRunId,
      runHistory: this.runHistory,
      minuteInput: this.minuteInput,
      minuteInputSource: this.minuteInputSource,
      foundMinutesInput: this.foundMinutesInput,
      movieDurationSec: this.movieDurationSec > 0 ? this.movieDurationSec : null,
      concurrency: this.concurrency,
      measuredTokenRate: this.measuredTokenRate,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedSec,
      activeWorkersCount,
      doneCount,
      queuedCount,
      failedCount,
      prohibitedCount,
      needsAttentionCount,
      totalWindows: this.windows.length,
      clipsReady: this.clipsReady,
      clipsTotal: this.clipsTotal,
      clipsExtracting: this.clipsExtracting,
      ramUsedPercent: readSystemRamUsedPercent(),
      freeDiskGb: readFreeDiskGb(),
      devShmUsedMb: readDevShmUsedMb(),
      chromeProcessCount: chromeStats.totalProcs,
      chromeProcsPerWorker: chromeStats.perWorkerProcs,
      chromeRssMbPerWorker: chromeStats.perWorkerRssMb,
      resourceWarning: this.resourceWarning,
      slotPool,
      workers: workerCards,
      windows: this.windows,
      mergedReport: this.getMergedReport(),
      combinedLogs: this.combinedLogs,
      totalLogLinesOnDisk: this.totalLogLinesOnDisk,
      resourceSnapshots: this.resourceSnapshots,
    }
  }
}

function getManagersMap(): Map<string, StudioParallelManager> {
  if (!globalForParallelStudio.__cmtStudioParallelManagers) {
    globalForParallelStudio.__cmtStudioParallelManagers = new Map<string, StudioParallelManager>()
  }
  const map = globalForParallelStudio.__cmtStudioParallelManagers

  if (!globalForParallelStudio.__cmtStudioParallelRestored) {
    globalForParallelStudio.__cmtStudioParallelRestored = true
    try {
      const scansRoot = path.join(DATA_DIR, 'scans')
      if (fs.existsSync(scansRoot)) {
        const entries = fs.readdirSync(scansRoot)
        for (const dirName of entries) {
          const stateFile = path.join(scansRoot, dirName, 'parallel-state.json')
          const legacyWinFile = path.join(scansRoot, dirName, 'parallel-windows.json')
          if (fs.existsSync(stateFile) || fs.existsSync(legacyWinFile)) {
            if (!map.has(dirName)) {
              map.set(dirName, new StudioParallelManager(dirName))
            }
          }
        }
      }
      // Also check legacy global file ONCE for migration ONLY to its own scanId, then rename to .migrated
      if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
        try {
          const legacy = JSON.parse(fs.readFileSync(LEGACY_PARALLEL_STATE_FILE, 'utf8'))
          if (legacy && typeof legacy.scanId === 'string' && legacy.scanId && legacy.scanId !== 'default') {
            if (!map.has(legacy.scanId)) {
              const mgr = new StudioParallelManager(legacy.scanId)
              map.set(legacy.scanId, mgr)
            }
          }
          if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
            fs.renameSync(LEGACY_PARALLEL_STATE_FILE, LEGACY_PARALLEL_STATE_MIGRATED_FILE)
          }
        } catch {
          try {
            if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
              fs.renameSync(LEGACY_PARALLEL_STATE_FILE, LEGACY_PARALLEL_STATE_MIGRATED_FILE)
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore startup scan dir walk error */
    }
  }

  return map
}

/**
 * Get the isolated StudioParallelManager for a specific scanId.
 */
export function getStudioParallelManager(scanId?: string | null): StudioParallelManager {
  const key = (scanId || '').trim() || 'default'
  const map = getManagersMap()
  let mgr = map.get(key)
  if (!mgr) {
    mgr = new StudioParallelManager(key)
    map.set(key, mgr)
  } else {
    Object.setPrototypeOf(mgr, StudioParallelManager.prototype)
  }
  return mgr
}

export function stopAndDeleteStudioParallelManager(scanId: string): void {
  const key = (scanId || '').trim()
  if (!key) return
  const map = getManagersMap()
  const mgr = map.get(key)
  if (mgr) {
    mgr.stopAll()
    map.delete(key)
  }
  globalProfileSlotPool.releaseAllSlotsForScan(key)
  try {
    fs.rmSync(path.join(DATA_DIR, 'scans', key), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

registerParallelWindowCompletionChecker((scanId: string) => {
  const map = getManagersMap()
  const mgr = map.get(scanId)
  if (!mgr) return null
  const snapWins = (mgr as unknown as { windows: ParallelWindowState[]; active: boolean; starting: boolean }).windows
  const isActive = (mgr as unknown as { active: boolean }).active
  const isStarting = (mgr as unknown as { starting: boolean }).starting
  if (!Array.isArray(snapWins) || snapWins.length === 0) {
    return isActive || isStarting ? { done: false } : null
  }
  const allTerminal = snapWins.every(
    (w) =>
      w.status === 'DONE' ||
      w.status === 'FAILED' ||
      w.status === 'PROHIBITED' ||
      w.status === 'SKIPPED' ||
      w.status === 'STOPPED',
  )
  return {
    done: allTerminal,
    reason: allTerminal ? 'All parallel windows reached terminal state' : undefined,
  }
})


export const studioParallelManager = getStudioParallelManager('default')
