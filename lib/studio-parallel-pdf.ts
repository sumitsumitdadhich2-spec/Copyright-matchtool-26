import fs from 'fs'
import { execFileSync } from 'child_process'
import { jsPDF } from 'jspdf'
import {
  getStudioParallelManager,
  type ParallelCombinedLogEntry,
  type ParallelWindowState,
} from './studio-parallel-manager'
import { getScan } from './store'

export type ParallelPdfMode = 'full' | 'errors'
export type ParallelPdfRunScope = 'latest' | 'all'

let cachedChromeVersion: string | null = null

function getRuntimeChromeAndAppVersion(): string {
  if (!cachedChromeVersion) {
    let chromeVer = 'Google Chrome (headed Xvfb)'
    for (const bin of [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]) {
      try {
        if (fs.existsSync(bin)) {
          const out = execFileSync(bin, ['--version'], {
            encoding: 'utf8',
            timeout: 2000,
          }).trim()
          if (out) {
            chromeVer = out
            break
          }
        }
      } catch {
        /* ignore */
      }
    }
    cachedChromeVersion = `${chromeVer} | Node ${process.version} | CMT v1.0`
  }
  return cachedChromeVersion
}

const TTF_MONO_CANDIDATES = [
  '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
]

const TTF_MONO_BOLD_CANDIDATES = [
  '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationMono-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
]

let cachedMonoRegularB64: string | null | undefined = undefined
let cachedMonoBoldB64: string | null | undefined = undefined

function getEmbeddedMonoFonts(): { regularB64: string | null; boldB64: string | null } {
  if (cachedMonoRegularB64 === undefined) {
    cachedMonoRegularB64 = null
    for (const p of TTF_MONO_CANDIDATES) {
      try {
        if (fs.existsSync(p)) {
          cachedMonoRegularB64 = fs.readFileSync(p).toString('base64')
          break
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (cachedMonoBoldB64 === undefined) {
    cachedMonoBoldB64 = null
    for (const p of TTF_MONO_BOLD_CANDIDATES) {
      try {
        if (fs.existsSync(p)) {
          cachedMonoBoldB64 = fs.readFileSync(p).toString('base64')
          break
        }
      } catch {
        /* ignore */
      }
    }
  }
  return {
    regularB64: cachedMonoRegularB64,
    boldB64: cachedMonoBoldB64 || cachedMonoRegularB64,
  }
}

/**
 * Ensures text is 100% Unicode-safe for jsPDF across both embedded TTF and standard PDF fonts
 * so Hinglish, timecodes, arrows, bullets, and special symbols never break or garble.
 */
export function sanitizePdfText(input: string | null | undefined): string {
  if (!input) return ''
  return String(input)
    .replace(/[\u2013\u2014\u2212]/g, '-') // en-dash, em-dash, minus -> hyphen
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00B7\u2022\u2219]/g, '|') // middle dot / bullet -> |
    .replace(/[\u2192\u27F6\u2794]/g, '->') // arrows -> ->
    .replace(/\u23CE/g, '\n  ') // return symbol ⏎ -> newline indent for ChromeLogLast30
    .replace(/\u00D7/g, 'x') // multiplication sign -> x
    .replace(/\u00B1/g, '+/-') // plus-minus -> +/-
    .replace(/\u2713|\u2714/g, '[OK]')
    .replace(/\u2717|\u2718/g, '[X]')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, (ch) => {
      // Transliterate or hex-escape any non-Latin-1 codepoints if no Unicode glyph exists
      const code = ch.codePointAt(0) || 0
      if (code >= 0x0900 && code <= 0x097f) {
        return ch // kept if TTF supports it, or safe fallback below
      }
      return ' '
    })
}

export function formatTimeHhMmSsMmm(epochMs: number | null | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '--:--:--.---'
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const mmm = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${mmm}`
}

export function formatTimeHhMmSs(epochMs: number | null | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '--:--:--'
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function formatElapsedPlusMmSs(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `+${mm}:${ss}`
}

function isErrorRetry403OrStateChange(entry: ParallelCombinedLogEntry): boolean {
  if (
    entry.level === 'ERROR' ||
    entry.level === 'RETRY' ||
    entry.level === '403' ||
    entry.level === 'STOPPED'
  ) {
    return true
  }
  const s = `${entry.step} ${entry.message}`.toLowerCase()
  return (
    s.includes('window done') ||
    s.includes('window failed') ||
    s.includes('window stopped') ||
    s.includes('window split') ||
    s.includes('hard reset') ||
    s.includes('browser restart') ||
    s.includes('403') ||
    s.includes('permission_denied') ||
    s.includes('parallel scan start') ||
    s.includes('parallel scan finished') ||
    s.includes('media verified') ||
    s.includes('compress 360p') ||
    s.includes('waiting for worker') ||
    s.includes('waiting for upload gate') ||
    s.includes('waiting for ram') ||
    s.includes('attach_movie mem') ||
    s.includes('target crashed') ||
    s.includes('error [crash]')
  )
}

/**
 * Filter logs for `mode=errors`: keeps every error/retry/403/state-change line
 * PLUS ±2 surrounding context lines before and after each matched line.
 */
export function filterLogsWithContextForErrorsMode(
  allLogs: ParallelCombinedLogEntry[],
  contextRadius = 2,
): ParallelCombinedLogEntry[] {
  if (allLogs.length === 0) return []
  const keepIndices = new Set<number>()
  for (let i = 0; i < allLogs.length; i++) {
    if (isErrorRetry403OrStateChange(allLogs[i])) {
      const start = Math.max(0, i - contextRadius)
      const end = Math.min(allLogs.length - 1, i + contextRadius)
      for (let j = start; j <= end; j++) {
        keepIndices.add(j)
      }
    }
  }
  const sortedIdx = Array.from(keepIndices).sort((a, b) => a - b)
  return sortedIdx.map((idx) => allLogs[idx])
}

function formatChromeProcsPerWorkerSummary(
  perWorker: Record<string, number> | undefined,
  total: number,
): string {
  if (!perWorker || Object.keys(perWorker).length === 0) {
    return `Total: ${total}`
  }
  const keys = Object.keys(perWorker).sort()
  const parts = keys.map((k) => `${k}:${perWorker[k] ?? 0}`)
  return `${parts.join(' ')} | Total: ${total}`
}

export async function buildParallelScanPdfBuffer(params: {
  scanId: string
  mode: ParallelPdfMode
  runScope?: ParallelPdfRunScope
}): Promise<{ buffer: Buffer; filename: string }> {
  const { scanId, mode, runScope = 'latest' } = params
  const mgr = getStudioParallelManager(scanId)
  const snap = await mgr.getLiveSnapshot(false)
  const scan = scanId && scanId !== 'default' ? getScan(scanId) : null
  const rawAllDiskLogs = mgr.readAllCombinedLogsFromDisk()

  // Filter logs & resource snapshots to the latest run by default (unless runScope === 'all')
  let activeRunIdLabel = snap.currentRunId || 'latest'
  let allDiskLogs = rawAllDiskLogs
  let filteredResourceSnapshots = snap.resourceSnapshots || []

  if (runScope === 'latest' && rawAllDiskLogs.length > 0) {
    // Find latest runId present in logs or fallback to last 'parallel scan start' boundary
    let targetRunId: string | null = snap.currentRunId || null
    if (!targetRunId) {
      for (let i = rawAllDiskLogs.length - 1; i >= 0; i--) {
        if (rawAllDiskLogs[i].runId) {
          targetRunId = rawAllDiskLogs[i].runId || null
          break
        }
      }
    }

    if (targetRunId && rawAllDiskLogs.some((e) => e.runId === targetRunId)) {
      activeRunIdLabel = targetRunId
      allDiskLogs = rawAllDiskLogs.filter((e) => e.runId === targetRunId)
      if (filteredResourceSnapshots.some((r) => r.runId === targetRunId)) {
        filteredResourceSnapshots = filteredResourceSnapshots.filter(
          (r) => r.runId === targetRunId,
        )
      } else if (allDiskLogs.length > 0) {
        const minT = allDiskLogs[0].t - 5000
        filteredResourceSnapshots = filteredResourceSnapshots.filter((r) => r.t >= minT)
      }
    } else {
      // Legacy fallback: slice from the last 'parallel scan start' (including 'media verified' immediately before it)
      let lastStartIdx = -1
      for (let i = rawAllDiskLogs.length - 1; i >= 0; i--) {
        const st = (rawAllDiskLogs[i].step || '').toLowerCase()
        if (st === 'parallel scan start') {
          lastStartIdx = i
          break
        }
      }
      if (lastStartIdx > 0) {
        const startT = rawAllDiskLogs[lastStartIdx].t
        while (
          lastStartIdx > 0 &&
          startT - rawAllDiskLogs[lastStartIdx - 1].t <= 30_000 &&
          /media verified|compress 360p/i.test(rawAllDiskLogs[lastStartIdx - 1].step || '')
        ) {
          lastStartIdx -= 1
        }
        allDiskLogs = rawAllDiskLogs.slice(lastStartIdx)
        activeRunIdLabel = `run@${formatTimeHhMmSs(rawAllDiskLogs[lastStartIdx].t)}`
        const minT = rawAllDiskLogs[lastStartIdx].t - 5000
        filteredResourceSnapshots = filteredResourceSnapshots.filter((r) => r.t >= minT)
      }
    }
  } else if (runScope === 'all') {
    activeRunIdLabel = `ALL RUNS (${rawAllDiskLogs.length} lines)`
  }

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  })

  // Embed TrueType Unicode Monospace font if present on system
  let monoFontName = 'courier'
  const embedded = getEmbeddedMonoFonts()
  if (embedded.regularB64) {
    try {
      doc.addFileToVFS('LiberationMono-Regular.ttf', embedded.regularB64)
      doc.addFont('LiberationMono-Regular.ttf', 'LiberationMono', 'normal')
      if (embedded.boldB64) {
        doc.addFileToVFS('LiberationMono-Bold.ttf', embedded.boldB64)
        doc.addFont('LiberationMono-Bold.ttf', 'LiberationMono', 'bold')
      } else {
        doc.addFont('LiberationMono-Regular.ttf', 'LiberationMono', 'bold')
      }
      monoFontName = 'LiberationMono'
    } catch {
      monoFontName = 'courier'
    }
  }

  const pageWidth = doc.internal.pageSize.getWidth() // 210mm
  const pageHeight = doc.internal.pageSize.getHeight() // 297mm
  const marginLeft = 10
  const marginRight = 10
  const contentWidth = pageWidth - marginLeft - marginRight // 190mm
  const marginBottom = 15

  let y = 12

  const ensureSpace = (neededMm: number, sectionContinuationTitle?: string) => {
    if (y + neededMm <= pageHeight - marginBottom) return
    doc.addPage()
    y = 12
    if (sectionContinuationTitle) {
      doc.setFont(monoFontName, 'bold')
      doc.setFontSize(7.5)
      doc.setTextColor(100, 116, 139)
      doc.text(sanitizePdfText(`${sectionContinuationTitle} (continued)`), marginLeft, y)
      y += 5
    }
  }

  // ==========================================================================
  // SECTION (a): HEADER
  // Scan ID/Name, generate time, concurrency, total windows, app/Chrome version,
  // elapsed duration, Chrome procs per worker + total, AND exact verified media paths + sizes + durations
  // ==========================================================================
  doc.setFillColor(15, 23, 42)
  doc.roundedRect(marginLeft, y, contentWidth, 43, 2, 2, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(248, 250, 252)
  doc.text(
    sanitizePdfText(
      `PARALLEL WINDOW SCAN REPORT - ${mode === 'errors' ? 'ERRORS / RETRIES / 403 ONLY' : 'FULL COMBINED LOG'} (${runScope === 'all' ? 'ALL RUNS' : 'LATEST RUN'})`,
    ),
    marginLeft + 4,
    y + 7,
  )

  doc.setFont(monoFontName, 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(186, 230, 253)
  const scanDisplay = scan?.customName || scan?.movieName || snap.scanName || scanId
  doc.text(
    sanitizePdfText(
      `Scan ID: ${scanId}  |  Name: ${scanDisplay}  |  Run Scope: ${runScope.toUpperCase()} (${activeRunIdLabel})`,
    ),
    marginLeft + 4,
    y + 12.5,
  )

  doc.setTextColor(203, 213, 225)
  doc.text(
    sanitizePdfText(
      `Generated: ${new Date().toISOString()}  |  Elapsed: ${formatElapsedPlusMmSs(snap.elapsedSec)} (${snap.elapsedSec}s)  |  Concurrency: ${snap.concurrency} (${snap.slotPool.summaryText})`,
    ),
    marginLeft + 4,
    y + 17.5,
  )

  doc.text(
    sanitizePdfText(
      `Windows: ${snap.totalWindows} total (${snap.doneCount} DONE, ${snap.failedCount} FAILED/STOPPED, ${snap.queuedCount} QUEUED)  |  Env: ${getRuntimeChromeAndAppVersion()}`,
    ),
    marginLeft + 4,
    y + 22.5,
  )

  const chromePerWorkerHeader = formatChromeProcsPerWorkerSummary(
    snap.chromeProcsPerWorker,
    snap.chromeProcessCount ?? 0,
  )
  doc.setTextColor(253, 230, 138)
  doc.setFontSize(7.0)
  doc.text(
    sanitizePdfText(
      `Chrome Procs per Worker: ${chromePerWorkerHeader}  |  RAM: ${snap.ramUsedPercent}%  |  /dev/shm: ${snap.devShmUsedMb ?? 0} MB`,
    ),
    marginLeft + 4,
    y + 27.5,
  )

  const mi = snap.mediaInfo
  const shortLine = mi?.shortPath
    ? `Short: ${mi.shortPath}  (${mi.shortSizeBytes ? (mi.shortSizeBytes / (1024 * 1024)).toFixed(2) : '0'} MB, ${(mi.shortDurationSec || 0).toFixed(1)}s)`
    : `Short: data/media/${scanId}/short.mp4 (not verified yet)`
  const movieLine = mi?.movie360Path
    ? `Movie 360p: ${mi.movie360Path}  (${mi.movie360SizeBytes ? (mi.movie360SizeBytes / (1024 * 1024)).toFixed(2) : '0'} MB, ${(mi.movie360DurationSec || 0).toFixed(1)}s)`
    : `Movie 360p: data/media/${scanId}/movie_360p.mp4 (not verified yet)`

  doc.setTextColor(167, 243, 208)
  doc.setFontSize(7.0)
  doc.text(sanitizePdfText(shortLine), marginLeft + 4, y + 33)
  doc.text(sanitizePdfText(movieLine), marginLeft + 4, y + 38)

  y += 48

  // ==========================================================================
  // SECTION (b): SUMMARY TABLE OF EVERY WINDOW
  // window #, movie range, final state, worker, attempts, 403 retries, model used,
  // tokens, matches/notFound, start, end, duration, last error
  // ==========================================================================
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text(
    sanitizePdfText(`1. Window Execution Summary (${snap.windows.length} Windows)`),
    marginLeft,
    y,
  )
  y += 3.5

  const drawWindowTableHeader = () => {
    doc.setFillColor(226, 232, 240)
    doc.rect(marginLeft, y, contentWidth, 5.5, 'F')
    doc.setFont(monoFontName, 'bold')
    doc.setFontSize(6.5)
    doc.setTextColor(30, 41, 59)
    doc.text(
      sanitizePdfText(
        '#   Range         State       Wrk  Try  403  Model       Tokens   M/NF    Start     End       Dur   Last Error / Note',
      ),
      marginLeft + 1.5,
      y + 3.8,
    )
    y += 6.5
  }

  drawWindowTableHeader()

  for (let i = 0; i < snap.windows.length; i++) {
    const w: ParallelWindowState = snap.windows[i]
    const numStr = `#${w.windowNumber}`.padEnd(4, ' ')
    const rangeStr = `${w.startFormatted}-${w.endFormatted}`.padEnd(14, ' ')
    const stateStr = (w.status || 'QUEUED').slice(0, 11).padEnd(12, ' ')
    const wrkStr = (w.workerId || '--').padEnd(5, ' ')
    const tryStr = `${w.attempt || 0}/${w.maxAttempts || 5}`.padEnd(5, ' ')
    const permStr = `${w.permRetry || 0}/10`.padEnd(5, ' ')
    const modShort = (w.modelName || '3.8 Flash').replace(/^Gemini\s+/i, '').slice(0, 11).padEnd(12, ' ')
    const tokStr = (w.tokens ? `${Math.round(w.tokens / 1000)}K` : '--').padEnd(9, ' ')
    const mnfStr = `${w.matchCount || 0}/${w.notFoundCount ?? 0}`.padEnd(8, ' ')
    const startStr = (w.startedAt ? formatTimeHhMmSs(w.startedAt) : '--:--:--').padEnd(10, ' ')
    const endStr = (w.finishedAt ? formatTimeHhMmSs(w.finishedAt) : '--:--:--').padEnd(10, ' ')
    const durStr = `${w.elapsedSec || 0}s`.padEnd(6, ' ')
    const errNote = sanitizePdfText(w.error || w.summaryText || '')

    const prefixCols = `${numStr}${rangeStr}${stateStr}${wrkStr}${tryStr}${permStr}${modShort}${tokStr}${mnfStr}${startStr}${endStr}${durStr}`

    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(6.2)
    const noteLines: string[] = errNote
      ? doc.splitTextToSize(errNote, 42)
      : ['--']
    const rowH = Math.max(4.5, noteLines.length * 3.2 + 1.2)

    if (y + rowH > pageHeight - marginBottom) {
      doc.addPage()
      y = 12
      drawWindowTableHeader()
    }

    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252)
      doc.rect(marginLeft, y - 0.8, contentWidth, rowH, 'F')
    }

    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(6.2)
    if (w.status === 'FAILED' || w.status === 'NEEDS_ATTENTION') {
      doc.setTextColor(185, 28, 28)
    } else if (w.status === 'DONE') {
      doc.setTextColor(21, 128, 61)
    } else {
      doc.setTextColor(30, 41, 59)
    }

    doc.text(sanitizePdfText(prefixCols), marginLeft + 1.5, y + 2.5)
    let ny = y + 2.5
    for (const nl of noteLines) {
      doc.text(sanitizePdfText(nl), marginLeft + 146, ny)
      ny += 3.2
    }
    y += rowH
  }

  y += 5

  // ==========================================================================
  // SECTION (c): EVENTS TABLE (403 / Hard Reset / Browser Restart / Retry / Error / Stopped)
  // ==========================================================================
  const keyEvents = allDiskLogs.filter(
    (e) =>
      e.level === '403' ||
      e.level === 'RETRY' ||
      e.level === 'ERROR' ||
      e.level === 'STOPPED',
  )

  ensureSpace(18, '2. Critical Events (403 / Reset / Browser Restart / Retries / Errors)')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text(
    sanitizePdfText(
      `2. Critical Events: 403 / Hard Reset / Browser Restart / Retries / Errors (${keyEvents.length})`,
    ),
    marginLeft,
    y,
  )
  y += 3.5

  if (keyEvents.length === 0) {
    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7)
    doc.setTextColor(100, 116, 139)
    doc.text('No 403, retry, or error events recorded for this scan.', marginLeft + 2, y + 3)
    y += 8
  } else {
    doc.setFillColor(254, 242, 242)
    doc.rect(marginLeft, y, contentWidth, 5.2, 'F')
    doc.setFont(monoFontName, 'bold')
    doc.setFontSize(6.5)
    doc.setTextColor(153, 27, 27)
    doc.text(
      sanitizePdfText('Time          Elapsed  Wrk   Win #           Level    Reason / Action'),
      marginLeft + 1.5,
      y + 3.6,
    )
    y += 6

    const maxEventsToRender = Math.min(keyEvents.length, 600)
    for (let i = 0; i < maxEventsToRender; i++) {
      const ev = keyEvents[i]
      const timeCol = formatTimeHhMmSsMmm(ev.t).padEnd(14, ' ')
      const elCol = formatElapsedPlusMmSs(ev.elapsedSec).padEnd(9, ' ')
      const wrkCol = (ev.workerId || 'SYS').padEnd(6, ' ')
      const winCol = (
        ev.windowNumber !== null ? `#${ev.windowNumber} (${ev.windowRange || ''})` : '--'
      )
        .slice(0, 15)
        .padEnd(16, ' ')
      const lvlCol = ev.level.padEnd(9, ' ')
      const leftCols = `${timeCol}${elCol}${wrkCol}${winCol}${lvlCol}`

      doc.setFont(monoFontName, 'normal')
      doc.setFontSize(6.3)
      const reasonLines: string[] = doc.splitTextToSize(
        sanitizePdfText(ev.message),
        contentWidth - 68,
      )
      const rowH = Math.max(4.2, reasonLines.length * 3.1 + 1)

      ensureSpace(rowH + 2, '2. Critical Events')
      if (i % 2 === 1) {
        doc.setFillColor(250, 250, 250)
        doc.rect(marginLeft, y - 0.8, contentWidth, rowH, 'F')
      }

      doc.setFont(monoFontName, 'normal')
      doc.setFontSize(6.3)
      if (ev.level === 'ERROR') doc.setTextColor(185, 28, 28)
      else if (ev.level === '403' || ev.level === 'RETRY') doc.setTextColor(180, 83, 9)
      else doc.setTextColor(51, 65, 85)

      doc.text(sanitizePdfText(leftCols), marginLeft + 1.5, y + 2.4)
      let ry = y + 2.4
      for (const rl of reasonLines) {
        doc.text(sanitizePdfText(rl), marginLeft + 67, ry)
        ry += 3.1
      }
      y += rowH
    }
    y += 5
  }

  // ==========================================================================
  // SECTION (d): RESOURCE SNAPSHOTS (RAM %, Free Disk GB, Chrome Procs per Worker & Total, /dev/shm)
  // ==========================================================================
  const resSnaps = filteredResourceSnapshots
  ensureSpace(18, '3. System Resource Snapshots (RAM, Disk & Chrome Processes)')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text(
    sanitizePdfText(
      `3. Resource Snapshots (${resSnaps.length} samples @ 10s | Current RAM: ${snap.ramUsedPercent}%, /dev/shm: ${snap.devShmUsedMb ?? 0}MB, Chrome Procs Total: ${snap.chromeProcessCount ?? 0}, Free Disk: ${snap.freeDiskGb} GB)`,
    ),
    marginLeft,
    y,
  )
  y += 3.5

  doc.setFont(monoFontName, 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(30, 41, 59)
  doc.text(
    sanitizePdfText(`Current Chrome Procs per Worker: ${chromePerWorkerHeader}`),
    marginLeft + 1.5,
    y + 2.5,
  )
  y += 4.5

  if (resSnaps.length === 0) {
    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7)
    doc.setTextColor(100, 116, 139)
    doc.text(
      sanitizePdfText(
        `Live snapshot: RAM ${snap.ramUsedPercent}% used | Chrome Procs: ${chromePerWorkerHeader} | Free Disk ${snap.freeDiskGb} GB | ${snap.slotPool.summaryText}`,
      ),
      marginLeft + 2,
      y + 3,
    )
    y += 7
  } else {
    doc.setFillColor(241, 245, 249)
    doc.rect(marginLeft, y, contentWidth, 5, 'F')
    doc.setFont(monoFontName, 'bold')
    doc.setFontSize(6.3)
    doc.setTextColor(51, 65, 85)
    doc.text(
      sanitizePdfText(
        'Time       Elapsed  RAM   /dev/shm  Disk     ChromeTotal  Chrome Procs per Worker              Wrk  Slots  Note',
      ),
      marginLeft + 1.5,
      y + 3.5,
    )
    y += 5.8

    const displaySnaps = resSnaps.slice(-80)
    for (let i = 0; i < displaySnaps.length; i++) {
      const rs = displaySnaps[i]
      ensureSpace(4.5, '3. System Resource Snapshots')
      doc.setFont(monoFontName, 'normal')
      doc.setFontSize(6.1)
      doc.setTextColor(30, 41, 59)
      const chromeCnt = typeof rs.chromeProcessCount === 'number' ? String(rs.chromeProcessCount) : '--'
      const perWrkCompact = rs.chromeProcsPerWorker
        ? Object.keys(rs.chromeProcsPerWorker)
            .sort()
            .slice(0, 6)
            .map((k) => `${k}:${rs.chromeProcsPerWorker![k] ?? 0}`)
            .join(' ')
        : '--'
      const shmStr = typeof rs.devShmUsedMb === 'number' ? `${rs.devShmUsedMb}M` : '--'
      const rowStr = `${formatTimeHhMmSs(rs.t).padEnd(11, ' ')}${formatElapsedPlusMmSs(rs.elapsedSec).padEnd(9, ' ')}${`${rs.ramUsedPercent}%`.padEnd(6, ' ')}${shmStr.padEnd(10, ' ')}${`${rs.freeDiskGb}GB`.padEnd(9, ' ')}${chromeCnt.padEnd(13, ' ')}${perWrkCompact.padEnd(37, ' ')}${String(rs.activeWorkers).padEnd(5, ' ')}${`${rs.slotsInUse}/${rs.totalSlots}`.padEnd(7, ' ')}${rs.note || ''}`
      doc.text(sanitizePdfText(rowStr), marginLeft + 1.5, y + 2.5)
      y += 4
    }
    y += 5
  }

  // ==========================================================================
  // SECTION (e): COMBINED CHRONOLOGICAL LOG (7.2pt Monospace, Line Wrap)
  // Full file from parallel-log.jsonl (or filtered errors+retries+403 with ±2 context lines)
  // ==========================================================================
  const logsToRenderRaw =
    mode === 'errors' ? filterLogsWithContextForErrorsMode(allDiskLogs, 2) : allDiskLogs

  // Cap at 18,000 lines in PDF to keep PDF file size safely under ~10-20 MB
  const MAX_PDF_LOG_LINES = 18_000
  const truncatedCount = Math.max(0, logsToRenderRaw.length - MAX_PDF_LOG_LINES)
  const logsToRender =
    truncatedCount > 0 ? logsToRenderRaw.slice(-MAX_PDF_LOG_LINES) : logsToRenderRaw

  ensureSpace(16, '4. Combined Worker Chronological Logs')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text(
    sanitizePdfText(
      `4. Combined Chronological Logs (${logsToRender.length} lines rendered from ${allDiskLogs.length} run lines [${rawAllDiskLogs.length} total disk lines] | mode=${mode} | scope=${runScope})`,
    ),
    marginLeft,
    y,
  )
  y += 4

  if (truncatedCount > 0) {
    doc.setFont(monoFontName, 'bold')
    doc.setFontSize(6.8)
    doc.setTextColor(180, 83, 9)
    doc.text(
      sanitizePdfText(
        `[Note: Showing most recent ${MAX_PDF_LOG_LINES} lines (${truncatedCount} older lines omitted to keep PDF size < 15 MB)]`,
      ),
      marginLeft,
      y + 2.5,
    )
    y += 5
  }

  doc.setFillColor(241, 245, 249)
  doc.rect(marginLeft, y, contentWidth, 5, 'F')
  doc.setFont(monoFontName, 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(51, 65, 85)
  doc.text(
    sanitizePdfText('HH:MM:SS.mmm  +mm:ss  [Wrk][Scan]  #Win (Range)      [LEVEL]   Message'),
    marginLeft + 1.5,
    y + 3.5,
  )
  y += 6

  for (let i = 0; i < logsToRender.length; i++) {
    const entry = logsToRender[i]
    const ts = formatTimeHhMmSsMmm(entry.t)
    const el = formatElapsedPlusMmSs(entry.elapsedSec)
    const wrk = `[${entry.workerId || 'SYS'}]`
    const winTag =
      entry.windowNumber !== null
        ? `#${entry.windowNumber}(${entry.windowRange || ''})`
        : '---'
    const lvlTag = `[${entry.level}]`
    const fullLine = sanitizePdfText(
      `${ts} ${el} ${wrk} ${winTag.padEnd(15, ' ')} ${lvlTag.padEnd(9, ' ')} ${entry.message}`,
    )

    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7)
    const wrapped: string[] = doc.splitTextToSize(fullLine, contentWidth - 3)
    const lineH = 3.2
    const blockH = wrapped.length * lineH + 0.6

    ensureSpace(blockH + 1, '4. Combined Worker Chronological Logs')

    if (entry.level === 'ERROR') {
      doc.setTextColor(185, 28, 28)
    } else if (entry.level === '403') {
      doc.setTextColor(194, 65, 12)
    } else if (entry.level === 'RETRY') {
      doc.setTextColor(180, 83, 9)
    } else if (entry.level === 'SUCCESS') {
      doc.setTextColor(21, 128, 61)
    } else if (entry.level === 'STOPPED') {
      doc.setTextColor(100, 116, 139)
    } else {
      doc.setTextColor(30, 41, 59)
    }

    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7)
    for (const wl of wrapped) {
      doc.text(wl, marginLeft + 1.5, y + 2.4)
      y += lineH
    }
    y += 0.6
  }

  y += 6

  // ==========================================================================
  // SECTION (f): FINAL MERGED RESULT (HISSA 1 + HISSA 2 MAP)
  // ==========================================================================
  ensureSpace(20, '5. Final Merged Result (HISSA 1 + HISSA 2 Map)')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(15, 23, 42)
  doc.text('5. Final Merged Result (HISSA 1 + HISSA 2 Map)', marginLeft, y)
  y += 4

  const mergedTxt =
    snap.mergedReport?.formattedTxt || 'No merged result available yet (no completed windows).'
  const rawMergedLines = sanitizePdfText(mergedTxt).split('\n')

  doc.setFont(monoFontName, 'normal')
  doc.setFontSize(7.2)
  doc.setTextColor(15, 23, 42)

  for (const rLine of rawMergedLines) {
    const wrapped: string[] = doc.splitTextToSize(rLine || ' ', contentWidth - 4)
    const blockH = wrapped.length * 3.4 + 0.5
    ensureSpace(blockH + 1, '5. Final Merged Result (HISSA Map)')
    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7.2)
    doc.setTextColor(15, 23, 42)
    for (const wl of wrapped) {
      doc.text(wl, marginLeft + 2, y + 2.5)
      y += 3.4
    }
  }

  // ==========================================================================
  // FOOTER WITH PAGE NUMBERS ON ALL PAGES
  // ==========================================================================
  const totalPages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setDrawColor(203, 213, 225)
    doc.setLineWidth(0.25)
    doc.line(marginLeft, pageHeight - 10, pageWidth - marginRight, pageHeight - 10)

    doc.setFont(monoFontName, 'normal')
    doc.setFontSize(7)
    doc.setTextColor(100, 116, 139)
    doc.text(
      sanitizePdfText(
        `Parallel Scan Log | Scan: ${scanDisplay} (${scanId}) | Mode: ${mode.toUpperCase()} | Scope: ${runScope.toUpperCase()}`,
      ),
      marginLeft,
      pageHeight - 6,
    )
    doc.text(
      sanitizePdfText(`Page ${p} of ${totalPages}`),
      pageWidth - marginRight,
      pageHeight - 6,
      { align: 'right' },
    )
  }

  const arrayBuf = doc.output('arraybuffer')
  const buffer = Buffer.from(arrayBuf)
  const safeId = (scanId || 'scan').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const scopeSuffix = runScope === 'all' ? '-allruns' : ''
  const filename = `parallel-log-${safeId}-${mode}${scopeSuffix}-${ts}.pdf`

  return { buffer, filename }
}
