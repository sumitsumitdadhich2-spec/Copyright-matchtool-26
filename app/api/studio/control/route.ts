import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getSession } from '@/lib/users'
import {
  studioController,
  type StudioTestClipLine,
} from '@/lib/studio-automation'
import {
  getStudioParallelManager,
  resolveScanMovieDurationSec,
} from '@/lib/studio-parallel-manager'
import { prepareStudioMovie360pAndDrive, ensureStudioShortReady } from '@/lib/media'
import { getScan, saveScan } from '@/lib/store'
import { MEDIA_DIR } from '@/lib/paths'
import {
  loadStudioUserConfig,
  saveStudioUserConfig,
  saveUserGoogleCookies,
} from '@/lib/studio-settings'
import { DEFAULT_STUDIO_MODEL_NAME } from '@/lib/studio-model-state'
import {
  buildStudioScanPlan,
  clipMatchToShortSegment,
  deriveChunkIndexForMovieTime,
  splitMovieBlockInHalf,
  type StudioScanJobPlan,
} from '@/lib/studio-window-planner'
import { fmtTime } from '@/lib/format'
import type { ChunkMatch, Scan, ShortSegmentState } from '@/lib/types'

interface ExpectedMatchEntry {
  short: string
  movie: string
  speed?: number
  note?: string
}

interface ExpectedNotFoundEntry {
  short: string
  note?: string
}

interface TestExpectedJson {
  short_duration_sec: number
  movie_duration_sec: number
  tolerance_sec: number
  matches: ExpectedMatchEntry[]
  not_found?: ExpectedNotFoundEntry[]
}

function parseTimeClock(raw: string): number {
  const parts = raw
    .trim()
    .split(':')
    .map((p) => Number(p.trim()))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function parseRangePair(rangeStr: string): { start: number; end: number } {
  const [left, right] = rangeStr.split('-').map((s) => s.trim())
  return {
    start: parseTimeClock(left || '0'),
    end: parseTimeClock(right || '0'),
  }
}

/**
 * Merge contiguous 1x match pieces (e.g. when a model splits a match at an internal scene cut)
 * while also keeping original pieces so comparison can match either single or stitched pieces.
 */
function buildComparisonPool(matches: ChunkMatch[], toleranceSec: number): ChunkMatch[] {
  const sorted = [...matches].sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
  const stitched: ChunkMatch[] = []
  for (const m of sorted) {
    const prev = stitched[stitched.length - 1]
    if (
      prev &&
      Math.abs(m.shortStart - prev.shortEnd) <= toleranceSec * 2 &&
      Math.abs(m.movieStart - prev.movieEnd) <= toleranceSec * 2
    ) {
      prev.shortEnd = m.shortEnd
      prev.movieEnd = m.movieEnd
    } else {
      stitched.push({ ...m })
    }
  }
  return [...stitched, ...sorted]
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }
  if (!studioController.canUserAccessStudio(session)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden: Studio browser is currently loaded for another user' },
      { status: 403 },
    )
  }
  const username = session.username

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    xRatio?: number
    yRatio?: number
    text?: string
    key?: string
    url?: string
    enabled?: boolean
    scanId?: string
    cookiesJson?: string
    minuteInput?: string
    minuteInputSource?: 'auto' | 'manual'
    concurrency?: number
    resumeExisting?: boolean
    windowId?: string
    subAction?: 'stop' | 'retry' | 'skip'
  }

  try {
    switch (body.action) {
      case 'save_cookies': {
        if (!body.cookiesJson || !body.cookiesJson.trim()) {
          return NextResponse.json({ ok: false, error: 'Paste Cookie-Editor JSON first' }, { status: 400 })
        }
        const saved = await saveUserGoogleCookies(username, body.cookiesJson)
        await studioController.applySavedCookiesToContext(username)
        return NextResponse.json({
          ok: true,
          cookieCount: saved.count,
          snapshot: await studioController.getSnapshot(false),
        })
      }
      case 'run_test_window': {
        const testDataDir = path.join(process.cwd(), 'test-data')
        const moviePath = path.join(testDataDir, 'TEST_movie_360p.mp4')
        const shortPath = path.join(testDataDir, 'TEST_short.mp4')
        const expectedPath = path.join(testDataDir, 'TEST_expected.json')

        if (!fs.existsSync(moviePath) || !fs.existsSync(shortPath) || !fs.existsSync(expectedPath)) {
          return NextResponse.json(
            {
              ok: false,
              error: 'Missing test-data files (TEST_movie_360p.mp4, TEST_short.mp4, TEST_expected.json)',
            },
            { status: 400 },
          )
        }

        const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as TestExpectedJson
        const shortDur = expected.short_duration_sec || 55
        const movieDur = expected.movie_duration_sec || 420
        const tolerance = expected.tolerance_sec ?? 0.15
        const chunkCount = Math.ceil(movieDur / 60)

        const cfg = await loadStudioUserConfig(username)

        // Build virtual scan + segment so the normal window planner splits 0-420s into 5-min windows
        const testSegments: ShortSegmentState[] = [
          {
            index: 0,
            start: 0,
            end: shortDur,
            status: 'pending',
            selected: true,
            chunks: Array.from({ length: chunkCount }, (_, i) => ({
              index: i,
              status: 'pending' as const,
              attempts: 0,
            })),
          },
        ]

        const virtualScan: Scan = {
          id: 'test-clip',
          createdAt: Date.now(),
          status: 'scanning',
          shortName: 'TEST_short.mp4',
          movieName: 'TEST_movie_360p.mp4',
          shortSize: null,
          movieSize: null,
          shortDuration: shortDur,
          movieDuration: movieDur,
          chunkCount,
          chunkingProgress: 100,
          chunks: testSegments[0].chunks,
          shortSegments: testSegments,
          matches: [],
          logs: [],
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
          report: null,
          modelStates: {},
        }

        const plannedJobs: StudioScanJobPlan[] = buildStudioScanPlan(virtualScan, testSegments, {
          windowMinutes: cfg.studioWindowMinutes || 5,
          shortPartMinutes: cfg.studioShortPartMinutes || 3,
          windowOverlapSec: cfg.studioWindowOverlapSec || 0,
        })

        studioController.clearStop({ scanId: 'test-clip', username })
        studioController.setTestClipResult({
          status: 'running',
          summary: `Running ${plannedJobs.length} planned window(s) for TEST_short.mp4 (0–${shortDur}s) × TEST_movie_360p.mp4 (0–${movieDur}s)...`,
          lines: [],
          startedAt: Date.now(),
        })

        void (async () => {
          const release = await studioController.acquireJobLock('test-clip', username)
          try {
            const queue: StudioScanJobPlan[] = [...plannedJobs]
            const collectedMatches: ChunkMatch[] = []
            let completed = 0

            while (queue.length > 0 && !studioController.isStopping({ scanId: 'test-clip', username })) {
              const wJob = queue.shift()!
              const { shortPart, movieBlock } = wJob
              const shrinkLevel = wJob.shrinkLevel ?? 0
              const jobLabel = `Test Clip Window ${completed + 1}/${completed + queue.length + 1}: ${shortPart.label} × ${movieBlock.label}`

              const res = await studioController.runWindowJob({
                username,
                scanId: 'test-clip',
                jobLabel,
                modelName: cfg.studioModelName || DEFAULT_STUDIO_MODEL_NAME,
                thinkingLevel: cfg.studioThinkingLevel,
                maxOutputTokens: cfg.studioMaxOutputTokens || 65536,
                maxInputTokens: cfg.studioMaxInputTokens,
                pageRecycleInterval: cfg.studioPageRecycleInterval,
                shortLocalPath: shortPath,
                shortStartSec: shortPart.startSec,
                shortEndSec: shortPart.endSec,
                movieLocalPath: moviePath,
                movieStartSec: movieBlock.startSec,
                movieEndSec: movieBlock.endSec,
              })

              if (res.status === 'shrink_needed') {
                const subBlocks =
                  shrinkLevel < 3
                    ? splitMovieBlockInHalf(virtualScan, movieBlock, cfg.studioWindowOverlapSec || 0)
                    : []
                if (subBlocks.length > 1) {
                  queue.unshift(
                    ...subBlocks.map((b, idx) => ({
                      jobIndex: wJob.jobIndex + idx,
                      shortPart,
                      movieBlock: b,
                      shrinkLevel: shrinkLevel + 1,
                    })),
                  )
                  continue
                }
                throw new Error(
                  `token counter too high (${res.tokenCount}) and block cannot be split`,
                )
              }

              if (res.status === 'success') {
                completed++
                collectedMatches.push(...res.matches)
                if (res.isRealTokenCount && res.tokenCount > 0) {
                  const testWinSec = Math.max(
                    1,
                    shortPart.endSec - shortPart.startSec + (movieBlock.endSec - movieBlock.startSec),
                  )
                  const measuredRate = Math.round((res.tokenCount / testWinSec) * 10) / 10
                  if (measuredRate > 100 && measuredRate < 4000) {
                    await saveStudioUserConfig(username, { studioMeasuredTokenRate: measuredRate })
                  }
                }
              }
            }

            // Compare collected matches with TEST_expected.json (tolerance 0.15 s) and log PASS/FAIL per line
            const pool = buildComparisonPool(collectedMatches, tolerance)
            const resultLines: StudioTestClipLine[] = []

            for (const exp of expected.matches || []) {
              const sRange = parseRangePair(exp.short)
              const mRange = parseRangePair(exp.movie)
              const expectedLabel = `${exp.short} --> ${exp.movie}`

              const matched = pool.find(
                (cand) =>
                  Math.abs(cand.shortStart - sRange.start) <= tolerance &&
                  Math.abs(cand.shortEnd - sRange.end) <= tolerance &&
                  Math.abs(cand.movieStart - mRange.start) <= tolerance &&
                  Math.abs(cand.movieEnd - mRange.end) <= tolerance,
              )

              const closest =
                matched ||
                pool.find(
                  (cand) => cand.shortStart < sRange.end && cand.shortEnd > sRange.start,
                )

              const actualStr = closest
                ? `${fmtTime(closest.shortStart)} - ${fmtTime(closest.shortEnd)} --> ${fmtTime(closest.movieStart)} - ${fmtTime(closest.movieEnd)}`
                : 'NOT FOUND'
              const pass = Boolean(matched)
              const lineLog = `${pass ? 'PASS' : 'FAIL'} | Expected: ${expectedLabel} | Actual: ${actualStr}${exp.note ? ` (${exp.note})` : ''}`
              console.log(`[Studio Test Clip] ${lineLog}`)
              studioController.logStep(pass ? 'TEST PASS' : 'TEST FAIL', lineLog, pass ? 'success' : 'error')

              resultLines.push({
                label: exp.short,
                pass,
                expected: expectedLabel,
                actual: actualStr,
                detail: exp.note,
              })
            }

            for (const nf of expected.not_found || []) {
              const sRange = parseRangePair(nf.short)
              const expectedLabel = `${nf.short} --> NOT FOUND`
              const overlapping = collectedMatches.find(
                (cand) =>
                  Math.min(cand.shortEnd, sRange.end) - Math.max(cand.shortStart, sRange.start) >
                  tolerance,
              )
              const pass = !overlapping
              const actualStr = overlapping
                ? `${fmtTime(overlapping.shortStart)} - ${fmtTime(overlapping.shortEnd)} --> ${fmtTime(overlapping.movieStart)} - ${fmtTime(overlapping.movieEnd)}`
                : 'NOT FOUND'
              const lineLog = `${pass ? 'PASS' : 'FAIL'} | Expected: ${expectedLabel} | Actual: ${actualStr}${nf.note ? ` (${nf.note})` : ''}`
              console.log(`[Studio Test Clip] ${lineLog}`)
              studioController.logStep(pass ? 'TEST PASS' : 'TEST FAIL', lineLog, pass ? 'success' : 'error')

              resultLines.push({
                label: nf.short,
                pass,
                expected: expectedLabel,
                actual: actualStr,
                detail: nf.note,
              })
            }

            const passedCount = resultLines.filter((l) => l.pass).length
            const allPass = resultLines.length > 0 && passedCount === resultLines.length
            const summary = `${allPass ? 'PASS' : 'FAIL'} (${passedCount}/${resultLines.length} lines within ±${tolerance}s tolerance)`
            studioController.setTestClipResult({
              status: allPass ? 'pass' : 'fail',
              summary,
              lines: resultLines,
              startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
              finishedAt: Date.now(),
            })
            studioController.logStep(
              allPass ? 'test clip PASS' : 'test clip FAIL',
              summary,
              allPass ? 'success' : 'error',
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const isUserStopped =
              msg === 'STOPPED BY USER' ||
              /stopped by user/i.test(msg) ||
              studioController.isStopping({ scanId: 'test-clip', username })

            if (isUserStopped) {
              console.log('[Studio Test Clip] STOPPED BY USER')
              studioController.logStep('test clip STOPPED', 'STOPPED BY USER', 'warn')
              studioController.setTestClipResult({
                status: 'stopped',
                summary: 'STOPPED BY USER',
                lines: [],
                startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
                finishedAt: Date.now(),
              })
              return
            }

            console.error('[Studio Test Clip] ERROR:', msg)
            studioController.logStep('test clip ERROR', msg, 'error')
            studioController.setTestClipResult({
              status: 'error',
              summary: `ERROR: ${msg}`,
              lines: [],
              startedAt: studioController.getTestClipResult()?.startedAt || Date.now(),
              finishedAt: Date.now(),
            })
          } finally {
            studioController.setJobContext(null, null, null)
            release()
          }
        })()

        return NextResponse.json({
          ok: true,
          started: true,
          plannedWindows: plannedJobs.length,
          snapshot: await studioController.getSnapshot(true),
        })
      }
      case 'test_login': {
        const res = await studioController.testLogin(username)
        const snap = await studioController.getSnapshot(true)
        return NextResponse.json({ ok: true, ...res, snapshot: snap })
      }
      case 'pause': {
        studioController.setPaused(true)
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'resume': {
        studioController.setPaused(false)
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'stop': {
        studioController.requestStop({
          scanId: body.scanId,
          username: session.role === 'admin' ? undefined : username,
        })
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(false) })
      }
      case 'assist_toggle': {
        const nextVal = Boolean(body.enabled)
        studioController.setAssistMode(nextVal)
        if (nextVal) {
          await studioController.ensurePage(username)
        }
        return NextResponse.json({ ok: true, snapshot: await studioController.getSnapshot(true) })
      }
      case 'click': {
        const snap = await studioController.performAssistAction(username, {
          type: 'click',
          xRatio: Number(body.xRatio) || 0,
          yRatio: Number(body.yRatio) || 0,
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'type': {
        const snap = await studioController.performAssistAction(username, {
          type: 'type',
          text: String(body.text || ''),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'key': {
        const snap = await studioController.performAssistAction(username, {
          type: 'key',
          key: String(body.key || 'Enter'),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'navigate': {
        const snap = await studioController.performAssistAction(username, {
          type: 'navigate',
          url: String(body.url || 'https://aistudio.google.com/prompts/new_chat'),
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'save_session': {
        const snap = await studioController.performAssistAction(username, {
          type: 'save_session',
        })
        return NextResponse.json({ ok: true, snapshot: snap })
      }
      case 'prepare_movie': {
        if (!body.scanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const scan = getScan(body.scanId)
        if (!scan) {
          return NextResponse.json({ ok: false, error: 'Scan not found' }, { status: 404 })
        }
        if (session.role !== 'admin' && scan.ownerUsername && scan.ownerUsername !== username) {
          return NextResponse.json(
            { ok: false, error: 'Forbidden: scan belongs to another user' },
            { status: 403 },
          )
        }
        void prepareStudioMovie360pAndDrive(body.scanId, undefined, undefined, scan.ownerUsername || username)
        return NextResponse.json({ ok: true })
      }
      case 'reset_parallel_minutes': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Select or create a scan first (missing scanId)' }, { status: 400 })
        }
        const scanObj = getScan(targetScanId)
        if (scanObj && session.role !== 'admin' && scanObj.ownerUsername && scanObj.ownerUsername !== username) {
          return NextResponse.json({ ok: false, error: 'Forbidden: scan belongs to another user' }, { status: 403 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        const resetRes = parallelMgr.resetMinuteInputToFound()
        const liveSnap = await parallelMgr.getLiveSnapshot(false)
        return NextResponse.json({
          ok: true,
          scanId: targetScanId,
          ...resetRes,
          parallelSnapshot: liveSnap,
        })
      }
      case 'save_parallel_config': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Select or create a scan first (missing scanId)' }, { status: 400 })
        }
        const scanObj = getScan(targetScanId)
        if (scanObj && session.role !== 'admin' && scanObj.ownerUsername && scanObj.ownerUsername !== username) {
          return NextResponse.json({ ok: false, error: 'Forbidden: scan belongs to another user' }, { status: 403 })
        }
        // Global concurrency default stays in user config; studioMinuteInput is per-scan
        if (body.concurrency !== undefined) {
          await saveStudioUserConfig(username, {
            studioConcurrency: Number(body.concurrency),
          })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        const movieDur = resolveScanMovieDurationSec(scanObj)
        const planned = parallelMgr.previewPlan(
          body.minuteInput,
          body.concurrency !== undefined ? Number(body.concurrency) : undefined,
          movieDur || undefined,
          { source: body.minuteInputSource },
        )
        const liveSnap = await parallelMgr.getLiveSnapshot(false)
        return NextResponse.json({
          ok: true,
          scanId: targetScanId,
          minuteInput: liveSnap.minuteInput,
          minuteInputSource: liveSnap.minuteInputSource,
          foundMinutesInput: liveSnap.foundMinutesInput,
          concurrency: liveSnap.concurrency,
          plannedWindows: planned,
          parallelSnapshot: liveSnap,
        })
      }
      case 'start_parallel_scan': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Select or create a scan first (missing scanId)' }, { status: 400 })
        }
        const targetScan: Scan | null = getScan(targetScanId) || null
        if (!targetScan) {
          return NextResponse.json({ ok: false, error: `Scan ${targetScanId} not found` }, { status: 404 })
        }
        if (session.role !== 'admin' && targetScan.ownerUsername && targetScan.ownerUsername !== username) {
          return NextResponse.json({ ok: false, error: 'Forbidden: scan belongs to another user' }, { status: 403 })
        }

        if (body.minuteInput !== undefined && body.minuteInput.trim()) {
          targetScan.studioMinuteInput = body.minuteInput.trim()
        }
        if (body.minuteInputSource) {
          targetScan.studioMinuteInputSource = body.minuteInputSource
        }
        if (body.concurrency !== undefined && Number.isFinite(Number(body.concurrency))) {
          targetScan.studioParallelConcurrency = Number(body.concurrency)
        }
        saveScan(targetScan)

        const movieDurationSec = resolveScanMovieDurationSec(targetScan) || 0

        const parallelMgr = getStudioParallelManager(targetScanId)
        const started = await parallelMgr.startParallelScan({
          username,
          scanId: targetScanId,
          minuteInput: body.minuteInput ?? targetScan.studioMinuteInput ?? undefined,
          minuteInputSource: body.minuteInputSource ?? targetScan.studioMinuteInputSource ?? undefined,
          concurrency: body.concurrency ?? targetScan.studioParallelConcurrency ?? undefined,
          shortDurationSec: targetScan.shortDuration || 150,
          movieDurationSec: movieDurationSec > 0 ? movieDurationSec : undefined,
          resumeExisting: Boolean(body.resumeExisting),
          onWindowMatches: async (_winState, matches) => {
            if (!targetScan) return
            const freshScan = getScan(targetScan.id)
            if (!freshScan) return
            for (const m of matches) {
              const absIdx = deriveChunkIndexForMovieTime(freshScan, m.movieStart)
              const withChunk: ChunkMatch = { ...m, chunkIndex: absIdx }
              const isDupGlobal = freshScan.matches.some(
                (ex) =>
                  Math.abs(ex.shortStart - withChunk.shortStart) < 1.2 &&
                  Math.abs(ex.movieStart - withChunk.movieStart) < 2.0,
              )
              if (!isDupGlobal) {
                freshScan.matches.push(withChunk)
              }
              for (const seg of freshScan.shortSegments || []) {
                const clipped = clipMatchToShortSegment(withChunk, seg.start, seg.end, freshScan)
                if (!clipped) continue
                seg.matches = seg.matches || []
                const isDupSeg = seg.matches.some(
                  (ex) =>
                    Math.abs(ex.shortStart - clipped.shortStart) < 1.2 &&
                    Math.abs(ex.movieStart - clipped.movieStart) < 2.0,
                )
                if (!isDupSeg) {
                  seg.matches.push(clipped)
                }
              }
            }
            saveScan(freshScan)
          },
        })

        return NextResponse.json({
          ok: true,
          ...started,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'pause_parallel': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        parallelMgr.pauseAll()
        return NextResponse.json({
          ok: true,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'resume_parallel': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        parallelMgr.resumeAll()
        return NextResponse.json({
          ok: true,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'stop_parallel': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        parallelMgr.stopAll()
        return NextResponse.json({
          ok: true,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'retry_failed_parallel': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        const retriedCount = await parallelMgr.retryFailedWindows(username)
        return NextResponse.json({
          ok: true,
          retriedCount,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'retry_prohibited_parallel': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        const retriedCount = await parallelMgr.retryProhibitedWindows(username)
        return NextResponse.json({
          ok: true,
          retriedCount,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      case 'parallel_window_action': {
        const targetScanId = (body.scanId || '').trim()
        if (!targetScanId) {
          return NextResponse.json({ ok: false, error: 'Missing scanId' }, { status: 400 })
        }
        if (!body.windowId || !body.subAction) {
          return NextResponse.json({ ok: false, error: 'Missing windowId or subAction' }, { status: 400 })
        }
        const parallelMgr = getStudioParallelManager(targetScanId)
        if (body.subAction === 'stop') {
          parallelMgr.stopWindow(body.windowId)
        } else if (body.subAction === 'skip') {
          parallelMgr.skipWindow(body.windowId)
        } else if (body.subAction === 'retry') {
          await parallelMgr.retryWindow(body.windowId, username)
        }
        return NextResponse.json({
          ok: true,
          parallelSnapshot: await parallelMgr.getLiveSnapshot(false),
        })
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown Studio action' }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
