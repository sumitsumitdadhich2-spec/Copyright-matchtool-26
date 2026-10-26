import type { Scan, ScanSummary } from './types'

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`
}

export const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface ScanStageInfo {
  stage: 'upload' | 'minute_finder' | 'backup_finder' | 'waiting_chunk_ticket' | 'chunk_scanning' | 'done'
  label: string
  steps: Array<{
    key: 'upload' | 'minute_finder' | 'backup_finder' | 'waiting_chunk_ticket' | 'chunk_scanning' | 'done'
    label: string
    active: boolean
    completed: boolean
  }>
}

export function formatScanKeyPairBadge(
  scanOrSlot?: Scan | ScanSummary | number | null,
  keyPairArg?: [number, number] | null,
): string | null {
  let keySlot: number | null | undefined = null
  let keyPair: [number, number] | null | undefined = keyPairArg
  if (typeof scanOrSlot === 'number') {
    keySlot = scanOrSlot
  } else if (scanOrSlot && typeof scanOrSlot === 'object') {
    keySlot = scanOrSlot.keySlot
    keyPair = scanOrSlot.keyPair ?? keyPairArg
  }
  if (!keySlot || keySlot <= 0) return null
  const k1 = keyPair?.[0] ?? 2 * keySlot - 1
  const k2 = keyPair?.[1] ?? 2 * keySlot
  return `Slot ${keySlot} — Keys ${k1} & ${k2}`
}

export function deriveScanStageInfo(scan: Scan | ScanSummary): ScanStageInfo {
  const fullScan = 'geminiPrescan' in scan ? scan : null
  const prescanStatus = fullScan ? fullScan.geminiPrescan?.status : scan.geminiPrescanStatus
  const ticket = scan.chunkTicket
  const waitTicket = scan.waitingForTicket ?? fullScan?.chunkQueue?.ticket
  const waitTitle =
    scan.waitingForScanTitle ||
    fullScan?.chunkQueue?.activeScanTitle ||
    fullScan?.chunkQueue?.activeScanId ||
    (waitTicket ? `#${waitTicket}` : '#1')

  let stage: ScanStageInfo['stage'] = 'upload'

  if (scan.status === 'done' || scan.pipelineStage === 'done') {
    stage = 'done'
  } else if (
    scan.pipelineStage === 'waiting_chunk_ticket' ||
    Boolean(scan.waitingForScanTitle || scan.waitingForTicket || fullScan?.chunkQueue)
  ) {
    stage = 'waiting_chunk_ticket'
  } else if (
    scan.pipelineStage === 'chunk_scanning' ||
    scan.status === 'scanning' ||
    scan.status === 'verifying'
  ) {
    stage = 'chunk_scanning'
  } else if (
    scan.pipelineStage === 'backup_finder' ||
    prescanStatus === 'backup' ||
    fullScan?.geminiPrescan?.backup?.status === 'preparing' ||
    fullScan?.geminiPrescan?.backup?.status === 'uploading' ||
    fullScan?.geminiPrescan?.backup?.status === 'scanning'
  ) {
    stage = 'backup_finder'
  } else if (
    scan.pipelineStage === 'minute_finder' ||
    prescanStatus === 'preparing' ||
    prescanStatus === 'uploading' ||
    prescanStatus === 'scanning' ||
    prescanStatus === 'starting_scan' ||
    (Boolean(scan.shortName && scan.movieName) && scan.status === 'chunking')
  ) {
    stage = 'minute_finder'
  } else {
    stage = 'upload'
  }

  const waitLabel = `Chunk windows ke liye wait (Ticket #${ticket ?? '?'}, Scan ${waitTitle} chal raha hai)`

  const orderedKeys: Array<{ key: ScanStageInfo['stage']; label: string }> = [
    { key: 'upload', label: 'Upload' },
    { key: 'minute_finder', label: 'Minute finder' },
    { key: 'backup_finder', label: 'Backup finder' },
    {
      key: 'waiting_chunk_ticket',
      label: stage === 'waiting_chunk_ticket' ? waitLabel : 'Chunk windows ke liye wait',
    },
    { key: 'chunk_scanning', label: 'Chunk windows scanning' },
    { key: 'done', label: 'Done' },
  ]

  const activeIdx = orderedKeys.findIndex((o) => o.key === stage)
  const currentLabel = orderedKeys[activeIdx]?.label || 'Upload'

  return {
    stage,
    label: currentLabel,
    steps: orderedKeys.map((o, idx) => ({
      key: o.key,
      label: o.label,
      active: idx === activeIdx && stage !== 'done',
      completed: stage === 'done' ? true : idx < activeIdx,
    })),
  }
}

