import { chunkAbsWindow } from './segment-range'
import { fmtTime } from './format'
import type { ChunkMatch, Scan, ShortSegmentState } from './types'

export interface StudioShortPart {
  partIndex: number
  /** Start offset in seconds within the short video */
  startSec: number
  /** End offset in seconds within the short video */
  endSec: number
  /** Duration in seconds */
  durationSec: number
  /** Underlying 1-minute shortSegments[i].index values grouped into this part */
  segmentIndexes: number[]
  label: string
}

export interface StudioMovieBlock {
  blockIndex: number
  /** Start offset in seconds within the full movie */
  startSec: number
  /** End offset in seconds within the full movie */
  endSec: number
  /** Duration in seconds */
  durationSec: number
  /** 1-based movie minutes covered by this block (for human-readable logs) */
  movieMinutes: number[]
  /** 0-based 60s chunk indexes covered by this block (for UI timeline & status updates) */
  chunkIndexes: number[]
  label: string
}

export interface StudioScanJobPlan {
  jobIndex: number
  shortPart: StudioShortPart
  movieBlock: StudioMovieBlock
  /** Number of times this job's movieBlock has been split due to exceeding maxInputTokens (max 3) */
  shrinkLevel?: number
}

export interface WindowPlannerOptions {
  /** Max movie window duration in minutes (default 5) */
  windowMinutes: number
  /** Max short part duration in minutes (default 3) */
  shortPartMinutes: number
  /** Optional overlap in seconds added to the end of each movie block (default 0) */
  windowOverlapSec: number
}

/**
 * Derive the 0-based 60-second chunk index for a given absolute movie timestamp:
 * floor((movieStart - trimStart) / 60), clamped to valid chunk range.
 */
export function deriveChunkIndexForMovieTime(
  scan: Pick<Scan, 'movieTrimStart' | 'chunkCount'>,
  movieStartSec: number,
  fallbackChunkIndexes?: number[],
): number {
  const trimStart = scan.movieTrimStart ?? 0
  const rawIdx = Math.floor(Math.max(0, movieStartSec - trimStart) / 60)
  const maxChunk = Math.max(0, (scan.chunkCount || 1) - 1)
  const clamped = Math.min(maxChunk, Math.max(0, rawIdx))
  if (fallbackChunkIndexes && fallbackChunkIndexes.length > 0) {
    if (fallbackChunkIndexes.includes(clamped)) return clamped
    // Find closest chunk in the block
    let best = fallbackChunkIndexes[0]
    let bestDist = Math.abs(best - clamped)
    for (const ci of fallbackChunkIndexes) {
      const d = Math.abs(ci - clamped)
      if (d < bestDist) {
        best = ci
        bestDist = d
      }
    }
    return best
  }
  return clamped
}

/**
 * Clip a ChunkMatch to a 60s short segment boundary [segStart, segEnd] and shift
 * movieStart / movieEnd by the corresponding amount (1:1 when speed ratio is 1,
 * or proportional to movieDuration / shortDuration when ratio != 1).
 * Returns null if the match does not overlap [segStart, segEnd] or the clipped piece is < 0.05s.
 */
export function clipMatchToShortSegment(
  match: ChunkMatch,
  segStart: number,
  segEnd: number,
  scan?: Pick<Scan, 'movieTrimStart' | 'chunkCount'>,
  fallbackChunkIndexes?: number[],
): ChunkMatch | null {
  const origShortDur = match.shortEnd - match.shortStart
  const origMovieDur = match.movieEnd - match.movieStart
  if (origShortDur <= 0 || match.shortEnd <= segStart || match.shortStart >= segEnd) {
    return null
  }

  const clippedShortStart = Math.max(segStart, match.shortStart)
  const clippedShortEnd = Math.min(segEnd, match.shortEnd)
  const clippedShortDur = clippedShortEnd - clippedShortStart

  // Drop pieces shorter than ~0.05 s
  if (clippedShortDur < 0.05) {
    return null
  }

  const deltaStart = clippedShortStart - match.shortStart
  const deltaEnd = match.shortEnd - clippedShortEnd
  const speedRatio =
    origShortDur > 0 && origMovieDur > 0
      ? Math.abs(origMovieDur - origShortDur) < 1e-6
        ? 1
        : origMovieDur / origShortDur
      : 1

  const clippedMovieStart = Number((match.movieStart + deltaStart * speedRatio).toFixed(3))
  const clippedMovieEnd = Number((match.movieEnd - deltaEnd * speedRatio).toFixed(3))
  if (clippedMovieEnd - clippedMovieStart < 0.02) {
    return null
  }

  const updatedChunkIndex = scan
    ? deriveChunkIndexForMovieTime(scan, clippedMovieStart, fallbackChunkIndexes)
    : match.chunkIndex

  return {
    ...match,
    shortStart: Number(clippedShortStart.toFixed(3)),
    shortEnd: Number(clippedShortEnd.toFixed(3)),
    movieStart: clippedMovieStart,
    movieEnd: clippedMovieEnd,
    chunkIndex: updatedChunkIndex,
  }
}

/**
 * Group selected 1-minute shortSegments into contiguous parts of <= shortPartMinutes (default 3 min).
 */
export function groupShortSegmentsIntoParts(
  scan: Scan,
  selectedSegments: ShortSegmentState[],
  shortPartMinutes: number = 3,
): StudioShortPart[] {
  const maxPartSec = Math.max(60, shortPartMinutes * 60)
  const sorted = [...selectedSegments].sort((a, b) => a.index - b.index)

  if (sorted.length === 0) {
    const dur = scan.shortDuration || 60
    const parts: StudioShortPart[] = []
    let pIdx = 0
    for (let s = 0; s < dur; s += maxPartSec) {
      const e = Math.min(dur, s + maxPartSec)
      parts.push({
        partIndex: pIdx++,
        startSec: s,
        endSec: e,
        durationSec: e - s,
        segmentIndexes: [0],
        label: `Short ${fmtTime(s)}–${fmtTime(e)}`,
      })
    }
    return parts
  }

  const parts: StudioShortPart[] = []
  let currentSegs: ShortSegmentState[] = []
  let partStart = 0
  let partEnd = 0

  const flush = () => {
    if (currentSegs.length === 0) return
    const pIdx = parts.length
    parts.push({
      partIndex: pIdx,
      startSec: partStart,
      endSec: partEnd,
      durationSec: Math.max(1, partEnd - partStart),
      segmentIndexes: currentSegs.map((s) => s.index),
      label: `Part ${pIdx + 1} (${fmtTime(partStart)}–${fmtTime(partEnd)})`,
    })
    currentSegs = []
  }

  for (const seg of sorted) {
    if (currentSegs.length === 0) {
      currentSegs.push(seg)
      partStart = seg.start
      partEnd = seg.end
      continue
    }

    const isContiguous = Math.abs(seg.start - partEnd) < 1.0
    const newDuration = seg.end - partStart
    if (isContiguous && newDuration <= maxPartSec + 0.5) {
      currentSegs.push(seg)
      partEnd = seg.end
    } else {
      flush()
      currentSegs.push(seg)
      partStart = seg.start
      partEnd = seg.end
    }
  }
  flush()

  return parts
}

/**
 * Build contiguous movie blocks of up to `windowMinutes` (default 5 min) for a given ShortPart.
 * - Uses the union of approved `movieMinutes` (from lib/minute-ranges.ts applyApprovedMinutes)
 *   and pending chunk indexes across the short segments in this part.
 * - Skips minute gaps (e.g. minutes 32..40 -> 32-37, 37-40).
 * - If no minute list exists (manual Full scan), covers the pending chunks in the trimmed movie range in 5-min blocks.
 */
export function buildMovieBlocksForShortPart(
  scan: Scan,
  part: StudioShortPart,
  allSegments: ShortSegmentState[],
  options: WindowPlannerOptions,
): StudioMovieBlock[] {
  const windowMinutes = Math.max(1, options.windowMinutes || 5)
  const overlapSec = Math.max(0, options.windowOverlapSec || 0)
  const movieDur = scan.movieDuration || 0
  const trimEnd = scan.movieTrimEnd ?? movieDur

  const partSegs = allSegments.filter((s) => part.segmentIndexes.includes(s.index))

  // Collect all pending 60s chunk indexes across the segments in this ShortPart.
  // Note: applyApprovedMinutes (from lib/minute-ranges.ts) already marks chunks inside
  // seg.movieMinutes as 'pending' and chunks outside as 'cancelled'.
  const pendingChunkSet = new Set<number>()

  if (partSegs.length > 0) {
    for (const seg of partSegs) {
      const hasApprovedMinutes = Array.isArray(seg.movieMinutes) && seg.movieMinutes.length > 0
      for (const ch of seg.chunks || []) {
        if (ch.status !== 'pending' && ch.status !== 'scanning') continue
        if (hasApprovedMinutes) {
          const { start: cs, end: ce } = chunkAbsWindow(scan, ch.index)
          const overlapsApproved = seg.movieMinutes!.some((m) => {
            const ms = (m - 1) * 60
            const me = m * 60
            return cs < me && ce > ms
          })
          if (!overlapsApproved) continue
        }
        pendingChunkSet.add(ch.index)
      }
    }
  } else {
    for (const ch of scan.chunks || []) {
      if (ch.status === 'pending' || ch.status === 'scanning') {
        pendingChunkSet.add(ch.index)
      }
    }
  }

  const sortedChunks = [...pendingChunkSet].sort((a, b) => a - b)
  if (sortedChunks.length === 0) return []

  // Group contiguous chunk indexes into blocks of at most `windowMinutes` chunks
  const blocks: StudioMovieBlock[] = []
  let currentGroup: number[] = []

  const flushBlock = () => {
    if (currentGroup.length === 0) return
    const firstCi = currentGroup[0]
    const lastCi = currentGroup[currentGroup.length - 1]
    const firstWin = chunkAbsWindow(scan, firstCi)
    const lastWin = chunkAbsWindow(scan, lastCi)
    const startSec = firstWin.start
    const endSec = Math.min(trimEnd > 0 ? trimEnd : lastWin.end, lastWin.end + overlapSec)
    const startMin = Math.floor(startSec / 60)
    const endMin = Math.ceil(endSec / 60)
    const movieMinutes: number[] = []
    for (let m = startMin + 1; m <= endMin; m++) movieMinutes.push(m)

    blocks.push({
      blockIndex: blocks.length,
      startSec,
      endSec,
      durationSec: Math.max(1, endSec - startSec),
      movieMinutes,
      chunkIndexes: [...currentGroup],
      label: `Min ${startMin}–${endMin} (${fmtTime(startSec)}–${fmtTime(endSec)})`,
    })
    currentGroup = []
  }

  for (const ci of sortedChunks) {
    if (currentGroup.length === 0) {
      currentGroup.push(ci)
      continue
    }
    const prevCi = currentGroup[currentGroup.length - 1]
    const isConsecutive = ci === prevCi + 1
    if (isConsecutive && currentGroup.length < windowMinutes) {
      currentGroup.push(ci)
    } else {
      flushBlock()
      currentGroup.push(ci)
    }
  }
  flushBlock()

  return blocks
}

/**
 * Split a movie block in half when AI Studio's token counter exceeds the maxInputTokens limit.
 */
export function splitMovieBlockInHalf(
  scan: Scan,
  block: StudioMovieBlock,
  overlapSec: number = 0,
): StudioMovieBlock[] {
  if (block.chunkIndexes.length <= 1) {
    // Even a single chunk can be split into two 30s halves if needed
    const mid = Math.round((block.startSec + block.endSec) / 2)
    if (mid <= block.startSec + 10 || mid >= block.endSec - 10) return [block]
    return [
      {
        ...block,
        endSec: mid,
        durationSec: mid - block.startSec,
        label: `${block.label} [A]`,
      },
      {
        ...block,
        startSec: mid,
        durationSec: block.endSec - mid,
        label: `${block.label} [B]`,
      },
    ]
  }

  const half = Math.ceil(block.chunkIndexes.length / 2)
  const leftChunks = block.chunkIndexes.slice(0, half)
  const rightChunks = block.chunkIndexes.slice(half)
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0

  const makeSubBlock = (chunks: number[], suffix: string): StudioMovieBlock => {
    const firstWin = chunkAbsWindow(scan, chunks[0])
    const lastWin = chunkAbsWindow(scan, chunks[chunks.length - 1])
    const startSec = firstWin.start
    const endSec = Math.min(trimEnd > 0 ? trimEnd : lastWin.end, lastWin.end + overlapSec)
    const startMin = Math.floor(startSec / 60)
    const endMin = Math.ceil(endSec / 60)
    return {
      blockIndex: block.blockIndex,
      startSec,
      endSec,
      durationSec: Math.max(1, endSec - startSec),
      movieMinutes: block.movieMinutes,
      chunkIndexes: chunks,
      label: `Min ${startMin}–${endMin}${suffix} (${fmtTime(startSec)}–${fmtTime(endSec)})`,
    }
  }

  return [makeSubBlock(leftChunks, 'a'), makeSubBlock(rightChunks, 'b')]
}

/**
 * Build the complete ordered list of (shortPart, movieBlock) Studio scan jobs.
 */
export function buildStudioScanPlan(
  scan: Scan,
  selectedSegments: ShortSegmentState[],
  options: WindowPlannerOptions,
): StudioScanJobPlan[] {
  const parts = groupShortSegmentsIntoParts(scan, selectedSegments, options.shortPartMinutes)
  const jobs: StudioScanJobPlan[] = []

  for (const part of parts) {
    const blocks = buildMovieBlocksForShortPart(scan, part, selectedSegments, options)
    for (const block of blocks) {
      jobs.push({
        jobIndex: jobs.length,
        shortPart: part,
        movieBlock: block,
      })
    }
  }

  return jobs
}

// ============================================================================
// PARALLEL WINDOW BUILDER & RESULT MERGER
// ============================================================================

export interface ParallelWindowSpec {
  id: string
  windowNumber: number // 1-indexed chronological window number
  runIndex: number // 1-indexed contiguous run index
  runLabel: string // e.g., "25-41 (25:00-42:00)"
  runTotalSeconds: number
  partIndex: number // 1..partsInRun
  partsInRun: number
  startSec: number
  endSec: number
  durationSec: number
  startFormatted: string
  endFormatted: string
  priorityRank: number // 1..N in pull-queue priority order (largest runs first)
  parentWindowId?: string
}

export interface ContiguousMinuteRun {
  runIndex: number
  startMinute: number
  endMinuteInclusive: number
  startSec: number
  endSec: number
  runSeconds: number
  label: string
}

/**
 * Format seconds as M:SS or H:MM:SS for AI Studio clip inputs and window display.
 * e.g. 420 -> "7:00", 3780 -> "1:03:00"
 */
export function formatParallelTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * Parse a timecode string ("7:00", "29:15", "1:03:00") into seconds.
 */
export function parseParallelTimecodeToSeconds(tc: string): number | null {
  const parts = (tc || '')
    .trim()
    .split(':')
    .map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  return null
}

/**
 * Parse a comma/space-separated minute list & range specification like:
 * "7,8,9,10,14,15,16,17,19,20,21,25-41,48-54,56,57,58,63-67,71-100"
 * where Minute N = N:00 to (N+1):00.
 * Groups contiguous minutes into runs, skipping gaps.
 */
export function parseMinuteInputToContiguousRuns(input: string): ContiguousMinuteRun[] {
  const minutesSet = new Set<number>()
  const tokens = (input || '')
    .split(/[,\s;]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10)
      const b = parseInt(rangeMatch[2], 10)
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const lo = Math.max(0, Math.min(a, b))
        const hi = Math.min(600, Math.max(a, b))
        for (let m = lo; m <= hi; m++) {
          minutesSet.add(m)
        }
      }
      continue
    }
    if (/^\d+$/.test(token)) {
      const m = parseInt(token, 10)
      if (Number.isFinite(m) && m >= 0 && m <= 600) {
        minutesSet.add(m)
      }
    }
  }

  const sortedMinutes = Array.from(minutesSet).sort((a, b) => a - b)
  if (sortedMinutes.length === 0) return []

  const runs: ContiguousMinuteRun[] = []
  let runStartMin = sortedMinutes[0]
  let prevMin = sortedMinutes[0]

  const pushRun = (startM: number, endM: number) => {
    const startSec = startM * 60
    const endSec = (endM + 1) * 60
    const runSeconds = endSec - startSec
    const runIndex = runs.length + 1
    const minRangeStr = startM === endM ? `${startM}` : `${startM}-${endM}`
    runs.push({
      runIndex,
      startMinute: startM,
      endMinuteInclusive: endM,
      startSec,
      endSec,
      runSeconds,
      label: `${minRangeStr} (${formatParallelTimecode(startSec)}-${formatParallelTimecode(endSec)})`,
    })
  }

  for (let i = 1; i < sortedMinutes.length; i++) {
    const cur = sortedMinutes[i]
    if (cur === prevMin + 1) {
      prevMin = cur
    } else {
      pushRun(runStartMin, prevMin)
      runStartMin = cur
      prevMin = cur
    }
  }
  pushRun(runStartMin, prevMin)

  return runs
}

/**
 * Build the parallel scan windows according to strict rules:
 * 1. Contiguous minute runs, gaps skipped.
 * 2. Run <= 300s (5:00) => single window, no overlap.
 * 3. Run > 300s => contiguous boundaries b_0 = runStart, b_k = min(runEnd, round(runStart + k*runSeconds/n) + 5) for k = 1..n-1, b_n = runEnd (no overlap, no gap).
 * 4. Assert every window is <= 300s (never > 5:00); increase n if any window would exceed 300s.
 * 5. Compute queue priority order so windows from the largest runs (e.g. 71-101, 25-42) are pulled first.
 */
export function buildParallelWindowsFromMinuteInput(
  input: string,
  movieDurationSeconds?: number,
): {
  runs: ContiguousMinuteRun[]
  windows: ParallelWindowSpec[]
  queueOrderIds: string[]
} {
  const runs = parseMinuteInputToContiguousRuns(input)
  const rawWindows: Omit<ParallelWindowSpec, 'priorityRank'>[] = []

  for (const run of runs) {
    const runStart = run.startSec
    const runEnd =
      movieDurationSeconds && movieDurationSeconds > 0
        ? Math.min(run.endSec, Math.floor(movieDurationSeconds))
        : run.endSec
    const runSeconds = Math.max(0, runEnd - runStart)
    if (runSeconds <= 0) continue

    if (runSeconds <= 300) {
      const windowNumber = rawWindows.length + 1
      const durationSec = runEnd - runStart
      if (durationSec > 300) {
        throw new Error(`Window #${windowNumber} exceeds 300s (${durationSec}s)`)
      }
      rawWindows.push({
        id: `W${String(windowNumber).padStart(2, '0')}`,
        windowNumber,
        runIndex: run.runIndex,
        runLabel: run.label,
        runTotalSeconds: runSeconds,
        partIndex: 1,
        partsInRun: 1,
        startSec: runStart,
        endSec: runEnd,
        durationSec,
        startFormatted: formatParallelTimecode(runStart),
        endFormatted: formatParallelTimecode(runEnd),
      })
    } else {
      let n = Math.ceil(runSeconds / 290)
      let boundaries: number[] = []
      while (true) {
        boundaries = [runStart]
        for (let k = 1; k < n; k++) {
          boundaries.push(Math.min(runEnd, Math.round(runStart + (k * runSeconds) / n) + 5))
        }
        boundaries.push(runEnd)
        const allWithin300 = boundaries.slice(0, -1).every((bStart, k) => {
          const bEnd = boundaries[k + 1]
          return bEnd - bStart <= 300
        })
        if (allWithin300) break
        n += 1
      }

      for (let k = 0; k < n; k++) {
        const startSec = boundaries[k]
        const endSec = boundaries[k + 1]
        const durationSec = endSec - startSec
        if (durationSec > 300) {
          throw new Error(`Window exceeds 300s (${durationSec}s) at run ${run.label}`)
        }
        const windowNumber = rawWindows.length + 1
        rawWindows.push({
          id: `W${String(windowNumber).padStart(2, '0')}`,
          windowNumber,
          runIndex: run.runIndex,
          runLabel: run.label,
          runTotalSeconds: runSeconds,
          partIndex: k + 1,
          partsInRun: n,
          startSec,
          endSec,
          durationSec,
          startFormatted: formatParallelTimecode(startSec),
          endFormatted: formatParallelTimecode(endSec),
        })
      }
    }
  }

  // Sort for pull queue priority: largest runTotalSeconds first, then chronological windowNumber
  const prioritySorted = [...rawWindows].sort((a, b) => {
    if (b.runTotalSeconds !== a.runTotalSeconds) {
      return b.runTotalSeconds - a.runTotalSeconds
    }
    return a.windowNumber - b.windowNumber
  })

  const rankById = new Map<string, number>()
  prioritySorted.forEach((w, idx) => {
    rankById.set(w.id, idx + 1)
  })

  const windows: ParallelWindowSpec[] = rawWindows.map((w) => ({
    ...w,
    priorityRank: rankById.get(w.id) ?? w.windowNumber,
  }))

  return {
    runs,
    windows,
    queueOrderIds: prioritySorted.map((w) => w.id),
  }
}

/**
 * Split a single window into 2 equal contiguous halves (no overlap) when context-limit is hit.
 */
export function splitParallelWindowInHalf(
  win: ParallelWindowSpec,
  nextWindowNumberStart: number,
): [ParallelWindowSpec, ParallelWindowSpec] {
  const totalSec = win.endSec - win.startSec
  const midSec = Math.round(win.startSec + totalSec / 2)
  const firstEnd = Math.min(win.endSec, Math.min(midSec, win.startSec + 300))
  const secondStart = midSec

  if (firstEnd - win.startSec > 300 || win.endSec - secondStart > 300) {
    throw new Error(`Split window half exceeds 300s (${win.startFormatted}-${win.endFormatted})`)
  }

  const w1Num = nextWindowNumberStart
  const w2Num = nextWindowNumberStart + 1

  const firstHalf: ParallelWindowSpec = {
    id: `${win.id}a`,
    windowNumber: w1Num,
    runIndex: win.runIndex,
    runLabel: `${win.runLabel} [split 1/2]`,
    runTotalSeconds: win.runTotalSeconds,
    partIndex: 1,
    partsInRun: 2,
    startSec: win.startSec,
    endSec: firstEnd,
    durationSec: firstEnd - win.startSec,
    startFormatted: formatParallelTimecode(win.startSec),
    endFormatted: formatParallelTimecode(firstEnd),
    priorityRank: win.priorityRank,
    parentWindowId: win.id,
  }

  const secondHalf: ParallelWindowSpec = {
    id: `${win.id}b`,
    windowNumber: w2Num,
    runIndex: win.runIndex,
    runLabel: `${win.runLabel} [split 2/2]`,
    runTotalSeconds: win.runTotalSeconds,
    partIndex: 2,
    partsInRun: 2,
    startSec: secondStart,
    endSec: win.endSec,
    durationSec: win.endSec - secondStart,
    startFormatted: formatParallelTimecode(secondStart),
    endFormatted: formatParallelTimecode(win.endSec),
    priorityRank: win.priorityRank,
    parentWindowId: win.id,
  }

  return [firstHalf, secondHalf]
}

export interface MergedShortSegmentResult {
  segmentIndex: number
  shortStartSec: number
  shortEndSec: number
  shortRange: string
  description: string
  status: 'FOUND' | 'NOT_FOUND' | 'CONFLICT'
  primaryMovieRange: string | null
  primaryMovieStartSec: number | null
  primaryMovieEndSec: number | null
  primaryWindowId: string | null
  candidates: Array<{
    windowId: string
    windowRange: string
    movieRange: string
    movieStartSec: number
    movieEndSec: number
    description: string
  }>
}

export interface ParallelMergedReport {
  generatedAt: string
  totalWindows: number
  completedWindows: number
  failedWindows: number
  prohibitedWindows: number
  totalShortSegments: number
  foundCount: number
  notFoundCount: number
  conflictCount: number
  segments: MergedShortSegmentResult[]
  formattedTxt: string
}

/**
 * Parse HISSA 1 descriptions and HISSA 2 lines from a validated raw responseText.
 */
export function extractHissa1And2EntriesFromResponse(rawText: string): {
  hissa1Entries: Array<{ shortStartSec: number; shortEndSec: number; description: string }>
  hissa2Entries: Array<{
    shortStartSec: number
    shortEndSec: number
    found: boolean
    movieStartSec: number | null
    movieEndSec: number | null
  }>
} {
  const normalized = (rawText || '').replace(/\r\n/g, '\n')
  const hissa2Match = normalized.match(/(?:^|\n)\s*(?:#+\s*|\*\*\s*)?HISSA\s*2\b/i)
  const hissa1Block =
    hissa2Match && hissa2Match.index !== undefined
      ? normalized.slice(0, hissa2Match.index)
      : normalized
  const hissa2Block =
    hissa2Match && hissa2Match.index !== undefined
      ? normalized.slice(hissa2Match.index)
      : normalized

  const hissa1Entries: Array<{ shortStartSec: number; shortEndSec: number; description: string }> = []
  for (const rawLine of hissa1Block.split('\n')) {
    const line = rawLine.trim().replace(/^[-*•]+\s*/, '').replace(/\*\*/g, '')
    if (!line || /HISSA\s*1/i.test(line)) continue
    const m = line.match(
      /^(?:\d+[.)]\s*)?(?:Short[:\s]+)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*\([^)]*\))?\s*(?:=|:|-|–|—)\s*(.+)$/i,
    )
    if (m) {
      const sStart = parseParallelTimecodeToSeconds(m[1])
      const sEnd = parseParallelTimecodeToSeconds(m[2])
      if (sStart !== null && sEnd !== null && sEnd > sStart) {
        hissa1Entries.push({
          shortStartSec: sStart,
          shortEndSec: sEnd,
          description: m[3].trim(),
        })
      }
    }
  }

  const hissa2Entries: Array<{
    shortStartSec: number
    shortEndSec: number
    found: boolean
    movieStartSec: number | null
    movieEndSec: number | null
  }> = []

  for (const rawLine of hissa2Block.split('\n')) {
    const line = rawLine.trim().replace(/^[-*•]+\s*/, '').replace(/\*\*/g, '')
    if (!line || /HISSA\s*2/i.test(line)) continue

    const foundMatch = line.match(
      /^(?:\d+[.)]\s*)?(?:Short[:\s]+)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*\([^)]*\))?\s*(?:=|-->|->|→)\s*(?:Movie[:\s]+)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*\([^)]*\))?\s*$/i,
    )
    if (foundMatch) {
      const sStart = parseParallelTimecodeToSeconds(foundMatch[1])
      const sEnd = parseParallelTimecodeToSeconds(foundMatch[2])
      const mStart = parseParallelTimecodeToSeconds(foundMatch[3])
      const mEnd = parseParallelTimecodeToSeconds(foundMatch[4])
      if (sStart !== null && sEnd !== null && mStart !== null && mEnd !== null) {
        hissa2Entries.push({
          shortStartSec: sStart,
          shortEndSec: sEnd,
          found: true,
          movieStartSec: mStart,
          movieEndSec: mEnd,
        })
      }
      continue
    }

    const nfMatch = line.match(
      /^(?:\d+[.)]\s*)?(?:Short[:\s]+)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*\([^)]*\))?\s*(?:=|-->|->|→)\s*(?:NOT[_\s-]*FOUND|NONE|N\/A|NULL|NO[_\s-]*MATCH|NAHI[_\s-]*MILA)\b/i,
    )
    if (nfMatch) {
      const sStart = parseParallelTimecodeToSeconds(nfMatch[1])
      const sEnd = parseParallelTimecodeToSeconds(nfMatch[2])
      if (sStart !== null && sEnd !== null) {
        hissa2Entries.push({
          shortStartSec: sStart,
          shortEndSec: sEnd,
          found: false,
          movieStartSec: null,
          movieEndSec: null,
        })
      }
    }
  }

  return {
    hissa1Entries,
    hissa2Entries,
  }
}

const SEAM_TOL = 1.5

/**
 * Merge results from all completed parallel windows:
 * 1. Build canonical short segments list from HISSA 1 / HISSA 2 across completed windows.
 * 2. Seam stitch candidates that straddle contiguous window boundaries (windowA.endSec === windowB.startSec) within SEAM_TOL = 1.5s.
 * 3. Deduplicate seam overlaps (if two windows report the same movie range within ±6s, merge as 1 match).
 * 4. Flag CONFLICT if two windows report genuinely different movie ranges (>6s apart) for the same short segment.
 * 5. Produce clean TXT and JSON reports.
 */
export function mergeParallelWindowResults(params: {
  windows: Array<{
    id: string
    startSec: number
    endSec: number
    startFormatted: string
    endFormatted: string
    status: string
    rawResponseText?: string
    runIndex?: number
  }>
}): ParallelMergedReport {
  const windowBoundsById = new Map<
    string,
    { startSec: number; endSec: number; runIndex?: number; orderIndex: number }
  >()
  params.windows.forEach((w, idx) => {
    windowBoundsById.set(w.id, {
      startSec: w.startSec,
      endSec: w.endSec,
      runIndex: w.runIndex,
      orderIndex: idx,
    })
  })

  const segmentMap = new Map<
    string,
    {
      shortStartSec: number
      shortEndSec: number
      descriptions: string[]
      candidates: Array<{
        windowId: string
        windowRange: string
        movieStartSec: number
        movieEndSec: number
        movieRange: string
        description: string
      }>
    }
  >()

  let completedWindows = 0
  let failedWindows = 0
  let prohibitedWindows = 0

  for (const w of params.windows) {
    if (w.status === 'DONE') completedWindows++
    else if (w.status === 'PROHIBITED') prohibitedWindows++
    else if (w.status === 'FAILED') failedWindows++

    if (!w.rawResponseText) continue
    const { hissa1Entries, hissa2Entries } = extractHissa1And2EntriesFromResponse(w.rawResponseText)

    const descByKey = new Map<string, string>()
    for (const h1 of hissa1Entries) {
      const key = `${Math.round(h1.shortStartSec)}-${Math.round(h1.shortEndSec)}`
      descByKey.set(key, h1.description)
      if (!segmentMap.has(key)) {
        segmentMap.set(key, {
          shortStartSec: h1.shortStartSec,
          shortEndSec: h1.shortEndSec,
          descriptions: [h1.description],
          candidates: [],
        })
      } else {
        const existing = segmentMap.get(key)!
        if (h1.description && !existing.descriptions.includes(h1.description)) {
          existing.descriptions.push(h1.description)
        }
      }
    }

    for (const h2 of hissa2Entries) {
      const key = `${Math.round(h2.shortStartSec)}-${Math.round(h2.shortEndSec)}`
      if (!segmentMap.has(key)) {
        segmentMap.set(key, {
          shortStartSec: h2.shortStartSec,
          shortEndSec: h2.shortEndSec,
          descriptions: [],
          candidates: [],
        })
      }
      const entry = segmentMap.get(key)!
      if (h2.found && h2.movieStartSec !== null && h2.movieEndSec !== null) {
        entry.candidates.push({
          windowId: w.id,
          windowRange: `${w.startFormatted}-${w.endFormatted}`,
          movieStartSec: h2.movieStartSec,
          movieEndSec: h2.movieEndSec,
          movieRange: `${formatParallelTimecode(h2.movieStartSec)} to ${formatParallelTimecode(h2.movieEndSec)}`,
          description: descByKey.get(key) || entry.descriptions[0] || '',
        })
      }
    }
  }

  const sortedSegments = Array.from(segmentMap.values()).sort(
    (a, b) => a.shortStartSec - b.shortStartSec || a.shortEndSec - b.shortEndSec,
  )

  const mergedSegments: MergedShortSegmentResult[] = []
  let foundCount = 0
  let notFoundCount = 0
  let conflictCount = 0

  sortedSegments.forEach((seg, idx) => {
    const shortRange = `${formatParallelTimecode(seg.shortStartSec)} to ${formatParallelTimecode(seg.shortEndSec)}`
    const description = seg.descriptions[0] || 'Scene segment'

    // Step 1: SEAM STITCHING (before +/-6s dedupe), supporting chains (A+B+C)
    type StitchableCandidate = (typeof seg.candidates)[number] & {
      firstWindowId: string
      lastWindowId: string
      windowIds: string[]
    }
    const stitchWork: StitchableCandidate[] = seg.candidates.map((c) => ({
      ...c,
      firstWindowId: c.windowId,
      lastWindowId: c.windowId,
      windowIds: [c.windowId],
    }))

    let stitchedInPass = true
    while (stitchedInPass && stitchWork.length > 1) {
      stitchedInPass = false
      outerLoop: for (let i = 0; i < stitchWork.length; i++) {
        for (let j = 0; j < stitchWork.length; j++) {
          if (i === j) continue
          const candA = stitchWork[i]
          const candB = stitchWork[j]
          if (candA.windowIds.some((id) => candB.windowIds.includes(id))) continue

          const windowA = windowBoundsById.get(candA.lastWindowId)
          const windowB = windowBoundsById.get(candB.firstWindowId)
          if (!windowA || !windowB) continue

          // Never stitch windows from different runs or non-adjacent windows
          if (
            windowA.runIndex !== undefined &&
            windowB.runIndex !== undefined &&
            windowA.runIndex !== windowB.runIndex
          ) {
            continue
          }
          if (windowA.endSec !== windowB.startSec) continue

          if (
            candA.movieEndSec >= windowA.endSec - SEAM_TOL &&
            candB.movieStartSec <= windowB.startSec + SEAM_TOL &&
            Math.abs(candA.movieEndSec - candB.movieStartSec) <= SEAM_TOL
          ) {
            const unionStart = candA.movieStartSec
            const unionEnd = candB.movieEndSec
            const unionCand: StitchableCandidate = {
              windowId: `${candA.windowId}+${candB.windowId}`,
              windowRange: `${candA.windowRange} + ${candB.windowRange}`,
              movieStartSec: unionStart,
              movieEndSec: unionEnd,
              movieRange: `${formatParallelTimecode(unionStart)} to ${formatParallelTimecode(unionEnd)}`,
              description: candA.description,
              firstWindowId: candA.firstWindowId,
              lastWindowId: candB.lastWindowId,
              windowIds: [...candA.windowIds, ...candB.windowIds],
            }
            const firstIdx = Math.min(i, j)
            const secondIdx = Math.max(i, j)
            stitchWork[firstIdx] = unionCand
            stitchWork.splice(secondIdx, 1)
            stitchedInPass = true
            break outerLoop
          }
        }
      }
    }

    const candidatesAfterStitch: typeof seg.candidates = stitchWork.map(
      ({ firstWindowId: _f, lastWindowId: _l, windowIds: _w, ...rest }) => rest,
    )

    // Deduplicate seam overlaps (movie timestamps within ±6s of each other)
    const distinctClusters: typeof seg.candidates = []
    for (const cand of candidatesAfterStitch) {
      const duplicate = distinctClusters.find(
        (c) =>
          Math.abs(c.movieStartSec - cand.movieStartSec) <= 6 &&
          Math.abs(c.movieEndSec - cand.movieEndSec) <= 6,
      )
      if (!duplicate) {
        distinctClusters.push(cand)
      }
    }

    if (distinctClusters.length === 0) {
      notFoundCount++
      mergedSegments.push({
        segmentIndex: idx + 1,
        shortStartSec: seg.shortStartSec,
        shortEndSec: seg.shortEndSec,
        shortRange,
        description,
        status: 'NOT_FOUND',
        primaryMovieRange: null,
        primaryMovieStartSec: null,
        primaryMovieEndSec: null,
        primaryWindowId: null,
        candidates: [],
      })
    } else if (distinctClusters.length === 1) {
      foundCount++
      const primary = distinctClusters[0]
      mergedSegments.push({
        segmentIndex: idx + 1,
        shortStartSec: seg.shortStartSec,
        shortEndSec: seg.shortEndSec,
        shortRange,
        description,
        status: 'FOUND',
        primaryMovieRange: primary.movieRange,
        primaryMovieStartSec: primary.movieStartSec,
        primaryMovieEndSec: primary.movieEndSec,
        primaryWindowId: primary.windowId,
        candidates: candidatesAfterStitch,
      })
    } else {
      conflictCount++
      const primary = distinctClusters[0]
      mergedSegments.push({
        segmentIndex: idx + 1,
        shortStartSec: seg.shortStartSec,
        shortEndSec: seg.shortEndSec,
        shortRange,
        description,
        status: 'CONFLICT',
        primaryMovieRange: primary.movieRange,
        primaryMovieStartSec: primary.movieStartSec,
        primaryMovieEndSec: primary.movieEndSec,
        primaryWindowId: primary.windowId,
        candidates: distinctClusters,
      })
    }
  })

  const hissa1Lines = mergedSegments.map((s) => `${s.shortRange} - ${s.description}`)
  const hissa2Lines = mergedSegments.map((s) => {
    if (s.status === 'NOT_FOUND') {
      return `${s.shortRange} = NOT FOUND`
    }
    if (s.status === 'FOUND') {
      return `${s.shortRange} = ${s.primaryMovieRange} [${s.primaryWindowId}]`
    }
    const allCands = s.candidates.map((c) => `${c.movieRange} (${c.windowId})`).join(' | ')
    return `${s.shortRange} = CONFLICT: ${allCands}`
  })

  const formattedTxt = [
    `# PARALLEL WINDOW SCAN MERGED REPORT`,
    `# Windows: ${completedWindows}/${params.windows.length} DONE (${failedWindows} FAILED, ${prohibitedWindows} PROHIBITED)`,
    `# Segments: ${mergedSegments.length} total | ${foundCount} FOUND | ${notFoundCount} NOT FOUND | ${conflictCount} CONFLICT`,
    ``,
    `HISSA 1`,
    ...hissa1Lines,
    ``,
    `HISSA 2`,
    ...hissa2Lines,
  ].join('\n')

  return {
    generatedAt: new Date().toISOString(),
    totalWindows: params.windows.length,
    completedWindows,
    failedWindows,
    prohibitedWindows,
    totalShortSegments: mergedSegments.length,
    foundCount,
    notFoundCount,
    conflictCount,
    segments: mergedSegments,
    formattedTxt,
  }
}
