'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  SkipForward,
  AlertTriangle,
  Layers,
  Copy,
  Download,
  Maximize2,
  X,
  Cpu,
  HardDrive,
  FileText,
  FileCode,
  Sparkles,
  Terminal,
  Filter,
  FileDown,
  CheckCircle2,
} from 'lucide-react'
import type {
  ParallelCombinedLogEntry,
  ParallelLogLevel,
  ParallelScanLiveSnapshot,
  ParallelWindowState,
  ParallelWindowStatus,
  ParallelWorkerCardSnapshot,
} from '@/lib/studio-parallel-manager'
import {
  buildParallelWindowsFromMinuteInput,
  formatParallelTimecode,
  parseMinuteInputToContiguousRuns,
  type ParallelWindowSpec,
} from '@/lib/studio-window-planner'
import type { Scan } from '@/lib/types'

const LEGACY_GLOBAL_DEFAULT_MINUTES =
  '7,8,9,10,14,15,16,17,19,20,21,25-41,48-54,56,57,58,63-67,71-100'

interface StudioParallelGridProps {
  scan?: Scan | null
  parallelSnapshot: ParallelScanLiveSnapshot | null
  scanId?: string | null
  scanTitle?: string | null
  scanMinuteInput?: string | null
  scanMinuteInputSource?: 'auto' | 'manual' | null
  scanMovieDuration?: number | null
  scanConcurrency?: number | null
  onActionCompleted?: (nextParallel: ParallelScanLiveSnapshot) => void
}

function formatCompactMinutesClient(
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

function extractScanFoundMinutesClient(
  scan?: Scan | null,
  movieDurationSec?: number | null,
): string {
  if (!scan) return ''
  const prescan = scan.geminiPrescan
  let raw: number[] = []
  if (prescan?.appliedMinutes && prescan.appliedMinutes.length > 0) {
    raw = [...prescan.appliedMinutes]
  } else if (prescan?.minuteSuggestions && prescan.minuteSuggestions.length > 0) {
    raw = prescan.minuteSuggestions.map((s) => s.minute)
  } else if (scan.mergePipeline?.approvedMinutes && scan.mergePipeline.approvedMinutes.length > 0) {
    raw = [...scan.mergePipeline.approvedMinutes]
  } else if (
    scan.mergePipeline?.minuteSuggestions &&
    scan.mergePipeline.minuteSuggestions.length > 0
  ) {
    raw = scan.mergePipeline.minuteSuggestions.map((s) => s.minute)
  } else {
    raw = (scan.shortSegments || [])
      .filter((s) => s.selected !== false && Array.isArray(s.movieMinutes) && s.movieMinutes.length > 0)
      .flatMap((s) => s.movieMinutes!)
  }
  return formatCompactMinutesClient(raw, movieDurationSec)
}

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function formatPlusMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `+${mm}:${ss}`
}

function formatHhMmSsMmm(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const mmm = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${mmm}`
}

function statusBadgeStyle(status: ParallelWindowStatus | 'IDLE'): string {
  switch (status) {
    case 'DONE':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
    case 'RUNNING':
    case 'VALIDATING':
      return 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
    case 'SETUP':
    case 'ASSIGNED':
      return 'border-blue-500/40 bg-blue-500/15 text-blue-300'
    case '403_WAIT':
    case 'RETRYING':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-300'
    case 'WAITING_FOR_WORKER':
    case 'WAITING_FOR_UPLOAD_GATE':
    case 'WAITING_FOR_RAM':
      return 'border-purple-500/40 bg-purple-500/15 text-purple-300'
    case 'NEEDS_ATTENTION':
      return 'border-rose-500/60 bg-rose-500/20 text-rose-200 animate-pulse'
    case 'PROHIBITED':
      return 'border-orange-500/50 bg-orange-500/20 text-orange-300'
    case 'FAILED':
      return 'border-red-500/40 bg-red-500/15 text-red-300'
    case 'STOPPED':
    case 'SKIPPED':
      return 'border-zinc-600/50 bg-zinc-800/60 text-zinc-400'
    case 'QUEUED':
    case 'IDLE':
    default:
      return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400'
  }
}

function logLevelBadgeStyle(level: ParallelLogLevel): string {
  switch (level) {
    case 'SUCCESS':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
    case '403':
      return 'border-orange-500/50 bg-orange-500/20 text-orange-300'
    case 'RETRY':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-300'
    case 'ERROR':
      return 'border-red-500/50 bg-red-500/20 text-red-300'
    case 'STOPPED':
      return 'border-zinc-500/40 bg-zinc-700/40 text-zinc-300'
    case 'INFO':
    default:
      return 'border-sky-500/30 bg-sky-500/10 text-sky-300'
  }
}

function shortModelBadge(modelName: string): string {
  if (/3\.8/i.test(modelName)) return '3.8 Flash'
  if (/3\.7/i.test(modelName)) return '3.7 Flash'
  if (/3\.6/i.test(modelName)) return '3.6 Flash'
  return modelName || '3.8 Flash'
}

export function StudioParallelGrid({
  scan,
  parallelSnapshot,
  scanId,
  scanTitle,
  scanMinuteInput,
  scanMinuteInputSource,
  scanMovieDuration,
  scanConcurrency,
  onActionCompleted,
}: StudioParallelGridProps) {
  // Strictly bind snapshot to THIS scanId so another scan's Resume/Retry counts never leak
  const snap = useMemo(() => {
    if (!parallelSnapshot || !scanId) return null
    return parallelSnapshot.scanId === scanId ? parallelSnapshot : null
  }, [parallelSnapshot, scanId])

  const effectiveMovieDurationSec = useMemo(() => {
    if (typeof scanMovieDuration === 'number' && scanMovieDuration > 0) return scanMovieDuration
    if (typeof scan?.movieDuration === 'number' && scan.movieDuration > 0) return scan.movieDuration
    if (typeof scan?.movieTrimEnd === 'number' && scan.movieTrimEnd > 0) return scan.movieTrimEnd
    if (
      scan?.geminiPrescan?.movieCopy?.trimEnd &&
      scan.geminiPrescan.movieCopy.trimEnd > 0
    ) {
      return scan.geminiPrescan.movieCopy.trimEnd
    }
    if (
      typeof snap?.movieDurationSec === 'number' &&
      snap.movieDurationSec > 0
    ) {
      return snap.movieDurationSec
    }
    return null
  }, [scanMovieDuration, scan, snap?.movieDurationSec])

  const effectiveFoundMinutes = useMemo(() => {
    const fromScan = extractScanFoundMinutesClient(scan, effectiveMovieDurationSec)
    if (fromScan) return fromScan
    if (snap?.foundMinutesInput) return snap.foundMinutesInput
    return ''
  }, [scan, effectiveMovieDurationSec, snap?.foundMinutesInput])

  const initialSource: 'auto' | 'manual' =
    snap?.minuteInputSource === 'manual' || scanMinuteInputSource === 'manual'
      ? 'manual'
      : 'auto'

  const resolveInitialMinutes = (): string => {
    if (initialSource === 'manual') {
      const manualVal = (snap?.minuteInput || scanMinuteInput || '').trim()
      if (manualVal) return manualVal
    }
    return effectiveFoundMinutes
  }

  const [minuteInputSource, setMinuteInputSource] = useState<'auto' | 'manual'>(initialSource)
  const [minuteInput, setMinuteInput] = useState<string>(resolveInitialMinutes)
  const [concurrency, setConcurrency] = useState<number>(
    snap?.concurrency || scanConcurrency || 4,
  )
  const [confirmClearStateOpen, setConfirmClearStateOpen] = useState<boolean>(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)
  const [reportTab, setReportTab] = useState<'txt' | 'json'>('txt')
  const [copiedReport, setCopiedReport] = useState(false)

  // Combined Log panel filters & auto-scroll state
  const [workerFilter, setWorkerFilter] = useState<string>('ALL')
  const [levelFilter, setLevelFilter] = useState<string>('ALL')
  const [onlyErrorsRetries403, setOnlyErrorsRetries403] = useState<boolean>(false)
  const [autoScrollLogs, setAutoScrollLogs] = useState<boolean>(true)
  const [pdfRunScope, setPdfRunScope] = useState<'latest' | 'all'>('latest')
  const [downloadingPdfMode, setDownloadingPdfMode] = useState<'full' | 'errors' | null>(null)
  const logContainerRef = useRef<HTMLDivElement | null>(null)

  const syncedScanIdRef = useRef<string | null>(null)

  // Sync per-scan minuteInput & concurrency when scanId changes
  useEffect(() => {
    const currentId = scanId || null
    if (syncedScanIdRef.current !== currentId) {
      syncedScanIdRef.current = currentId
      const nextSource: 'auto' | 'manual' =
        snap?.minuteInputSource === 'manual' || scanMinuteInputSource === 'manual'
          ? 'manual'
          : 'auto'
      setMinuteInputSource(nextSource)
      if (nextSource === 'manual') {
        const manualVal = (snap?.minuteInput || scanMinuteInput || '').trim()
        setMinuteInput(
          manualVal && manualVal !== LEGACY_GLOBAL_DEFAULT_MINUTES
            ? manualVal
            : effectiveFoundMinutes,
        )
      } else {
        setMinuteInput(effectiveFoundMinutes)
      }
      setConcurrency(snap?.concurrency || scanConcurrency || 4)
      setConfirmClearStateOpen(false)
      setSelectedWorkerId(null)
      setErrorMsg(null)
    }
  }, [
    scanId,
    scanMinuteInput,
    scanMinuteInputSource,
    scanConcurrency,
    snap,
    effectiveFoundMinutes,
  ])

  // Auto-update minuteInput whenever scan's "Minutes found" changes AND source is 'auto'
  useEffect(() => {
    if (minuteInputSource === 'auto') {
      setMinuteInput(effectiveFoundMinutes)
    }
  }, [effectiveFoundMinutes, minuteInputSource])

  const postParallelControl = async (payload: Record<string, unknown>, label: string) => {
    if (!scanId) {
      setErrorMsg('Please select or create a scan first to run Parallel Window Scan.')
      return
    }
    setBusyAction(label)
    setErrorMsg(null)
    try {
      const res = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          ...payload,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error || `Failed: ${label}`)
      } else if (data.parallelSnapshot) {
        onActionCompleted?.(data.parallelSnapshot as ParallelScanLiveSnapshot)
      }
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setBusyAction(null)
    }
  }

  const activeCount = snap?.activeWorkersCount ?? 0
  const maxConcurrency = snap?.concurrency ?? concurrency
  const doneCount = snap?.doneCount ?? 0
  const totalWindows = snap?.totalWindows ?? 0
  const queuedCount = snap?.queuedCount ?? 0
  const failedCount = snap?.failedCount ?? 0
  const needsAttentionCount = snap?.needsAttentionCount ?? 0
  const elapsedSec = snap?.elapsedSec ?? 0
  const workers = snap?.workers ?? []
  const windows = snap?.windows ?? []
  const prohibitedWindows = useMemo(
    () => windows.filter((w) => w.status === 'PROHIBITED'),
    [windows],
  )
  const prohibitedCount = snap?.prohibitedCount ?? prohibitedWindows.length
  const clipsReady = snap?.clipsReady ?? 0
  const clipsTotal = snap?.clipsTotal ?? 0
  const clipsExtracting = Boolean(snap?.clipsExtracting)
  const mergedReport = snap?.mergedReport ?? null
  const slotPool = snap?.slotPool ?? null
  const combinedLogs = snap?.combinedLogs ?? []
  const totalLogLinesOnDisk = snap?.totalLogLinesOnDisk ?? combinedLogs.length
  const isRunningOrStarting = Boolean(snap?.active || snap?.starting)
  const hasResumableState = Boolean(snap?.hasResumableState)
  const compressing360p = snap?.compressing360p ?? null
  const mediaInfo = snap?.mediaInfo ?? null

  const selectedWorker: ParallelWorkerCardSnapshot | null =
    selectedWorkerId ? workers.find((w) => w.workerId === selectedWorkerId) || null : null

  // Live preview of windows from the current minuteInput + movie length validation
  const previewValidation = useMemo(() => {
    const trimmed = (minuteInput || '').trim()
    if (!trimmed) {
      return {
        previewWindows: [] as ParallelWindowSpec[],
        unclampedMaxEndSec: 0,
        exceededInputCount: 0,
        savedWindowsOutOfBounds: [] as ParallelWindowState[],
      }
    }
    const rawRuns = parseMinuteInputToContiguousRuns(trimmed)
    const unclampedMaxEndSec = rawRuns.reduce((max, r) => Math.max(max, r.endSec), 0)
    const maxDurFloor =
      effectiveMovieDurationSec && effectiveMovieDurationSec > 0
        ? Math.floor(effectiveMovieDurationSec)
        : null
    const exceededInputCount =
      maxDurFloor !== null
        ? rawRuns.filter((r) => r.endSec > maxDurFloor || r.startSec >= maxDurFloor).length
        : 0

    let previewWindows: ParallelWindowSpec[] = []
    try {
      const built = buildParallelWindowsFromMinuteInput(
        trimmed,
        maxDurFloor !== null ? maxDurFloor : undefined,
      )
      previewWindows = built.windows
    } catch {
      previewWindows = []
    }

    const savedWindowsOutOfBounds =
      maxDurFloor !== null
        ? windows.filter((w) => w.endSec > maxDurFloor || w.startSec >= maxDurFloor)
        : []

    return {
      previewWindows,
      unclampedMaxEndSec,
      exceededInputCount,
      savedWindowsOutOfBounds,
    }
  }, [minuteInput, effectiveMovieDurationSec, windows])

  const handleBuildPreviewClick = () => {
    if (!minuteInput.trim()) {
      setErrorMsg('Pehle window scan poora chalao (Minutes found khali hai)')
      return
    }
    const savedMinuteStr = (snap?.minuteInput || '').trim()
    const hasExistingState =
      windows.length > 0 &&
      (savedMinuteStr !== minuteInput.trim() ||
        doneCount > 0 ||
        failedCount > 0 ||
        prohibitedCount > 0 ||
        needsAttentionCount > 0)

    if (hasExistingState) {
      setConfirmClearStateOpen(true)
      return
    }

    void postParallelControl(
      {
        action: 'save_parallel_config',
        minuteInput: minuteInput.trim(),
        minuteInputSource,
        concurrency,
      },
      'save_config',
    )
  }

  const handleConfirmRebuildWindows = () => {
    setConfirmClearStateOpen(false)
    void postParallelControl(
      {
        action: 'save_parallel_config',
        minuteInput: minuteInput.trim(),
        minuteInputSource,
        concurrency,
      },
      'save_config',
    )
  }

  const handleResetToMinutesFound = () => {
    setMinuteInputSource('auto')
    setMinuteInput(effectiveFoundMinutes)
    setConfirmClearStateOpen(false)
    if (scanId) {
      void postParallelControl({ action: 'reset_parallel_minutes' }, 'reset_minutes')
    }
  }

  const filteredCombinedLogs = useMemo(() => {
    return combinedLogs
      .filter((entry: ParallelCombinedLogEntry) => {
        if (workerFilter !== 'ALL' && entry.workerId !== workerFilter) return false
        if (onlyErrorsRetries403) {
          if (entry.level !== 'ERROR' && entry.level !== 'RETRY' && entry.level !== '403') {
            return false
          }
        } else if (levelFilter !== 'ALL' && entry.level !== levelFilter) {
          return false
        }
        return true
      })
      .slice(-2000)
  }, [combinedLogs, workerFilter, levelFilter, onlyErrorsRetries403])

  useEffect(() => {
    if (!autoScrollLogs || !logContainerRef.current) return
    const el = logContainerRef.current
    el.scrollTop = el.scrollHeight
  }, [filteredCombinedLogs.length, autoScrollLogs])

  const handleCopyReport = async () => {
    if (!mergedReport) return
    const content =
      reportTab === 'txt' ? mergedReport.formattedTxt : JSON.stringify(mergedReport, null, 2)
    try {
      await navigator.clipboard.writeText(content)
      setCopiedReport(true)
      setTimeout(() => setCopiedReport(false), 2000)
    } catch {
      /* ignore */
    }
  }

  const handleDownloadReport = (ext: 'txt' | 'json') => {
    if (!mergedReport) return
    const content =
      ext === 'txt' ? mergedReport.formattedTxt : JSON.stringify(mergedReport, null, 2)
    const blob = new Blob([content], {
      type: ext === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `parallel-window-scan-${scanId || 'scan'}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const handleDownloadPdf = async (mode: 'full' | 'errors') => {
    if (!scanId) {
      setErrorMsg('Select a scan first to download its parallel log PDF.')
      return
    }
    setDownloadingPdfMode(mode)
    setErrorMsg(null)
    try {
      const url = `/api/studio/parallel/log-pdf?scanId=${encodeURIComponent(scanId)}&mode=${mode}&runScope=${pdfRunScope}`
      const res = await fetch(url)
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `PDF download failed (HTTP ${res.status})`)
      }
      const blob = await res.blob()
      const dlUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = dlUrl
      const disp = res.headers.get('Content-Disposition') || ''
      const match = disp.match(/filename="([^"]+)"/)
      a.download = match ? match[1] : `parallel-log-${scanId}-${mode}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(dlUrl)
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setDownloadingPdfMode(null)
    }
  }

  const workerFilterOptions = useMemo(() => {
    const set = new Set<string>(['SYS'])
    for (let i = 1; i <= 10; i++) {
      set.add(`W${String(i).padStart(2, '0')}`)
    }
    for (const w of workers) {
      set.add(w.workerId)
    }
    for (const l of combinedLogs) {
      if (l.workerId) set.add(l.workerId)
    }
    return Array.from(set)
  }, [workers, combinedLogs])

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/95 overflow-hidden">
      {/* Top Summary Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold tracking-wide text-zinc-100 uppercase">
              Parallel Window Scan
            </span>
            {scanId ? (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300">
                {scanTitle ? `${scanTitle} (#${scanId.slice(0, 6)})` : `Scan #${scanId.slice(0, 8)}`}
              </span>
            ) : (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300">
                No scan selected
              </span>
            )}
          </div>

          <span className="text-[11px] font-mono px-2.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-200">
            Active:{' '}
            <strong className="text-cyan-400">
              {activeCount}/{maxConcurrency}
            </strong>{' '}
            · Done:{' '}
            <strong className="text-emerald-400">
              {doneCount}/{totalWindows}
            </strong>{' '}
            · Queued: <strong className="text-amber-300">{queuedCount}</strong> · Failed:{' '}
            <strong className={failedCount > 0 ? 'text-red-400' : 'text-zinc-400'}>
              {failedCount}
            </strong>{' '}
            · Prohibited:{' '}
            <strong className={prohibitedCount > 0 ? 'text-orange-400' : 'text-zinc-400'}>
              {prohibitedCount}
            </strong>{' '}
            · Elapsed: <strong className="text-zinc-200">{formatMmSs(elapsedSec)}</strong>
          </span>

          {/* Global Profile Slot Pool Telemetry Badge */}
          {slotPool && (
            <span
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950/50 border border-purple-500/30 text-purple-200"
              title="Global Chrome profile slot pool shared safely across all scans"
            >
              {slotPool.summaryText}
            </span>
          )}

          {snap?.waitingForWorkerSlots && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-500/20 text-purple-200 border border-purple-500/40 animate-pulse">
              WAITING FOR WORKER
            </span>
          )}

          {needsAttentionCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse">
              <AlertTriangle className="w-3 h-3" />
              NEEDS ATTENTION: {needsAttentionCount}
            </span>
          )}

          {snap && (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-zinc-400">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                <Cpu className="w-3 h-3 text-zinc-500" />
                RAM {snap.ramUsedPercent}%
              </span>
              {typeof snap.devShmUsedMb === 'number' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                  /dev/shm {snap.devShmUsedMb} MB
                </span>
              )}
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                <HardDrive className="w-3 h-3 text-zinc-500" />
                Disk {snap.freeDiskGb} GB
              </span>
              {typeof snap.chromeProcessCount === 'number' && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-200"
                  title="Chrome processes per worker profile and total across the system (0 when scan finishes)"
                >
                  Chrome procs per worker:{' '}
                  {snap.chromeProcsPerWorker
                    ? Object.keys(snap.chromeProcsPerWorker)
                        .sort()
                        .slice(0, Math.max(maxConcurrency, 6))
                        .map((k) => `${k}:${snap.chromeProcsPerWorker[k] ?? 0}`)
                        .join(' ')
                    : '—'}{' '}
                  | Total: <strong className="text-cyan-300">{snap.chromeProcessCount}</strong>
                </span>
              )}
              {snap.measuredTokenRate && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-300">
                  <Sparkles className="w-3 h-3" />
                  {snap.measuredTokenRate} tok/s
                </span>
              )}
            </div>
          )}
        </div>

        {/* Scan-scoped Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {!isRunningOrStarting ? (
            <>
              <button
                type="button"
                disabled={
                  busyAction !== null ||
                  Boolean(compressing360p?.active) ||
                  !scanId ||
                  !minuteInput.trim()
                }
                onClick={() =>
                  postParallelControl(
                    {
                      action: 'start_parallel_scan',
                      minuteInput: minuteInput.trim(),
                      minuteInputSource,
                      concurrency,
                      resumeExisting: false,
                    },
                    'start_parallel',
                  )
                }
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50"
              >
                <Play className="w-3 h-3" />
                {busyAction === 'start_parallel'
                  ? 'Starting...'
                  : compressing360p?.active
                    ? compressing360p.statusText || 'Compressing movie 360p...'
                    : 'Start Parallel Scan'}
              </button>

              {hasResumableState && totalWindows > 0 && doneCount < totalWindows && (
                <button
                  type="button"
                  disabled={
                    busyAction !== null ||
                    Boolean(compressing360p?.active) ||
                    !scanId ||
                    !minuteInput.trim()
                  }
                  onClick={() =>
                    postParallelControl(
                      {
                        action: 'start_parallel_scan',
                        minuteInput: minuteInput.trim(),
                        minuteInputSource,
                        concurrency,
                        resumeExisting: true,
                      },
                      'resume_existing',
                    )
                  }
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                  title="Resume THIS scan from its data/scans/<scanId>/parallel-state.json without re-running DONE windows"
                >
                  <Play className="w-3 h-3" />
                  Resume ({doneCount}/{totalWindows} done)
                </button>
              )}
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2.5 py-1 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                {compressing360p?.active
                  ? compressing360p.statusText
                  : snap?.starting
                    ? 'Verifying 360p media...'
                    : 'Parallel Scan Running'}
              </span>

              {snap?.paused ? (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => postParallelControl({ action: 'resume_parallel' }, 'resume_all')}
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30"
                >
                  <Play className="w-3 h-3" />
                  Resume All
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => postParallelControl({ action: 'pause_parallel' }, 'pause_all')}
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30"
                >
                  <Pause className="w-3 h-3" />
                  Pause All
                </button>
              )}

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => postParallelControl({ action: 'stop_parallel' }, 'stop_all')}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30"
              >
                <Square className="w-3 h-3" />
                Stop All
              </button>
            </>
          )}

          {(failedCount > 0 || needsAttentionCount > 0) && (
            <button
              type="button"
              disabled={busyAction !== null || !scanId || isRunningOrStarting}
              onClick={() =>
                postParallelControl({ action: 'retry_failed_parallel' }, 'retry_failed')
              }
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-50"
            >
              <RotateCcw className="w-3 h-3" />
              Retry failed windows ({failedCount + needsAttentionCount})
            </button>
          )}

          {prohibitedCount > 0 && (
            <button
              type="button"
              disabled={busyAction !== null || !scanId}
              onClick={() =>
                postParallelControl({ action: 'retry_prohibited_parallel' }, 'retry_prohibited')
              }
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-orange-500/20 text-orange-200 border border-orange-500/40 hover:bg-orange-500/30 disabled:opacity-50"
              title="Manually retry only PROHIBITED windows (skipped by auto-retry)"
            >
              <RotateCcw className="w-3 h-3" />
              Retry prohibited ({prohibitedCount})
            </button>
          )}
        </div>
      </div>

      {/* Per-Scan Config Bar: Movie Minutes Input + Source Badge + Reset + Concurrency */}
      <div className="px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-900/40 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[260px] flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-medium text-zinc-400 shrink-0">
              Scan Movie Minutes:
            </label>
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                minuteInputSource === 'manual'
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              }`}
              title={
                minuteInputSource === 'manual'
                  ? 'Manually edited by user — preserved across refreshes'
                  : 'Auto-synced from this scan’s Minutes found (±1 min buffer)'
              }
            >
              {minuteInputSource === 'manual' ? 'manual' : 'auto (Minutes found)'}
            </span>
            <input
              type="text"
              value={minuteInput}
              onChange={(e) => {
                setMinuteInput(e.target.value)
                setMinuteInputSource('manual')
              }}
              placeholder={
                effectiveFoundMinutes
                  ? effectiveFoundMinutes
                  : 'Pehle window scan poora chalao'
              }
              className="flex-1 min-w-[180px] rounded bg-zinc-950 border border-zinc-800 px-2.5 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500/50"
            />
            <button
              type="button"
              disabled={busyAction !== null || !scanId}
              onClick={handleResetToMinutesFound}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800/90 hover:bg-zinc-700 text-cyan-300 border border-zinc-700 disabled:opacity-50"
              title="Reset box to this scan's Minutes found (±1 min buffer) and switch source back to auto"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to Minutes found
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[11px] font-medium text-zinc-400">Concurrency:</label>
            <input
              type="number"
              min={1}
              max={20}
              value={concurrency}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 4)))}
              className="w-16 rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs font-mono text-zinc-200 text-center focus:outline-none focus:border-cyan-500/50"
            />
            <button
              type="button"
              disabled={busyAction !== null || !scanId || !minuteInput.trim() || isRunningOrStarting}
              onClick={handleBuildPreviewClick}
              className="text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
            >
              {busyAction === 'save_config' ? 'Building...' : 'Build / Preview Windows'}
            </button>
          </div>
        </div>

        {/* 360p Compression Progress Bar Banner (blocks workers until ready) */}
        {compressing360p?.active && (
          <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-cyan-200 font-mono">
              <span className="font-semibold">
                {compressing360p.statusText ||
                  `Compressing movie 360p... ${compressing360p.progress || 0}%`}
              </span>
              <span className="text-[11px] text-cyan-300/80">
                Workers queued — waiting for data/media/{scanId}/movie_360p.mp4 (&le; 390 MB, 24fps CFR)
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden border border-cyan-500/30">
              <div
                className="h-full bg-cyan-400 transition-all duration-300"
                style={{ width: `${Math.max(2, Math.min(100, compressing360p.progress || 0))}%` }}
              />
            </div>
          </div>
        )}

        {compressing360p && !compressing360p.active && compressing360p.error && (
          <div className="rounded border border-red-500/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300 font-mono">
            360p Compression Error: {compressing360p.error}
          </div>
        )}

        {/* Per-Window Clip Extraction Progress Bar Banner */}
        {(clipsExtracting || (isRunningOrStarting && clipsTotal > 0)) && (
          <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-3 py-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-cyan-200 font-mono">
              <span className="font-semibold">
                Clips: {clipsReady}/{clipsTotal} (
                {clipsTotal > 0 ? Math.round((clipsReady / clipsTotal) * 100) : 0}%)
              </span>
              <span className="text-[11px] text-cyan-300/80">
                {clipsReady < clipsTotal
                  ? 'Extracting frame-exact 24fps window clips (max 2 parallel)...'
                  : 'All window clips extracted'}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden border border-cyan-500/30">
              <div
                className="h-full bg-cyan-400 transition-all duration-300"
                style={{
                  width: `${Math.max(
                    2,
                    Math.min(100, clipsTotal > 0 ? Math.round((clipsReady / clipsTotal) * 100) : 0),
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Verified Per-Scan Media Badge */}
        {mediaInfo && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-emerald-300/90 bg-emerald-950/20 border border-emerald-500/25 rounded px-2.5 py-1">
            <span className="font-semibold text-emerald-300">Verified Media ({mediaInfo.scanId}):</span>
            <span>
              short: {mediaInfo.shortPath} (
              {mediaInfo.shortSizeBytes ? (mediaInfo.shortSizeBytes / (1024 * 1024)).toFixed(1) : '0'}{' '}
              MB, {(mediaInfo.shortDurationSec || 0).toFixed(1)}s)
            </span>
            <span>·</span>
            <span>
              movie_360p: {mediaInfo.movie360Path} (
              {mediaInfo.movie360SizeBytes
                ? (mediaInfo.movie360SizeBytes / (1024 * 1024)).toFixed(1)
                : '0'}{' '}
              MB, {(mediaInfo.movie360DurationSec || 0).toFixed(1)}s)
            </span>
          </div>
        )}

        {/* Empty Minutes Found message */}
        {!effectiveFoundMinutes && !minuteInput.trim() && (
          <div className="flex items-center gap-2 rounded bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-xs text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
            <span className="font-medium">Pehle window scan poora chalao</span>
            <span className="text-[11px] text-amber-300/80">
              (Is scan me abhi Minutes found nahi hain — window scan poora hone par ±1 min buffer ke saath compact ranges yahan apne aap aa jayengi)
            </span>
          </div>
        )}

        {/* Confirmation prompt before wiping old parallel state when minute list changed */}
        {confirmClearStateOpen && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-amber-500/15 border border-amber-500/40 px-3 py-2 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Minute list badal gayi hai — purani{' '}
                <strong>{windows.length} windows</strong> (Done: {doneCount}, Failed:{' '}
                {failedCount}) ka parallel state saaf karke nayi{' '}
                <strong>{previewValidation.previewWindows.length} windows</strong> banayein?
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleConfirmRebuildWindows}
                className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-[11px]"
              >
                Confirm &amp; Clear Old State
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearStateOpen(false)}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {snap?.resourceWarning && (
        <div className="px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{snap.resourceWarning}</span>
        </div>
      )}

      {errorMsg && (
        <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-300 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-400 hover:text-red-200 text-[10px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Worker Cards Grid (Global Profile Slot Pool W01..W10) */}
      <div className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span>Worker Browser Pool ({workers.length || maxConcurrency} Chrome Profiles)</span>
            {slotPool && (
              <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                {slotPool.summaryText}
              </span>
            )}
          </div>
          <span className="text-[10px] font-normal text-zinc-500">
            Click any worker card to view large screenshot &amp; [Wxx] step logs (200 lines)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {workers.map((w) => {
            const isIdle = w.status === 'IDLE' || !w.windowId
            return (
              <div
                key={w.workerId}
                onClick={() => setSelectedWorkerId(w.workerId)}
                className={`group relative rounded-lg border transition cursor-pointer overflow-hidden flex flex-col ${
                  w.active
                    ? 'border-cyan-500/40 bg-zinc-900/70 hover:border-cyan-400/70'
                    : w.leasedByOtherScan
                      ? 'border-purple-500/30 bg-purple-950/15 hover:border-purple-400/50'
                      : 'border-zinc-800/80 bg-zinc-900/30 hover:border-zinc-700'
                }`}
              >
                {/* Live Thumbnail Header */}
                <div className="relative aspect-video bg-black border-b border-zinc-800/80 flex items-center justify-center overflow-hidden">
                  {w.screenshotBase64 ? (
                    <img
                      src={`data:image/jpeg;base64,${w.screenshotBase64}`}
                      alt={w.workerId}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-[10px] text-zinc-600 font-mono text-center px-2">
                      <div>
                        {w.workerId} · {w.profileDirName}
                      </div>
                      {w.leasedByOtherScan && w.leasedByScanLabel && (
                        <div className="text-[9px] text-purple-300 mt-0.5">
                          Leased by {w.leasedByScanLabel}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Top-left Worker ID + Window # overlay */}
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded bg-black/80 border border-zinc-700 text-[10px] font-mono font-bold text-cyan-300">
                      {w.workerId}
                    </span>
                    {w.windowNumber !== null && (
                      <span className="px-1.5 py-0.5 rounded bg-black/80 border border-zinc-700 text-[10px] font-mono text-zinc-100">
                        #{w.windowNumber} ({w.windowRange})
                      </span>
                    )}
                  </div>

                  {/* Top-right Status Badge */}
                  <div className="absolute top-1.5 right-1.5">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[9px] font-mono font-semibold uppercase ${statusBadgeStyle(
                        w.status,
                      )}`}
                    >
                      {w.leasedByOtherScan ? 'OTHER SCAN' : w.status}
                    </span>
                  </div>

                  {/* Bottom-right expand icon */}
                  <div className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition bg-black/75 p-1 rounded text-zinc-300">
                    <Maximize2 className="w-3 h-3" />
                  </div>
                </div>

                {/* Card Telemetry Body */}
                <div className="p-2.5 flex-1 flex flex-col justify-between gap-1.5 text-[11px]">
                  <div>
                    <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-zinc-400">
                      <span className="text-purple-300 font-medium">
                        {shortModelBadge(w.modelName)}
                      </span>
                      <span>
                        {w.tokens ? `${Math.round(w.tokens / 1000)}K tok` : '— tok'} ·{' '}
                        {formatMmSs(w.elapsedSec)}
                      </span>
                    </div>

                    <div
                      className="mt-1 text-[10px] font-mono text-zinc-300 truncate"
                      title={w.stage}
                    >
                      {w.stage || 'idle'}
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-zinc-400">
                      <span>
                        Chrome procs: <strong className="text-zinc-200">{w.chromeProcessCount ?? 0}</strong>
                        {w.chromeRssMb ? ` (${w.chromeRssMb} MB)` : ''}
                      </span>
                      {!isIdle && (
                        <span>
                          try {w.attempt || 1}/{w.maxAttempts || 5}
                          {w.permRetry > 0 ? ` · 403:${w.permRetry}` : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Per-card controls when a window of THIS scan is assigned */}
                  {w.windowId && !w.leasedByOtherScan && (
                    <div
                      className="pt-1.5 border-t border-zinc-800/80 flex items-center justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'stop',
                            },
                            `stop_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-[10px]"
                        title="Stop this window"
                      >
                        Stop
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'retry',
                            },
                            `retry_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[10px]"
                        title="Retry this window"
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'skip',
                            },
                            `skip_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px]"
                        title="Skip this window"
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Preview Windows List & Movie Length Check (shown whenever minuteInput produces preview windows) */}
      {previewValidation.previewWindows.length > 0 && (
        <div className="px-4 pb-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                  Window Preview ({previewValidation.previewWindows.length} Windows · Max 5:00 · no overlap)
                </span>
                {effectiveMovieDurationSec && effectiveMovieDurationSec > 0 ? (
                  previewValidation.savedWindowsOutOfBounds.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-300">
                      <AlertTriangle className="w-3 h-3" />
                      {previewValidation.savedWindowsOutOfBounds.length} stale window(s) exceed Movie Length{' '}
                      {formatParallelTimecode(Math.floor(effectiveMovieDurationSec))} — click Build / Preview Windows
                    </span>
                  ) : previewValidation.exceededInputCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">
                      <CheckCircle2 className="w-3 h-3" />
                      Clamped to Movie Length {formatParallelTimecode(Math.floor(effectiveMovieDurationSec))} (no window &gt;{' '}
                      {formatParallelTimecode(Math.floor(effectiveMovieDurationSec))})
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                      <CheckCircle2 className="w-3 h-3" />
                      All {previewValidation.previewWindows.length} windows within Movie Length (
                      {formatParallelTimecode(Math.floor(effectiveMovieDurationSec))})
                    </span>
                  )
                ) : null}
              </div>
              <span className="text-[10px] font-mono text-zinc-400">
                Minutes: <strong className="text-zinc-200">{minuteInput.trim()}</strong>
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto pr-1">
              {previewValidation.previewWindows.map((pw) => {
                const maxDurFloor =
                  effectiveMovieDurationSec && effectiveMovieDurationSec > 0
                    ? Math.floor(effectiveMovieDurationSec)
                    : null
                const isWithinBounds = maxDurFloor === null || pw.endSec <= maxDurFloor
                return (
                  <span
                    key={pw.id}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono ${
                      isWithinBounds
                        ? 'border-zinc-800 bg-zinc-950 text-zinc-200'
                        : 'border-red-500/50 bg-red-950/40 text-red-300'
                    }`}
                    title={`Run ${pw.runLabel} · Part ${pw.partIndex}/${pw.partsInRun} · Priority #${pw.priorityRank}`}
                  >
                    <strong className="text-cyan-400">#{pw.windowNumber}</strong>
                    <span>
                      {pw.startFormatted}–{pw.endFormatted}
                    </span>
                    <span className="text-zinc-500">({formatMmSs(pw.durationSec)})</span>
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Prohibited Windows Compact List */}
      {prohibitedWindows.length > 0 && (
        <div className="px-4 pb-3">
          <div className="rounded-lg border border-orange-500/40 bg-orange-950/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-orange-300">
                  Prohibited windows ({prohibitedWindows.length})
                </span>
                <span className="text-[10px] font-mono text-orange-200/80">
                  Skipped automatically (no auto-retry). Use manual Retry if needed.
                </span>
              </div>
              <button
                type="button"
                disabled={busyAction !== null || !scanId}
                onClick={() =>
                  postParallelControl({ action: 'retry_prohibited_parallel' }, 'retry_prohibited')
                }
                className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-500/40 disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                Retry prohibited ({prohibitedWindows.length})
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {prohibitedWindows.map((pw) => (
                <div
                  key={pw.id}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-orange-500/40 bg-zinc-950/90 text-[10px] font-mono text-orange-200"
                >
                  <span>
                    Window #{pw.windowNumber} ({pw.startFormatted}–{pw.endFormatted})
                  </span>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      postParallelControl(
                        {
                          action: 'parallel_window_action',
                          windowId: pw.id,
                          subAction: 'retry',
                        },
                        `prohibited_retry_${pw.id}`,
                      )
                    }
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-orange-500/20 hover:bg-orange-500/35 text-orange-200 border border-orange-500/40 text-[9px]"
                    title={`Retry Window #${pw.windowNumber} (${pw.startFormatted}–${pw.endFormatted})`}
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    Retry
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Planned Windows Status Table / Cards */}
      {windows.length > 0 && (
        <div className="px-4 pb-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center justify-between">
            <span>
              Active / Saved Scan Windows ({windows.length} Windows · Max 5:00 each · no overlap)
            </span>
            <span className="text-[10px] font-mono text-zinc-500">
              Queue Priority: Largest contiguous runs pulled first
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
            {windows.map((win: ParallelWindowState) => (
              <div
                key={win.id}
                className="rounded-lg border border-zinc-800/90 bg-zinc-900/50 px-3 py-2 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono font-bold text-zinc-100">
                      #{win.windowNumber}
                    </span>
                    <span className="font-mono text-cyan-300">
                      {win.startFormatted}–{win.endFormatted}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      ({formatMmSs(win.durationSec)})
                    </span>
                    {win.workerId && (
                      <span className="px-1.5 py-0.2 rounded bg-cyan-500/15 border border-cyan-500/30 text-[10px] font-mono text-cyan-300">
                        {win.workerId}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.2 rounded border text-[9px] font-mono font-semibold uppercase ${statusBadgeStyle(
                        win.status,
                      )}`}
                    >
                      {win.status === 'WAITING_FOR_WORKER' ? 'WAITING FOR WORKER' : win.status}
                    </span>
                  </div>

                  <div className="mt-0.5 text-[10px] font-mono text-zinc-400 truncate">
                    {win.status === 'DONE' ? (
                      <span className="text-emerald-300 font-medium">{win.summaryText}</span>
                    ) : win.status === 'PROHIBITED' ? (
                      <span className="text-orange-300 font-medium">
                        {win.summaryText || 'PROHIBITED CONTENT (skipped, no retry)'}
                      </span>
                    ) : win.error ? (
                      <span className="text-red-300">{win.error}</span>
                    ) : (
                      <span>
                        {win.stage} · {shortModelBadge(win.modelName)}
                        {win.tokens ? ` · ${Math.round(win.tokens / 1000)}K tok` : ''}
                        {win.attempt > 0 ? ` · try ${win.attempt}/${win.maxAttempts}` : ''}
                        {win.permRetry > 0 ? ` · 403 ${win.permRetry}/10` : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Per-window controls */}
                <div className="flex items-center gap-1 shrink-0">
                  {(win.status === 'SETUP' ||
                    win.status === 'RUNNING' ||
                    win.status === 'VALIDATING' ||
                    win.status === 'RETRYING' ||
                    win.status === '403_WAIT' ||
                    win.status === 'WAITING_FOR_WORKER' ||
                    win.status === 'QUEUED') && (
                    <button
                      type="button"
                      onClick={() =>
                        postParallelControl(
                          {
                            action: 'parallel_window_action',
                            windowId: win.id,
                            subAction: 'stop',
                          },
                          `win_stop_${win.id}`,
                        )
                      }
                      className="p-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30"
                      title="Stop window"
                    >
                      <Square className="w-3 h-3" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      postParallelControl(
                        {
                          action: 'parallel_window_action',
                          windowId: win.id,
                          subAction: 'retry',
                        },
                        `win_retry_${win.id}`,
                      )
                    }
                    className="p-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30"
                    title="Retry window"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>

                  {win.status !== 'DONE' && win.status !== 'SKIPPED' && (
                    <button
                      type="button"
                      onClick={() =>
                        postParallelControl(
                          {
                            action: 'parallel_window_action',
                            windowId: win.id,
                            subAction: 'skip',
                          },
                          `win_skip_${win.id}`,
                        )
                      }
                      className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
                      title="Skip window"
                    >
                      <SkipForward className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Final Merged Result Viewer (TXT + JSON) */}
      {mergedReport && mergedReport.totalShortSegments > 0 && (
        <div className="border-t border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                Merged Final Result (HISSA 1 + HISSA 2)
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                {mergedReport.completedWindows}/{mergedReport.totalWindows} DONE
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
                {mergedReport.failedWindows} FAILED
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30">
                {mergedReport.prohibitedWindows ?? prohibitedCount} PROHIBITED
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                {mergedReport.foundCount} FOUND
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                {mergedReport.notFoundCount} NOT FOUND
              </span>
              {mergedReport.conflictCount > 0 && (
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {mergedReport.conflictCount} CONFLICT
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setReportTab('txt')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${
                  reportTab === 'txt'
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                }`}
              >
                <FileText className="w-3 h-3" />
                TXT
              </button>
              <button
                type="button"
                onClick={() => setReportTab('json')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${
                  reportTab === 'json'
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                }`}
              >
                <FileCode className="w-3 h-3" />
                JSON
              </button>
              <button
                type="button"
                onClick={handleCopyReport}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Copy className="w-3 h-3" />
                {copiedReport ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadReport('txt')}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Download className="w-3 h-3" />
                .txt
              </button>
              <button
                type="button"
                onClick={() => handleDownloadReport('json')}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Download className="w-3 h-3" />
                .json
              </button>
            </div>
          </div>

          <pre className="max-h-64 overflow-y-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] font-mono text-zinc-200 whitespace-pre-wrap">
            {reportTab === 'txt'
              ? mergedReport.formattedTxt
              : JSON.stringify(mergedReport, null, 2)}
          </pre>
        </div>
      )}

      {/* =====================================================================
          KAAM 2: COMBINED LOG (ALL WORKERS) PANEL + SERVER-SIDE PDF DOWNLOAD
          ===================================================================== */}
      <div className="border-t border-zinc-800 bg-zinc-950 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-100">
              Combined Log (all workers)
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
              Showing {filteredCombinedLogs.length} / {totalLogLinesOnDisk} persisted lines (JSONL)
            </span>
          </div>

          {/* PDF Scope Selector + Download Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={pdfRunScope}
              onChange={(e) => setPdfRunScope(e.target.value === 'all' ? 'all' : 'latest')}
              className="rounded bg-zinc-900 border border-zinc-700 px-2 py-1 font-mono text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50"
              title="Choose whether PDF includes only the latest Start run (default) or all historical runs"
            >
              <option value="latest">
                Latest run only{snap?.currentRunId ? ` (${snap.currentRunId})` : ''}
              </option>
              <option value="all">All runs</option>
            </select>

            <button
              type="button"
              disabled={!scanId || downloadingPdfMode !== null}
              onClick={() => void handleDownloadPdf('full')}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-500/40 disabled:opacity-50"
              title="Download full server-side PDF report (all workers, window summary, events, resources, full JSONL log, HISSA map)"
            >
              <FileDown className="w-3.5 h-3.5" />
              {downloadingPdfMode === 'full' ? 'Generating PDF...' : 'Download PDF (full)'}
            </button>

            <button
              type="button"
              disabled={!scanId || downloadingPdfMode !== null}
              onClick={() => void handleDownloadPdf('errors')}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 disabled:opacity-50"
              title="Download server-side PDF report with only errors, retries, 403s, state changes & ±2 surrounding context lines"
            >
              <FileDown className="w-3.5 h-3.5" />
              {downloadingPdfMode === 'errors' ? 'Generating PDF...' : 'Download PDF (errors only)'}
            </button>
          </div>
        </div>

        {/* Filters & Auto-scroll Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5 px-3 py-2 rounded-lg bg-zinc-900/70 border border-zinc-800/90 text-[11px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Filter className="w-3.5 h-3.5 text-zinc-500" />
              <span>Worker:</span>
              <select
                value={workerFilter}
                onChange={(e) => setWorkerFilter(e.target.value)}
                className="rounded bg-zinc-950 border border-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-200 focus:outline-none focus:border-cyan-500/50"
              >
                <option value="ALL">All Workers</option>
                {workerFilterOptions.map((wId) => (
                  <option key={wId} value={wId}>
                    {wId}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5 text-zinc-400">
              <span>Level:</span>
              <select
                value={levelFilter}
                disabled={onlyErrorsRetries403}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="rounded bg-zinc-950 border border-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-200 disabled:opacity-40 focus:outline-none focus:border-cyan-500/50"
              >
                <option value="ALL">All Levels</option>
                <option value="INFO">INFO</option>
                <option value="SUCCESS">SUCCESS</option>
                <option value="RETRY">RETRY</option>
                <option value="403">403</option>
                <option value="ERROR">ERROR</option>
                <option value="STOPPED">STOPPED</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => setOnlyErrorsRetries403((v) => !v)}
              className={`px-2.5 py-0.5 rounded border font-mono text-[11px] transition ${
                onlyErrorsRetries403
                  ? 'border-amber-500/50 bg-amber-500/20 text-amber-200 font-semibold'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Sirf errors+retries+403 {onlyErrorsRetries403 ? '✓' : ''}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoScrollLogs((v) => !v)}
              className={`px-2.5 py-0.5 rounded border font-mono text-[11px] transition ${
                autoScrollLogs
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400'
              }`}
            >
              Auto-scroll: {autoScrollLogs ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Chronological Combined Log Stream (last ~2000 lines) */}
        <div
          ref={logContainerRef}
          className="h-72 overflow-y-auto rounded-lg bg-black/80 border border-zinc-800 p-2.5 font-mono text-[11px] space-y-1"
        >
          {filteredCombinedLogs.length === 0 ? (
            <div className="text-zinc-500 py-12 text-center">
              {scanId
                ? 'No combined worker logs recorded yet for this scan.'
                : 'Select a scan to view its combined parallel worker logs.'}
            </div>
          ) : (
            filteredCombinedLogs.map((entry: ParallelCombinedLogEntry) => (
              <div
                key={`${entry.seq}-${entry.t}`}
                className="flex items-start gap-1.5 leading-snug hover:bg-zinc-900/50 px-1.5 py-0.5 rounded"
              >
                <span className="text-zinc-500 shrink-0">{formatHhMmSsMmm(entry.t)}</span>
                <span className="text-zinc-400 shrink-0">{formatPlusMmSs(entry.elapsedSec)}</span>
                <span className="px-1 rounded bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 text-[10px] shrink-0">
                  [{entry.workerId}]
                </span>
                {entry.windowNumber !== null ? (
                  <span className="px-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 text-[10px] shrink-0">
                    #{entry.windowNumber} ({entry.windowRange})
                  </span>
                ) : (
                  <span className="px-1 rounded bg-zinc-900/50 border border-zinc-800 text-zinc-500 text-[10px] shrink-0">
                    [scan]
                  </span>
                )}
                <span
                  className={`px-1 rounded border text-[9px] font-bold shrink-0 ${logLevelBadgeStyle(
                    entry.level,
                  )}`}
                >
                  {entry.level}
                </span>
                <span
                  className={`break-all ${
                    entry.level === 'ERROR'
                      ? 'text-red-300'
                      : entry.level === '403'
                        ? 'text-orange-300'
                        : entry.level === 'RETRY'
                          ? 'text-amber-200'
                          : entry.level === 'SUCCESS'
                            ? 'text-emerald-300'
                            : entry.level === 'STOPPED'
                              ? 'text-zinc-400'
                              : 'text-zinc-200'
                  }`}
                >
                  {entry.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Modal for Worker Large Screenshot + [Wxx] Step Log (200 lines) */}
      {selectedWorker && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedWorkerId(null)}
        >
          <div
            className="w-full max-w-5xl rounded-xl border border-zinc-700 bg-zinc-950 overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-xs font-mono font-bold text-cyan-300">
                  {selectedWorker.workerId}
                </span>
                <span className="text-xs font-mono text-zinc-300">
                  Profile: {selectedWorker.profileDirName}
                </span>
                {selectedWorker.windowNumber !== null && (
                  <span className="text-xs font-mono text-zinc-100">
                    · Window #{selectedWorker.windowNumber} ({selectedWorker.windowRange})
                  </span>
                )}
                <span
                  className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold uppercase ${statusBadgeStyle(
                    selectedWorker.status,
                  )}`}
                >
                  {selectedWorker.status}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWorkerId(null)}
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 overflow-hidden">
              <div className="lg:col-span-7 bg-black flex items-center justify-center border-b lg:border-b-0 lg:border-r border-zinc-800 p-2">
                {selectedWorker.screenshotBase64 ? (
                  <img
                    src={`data:image/jpeg;base64,${selectedWorker.screenshotBase64}`}
                    alt={selectedWorker.workerId}
                    className="max-h-[65vh] w-auto object-contain rounded"
                  />
                ) : (
                  <div className="text-xs font-mono text-zinc-500 py-16">
                    No live screenshot captured yet for {selectedWorker.workerId}
                  </div>
                )}
              </div>

              <div className="lg:col-span-5 flex flex-col max-h-[65vh]">
                <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span>
                    [{selectedWorker.workerId}] Step Log ({selectedWorker.logs.length}/200 lines)
                  </span>
                  <span>
                    {shortModelBadge(selectedWorker.modelName)} ·{' '}
                    {selectedWorker.tokens
                      ? `${selectedWorker.tokens.toLocaleString()} tok`
                      : '— tok'}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[11px]">
                  {selectedWorker.logs.length === 0 ? (
                    <div className="text-zinc-600">No logs recorded yet.</div>
                  ) : (
                    selectedWorker.logs
                      .slice()
                      .reverse()
                      .map((log, i) => (
                        <div key={`${log.t}-${i}`} className="leading-snug flex items-start gap-1.5">
                          <span className="text-zinc-600 shrink-0">
                            {new Date(log.t).toLocaleTimeString([], {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                          <span
                            className={
                              log.level === 'error'
                                ? 'text-red-400'
                                : log.level === 'warn'
                                  ? 'text-amber-300'
                                  : log.level === 'success'
                                    ? 'text-emerald-400'
                                    : 'text-zinc-300'
                            }
                          >
                            <strong className="font-semibold">{log.step}</strong>
                            {log.detail ? ` — ${log.detail}` : ''}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
