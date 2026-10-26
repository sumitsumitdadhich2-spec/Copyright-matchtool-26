import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { chromium, type BrowserContext, type Page, type Response as PlaywrightResponse } from 'playwright'
import { DATA_DIR } from './paths'
import {
  STUDIO_SELECTORS,
  STUDIO_URLS,
  findFirstVisibleLocator,
} from './studio-selectors'
import {
  DEFAULT_STUDIO_UPLOAD_GATE,
  computeEffectiveMaxInputTokens,
  encryptSecret,
  loadDecryptedPlaywrightCookies,
  loadStudioUserConfig,
  saveStudioUserConfig,
} from './studio-settings'
import {
  DEFAULT_STUDIO_MODEL_NAME,
  buildStudioModelChain,
  canonicalizeStudioModelName,
  getEffectiveModel,
  loadStudioModelQuotaState,
  markModelExhausted,
  normalizeStudioThinkingLevel,
  thinkingLevelToDisplayLabel,
  type StudioThinkingLevel,
} from './studio-model-state'
import { buildStudioChunkPrompt } from './studio-prompt'
import { parseChunkMatches } from './gemini'
import {
  checkHissa2ShortCoverage,
  cleanStudioAnswerText,
  isPromptEchoText,
  isThinkingOnlyText,
  stitchContinuedStudioAnswer,
  validateStudioAnswer,
  type StudioValidationResult,
} from './studio-result-validator'
import { extractHissa1And2EntriesFromResponse, formatParallelTimecode } from './studio-window-planner'
import { maxMovieEndSecInHissa2, shiftMovieTimestampsInHissa2 } from './studio-clip-offset'
import { fmtTime } from './format'
import type { ChunkMatch } from './types'

export interface StudioStepLog {
  t: number
  step: string
  detail?: string
  level: 'info' | 'success' | 'warn' | 'error'
}

export interface StudioTestClipLine {
  label: string
  pass: boolean
  expected: string
  actual: string
  detail?: string
}

export interface StudioTestClipResult {
  status: 'running' | 'pass' | 'fail' | 'error' | 'stopped'
  summary: string
  lines: StudioTestClipLine[]
  startedAt: number
  finishedAt?: number
}

export interface StudioLiveSnapshot {
  active: boolean
  paused: boolean
  assistMode: boolean
  currentStep: string
  currentUrl: string
  scanId: string | null
  jobLabel: string | null
  tokenCount: number | null
  elapsedSec: number
  screenshotBase64: string | null
  screenshotAt: number | null
  viewport: { width: number; height: number }
  logs: StudioStepLog[]
  testClipResult?: StudioTestClipResult | null
}

const VIEWPORT = { width: 1366, height: 840 }
const STUDIO_CHROME_PROFILE_NAME = 'studio-chrome-profile'

export function readAutomationRamPercent(): number {
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
    /* ignore */
  }
  const total = os.totalmem()
  const free = os.freemem()
  if (total <= 0) return 0
  return Math.round(((total - free) / total) * 100)
}

export function readDevShmUsedMb(): number {
  try {
    if (fs.existsSync('/dev/shm')) {
      const st = fs.statfsSync('/dev/shm')
      const usedBlocks = Math.max(0, Number(st.blocks) - Number(st.bfree))
      const usedBytes = usedBlocks * Number(st.bsize)
      return Math.round((usedBytes / (1024 * 1024)) * 10) / 10
    }
  } catch {
    /* ignore */
  }
  return 0
}

export interface ChromeProcessInspection {
  totalCount: number
  perWorkerCount: Record<string, number>
  perWorkerRssMb: Record<string, number>
  pidsByProfileDir: Record<string, number[]>
  allChromePids: number[]
}

export function inspectChromeProcesses(): ChromeProcessInspection {
  const perWorkerCount: Record<string, number> = {}
  const perWorkerRssMb: Record<string, number> = {}
  const pidsByProfileDir: Record<string, number[]> = {}
  const allChromePids: number[] = []
  let totalCount = 0

  try {
    if (fs.existsSync('/proc')) {
      const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))
      for (const pidStr of pids) {
        const pid = Number(pidStr)
        if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue
        try {
          const rawCmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          if (!rawCmd) continue
          const cmd = rawCmd.replace(/\0/g, ' ')
          // Match google-chrome / chromium processes (exclude pgrep/pkill/node)
          if (!/google-chrome|chromium|chrome-linux|chrome\b/i.test(cmd)) continue
          if (/^\s*(node|sh\s+-c|pkill|pgrep)\b/i.test(cmd)) continue

          totalCount += 1
          allChromePids.push(pid)

          let rssKb = 0
          try {
            const statusTxt = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
            const m = statusTxt.match(/VmRSS:\s+(\d+)\s+kB/i)
            if (m) rssKb = Number(m[1]) || 0
          } catch {
            /* ignore */
          }
          const rssMb = rssKb / 1024

          const profMatch = cmd.match(/studio-chrome-profile(?:-w(\d+))?/i)
          if (profMatch) {
            const profName = profMatch[0]
            if (!pidsByProfileDir[profName]) pidsByProfileDir[profName] = []
            pidsByProfileDir[profName].push(pid)
            const workerKey = profMatch[1]
              ? `W${String(Number(profMatch[1])).padStart(2, '0')}`
              : 'MAIN'
            perWorkerCount[workerKey] = (perWorkerCount[workerKey] || 0) + 1
            perWorkerRssMb[workerKey] = Math.round(((perWorkerRssMb[workerKey] || 0) + rssMb) * 10) / 10
          }
        } catch {
          /* process exited */
        }
      }
      return {
        totalCount,
        perWorkerCount,
        perWorkerRssMb,
        pidsByProfileDir,
        allChromePids,
      }
    }
  } catch {
    /* fallback to ps below */
  }

  try {
    const out = execFileSync('ps', ['-eo', 'pid,rss,args'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
    for (const line of out.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = Number(m[1])
      const rssKb = Number(m[2]) || 0
      const cmd = m[3] || ''
      if (pid === process.pid) continue
      if (!/google-chrome|chromium|chrome-linux|chrome\b/i.test(cmd)) continue
      if (/^\s*(node|sh\s+-c|pkill|pgrep|ps)\b/i.test(cmd)) continue

      totalCount += 1
      allChromePids.push(pid)
      const rssMb = rssKb / 1024
      const profMatch = cmd.match(/studio-chrome-profile(?:-w(\d+))?/i)
      if (profMatch) {
        const profName = profMatch[0]
        if (!pidsByProfileDir[profName]) pidsByProfileDir[profName] = []
        pidsByProfileDir[profName].push(pid)
        const workerKey = profMatch[1]
          ? `W${String(Number(profMatch[1])).padStart(2, '0')}`
          : 'MAIN'
        perWorkerCount[workerKey] = (perWorkerCount[workerKey] || 0) + 1
        perWorkerRssMb[workerKey] = Math.round(((perWorkerRssMb[workerKey] || 0) + rssMb) * 10) / 10
      }
    }
  } catch {
    /* ignore */
  }

  return {
    totalCount,
    perWorkerCount,
    perWorkerRssMb,
    pidsByProfileDir,
    allChromePids,
  }
}

export function getWorkerChromeStats(profileDirName: string): {
  procCount: number
  rssMb: number
  pids: number[]
} {
  const snap = inspectChromeProcesses()
  const profMatch = profileDirName.match(/studio-chrome-profile(?:-w(\d+))?/i)
  const workerKey = profMatch
    ? profMatch[1]
      ? `W${String(Number(profMatch[1])).padStart(2, '0')}`
      : 'MAIN'
    : 'MAIN'
  const pids = snap.pidsByProfileDir[profileDirName] || []
  const procCount = snap.perWorkerCount[workerKey] ?? pids.length
  const rssMb = snap.perWorkerRssMb[workerKey] ?? 0
  return { procCount, rssMb, pids }
}

/**
 * Cleanly terminate all Chrome processes matching `profileDirName` (--user-data-dir):
 * Sends SIGTERM first, waits up to 3 seconds for processes to exit, then sends SIGKILL
 * to any survivors and removes SingletonLock/SingletonCookie/SingletonSocket.
 */
export async function killWorkerChromeProcessesByProfileDir(
  profileDirName: string,
): Promise<{ sigtermCount: number; sigkillCount: number }> {
  const profileDir = path.join(DATA_DIR, profileDirName)
  const getMatchingPids = (): number[] => {
    const snap = inspectChromeProcesses()
    return snap.pidsByProfileDir[profileDirName] || []
  }

  let pids = getMatchingPids()
  const sigtermCount = pids.length

  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
    try {
      execFileSync('pkill', ['-TERM', '-f', profileDirName], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }

    const waitDeadline = Date.now() + 3000
    while (Date.now() < waitDeadline) {
      pids = getMatchingPids()
      if (pids.length === 0) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  pids = getMatchingPids()
  const sigkillCount = pids.length
  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
    }
    try {
      execFileSync('pkill', ['-KILL', '-f', profileDirName], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(profileDir, lockName), { force: true })
    } catch {
      /* ignore */
    }
  }

  return { sigtermCount, sigkillCount }
}

const globalForStartupChromeCleanup = globalThis as unknown as {
  __cmtStartupChromeCleanedUp?: boolean
}

/**
 * Requirement 1: On app start, kill all leftover google-chrome / chromium processes once.
 */
export function killAllLeftoverChromeProcessesOnceOnStartup(): void {
  if (globalForStartupChromeCleanup.__cmtStartupChromeCleanedUp) return
  globalForStartupChromeCleanup.__cmtStartupChromeCleanedUp = true

  try {
    const snap = inspectChromeProcesses()
    if (snap.allChromePids.length > 0) {
      for (const pid of snap.allChromePids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* ignore */
        }
      }
      try {
        execFileSync('pkill', ['-TERM', '-f', 'google-chrome|chromium'], { stdio: 'ignore' })
      } catch {
        /* ignore */
      }
      // Brief synchronous wait up to 1.5s then SIGKILL any remaining orphan processes
      const deadline = Date.now() + 1500
      while (Date.now() < deadline) {
        const check = inspectChromeProcesses()
        if (check.allChromePids.length === 0) break
        try {
          execFileSync('sleep', ['0.2'], { stdio: 'ignore' })
        } catch {
          break
        }
      }
      const survivors = inspectChromeProcesses().allChromePids
      for (const pid of survivors) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
      try {
        execFileSync('pkill', ['-KILL', '-f', 'google-chrome|chromium'], { stdio: 'ignore' })
      } catch {
        /* ignore */
      }
    }

    // Clean stale SingletonLocks across all studio-chrome-profile* dirs
    if (fs.existsSync(DATA_DIR)) {
      for (const entry of fs.readdirSync(DATA_DIR)) {
        if (entry.startsWith('studio-chrome-profile')) {
          const dirPath = path.join(DATA_DIR, entry)
          for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            try {
              fs.rmSync(path.join(dirPath, lockName), { force: true })
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  } catch {
    /* ignore startup cleanup errors */
  }
}

// Run startup cleanup once when module is loaded
killAllLeftoverChromeProcessesOnceOnStartup()

function resolveChromeLogsRootDir(): string {
  // Requirement 2: write to /data/chrome-logs/<scanId>/wNN-attemptN.log
  const primary = path.join(DATA_DIR, 'chrome-logs')
  try {
    fs.mkdirSync(primary, { recursive: true })
  } catch {
    /* ignore */
  }
  if (path.resolve(DATA_DIR) !== '/data') {
    try {
      if (fs.existsSync('/data') || fs.existsSync('/')) {
        if (!fs.existsSync('/data')) {
          fs.mkdirSync('/data', { recursive: true })
        }
        if (!fs.existsSync('/data/chrome-logs')) {
          try {
            fs.symlinkSync(primary, '/data/chrome-logs', 'dir')
          } catch {
            fs.mkdirSync('/data/chrome-logs', { recursive: true })
          }
        }
        if (fs.existsSync('/data/chrome-logs')) {
          return '/data/chrome-logs'
        }
      }
    } catch {
      /* fallback to DATA_DIR/chrome-logs */
    }
  }
  return primary
}

export function extractCleanScanIdForChromeLog(rawScanId: string | null | undefined): string {
  const s = (rawScanId || '').trim()
  if (!s) return 'default'
  // parallel-<scanId>-win-<N> -> <scanId>
  const m = s.match(/^parallel-([a-zA-Z0-9_-]+?)-win-\d+$/i)
  if (m && m[1]) return m[1]
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function resolveWorkerChromeLogFilePath(
  rawScanId: string | null | undefined,
  profileDirName: string,
  attempt: number,
): string {
  const cleanScanId = extractCleanScanIdForChromeLog(rawScanId)
  const profMatch = profileDirName.match(/studio-chrome-profile-w(\d+)/i)
  const workerSlug = profMatch ? `w${String(Number(profMatch[1])).padStart(2, '0')}` : 'w00'
  const safeAttempt = Math.max(1, Math.floor(attempt || 1))
  const rootDir = resolveChromeLogsRootDir()
  const scanLogDir = path.join(rootDir, cleanScanId)
  try {
    fs.mkdirSync(scanLogDir, { recursive: true })
  } catch {
    /* ignore */
  }
  return path.join(scanLogDir, `${workerSlug}-attempt${safeAttempt}.log`)
}

export function readLastLinesFromFile(filePath: string | null | undefined, maxLines = 30): string {
  if (!filePath) return '(no chrome log path)'
  try {
    if (!fs.existsSync(filePath)) {
      return `(chrome log file not found at ${filePath})`
    }
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0)
    if (lines.length === 0) return '(chrome log file is empty)'
    return lines.slice(-maxLines).join('\n')
  } catch (err) {
    return `(failed to read chrome log: ${(err as Error)?.message || String(err)})`
  }
}

function ensureChromeStderrWrapperScript(): string | null {
  const wrapperPath = path.join(os.tmpdir(), 'cmt-chrome-stderr-wrapper.sh')
  try {
    const script = [
      '#!/bin/sh',
      'if [ -n "$CMT_CHROME_LOG_FILE" ]; then',
      '  mkdir -p "$(dirname "$CMT_CHROME_LOG_FILE")" 2>/dev/null || true',
      '  exec "$CMT_REAL_CHROME_BIN" "$@" 2>>"$CMT_CHROME_LOG_FILE"',
      'else',
      '  exec "$CMT_REAL_CHROME_BIN" "$@"',
      'fi',
      '',
    ].join('\n')
    fs.writeFileSync(wrapperPath, script, { encoding: 'utf8', mode: 0o755 })
    fs.chmodSync(wrapperPath, 0o755)
    return wrapperPath
  } catch {
    return null
  }
}

/**
 * Global Upload Gate across all workers/scans:
 * Ensures at most N workers (default 2) attach/upload video files to AI Studio concurrently
 * so 10 Chrome processes never buffer 300+ MB files in RAM at the same time.
 */
class GlobalStudioUploadGate {
  private maxConcurrent = DEFAULT_STUDIO_UPLOAD_GATE
  private inUse = 0
  private activeHolders = new Set<string>()
  private waiters: Array<{
    holderId: string
    grant: () => void
    cancelled: boolean
  }> = []

  public setMaxConcurrent(limit: number) {
    if (Number.isFinite(limit) && limit >= 1) {
      this.maxConcurrent = Math.max(1, Math.min(10, Math.round(limit)))
      this.pump()
    }
  }

  public getStatus() {
    return {
      inUse: this.inUse,
      maxConcurrent: this.maxConcurrent,
      waiting: this.waiters.filter((w) => !w.cancelled).length,
      holders: Array.from(this.activeHolders),
    }
  }

  public async acquire(
    holderId: string,
    opts?: {
      onWaiting?: (inUse: number, maxConcurrent: number, queuePos: number) => void
      isAborted?: () => boolean
    },
  ): Promise<() => void> {
    if (this.inUse < this.maxConcurrent) {
      this.inUse += 1
      this.activeHolders.add(holderId)
      let released = false
      return () => {
        if (released) return
        released = true
        this.inUse = Math.max(0, this.inUse - 1)
        this.activeHolders.delete(holderId)
        this.pump()
      }
    }

    const waiter = {
      holderId,
      grant: () => {},
      cancelled: false,
    }
    this.waiters.push(waiter)
    const activeWaiters = this.waiters.filter((w) => !w.cancelled)
    opts?.onWaiting?.(this.inUse, this.maxConcurrent, activeWaiters.length)

    await new Promise<void>((resolve, reject) => {
      const pollTimer = setInterval(() => {
        if (opts?.isAborted?.()) {
          waiter.cancelled = true
          clearInterval(pollTimer)
          reject(new Error('STOPPED BY USER'))
        }
      }, 400)
      waiter.grant = () => {
        clearInterval(pollTimer)
        resolve()
      }
    })

    let released = false
    return () => {
      if (released) return
      released = true
      this.inUse = Math.max(0, this.inUse - 1)
      this.activeHolders.delete(holderId)
      this.pump()
    }
  }

  private pump() {
    while (this.inUse < this.maxConcurrent && this.waiters.length > 0) {
      const next = this.waiters.shift()!
      if (next.cancelled) continue
      this.inUse += 1
      this.activeHolders.add(next.holderId)
      next.grant()
    }
  }
}

const globalForUploadGate = globalThis as unknown as {
  __cmtStudioUploadGate?: GlobalStudioUploadGate
}

export const globalStudioUploadGate: GlobalStudioUploadGate =
  globalForUploadGate.__cmtStudioUploadGate ||
  (globalForUploadGate.__cmtStudioUploadGate = new GlobalStudioUploadGate())

let globalClipboardLockPromise: Promise<void> = Promise.resolve()

async function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const nextLock = new Promise<void>((resolve) => {
    release = resolve
  })
  const prevLock = globalClipboardLockPromise
  globalClipboardLockPromise = prevLock.then(() => nextLock)
  await prevLock
  try {
    return await fn()
  } finally {
    release()
  }
}

export interface StudioBrowserControllerOptions {
  profileDirName?: string
  workerTag?: string
}

export class StudioBrowserController {
  public readonly profileDirName: string
  public readonly workerTag: string
  private context: BrowserContext | null = null
  private page: Page | null = null
  private pageCrashed = false
  private launching: Promise<Page> | null = null
  private paused = false
  private stoppedScanIds = new Set<string>()
  private stoppedUsernames = new Set<string>()
  private assistMode = false
  private currentStep = 'idle'
  private scanId: string | null = null
  private activeUsername: string | null = null
  private jobLabel: string | null = null
  private tokenCount: number | null = null
  private jobStartedAt: number | null = null
  private lastScreenshotB64: string | null = null
  private lastScreenshotAt: number | null = null
  private screenshotInFlight: Promise<void> | null = null
  private logs: StudioStepLog[] = []
  private lastInjectedCookieUser: string | null = null
  private browserLaunchInfo: string | null = null
  private finishedJobsSinceRecycle = 0
  private testClipResult: StudioTestClipResult | null = null
  private suppressDiagDumps = false
  private activeModelName = 'Gemini 3.8 Flash'
  private activeAttempt = 0
  private activeMaxAttempts = 3
  private activePermRetry = 0
  private activeChromeLogPath: string | null = null
  private lastSampledWorkerRssMb = 0
  private peakWorkerRssMb = 0
  private scanContextTag = ''
  private stepLogListener?: (entry: StudioStepLog) => void
  private jobLockBusy = false
  private jobLockQueue: Array<{
    scanId: string
    username: string
    grant: () => void
  }> = []

  constructor(options?: StudioBrowserControllerOptions) {
    this.profileDirName = options?.profileDirName || STUDIO_CHROME_PROFILE_NAME
    this.workerTag = options?.workerTag || ''
  }

  public setScanContextTag(tag: string) {
    this.scanContextTag = tag
  }

  public setStepLogListener(listener?: (entry: StudioStepLog) => void) {
    this.stepLogListener = listener
  }

  public getActiveRunMeta() {
    return {
      modelName: this.activeModelName,
      attempt: this.activeAttempt,
      maxAttempts: this.activeMaxAttempts,
      permRetry: this.activePermRetry,
      tokenCount: this.tokenCount,
      currentStep: this.currentStep,
    }
  }

  public getLogs(limit = 200): StudioStepLog[] {
    return this.logs.slice(-limit)
  }

  public clearLogs() {
    this.logs = []
  }

  public isBrowserOrTargetCrashError(msg: string): boolean {
    if (this.pageCrashed) return true
    return /target\s+crashed|page\s+crashed|frame\s+crashed|target\s+page,\s*context\s+or\s+browser\s+has\s+been\s+closed|browser\s+has\s+been\s+closed|context\s+closed|target\s+closed|cdp\s+session.*closed|inspector.*detached/i.test(
      msg || '',
    )
  }

  /**
   * Immediately close a dead/crashed Playwright context, kill any zombie Chrome processes
   * bound to this worker's profile directory (SIGTERM -> wait 3s -> SIGKILL), and clean
   * SingletonLock files so the next `ensurePage` launches a fresh Chrome browser.
   */
  public async forceRestartDeadBrowser(): Promise<void> {
    this.pageCrashed = false
    const ctx = this.context
    this.context = null
    this.page = null
    this.launching = null

    if (ctx) {
      try {
        await Promise.race([
          ctx.close(),
          new Promise((r) => setTimeout(r, 3000)),
        ])
      } catch {
        /* ignore dead context close error */
      }
    }

    await killWorkerChromeProcessesByProfileDir(this.profileDirName)
  }

  /**
   * Requirement 1: Close context AND ensure all processes for this worker's --user-data-dir
   * are terminated via SIGTERM -> 3s -> SIGKILL.
   */
  public async closeContext(): Promise<void> {
    await this.forceRestartDeadBrowser()
  }

  public appendToWorkerChromeLog(line: string) {
    const targetPath =
      this.activeChromeLogPath ||
      resolveWorkerChromeLogFilePath(this.scanId, this.profileDirName, this.activeAttempt || 1)
    this.activeChromeLogPath = targetPath
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.appendFileSync(targetPath, `${line}\n`, 'utf8')
    } catch {
      /* ignore log write error */
    }
  }

  public logStep(
    step: string,
    detail?: string,
    level: 'info' | 'success' | 'warn' | 'error' = 'info',
  ) {
    const fullTag = `${this.workerTag}${this.scanContextTag}`.trim()
    const prefixedStep =
      fullTag && !step.startsWith(this.workerTag || fullTag) ? `${fullTag} ${step}` : step
    this.currentStep = detail ? `${prefixedStep}: ${detail}` : prefixedStep
    const entry: StudioStepLog = {
      t: Date.now(),
      step: prefixedStep,
      detail,
      level,
    }
    this.logs.push(entry)
    if (this.logs.length > 200) {
      this.logs.splice(0, this.logs.length - 200)
    }
    try {
      this.stepLogListener?.(entry)
    } catch {
      /* ignore listener errors */
    }
  }

  public setJobContext(scanId: string | null, jobLabel: string | null, username?: string | null) {
    this.scanId = scanId
    this.jobLabel = jobLabel
    if (username !== undefined) this.activeUsername = username
    this.jobStartedAt = scanId ? Date.now() : null
    if (!scanId) {
      this.tokenCount = null
      this.currentStep = 'idle'
      this.activeUsername = null
    }
  }

  public getActiveScanId(): string | null {
    return this.scanId
  }

  public getLoadedCookieUser(): string | null {
    return this.lastInjectedCookieUser || this.activeUsername
  }

  /**
   * FIX 6: Only allow the admin role OR the user whose cookies are currently loaded in the browser.
   */
  public canUserAccessStudio(session: { username: string; role: 'admin' | 'user' } | null): boolean {
    if (!session) return false
    if (session.role === 'admin') return true
    const cookieOwner = this.getLoadedCookieUser()
    return Boolean(cookieOwner && cookieOwner === session.username)
  }

  /**
   * FIX 6: Simple guard so only ONE Studio job runs at a time across all users (single shared browser).
   * Queues subsequent jobs in FIFO order and logs their queue position.
   */
  public async acquireJobLock(
    scanId: string,
    username: string,
    onQueued?: (position: number, msg: string) => void,
  ): Promise<() => void> {
    if (!this.jobLockBusy) {
      this.jobLockBusy = true
      return () => this.releaseJobLock()
    }

    const position = this.jobLockQueue.length + 1
    const waitMsg = `Studio browser is currently busy (active scan ${this.scanId || 'running'}) — queued at position #${position}, waiting for browser lock...`
    this.logStep('queued', waitMsg, 'info')
    onQueued?.(position, waitMsg)

    await new Promise<void>((resolve) => {
      this.jobLockQueue.push({
        scanId,
        username,
        grant: resolve,
      })
    })

    return () => this.releaseJobLock()
  }

  private releaseJobLock() {
    const next = this.jobLockQueue.shift()
    if (next) {
      next.grant()
    } else {
      this.jobLockBusy = false
    }
  }

  public setPaused(val: boolean) {
    this.paused = val
    this.logStep(val ? 'paused' : 'resumed', val ? 'User paused Studio automation' : 'User resumed Studio automation', 'warn')
  }

  public isPaused(): boolean {
    return this.paused
  }

  /**
   * FIX 6: Scope stop flag by scanId and/or username so stopping one job never stops everyone globally.
   */
  public requestStop(scope?: { scanId?: string | null; username?: string | null }) {
    const targetScanId = scope?.scanId ?? this.scanId
    const targetUsername = scope?.username ?? null
    if (targetScanId) this.stoppedScanIds.add(targetScanId)
    if (targetUsername) this.stoppedUsernames.add(targetUsername)
    if (
      (!targetScanId && !targetUsername) ||
      (targetScanId && targetScanId === this.scanId) ||
      (targetUsername && targetUsername === this.activeUsername)
    ) {
      this.paused = false
    }
    this.logStep(
      'stopping',
      `Stop requested (${targetScanId ? `scan ${targetScanId}` : targetUsername ? `user ${targetUsername}` : 'active job'})`,
      'warn',
    )
  }

  public clearStop(scope?: { scanId?: string | null; username?: string | null }) {
    if (scope?.scanId) this.stoppedScanIds.delete(scope.scanId)
    if (scope?.username) this.stoppedUsernames.delete(scope.username)
    if (!scope?.scanId && !scope?.username) {
      this.stoppedScanIds.clear()
      this.stoppedUsernames.clear()
    }
  }

  public isStopping(scope?: { scanId?: string | null; username?: string | null }): boolean {
    const checkScanId = scope?.scanId ?? this.scanId
    const checkUsername = scope?.username ?? this.activeUsername
    if (checkScanId && this.stoppedScanIds.has(checkScanId)) return true
    if (checkUsername && this.stoppedUsernames.has(checkUsername)) return true
    return false
  }

  public setAssistMode(val: boolean) {
    this.assistMode = val
    this.logStep(val ? 'login assist ON' : 'login assist OFF', undefined, 'info')
  }

  public async waitIfPausedOrThrowIfStopped(scope?: { scanId?: string | null; username?: string | null }) {
    while (this.paused && !this.isStopping(scope)) {
      await new Promise((r) => setTimeout(r, 400))
    }
    if (this.isStopping(scope)) {
      throw new Error('Studio scan stopped by user')
    }
  }

  private async ensureXvfbDisplay(): Promise<string> {
    if (!process.env.DISPLAY) {
      process.env.DISPLAY = ':99'
    }
    const display = process.env.DISPLAY
    const match = display.match(/^:(\d+)/)
    const displayNum = match ? match[1] : '99'
    const xSocket = `/tmp/.X11-unix/X${displayNum}`
    if (fs.existsSync(xSocket)) {
      return display
    }
    if (fs.existsSync('/usr/bin/Xvfb')) {
      try {
        const { spawn } = await import('child_process')
        try {
          fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 })
        } catch {
          /* ignore */
        }
        try {
          const lockFile = `/tmp/.X${displayNum}-lock`
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile)
        } catch {
          /* ignore */
        }
        const child = spawn(
          '/usr/bin/Xvfb',
          [`:${displayNum}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
        for (let i = 0; i < 25; i++) {
          if (fs.existsSync(xSocket)) break
          await new Promise((r) => setTimeout(r, 100))
        }
      } catch {
        /* ignore Xvfb spawn error; Playwright launch will report if DISPLAY fails */
      }
    }
    return display
  }

  private attachPageLifecycleListeners(p: Page) {
    p.on('crash', () => {
      this.pageCrashed = true
      const ramPct = readAutomationRamPercent()
      const shmMb = readDevShmUsedMb()
      const wStats = getWorkerChromeStats(this.profileDirName)
      const effectiveRss = wStats.rssMb > 0 ? wStats.rssMb : this.lastSampledWorkerRssMb
      if (wStats.rssMb > 0) {
        this.lastSampledWorkerRssMb = wStats.rssMb
        this.peakWorkerRssMb = Math.max(this.peakWorkerRssMb, wStats.rssMb)
      }
      const crashEvtLine = `[${new Date().toISOString()}] [page.on('crash')] profile=${this.profileDirName} step="${this.currentStep}" url="${p.url()}" RAM=${ramPct}% workerChromeRSS=${effectiveRss.toFixed(1)}MB (peak=${this.peakWorkerRssMb.toFixed(1)}MB, procs=${wStats.procCount}) /dev/shm=${shmMb.toFixed(1)}MB`
      this.appendToWorkerChromeLog(crashEvtLine)
    })
    p.on('close', () => {
      if (this.page === p) {
        this.page = null
      }
    })
  }

  public async ensurePage(username: string): Promise<Page> {
    if (this.pageCrashed) {
      await this.forceRestartDeadBrowser()
    }
    if (this.page && !this.page.isClosed() && !this.pageCrashed && this.context) {
      await this.context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://aistudio.google.com',
        })
        .catch(() => {})
      this.lastInjectedCookieUser = username
      if (!this.browserLaunchInfo) {
        const pwPath = chromium.executablePath()
        const sysChrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) =>
          fs.existsSync(p),
        )
        const displayEnv = process.env.DISPLAY || ''
        this.browserLaunchInfo = sysChrome && displayEnv
          ? `channel=chrome · mode=headed · profile=${this.profileDirName} · path=${sysChrome} · display=${displayEnv}`
          : `WARN: binary=${sysChrome || pwPath} · mode=${displayEnv ? 'headed' : 'headless (no DISPLAY)'} · profile=${this.profileDirName}`
      }
      return this.page
    }

    if (this.launching) return this.launching

    this.launching = (async () => {
      try {
        // Ensure no lingering zombie Chrome processes exist for this profile before launching
        await killWorkerChromeProcessesByProfileDir(this.profileDirName)

        const profileDir = path.join(DATA_DIR, this.profileDirName)
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })

        const displayEnv = await this.ensureXvfbDisplay()
        const userCfg = await loadStudioUserConfig(username)
        const lowMemFlags = Boolean(userCfg.studioLowMemoryChromeFlags ?? false)
        const disableDevShm =
          userCfg.studioDisableDevShmUsage !== undefined
            ? Boolean(userCfg.studioDisableDevShmUsage)
            : true

        const chromeLogPath = resolveWorkerChromeLogFilePath(
          this.scanId,
          this.profileDirName,
          this.activeAttempt || 1,
        )
        this.activeChromeLogPath = chromeLogPath
        this.appendToWorkerChromeLog(
          `=== [${new Date().toISOString()}] Launching Chrome for ${this.profileDirName} (scan=${this.scanId || 'default'}, attempt=${this.activeAttempt || 1}, lowMemFlags=${lowMemFlags ? 'ON' : 'OFF'}, disableDevShm=${disableDevShm ? 'ON' : 'OFF'}) ===`,
        )

        const baseArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(disableDevShm ? ['--disable-dev-shm-usage'] : []),
          ...(lowMemFlags
            ? [
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
              ]
            : []),
          '--enable-logging=stderr',
          '--v=0',
          '--disable-blink-features=AutomationControlled',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--window-size=1366,840',
        ]

        const sysChromePath = [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome-beta',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ].find((p) => fs.existsSync(p))
        const pwExecPath = chromium.executablePath()
        const wrapperPath = ensureChromeStderrWrapperScript()

        const flagsSummary = `lowMemFlags=${lowMemFlags ? 'ON' : 'OFF'} · devShm=${disableDevShm ? 'disabled' : 'enabled'} · log=${chromeLogPath}`

        this.logStep(
          'browser launching',
          `Checking Chrome/Chromium (systemChrome=${sysChromePath || 'none'}, DISPLAY=${displayEnv || 'none'}, profile=${this.profileDirName}, ${flagsSummary})`,
        )

        const launchEnvForBin = (realBin: string): Record<string, string> => {
          const envCopy: Record<string, string> = {}
          for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === 'string') envCopy[k] = v
          }
          envCopy.CMT_REAL_CHROME_BIN = realBin
          envCopy.CMT_CHROME_LOG_FILE = chromeLogPath
          envCopy.CHROME_LOG_FILE = chromeLogPath
          return envCopy
        }

        try {
          if (sysChromePath && wrapperPath) {
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: false,
              executablePath: wrapperPath,
              env: launchEnvForBin(sysChromePath),
              viewport: VIEWPORT,
              args: baseArgs,
            })
          } else {
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: false,
              channel: 'chrome',
              env: launchEnvForBin(sysChromePath || pwExecPath),
              viewport: VIEWPORT,
              args: baseArgs,
            })
          }
          this.browserLaunchInfo = `channel=chrome · mode=headed · profile=${this.profileDirName} · path=${sysChromePath || 'system-chrome'} · display=${displayEnv} · ${flagsSummary}`
          this.logStep('browser launched', this.browserLaunchInfo, 'success')
        } catch (chromeErr) {
          const chromeErrMsg = chromeErr instanceof Error ? chromeErr.message.split('\n')[0].slice(0, 140) : String(chromeErr)
          try {
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: false,
              ...(wrapperPath && pwExecPath
                ? { executablePath: wrapperPath, env: launchEnvForBin(pwExecPath) }
                : {}),
              viewport: VIEWPORT,
              args: baseArgs,
            })
            this.browserLaunchInfo = `WARN: channel=chrome failed (${chromeErrMsg}); fallback=chromium · mode=headed · profile=${this.profileDirName} · path=${pwExecPath} · ${flagsSummary}`
            this.logStep('browser launched (fallback)', this.browserLaunchInfo, 'warn')
          } catch (headedErr) {
            const headedErrMsg =
              headedErr instanceof Error ? headedErr.message.split('\n')[0].slice(0, 140) : String(headedErr)
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: true,
              ...(wrapperPath && pwExecPath
                ? { executablePath: wrapperPath, env: launchEnvForBin(pwExecPath) }
                : {}),
              viewport: VIEWPORT,
              args: baseArgs,
            })
            this.browserLaunchInfo = `WARN: Headed launch failed [chrome: ${chromeErrMsg} | headed-chromium: ${headedErrMsg} | DISPLAY=${displayEnv || 'none'}]; fallback=chromium · mode=headless · profile=${this.profileDirName} · path=${pwExecPath} · ${flagsSummary}`
            this.logStep('WARN [headless fallback]', this.browserLaunchInfo, 'warn')
          }
        }

        await this.context
          .grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: 'https://aistudio.google.com',
          })
          .catch(() => {})

        // If the profile has no Google cookies yet, seed once from any pasted/saved user cookies
        try {
          const existingGoogleCookies = await this.context.cookies([
            'https://aistudio.google.com',
            'https://accounts.google.com',
          ])
          if (existingGoogleCookies.length === 0) {
            await this.injectUserCookies(username)
          }
        } catch {
          /* ignore initial cookie check */
        }

        const pages = this.context.pages()
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage()
        this.pageCrashed = false
        this.attachPageLifecycleListeners(this.page)
        await this.page.setViewportSize(VIEWPORT)

        this.lastInjectedCookieUser = username
        return this.page
      } finally {
        this.launching = null
      }
    })()

    return this.launching
  }

  /**
   * Persist updated/rotated Google cookies and storage state from the persistent browser context
   * after every job (Google cookies rotate frequently during active sessions).
   */
  public async saveRotatedSessionFromContext(username: string): Promise<void> {
    if (!this.context) return
    try {
      const profileDir = path.join(DATA_DIR, this.profileDirName)
      const statePath = path.join(profileDir, 'storage-state.json')
      const state = await this.context.storageState({ path: statePath })
      const rotatedCookies = await this.context.cookies([
        'https://aistudio.google.com',
        'https://accounts.google.com',
        'https://google.com',
      ])
      const cookiesToSave = rotatedCookies.length > 0 ? rotatedCookies : state.cookies
      if (cookiesToSave.length > 0) {
        const encrypted = encryptSecret(JSON.stringify(cookiesToSave))
        await saveStudioUserConfig(username, {
          encryptedCookies: encrypted,
        })
      }
    } catch {
      /* ignore cookie rotation persistence warning */
    }
  }

  public async applySavedCookiesToContext(username: string): Promise<void> {
    if (!this.context) return
    await this.injectUserCookies(username)
    await this.saveRotatedSessionFromContext(username)
  }

  private async injectUserCookies(username: string) {
    if (!this.context) return
    const cookies = await loadDecryptedPlaywrightCookies(username)
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies)
        this.lastInjectedCookieUser = username
        this.logStep('cookies loaded', `${cookies.length} Google cookie(s) applied to browser session`)
      } catch (err) {
        this.logStep(
          'cookie warning',
          `Some cookies could not be added: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        )
      }
    }
  }

  public setTestClipResult(result: StudioTestClipResult | null) {
    this.testClipResult = result
  }

  public getTestClipResult(): StudioTestClipResult | null {
    return this.testClipResult
  }

  /**
   * Item 5: Page recycling — after every N finished window jobs (success or failed, default 5),
   * close the Playwright page and open a fresh page in the SAME persistent context (cookies kept),
   * then continue. Logs "page recycled" in the step log.
   * Also saves rotated cookies/profile after every finished job.
   */
  public async recordFinishedWindowJobAndMaybeRecyclePage(
    username: string,
    recycleInterval?: number,
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void,
  ): Promise<void> {
    await this.saveRotatedSessionFromContext(username)
    this.finishedJobsSinceRecycle += 1
    let interval = recycleInterval
    if (!interval || interval < 1) {
      const cfg = await loadStudioUserConfig(username)
      interval = cfg.studioPageRecycleInterval || 5
    }
    if (this.finishedJobsSinceRecycle < interval) return

    const count = this.finishedJobsSinceRecycle
    this.finishedJobsSinceRecycle = 0
    if (!this.context) return

    try {
      await this.context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://aistudio.google.com',
        })
        .catch(() => {})
      const oldPage = this.page
      const freshPage = await this.context.newPage()
      await freshPage.setViewportSize(VIEWPORT)
      this.page = freshPage
      if (oldPage && !oldPage.isClosed()) {
        await oldPage.close().catch(() => {})
      }
      const detail = `Closed old page and opened fresh page in same persistent context after ${count} finished window job(s) (interval=${interval})`
      this.logStep('page recycled', detail, 'info')
      onLog?.('info', `[Studio] page recycled: ${detail}`)
    } catch (err) {
      this.logStep(
        'page recycle warning',
        err instanceof Error ? err.message : String(err),
        'warn',
      )
    }
  }

  /**
   * FIX 6: Capture at most ONE screenshot per second (or minIntervalMs) across all connected SSE clients.
   */
  public async getSnapshot(
    captureFresh = true,
    opts?: { quality?: number; minIntervalMs?: number; maxLogs?: number },
  ): Promise<StudioLiveSnapshot> {
    const quality = opts?.quality ?? 62
    const minIntervalMs = opts?.minIntervalMs ?? 1000
    const maxLogs = opts?.maxLogs ?? 30

    if (captureFresh && this.page && !this.page.isClosed()) {
      const now = Date.now()
      if (!this.lastScreenshotAt || now - this.lastScreenshotAt >= minIntervalMs) {
        if (!this.screenshotInFlight) {
          this.screenshotInFlight = (async () => {
            try {
              if (!this.page || this.page.isClosed()) return
              const buf = await this.page.screenshot({
                type: 'jpeg',
                quality,
                timeout: 2500,
              })
              this.lastScreenshotB64 = buf.toString('base64')
              this.lastScreenshotAt = Date.now()
            } catch {
              /* ignore screenshot race while navigating */
            } finally {
              this.screenshotInFlight = null
            }
          })()
        }
        await this.screenshotInFlight
      }
    }

    const elapsedSec = this.jobStartedAt ? Math.round((Date.now() - this.jobStartedAt) / 1000) : 0
    return {
      active: Boolean(this.page && !this.page.isClosed()),
      paused: this.paused,
      assistMode: this.assistMode,
      currentStep: this.currentStep,
      currentUrl: this.page && !this.page.isClosed() ? this.page.url() : '',
      scanId: this.scanId,
      jobLabel: this.jobLabel,
      tokenCount: this.tokenCount,
      elapsedSec,
      screenshotBase64: this.lastScreenshotB64,
      screenshotAt: this.lastScreenshotAt,
      viewport: VIEWPORT,
      logs: this.logs.slice(-maxLogs),
      testClipResult: this.testClipResult,
    }
  }

  /**
   * Interactive Login Assist actions from the Live View panel (click, type, key, navigate).
   */
  public async performAssistAction(
    username: string,
    action:
      | { type: 'click'; xRatio: number; yRatio: number }
      | { type: 'type'; text: string }
      | { type: 'key'; key: string }
      | { type: 'navigate'; url: string }
      | { type: 'save_session' },
  ): Promise<StudioLiveSnapshot> {
    const page = await this.ensurePage(username)
    if (action.type === 'click') {
      const x = Math.round(Math.max(0, Math.min(1, action.xRatio)) * VIEWPORT.width)
      const y = Math.round(Math.max(0, Math.min(1, action.yRatio)) * VIEWPORT.height)
      await page.mouse.click(x, y)
      this.logStep('assist click', `Clicked (${x}, ${y})`)
    } else if (action.type === 'type') {
      await page.keyboard.type(action.text, { delay: 35 })
      this.logStep('assist type', `Typed ${action.text.length} char(s)`)
    } else if (action.type === 'key') {
      await page.keyboard.press(action.key)
      this.logStep('assist key', `Pressed ${action.key}`)
    } else if (action.type === 'navigate') {
      await page.goto(action.url || STUDIO_URLS.newChat, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      this.logStep('assist navigate', page.url())
    } else if (action.type === 'save_session' && this.context) {
      const state = await this.context.storageState()
      const { saveUserGoogleCookies } = await import('./studio-settings')
      await saveUserGoogleCookies(username, JSON.stringify(state))
      this.logStep('session saved', `Saved ${state.cookies.length} cookies from live browser`, 'success')
    }
    await new Promise((r) => setTimeout(r, 350))
    return this.getSnapshot(true)
  }

  /**
   * Test login on aistudio.google.com and return whether the session is authenticated + account email.
   */
  public async testLogin(username: string): Promise<{
    loggedIn: boolean
    email: string | null
    currentUrl: string
    message: string
  }> {
    const page = await this.ensurePage(username)
    this.logStep('testing login', 'Opening aistudio.google.com/prompts/new_chat...')

    try {
      await page.goto(STUDIO_URLS.newChat, {
        waitUntil: 'domcontentloaded',
        timeout: 40_000,
      })
    } catch (err) {
      this.logStep('navigation warning', err instanceof Error ? err.message : String(err), 'warn')
    }

    await new Promise((r) => setTimeout(r, 3500))
    await this.dismissAnyOnboardingModals(page)

    const url = page.url()
    const isGoogleLoginRedirect =
      url.includes('accounts.google.com') ||
      url.includes('ServiceLogin') ||
      url.includes('InteractiveLogin')

    let email: string | null = null
    try {
      email = await page.evaluate(() => {
        // Look for email in aria-labels or page text
        const els = Array.from(document.querySelectorAll('[aria-label], [title], [data-email]'))
        for (const el of els) {
          const text =
            (el.getAttribute('data-email') || '') +
            ' ' +
            (el.getAttribute('aria-label') || '') +
            ' ' +
            (el.getAttribute('title') || '')
          const m = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
          if (m) return m[1]
        }
        const bodyMatch = document.body.innerText.match(/([a-zA-Z0-9._%+-]+@gmail\.com)/i)
        return bodyMatch ? bodyMatch[1] : null
      })
    } catch {
      /* ignore */
    }

    const promptLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 4000)
    const loggedIn = !isGoogleLoginRedirect && Boolean(promptLoc || url.includes('aistudio.google.com/prompts') || url.includes('aistudio.google.com/app'))

    await saveStudioUserConfig(username, {
      lastLoginStatus: loggedIn ? 'logged_in' : 'logged_out',
      lastLoginEmail: email,
      lastLoginTestedAt: Date.now(),
    })

    if (loggedIn) {
      const msg = `Logged in to Google AI Studio${email ? ` as ${email}` : ''}`
      this.logStep('login verified', msg, 'success')
      return { loggedIn: true, email, currentUrl: url, message: msg }
    } else {
      const msg = isGoogleLoginRedirect
        ? 'Redirected to Google Sign-In (cookies expired or verification needed — use Login Assist in Live View or paste fresh cookies)'
        : `Could not confirm AI Studio workspace at ${url}`
      this.logStep('login failed', msg, 'error')
      return { loggedIn: false, email: null, currentUrl: url, message: msg }
    }
  }

  /**
   * Close any "paid API key" / billing / API key selection dialog ONLY via its cross (X / close) button.
   * Never clicks any button that selects an API key, links a project, or sets up billing.
   */
  private async closePaidApiKeyPopupByCrossButton(page: Page): Promise<boolean> {
    try {
      const closed = await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const dialogs = Array.from(
          document.querySelectorAll('mat-dialog-container, [role="dialog"], [aria-modal="true"]'),
        ).filter(isVisible)

        let closedAny = false
        for (const dlg of dialogs) {
          const txt = (dlg.innerText || dlg.textContent || '').trim()
          if (
            !/paid\s+api\s+key|billing|select\s+an?\s+api\s+key|link\s+a\s+paid|pay-as-you-go|api\s+key\s+required|set\s+up\s+billing/i.test(
              txt,
            )
          ) {
            continue
          }

          const buttons = Array.from(dlg.querySelectorAll('button, [role="button"]')).filter(isVisible)
          for (const b of buttons) {
            const aria = (b.getAttribute('aria-label') || '').trim()
            const title = (b.getAttribute('title') || b.getAttribute('mattooltip') || '').trim()
            const iconText = (b.innerText || b.textContent || '').trim()
            const isCloseCross =
              /\b(close|dismiss)\b/i.test(aria) ||
              /\b(close|dismiss)\b/i.test(title) ||
              /^(close|×|✕|✖|x)$/i.test(iconText)
            const isForbiddenAction =
              /\b(select|save|confirm|upgrade|billing|link|create|enable|continue|accept)\b/i.test(
                `${aria} ${iconText}`,
              ) && !/^(close|×|✕|✖)$/i.test(iconText)

            if (isCloseCross && !isForbiddenAction) {
              b.click()
              closedAny = true
              break
            }
          }
        }
        return closedAny
      })

      if (closed) {
        this.logStep('paid API key popup closed', 'Closed paid API key / billing dialog via X button', 'info')
        await new Promise((r) => setTimeout(r, 350))
      }
      return closed
    } catch {
      return false
    }
  }

  public async dismissAnyOnboardingModals(page: Page) {
    await this.closePaidApiKeyPopupByCrossButton(page)

    for (const sel of STUDIO_SELECTORS.dismissDialogs) {
      try {
        const btn = page.locator(sel).first()
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          const isInsidePaidKeyDialog = await btn
            .evaluate((el) => {
              const dlg = el.closest('mat-dialog-container, [role="dialog"], [aria-modal="true"]') as HTMLElement | null
              const txt = (dlg?.innerText || dlg?.textContent || '').trim()
              return /paid\s+api\s+key|billing|select\s+an?\s+api\s+key|link\s+a\s+paid|pay-as-you-go/i.test(txt)
            })
            .catch(() => false)
          if (isInsidePaidKeyDialog) {
            await this.closePaidApiKeyPopupByCrossButton(page)
            continue
          }
          await btn.click({ timeout: 1500 })
          await new Promise((r) => setTimeout(r, 300))
        }
      } catch {
        /* ignore */
      }
    }
  }

  private formatClockForStudioInput(sec: number): string {
    const total = Math.max(0, Math.floor(sec))
    if (total === 0) return '0s'
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const parts: string[] = []
    if (h > 0) parts.push(`${h}h`)
    if (m > 0) parts.push(`${m}m`)
    if (s > 0) parts.push(`${s}s`)
    return parts.join('')
  }

  /**
   * Parse a clock/time string read back from Studio's video settings input
   * (e.g. "0s", "5m", "1m10s", "05:00", "1:05:00", "300", "05m 00s") into seconds.
   */
  private parseStudioClockToSec(raw: string | null | undefined): number | null {
    if (!raw) return null
    const str = raw.trim()
    if (!str) return null

    // HH:MM:SS or MM:SS
    const colonParts = str.split(':').map((p) => p.trim())
    if (colonParts.length === 2 || colonParts.length === 3) {
      const nums = colonParts.map((p) => Number(p))
      if (nums.every((n) => Number.isFinite(n) && n >= 0)) {
        if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
        return nums[0] * 60 + nums[1]
      }
    }

    // e.g. "5m 30s", "1m10s", "5m", "0s", "120s"
    const msMatch = str.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s?)?$/i)
    if (msMatch && (msMatch[1] || msMatch[2] || msMatch[3])) {
      const h = msMatch[1] ? Number(msMatch[1]) : 0
      const m = msMatch[2] ? Number(msMatch[2]) : 0
      const s = msMatch[3] ? Number(msMatch[3]) : 0
      if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
        return h * 3600 + m * 60 + s
      }
    }

    const plain = Number(str)
    return Number.isFinite(plain) && plain >= 0 ? plain : null
  }

  /**
   * Problem 2(d): Dump the Run Settings panel HTML + controls to the step log when
   * model list / thinking level dropdown selectors are not found or verification fails.
   */
  private async dumpRunSettingsPanelDiagnostics(page: Page, reason: string): Promise<void> {
    if (this.suppressDiagDumps || this.pageCrashed || page.isClosed()) return
    try {
      const dump = await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const panelCandidates = Array.from(
          document.querySelectorAll(
            'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i]), aside, .right-side-panel, [data-test-id*="run-settings" i], [data-test-id*="runsettings" i]',
          ),
        ).filter((el) => {
          if (!isVisible(el)) return false
          const r = el.getBoundingClientRect()
          return r.width >= 140 && r.height >= 100
        })

        let panelEl: HTMLElement | null = (panelCandidates[0] as HTMLElement | undefined) || null
        if (!panelEl) {
          // Fallback: find any right-side container holding Run Settings controls
          const rightContainers = Array.from(document.body.querySelectorAll('div, section, aside')).filter((el) => {
            if (!isVisible(el)) return false
            const r = el.getBoundingClientRect()
            return (
              r.left >= window.innerWidth * 0.45 &&
              r.width >= 180 &&
              r.width <= 650 &&
              r.height >= 220 &&
              /temperature|thinking|safety|resolution|token|system\s+instructions/i.test(
                (el as HTMLElement).innerText || '',
              )
            )
          })
          panelEl = (rightContainers[0] as HTMLElement) || null
        }

        const overlayPanes = Array.from(
          document.querySelectorAll('.cdk-overlay-pane, [role="listbox"], [role="menu"], [role="dialog"]'),
        )
          .filter((el) => (el.textContent || '').trim().length > 0)
          .map((el) => el.outerHTML.slice(0, 1500))
          .join(' || ')

        const panelHtml = panelEl
          ? panelEl.outerHTML.slice(0, 3000)
          : `No run-settings panel open. Body snippet: ${(document.body.innerText || '').slice(0, 800)}`

        const controls = Array.from(
          (panelEl || document.body).querySelectorAll(
            'ms-model-selector, button, mat-select, [role="combobox"], [role="listbox"], [role="option"], mat-option, mat-slide-toggle, input',
          ),
        )
          .slice(0, 45)
          .map((c) => {
            const tag = c.tagName.toLowerCase()
            const aria = c.getAttribute('aria-label') || ''
            const role = c.getAttribute('role') || ''
            const cls = (c.getAttribute('class') || '').slice(0, 60)
            const txt = ((c as HTMLElement).innerText || c.textContent || '')
              .trim()
              .replace(/\s+/g, ' ')
              .slice(0, 80)
            return `<${tag}${role ? ` role="${role}"` : ''}${aria ? ` aria="${aria}"` : ''}${cls ? ` class="${cls}"` : ''}>"${txt}"`
          })
          .join(' ; ')

        return {
          panelHtml,
          overlayHtml: overlayPanes.slice(0, 2000),
          controls: controls.slice(0, 3000),
        }
      })

      this.logStep(`diag panel HTML`, `${reason} :: ${dump.panelHtml}`, 'warn')
      if (dump.overlayHtml) {
        this.logStep(`diag overlay HTML`, dump.overlayHtml, 'warn')
      }
      this.logStep(`diag panel controls`, dump.controls || 'none', 'warn')
      console.warn(`[Studio RunSettings Diag] ${reason} :: panelHtml:`, dump.panelHtml)
      if (dump.overlayHtml) {
        console.warn(`[Studio RunSettings Diag] overlayHtml:`, dump.overlayHtml)
      }
      console.warn(`[Studio RunSettings Diag] controls:`, dump.controls)
    } catch (err) {
      const msg = (err as Error)?.message || String(err)
      if (this.isBrowserOrTargetCrashError(msg)) {
        this.pageCrashed = true
        return
      }
      this.logStep('diag panel err', msg, 'warn')
    }
  }

  /**
   * Check whether the right-hand Run Settings panel is currently open and whether its inner
   * elements (model selector and/or Thinking level dropdown) are visible in the DOM.
   * IMPORTANT: Never trust `aria-expanded` on `button[aria-label="Toggle run settings panel"]`
   * because in a new chat the panel is ALREADY OPEN by default while `aria-expanded` may be unset/false.
   */
  private async getRunSettingsPanelState(page: Page): Promise<{
    open: boolean
    hasModelSelector: boolean
    hasThinkingLevel: boolean
  }> {
    try {
      return await page.evaluate(
        ({ modelSels, thinkSels }) => {
          const isElementVisibleOnScreen = (el: Element | null): el is HTMLElement => {
            if (!el) return false
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            const style = window.getComputedStyle(h)
            return (
              r.width > 20 &&
              r.height > 14 &&
              r.right > 0 &&
              r.left < window.innerWidth &&
              r.bottom > 0 &&
              r.top < window.innerHeight &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0' &&
              h.getAttribute('aria-hidden') !== 'true'
            )
          }

          let hasModelSelector = false
          for (const sel of modelSels) {
            try {
              const nodes = Array.from(document.querySelectorAll(sel))
              if (nodes.some((n) => isElementVisibleOnScreen(n))) {
                hasModelSelector = true
                break
              }
            } catch {
              /* ignore */
            }
          }

          let hasThinkingLevel = false
          for (const sel of thinkSels) {
            try {
              const nodes = Array.from(document.querySelectorAll(sel))
              if (nodes.some((n) => isElementVisibleOnScreen(n))) {
                hasThinkingLevel = true
                break
              }
            } catch {
              /* ignore */
            }
          }

          if (!hasThinkingLevel) {
            const all = Array.from(document.body.querySelectorAll('*'))
            for (const el of all) {
              if (!isElementVisibleOnScreen(el)) continue
              if (el.children.length > 2) continue
              const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
              if (/^thinking\s*(level|budget)?$/i.test(t)) {
                hasThinkingLevel = true
                break
              }
            }
          }

          let hasContainer = false
          const containers = Array.from(
            document.querySelectorAll(
              'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, aside.runsettings-panel, div.runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i]',
            ),
          )
          for (const c of containers) {
            const r = c.getBoundingClientRect()
            if (isElementVisibleOnScreen(c) && r.left > window.innerWidth * 0.45 && r.width >= 160) {
              hasContainer = true
              break
            }
          }

          return {
            open: hasModelSelector || hasThinkingLevel || hasContainer,
            hasModelSelector,
            hasThinkingLevel,
          }
        },
        {
          modelSels: [...STUDIO_SELECTORS.modelSelectorTrigger],
          thinkSels: [...STUDIO_SELECTORS.thinkingLevelSelect],
        },
      )
    } catch {
      return { open: false, hasModelSelector: false, hasThinkingLevel: false }
    }
  }

  /**
   * Dismiss any open dropdown / menu overlay (.cdk-overlay-pane) using Escape ONLY when an overlay is open,
   * never clicking outside the panel where it could accidentally close the Run Settings panel.
   */
  private async dismissOpenOverlayIfAny(page: Page): Promise<void> {
    try {
      const hasOpenOverlay = await page.evaluate(() => {
        const activeOverlay = document.querySelector(
          '.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="listbox"], .cdk-overlay-pane mat-option, .cdk-overlay-pane [role="option"]',
        ) as HTMLElement | null
        return Boolean(activeOverlay && activeOverlay.getBoundingClientRect().height > 0)
      })
      if (hasOpenOverlay) {
        await page.keyboard.press('Escape').catch(() => {})
        await new Promise((r) => setTimeout(r, 200))
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Wait for the Run Settings panel elements (model selector, thinking level dropdown) to become
   * visible after a new chat loads (max ~5s).
   *
   * CRITICAL: In a new chat, the Run Settings panel is ALREADY OPEN by default.
   * Do NOT click `button[aria-label="Toggle run settings panel"]` when the panel is already open,
   * or it will close the panel!
   * Only if the panel is genuinely closed after waiting up to ~5s (neither model selector nor
   * thinking level is visible in DOM), click the toggle button ONCE and verify it opened.
   */
  private async waitForRunSettingsPanelElements(page: Page, maxWaitMs = 5000): Promise<{
    open: boolean
    hasModelSelector: boolean
    hasThinkingLevel: boolean
  }> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      const state = await this.getRunSettingsPanelState(page)
      if (state.hasThinkingLevel || (state.open && state.hasModelSelector)) {
        return state
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    let state = await this.getRunSettingsPanelState(page)
    if (state.open) {
      return state
    }

    // Panel is genuinely closed even after waiting 5s -> click toggle ONCE to open it
    this.logStep(
      'opening run settings',
      'Panel confirmed closed after 5s wait -> clicking Toggle run settings panel once',
      'info',
    )
    const toggle = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runSettingsToggle, 2000)
    if (toggle) {
      await toggle.click().catch(() => {})
    } else {
      await page
        .evaluate(() => {
          const btn = document.querySelector(
            'button[aria-label="Toggle run settings panel" i], button.runsettings-toggle-button',
          ) as HTMLElement | null
          if (btn) btn.click()
        })
        .catch(() => {})
    }

    const afterClickDeadline = Date.now() + 5000
    while (Date.now() < afterClickDeadline) {
      await new Promise((r) => setTimeout(r, 250))
      state = await this.getRunSettingsPanelState(page)
      if (state.hasThinkingLevel || state.open) {
        return state
      }
    }

    return await this.getRunSettingsPanelState(page)
  }

  /**
   * Read the currently visible model card text at the top of the Run Settings panel.
   * Excludes the center-page welcome heading ("Start building with Gemini 3.8 Flash").
   */
  private async readVisibleModelCardText(page: Page): Promise<string> {
    try {
      return await page.evaluate((triggerSels) => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const isWelcomeHeading = (txt: string) => /^start\s+building\s+with\b/i.test(txt)

        for (const sel of triggerSels) {
          const nodes = Array.from(document.querySelectorAll(sel))
          for (const node of nodes) {
            if (!isVisible(node)) continue
            const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
            if (
              t &&
              !isWelcomeHeading(t) &&
              (/\bargon\b/i.test(t) || /gemini/i.test(t) || /3\.[678]/i.test(t) || /2\.5/i.test(t))
            ) {
              return t
            }
          }
        }

        // Search inside the Run Settings panel (or right-hand panel region) for the model card
        const panelRoot =
          (Array.from(
            document.querySelectorAll(
              'ms-run-settings, ms-runsettings, ms-run-settings-panel, ms-runsettings-panel, [class*="runsettings-panel" i], [class*="run-settings-panel" i], [class*="runsettings" i]:not(button):not([class*="toggle" i]), [class*="run-settings" i]:not(button):not([class*="toggle" i])',
            ),
          ).find((el) => isVisible(el) && el.getBoundingClientRect().width >= 150) as HTMLElement | undefined) ||
          null

        const searchRoot = panelRoot || document.body
        const all = Array.from(
          searchRoot.querySelectorAll(
            'ms-model-selector, [class*="model-selector" i], [data-test-id*="model" i], button, a, [role="button"], [role="combobox"], div, span',
          ),
        )
        for (const node of all) {
          if (!isVisible(node)) continue
          const r = node.getBoundingClientRect()
          // If searching document.body, restrict to right-hand Run Settings area and exclude center welcome card
          if (!panelRoot && r.left < window.innerWidth * 0.45) continue
          if (r.height > 150 || r.width > 550 || r.width < 40) continue
          const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
          if (!t || isWelcomeHeading(t)) continue
          if (
            /\bargon\b/i.test(t) ||
            /^gemini[\s-]+\d+(\.\d+)?/i.test(t) ||
            /\bgemini[\s-]+3\.[678]\b/i.test(t) ||
            /\bgemini[\s-]+2\.5\b/i.test(t)
          ) {
            return t
          }
        }
        return ''
      }, [...STUDIO_SELECTORS.modelSelectorTrigger])
    } catch {
      return ''
    }
  }

  /**
   * Select a specific model ("Argon", "Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.6 Flash")
   * in the Run Settings panel.
   * - Supports name-based matching for "Argon" (/argon/i) and version+flash matching for 3.8/3.7/3.6.
   * - If a paid API key / billing popup appears when selecting "Argon", closes it ONLY via its X button,
   *   reads back the active model, and if "Argon" is not selected, treats Argon as unavailable for this window
   *   and falls back to the next model in the chain.
   */
  private async selectModelInRunSettings(
    page: Page,
    targetModelName: string,
    fallbackChain?: string[],
  ): Promise<{ selectedModelName: string; visibleCardText: string }> {
    const chain =
      fallbackChain && fallbackChain.length > 0
        ? fallbackChain
        : buildStudioModelChain(targetModelName || DEFAULT_STUDIO_MODEL_NAME)

    const trySelectSingleModel = async (
      desiredRaw: string,
    ): Promise<{ matched: boolean; cardText: string }> => {
      const desired = (desiredRaw || DEFAULT_STUDIO_MODEL_NAME).trim()
      const isArgon = /\bargon\b/i.test(desired)
      const versionMatch = isArgon ? null : desired.match(/(\d+\.\d+)/)
      const desiredVersion = versionMatch ? versionMatch[1] : ''
      const isFlash = /flash/i.test(desired)

      const matchesDesired = (text: string): boolean => {
        if (!text) return false
        if (isArgon) {
          return /\bargon\b/i.test(text)
        }
        if (desiredVersion) {
          const hasVer = text.includes(desiredVersion)
          const hasVariant = !isFlash || /flash/i.test(text)
          return hasVer && hasVariant
        }
        return text.toLowerCase().includes(desired.toLowerCase())
      }

      const currentCardText = await this.readVisibleModelCardText(page)
      if (matchesDesired(currentCardText)) {
        return { matched: true, cardText: currentCardText }
      }

      this.logStep(
        'selecting model',
        `Switching model to "${desired}" (current="${currentCardText || 'default'}")`,
        'info',
      )

      const trigger = await findFirstVisibleLocator(page, STUDIO_SELECTORS.modelSelectorTrigger, 2500)
      if (!trigger) {
        return { matched: matchesDesired(currentCardText), cardText: currentCardText || desired }
      }

      await trigger.click().catch(() => {})
      await new Promise((r) => setTimeout(r, 450))

      const clickedModel = await page
        .evaluate(
          ({ ver, wantFlash, wantArgon, fullLabel }) => {
            const isVisible = (el: Element | null): el is HTMLElement => {
              if (!el) return false
              const h = el as HTMLElement
              const r = h.getBoundingClientRect()
              return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
            }

            const roots = Array.from(
              document.querySelectorAll(
                '.cdk-overlay-pane, mat-dialog-container, [role="listbox"], [role="menu"], ms-model-carousel, [class*="model-list" i], [class*="model-picker" i]',
              ),
            ).filter((el) => isVisible(el))

            const candidates: HTMLElement[] = []
            for (const root of roots) {
              root
                .querySelectorAll(
                  'mat-option, [role="option"], [role="menuitem"], button, [class*="model-card" i], [class*="model-item" i], [class*="model-row" i]',
                )
                .forEach((n) => {
                  if (isVisible(n)) candidates.push(n as HTMLElement)
                })
            }

            for (const c of candidates) {
              const txt = (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ')
              if (!txt) continue
              if (wantArgon) {
                if (/\bargon\b/i.test(txt)) {
                  c.click()
                  return txt
                }
              } else if (ver) {
                if (txt.includes(ver) && (!wantFlash || /flash/i.test(txt)) && !/lite/i.test(txt)) {
                  c.click()
                  return txt
                }
              } else if (txt.toLowerCase().includes(fullLabel.toLowerCase())) {
                c.click()
                return txt
              }
            }
            return null
          },
          { ver: desiredVersion, wantFlash: isFlash, wantArgon: isArgon, fullLabel: desired },
        )
        .catch(() => null)

      await new Promise((r) => setTimeout(r, 450))

      // Requirement 2: If selecting "Argon" (or any model) opened a "paid API key" / billing popup,
      // close it ONLY via its cross (X) button.
      await this.closePaidApiKeyPopupByCrossButton(page)
      await this.dismissOpenOverlayIfAny(page)

      const updatedCardText = (await this.readVisibleModelCardText(page)) || ''
      const verified = matchesDesired(updatedCardText) || (!isArgon && Boolean(clickedModel))
      return {
        matched: verified,
        cardText: updatedCardText || (verified ? clickedModel || desired : ''),
      }
    }

    const startCanonical = canonicalizeStudioModelName(targetModelName)
    const startIdx = Math.max(
      0,
      chain.findIndex((m) => canonicalizeStudioModelName(m).toLowerCase() === startCanonical.toLowerCase()),
    )

    for (let i = startIdx; i < chain.length; i++) {
      const candidateModel = chain[i]
      const res = await trySelectSingleModel(candidateModel)
      if (res.matched) {
        this.logStep('model selected', `Active model in Run Settings: ${res.cardText || candidateModel}`, 'info')
        return {
          selectedModelName: canonicalizeStudioModelName(candidateModel),
          visibleCardText: res.cardText || candidateModel,
        }
      }

      const nextFallback = chain[i + 1]
      if (nextFallback) {
        this.logStep(
          'model unavailable',
          `"${candidateModel}" unavailable after selection/popup close (readBack="${res.cardText || 'none'}") -> falling back to "${nextFallback}"`,
          'warn',
        )
      }
    }

    const fallbackCard = (await this.readVisibleModelCardText(page)) || targetModelName
    return {
      selectedModelName: canonicalizeStudioModelName(targetModelName),
      visibleCardText: fallbackCard,
    }
  }

  /**
   * Read the currently visible text of the "Thinking level" dropdown in the Run Settings panel.
   */
  private async readVisibleThinkingLevelText(page: Page): Promise<string> {
    try {
      return await page.evaluate((thinkSels) => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        for (const sel of thinkSels) {
          const nodes = Array.from(document.querySelectorAll(sel))
          for (const node of nodes) {
            if (!isVisible(node)) continue
            const t = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')
            if (t) return t
          }
        }

        // Row-scoped lookup: find the compact row containing "Thinking level" (or "Thinking budget") and read its dropdown/button/selected value
        const all = Array.from(document.body.querySelectorAll('*'))
        const labelNodes = all.filter((el) => {
          if (!isVisible(el)) return false
          const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
          return /^thinking\s+(level|budget)$/i.test(t)
        })

        for (const lbl of labelNodes) {
          let row: Element | null = lbl.parentElement
          for (let depth = 0; depth < 6 && row; depth++) {
            const r = row.getBoundingClientRect()
            if (r.height >= 18 && r.height <= 160 && r.width <= 600) {
              // Check for active/checked segmented button first (if rendered as Low/Medium/High buttons)
              const pressedBtn = row.querySelector(
                'button[aria-pressed="true"], button[aria-selected="true"], .mat-button-toggle-checked, [class*="active" i][role="button"], [class*="selected" i] button',
              ) as HTMLElement | null
              if (pressedBtn && isVisible(pressedBtn)) {
                const pVal = (pressedBtn.innerText || pressedBtn.textContent || '').trim().replace(/\s+/g, ' ')
                if (pVal) return pVal
              }

              const ctrl = row.querySelector(
                'mat-select, [role="combobox"], button[aria-haspopup], select, .mat-mdc-select-value, .mat-mdc-select-trigger, button:not([aria-label*="info" i]):not([aria-label*="help" i]):not([role="switch"])',
              ) as HTMLElement | null
              if (ctrl && isVisible(ctrl) && ctrl !== lbl && !ctrl.contains(lbl)) {
                const val = (ctrl.innerText || ctrl.textContent || (ctrl as HTMLInputElement).value || '')
                  .trim()
                  .replace(/\s+/g, ' ')
                if (val && !/^thinking\s+(level|budget)$/i.test(val)) {
                  return val
                }
              }
            }
            row = row.parentElement
          }
        }
        return ''
      }, [...STUDIO_SELECTORS.thinkingLevelSelect])
    } catch {
      return ''
    }
  }

  /**
   * Tag the dropdown control (mat-select / [role="combobox"] / button) inside a compact
   * Run Settings row identified by its label text (e.g. "Thinking level" or "Media resolution")
   * with `data-cmt-row-select="<attrVal>"` so Playwright can click it without matching unrelated dropdowns.
   */
  private async markRowDropdownByLabel(
    page: Page,
    rowLabelRegexSource: string,
    attrVal: string,
  ): Promise<boolean> {
    try {
      return await page.evaluate(
        ({ regexSrc, marker }) => {
          document
            .querySelectorAll(`[data-cmt-row-select="${marker}"]`)
            .forEach((el) => el.removeAttribute('data-cmt-row-select'))

          const re = new RegExp(regexSrc, 'i')
          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!el) return false
            const h = el as HTMLElement
            const r = h.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
          }

          const all = Array.from(document.body.querySelectorAll('*'))
          const labelLeaves = all.filter((el) => {
            if (!isVisible(el)) return false
            if (el.children.length > 2) return false
            const t = ((el as HTMLElement).innerText || el.textContent || '').trim()
            return re.test(t) && t.length <= 40
          })

          for (const leaf of labelLeaves) {
            let row: Element | null = leaf.parentElement
            for (let depth = 0; depth < 6 && row; depth++) {
              const r = row.getBoundingClientRect()
              if (r.height >= 18 && r.height <= 165 && r.width <= 600) {
                const ctrl = row.querySelector(
                  'mat-select, [role="combobox"], button[aria-haspopup], select, .mat-mdc-select-trigger, button:not([aria-label*="info" i]):not([aria-label*="help" i]):not([role="switch"])',
                ) as HTMLElement | null
                if (ctrl && isVisible(ctrl) && ctrl !== leaf && !ctrl.contains(leaf)) {
                  ctrl.setAttribute('data-cmt-row-select', marker)
                  return true
                }
              }
              row = row.parentElement
            }
          }
          return false
        },
        { regexSrc: rowLabelRegexSource, marker: attrVal },
      )
    } catch {
      return false
    }
  }

  /**
   * Step (b):
   * - In a new chat, the Run Settings panel (tune / three-dot panel) is ALREADY OPEN by default.
   * - Do NOT click `button[aria-label="Toggle run settings panel"]` on new chat load (doing so closes the panel!).
   * - Flow: wait for panel elements (model selector, thinking level dropdown) to appear (max ~5s) ->
   *   select model (or fallback model) and set Thinking = High directly.
   * - Never click outside the panel while configuring. After dropdown selection, verify the panel is still open.
   * - If the dropdown is still not found, log "not found" along with the current panel state (open/closed).
   */
  private async configureRunSettings(
    page: Page,
    config: {
      modelName: string
      maxOutputTokens: number
      thinkingLevel?: StudioThinkingLevel
      fallbackChain?: string[]
    },
    scope?: { scanId?: string | null; username?: string | null },
  ): Promise<{ selectedModelName: string; visibleCardText: string }> {
    await this.waitIfPausedOrThrowIfStopped(scope)

    // 0. Wait up to ~5s for the already-open Run Settings panel elements to appear in DOM.
    // Only clicks Toggle run settings panel ONCE if the panel is genuinely closed after waiting.
    const initialPanelState = await this.waitForRunSettingsPanelElements(page, 5000)
    if (!initialPanelState.open) {
      const stateLabel = initialPanelState.open ? 'khula (open)' : 'band (closed)'
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `Run settings panel not open after wait (panel=${stateLabel})`,
      )
      throw new Error(
        `Studio thinking level config failed: Run settings panel not found (panel=${stateLabel})`,
      )
    }

    // 1. Select requested or fallback model ("Argon", "Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.6 Flash")
    const modelSelection = await this.selectModelInRunSettings(
      page,
      config.modelName,
      config.fallbackChain,
    )
    const activeModelText = modelSelection.visibleCardText

    // 2. Set "Thinking level" dropdown to user's chosen level (High / Medium / Low, default High) & READ BACK visible value
    const desiredThinkingLabel = thinkingLevelToDisplayLabel(config.thinkingLevel)
    const desiredThinkingRegex = new RegExp(`\\b${desiredThinkingLabel}\\b`, 'i')
    let verifiedThinkingText = ''
    let thinkingConfigError = ''

    for (let thinkAttempt = 1; thinkAttempt <= 2; thinkAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      thinkingConfigError = ''

      // If there is a Thinking mode toggle switch that is currently unchecked, enable it first
      try {
        const thinkSwitch = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingToggle, 500)
        if (thinkSwitch) {
          const checked = await thinkSwitch.getAttribute('aria-checked')
          if (checked === 'false') {
            await thinkSwitch.click().catch(() => {})
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      } catch {
        /* ignore */
      }

      // Search for Thinking level dropdown inside the open Run Settings panel
      let thinkSelect = await findFirstVisibleLocator(page, STUDIO_SELECTORS.thinkingLevelSelect, 3000)
      if (!thinkSelect) {
        const markedThink = await this.markRowDropdownByLabel(
          page,
          '^thinking(\\s+level|\\s+budget)?$',
          'thinking-level',
        )
        if (markedThink) {
          thinkSelect = page.locator('[data-cmt-row-select="thinking-level"]').first()
        }
      }

      if (!thinkSelect || (await thinkSelect.count()) === 0) {
        const pState = await this.getRunSettingsPanelState(page)
        const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
        thinkingConfigError = `Thinking level dropdown selector not found (panel=${stateDesc}, modelSelector=${pState.hasModelSelector}, thinkingLevel=${pState.hasThinkingLevel})`
        if (thinkAttempt >= 2) {
          await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
        }
      } else {
        const beforeThink = await this.readVisibleThinkingLevelText(page)
        if (!desiredThinkingRegex.test(beforeThink)) {
          await thinkSelect.scrollIntoViewIfNeeded().catch(() => {})
          await thinkSelect.click().catch(() => {})
          await new Promise((r) => setTimeout(r, 350))

          // Click the desired option ("High" / "Medium" / "Low") strictly inside the opened overlay pane
          const targetOpt = page
            .locator(
              `.cdk-overlay-pane mat-option:has-text("${desiredThinkingLabel}"), .cdk-overlay-pane [role="option"]:has-text("${desiredThinkingLabel}"), .cdk-overlay-pane [role="menuitem"]:has-text("${desiredThinkingLabel}"), mat-option:has-text("${desiredThinkingLabel}"), [role="option"]:has-text("${desiredThinkingLabel}")`,
            )
            .first()

          if ((await targetOpt.count()) > 0 && (await targetOpt.isVisible().catch(() => false))) {
            await targetOpt.click().catch(() => {})
            await new Promise((r) => setTimeout(r, 350))
          } else {
            const pState = await this.getRunSettingsPanelState(page)
            const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
            thinkingConfigError = `"${desiredThinkingLabel}" option not found after opening Thinking level dropdown (panel=${stateDesc})`
            if (thinkAttempt >= 2) {
              await this.dumpRunSettingsPanelDiagnostics(page, `${thinkingConfigError} (attempt ${thinkAttempt}/2)`)
            }
            await this.dismissOpenOverlayIfAny(page)
          }
        }

        // Verify panel is still open after dropdown selection (do not toggle if closed, just check state)
        const postSelectState = await this.getRunSettingsPanelState(page)
        const readBackThink = await this.readVisibleThinkingLevelText(page)
        if (desiredThinkingRegex.test(readBackThink)) {
          verifiedThinkingText = readBackThink
          break
        }
        if (!thinkingConfigError) {
          const stateDesc = postSelectState.open ? 'khula (open)' : 'band (closed)'
          thinkingConfigError = `expected "${desiredThinkingLabel}", read back "${readBackThink || 'empty'}" (panel=${stateDesc})`
        }
        if (thinkAttempt >= 2) {
          await this.dumpRunSettingsPanelDiagnostics(page, `thinking level read-back mismatch: ${thinkingConfigError}`)
        }
      }

      if (thinkAttempt >= 2 && thinkingConfigError) {
        throw new Error(`Studio thinking level config failed: ${thinkingConfigError}`)
      }
    }

    // 3. Ensure Advanced Settings is expanded if needed for Output length (do not collapse if already expanded)
    try {
      const outputLengthVisible = await page
        .evaluate(() => /output\s+length/i.test(document.body.innerText || ''))
        .catch(() => false)

      if (!outputLengthVisible) {
        const advBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.advancedSettingsToggle, 1000)
        if (advBtn) {
          const expanded = await advBtn.getAttribute('aria-expanded')
          if (expanded === 'false') {
            await advBtn.click()
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 4. Set Output length (maxOutputTokens) if needed
    try {
      const maxOutInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.maxOutputTokensInput, 1200)
      if (maxOutInput) {
        const currentMaxOut = await maxOutInput.inputValue().catch(() => '')
        const desiredMaxOut = String(config.maxOutputTokens || 65536)
        if (currentMaxOut.trim() !== desiredMaxOut) {
          await maxOutInput.click({ clickCount: 3 })
          await maxOutInput.fill(desiredMaxOut)
          await maxOutInput.press('Enter')
        }
      }
    } catch {
      /* ignore */
    }

    // 5. Optional: Turn OFF "Grounding with Google Search" in Run Settings if it is currently ON
    try {
      const turnedOffGrounding = await page
        .evaluate(() => {
          const switches = Array.from(
            document.querySelectorAll(
              'button[role="switch"], mat-slide-toggle button, [role="switch"]',
            ),
          )
          for (const sw of switches) {
            const el = sw as HTMLElement
            const aria = (el.getAttribute('aria-label') || '').toLowerCase()
            const row = el.closest(
              'mat-slide-toggle, .run-settings-row, .settings-item, .tool-row, div',
            ) as HTMLElement | null
            const rowText = (row?.innerText || row?.textContent || '').toLowerCase()
            if (
              aria.includes('grounding') ||
              aria.includes('google search') ||
              /grounding\s+with\s+google\s+search/i.test(rowText)
            ) {
              if (el.getAttribute('aria-checked') === 'true') {
                el.click()
                return true
              }
            }
          }
          return false
        })
        .catch(() => false)
      if (turnedOffGrounding) {
        this.logStep('grounding toggle off', 'Disabled Grounding with Google Search', 'info')
        await new Promise((r) => setTimeout(r, 250))
      }
    } catch {
      /* ignore */
    }

    // Final read-back verification (keep Run Settings panel open — do NOT click Toggle run settings panel)
    const finalThinkingReadBack = (await this.readVisibleThinkingLevelText(page)) || verifiedThinkingText
    if (!desiredThinkingRegex.test(finalThinkingReadBack)) {
      const pState = await this.getRunSettingsPanelState(page)
      const stateDesc = pState.open ? 'khula (open)' : 'band (closed)'
      await this.dumpRunSettingsPanelDiagnostics(
        page,
        `final thinking read-back check failed: "${finalThinkingReadBack}" (panel=${stateDesc})`,
      )
      throw new Error(
        `Studio thinking level config failed: expected "${desiredThinkingLabel}", read back "${finalThinkingReadBack || 'empty'}" (panel=${stateDesc})`,
      )
    }

    this.logStep(
      'model set',
      `thinking=${desiredThinkingLabel} · model=${activeModelText || modelSelection.selectedModelName || config.modelName || 'default'}`,
      'success',
    )
    return modelSelection
  }

  /**
   * Problem 1(a): Detect chips by anchoring on button[aria-label="Edit video options" i]
   * (and/or button[aria-label="Remove media" i]).
   * A chip = the nearest ancestor of that button that contains BOTH:
   *   - exactly one Edit button (button[aria-label="Edit video options" i] / video options)
   *   - and one Remove button (button[aria-label="Remove media" i]).
   * Tags each detected chip with `data-cmt-fallback-chip="true"` (keeping ms-* CSS selectors as primary).
   * No filename or "N tokens" text dependency.
   */
  private async syncFallbackMediaChips(page: Page, _uploadedBasename?: string): Promise<void> {
    const primarySelector = STUDIO_SELECTORS.videoMediaChipsCss.join(', ')
    await page
      .evaluate((primarySel) => {
        try {
          document
            .querySelectorAll('[data-cmt-fallback-chip]')
            .forEach((el) => el.removeAttribute('data-cmt-fallback-chip'))
        } catch {
          /* ignore */
        }

        const primarySet = new Set<Element>()
        if (primarySel) {
          try {
            Array.from(document.querySelectorAll(primarySel)).forEach((el) => primarySet.add(el))
          } catch {
            /* ignore */
          }
        }

        const editBtnSel =
          'button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i], [role="button"][aria-label*="Edit video options" i]'
        const removeBtnSel =
          'button[aria-label="Remove media" i], button[aria-label*="Remove media" i], [role="button"][aria-label*="Remove media" i]'

        let editButtons: Element[] = []
        try {
          editButtons = Array.from(document.body.querySelectorAll(editBtnSel))
        } catch {
          editButtons = []
        }

        const foundChips: Element[] = []

        for (const editBtn of editButtons) {
          let curr: Element | null = editBtn.parentElement
          for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
            let editCount = 0
            let removeCount = 0
            try {
              editCount = curr.querySelectorAll(editBtnSel).length
            } catch {
              editCount = 0
            }
            try {
              removeCount = curr.querySelectorAll(removeBtnSel).length
            } catch {
              removeCount = 0
            }
            if (editCount === 1 && removeCount === 1) {
              if (!foundChips.includes(curr)) {
                foundChips.push(curr)
              }
              break
            }
            // If we climbed too high and now contain multiple Edit buttons, stop
            if (editCount > 1) {
              break
            }
            curr = curr.parentElement
          }
        }

        // Fallback if only Remove media + gear icon button exist inside the chip
        if (foundChips.length === 0) {
          let removeButtons: Element[] = []
          try {
            removeButtons = Array.from(document.body.querySelectorAll(removeBtnSel))
          } catch {
            removeButtons = []
          }
          for (const remBtn of removeButtons) {
            let curr: Element | null = remBtn.parentElement
            for (let depth = 0; depth < 8 && curr && curr !== document.body; depth++) {
              let removeCount = 0
              let allBtns = 0
              try {
                removeCount = curr.querySelectorAll(removeBtnSel).length
              } catch {
                removeCount = 0
              }
              try {
                allBtns = curr.querySelectorAll('button, [role="button"]').length
              } catch {
                allBtns = 0
              }
              if (removeCount === 1 && allBtns === 2) {
                if (!foundChips.includes(curr)) {
                  foundChips.push(curr)
                }
                break
              }
              if (removeCount > 1) break
              curr = curr.parentElement
            }
          }
        }

        for (const chip of foundChips) {
          const alreadyCovered = Array.from(primarySet).some(
            (p) => p === chip || p.contains(chip) || chip.contains(p),
          )
          if (!alreadyCovered) {
            chip.setAttribute('data-cmt-fallback-chip', 'true')
          }
        }
      }, primarySelector)
      .catch((err: unknown) => {
        this.logStep('chip sync error', (err as Error)?.message || String(err), 'warn')
      })
  }

  /**
   * Read the top header token count silently (without logging to step log on every poll tick).
   */
  private async readHeaderTokenCountSilent(page: Page): Promise<number> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        let headerTokens = 0
        try {
          const topNodes = Array.from(document.body.querySelectorAll('span, div, button, p'))
          for (const node of topNodes) {
            if (!isVisible(node)) continue
            const r = node.getBoundingClientRect()
            if (r.top < 0 || r.top > 120 || r.height > 65) continue
            const txt = ((node as HTMLElement).innerText || node.textContent || '').trim()
            if (txt.length > 80) continue
            const m = txt.match(/([\d,]+)\s*(?:\/\s*[\d,]+\s*)?tokens?\b/i)
            if (m) {
              const val = parseInt(m[1].replace(/,/g, ''), 10)
              if (Number.isFinite(val) && val > headerTokens) {
                headerTokens = val
              }
            }
          }
        } catch {
          /* ignore */
        }
        return headerTokens
      })
    } catch {
      return 0
    }
  }

  /**
   * Requirement 1: Dump detailed DOM diagnostics via this.logStep + save screenshot to DATA_DIR
   * before throwing when media chip count does not increase.
   */
  private async dumpChipAttachDiagnostics(
    page: Page,
    label: string,
    uploadedBasename: string,
  ): Promise<void> {
    if (this.suppressDiagDumps || this.pageCrashed || page.isClosed()) return
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const shotPath = path.join(DATA_DIR, `studio-attach-fail-${label}-${Date.now()}.png`)
      await page.screenshot({ path: shotPath, fullPage: true })
      this.logStep('diag screenshot', `Saved to ${shotPath}`, 'warn')
    } catch (shotErr) {
      const msg = (shotErr as Error)?.message || String(shotErr)
      if (this.isBrowserOrTargetCrashError(msg)) {
        this.pageCrashed = true
        return
      }
      this.logStep('diag screenshot err', msg, 'warn')
    }

    if (this.pageCrashed || page.isClosed()) return
    try {
      const diag = await page.evaluate((basename) => {
        const needle = (basename || '.mp4').toLowerCase()
        const all = Array.from(document.body.querySelectorAll('*'))
        const matching = all.filter((el) => {
          if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false
          const t = ((el as HTMLElement).innerText || el.textContent || '').toLowerCase()
          return t.includes(needle)
        })

        // Smallest element whose text contains the uploaded file's basename (has no child also matching, or shortest outerHTML)
        const smallest =
          matching
            .filter((el) => !matching.some((child) => child !== el && el.contains(child)))
            .sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0] || null

        const editBtns = Array.from(
          document.body.querySelectorAll(
            'button[aria-label*="Edit video" i], button[aria-label*="Remove media" i], button[aria-label*="video" i]',
          ),
        ).map(
          (b) =>
            `aria="${b.getAttribute('aria-label') || ''}" text="${(b.textContent || '').trim()}" parent=<${b.parentElement?.tagName.toLowerCase() || ''} class="${b.parentElement?.getAttribute('class') || ''}">`,
        )

        if (!smallest) {
          return {
            found: false,
            outerHtml: `No element found containing "${basename}". Video buttons: ${editBtns.join(' | ') || 'none'}. Body snippet: ${(document.body.innerText || '').slice(0, 500)}`,
            ancestors: 'none',
            buttons: editBtns.join(' ; ') || 'none',
          }
        }

        // (a) outerHTML (max 3000 chars) of the smallest element (plus its L2 parent if smallest is just a leaf text node)
        const smallestHtml = smallest.outerHTML.slice(0, 1500)
        const parent2Html =
          smallest.parentElement?.parentElement?.outerHTML.slice(0, 1500) ||
          smallest.parentElement?.outerHTML.slice(0, 1500) ||
          ''
        const combinedOuterHtml = (
          parent2Html && parent2Html !== smallestHtml
            ? `[smallest]: ${smallestHtml} | [ancestor-L2]: ${parent2Html}`
            : smallestHtml
        ).slice(0, 3000)

        // (b) ancestor tag names / classes / aria-labels up 4 levels
        const ancestorDescriptions: string[] = []
        let curr: Element | null = smallest
        for (let level = 0; level <= 4 && curr; level++) {
          const tag = curr.tagName.toLowerCase()
          const cls = (curr.getAttribute('class') || '').trim()
          const aria = (curr.getAttribute('aria-label') || '').trim()
          ancestorDescriptions.push(
            `L${level}: <${tag}${cls ? ` class="${cls}"` : ''}${aria ? ` aria-label="${aria}"` : ''}>`,
          )
          curr = curr.parentElement
        }

        // (c) all button aria-labels inside it (and inside up to 4 ancestor levels + page video buttons)
        const searchRoot =
          smallest.parentElement?.parentElement?.parentElement?.parentElement ||
          smallest.parentElement?.parentElement ||
          smallest
        const btnsInsideSmallest = Array.from(smallest.querySelectorAll('button, [role="button"]')).map(
          (b) =>
            `[in-smallest] aria="${b.getAttribute('aria-label') || ''}" tooltip="${b.getAttribute('mattooltip') || ''}" text="${(b.textContent || '').trim()}"`,
        )
        const btnsInsideChipRoot = Array.from(searchRoot.querySelectorAll('button, [role="button"]')).map(
          (b) =>
            `[in-L4] aria="${b.getAttribute('aria-label') || ''}" tooltip="${b.getAttribute('mattooltip') || ''}" text="${(b.textContent || '').trim()}"`,
        )

        return {
          found: true,
          outerHtml: combinedOuterHtml,
          ancestors: ancestorDescriptions.join(' -> '),
          buttons:
            [...btnsInsideSmallest, ...btnsInsideChipRoot, ...editBtns].join(' ; ') ||
            'no buttons found',
        }
      }, uploadedBasename)

      this.logStep(`diag (a) outerHTML [${label}]`, diag.outerHtml, 'warn')
      this.logStep(`diag (b) ancestors [${label}]`, diag.ancestors, 'warn')
      this.logStep(`diag (c) buttons [${label}]`, diag.buttons, 'warn')
      console.warn(`[Studio Attach Diag - ${label}] (a) outerHTML:`, diag.outerHtml)
      console.warn(`[Studio Attach Diag - ${label}] (b) ancestors:`, diag.ancestors)
      console.warn(`[Studio Attach Diag - ${label}] (c) buttons:`, diag.buttons)
    } catch (diagErr) {
      const msg = (diagErr as Error)?.message || String(diagErr)
      if (this.isBrowserOrTargetCrashError(msg)) {
        this.pageCrashed = true
        return
      }
      this.logStep('diag eval err', msg, 'warn')
    }
  }

  /**
   * Problem 1(c): Dump open Video Settings dialog / popover DOM + all inputs when start/end/FPS inputs are not found.
   */
  private async dumpVideoDialogDiagnostics(page: Page, label: string, reason: string): Promise<void> {
    if (this.suppressDiagDumps || this.pageCrashed || page.isClosed()) return
    try {
      const dump = await page.evaluate(() => {
        // Prioritize non-empty dialog / overlay panes that contain inputs or buttons (skipping empty tooltip panes)
        const candidates = Array.from(
          document.querySelectorAll(
            'mat-dialog-container, [role="dialog"], .cdk-overlay-pane, [class*="video-options" i], [class*="video-settings" i]',
          ),
        ).filter((el) => (el.innerHTML || '').trim().length > 0)

        const bestDialog =
          candidates.find((el) => el.querySelectorAll('input').length > 0) ||
          candidates[candidates.length - 1] ||
          null

        const dialogHtml = bestDialog
          ? bestDialog.outerHTML.slice(0, 3000)
          : 'No non-empty mat-dialog-container / [role="dialog"] / .cdk-overlay-pane found in DOM'

        const inputs = Array.from(document.querySelectorAll('input'))
          .map((inp) => {
            const fieldLabel =
              inp.closest('mat-form-field, label, div')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || ''
            return `<input type="${inp.type}" id="${inp.id || ''}" name="${inp.name || ''}" aria-label="${inp.getAttribute('aria-label') || ''}" placeholder="${inp.getAttribute('placeholder') || ''}" value="${inp.value}" label="${fieldLabel}">`
          })
          .join(' | ')
        return { dialogHtml, inputs }
      })
      this.logStep(`diag dialog HTML [${label}]`, `${reason} :: ${dump.dialogHtml}`, 'warn')
      this.logStep(`diag dialog inputs [${label}]`, dump.inputs || 'no inputs on page', 'warn')
      console.warn(`[Studio Dialog Diag - ${label}] ${reason} ::`, dump.dialogHtml)
      console.warn(`[Studio Dialog Diag - ${label}] inputs:`, dump.inputs)
    } catch (err) {
      const msg = (err as Error)?.message || String(err)
      if (this.isBrowserOrTargetCrashError(msg)) {
        this.pageCrashed = true
        return
      }
      this.logStep('diag dialog err', msg, 'warn')
    }
  }

  /**
   * Tag the Start Time, End Time, FPS inputs and Save button inside the open "Video settings" dialog
   * (shown at 02:04-02:50 in the user's video: "Start Time (e.g., 1m10s)", "End Time (e.g., 2m30s)",
   * "FPS (frames per second)" with placeholder "Defaults to 1 FPS", and buttons "Cancel" / "Save").
   */
  private async tagVideoSettingsDialogControls(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        document
          .querySelectorAll('[data-cmt-video-input]')
          .forEach((el) => el.removeAttribute('data-cmt-video-input'))
        document
          .querySelectorAll('[data-cmt-video-save]')
          .forEach((el) => el.removeAttribute('data-cmt-video-save'))

        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        const dialogs = Array.from(
          document.querySelectorAll(
            'mat-dialog-container, [role="dialog"], .cdk-overlay-pane, [class*="video-settings" i], [class*="video-options" i]',
          ),
        ).filter((el) => isVisible(el) && el.querySelectorAll('input').length >= 2)

        const root = dialogs[dialogs.length - 1] || document.body
        const visibleInputs = Array.from(root.querySelectorAll('input')).filter(
          (inp) => isVisible(inp) && inp.type !== 'file' && inp.type !== 'checkbox' && inp.type !== 'hidden',
        )

        let taggedStart = false
        let taggedEnd = false
        let taggedFps = false

        for (const inp of visibleInputs) {
          const contextText = (
            (inp.getAttribute('aria-label') || '') +
            ' ' +
            (inp.getAttribute('placeholder') || '') +
            ' ' +
            (inp.closest('mat-form-field, label, .form-field, div')?.textContent || '')
          )
            .toLowerCase()
            .replace(/\s+/g, ' ')

          if (!taggedStart && /start\s*time|1m10s/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'start')
            taggedStart = true
          } else if (!taggedEnd && /end\s*time|2m30s/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'end')
            taggedEnd = true
          } else if (!taggedFps && /\bfps\b|frames\s+per\s+second|defaults\s+to\s+1\s+fps/i.test(contextText)) {
            inp.setAttribute('data-cmt-video-input', 'fps')
            taggedFps = true
          }
        }

        // Positional fallback if inside a dialog with exactly 3 visible inputs (Start Time, End Time, FPS)
        if (dialogs.length > 0 && visibleInputs.length === 3) {
          if (!taggedStart) visibleInputs[0].setAttribute('data-cmt-video-input', 'start')
          if (!taggedEnd) visibleInputs[1].setAttribute('data-cmt-video-input', 'end')
          if (!taggedFps) visibleInputs[2].setAttribute('data-cmt-video-input', 'fps')
        }

        // Tag the Save button (never Cancel or Close)
        const btns = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isVisible)
        for (const b of btns) {
          const txt = (b.innerText || b.textContent || '').trim()
          if (/^save$/i.test(txt) || /^apply$/i.test(txt) || /^done$/i.test(txt)) {
            b.setAttribute('data-cmt-video-save', 'true')
            break
          }
        }
      })
      .catch(() => {})
  }

  /**
   * FIX 1: Attach a YouTube link or Drive file or local file as a video asset in the prompt,
   * verify media chip count increased (or Remove media button count / header token count increased),
   * configure Start Time (e.g. 0s), End Time (e.g. 5m), and FPS = 24 via the Video Settings dialog,
   * READ BACK all three values to confirm they stuck, and click Save.
   */
  private async attachVideoAndConfigureRange(
    page: Page,
    params: {
      label: 'short' | 'movie'
      youtubeUrl?: string | null
      driveFileName?: string | null
      localFilePath?: string | null
      startSec: number
      endSec: number
      fps: number
      scope?: { scanId?: string | null; username?: string | null }
    },
  ) {
    const { label, youtubeUrl, driveFileName, localFilePath, startSec, endSec, fps, scope } = params
    await this.waitIfPausedOrThrowIfStopped(scope)

    const uploadedBasename =
      driveFileName ||
      (localFilePath ? path.basename(localFilePath) : '')

    // Combined locator: videoMediaChipsCss + videoMediaChipsPw + fallback chip locator ([data-cmt-fallback-chip="true"])
    const combinedChipSelector = [
      ...STUDIO_SELECTORS.videoMediaChipsCss,
      ...STUDIO_SELECTORS.videoMediaChipsPw,
      '[data-cmt-fallback-chip="true"]',
    ].join(', ')
    const chipsLocator = page.locator(combinedChipSelector)
    const removeMediaBtnLocator = page.locator('button[aria-label="Remove media" i]')

    await this.syncFallbackMediaChips(page)
    const chipsBefore = await chipsLocator.count()
    const removeBefore = await removeMediaBtnLocator.count().catch(() => 0)
    const headerTokensBefore = await this.readHeaderTokenCountSilent(page)

    if (driveFileName) {
      // Attach from Google Drive picker by file name (Insert -> Drive -> search driveFileName -> Select)
      let attachedFromDrive = false
      const insertBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMediaButton, 3000)
      if (insertBtn) {
        await insertBtn.click()
        await new Promise((r) => setTimeout(r, 400))
        const driveOpt = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMenuDriveOption, 2500)
        if (driveOpt) {
          await driveOpt.click()
          await new Promise((r) => setTimeout(r, 1500))

          // Locate the Google Drive Picker iframe
          const frames = page.frames()
          const pickerFrame = frames.find(
            (f) => f.url().includes('docs.google.com/picker') || f.url().includes('drive.google.com'),
          )
          if (pickerFrame) {
            const searchBox = await findFirstVisibleLocator(
              pickerFrame,
              STUDIO_SELECTORS.drivePickerSearchInput,
              5000,
            )
            if (searchBox) {
              await searchBox.fill(driveFileName)
              await searchBox.press('Enter')
              await new Promise((r) => setTimeout(r, 2000))
            }
            // Click the matching file row inside the picker
            const row = pickerFrame.locator(`text="${driveFileName}"`).first()
            if ((await row.count()) > 0) {
              await row.click()
              await new Promise((r) => setTimeout(r, 400))
              const selectBtn = await findFirstVisibleLocator(
                pickerFrame,
                STUDIO_SELECTORS.drivePickerSelectButton,
                3000,
              )
              if (selectBtn) {
                await selectBtn.click()
                attachedFromDrive = true
              } else {
                await row.dblclick()
                attachedFromDrive = true
              }
            }
          }
        } else {
          await page.keyboard.press('Escape')
        }
      }

      // Fallback if Drive picker iframe couldn't be interacted with and local file exists
      if (!attachedFromDrive && localFilePath && fs.existsSync(localFilePath)) {
        await this.uploadLocalFileToStudio(page, localFilePath)
      }
    } else if (localFilePath && fs.existsSync(localFilePath)) {
      await this.uploadLocalFileToStudio(page, localFilePath)
    } else {
      throw new Error(`No media source available to attach ${label} video in Studio`)
    }

    // FIX 1a: Wait for the new video chip to appear (via chip count increase OR second success signal:
    // button[aria-label="Remove media" i] count increased OR header token count increased)
    // AND wait until the chip finishes "Loading..." so its gear button ("Edit video options") is ready.
    // A local 390 MB upload can take longer than 90s, so use a 5-minute (300_000ms) deadline for local file uploads.
    const isLocalFileUpload = Boolean(!driveFileName && localFilePath)
    const waitTimeoutMs = isLocalFileUpload ? 300_000 : 90_000
    const uploadWaitStartedAt = Date.now()
    const waitDeadline = uploadWaitStartedAt + waitTimeoutMs
    let chipCount = chipsBefore
    let removeAfter = removeBefore
    let headerTokensAfter = headerTokensBefore
    let attachSucceeded = false
    let lastLoggedUploadSec = -1

    while (Date.now() < waitDeadline) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      removeAfter = await removeMediaBtnLocator.count().catch(() => 0)
      headerTokensAfter = await this.readHeaderTokenCountSilent(page)

      const primarySignal = chipCount > chipsBefore
      const secondarySignal =
        removeAfter > removeBefore || (headerTokensAfter > headerTokensBefore && headerTokensAfter > 0)

      if (primarySignal || secondarySignal) {
        if (chipCount > chipsBefore) {
          const candidateChip = chipsLocator.nth(chipsBefore)
          const chipText = ((await candidateChip.innerText().catch(() => '')) || '').trim()
          const gearBtnCount = await candidateChip
            .locator(
              'button[aria-label*="Edit video options" i], button[aria-label*="Video options" i], button[aria-label*="Video settings" i]',
            )
            .count()
            .catch(() => 0)
          // As shown in video 01:54 -> 01:56, while "Loading..." is displayed the gear icon is not ready yet
          if (gearBtnCount > 0 || !/\bloading\b/i.test(chipText)) {
            attachSucceeded = true
            break
          }
        } else {
          // Secondary signal triggered while chip is still Loading... — wait until Edit video options button appears and syncs
          const editBtnCountOnPage = await page
            .locator('button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i]')
            .count()
            .catch(() => 0)
          if (editBtnCountOnPage > chipsBefore) {
            await this.syncFallbackMediaChips(page)
            chipCount = await chipsLocator.count()
            attachSucceeded = true
            break
          }
        }
      }

      const elapsedUploadSec = Math.max(1, Math.floor((Date.now() - uploadWaitStartedAt) / 1000))
      if (isLocalFileUpload && elapsedUploadSec !== lastLoggedUploadSec) {
        lastLoggedUploadSec = elapsedUploadSec
        this.logStep(
          `uploading ${uploadedBasename || `${label}.mp4`} to AI Studio... ${elapsedUploadSec}s`,
          label,
        )
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    if (!attachSucceeded) {
      await this.syncFallbackMediaChips(page)
      chipCount = await chipsLocator.count()
      removeAfter = await removeMediaBtnLocator.count().catch(() => 0)
      headerTokensAfter = await this.readHeaderTokenCountSilent(page)
      if (
        chipCount > chipsBefore ||
        removeAfter > removeBefore ||
        (headerTokensAfter > headerTokensBefore && headerTokensAfter > 0)
      ) {
        attachSucceeded = true
      }
    }

    if (!attachSucceeded) {
      await this.dumpChipAttachDiagnostics(page, label, uploadedBasename)
      throw new Error(
        `Studio video attach failed for ${label}: media chip count did not increase within ${Math.round(waitTimeoutMs / 1000)}s (before=${chipsBefore}, after=${chipCount}, removeBefore=${removeBefore}, removeAfter=${removeAfter}, tokensBefore=${headerTokensBefore}, tokensAfter=${headerTokensAfter})`,
      )
    }

    // Problem 1(d): Target the chip we just added at index chipsBefore (short = 0, movie = 1)
    const targetChipIndex = chipsBefore

    const targetChip = chipsLocator.nth(targetChipIndex)
    if ((await targetChip.count()) === 0) {
      throw new Error(`Studio clip config failed: target media chip #${targetChipIndex} for ${label} not found`)
    }

    // Requirement 4: Keep the existing "movie chip must not resolve to index 0" check working with the new locator
    if (label === 'movie' && targetChipIndex === 0 && chipsBefore >= 1) {
      throw new Error(`Studio clip config failed: movie chip resolved to index 0 (short video chip)`)
    }

    // FIX 1c: Open Video Settings on targetChip via button[aria-label="Edit video options"],
    // set Start Time (e.g. 0s), End Time (e.g. 5m), and FPS = 24, and READ BACK all three values.
    // Retry the dialog once if any input is missing or any value did not stick, then THROW.
    const startStr = this.formatClockForStudioInput(startSec)
    const endStr = this.formatClockForStudioInput(endSec)
    let lastConfigError = ''

    for (let dialogAttempt = 1; dialogAttempt <= 2; dialogAttempt++) {
      await this.waitIfPausedOrThrowIfStopped(scope)
      lastConfigError = ''

      await targetChip.scrollIntoViewIfNeeded().catch(() => {})
      await targetChip.hover().catch(() => {})
      await new Promise((r) => setTimeout(r, 250))

      // Prefer explicit video settings (gear: button[aria-label="Edit video options"]) inside the chip; NEVER click Remove media
      let openedDialog = false
      for (const btnSel of STUDIO_SELECTORS.videoChipSettingsButton) {
        const btn = targetChip.locator(btnSel).first()
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click()
          openedDialog = true
          break
        }
      }
      if (!openedDialog) {
        // Fallback: find the first button inside targetChip that is NOT "Remove media" / close / delete
        const chipButtons = targetChip.locator('button, [role="button"]')
        const btnCount = await chipButtons.count()
        for (let bIdx = 0; bIdx < btnCount; bIdx++) {
          const btn = chipButtons.nth(bIdx)
          const btnMeta = (
            ((await btn.getAttribute('aria-label').catch(() => '')) || '') +
            ' ' +
            ((await btn.getAttribute('mattooltip').catch(() => '')) || '') +
            ' ' +
            ((await btn.getAttribute('title').catch(() => '')) || '') +
            ' ' +
            (await btn.innerText().catch(() => ''))
          )
            .trim()
            .toLowerCase()
          if (!/\b(close|cancel|clear|remove|delete)\b|^×$|^x$/i.test(btnMeta)) {
            await btn.click()
            openedDialog = true
            break
          }
        }
      }
      await new Promise((r) => setTimeout(r, 650))

      // Tag the Start Time, End Time, FPS inputs and Save button inside the open Video settings dialog
      await this.tagVideoSettingsDialogControls(page)

      const startInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoStartTimeInput, 2500)
      const endInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoEndTimeInput, 2500)
      const fpsInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoFpsInput, 2500)

      if (!startInput) {
        lastConfigError = `start time input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else if (!endInput) {
        lastConfigError = `end time input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else if (!fpsInput) {
        lastConfigError = `fps input not found for ${label}`
        await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
      } else {
        await startInput.click({ clickCount: 3 })
        await startInput.fill(startStr)
        await startInput.dispatchEvent('input').catch(() => {})
        await startInput.dispatchEvent('change').catch(() => {})

        await endInput.click({ clickCount: 3 })
        await endInput.fill(endStr)
        await endInput.dispatchEvent('input').catch(() => {})
        await endInput.dispatchEvent('change').catch(() => {})

        await fpsInput.click({ clickCount: 3 })
        await fpsInput.fill(String(fps))
        await fpsInput.dispatchEvent('input').catch(() => {})
        await fpsInput.dispatchEvent('change').catch(() => {})
        await fpsInput.press('Tab').catch(() => {})
        await new Promise((r) => setTimeout(r, 250))

        // Read back the three values from the dialog before clicking Save
        const readStartRaw = await startInput.inputValue().catch(() => '')
        const readEndRaw = await endInput.inputValue().catch(() => '')
        const readFpsRaw = await fpsInput.inputValue().catch(() => '')

        const readStartSec = this.parseStudioClockToSec(readStartRaw)
        const readEndSec = this.parseStudioClockToSec(readEndRaw)
        const readFps = Number(readFpsRaw.trim())

        if (!Number.isFinite(readFps) || Math.abs(readFps - fps) > 0.01) {
          lastConfigError = `fps (expected ${fps}, read back "${readFpsRaw}") on ${label}`
        } else if (readStartSec === null || Math.abs(readStartSec - Math.floor(startSec)) > 1) {
          lastConfigError = `start time (expected ${startStr} [${Math.floor(startSec)}s], read back "${readStartRaw}") on ${label}`
        } else if (readEndSec === null || Math.abs(readEndSec - Math.floor(endSec)) > 1) {
          lastConfigError = `end time (expected ${endStr} [${Math.floor(endSec)}s], read back "${readEndRaw}") on ${label}`
        }
        if (lastConfigError) {
          await this.dumpVideoDialogDiagnostics(page, label, lastConfigError)
        }
      }

      // Click the "Save" button at the bottom-right of the Video settings dialog (video 02:49)
      await this.tagVideoSettingsDialogControls(page)
      const saveBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.videoSettingsSaveButton, 1500)
      if (saveBtn) {
        await saveBtn.click().catch(() => {})
      } else {
        await page.keyboard.press('Enter').catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 600))
      // Wait 10 seconds after clicking Save in the Video settings dialog before doing anything else
      await new Promise((r) => setTimeout(r, 10_000))

      if (!lastConfigError) {
        break
      }

      this.logStep(
        `${label} clip config retry ${dialogAttempt}/2`,
        `Studio clip config failed: ${lastConfigError}`,
        'warn',
      )
      if (dialogAttempt >= 2) {
        throw new Error(`Studio clip config failed: ${lastConfigError}`)
      }
    }

    this.logStep(
      `${label} attached`,
      `chip #${targetChipIndex} · ${startStr}–${endStr} @ ${fps} FPS (verified)`,
      'success',
    )
  }

  private async uploadLocalFileToStudio(page: Page, filePath: string) {
    const fileInput = page.locator('input[type="file"]').first()
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath)
      return
    }
    const insertBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMediaButton, 2500)
    if (insertBtn) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
        (async () => {
          await insertBtn.click()
          await new Promise((r) => setTimeout(r, 350))
          const upOpt = await findFirstVisibleLocator(page, STUDIO_SELECTORS.insertMenuUploadFileOption, 2000)
          if (upOpt) await upOpt.click()
        })(),
      ])
      if (fileChooser) {
        await fileChooser.setFiles(filePath)
      }
    }
  }

  /**
   * Read AI Studio's total token counter from the DOM.
   * As shown in the user's video (02:56-03:04), the total token count is displayed in the top header bar
   * next to "Untitled prompt" (e.g. "520,801 tokens") AND each media chip also displays its own token count.
   * We inspect both the top header and all chip token counts so we never return only a single small chip's
   * token count when two videos are attached.
   */
  public async readStudioTokenCount(page: Page): Promise<number | null> {
    try {
      const count = await page.evaluate(() => {
        const isVisible = (el: Element | null): el is HTMLElement => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && window.getComputedStyle(h).visibility !== 'hidden'
        }

        // 1. Check top header bar elements (rect.top < 115) for total prompt tokens (next to "Untitled prompt")
        let headerTokens = 0
        const topNodes = Array.from(document.body.querySelectorAll('span, div, button, p'))
        for (const node of topNodes) {
          if (!isVisible(node)) continue
          const r = node.getBoundingClientRect()
          if (r.top < 0 || r.top > 115 || r.height > 60) continue
          const txt = ((node as HTMLElement).innerText || node.textContent || '').trim()
          if (txt.length > 80) continue
          const m = txt.match(/([\d,]+)\s*(?:\/\s*[\d,]+\s*)?tokens?\b/i)
          if (m) {
            const val = parseInt(m[1].replace(/,/g, ''), 10)
            if (Number.isFinite(val) && val > headerTokens) {
              headerTokens = val
            }
          }
        }

        // 2. Sum token counts across all attached media chips (each chip has one Edit video options button)
        let chipTokensSum = 0
        const editBtns = Array.from(
          document.body.querySelectorAll(
            'button[aria-label="Edit video options" i], button[aria-label*="Edit video options" i], button[aria-label*="Video options" i]',
          ),
        )
        const visitedChips = new Set<Element>()
        for (const btn of editBtns) {
          let curr: Element | null = btn.parentElement
          for (let d = 0; d < 6 && curr && curr !== document.body; d++) {
            const txt = ((curr as HTMLElement).innerText || curr.textContent || '').trim()
            const m = txt.match(/([\d,]+)\s*tokens?\b/i)
            if (m && curr.querySelectorAll('button[aria-label*="Edit video" i]').length === 1) {
              if (!visitedChips.has(curr)) {
                visitedChips.add(curr)
                const val = parseInt(m[1].replace(/,/g, ''), 10)
                if (Number.isFinite(val) && val > 0) {
                  chipTokensSum += val
                }
              }
              break
            }
            curr = curr.parentElement
          }
        }

        // 3. Also scan all token occurrences in bodyText and take the maximum
        const bodyText = document.body.innerText || ''
        let maxBodyTokens = 0
        const allMatches = bodyText.matchAll(/([\d,]{3,})\s*(?:\/\s*[\d,]+\s*)?tokens?\b/gi)
        for (const m of allMatches) {
          const val = parseInt(m[1].replace(/,/g, ''), 10)
          if (Number.isFinite(val) && val > maxBodyTokens) {
            maxBodyTokens = val
          }
        }

        const best = Math.max(headerTokens, chipTokensSum, maxBodyTokens)
        return best > 0 ? best : null
      })
      if (count !== null) {
        this.tokenCount = count
        this.logStep(`tokens ${Math.round(count / 1000)}K`, `${count.toLocaleString()} tokens`)
      }
      return count
    } catch {
      return null
    }
  }

  /**
   * Check whether the AI Studio "thinking / running" spinner is currently visible,
   * strictly scoped to ONLY the last model turn OR the Run/Stop button (never page-wide generic spinners).
   */
  private async isThinkingOrRunningSpinnerVisible(page: Page): Promise<boolean> {
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers
    return page
      .evaluate((turnSels) => {
        const isVisible = (el: Element | null): boolean => {
          if (!el) return false
          const h = el as HTMLElement
          const r = h.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return false
          const style = window.getComputedStyle(h)
          return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0
        }

        const spinnerQuery = 'mat-spinner, mat-progress-spinner, .mat-mdc-progress-spinner, [role="progressbar"]'

        // 1. Check inside the LAST model turn only
        let turns: Element[] = []
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore
          }
        }
        const lastTurn = turns[turns.length - 1]
        if (lastTurn) {
          const turnSpinners = Array.from(lastTurn.querySelectorAll(spinnerQuery))
          if (turnSpinners.some((s) => isVisible(s))) return true
        }

        // 2. Check inside ms-run-button / button.run-button only
        const runContainers = Array.from(document.querySelectorAll('ms-run-button, button.run-button'))
        for (const rc of runContainers) {
          const runSpinners = Array.from(rc.querySelectorAll(spinnerQuery))
          if (runSpinners.some((s) => isVisible(s))) return true
        }

        return false
      }, [...turnSelectors])
      .catch(() => false)
  }

  /**
   * Copy ONLY the final model response text from the latest turn,
   * explicitly stripping any thinking / thought blocks (`ms-thought-chunk`, etc.).
   * Attaches the cloned turn to an off-screen hidden container in `document.body`
   * so Chromium computes real layout-aware `innerText` with proper `\n` line breaks
   * on block elements (`p, div, li, br`).
   */
  private async extractFinalAnswerWithoutThoughts(page: Page): Promise<string> {
    const thoughtSelectors = STUDIO_SELECTORS.thoughtContainersToExclude
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers

    const extracted = await page.evaluate(
      ({ turnSels, thoughtSels }) => {
        let turns: Element[] = []
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore invalid CSS selector
          }
        }
        const lastTurn = turns[turns.length - 1] as HTMLElement | undefined
        if (!lastTurn) return ''

        const origRect = lastTurn.getBoundingClientRect()
        const origWidth = origRect && origRect.width > 50 ? Math.round(origRect.width) : 800

        const container = document.createElement('div')
        container.setAttribute('data-cmt-offscreen-extract', 'true')
        container.style.cssText = `position:fixed;left:-99999px;top:0;width:${origWidth}px;pointer-events:none;white-space:normal;z-index:-1;`

        try {
          const clone = lastTurn.cloneNode(true) as HTMLElement
          container.appendChild(clone)
          document.body.appendChild(container)

          for (const tSel of thoughtSels) {
            if (tSel.includes(':has-text(')) continue
            try {
              clone.querySelectorAll(tSel).forEach((el) => el.remove())
            } catch {
              // ignore invalid CSS selector
            }
          }

          // Remove thought panels in JS: for every 'mat-expansion-panel, details' inside the cloned last turn,
          // if its innerText starts with "Thoughts" or "Thinking" (case-insensitive), remove it.
          try {
            clone.querySelectorAll('mat-expansion-panel, details').forEach((el) => {
              const txt = ((el as HTMLElement).innerText || el.textContent || '').trim()
              if (/^(thoughts|thinking)\b/i.test(txt)) {
                el.remove()
              }
            })
          } catch {
            // ignore
          }

          // Ensure <br> and block elements produce line breaks even if custom web components use inline/flex styles
          try {
            clone.querySelectorAll('br').forEach((br) => {
              br.replaceWith('\n')
            })
            clone
              .querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr')
              .forEach((blk) => {
                blk.prepend(document.createTextNode('\n'))
                blk.append(document.createTextNode('\n'))
              })
          } catch {
            // ignore
          }

          const cloneText = (clone.innerText || clone.textContent || '').trim()
          if (cloneText) {
            return cloneText
          }
          // FIX 3(b): If removing thought panels emptied the turn, check if the raw turn only had thinking text
          const rawTurnText = (lastTurn.innerText || lastTurn.textContent || '').trim()
          if (
            rawTurnText &&
            !/\bHISSA\s*1\b/i.test(rawTurnText) &&
            /\b(?:MATCHED\s+SECTION|Sub-segment|Offset\s*=|Movie:\s*frame\s*\d+|Short:\s*frame\s*\d+|Initiating\s+Video\s+Analysis)\b/i.test(
              rawTurnText,
            )
          ) {
            return rawTurnText
          }
          return ''
        } finally {
          try {
            container.remove()
          } catch {
            // ignore
          }
        }
      },
      {
        turnSels: [...turnSelectors],
        thoughtSels: [...thoughtSelectors],
      },
    )

    if (isThinkingOnlyText(extracted)) {
      return extracted.trim()
    }
    return cleanStudioAnswerText(extracted)
  }

  /**
   * FIX 4: Inspect the last model turn in DOM for Prohibited Content / Safety Ratings block.
   * Returns true ONLY if `[aria-label="Safety Ratings"]` or `"Prohibited content"` is present in the last turn
   * AND the turn does NOT contain both `HISSA 1` and `HISSA 2` (so a normal complete answer that happens to mention
   * those words in a description is never falsely blocked).
   */
  private async checkLastTurnProhibited(page: Page): Promise<boolean> {
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers
    return page
      .evaluate((turnSels) => {
        let turns: Element[] = []
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = Array.from(document.querySelectorAll(sel))
            if (found.length > 0) {
              turns = found
              break
            }
          } catch {
            // ignore
          }
        }
        const lastTurn = turns[turns.length - 1] as HTMLElement | undefined
        if (!lastTurn) return false

        const turnText = (lastTurn.innerText || lastTurn.textContent || '').trim()
        const hasBothHissa = /\bHISSA\s*1\b/i.test(turnText) && /\bHISSA\s*2\b/i.test(turnText)
        if (hasBothHissa) {
          return false
        }

        const hasSafetyRatingsAttr = Boolean(
          lastTurn.querySelector('[aria-label="Safety Ratings" i], [aria-label*="Safety Ratings" i]'),
        )
        const hasProhibitedText =
          /\bProhibited\s+content\b|\bblocked\s+due\s+to\s+safety\b|\bPROHIBITED_CONTENT\b/i.test(
            turnText,
          )

        return (hasSafetyRatingsAttr || hasProhibitedText) && !/\bHISSA\s*1\b/i.test(turnText)
      }, [...turnSelectors])
      .catch(() => false)
  }

  /**
   * FIX 6 (before fetch): Confirm the last model turn is truly finished:
   * - Stop button / spinner is not visible
   * - Turn footer shows either a run duration (e.g. "6m31.5s", "12.4s") or thumb_up / thumb_down feedback icons.
   * If not yet visible, waits in 3s intervals up to `maxWaitMs` (default 20s).
   */
  private async waitUntilTurnTrulyFinished(page: Page, maxWaitMs = 20_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers

    while (Date.now() < deadline) {
      if (await this.checkLastTurnProhibited(page)) {
        throw new Error('POLICY_BLOCKED: Gemini prohibited content')
      }

      const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 80)
      const spinnerVisible = await this.isThinkingOrRunningSpinnerVisible(page)

      const footerReady = await page
        .evaluate((turnSels) => {
          let turns: Element[] = []
          for (const sel of turnSels) {
            if (sel.includes(':has-text(')) continue
            try {
              const found = Array.from(document.querySelectorAll(sel))
              if (found.length > 0) {
                turns = found
                break
              }
            } catch {
              // ignore
            }
          }
          const lastTurn = turns[turns.length - 1] as HTMLElement | undefined
          if (!lastTurn) return false

          const rawText = (lastTurn.innerText || lastTurn.textContent || '').trim()
          const hasDuration = /\b\d+m\s*\d+(?:\.\d+)?s\b|\b\d+\.\d+s\b/i.test(rawText)
          const hasThumbText = /\bthumb_up\b|\bthumb_down\b/i.test(rawText)
          const hasThumbButton = Boolean(
            lastTurn.querySelector(
              'button[aria-label*="Good response" i], button[aria-label*="Bad response" i], button[aria-label*="thumb" i], mat-icon',
            ),
          )
          return hasDuration || hasThumbText || hasThumbButton
        }, [...turnSelectors])
        .catch(() => false)

      if (!stopLoc && !spinnerVisible && footerReady) {
        return
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((r) => setTimeout(r, Math.min(3000, remaining)))
    }
  }

  /**
   * FIX 5: Reject bad clipboard text (prompt echo, thinking header, or missing HISSA 1).
   */
  private isRejectedClipboardText(txt: string): boolean {
    const t = (txt || '').trim()
    if (!t) return true
    if (isPromptEchoText(t)) return true
    if (isThinkingOnlyText(t)) return true
    if (/^(?:you\s+are\s+a\s+forensic\s+video\s+analyst|initiating\s+video\s+analysis|thinking\b|thoughts\b)/i.test(t)) {
      return true
    }
    if (!/\bHISSA\s*1\b/i.test(t)) {
      return true
    }
    return false
  }

  /**
   * FIX 3(a): Capture diagnostics when an answer is INCOMPLETE / truncated:
   * - Last model turn's footer text (duration, thumb_up/thumb_down, etc.)
   * - Any visible error / "Stopped" / safety banner
   * - StreamGenerateContent finishReason (MAX_TOKENS / STOP / OTHER) if seen on the network
   * - Save a diagnostic PNG screenshot in `data/`
   */
  private async captureIncompleteDiagnostics(
    page: Page,
    params: {
      scanId: string
      jobLabel: string
      reason: string
      finishReason: string | null
      onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
    },
  ): Promise<void> {
    const { scanId, jobLabel, reason, finishReason, onLog } = params
    try {
      const turnSelectors = STUDIO_SELECTORS.modelTurnContainers
      const errorSelectors = STUDIO_SELECTORS.errorBanners
      const domDiag = await page
        .evaluate(
          ({ turnSels, errSels }) => {
            let turns: Element[] = []
            for (const sel of turnSels) {
              if (sel.includes(':has-text(')) continue
              try {
                const found = Array.from(document.querySelectorAll(sel))
                if (found.length > 0) {
                  turns = found
                  break
                }
              } catch {
                // ignore
              }
            }
            const lastTurn = turns[turns.length - 1] as HTMLElement | undefined
            const turnText = (lastTurn?.innerText || lastTurn?.textContent || '').trim()
            const durationMatch = turnText.match(/\b\d+m\s*\d+(?:\.\d+)?s\b|\b\d+(?:\.\d+)?s\b/gi)
            const footerTail = turnText.slice(-160).replace(/\s+/g, ' ')

            const banners: string[] = []
            for (const s of errSels) {
              if (s.includes(':has-text(')) continue
              try {
                document.querySelectorAll(s).forEach((el) => {
                  const h = el as HTMLElement
                  const t = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ')
                  if (t && t.length <= 240) banners.push(t)
                })
              } catch {
                // ignore
              }
            }
            const bodyText = document.body?.innerText || ''
            const stoppedMatch = bodyText.match(
              /\b(?:generation\s+stopped|stopped\s+generating|response\s+stopped|safety\s+ratings|prohibited\s+content|max_tokens)\b[^\n]{0,80}/i,
            )
            if (stoppedMatch) {
              banners.push(stoppedMatch[0].trim())
            }

            return {
              durationTokens: durationMatch ? durationMatch.slice(-3).join(',') : 'none',
              footerTail,
              bannerText: banners.length > 0 ? Array.from(new Set(banners)).join(' | ').slice(0, 240) : 'none',
            }
          },
          { turnSels: [...turnSelectors], errSels: [...errorSelectors] },
        )
        .catch(() => ({ durationTokens: 'err', footerTail: '', bannerText: 'err' }))

      let screenshotRelPath = 'none'
      try {
        const safeScan = (scanId || 'scan').replace(/[^a-zA-Z0-9_-]+/g, '_')
        const safeJob = (jobLabel || 'win').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)
        const fileName = `incomplete_${safeScan}_${safeJob}_${Date.now()}.png`
        const fullPath = path.join(DATA_DIR, fileName)
        fs.mkdirSync(DATA_DIR, { recursive: true })
        await page.screenshot({ path: fullPath, fullPage: false, timeout: 5000 })
        screenshotRelPath = `data/${fileName}`
      } catch {
        // ignore screenshot error
      }

      const diagMsg = `INCOMPLETE_DIAG [reason=${reason}] finishReason=${finishReason || 'unknown'} turnDuration=${domDiag.durationTokens} banner=${JSON.stringify(domDiag.bannerText)} footerTail=${JSON.stringify(domDiag.footerTail)} screenshot=${screenshotRelPath}`
      this.logStep('INCOMPLETE_DIAG', diagMsg, 'warn')
      onLog?.('warn', `${diagMsg} on ${jobLabel}`)
    } catch {
      // ignore diagnostic error
    }
  }

  /**
   * FIX 3(c): Send a follow-up "Continue EXACTLY from where you stopped..." message in the same AI Studio chat,
   * wait for the new model turn to finish streaming, and fetch its text.
   */
  private async sendContinueFollowUpAndFetch(
    page: Page,
    params: {
      jobLabel: string
      activeModelName: string
      continueAttempt: number
      scope?: { scanId?: string | null; username?: string | null }
      onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
    },
  ): Promise<string> {
    const { jobLabel, activeModelName, continueAttempt, scope, onLog } = params
    const CONTINUE_PROMPT =
      'Continue EXACTLY from where you stopped. Output only the remaining lines in the same format, no repetition, no explanation.'

    await this.waitIfPausedOrThrowIfStopped(scope)

    const turnSelectors = STUDIO_SELECTORS.modelTurnContainers
    const prevTurnCount = await page
      .evaluate((turnSels) => {
        for (const sel of turnSels) {
          if (sel.includes(':has-text(')) continue
          try {
            const found = document.querySelectorAll(sel)
            if (found.length > 0) return found.length
          } catch {
            // ignore
          }
        }
        return 0
      }, [...turnSelectors])
      .catch(() => 0)

    const promptInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 5000)
    if (!promptInput) {
      throw new Error('Could not find prompt input textarea for CONTINUE follow-up')
    }
    await promptInput.click()
    await promptInput.fill(CONTINUE_PROMPT)
    await new Promise((r) => setTimeout(r, 400))

    const runBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 4000)
    if (runBtn) {
      await runBtn.click()
    } else {
      await promptInput.press('Control+Enter')
    }

    this.logStep(
      `continue #${continueAttempt} sent`,
      `${jobLabel} [${activeModelName}] — waiting for continuation turn`,
      'info',
    )
    onLog?.(
      'info',
      `CONTINUE [runWindowJob] (#${continueAttempt}/2) sent follow-up in same chat on ${jobLabel}`,
    )

    const contStart = Date.now()
    const CONT_TIMEOUT_MS = 4 * 60_000
    let stopEverSeen = false
    let stopGonePolls = 0
    let lastText = ''
    let stablePolls = 0

    while (Date.now() - contStart < CONT_TIMEOUT_MS) {
      await this.waitIfPausedOrThrowIfStopped(scope)

      const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 100)
      const stopVisible = Boolean(stopLoc)
      if (stopVisible) stopEverSeen = true

      const spinnerVisible = await this.isThinkingOrRunningSpinnerVisible(page)
      const elapsedSec = Math.floor((Date.now() - contStart) / 1000)

      if (elapsedSec >= 2) {
        if (!stopVisible && !spinnerVisible && (await this.checkLastTurnProhibited(page))) {
          throw new Error('POLICY_BLOCKED: Gemini prohibited content')
        }

        // Check if an internal error or quota error occurred during continuation turn
        const contErrDetected = await page
          .evaluate((sels) => {
            const re =
              /(an\s+internal\s+error\s+has\s+occurred|internal\s+error\s+has\s+occurred|something\s+went\s+wrong|failed\s+to\s+generate|quota\s+exceeded|resource[_\s]+exhausted)/i
            for (const s of sels) {
              if (s.includes(':has-text(')) continue
              try {
                for (const node of Array.from(document.querySelectorAll(s))) {
                  const el = node as HTMLElement
                  if (!el || !el.innerText) continue
                  if (el.offsetParent !== null || el.getClientRects().length > 0) {
                    const t = el.innerText.trim()
                    if (re.test(t)) return t
                  }
                }
              } catch {
                // ignore
              }
            }
            return null
          }, [...STUDIO_SELECTORS.errorBanners])
          .catch(() => null)

        if (contErrDetected) {
          throw new Error(`CONTINUE_TURN_ERROR: ${contErrDetected.slice(0, 160)}`)
        }

        const curTurnCount = await page
          .evaluate((turnSels) => {
            for (const sel of turnSels) {
              if (sel.includes(':has-text(')) continue
              try {
                const found = document.querySelectorAll(sel)
                if (found.length > 0) return found.length
              } catch {
                // ignore
              }
            }
            return 0
          }, [...turnSelectors])
          .catch(() => prevTurnCount)

        const candidate = await this.extractFinalAnswerWithoutThoughts(page)
        if (
          curTurnCount > prevTurnCount &&
          /^(?:an\s+internal\s+error\s+has\s+occurred|internal\s+error\s+has\s+occurred|something\s+went\s+wrong|failed\s+to\s+generate)\b/i.test(
            candidate.trim(),
          )
        ) {
          throw new Error(`CONTINUE_TURN_ERROR: ${candidate.trim().slice(0, 160)}`)
        }

        if (candidate === lastText && candidate.length > 0) {
          stablePolls += 1
        } else {
          lastText = candidate
          stablePolls = candidate.length > 0 ? 1 : 0
        }

        if ((stopEverSeen || curTurnCount > prevTurnCount) && !stopVisible && !spinnerVisible) {
          stopGonePolls += 1
        } else {
          stopGonePolls = 0
        }

        if (stopGonePolls >= 3 && stablePolls >= 4 && candidate.length > 0) {
          break
        }
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    const fetched = await this.fetchStudioResultFromTurnOrFallback(page)
    return fetched.text || lastText
  }

  /**
   * Fetch the final answer from the latest model turn:
   * - First checks for Prohibited content (`POLICY_BLOCKED: Gemini prohibited content`).
   * - Confirms the turn footer is finished (up to 20s wait in 3s steps).
   * - Uses fixed DOM extraction (`extractFinalAnswerWithoutThoughts` + `cleanStudioAnswerText`) as the PRIMARY path.
   * - Only falls back to clipboard if DOM failed, and rejects any clipboard text that looks like the prompt, thoughts, or lacks HISSA 1.
   */
  private async fetchStudioResultFromTurnOrFallback(
    page: Page,
  ): Promise<{ text: string; source: 'clipboard' | 'dom' }> {
    // FIX 4: Check Prohibited content on the last model turn BEFORE any fetch/copy
    if (await this.checkLastTurnProhibited(page)) {
      throw new Error('POLICY_BLOCKED: Gemini prohibited content')
    }

    // FIX 6: Ensure turn is truly finished (Stop/spinner gone + duration or thumb_up/thumb_down visible, max 20s)
    await this.waitUntilTurnTrulyFinished(page, 20_000)

    // Re-check Prohibited content in case it appeared as the turn finished
    if (await this.checkLastTurnProhibited(page)) {
      throw new Error('POLICY_BLOCKED: Gemini prohibited content')
    }

    // 1. Primary path (race-free across parallel Xvfb workers): read directly from this worker's DOM turn!
    const domDirectText = await this.extractFinalAnswerWithoutThoughts(page)
    if (
      domDirectText &&
      !isPromptEchoText(domDirectText) &&
      /HISSA\s*1\b/i.test(domDirectText) &&
      /HISSA\s*2\b/i.test(domDirectText)
    ) {
      return { text: domDirectText, source: 'dom' }
    }

    // 2. Fallback: Use shared X11 clipboard guarded by a global mutex + sentinel + strict prompt/thinking rejection
    return withClipboardLock(async () => {
      const fetchDeadline = Date.now() + 15_000

      if (this.context) {
        await this.context
          .grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: 'https://aistudio.google.com',
          })
          .catch(() => {})
      }

      const writeSentinel = async (): Promise<string> => {
        const sentinel = `__CMT_SENTINEL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}__`
        await page
          .evaluate(async (s) => {
            try {
              await navigator.clipboard.writeText(s)
            } catch {
              // ignore
            }
          }, sentinel)
          .catch(() => {})
        return sentinel
      }

      const readClipboardUntilChanged = async (sentinel: string, maxWaitMs = 3000): Promise<string | null> => {
        const waitEnd = Math.min(fetchDeadline, Date.now() + maxWaitMs)
        while (Date.now() < waitEnd) {
          const txt = await page
            .evaluate(async () => {
              try {
                return await navigator.clipboard.readText()
              } catch {
                return ''
              }
            })
            .catch(() => '')
          if (txt && txt !== sentinel && !txt.startsWith('__CMT_SENTINEL_')) {
            return txt.trim()
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return null
      }

      const clickCopyAsTextInOpenMenu = async (): Promise<string | null> => {
        for (const itemSel of STUDIO_SELECTORS.copyAsTextMenuItem) {
          try {
            const itemLoc = page.locator(itemSel).first()
            if ((await itemLoc.count()) > 0 && (await itemLoc.isVisible().catch(() => false))) {
              const itemText = ((await itemLoc.innerText().catch(() => '')) || '').trim()
              // Strict safety: ONLY click "Copy as text", never "Copy as markdown", "Delete", or "Branch from here"
              if (/copy\s+as\s+text/i.test(itemText) && !/markdown|delete|branch/i.test(itemText)) {
                const sentinel = await writeSentinel()
                await itemLoc.click({ timeout: 1500 })
                const copied = await readClipboardUntilChanged(sentinel, 3000)
                if (copied) return copied
              }
            }
          } catch {
            // try next selector
          }
        }
        return null
      }

      // Find the last model turn Locator
      let lastTurnLoc: ReturnType<Page['locator']> | null = null
      for (const tSel of STUDIO_SELECTORS.modelTurnContainers) {
        try {
          const allTurns = page.locator(tSel)
          const cnt = await allTurns.count()
          if (cnt > 0) {
            lastTurnLoc = allTurns.nth(cnt - 1)
            break
          }
        } catch {
          // ignore
        }
      }

      // Fallback (a): UI flow using DOM locators scoped strictly inside lastTurn (max 3 tries)
      if (lastTurnLoc) {
        for (let copyTry = 1; copyTry <= 3 && Date.now() < fetchDeadline; copyTry++) {
          try {
            await lastTurnLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
            const turnBox = await lastTurnLoc.boundingBox().catch(() => null)
            if (turnBox && turnBox.width > 40 && turnBox.height > 20) {
              // Click near the center of the last model turn to reveal its turn options toolbar
              const clickX = Math.round(turnBox.x + turnBox.width * 0.5)
              const clickY = Math.round(
                Math.max(85, Math.min(VIEWPORT.height - 60, turnBox.y + Math.min(turnBox.height * 0.5, 220))),
              )
              await page.mouse.click(clickX, clickY)
            } else {
              await lastTurnLoc.hover({ timeout: 1500 }).catch(() => {})
            }
            await new Promise((r) => setTimeout(r, 250))

            // Find the three-dot (more_vert) button strictly inside lastTurnLoc and below the page header
            let clickedMoreBtn = false
            for (const btnSel of STUDIO_SELECTORS.turnOptionsButton) {
              const candidates = lastTurnLoc.locator(btnSel)
              const cCount = await candidates.count().catch(() => 0)
              for (let i = 0; i < cCount; i++) {
                const btn = candidates.nth(i)
                if (!(await btn.isVisible().catch(() => false))) continue
                const box = await btn.boundingBox().catch(() => null)
                // Must be below the top page header bar (y > 68)
                if (!box || box.y <= 68) continue

                const isInsideTurnAndNotHeader = await btn
                  .evaluate((el) => {
                    if (el.closest('header, mat-toolbar, ms-toolbar, ms-header, .toolbar')) return false
                    return Boolean(el.closest('ms-chat-turn, [data-turn-role="model"], .model-turn'))
                  })
                  .catch(() => false)

                if (!isInsideTurnAndNotHeader) continue

                await btn.click({ timeout: 1500 })
                clickedMoreBtn = true
                break
              }
              if (clickedMoreBtn) break
            }

            if (clickedMoreBtn) {
              await new Promise((r) => setTimeout(r, 300))
              const copied = await clickCopyAsTextInOpenMenu()
              if (copied) {
                if (!this.isRejectedClipboardText(copied)) {
                  return { text: cleanStudioAnswerText(copied), source: 'clipboard' }
                }
                this.logStep(
                  'clipboard text rejected',
                  `Rejected copied text (${copied.length} chars, starts=${JSON.stringify(copied.slice(0, 60))}) -> falling back to DOM`,
                  'warn',
                )
              }
              // Wrong menu opened or "Copy as text" not found — press Escape and retry
              await page.keyboard.press('Escape').catch(() => {})
              await new Promise((r) => setTimeout(r, 200))
            }
          } catch {
            await page.keyboard.press('Escape').catch(() => {})
          }
        }
      }

      // Fallback (b): Coordinate ratios on VIEWPORT (1366x840)
      if (Date.now() < fetchDeadline) {
        try {
          if (lastTurnLoc) {
            await lastTurnLoc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
          }
          const turnClickX = Math.round(0.586 * VIEWPORT.width)
          const turnClickY = Math.round(0.506 * VIEWPORT.height)
          await page.mouse.click(turnClickX, turnClickY)
          await new Promise((r) => setTimeout(r, 250))

          const moreX = Math.round(0.742 * VIEWPORT.width)
          const moreY = Math.round(0.113 * VIEWPORT.height)
          // Verify element at (moreX, moreY) is not a top header bar button before clicking
          const safeToClickMoreAtCoord = await page
            .evaluate(
              ({ x, y }) => {
                const el = document.elementFromPoint(x, y)
                if (!el) return false
                if (el.closest('header, mat-toolbar, ms-toolbar, ms-header')) return false
                return true
              },
              { x: moreX, y: moreY },
            )
            .catch(() => false)

          if (safeToClickMoreAtCoord) {
            await page.mouse.click(moreX, moreY)
            await new Promise((r) => setTimeout(r, 300))

            // First try clicking the "Copy as text" item in the opened overlay via locator
            const copiedViaOverlay = await clickCopyAsTextInOpenMenu()
            if (copiedViaOverlay) {
              if (!this.isRejectedClipboardText(copiedViaOverlay)) {
                return { text: cleanStudioAnswerText(copiedViaOverlay), source: 'clipboard' }
              }
              this.logStep(
                'clipboard text rejected',
                `Rejected overlay copied text (${copiedViaOverlay.length} chars) -> falling back to DOM`,
                'warn',
              )
            }

            // Otherwise check if (0.792, 0.227) points to "Copy as text"
            const copyX = Math.round(0.792 * VIEWPORT.width)
            const copyY = Math.round(0.227 * VIEWPORT.height)
            const isCopyAsTextAtCoord = await page
              .evaluate(
                ({ x, y }) => {
                  const el = document.elementFromPoint(x, y) as HTMLElement | null
                  if (!el) return false
                  const item = (el.closest('[role="menuitem"], button, .mat-mdc-menu-item') || el) as HTMLElement
                  const txt = (item.innerText || item.textContent || '').trim()
                  return /copy\s+as\s+text/i.test(txt) && !/markdown|delete|branch/i.test(txt)
                },
                { x: copyX, y: copyY },
              )
              .catch(() => false)

            if (isCopyAsTextAtCoord) {
              const sentinel = await writeSentinel()
              await page.mouse.click(copyX, copyY)
              const copied = await readClipboardUntilChanged(sentinel, 3000)
              if (copied) {
                if (!this.isRejectedClipboardText(copied)) {
                  return { text: cleanStudioAnswerText(copied), source: 'clipboard' }
                }
                this.logStep(
                  'clipboard text rejected',
                  `Rejected coord copied text (${copied.length} chars) -> falling back to DOM`,
                  'warn',
                )
              }
            }
            await page.keyboard.press('Escape').catch(() => {})
          }
        } catch {
          await page.keyboard.press('Escape').catch(() => {})
        }
      }

      // Debug dump of buttons inside the last turn so selectors can be tuned if UI copy failed
      try {
        const turnButtonsDump = await page.evaluate((turnSels) => {
          let turns: Element[] = []
          for (const sel of turnSels) {
            if (sel.includes(':has-text(')) continue
            try {
              const found = Array.from(document.querySelectorAll(sel))
              if (found.length > 0) {
                turns = found
                break
              }
            } catch {
              // ignore
            }
          }
          const lastTurn = turns[turns.length - 1]
          if (!lastTurn) return 'no lastTurn found'
          const btns = Array.from(lastTurn.querySelectorAll('button, [role="button"]')).slice(0, 12)
          return btns
            .map((b) => {
              const h = b as HTMLElement
              const r = h.getBoundingClientRect()
              const aria = h.getAttribute('aria-label') || ''
              const txt = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)
              return `[aria="${aria}" txt="${txt}" @${Math.round(r.x)},${Math.round(r.y)}]`
            })
            .join(' ')
        }, [...STUDIO_SELECTORS.modelTurnContainers])
        this.logStep('turn copy fallback->dom', turnButtonsDump.slice(0, 260), 'warn')
      } catch {
        // ignore dump error
      }

      // Fallback (c): DOM extraction without thoughts
      const domText = await this.extractFinalAnswerWithoutThoughts(page)
      return { text: domText, source: 'dom' }
    })
  }

  /**
   * Read any visible toast / snackbar / alert text on the AI Studio page (e.g. when Run fails with 403).
   */
  private async readPageToastOrErrorText(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        const selectors = [
          'mat-snack-bar-container',
          'simple-snack-bar',
          '.mat-mdc-snack-bar-container',
          '.cdk-overlay-container [role="status"]',
          '.cdk-overlay-container [role="alert"]',
          '[role="alert"]',
          '.error-message',
          '.mat-mdc-snack-bar-label',
        ]
        const parts: string[] = []
        for (const sel of selectors) {
          try {
            const nodes = Array.from(document.querySelectorAll(sel))
            for (const n of nodes) {
              const el = n as HTMLElement
              const r = el.getBoundingClientRect()
              if (r.width <= 0 || r.height <= 0) continue
              const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
              if (txt && !parts.includes(txt)) {
                parts.push(txt)
              }
            }
          } catch {
            /* ignore */
          }
        }
        return parts.join(' | ').slice(0, 500)
      })
    } catch {
      return ''
    }
  }

  /**
   * Execute a single (shortPart, movieBlock) Studio job:
   * a. Open a NEW chat on aistudio.google.com
   * b. Configure Run Settings (thinking=High, maxOutputTokens, model fallback selection if triggered)
   * c. Attach Video 1 (short part) & Video 2 (movie_360p), set start/end times + FPS=24 (verified read-back + 10s wait after Save)
   * d. Paste prompt text and check token counter BEFORE pressing Run:
   *    - If > maxInputTokens (1_048_576 - maxOutputTokens - 5_000, or user override), signal shrink_needed
   *    - Never run the shrink check after pressing Run (during generation the counter can include output tokens)
   *    - Keep the implausibly low token counter check (minimum 500 tokens/sec of video)
   *    - Wait 10s after token counter settles before pressing Run
   * e. Press Run -> capture GenerateContent network response (status + body) & page toast -> wait up to 10m -> check permission denied first (own 5-retry counter + model fallback 3.8 -> 3.7 -> 3.6 Flash) -> detect completion via STOP_GONE | HISSA_FOUND | STABLE_6S
   * f. Fetch final answer via turn "Copy as text" (or DOM fallback) -> synchronously validate with validateStudioAnswer (retry up to 3x in new chat if invalid) -> calibrate offset mode -> parseChunkMatches
   * g. Save rotated cookies/profile & recycle Playwright page in same persistent context after every N finished window jobs (default 5)
   */
  public async runWindowJob(params: {
    username: string
    scanId: string
    jobLabel: string
    modelName: string
    thinkingLevel?: StudioThinkingLevel
    maxOutputTokens: number
    maxInputTokens?: number | null
    pageRecycleInterval?: number
    shortYoutubeUrl?: string | null
    shortDriveFileName?: string | null
    shortLocalPath?: string | null
    shortStartSec: number
    shortEndSec: number
    movieDriveFileName?: string | null
    movieLocalPath?: string | null
    movieStartSec: number
    movieEndSec: number
    windowClip?: {
      clipPath: string
      clipStartFrame: number
      clipStartSec: number
      frameCount: number
      durationSec: number
    } | null
    sanitized?: boolean
    parallelMode?: boolean
    maxAttempts?: number
    measuredTokenRate?: number | null
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<
    | { status: 'shrink_needed'; tokenCount: number; maxInputTokens: number }
    | {
        status: 'success'
        rawText: string
        tokenCount: number
        isRealTokenCount: boolean
        matches: ChunkMatch[]
        calibratedOffsetMode: 'relative' | 'absolute'
      }
  > {
    const {
      username,
      scanId,
      jobLabel,
      modelName,
      maxOutputTokens,
      shortYoutubeUrl,
      shortDriveFileName,
      shortLocalPath,
      shortStartSec,
      shortEndSec,
      movieDriveFileName,
      movieLocalPath,
      movieStartSec,
      movieEndSec,
      windowClip = null,
      sanitized = false,
      parallelMode = false,
      measuredTokenRate = null,
      onLog,
    } = params

    const userCfg = await loadStudioUserConfig(username)
    const effectiveThinkingLevel = normalizeStudioThinkingLevel(
      params.thinkingLevel ?? userCfg.studioThinkingLevel,
    )
    const rawEffectiveMaxInputTokens = computeEffectiveMaxInputTokens(
      maxOutputTokens,
      params.maxInputTokens !== undefined ? params.maxInputTokens : userCfg.studioMaxInputTokens,
    )
    const effectiveMaxInputTokens = parallelMode
      ? 990_000
      : rawEffectiveMaxInputTokens
    const effectiveRecycleInterval =
      params.pageRecycleInterval ?? userCfg.studioPageRecycleInterval ?? 5

    const scope = { scanId, username }
    this.setJobContext(scanId, jobLabel, username)

    const totalVideoSec = Math.max(1, (shortEndSec - shortStartSec) + (movieEndSec - movieStartSec))
    // Item 3: KEEP the "implausibly low token counter" check (minimum 500 tokens/sec of video, or 90% of measuredTokenRate when calibrated from Test Clip).
    const activeMeasuredRate = measuredTokenRate || userCfg.studioMeasuredTokenRate || null
    const minPlausible24FpsTokens = activeMeasuredRate
      ? Math.max(Math.round(totalVideoSec * 500), Math.round(totalVideoSec * activeMeasuredRate * 0.85))
      : Math.round(totalVideoSec * 500)

    const MAX_ATTEMPTS = params.maxAttempts ?? (parallelMode ? 5 : 3)
    const MAX_PERMISSION_RETRIES = 10
    let permissionDeniedRetries = 0
    const MAX_INTERNAL_ERROR_REFRESH = 3
    let internalErrorRefreshes = 0
    const MAX_INVALID_RESULT_RETRIES = parallelMode ? MAX_ATTEMPTS : 3
    let invalidResultRetries = 0

    // Requirement 1 & 5: Build model fallback chain starting from user's chosen model:
    // Argon -> Gemini 3.8 Flash -> Gemini 3.7 Flash -> Gemini 3.6 Flash
    const chosenModel = canonicalizeStudioModelName(
      modelName || userCfg.studioModelName || DEFAULT_STUDIO_MODEL_NAME,
    )
    const MODEL_FALLBACK_CHAIN = buildStudioModelChain(chosenModel)
    const formatQuotaResetTime = async (): Promise<string> => {
      const qState = await loadStudioModelQuotaState()
      const timestamps = Object.values(qState.exhausted).filter((t) => Number.isFinite(t) && t > 0)
      const earliestTs = timestamps.length > 0 ? Math.min(...timestamps) : Date.now()
      return new Date(earliestTs).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    }

    const initialEffectiveModel = await getEffectiveModel(chosenModel, MODEL_FALLBACK_CHAIN)
    if (!initialEffectiveModel) {
      const resetTimeStr = await formatQuotaResetTime()
      throw new Error(`NEEDS_ATTENTION: saare models ka quota khatam, reset ${resetTimeStr} par`)
    }

    let activeModelName = initialEffectiveModel
    let activeModelIndex = Math.max(
      0,
      MODEL_FALLBACK_CHAIN.findIndex((m) => m.toLowerCase() === activeModelName.toLowerCase()),
    )
    let resetOnPermissionDenied = false
    let resetOnInternalError = false

    this.activeMaxAttempts = MAX_ATTEMPTS
    this.activeModelName = activeModelName
    this.activePermRetry = 0

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.activeAttempt = attempt
      this.activeModelName = activeModelName
      this.activePermRetry = permissionDeniedRetries
      this.suppressDiagDumps = Boolean(parallelMode && attempt < MAX_ATTEMPTS)
      this.activeChromeLogPath = resolveWorkerChromeLogFilePath(
        scanId,
        this.profileDirName,
        attempt,
      )
      this.lastSampledWorkerRssMb = 0
      this.peakWorkerRssMb = 0
      try {
        fs.mkdirSync(path.dirname(this.activeChromeLogPath), { recursive: true })
        fs.appendFileSync(
          this.activeChromeLogPath,
          `\n=== [${new Date().toISOString()}] Worker=${this.workerTag || this.profileDirName} profile=${this.profileDirName} job=${jobLabel} attempt=${attempt}/${MAX_ATTEMPTS} ===\n`,
          'utf8',
        )
      } catch {
        /* ignore log header error */
      }
      let currentStage = 'setup/ensure_page'
      await this.waitIfPausedOrThrowIfStopped(scope)

      try {
        let page = await this.ensurePage(username)
        if (this.browserLaunchInfo && attempt === 1 && permissionDeniedRetries === 0 && internalErrorRefreshes === 0) {
          const isFallbackWarn = /WARN|mode=headless/i.test(this.browserLaunchInfo)
          this.logStep('browser info', this.browserLaunchInfo, isFallbackWarn ? 'warn' : 'info')
        }

        // (a) On 403 PERMISSION_DENIED retry OR internal error hard refresh: alternate between:
        //   - Odd retry (1, 3, 5...): Hard page reset (close old page, clear cache + site storage via CDP without touching cookies, open fresh page in same context, goto new_chat)
        //   - Even retry (2, 4, 6...): Full browser restart (close context, relaunch persistent profile, open fresh page, goto new_chat)
        // On normal start or any other error retry: open a NEW chat on aistudio.google.com.
        if (resetOnPermissionDenied || resetOnInternalError) {
          const isInternalErrReset = resetOnInternalError
          resetOnPermissionDenied = false
          resetOnInternalError = false
          const resetCounter = isInternalErrReset ? internalErrorRefreshes : permissionDeniedRetries
          const resetMax = isInternalErrReset ? MAX_INTERNAL_ERROR_REFRESH : MAX_PERMISSION_RETRIES
          const resetPrefix = isInternalErrReset ? 'internal error' : '403'
          const isHardPageReset = resetCounter % 2 === 1
          const storageTypesToClear = 'local_storage,indexeddb,cache_storage,service_workers,websql'

          const clearCacheAndStorageViaCdp = async (targetPage: Page): Promise<string[]> => {
            if (!this.context) return []
            const clearedItems: string[] = []
            let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null
            try {
              cdp = await this.context.newCDPSession(targetPage)
              try {
                await cdp.send('Network.clearBrowserCache')
                clearedItems.push('Network.clearBrowserCache')
              } catch {
                /* ignore cache clear warning */
              }
              try {
                await cdp.send('Storage.clearDataForOrigin', {
                  origin: 'https://aistudio.google.com',
                  storageTypes: storageTypesToClear,
                })
                clearedItems.push(`Storage.clearDataForOrigin(${storageTypesToClear})`)
              } catch {
                /* ignore storage clear warning */
              }
            } catch {
              /* ignore cdp session warning */
            } finally {
              if (cdp) {
                await cdp.detach().catch(() => {})
              }
            }
            return clearedItems
          }

          if (isHardPageReset) {
            currentStage = 'setup/hard_reset_page'
            if (!this.context) {
              page = await this.ensurePage(username)
            }
            const oldPages = this.context ? [...this.context.pages()] : [page]
            const freshPage = await this.context!.newPage()
            for (const oldP of oldPages) {
              if (oldP !== freshPage && !oldP.isClosed()) {
                await oldP.close().catch(() => {})
              }
            }
            const clearedList = await clearCacheAndStorageViaCdp(freshPage)
            await freshPage.setViewportSize(VIEWPORT)
            this.page = freshPage
            page = freshPage

            const clearedDesc =
              clearedList.length > 0
                ? clearedList.join(' + ')
                : `cache + storage (${storageTypesToClear})`
            const resetDetail = `${jobLabel} (${resetPrefix} refresh ${resetCounter}/${resetMax}, model=${activeModelName}) — old page closed, cleared [${clearedDesc}] for https://aistudio.google.com (cookies preserved), opened new page -> new_chat`
            this.logStep(`${resetPrefix} -> hard reset (page+cache)`, resetDetail, 'info')
            onLog?.('info', `${resetPrefix} -> hard reset (page+cache): ${resetDetail}`)

            await page.goto(STUDIO_URLS.newChat, {
              waitUntil: 'domcontentloaded',
              timeout: 45_000,
            })
          } else {
            currentStage = 'setup/browser_restart'
            let clearedList: string[] = []
            if (this.context && page && !page.isClosed()) {
              clearedList = await clearCacheAndStorageViaCdp(page)
            }
            if (this.context) {
              try {
                await this.context.close()
              } catch {
                /* ignore context close warning */
              }
              this.context = null
              this.page = null
            }
            await new Promise((r) => setTimeout(r, 1000))

            await this.ensurePage(username)
            const activeCtx = this.context as BrowserContext | null
            const existingPages = activeCtx ? [...activeCtx.pages()] : []
            const freshPage = await activeCtx!.newPage()
            for (const oldP of existingPages) {
              if (oldP !== freshPage && !oldP.isClosed()) {
                await oldP.close().catch(() => {})
              }
            }
            if (clearedList.length === 0) {
              clearedList = await clearCacheAndStorageViaCdp(freshPage)
            }
            await freshPage.setViewportSize(VIEWPORT)
            this.page = freshPage
            page = freshPage

            const clearedDesc =
              clearedList.length > 0
                ? clearedList.join(' + ')
                : `cache + storage (${storageTypesToClear})`
            const restartDetail = `${jobLabel} (${resetPrefix} refresh ${resetCounter}/${resetMax}, model=${activeModelName}) — context closed & relaunched persistent profile (${this.profileDirName}), cleared [${clearedDesc}] for https://aistudio.google.com (cookies preserved), opened new page -> new_chat`
            this.logStep(`${resetPrefix} -> browser restart`, restartDetail, 'info')
            onLog?.('info', `${resetPrefix} -> browser restart: ${restartDetail}`)

            await page.goto(STUDIO_URLS.newChat, {
              waitUntil: 'domcontentloaded',
              timeout: 45_000,
            })
          }
        } else {
          currentStage = 'setup/new_chat'
          this.logStep('opening new chat', `${jobLabel} (attempt ${attempt}/${MAX_ATTEMPTS}, model=${activeModelName})`)
          await page.goto(STUDIO_URLS.newChat, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          })
        }
        await new Promise((r) => setTimeout(r, 2500))
        await this.dismissAnyOnboardingModals(page)

        const needsAttentionReason = await page
          .evaluate(() => {
            if (window.location.href.includes('accounts.google.com')) {
              return 'Google session logged out or requires verification'
            }
            const body = document.body?.innerText || ''
            if (/no\s+api\s+key\s+selected|select\s+an?\s+api\s+key\s+to\s+continue/i.test(body)) {
              return 'No API key selected or project prompt blocking AI Studio'
            }
            return null
          })
          .catch(() => (page.url().includes('accounts.google.com') ? 'Google session logged out' : null))

        if (needsAttentionReason) {
          throw new Error(
            `NEEDS_ATTENTION: ${needsAttentionReason}. Open "Gemini Studio Live" -> Login Assist or log in once in the persistent Chrome profile.`,
          )
        }

        // (b) Configure Run Settings (panel is already open in new chat: wait for elements, select model/fallback model, set Thinking=chosen level; leave panel open)
        currentStage = 'setup/run_settings'
        const runSettingsRes = await this.configureRunSettings(
          page,
          {
            modelName: activeModelName,
            maxOutputTokens,
            thinkingLevel: effectiveThinkingLevel,
            fallbackChain: MODEL_FALLBACK_CHAIN,
          },
          scope,
        )
        if (runSettingsRes.selectedModelName && runSettingsRes.selectedModelName !== activeModelName) {
          activeModelName = runSettingsRes.selectedModelName
          this.activeModelName = activeModelName
          const newIdx = MODEL_FALLBACK_CHAIN.findIndex(
            (m) => m.toLowerCase() === activeModelName.toLowerCase(),
          )
          if (newIdx >= 0) activeModelIndex = newIdx
        }

        // (c) Attach Video 1 = short part & Video 2 = movie_360p, set start/end & 24 FPS (waits 10s after each Save)
        // Guarded by RAM > 90% check and Global UPLOAD GATE (max 2 concurrent uploads across all scans/workers)
        globalStudioUploadGate.setMaxConcurrent(
          userCfg.studioUploadGateConcurrency || DEFAULT_STUDIO_UPLOAD_GATE,
        )

        const waitUntilRamSafeForAttach = async (stageLabel: string) => {
          let ramNow = readAutomationRamPercent()
          let loggedRamWait = false
          while (ramNow > 90) {
            await this.waitIfPausedOrThrowIfStopped(scope)
            currentStage = 'WAITING FOR RAM'
            if (!loggedRamWait) {
              loggedRamWait = true
              this.logStep(
                'WAITING FOR RAM',
                `RAM ${ramNow}% > 90% before ${stageLabel} — pausing media attach until RAM <= 90%`,
                'warn',
              )
              onLog?.('warn', `WAITING FOR RAM (${ramNow}% > 90%) before ${stageLabel} on ${jobLabel}`)
            }
            await new Promise((r) => setTimeout(r, 3000))
            ramNow = readAutomationRamPercent()
          }
        }

        await waitUntilRamSafeForAttach('attach_short')

        let releaseUploadGate: (() => void) | null = null
        if (parallelMode) {
          currentStage = 'WAITING FOR UPLOAD GATE'
          const holderKey = `${this.workerTag || this.profileDirName}:${scanId}`
          releaseUploadGate = await globalStudioUploadGate.acquire(holderKey, {
            isAborted: () => this.isStopping(scope),
            onWaiting: (inUse, maxConc, qPos) => {
              this.logStep(
                'WAITING FOR UPLOAD GATE',
                `Upload gate ${inUse}/${maxConc} busy (queue #${qPos}) — waiting before attaching videos`,
                'info',
              )
            },
          })
        }

        try {
          await waitUntilRamSafeForAttach('attach_short')
          currentStage = 'setup/attach_short'
          await this.attachVideoAndConfigureRange(page, {
            label: 'short',
            youtubeUrl: shortYoutubeUrl,
            driveFileName: shortDriveFileName,
            localFilePath: shortLocalPath,
            startSec: shortStartSec,
            endSec: shortEndSec,
            fps: 24,
            scope,
          })

          await waitUntilRamSafeForAttach('attach_movie')
          currentStage = 'setup/attach_movie'
          const attachMovieFilePath = windowClip?.clipPath || movieLocalPath
          const movieSizeMbForAttach = (() => {
            try {
              if (attachMovieFilePath && fs.existsSync(attachMovieFilePath)) {
                return Number((fs.statSync(attachMovieFilePath).size / (1024 * 1024)).toFixed(1))
              }
            } catch {
              /* ignore */
            }
            return 0
          })()
          const sampleAndLogAttachMovieMem = (phaseLabel: string, elapsedSec?: number) => {
            const ramPct = readAutomationRamPercent()
            const wStats = getWorkerChromeStats(this.profileDirName)
            const shmMb = readDevShmUsedMb()
            if (wStats.rssMb > 0) {
              this.lastSampledWorkerRssMb = wStats.rssMb
              if (wStats.rssMb > this.peakWorkerRssMb) {
                this.peakWorkerRssMb = wStats.rssMb
              }
            }
            const elapsedTag = elapsedSec !== undefined ? ` t=+${elapsedSec}s` : ''
            this.logStep(
              `attach_movie mem [${phaseLabel}]`,
              `${jobLabel}${elapsedTag} · RAM=${ramPct}% · workerChromeRSS=${wStats.rssMb}MB (peak=${this.peakWorkerRssMb}MB, procs=${wStats.procCount}) · /dev/shm=${shmMb}MB · movie=${movieSizeMbForAttach}MB`,
              ramPct >= 85 ? 'warn' : 'info',
            )
          }
          sampleAndLogAttachMovieMem('before')
          const attachStartMs = Date.now()
          const attachMemTimer = setInterval(() => {
            try {
              const elapsedSec = Math.round((Date.now() - attachStartMs) / 1000)
              sampleAndLogAttachMovieMem('3s-tick', elapsedSec)
            } catch {
              /* ignore timer error */
            }
          }, 3000)
          try {
            if (windowClip) {
              await this.attachVideoAndConfigureRange(page, {
                label: 'movie',
                driveFileName: null,
                localFilePath: windowClip.clipPath,
                startSec: 0,
                endSec: windowClip.durationSec,
                fps: 24,
                scope,
              })
            } else {
              await this.attachVideoAndConfigureRange(page, {
                label: 'movie',
                driveFileName: movieDriveFileName,
                localFilePath: movieLocalPath,
                startSec: movieStartSec,
                endSec: movieEndSec,
                fps: 24,
                scope,
              })
            }
          } finally {
            clearInterval(attachMemTimer)
            const totalElapsedSec = Math.round((Date.now() - attachStartMs) / 1000)
            sampleAndLogAttachMovieMem('after', totalElapsedSec)
          }
        } finally {
          if (releaseUploadGate) {
            releaseUploadGate()
            releaseUploadGate = null
          }
        }

        // (d) Paste the chunk prompt text BEFORE reading the input token counter and BEFORE pressing Run
        currentStage = 'setup/prompt_paste'
        const promptText = buildStudioChunkPrompt({
          movieWindowSec: movieEndSec - movieStartSec,
          shortPartSec: shortEndSec - shortStartSec,
          sanitized,
        })

        const promptInput = await findFirstVisibleLocator(page, STUDIO_SELECTORS.promptInput, 5000)
        if (!promptInput) {
          throw new Error('Could not find prompt input textarea on AI Studio page')
        }
        await promptInput.click()
        await promptInput.fill(promptText)

        // Wait up to 60 s for AI Studio to finish counting tokens for both attached videos + pasted prompt text:
        // poll every 1 s, log each reading in the step log, and accept the value only when
        // it is >= minPlausible24FpsTokens AND unchanged for 3 consecutive reads (counter settled).
        currentStage = 'setup/token_poll'
        let tokens: number | null = null
        let settledTokens: number | null = null
        let lastReadTokens: number | null = null
        let consecutiveSameReads = 0
        let pollCount = 0
        const tokenWaitDeadline = Date.now() + 60_000

        while (Date.now() < tokenWaitDeadline) {
          await new Promise((r) => setTimeout(r, 1000))
          pollCount += 1
          const readVal = await this.readStudioTokenCount(page)
          if (readVal !== null) {
            tokens = readVal
            if (readVal >= minPlausible24FpsTokens) {
              if (readVal === lastReadTokens) {
                consecutiveSameReads += 1
              } else {
                lastReadTokens = readVal
                consecutiveSameReads = 1
              }
            } else {
              lastReadTokens = readVal
              consecutiveSameReads = 0
            }
            this.logStep(
              `token poll ${pollCount}s`,
              `${readVal.toLocaleString()} tokens (min ${minPlausible24FpsTokens.toLocaleString()}, settled ${consecutiveSameReads}/3)`,
            )
            if (readVal >= minPlausible24FpsTokens && consecutiveSameReads >= 3) {
              settledTokens = readVal
              tokens = settledTokens
              break
            }
          } else {
            lastReadTokens = null
            consecutiveSameReads = 0
            this.logStep(`token poll ${pollCount}s`, 'null (counter not readable)')
          }
        }

        if (tokens === null) {
          const warnMsg = `Token counter was never readable (null) after 60s for ${jobLabel} — continuing with fallback estimate`
          this.logStep('token counter warning', warnMsg, 'warn')
          onLog?.('warn', warnMsg)
        } else if (settledTokens === null) {
          throw new Error(
            `FPS/range not applied: token counter (${tokens}) is implausibly low for ${totalVideoSec.toFixed(0)}s at 24 FPS (expected >= ${minPlausible24FpsTokens})`,
          )
        }

        // Item 1 & Item 2: Do the token-limit shrink check BEFORE pressing Run
        // (after both videos are attached and the prompt text is pasted).
        // Never run the shrink check after the run started!
        if (tokens !== null && tokens > effectiveMaxInputTokens) {
          const msg = `ERROR [context-limit] Studio token counter is ${(tokens / 1000).toFixed(0)}K (> ${(effectiveMaxInputTokens / 1000).toFixed(0)}K limit [${effectiveMaxInputTokens.toLocaleString()}]) for ${jobLabel} — splitting movie window into 2 equal halves`
          this.logStep('ERROR [context-limit]', msg, 'warn')
          onLog?.('warn', msg)
          await this.saveRotatedSessionFromContext(username)
          return {
            status: 'shrink_needed',
            tokenCount: tokens,
            maxInputTokens: effectiveMaxInputTokens,
          }
        }

        // Wait 10 seconds after the prompt is pasted and the token counter has settled, then press Run
        await new Promise((r) => setTimeout(r, 10_000))

        currentStage = 'run/execute'
        // Attach network response listener BEFORE pressing Run so we capture exact GenerateContent status + body on 403/errors
        // and track GenerateContent/StreamGenerateContent request completion for the completion gate.
        let capturedRunError: { status: number; url: string; body: string } | null = null as {
          status: number
          url: string
          body: string
        } | null
        let capturedFinishReason: string | null = null
        let genContentSeenCount = 0
        let genContentInFlight = 0
        const onRunResponse = async (res: PlaywrightResponse) => {
          try {
            const url = res.url()
            const status = res.status()
            const isGenContentStream = /GenerateContent|StreamGenerateContent/i.test(url)
            if (isGenContentStream) {
              genContentSeenCount += 1
              genContentInFlight += 1
              void res
                .finished()
                .catch(() => null)
                .finally(() => {
                  genContentInFlight = Math.max(0, genContentInFlight - 1)
                })
            }
            const isGenApi =
              /GenerateContent|StreamGenerateContent|MakerSuiteService|alkali|generativelanguage|batchexecute|aistudio\.google\.com\/_\//i.test(
                url,
              )
            if (!isGenApi && status < 400) return
            if (status >= 400 || /GenerateContent|StreamGenerateContent|MakerSuiteService|alkali|batchexecute/i.test(url)) {
              const text = await res.text().catch(() => '')
              const finishMatch =
                text.match(/"finishReason"\s*:\s*"([^"]+)"/i) ||
                text.match(/\b(MAX_TOKENS|PROHIBITED_CONTENT|SAFETY|RECITATION|STOP)\b/)
              if (finishMatch && finishMatch[1]) {
                capturedFinishReason = finishMatch[1].toUpperCase()
              }
              if (
                status >= 400 ||
                /PERMISSION_DENIED|caller does not have permission|"error"\s*:/i.test(text)
              ) {
                const compactBody = text.replace(/\s+/g, ' ').trim().slice(0, 600)
                capturedRunError = { status, url, body: compactBody || `HTTP ${status} (${url.slice(0, 120)})` }
              }
            }
          } catch {
            /* ignore response read race */
          }
        }
        page.on('response', onRunResponse)

        let runStarted = Date.now()
        const TIMEOUT_MS = 10 * 60_000
        const INCOMPLETE_REASONS = new Set([
          'empty',
          'missing_hissa',
          'empty_hissa2',
          'truncated_last_line',
          'thinking_only',
        ])
        let rawAnswer = ''
        let lastCandidateText = ''
        let stableSeconds = 0
        let stopEverSeen = false
        let stopGoneConsecutivePolls = 0
        let hissa2FirstSeenLogged = false
        let incompleteAfterAbStartedAt: number | null = null
        let lastIncompleteLogAt = 0
        let doneIndicator: 'COMPLETION_GATE' | 'INCOMPLETE_60S_CAP' | null = null
        let permissionDeniedTriggered = false
        let internalErrorDetected = false
        let internalErrorContinueTriedInChat = false
        let quotaContinuePartialText: string | null = null
        let transientBannerReason: string | null = null

        const cancelStuckStopButtonIfVisible = async () => {
          try {
            const stuckStop = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 250)
            if (stuckStop) {
              this.logStep('canceling stuck generation', `${jobLabel}: clicking Stop button`, 'warn')
              await stuckStop.click().catch(() => {})
              const stopWaitDeadline = Date.now() + 5000
              while (Date.now() < stopWaitDeadline) {
                const stillThere = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 100)
                if (!stillThere) break
                await new Promise((r) => setTimeout(r, 250))
              }
            }
          } catch {
            /* ignore */
          }
        }

        try {
          // (e) Press Run
          const runBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 4000)
          if (runBtn) {
            await runBtn.click()
          } else {
            await promptInput.press('Control+Enter')
          }
          this.logStep('press Run', `${jobLabel} [${activeModelName}]`)

          // Poll every 1 s up to 10-min timeout.
          while (Date.now() - runStarted < TIMEOUT_MS) {
            await this.waitIfPausedOrThrowIfStopped(scope)

            // Priority 1: Check network response + page text for 403 PERMISSION_DENIED as soon as Run is pressed
            const domPermissionDenied = await page
              .evaluate(() => {
                const bodyText = document.body?.innerText || ''
                return /failed to generate content[\s\S]{0,80}permission denied|caller does not have permission/i.test(
                  bodyText,
                )
              })
              .catch(() => false)

            const netPermissionDenied =
              capturedRunError !== null &&
              (capturedRunError.status === 403 ||
                /PERMISSION_DENIED|caller does not have permission/i.test(capturedRunError.body))

            if (domPermissionDenied || netPermissionDenied) {
              if (!capturedRunError) {
                await new Promise((r) => setTimeout(r, 500))
              }
              const toastText = await this.readPageToastOrErrorText(page)
              const statusLabel = capturedRunError?.status || 403
              const bodySnippet =
                capturedRunError?.body ||
                toastText ||
                'The caller does not have permission (no response body captured)'
              const exactErrLog = `ERROR [run] ${statusLabel} PERMISSION_DENIED: ${bodySnippet}${
                toastText && !bodySnippet.includes(toastText) ? ` | Toast: ${toastText}` : ''
              } (model=${activeModelName})`

              this.logStep('ERROR [run] 403 PERMISSION_DENIED', exactErrLog, 'error')
              onLog?.('error', `${exactErrLog} on ${jobLabel}`)

              permissionDeniedRetries += 1

              // Model fallback: advance to next non-exhausted model in MODEL_FALLBACK_CHAIN without marking quota state
              const prevModel = activeModelName
              const quotaSnap = await loadStudioModelQuotaState()
              const nonExhaustedChain = MODEL_FALLBACK_CHAIN.filter(
                (m) => !quotaSnap.exhausted[canonicalizeStudioModelName(m)],
              )
              const chainToCycle =
                nonExhaustedChain.length > 0 ? nonExhaustedChain : MODEL_FALLBACK_CHAIN
              const curIdxInCycle = chainToCycle.findIndex(
                (m) => m.toLowerCase() === prevModel.toLowerCase(),
              )
              const nextModelInCycle =
                curIdxInCycle >= 0 && curIdxInCycle + 1 < chainToCycle.length
                  ? chainToCycle[curIdxInCycle + 1]
                  : chainToCycle[(curIdxInCycle + 1) % chainToCycle.length]
              activeModelName = nextModelInCycle
              activeModelIndex = Math.max(
                0,
                MODEL_FALLBACK_CHAIN.findIndex((m) => m.toLowerCase() === activeModelName.toLowerCase()),
              )

              const nextResetLabel =
                permissionDeniedRetries % 2 === 1 ? '403 -> hard reset (page+cache)' : '403 -> browser restart'
              this.logStep(
                'permission denied - retrying',
                `${jobLabel} (retry ${permissionDeniedRetries}/${MAX_PERMISSION_RETRIES}) -> model fallback: ${prevModel} -> ${activeModelName} (waiting 15s, then ${nextResetLabel})`,
                'warn',
              )
              onLog?.(
                'warn',
                `AI Studio 403 PERMISSION_DENIED on ${jobLabel} with ${prevModel} (retry ${permissionDeniedRetries}/${MAX_PERMISSION_RETRIES}) — waiting 15s, then ${nextResetLabel} and switching model to "${activeModelName}"`,
              )

              if (permissionDeniedRetries >= MAX_PERMISSION_RETRIES) {
                throw new Error(
                  `PERMISSION_DENIED_EXHAUSTED: ${exactErrLog} after ${MAX_PERMISSION_RETRIES} permission attempts on ${jobLabel}`,
                )
              }
              await new Promise((r) => setTimeout(r, 15_000))
              permissionDeniedTriggered = true
              break
            }

            const elapsed = Math.floor((Date.now() - runStarted) / 1000)
            const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
            const ss = String(elapsed % 60).padStart(2, '0')
            this.logStep(`running ${mm}:${ss}`, `${jobLabel} [${activeModelName}]`)

            // Error/quota/alert banner detection + last model turn error detection
            const errBannerText = await page.evaluate((sels) => {
              const strictRegex =
                /(quota\s+exceeded|resource[_\s]+exhausted|rate\s+limit|try\s+again\s+later|you\s+have\s+exceeded\s+your\s+quota|prohibited_content|blocked\s+due\s+to\s+safety|an\s+internal\s+error\s+has\s+occurred|internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate)/i
              for (const s of sels) {
                if (s.includes(':has-text(')) continue
                try {
                  const nodes = Array.from(document.querySelectorAll(s))
                  for (const node of nodes) {
                    const el = node as HTMLElement
                    if (!el || !el.innerText) continue
                    const visible = el.offsetParent !== null || el.getClientRects().length > 0
                    if (!visible) continue
                    const t = el.innerText.trim()
                    if (strictRegex.test(t)) {
                      return t
                    }
                  }
                } catch {
                  // ignore invalid selector
                }
              }
              return null
            }, [...STUDIO_SELECTORS.errorBanners])

            const netQuotaExceeded =
              capturedRunError !== null &&
              (capturedRunError.status === 429 ||
                /RESOURCE_EXHAUSTED|quota\s+exceeded|rateLimitExceeded/i.test(capturedRunError.body))

            const domQuotaExceeded =
              errBannerText !== null &&
              /(quota\s+exceeded|resource[_\s]+exhausted|rate\s+limit|you\s+have\s+exceeded\s+your\s+quota)/i.test(
                errBannerText,
              )

            // Requirement 4 & 5: Quota Exceeded -> mark model exhausted, switch model in Run Settings, continue in SAME chat
            if (domQuotaExceeded || netQuotaExceeded) {
              const quotaDetail = errBannerText || capturedRunError?.body || 'HTTP 429 RESOURCE_EXHAUSTED'
              await cancelStuckStopButtonIfVisible()
              const exhaustedModel = activeModelName
              await markModelExhausted(exhaustedModel)

              const nextAvailableModel = await getEffectiveModel(chosenModel, MODEL_FALLBACK_CHAIN)
              if (!nextAvailableModel) {
                const resetTimeStr = await formatQuotaResetTime()
                const allExhaustedMsg = `NEEDS_ATTENTION: saare models ka quota khatam, reset ${resetTimeStr} par`
                this.logStep('all models quota exhausted', allExhaustedMsg, 'error')
                onLog?.('error', `${allExhaustedMsg} (${jobLabel})`)
                throw new Error(allExhaustedMsg)
              }

              const switchLogMsg = `${jobLabel}: ${exhaustedModel} quota exhausted -> ${nextAvailableModel} par switch, same chat me continue (${quotaDetail.slice(0, 120)})`
              this.logStep('quota exhausted -> switch model', switchLogMsg, 'warn')
              onLog?.('warn', switchLogMsg)

              activeModelName = nextAvailableModel
              this.activeModelName = activeModelName
              activeModelIndex = Math.max(
                0,
                MODEL_FALLBACK_CHAIN.findIndex((m) => m.toLowerCase() === activeModelName.toLowerCase()),
              )

              const switchedRes = await this.selectModelInRunSettings(
                page,
                activeModelName,
                MODEL_FALLBACK_CHAIN,
              )
              if (switchedRes.selectedModelName) {
                activeModelName = switchedRes.selectedModelName
                this.activeModelName = activeModelName
              }

              const partialNow = await this.extractFinalAnswerWithoutThoughts(page)
              const hasPartialHissa =
                Boolean(partialNow && /\bHISSA\s*1\b/i.test(partialNow) && !isThinkingOnlyText(partialNow))

              if (hasPartialHissa) {
                quotaContinuePartialText = partialNow
                break
              }

              // No partial answer yet -> re-run in the SAME chat
              capturedRunError = null
              capturedFinishReason = null
              runStarted = Date.now()
              stopEverSeen = false
              stopGoneConsecutivePolls = 0
              stableSeconds = 0
              lastCandidateText = ''

              const retryRunBtn = await findFirstVisibleLocator(page, STUDIO_SELECTORS.runButton, 2500)
              const runBtnEnabled = retryRunBtn
                ? await retryRunBtn.isEnabled().catch(() => false)
                : false
              if (retryRunBtn && runBtnEnabled) {
                await retryRunBtn.click().catch(() => {})
                this.logStep('re-press Run (same chat)', `${jobLabel} [${activeModelName}]`, 'info')
                continue
              } else {
                // Prompt was already submitted as a turn -> send Continue in same chat
                quotaContinuePartialText = ''
                break
              }
            }

            if (errBannerText) {
              const netDetail = capturedRunError
                ? ` | HTTP ${capturedRunError.status}: ${capturedRunError.body}`
                : ''
              this.logStep('error banner', `${errBannerText.slice(0, 180)}${netDetail}`, 'warn')
              onLog?.(
                'warn',
                `Matched AI Studio error banner on ${jobLabel}: "${errBannerText.slice(0, 200)}"${netDetail}`,
              )
              if (/(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(errBannerText)) {
                throw new Error(`POLICY_BLOCKED: ${errBannerText.slice(0, 180)}${netDetail}`)
              }
              if (
                /(token\s+limit|context\s+length|exceeds\s+the\s+maximum\s+number\s+of\s+tokens|input\s+is\s+too\s+long)/i.test(
                  errBannerText,
                )
              ) {
                const msg = `ERROR [context-limit] ${errBannerText.slice(0, 180)} on ${jobLabel} — splitting window in half`
                this.logStep('ERROR [context-limit]', msg, 'warn')
                onLog?.('warn', msg)
                return {
                  status: 'shrink_needed',
                  tokenCount: tokens || 975_000,
                  maxInputTokens: effectiveMaxInputTokens,
                }
              }
              if (
                /(an\s+internal\s+error\s+has\s+occurred|internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate)/i.test(
                  errBannerText,
                )
              ) {
                internalErrorDetected = true
                transientBannerReason = `internal_error:${errBannerText.slice(0, 80)}`
                break
              }
              throw new Error(`AI Studio banner error: ${errBannerText.slice(0, 180)}${netDetail}`)
            }

            const stopLoc = await findFirstVisibleLocator(page, STUDIO_SELECTORS.stopButton, 100)
            const stopVisible = Boolean(stopLoc)
            if (stopVisible) {
              stopEverSeen = true
            }

            if (elapsed >= 2) {
              const spinnerVisible = await this.isThinkingOrRunningSpinnerVisible(page)
              if (!stopVisible && !spinnerVisible && (await this.checkLastTurnProhibited(page))) {
                throw new Error('POLICY_BLOCKED: Gemini prohibited content')
              }

              // Requirement 6: Also check the last model turn text + network 500/INTERNAL for "An internal error has occurred"
              const turnInternalError = await page
                .evaluate((turnSels) => {
                  let turns: Element[] = []
                  for (const sel of turnSels) {
                    if (sel.includes(':has-text(')) continue
                    try {
                      const found = Array.from(document.querySelectorAll(sel))
                      if (found.length > 0) {
                        turns = found
                        break
                      }
                    } catch {
                      // ignore
                    }
                  }
                  const lastTurn = turns[turns.length - 1] as HTMLElement | undefined
                  if (!lastTurn) return null
                  const t = (lastTurn.innerText || lastTurn.textContent || '').trim()
                  if (
                    /(an\s+internal\s+error\s+has\s+occurred|internal\s+error\s+has\s+occurred|something\s+went\s+wrong|failed\s+to\s+generate\s+content)/i.test(
                      t,
                    ) &&
                    !/permission\s+denied|caller\s+does\s+not\s+have\s+permission|quota\s+exceeded/i.test(t)
                  ) {
                    return t.slice(0, 160)
                  }
                  return null
                }, [...STUDIO_SELECTORS.modelTurnContainers])
                .catch(() => null)

              const netInternalError =
                capturedRunError !== null &&
                (capturedRunError.status === 500 ||
                  capturedRunError.status === 503 ||
                  /\bINTERNAL\b|internal\s+error\s+has\s+occurred/i.test(capturedRunError.body))

              if (turnInternalError || (netInternalError && !stopVisible && !spinnerVisible)) {
                internalErrorDetected = true
                transientBannerReason = `internal_error:${(turnInternalError || capturedRunError?.body || 'HTTP 500 INTERNAL').slice(0, 80)}`
                break
              }

              const candidateText = await this.extractFinalAnswerWithoutThoughts(page)

              if (!hissa2FirstSeenLogged && /HISSA\s*2\b/i.test(candidateText)) {
                hissa2FirstSeenLogged = true
                this.logStep(
                  'HISSA 2 first seen',
                  `${jobLabel} [${activeModelName}] (${candidateText.length} chars at ${mm}:${ss})`,
                )
              }

              if (candidateText === lastCandidateText) {
                stableSeconds += 1
              } else {
                lastCandidateText = candidateText
                stableSeconds = 1
              }

              if (stopEverSeen && !stopVisible && !spinnerVisible) {
                stopGoneConsecutivePolls += 1
              } else {
                stopGoneConsecutivePolls = 0
              }

              // COMPLETION GATE:
              // a) stop button not visible AND spinner not visible for >= 3 consecutive polls, and stopEverSeen is true
              // b) candidate text unchanged for >= 4 consecutive polls
              // c) validateStudioAnswer(candidateText, {shortWindowSec}) is NOT in {empty, missing_hissa, empty_hissa2, truncated_last_line, thinking_only}
              // d) GenerateContent/StreamGenerateContent request of THIS run has finished (if URL was matched)
              const condA =
                stopEverSeen && !stopVisible && !spinnerVisible && stopGoneConsecutivePolls >= 3
              const condB = stableSeconds >= 4
              const condD = genContentSeenCount === 0 || genContentInFlight === 0

              if (condA && condB) {
                let gateReason = 'empty'
                try {
                  const gateVal = validateStudioAnswer(candidateText, {
                    shortWindowSec: shortEndSec - shortStartSec,
                  })
                  gateReason = gateVal.ok ? 'ok' : gateVal.reason
                } catch {
                  gateReason = 'ok'
                }

                const condC = !INCOMPLETE_REASONS.has(gateReason)
                if (condC && condD) {
                  doneIndicator = 'COMPLETION_GATE'
                  this.logStep(
                    'done by COMPLETION_GATE',
                    `${jobLabel} [${activeModelName}] (stopGone=${stopGoneConsecutivePolls}s, stable=${stableSeconds}s, chars=${candidateText.length}, precheck=${gateReason}, genInFlight=${genContentInFlight})`,
                    'success',
                  )
                  break
                }

                if (!condC) {
                  const nowMs = Date.now()
                  if (incompleteAfterAbStartedAt === null) {
                    incompleteAfterAbStartedAt = nowMs
                    lastIncompleteLogAt = 0
                  }
                  const incompleteWaitSec = Math.floor((nowMs - incompleteAfterAbStartedAt) / 1000)
                  if (lastIncompleteLogAt === 0 || nowMs - lastIncompleteLogAt >= 15_000) {
                    lastIncompleteLogAt = nowMs
                    const nonEmptyLines = candidateText
                      .split('\n')
                      .filter((l) => l.trim().length > 0)
                    const lastLine =
                      nonEmptyLines.length > 0 ? nonEmptyLines[nonEmptyLines.length - 1] : ''
                    const lastLineTail = lastLine.slice(-80)
                    const incompleteLog = `answer still incomplete: ${gateReason}, ${candidateText.length} chars, last line tail=${lastLineTail}`
                    this.logStep('answer still incomplete', incompleteLog, 'warn')
                    onLog?.('warn', `${incompleteLog} on ${jobLabel}`)
                  }
                  if (incompleteWaitSec >= 60) {
                    doneIndicator = 'INCOMPLETE_60S_CAP'
                    this.logStep(
                      'incomplete 60s cap',
                      `answer still incomplete after 60s post-(a)+(b): ${gateReason}, ${candidateText.length} chars -> breaking to retry`,
                      'warn',
                    )
                    break
                  }
                }
              } else {
                incompleteAfterAbStartedAt = null
                lastIncompleteLogAt = 0
              }
            }

            await new Promise((r) => setTimeout(r, 1000))
          }
        } finally {
          page.off('response', onRunResponse)
        }

        if (permissionDeniedTriggered) {
          await this.saveRotatedSessionFromContext(username)
          resetOnPermissionDenied = true
          // Do NOT consume normal MAX_ATTEMPTS = 3; perform hard page reset or browser restart at the top of the loop and redo the full window setup
          attempt -= 1
          continue
        }

        // Fetch and validate answer (with Fix 6: 10s wait + single re-fetch if validation is INCOMPLETE,
        // and Fix 3: diagnostics + up to 2 CONTINUE follow-up attempts in the same chat)
        currentStage = 'run/validate'
        let validationReason = transientBannerReason || ''
        let fetchedSource: 'clipboard' | 'dom' = 'dom'
        let fetchedRawText = ''
        let accumulatedUnshiftedText = ''
        let validation: StudioValidationResult | null = null
        const shortDurationSec = shortEndSec - shortStartSec

        const shiftValidateAndCheckCoverage = (unshiftedInput: string): void => {
          rawAnswer = ''
          validation = null
          let answerText = isThinkingOnlyText(unshiftedInput)
            ? unshiftedInput.trim()
            : cleanStudioAnswerText(unshiftedInput)
          fetchedRawText = answerText
          let clipDurationExceeded = false

          if (windowClip && answerText && !isThinkingOnlyText(answerText)) {
            const maxMovieEnd = maxMovieEndSecInHissa2(answerText)
            if (maxMovieEnd > windowClip.durationSec + 10) {
              clipDurationExceeded = true
              rawAnswer = ''
              validationReason = 'movie_ts_exceed_clip_duration'
              this.logStep(
                'validate clip range',
                `movie_ts_exceed_clip_duration (maxMovieEnd=${maxMovieEnd.toFixed(3)}s > clipDuration=${windowClip.durationSec.toFixed(3)}s + 10s)`,
                'warn',
              )
            } else {
              answerText = shiftMovieTimestampsInHissa2(answerText, windowClip.clipStartFrame)
              fetchedRawText = answerText
            }
          }

          if (!clipDurationExceeded) {
            try {
              validation = validateStudioAnswer(answerText, {
                shortWindowSec: shortDurationSec,
              })
            } catch (valErr) {
              const valErrMsg = valErr instanceof Error ? valErr.message : String(valErr)
              this.logStep(
                'validate error',
                `ERROR [validate] validateStudioAnswer threw: ${valErrMsg} -> keeping answer as DONE (validation skipped)`,
                'warn',
              )
              onLog?.(
                'warn',
                `ERROR [validate] Studio validator exception: ${valErrMsg}. Marking DONE (validation skipped) and accepting answer.`,
              )
              rawAnswer = cleanStudioAnswerText(answerText)
              return
            }
          }

          const curVal = validation as StudioValidationResult | null
          if (!curVal) return

          if (!curVal.ok) {
            validationReason =
              !doneIndicator && curVal.reason === 'empty' ? 'timeout_10m' : curVal.reason
            return
          }

          // FIX 4: Clean HISSA 1 + HISSA 2 text (no UI noise, no Grounding Sources, no thumb_up/duration)
          let candidateCleanAnswer = cleanStudioAnswerText(curVal.cleanedText)

          // FIX 1: Coverage check (never compare HISSA 1 count with HISSA 2 count!) + out-of-window check
          if (parallelMode) {
            const parsedEntries = extractHissa1And2EntriesFromResponse(candidateCleanAnswer)
            const cov = checkHissa2ShortCoverage(parsedEntries.hissa2Entries, shortDurationSec)
            if (!cov.ok) {
              candidateCleanAnswer = ''
              validationReason = cov.reason || 'hissa2_coverage_gap'
            } else {
              if (cov.warning) {
                this.logStep('HISSA 2 coverage note', cov.warning, 'warn')
              }
              const outOfWin = parsedEntries.hissa2Entries.find(
                (e) =>
                  e.found &&
                  e.movieStartSec !== null &&
                  e.movieEndSec !== null &&
                  (e.movieStartSec < movieStartSec - 5 || e.movieEndSec > movieEndSec + 5),
              )
              if (outOfWin && outOfWin.movieStartSec !== null && outOfWin.movieEndSec !== null) {
                candidateCleanAnswer = ''
                validationReason = `out-of-window (${formatParallelTimecode(outOfWin.movieStartSec)}-${formatParallelTimecode(outOfWin.movieEndSec)} outside ${formatParallelTimecode(movieStartSec)}-${formatParallelTimecode(movieEndSec)} ±5s)`
              }
            }
          }

          if (candidateCleanAnswer) {
            rawAnswer = candidateCleanAnswer
            if (curVal.stats.softWarning) {
              this.logStep('result coverage note', curVal.stats.softWarning, 'warn')
            }
            const matchNote =
              curVal.stats.matchLineCount > 0 ? `${curVal.stats.matchLineCount} matches` : '0 matches'
            this.logStep(
              'SUCCESS [validate]',
              `result check OK (HISSA 1 + HISSA 2, ${curVal.stats.totalValidHissa2Lines} lines: ${matchNote}, ${curVal.stats.notFoundLineCount} notFound, source=${fetchedSource})`,
              'success',
            )
            onLog?.(
              'success',
              `SUCCESS [validate] ${jobLabel}: valid result (${curVal.stats.totalValidHissa2Lines} lines: ${matchNote}, ${curVal.stats.notFoundLineCount} not found, source=${fetchedSource})`,
            )
          }
        }

        const fetchShiftAndValidateOnce = async (): Promise<void> => {
          const fetched = await this.fetchStudioResultFromTurnOrFallback(page)
          fetchedSource = fetched.source
          accumulatedUnshiftedText = fetched.text || lastCandidateText
          shiftValidateAndCheckCoverage(accumulatedUnshiftedText)
        }

        // Requirement 4: If quota was exceeded after a partial answer arrived (or after prompt turn was sent),
        // continue in the SAME chat with the newly switched model and stitch!
        if (quotaContinuePartialText !== null) {
          accumulatedUnshiftedText = quotaContinuePartialText
          for (let qCont = 1; qCont <= 2 && !rawAnswer; qCont++) {
            try {
              const contText = await this.sendContinueFollowUpAndFetch(page, {
                jobLabel,
                activeModelName,
                continueAttempt: qCont,
                scope,
                onLog,
              })
              if (contText && contText.trim()) {
                accumulatedUnshiftedText = accumulatedUnshiftedText
                  ? stitchContinuedStudioAnswer(accumulatedUnshiftedText, contText)
                  : contText
                shiftValidateAndCheckCoverage(accumulatedUnshiftedText)
              }
            } catch (qContErr) {
              const qMsg = qContErr instanceof Error ? qContErr.message : String(qContErr)
              if (qMsg.startsWith('POLICY_BLOCKED:') || qMsg.startsWith('STOPPED')) {
                throw qContErr
              }
              if (/internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate/i.test(qMsg)) {
                internalErrorDetected = true
                transientBannerReason = `internal_error:${qMsg.slice(0, 80)}`
              }
              break
            }
          }
        }

        // Requirement 6: "An internal error has occurred" handling:
        // (a) Cancel stuck Stop button if visible, then try 1 Continue in the SAME chat ("internal error -> Continue (1/1)")
        // (b) If internal error happens again or result is still invalid -> hard refresh (up to MAX_INTERNAL_ERROR_REFRESH = 3) without consuming normal attempt
        if (internalErrorDetected && !rawAnswer) {
          await cancelStuckStopButtonIfVisible()

          if (!internalErrorContinueTriedInChat) {
            internalErrorContinueTriedInChat = true
            const partialBeforeErr = await this.extractFinalAnswerWithoutThoughts(page)
            const hasValidPartialBeforeErr =
              partialBeforeErr &&
              /\bHISSA\s*1\b/i.test(partialBeforeErr) &&
              !/^(?:an\s+internal\s+error|internal\s+error|something\s+went\s+wrong|failed\s+to\s+generate)/i.test(
                partialBeforeErr.trim(),
              )

            this.logStep(
              'internal error -> Continue (1/1)',
              `${jobLabel} [${activeModelName}] (${transientBannerReason || 'internal error'})`,
              'warn',
            )
            onLog?.(
              'warn',
              `${jobLabel}: internal error -> Continue (1/1) in same chat`,
            )

            try {
              const contAfterErr = await this.sendContinueFollowUpAndFetch(page, {
                jobLabel,
                activeModelName,
                continueAttempt: 1,
                scope,
                onLog,
              })
              if (contAfterErr && contAfterErr.trim()) {
                accumulatedUnshiftedText = hasValidPartialBeforeErr
                  ? stitchContinuedStudioAnswer(partialBeforeErr, contAfterErr)
                  : contAfterErr
                shiftValidateAndCheckCoverage(accumulatedUnshiftedText)
              }
            } catch (ieContErr) {
              const ieMsg = ieContErr instanceof Error ? ieContErr.message : String(ieContErr)
              if (ieMsg.startsWith('POLICY_BLOCKED:') || ieMsg.startsWith('STOPPED')) {
                throw ieContErr
              }
              this.logStep(
                'internal error Continue failed',
                `${jobLabel}: ${ieMsg.slice(0, 140)}`,
                'warn',
              )
            }
          }

          if (!rawAnswer) {
            await cancelStuckStopButtonIfVisible()
            if (internalErrorRefreshes < MAX_INTERNAL_ERROR_REFRESH) {
              internalErrorRefreshes += 1
              const refreshLog = `internal error again -> hard refresh (${internalErrorRefreshes}/${MAX_INTERNAL_ERROR_REFRESH})`
              this.logStep(refreshLog, `${jobLabel} [${activeModelName}]`, 'warn')
              onLog?.('warn', `${jobLabel}: ${refreshLog}`)
              await this.saveRotatedSessionFromContext(username)
              resetOnInternalError = true
              attempt -= 1
              continue
            }
          }
        }

        if (!transientBannerReason && quotaContinuePartialText === null) {
          await fetchShiftAndValidateOnce()

          // FIX 6 (after fetch): If validation failed with an INCOMPLETE reason, wait 10s once and re-fetch + re-validate
          const firstVal = validation as StudioValidationResult | null
          if (!rawAnswer && firstVal && !firstVal.ok && INCOMPLETE_REASONS.has(firstVal.reason)) {
            this.logStep(
              'incomplete post-fetch -> 10s re-fetch',
              `${jobLabel}: validation=${firstVal.reason} -> waiting 10s and re-fetching once before retry`,
              'warn',
            )
            await new Promise((r) => setTimeout(r, 10_000))
            await fetchShiftAndValidateOnce()
          }

          // FIX 3(a) & FIX 3(c): On incomplete/truncated result, capture diagnostics + screenshot,
          // and if HISSA 1 is present and NOT thinking_only, attempt up to 2 CONTINUE follow-ups in the same chat!
          if (
            !rawAnswer &&
            (INCOMPLETE_REASONS.has(validationReason) ||
              validationReason.startsWith('hissa2_coverage_gap'))
          ) {
            await this.captureIncompleteDiagnostics(page, {
              scanId,
              jobLabel,
              reason: validationReason,
              finishReason: capturedFinishReason,
              onLog,
            })

            const canContinueInSameChat =
              /\bHISSA\s*1\b/i.test(accumulatedUnshiftedText) &&
              validationReason !== 'thinking_only' &&
              !isThinkingOnlyText(accumulatedUnshiftedText) &&
              (validationReason === 'truncated_last_line' ||
                validationReason === 'empty_hissa2' ||
                validationReason === 'missing_hissa' ||
                validationReason.startsWith('hissa2_coverage_gap'))

            if (canContinueInSameChat) {
              for (let contAttempt = 1; contAttempt <= 2 && !rawAnswer; contAttempt++) {
                try {
                  this.logStep(
                    `CONTINUE recovery (${contAttempt}/2)`,
                    `${jobLabel}: reason=${validationReason} -> sending Continue in same chat`,
                    'warn',
                  )
                  const contText = await this.sendContinueFollowUpAndFetch(page, {
                    jobLabel,
                    activeModelName,
                    continueAttempt: contAttempt,
                    scope,
                    onLog,
                  })
                  if (contText && contText.trim()) {
                    accumulatedUnshiftedText = stitchContinuedStudioAnswer(
                      accumulatedUnshiftedText,
                      contText,
                    )
                    shiftValidateAndCheckCoverage(accumulatedUnshiftedText)
                  }
                } catch (contErr) {
                  const contMsg = contErr instanceof Error ? contErr.message : String(contErr)
                  if (contMsg.startsWith('POLICY_BLOCKED:') || contMsg.startsWith('STOPPED:')) {
                    throw contErr
                  }
                  this.logStep(
                    `continue #${contAttempt} error`,
                    `${jobLabel}: ${contMsg.slice(0, 160)}`,
                    'warn',
                  )
                  break
                }
              }
            }
          }
        }

        if (!rawAnswer) {
          const prohibitedDetected = await this.checkLastTurnProhibited(page)
          if (prohibitedDetected) {
            throw new Error('POLICY_BLOCKED: Gemini prohibited content')
          }
          invalidResultRetries += 1
          const badReason = validationReason || 'empty'
          const cleanedDiagText = cleanStudioAnswerText(fetchedRawText)
          const newlineCount = (cleanedDiagText.match(/\n/g) || []).length
          const first300 = JSON.stringify(cleanedDiagText.slice(0, 300))
          const last400 = JSON.stringify(cleanedDiagText.slice(-400))
          const badDiagMsg = `BAD_RESULT_DIAG [reason=${badReason}] fetchedSource=${fetchedSource} finishReason=${capturedFinishReason || 'unknown'} prohibited=${prohibitedDetected} rawLength=${fetchedRawText.length} cleanedLength=${cleanedDiagText.length} newlines=${newlineCount} first300=${first300} last400=${last400}`
          this.logStep('BAD result diagnostic', badDiagMsg, 'warn')
          onLog?.('warn', `${badDiagMsg} on ${jobLabel}`)
          this.logStep(
            `RETRY [runWindowJob] (${invalidResultRetries}/${MAX_INVALID_RESULT_RETRIES})`,
            `result BAD: ${badReason} -> naya chat, same window retry`,
            'warn',
          )
          onLog?.(
            'warn',
            `RETRY [runWindowJob] Studio result BAD (${badReason}) on ${jobLabel} — opening new chat and retrying same window (${invalidResultRetries}/${MAX_INVALID_RESULT_RETRIES})`,
          )
          if (parallelMode) {
            if (attempt >= MAX_ATTEMPTS) {
              throw new Error(`INVALID_RESULT_EXHAUSTED: ${badReason}`)
            }
            // In parallelMode, consume normal attempt (1..5) and retry in a new chat
            continue
          }
          if (invalidResultRetries > MAX_INVALID_RESULT_RETRIES) {
            throw new Error(`INVALID_RESULT_EXHAUSTED: ${badReason}`)
          }
          // Immediate retry in a new chat with zero backoff wait and without consuming MAX_ATTEMPTS
          attempt -= 1
          continue
        }

        // (f) Calibrate offset mode (relative 0:00 vs absolute startSec) and parse via parseChunkMatches!
        currentStage = 'run/parse'
        const calibrated = await this.calibrateAndParseMatches({
          username,
          rawText: rawAnswer,
          shortStartSec,
          shortEndSec,
          movieStartSec,
          movieEndSec,
          modelName: activeModelName,
          forceAbsoluteZeroOffset: parallelMode,
          onLog,
        })

        // Item 5: Page recycling after every N finished window jobs (success or failed) + rotated cookie persistence
        await this.recordFinishedWindowJobAndMaybeRecyclePage(
          username,
          effectiveRecycleInterval,
          onLog,
        )

        // Item 4: Token-report fallback — when Studio counter is not readable, estimate with 1940 tokens/sec (calibrated: 930K / 480 s).
        // The real counter always wins when readable.
        const fallbackTokens24Fps = Math.round(totalVideoSec * (activeMeasuredRate || 1940))
        const matchSummary =
          calibrated.matches.length > 0
            ? `found ${calibrated.matches.length} matches`
            : '0 matches'

        this.logStep('SUCCESS [runWindowJob]', `${jobLabel} [${activeModelName}]: ${matchSummary}`, 'success')
        onLog?.(
          'success',
          `SUCCESS [runWindowJob] ${jobLabel} [${activeModelName}]: ${matchSummary} (${tokens || fallbackTokens24Fps} tokens)`,
        )

        return {
          status: 'success',
          rawText: rawAnswer,
          tokenCount: tokens || fallbackTokens24Fps,
          isRealTokenCount: tokens !== null,
          matches: calibrated.matches,
          calibratedOffsetMode: calibrated.offsetMode,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)

        // User pause/stop must not be logged as error, use "STOPPED BY USER"
        const isUserStopped =
          msg === 'STOPPED BY USER' ||
          /stopped by user/i.test(msg) ||
          this.isStopping(scope)

        if (isUserStopped) {
          this.logStep('STOPPED BY USER', jobLabel, 'info')
          onLog?.('info', `STOPPED BY USER on ${jobLabel}`)
          throw new Error('STOPPED BY USER')
        }

        if (msg.startsWith('NEEDS_ATTENTION:')) {
          this.logStep('NEEDS ATTENTION', msg, 'error')
          onLog?.('error', msg)
          throw err
        }

        // Item 3: Do NOT retry on internal code bugs (TypeError / ReferenceError / SyntaxError / "is not a function").
        // Immediately log "ERROR [code-bug] <fn name> <stage>" and stop without waiting 15/30/45s.
        const isCodeBug =
          err instanceof TypeError ||
          err instanceof ReferenceError ||
          err instanceof SyntaxError ||
          /\bis not a function\b|\bis not defined\b|\bCannot read properties of\b|\bCannot destructure property\b/i.test(
            msg,
          )

        if (isCodeBug) {
          const fnFromMsg =
            msg.match(/([a-zA-Z0-9_$.]+)\s+is\s+not\s+a\s+function/i)?.[1] ||
            msg.match(/([a-zA-Z0-9_$.]+)\s+is\s+not\s+defined/i)?.[1]
          const fnFromStack =
            err instanceof Error && err.stack
              ? err.stack
                  .split('\n')
                  .slice(1)
                  .map((l) => l.match(/at\s+([a-zA-Z0-9_$.]+)/)?.[1])
                  .find((fn) => fn && !/^Object\.|^process\.|^async/.test(fn))
              : undefined
          const fnName = fnFromMsg || fnFromStack || 'unknownFn'
          const codeBugStep = `ERROR [code-bug] ${fnName} ${currentStage}`
          this.logStep(codeBugStep, msg, 'error')
          onLog?.('error', `${codeBugStep}: ${msg}`)
          throw new Error(`${codeBugStep}: ${msg}`)
        }

        if (
          msg.includes('PERMISSION_DENIED_EXHAUSTED:') ||
          msg.includes('INVALID_RESULT_EXHAUSTED:')
        ) {
          this.logStep(`ERROR [${currentStage}]`, msg, 'error')
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw err
        }
        const isPolicy =
          msg.startsWith('POLICY_BLOCKED:') ||
          /(prohibited_content|blocked\s+due\s+to\s+safety)/i.test(msg)
        if (isPolicy) {
          const policyErr = msg.startsWith('POLICY_BLOCKED:') ? msg : `POLICY_BLOCKED: ${msg}`
          this.logStep(`ERROR [${currentStage}]`, policyErr, 'error')
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw new Error(policyErr)
        }

        const isCrash = this.isBrowserOrTargetCrashError(msg)
        const backoffSec = 15

        if (isCrash) {
          await new Promise((r) => setTimeout(r, 150))
          const workerLabel = this.workerTag.replace(/^\[|\]$/g, '') || 'W00'
          const crashStep = `ERROR [crash] ${workerLabel} Target crashed -> browser restart`
          const ramAtCrashPct = readAutomationRamPercent()
          const liveWStats = getWorkerChromeStats(this.profileDirName)
          const workerRssMb =
            liveWStats.rssMb > 0 ? liveWStats.rssMb : this.lastSampledWorkerRssMb
          const peakRssMb = Math.max(workerRssMb, this.peakWorkerRssMb)
          const devShmMb = readDevShmUsedMb()
          let movieFileSizeMb = 0
          try {
            if (movieLocalPath && fs.existsSync(movieLocalPath)) {
              movieFileSizeMb = Number(
                (fs.statSync(movieLocalPath).size / (1024 * 1024)).toFixed(1),
              )
            }
          } catch {
            /* ignore */
          }
          const logFilePath =
            this.activeChromeLogPath ||
            resolveWorkerChromeLogFilePath(scanId, this.profileDirName, attempt)
          try {
            fs.appendFileSync(
              logFilePath,
              `[${new Date().toISOString()}] [TARGET_CRASHED] stage=${currentStage} attempt=${attempt}/${MAX_ATTEMPTS} RAM=${ramAtCrashPct}% workerChromeRSS=${workerRssMb}MB(peak=${peakRssMb}MB,procs=${liveWStats.procCount}) /dev/shm=${devShmMb}MB movieSize=${movieFileSizeMb}MB err=${msg}\n`,
              'utf8',
            )
          } catch {
            /* ignore */
          }
          const last30Lines = readLastLinesFromFile(logFilePath, 30)
          const tailFormatted = last30Lines.trim().length > 0
            ? last30Lines.split('\n').join(' ⏎ ')
            : '(no stderr lines captured)'
          const crashDetail = `stage=${currentStage} · attempt=${attempt}/${MAX_ATTEMPTS} · RAM=${ramAtCrashPct}% · workerChromeRSS=${workerRssMb}MB (peak=${peakRssMb}MB, procs=${liveWStats.procCount}) · /dev/shm=${devShmMb}MB · movieFile=${movieFileSizeMb}MB · log=${logFilePath} · err=${msg.slice(0, 120)} · ChromeLogLast30=[${tailFormatted}]`

          this.logStep(crashStep, crashDetail, 'error')
          onLog?.(
            'error',
            `${crashStep} (${crashDetail}) — restarting worker Chrome profile ${this.profileDirName} and retrying in ${backoffSec}s`,
          )
          // Immediately close dead context and clean up crashed Chrome processes for this worker profile
          await this.forceRestartDeadBrowser()

          if (attempt >= MAX_ATTEMPTS) {
            throw new Error(`${crashStep}: ${crashDetail}`)
          }
          this.logStep(
            `RETRY [runWindowJob] (${attempt}/${MAX_ATTEMPTS})`,
            `crash recovery -> fresh browser & new_chat in ${backoffSec}s`,
            'warn',
          )
          await new Promise((r) => setTimeout(r, backoffSec * 1000))
          continue
        }

        this.logStep(`ERROR [${currentStage}]`, msg.slice(0, 180), 'error')
        this.logStep(
          `RETRY [runWindowJob] (${attempt}/${MAX_ATTEMPTS})`,
          `stage=${currentStage} · ${msg.slice(0, 100)} — waiting ${backoffSec}s`,
          'warn',
        )
        onLog?.(
          'warn',
          `ERROR [${currentStage}] Studio job ${jobLabel} attempt ${attempt}/${MAX_ATTEMPTS}: ${msg} — retrying in ${backoffSec}s...`,
        )
        if (attempt >= MAX_ATTEMPTS) {
          // Dump diagnostic HTML on final failed attempt (only if page is alive and not crashed)
          this.suppressDiagDumps = false
          try {
            const p = this.page
            if (p && !p.isClosed() && !this.pageCrashed) {
              await this.dumpRunSettingsPanelDiagnostics(p, `Final failed attempt (${attempt}/${MAX_ATTEMPTS}): ${msg.slice(0, 120)}`)
            }
          } catch {
            /* ignore diag dump error */
          }
          await this.recordFinishedWindowJobAndMaybeRecyclePage(
            username,
            effectiveRecycleInterval,
            onLog,
          )
          throw err
        }
        await new Promise((r) => setTimeout(r, backoffSec * 1000))
      }
    }

    throw new Error(`Studio job ${jobLabel} failed after ${MAX_ATTEMPTS} attempts`)
  }

  /**
   * Requirement 5(g) Calibration:
   * When start/end offset is set on a video in Studio, check whether the model's timestamps
   * in the answer are 0:00-based (relative to clip start) or start-offset-based (absolute to full video),
   * and apply the right offset so parseChunkMatches gets accurate timestamps.
   */
  private async calibrateAndParseMatches(params: {
    username: string
    rawText: string
    shortStartSec: number
    shortEndSec: number
    movieStartSec: number
    movieEndSec: number
    modelName: string
    forceAbsoluteZeroOffset?: boolean
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<{ matches: ChunkMatch[]; offsetMode: 'relative' | 'absolute' }> {
    const {
      username,
      rawText,
      shortStartSec,
      shortEndSec,
      movieStartSec,
      movieEndSec,
      modelName,
      forceAbsoluteZeroOffset = false,
      onLog,
    } = params

    if (forceAbsoluteZeroOffset) {
      const parsedZeroOffset = parseChunkMatches(rawText, 0, 0, modelName)
      return {
        matches: parsedZeroOffset.filter((m) => m.shortEnd - m.shortStart > 0.02),
        offsetMode: 'absolute',
      }
    }

    const cfg = await loadStudioUserConfig(username)
    let mode = cfg.studioOffsetMode

    // Parse raw timestamps with chunkOffset = 0 first to inspect the raw numbers returned by Gemini Studio
    const rawParsed = parseChunkMatches(rawText, 0, 0, modelName)
    const blockDur = Math.max(1, movieEndSec - movieStartSec)

    if (rawParsed.length > 0 && movieStartSec >= 60) {
      // Check if raw movie timestamps clearly fall in [movieStartSec, movieEndSec] vs [0, blockDur]
      const looksAbsolute = rawParsed.every(
        (m) => m.movieStart >= movieStartSec - 5 && m.movieEnd <= movieEndSec + 10,
      ) && rawParsed.some((m) => m.movieStart > blockDur + 5)

      const looksRelative = rawParsed.every(
        (m) => m.movieStart >= 0 && m.movieEnd <= blockDur + 10,
      ) && rawParsed.some((m) => m.movieStart < movieStartSec - 5)

      if (looksAbsolute && mode !== 'absolute') {
        mode = 'absolute'
        await saveStudioUserConfig(username, { studioOffsetMode: 'absolute' })
        onLog?.(
          'info',
          `Studio Timestamp Calibration: detected ABSOLUTE timestamps (model reports timestamps from full video clock ${fmtTime(movieStartSec)}–${fmtTime(movieEndSec)}). Saved calibration = absolute.`,
        )
      } else if (looksRelative && mode !== 'relative') {
        mode = 'relative'
        await saveStudioUserConfig(username, { studioOffsetMode: 'relative' })
        onLog?.(
          'info',
          `Studio Timestamp Calibration: detected RELATIVE timestamps (model reports 00:00-based clip timestamps for window ${fmtTime(movieStartSec)}–${fmtTime(movieEndSec)}). Saved calibration = relative.`,
        )
      }
    }

    const effectiveMode: 'relative' | 'absolute' = mode === 'absolute' ? 'absolute' : 'relative'
    const movieOffsetToAdd = effectiveMode === 'relative' ? movieStartSec : 0

    // Call unchanged parseChunkMatches from lib/gemini.ts with the calibrated movieOffset!
    const parsedWithMovieOffset = parseChunkMatches(rawText, 0, movieOffsetToAdd, modelName)

    // Apply the same calibrated offset logic to the short timestamps and clamp within the short part window
    const finalMatches = parsedWithMovieOffset
      .map((m) => {
        const shortIsAlreadyAbsolute =
          effectiveMode === 'absolute' ||
          (shortStartSec >= 60 && m.shortStart >= shortStartSec - 2 && m.shortEnd <= shortEndSec + 5)
        const absShortStart = shortIsAlreadyAbsolute ? m.shortStart : shortStartSec + m.shortStart
        const absShortEnd = shortIsAlreadyAbsolute ? m.shortEnd : shortStartSec + m.shortEnd
        return {
          ...m,
          shortStart: Math.min(shortEndSec, Math.max(shortStartSec, absShortStart)),
          shortEnd: Math.min(shortEndSec, Math.max(shortStartSec, absShortEnd)),
        }
      })
      .filter((m) => m.shortEnd - m.shortStart > 0.02)

    return { matches: finalMatches, offsetMode: effectiveMode }
  }
}

const globalForStudio = globalThis as unknown as {
  __cmtStudioController?: StudioBrowserController
}

if (globalForStudio.__cmtStudioController) {
  Object.setPrototypeOf(globalForStudio.__cmtStudioController, StudioBrowserController.prototype)
}

export const studioController =
  globalForStudio.__cmtStudioController ||
  (globalForStudio.__cmtStudioController = new StudioBrowserController())
