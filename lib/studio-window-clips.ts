import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { extractWindowClip, probeDuration, verifyWindowClipFile } from './ffmpeg'
import type { CancelToken } from './ffmpeg-pool'

const SCAN_FPS = 24

export interface WindowClipInput {
  windowNumber: number
  startSec: number
  endSec: number
}

export interface WindowClipResult {
  clipPath: string
  clipStartFrame: number
  clipStartSec: number
  frameCount: number
  durationSec: number
  cached: boolean
}

export interface WindowClipSidecar {
  version: 1
  windowNumber: number
  startFrame: number
  endFrame: number
  frameCount: number
  clipStartSec: number
  durationSec: number
  movieSize: number
  movieMtimeMs: number
  size: number
  mtime: number
  createdAt: number
}

const globalForWindowClips = globalThis as unknown as {
  __cmtWindowClipInflight?: Map<string, Promise<WindowClipResult>>
  __cmtMovieDurationCache?: Map<
    string,
    { size: number; mtimeMs: number; promise: Promise<number> }
  >
}

function getInflightMap(): Map<string, Promise<WindowClipResult>> {
  if (!globalForWindowClips.__cmtWindowClipInflight) {
    globalForWindowClips.__cmtWindowClipInflight = new Map()
  }
  return globalForWindowClips.__cmtWindowClipInflight
}

function getMovieDurationCache(): Map<
  string,
  { size: number; mtimeMs: number; promise: Promise<number> }
> {
  if (!globalForWindowClips.__cmtMovieDurationCache) {
    globalForWindowClips.__cmtMovieDurationCache = new Map()
  }
  return globalForWindowClips.__cmtMovieDurationCache
}

/**
 * Persistent clips directory under <DATA_DIR>/media/<scanId>/clips.
 * Never writes under WORK_DIR (/dev/shm/cmt).
 */
export function getScanWindowClipsDir(scanId: string): string {
  return path.join(DATA_DIR, 'media', scanId, 'clips')
}

export function getWindowClipSidecarPath(clipPath: string): string {
  return clipPath.replace(/\.mp4$/i, '.json')
}

/**
 * Delete stale *.partial files in <DATA_DIR>/media/<scanId>/clips at scan start.
 */
export function cleanStaleWindowClipPartials(scanId: string): number {
  const clipsDir = getScanWindowClipsDir(scanId)
  if (!fs.existsSync(clipsDir)) return 0
  let removed = 0
  try {
    for (const name of fs.readdirSync(clipsDir)) {
      if (name.endsWith('.partial') || name.endsWith('.tmp')) {
        try {
          fs.rmSync(path.join(clipsDir, name), { force: true })
          removed += 1
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return removed
}

async function getProbedMovieDurationCached(
  moviePath: string,
  size: number,
  mtimeMs: number,
): Promise<number> {
  const cache = getMovieDurationCache()
  const cached = cache.get(moviePath)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return cached.promise
  }
  const promise = probeDuration(moviePath)
  promise.catch(() => {
    if (cache.get(moviePath)?.promise === promise) {
      cache.delete(moviePath)
    }
  })
  cache.set(moviePath, { size, mtimeMs, promise })
  return promise
}

function safeRemoveClipFiles(clipPath: string, sidecarPath: string) {
  for (const p of [clipPath, sidecarPath, `${clipPath}.json`, `${clipPath}.partial`, `${sidecarPath}.tmp`]) {
    try {
      fs.rmSync(p, { force: true })
    } catch {
      /* ignore */
    }
  }
}

function readValidSidecar(
  sidecarPath: string,
  altSidecarPath: string,
  expectedStartFrame: number,
  expectedFrameCount: number,
  movieSize: number,
  movieMtimeMs: number,
): boolean {
  const pathToRead = fs.existsSync(sidecarPath)
    ? sidecarPath
    : fs.existsSync(altSidecarPath)
      ? altSidecarPath
      : null
  if (!pathToRead) return false
  try {
    const raw = JSON.parse(fs.readFileSync(pathToRead, 'utf8')) as Partial<WindowClipSidecar>
    if (raw.version !== 1) return false
    if (raw.startFrame !== expectedStartFrame) return false
    if (raw.frameCount !== expectedFrameCount) return false
    const recordedSize = raw.movieSize ?? raw.size
    const recordedMtime = raw.movieMtimeMs ?? raw.mtime
    if (recordedSize !== movieSize) return false
    if (typeof recordedMtime !== 'number' || Math.round(recordedMtime) !== movieMtimeMs) return false
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the frame-exact window clip exists on persistent disk under:
 *   <DATA_DIR>/media/<scanId>/clips/win-<windowNumber>-f<startFrame>-<endFrame>.mp4
 * with sidecar .json written ONLY AFTER the successful atomic rename.
 *
 * Reuses a cached clip ONLY if:
 *   1. clip + sidecar exist
 *   2. sidecar matches movie.mp4 size + mtime and window startFrame + frameCount (version=1)
 *   3. ffprobe video frame count matches frameCount (and 24 fps)
 * Otherwise deletes and re-extracts.
 *
 * Memoizes in-flight promises per clipPath so concurrent callers share ONE extraction.
 */
export async function ensureWindowClip(
  scanId: string,
  window: WindowClipInput,
  opts?: {
    token?: CancelToken
    moviePath?: string
  },
): Promise<WindowClipResult> {
  const sourceMoviePath = opts?.moviePath || path.join(DATA_DIR, 'media', scanId, 'movie.mp4')
  if (!fs.existsSync(sourceMoviePath)) {
    throw new Error(`Original movie.mp4 not found at ${sourceMoviePath}`)
  }
  const movieStat = fs.statSync(sourceMoviePath)
  if (movieStat.size <= 0) {
    throw new Error(`Original movie.mp4 is empty (0 bytes) at ${sourceMoviePath}`)
  }
  const movieSize = movieStat.size
  const movieMtimeMs = Math.round(movieStat.mtimeMs)

  const movieDur = await getProbedMovieDurationCached(sourceMoviePath, movieSize, movieMtimeMs)
  const movieLastFrame = Math.max(1, Math.round(movieDur * SCAN_FPS))
  const startFrame = Math.max(0, Math.round(window.startSec * SCAN_FPS))
  const clipStartSec = startFrame / SCAN_FPS
  const endFrame = Math.min(movieLastFrame, Math.round(window.endSec * SCAN_FPS))
  const frameCount = endFrame - startFrame
  if (frameCount <= 0) {
    throw new Error(
      `Invalid window clip frame range for Window #${window.windowNumber} (${window.startSec}s..${window.endSec}s): startFrame=${startFrame}, endFrame=${endFrame}, movieLastFrame=${movieLastFrame}`,
    )
  }
  const durationSec = frameCount / SCAN_FPS

  const clipsDir = getScanWindowClipsDir(scanId)
  fs.mkdirSync(clipsDir, { recursive: true })

  const clipPath = path.join(
    clipsDir,
    `win-${window.windowNumber}-f${startFrame}-${endFrame}.mp4`,
  )
  const sidecarPath = getWindowClipSidecarPath(clipPath)
  const altSidecarPath = `${clipPath}.json`

  const inflight = getInflightMap()
  const existingPromise = inflight.get(clipPath)
  if (existingPromise) {
    return existingPromise
  }

  const jobPromise = (async (): Promise<WindowClipResult> => {
    // Remove any leftover .partial for this clip before checking cache
    if (fs.existsSync(`${clipPath}.partial`)) {
      try {
        fs.rmSync(`${clipPath}.partial`, { force: true })
      } catch {
        /* ignore */
      }
    }

    // Check cache validity: clip + sidecar exist, sidecar matches movie size/mtime & frames, ffprobe frameCount matches
    if (fs.existsSync(clipPath)) {
      let cacheValid = false
      try {
        const clipStat = fs.statSync(clipPath)
        if (
          clipStat.size > 0 &&
          readValidSidecar(
            sidecarPath,
            altSidecarPath,
            startFrame,
            frameCount,
            movieSize,
            movieMtimeMs,
          )
        ) {
          await verifyWindowClipFile(clipPath, frameCount)
          cacheValid = true
        }
      } catch {
        cacheValid = false
      }

      if (cacheValid) {
        return {
          clipPath,
          clipStartFrame: startFrame,
          clipStartSec,
          frameCount,
          durationSec,
          cached: true,
        }
      }

      // Invalid/stale clip or sidecar -> delete and re-extract
      safeRemoveClipFiles(clipPath, sidecarPath)
    } else if (fs.existsSync(sidecarPath) || fs.existsSync(altSidecarPath)) {
      safeRemoveClipFiles(clipPath, sidecarPath)
    }

    const extracted = await extractWindowClip(
      sourceMoviePath,
      window.startSec,
      window.endSec,
      clipPath,
      opts?.token,
    )

    // Write sidecar .json ONLY AFTER extractWindowClip's successful atomic rename
    const sidecarData: WindowClipSidecar = {
      version: 1,
      windowNumber: window.windowNumber,
      startFrame: extracted.clipStartFrame,
      endFrame: extracted.clipStartFrame + extracted.frameCount,
      frameCount: extracted.frameCount,
      clipStartSec: extracted.clipStartSec,
      durationSec: extracted.durationSec,
      movieSize,
      movieMtimeMs,
      size: movieSize,
      mtime: movieMtimeMs,
      createdAt: Date.now(),
    }
    const tmpSidecar = `${sidecarPath}.tmp`
    fs.writeFileSync(tmpSidecar, JSON.stringify(sidecarData, null, 2), 'utf8')
    fs.renameSync(tmpSidecar, sidecarPath)

    return {
      clipPath,
      clipStartFrame: extracted.clipStartFrame,
      clipStartSec: extracted.clipStartSec,
      frameCount: extracted.frameCount,
      durationSec: extracted.durationSec,
      cached: false,
    }
  })()

  inflight.set(clipPath, jobPromise)
  try {
    return await jobPromise
  } finally {
    inflight.delete(clipPath)
  }
}
