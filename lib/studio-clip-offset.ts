const SCAN_FPS = 24

/**
 * Parse "h:mm:ss(.mmm)" / "mm:ss(.mmm)" / "m:ss" into integer milliseconds
 * (same timestamp acceptance as parseTsFlexible in lib/gemini.ts, without float drift).
 */
export function parseTsFlexibleToMs(ts: string): number | null {
  const t = (ts || '').trim()
  const m3 = t.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/)
  if (m3) {
    const hrs = Number.parseInt(m3[1], 10)
    const mins = Number.parseInt(m3[2], 10)
    const secs = Number.parseInt(m3[3], 10)
    const ms = parseFractionToMs(m3[4])
    if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs) || ms === null) {
      return null
    }
    return (hrs * 3600 + mins * 60 + secs) * 1000 + ms
  }
  const m2 = t.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/)
  if (m2) {
    const mins = Number.parseInt(m2[1], 10)
    const secs = Number.parseInt(m2[2], 10)
    const ms = parseFractionToMs(m2[3])
    if (!Number.isFinite(mins) || !Number.isFinite(secs) || ms === null) {
      return null
    }
    return (mins * 60 + secs) * 1000 + ms
  }
  return null
}

function parseFractionToMs(frac: string | undefined): number | null {
  if (!frac) return 0
  if (frac.length === 3) {
    const n = Number.parseInt(frac, 10)
    return Number.isFinite(n) ? n : null
  }
  if (frac.length < 3) {
    const n = Number.parseInt(frac.padEnd(3, '0'), 10)
    return Number.isFinite(n) ? n : null
  }
  const n = Math.round(Number(`0.${frac}`) * 1000)
  return Number.isFinite(n) ? n : null
}

/**
 * Format integer milliseconds as:
 * - "mm:ss.mmm" (3 decimals) when < 1 h (< 3,600,000 ms)
 * - "h:mm:ss.mmm" (3 decimals) when >= 1 h
 */
export function formatMsAsMovieTimestamp(ms: number): string {
  const clampedMs = Math.max(0, Math.round(ms))
  const totalSec = Math.floor(clampedMs / 1000)
  const mmm = String(clampedMs % 1000).padStart(3, '0')
  const hrs = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (hrs >= 1) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${mmm}`
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${mmm}`
}

function splitAtHissa2Section(text: string): { prefix: string; hissa2: string } {
  const raw = typeof text === 'string' ? text : ''
  const hissa2Match = /HISSA\s*2\b/i.exec(raw)
  if (hissa2Match && hissa2Match.index !== undefined) {
    return {
      prefix: raw.slice(0, hissa2Match.index),
      hissa2: raw.slice(hissa2Match.index),
    }
  }
  // If HISSA 1 is present without HISSA 2, do not touch anything in HISSA 1
  if (/HISSA\s*1\b/i.test(raw)) {
    return { prefix: raw, hissa2: '' }
  }
  // Single-line / snippet unit test without section headers
  return { prefix: '', hissa2: raw }
}

/**
 * Return the maximum movie end timestamp (in seconds) across all matched lines
 * inside the HISSA 2 section of `text` (returns 0 if no matched movie ranges exist).
 */
export function maxMovieEndSecInHissa2(text: string): number {
  const { hissa2 } = splitAtHissa2Section(text)
  if (!hissa2) return 0

  let maxEndSec = 0
  const movieRe =
    /\bMovie[:\s]+((?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?)\s*(?:-|–|—|to)\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?)/gi

  let m: RegExpExecArray | null
  while ((m = movieRe.exec(hissa2)) !== null) {
    const startMs = parseTsFlexibleToMs(m[1])
    const endMs = parseTsFlexibleToMs(m[2])
    if (startMs !== null && startMs / 1000 > maxEndSec) {
      maxEndSec = startMs / 1000
    }
    if (endMs !== null && endMs / 1000 > maxEndSec) {
      maxEndSec = endMs / 1000
    }
  }
  return maxEndSec
}

/**
 * Shift clip-relative movie timestamps and movie frame numbers inside the HISSA 2 section
 * back to original-movie time:
 * - A' = A + offsetFrames / 24 (computed in exact integer milliseconds, no float drift)
 * - B' = B + offsetFrames / 24
 * - f1' = f1 + offsetFrames, f2' = f2 + offsetFrames (exact integers)
 * Leaves the Short range, HISSA 1, and NOT FOUND entries 100% byte-identical.
 */
export function shiftMovieTimestampsInHissa2(text: string, offsetFrames: number): string {
  if (typeof text !== 'string' || !text) return text
  const safeOffsetFrames = Math.round(Number(offsetFrames) || 0)
  const offsetMs = Math.round((safeOffsetFrames * 1000) / SCAN_FPS)

  const { prefix, hissa2 } = splitAtHissa2Section(text)
  if (!hissa2) return text

  const movieRangeWithOptionalFramesRe =
    /(\bMovie[:\s]+)((?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?)(\s*(?:-|–|—|to)\s*)((?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?)(?:(\s*\(\s*)(\d+)(\s*(?:-|–|—|to)\s*)(\d+)(\s*frames?\s*\)))?/gi

  const shiftedHissa2 = hissa2.replace(
    movieRangeWithOptionalFramesRe,
    (
      fullMatch,
      moviePrefix: string,
      tsA: string,
      rangeSep: string,
      tsB: string,
      frameOpen: string | undefined,
      f1Str: string | undefined,
      frameSep: string | undefined,
      f2Str: string | undefined,
      frameClose: string | undefined,
    ) => {
      const msA = parseTsFlexibleToMs(tsA)
      const msB = parseTsFlexibleToMs(tsB)
      if (msA === null || msB === null) {
        return fullMatch
      }
      const shiftedA = formatMsAsMovieTimestamp(msA + offsetMs)
      const shiftedB = formatMsAsMovieTimestamp(msB + offsetMs)

      if (
        frameOpen !== undefined &&
        f1Str !== undefined &&
        frameSep !== undefined &&
        f2Str !== undefined &&
        frameClose !== undefined
      ) {
        const f1 = Number.parseInt(f1Str, 10)
        const f2 = Number.parseInt(f2Str, 10)
        if (Number.isFinite(f1) && Number.isFinite(f2)) {
          const shiftedF1 = f1 + safeOffsetFrames
          const shiftedF2 = f2 + safeOffsetFrames
          return `${moviePrefix}${shiftedA}${rangeSep}${shiftedB}${frameOpen}${shiftedF1}${frameSep}${shiftedF2}${frameClose}`
        }
      }

      const computedF1 = Math.round(((msA + offsetMs) / 1000) * SCAN_FPS)
      const computedF2 = Math.round(((msB + offsetMs) / 1000) * SCAN_FPS)
      return `${moviePrefix}${shiftedA}${rangeSep}${shiftedB} (${computedF1}-${computedF2} frames)`
    },
  )

  return `${prefix}${shiftedHissa2}`
}
