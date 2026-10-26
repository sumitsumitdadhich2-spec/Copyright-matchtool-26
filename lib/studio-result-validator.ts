import { parseChunkMatches } from './gemini'

export interface StudioValidationStats {
  rawLength: number
  cleanedLength: number
  matchLineCount: number
  notFoundLineCount: number
  totalValidHissa2Lines: number
  maxShortEndSec: number | null
  reachedShortEnd?: boolean
  softWarning?: string
}

export interface StudioValidationResult {
  ok: boolean
  reason: string
  cleanedText: string
  stats: StudioValidationStats
}

const SPECIFIC_ERROR_PHRASES: readonly string[] = [
  'an internal error has occurred',
  'internal error',
  'failed to generate content',
  'something went wrong',
  'permission denied',
  'caller does not have permission',
  'quota exceeded',
  'resource exhausted',
  'rate limit',
  'try again later',
  'prohibited_content',
  'blocked due to safety',
  'model is overloaded',
]

const PROMPT_ECHO_PHRASES: readonly string[] = [
  'sirf hissa 1 aur hissa 2 do',
  'you are a forensic video analyst',
  'you are an automated visual frame-level',
  'watch video 1 from start to finish and break it into',
  '1:1 same-duration mapping (sabse important rule)',
  'har matched line ka format:',
]

/**
 * Check whether text is actually our prompt (or starts with our prompt/thinking header without answer).
 */
export function isPromptEchoText(text: string): boolean {
  const lower = (text || '').toLowerCase()
  for (const phrase of PROMPT_ECHO_PHRASES) {
    if (lower.includes(phrase)) {
      return true
    }
  }
  return false
}

/**
 * FIX 3(b): Detect thinking-only text when "HISSA 1" is absent and model reasoning/thought markers are present.
 */
export function isThinkingOnlyText(text: string): boolean {
  const raw = (text || '').trim()
  if (!raw) return false
  if (/\bHISSA\s*1\b/i.test(raw)) return false
  return (
    /\bMATCHED\s+SECTION\b/i.test(raw) ||
    /\bSub-segment\b/i.test(raw) ||
    /\bOffset\s*=/i.test(raw) ||
    /\bInitiating\s+Video\s+Analysis\b/i.test(raw) ||
    /\bMovie:\s*frame\s*\d+/i.test(raw) ||
    /\bShort:\s*frame\s*\d+/i.test(raw) ||
    /^(?:Thoughts|Thinking)\b/i.test(raw) ||
    /\bLet(?:'s|\s+me)\s+(?:analyze|check|verify|scan|look\s+at)\b/i.test(raw)
  )
}

/**
 * Clean DOM / clipboard noise from an AI Studio model turn response:
 * 1. Strip leading UI icon tokens ("edit", "more_vert", "content_copy", "flag", "auto_awesome").
 * 2. Strip any thinking leak / preamble before "HISSA 1".
 * 3. Strip Grounding with Google Search footer blocks ("Sources help...", "Google Search Suggestions...", "Learn more") after HISSA 2.
 * 4. Strip trailing UI tokens ("thumb_up", "thumb_down", "thumb_upthumb_down", "more_vert", "edit") and turn duration tokens (e.g. "6m31.5s", "12.4s").
 * 5. Ensure line breaks exist around HISSA 1 / HISSA 2 headings and before each HISSA 1 / HISSA 2 entry even if DOM extraction flattened lines.
 */
export function cleanStudioAnswerText(text: string): string {
  if (typeof text !== 'string' || !text) return ''
  let s = text.replace(/\r\n/g, '\n').trim()
  if (!s) return ''

  // Strip standalone UI icon lines anywhere in the text
  s = s.replace(/^[ \t]*(?:edit|more_vert|content_copy|flag|auto_awesome)[ \t]*$/gim, '')

  // Strip leading UI icon words at the very beginning
  s = s.replace(/^(?:\s*(?:edit|more_vert|content_copy|flag|auto_awesome)\b\s*)+/i, '').trim()

  // Strip everything before "HISSA 1" (unless it's a prompt echo, which validator catches separately)
  const hissa1Match = /HISSA\s*1\b/i.exec(s)
  if (hissa1Match && !isPromptEchoText(s)) {
    s = s.slice(hissa1Match.index).trim()
  }

  // Strip Grounding / Google Search Suggestions block after HISSA 2
  const hissa2Check = /HISSA\s*2\b/i.exec(s)
  if (hissa2Check) {
    const beforeH2 = s.slice(0, hissa2Check.index)
    let fromH2 = s.slice(hissa2Check.index)

    fromH2 = fromH2.replace(
      /(?:\n|\s)*(?:Sources\s+help\b|Google\s+Search\s+Suggestions\b|Display\s+of\s+Search\s+Suggestions\s+is\s+required\b)[\s\S]*$/i,
      '',
    )
    fromH2 = fromH2.replace(/\n[ \t]*Sources[ \t]*\n[\s\S]*$/i, '')

    // Strip trailing UI feedback icons and turn duration tokens (e.g. "thumb_up", "thumb_down", "6m31.5s", "12.4s")
    fromH2 = fromH2.replace(
      /(?:[\s\n]+(?:thumb_upthumb_down|thumb_up|thumb_down|more_vert|edit|content_copy|flag|\d+m\s*\d+(?:\.\d+)?s|\d+(?:\.\d+)?s))+\s*$/gi,
      '',
    )
    // Also handle glued trailing tokens right after "(123-456 frames)" or "NOT FOUND..."
    fromH2 = fromH2.replace(
      /(\bframes\)|\bNOT[\s_]*FOUND[^\n]*?)(?:thumb_upthumb_down|thumb_up|thumb_down|\d+m\s*\d+(?:\.\d+)?s|\d+\.\d+s)+[ \t]*$/i,
      '$1',
    )

    s = (beforeH2 + fromH2).trim()
  } else {
    s = s.replace(
      /(?:[\s\n]+(?:thumb_upthumb_down|thumb_up|thumb_down|more_vert|edit|content_copy|flag|\d+m\s*\d+(?:\.\d+)?s|\d+(?:\.\d+)?s))+\s*$/gi,
      '',
    ).trim()
  }

  // Ensure line breaks around HISSA 1 / HISSA 2 headings and entries when text was flattened
  // 1) Newline before HISSA 2 section (and its optional === border)
  s = s.replace(/([^\n])\s*(={3,}\s*HISSA\s*2\b)/gi, '$1\n$2')
  s = s.replace(/([^\n=])\s*(HISSA\s*2\b)/gi, '$1\n$2')

  // 2) Newline right after HISSA 1 heading (e.g. "HISSA 1 — SHORT VIDEO TIME MAP ===" followed by timestamp)
  s = s.replace(
    /(HISSA\s*1\b(?:\s*[-—–:]\s*(?:SHORT\s+VIDEO\s+TIME\s+MAP|SHORT\s+VIDEO\s+SCENE\s+MAP|SHORT\s+VIDEO\s+MAP|SHORT\s+MAP))?[=*#\s]*)(?=(?:\d+:)?\d{1,2}:\d{2})/gi,
    '$1\n',
  )

  // 3) Newline right after HISSA 2 heading (e.g. "HISSA 2 — MOVIE MAP TIME ===" followed by "Short")
  s = s.replace(
    /(HISSA\s*2\b(?:\s*[-—–:]\s*(?:MOVIE\s+MAP\s+TIME|MOVIE\s+TIME\s+MAP|MOVIE\s+LOCATION\s+HUNT|MOVIE\s+MAP))?[=*#\s]*)(?=\bShort\b|(?:\d+:)?\d{1,2}:\d{2})/gi,
    '$1\n',
  )

  // 4) Newline before each HISSA 1 timestamp segment: "mm:ss.mmm - mm:ss.mmm (start-end frames):"
  s = s.replace(
    /([^\n])\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3}\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}\.\d{3}\s*\(\d+\s*-\s*\d+\s*frames\)\s*:)/gi,
    '$1\n$2',
  )

  // 5) Newline before each HISSA 2 case-sensitive "Short <ts>" entry (including truncated "Short 02:" at the end of a line)
  s = s.replace(/([^\n])\s+(Short[:\s]+(?:\d+:)?\d{1,2}:\d{0,2})/g, '$1\n$2')

  // Collapse 3+ consecutive newlines to 2
  s = s.replace(/\n{3,}/g, '\n\n').trim()

  return s
}

/** Parse "h:mm:ss(.mmm)" / "mm:ss(.mmm)" into seconds. */
function parseClockSec(ts: string): number | null {
  const t = ts.trim()
  const m3 = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (m3) return Number(m3[1]) * 3600 + Number(m3[2]) * 60 + Number(m3[3])
  const m2 = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (m2) return Number(m2[1]) * 60 + Number(m2[2])
  return null
}

/**
 * Check if a timestamp token has a truncated millisecond part (e.g. "00:13.0" or "00:13.")
 * instead of full 3-digit milliseconds ("00:13.000") or clean integer seconds ("00:13").
 */
function hasTruncatedTimestampToken(line: string): boolean {
  const tokens = line.match(/\b(?:\d+:)?\d{1,2}:\d{1,2}\.\d*\b|\b(?:\d+:)?\d{1,2}:\d{1,2}\./g)
  if (!tokens) return false
  for (const tok of tokens) {
    const dotIdx = tok.indexOf('.')
    if (dotIdx >= 0) {
      const decimals = tok.slice(dotIdx + 1)
      if (decimals.length !== 3) {
        return true
      }
    }
  }
  return false
}

/**
 * FIX 2: Strip free-text notes (and parenthetical remarks) after `NOT FOUND` up to the next
 * real case-sensitive `Short <timestamp>` entry (or end of string).
 * This ensures words like lowercase "short", arrows "->", colons ":", or dots "..." inside
 * a NOT FOUND explanation never trigger false truncation.
 */
function stripNotFoundNotesFromHissa2(normalizedHissa2: string): string {
  return normalizedHissa2
    .replace(
      /(\bNOT[\s_]*FOUND\b)(?:(?!\s+Short[:\s]+(?:\d+:)?\d{1,2}:)[\s\S])*/gi,
      '$1',
    )
    .trim()
}

/**
 * FIX 2: Check whether the tail of HISSA 2 looks cut off / truncated mid-stream.
 * - First strips free-text notes after `NOT FOUND` so lowercase "short" or punctuation inside notes is ignored.
 * - Uses case-sensitive real entry pattern `/(?:^|\s)Short[:\s]+(?:\d+:)?\d{1,2}:\d{0,2}/g` (and checks for bare trailing `Short...`).
 * - Applies dangling connector and incomplete timestamp checks strictly to the last real entry.
 */
function isTailTruncated(normalizedHissa2: string): boolean {
  const strippedNotes = stripNotFoundNotesFromHissa2(normalizedHissa2)
  if (!strippedNotes) return false

  // If the text ends with a bare/incomplete "Short" starter that didn't even reach "Short dd:dd"
  // e.g. "... (26320-26352 frames) Short" or "... Short 02:"
  if (/(?:^|\s)Short(?::|\s+(?:\d+:)?\d{0,2}:?\d{0,2}(?:\.\d*)?)?$/.test(strippedNotes)) {
    return true
  }

  // Find the last real case-sensitive "Short <mm:ss>" entry in stripped text
  const realEntryPattern = /(?:^|\s)(Short[:\s]+(?:\d+:)?\d{1,2}:\d{2})/g
  let lastShortIndex: number | null = null
  let m: RegExpExecArray | null
  while ((m = realEntryPattern.exec(strippedNotes)) !== null) {
    const leadingLen = m[0].length - m[1].length
    lastShortIndex = m.index + leadingLen
  }

  if (lastShortIndex === null) {
    return true
  }

  const lastEntryRaw = strippedNotes.slice(lastShortIndex).trim()
  // Strip optional trailing frame range "(1814-1827 frames)" from the end of a Movie match entry before checking tail connectors
  const lastEntryCore = lastEntryRaw.replace(/\s*\(\d+\s*-\s*\d+\s*frames\)\s*$/i, '').trim()

  // Dangling connector or incomplete timestamp token at the end of the last real entry
  if (/(?:-->|->|—>|=>|→|-|–|—|:|\.\d{0,2})$/.test(lastEntryCore)) {
    return true
  }

  const lastToken = lastEntryCore.split(/\s+/).pop() || ''
  if (hasTruncatedTimestampToken(lastToken)) {
    return true
  }

  // Complete match entry: Short <start> - <end> --> Movie <start> - <end>
  const hasCompleteMatch =
    /^Short[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?(?:\s*\([^)]*\))?\s*(?:-->|->|—>|=>|→|=)\s*Movie[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$/i.test(
      lastEntryCore,
    )

  // Complete not-found entry: Short <start> - <end> --> NOT FOUND
  const hasCompleteNotFound =
    /^Short[:\s]+(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?(?:\s*\([^)]*\))?\s*(?:-->|->|—>|=>|→|:|-|–|—|=)?\s*NOT[\s_]*FOUND$/i.test(
      lastEntryCore,
    )

  if (!hasCompleteMatch && !hasCompleteNotFound) {
    return true
  }

  return false
}

function fmtSecShort(sec: number): string {
  const s = Math.max(0, sec)
  const mm = Math.floor(s / 60)
  const rem = s - mm * 60
  return `${String(mm).padStart(2, '0')}:${rem.toFixed(3).padStart(6, '0')}`
}

/**
 * FIX 1: Check HISSA 2 Short-video timeline coverage instead of comparing HISSA 1 vs HISSA 2 line counts.
 * Rules:
 * a) Sort HISSA 2 entries (both found and NOT FOUND) by shortStartSec ascending.
 * b) First entry start must be <= 1.0s (hard reject if > 1.5s) and last entry end must be >= shortDurationSec - 2.0s.
 * c) Any gap or overlap between consecutive entries > 1.5s is rejected with `hissa2_coverage_gap (<where>)`.
 * d) Never compares HISSA 1 count with HISSA 2 count.
 */
export function checkHissa2ShortCoverage(
  hissa2Entries: ReadonlyArray<{ shortStartSec: number; shortEndSec: number }>,
  shortDurationSec: number,
): { ok: boolean; reason?: string; warning?: string } {
  if (!hissa2Entries || hissa2Entries.length === 0) {
    return { ok: false, reason: 'hissa2_coverage_gap (no HISSA 2 entries parsed)' }
  }

  const sorted = [...hissa2Entries].sort(
    (a, b) => a.shortStartSec - b.shortStartSec || a.shortEndSec - b.shortEndSec,
  )

  const warnings: string[] = []
  const first = sorted[0]
  if (first.shortStartSec > 1.5) {
    return {
      ok: false,
      reason: `hissa2_coverage_gap (start ${fmtSecShort(0)}->${fmtSecShort(first.shortStartSec)}, gap=${first.shortStartSec.toFixed(2)}s)`,
    }
  } else if (first.shortStartSec > 1.0) {
    warnings.push(`first HISSA 2 entry starts at ${fmtSecShort(first.shortStartSec)} (> 1.0s)`)
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    const diff = curr.shortStartSec - prev.shortEndSec
    if (diff > 1.5) {
      return {
        ok: false,
        reason: `hissa2_coverage_gap (${fmtSecShort(prev.shortEndSec)}->${fmtSecShort(curr.shortStartSec)}, gap=+${diff.toFixed(2)}s)`,
      }
    }
    if (diff < -1.5) {
      return {
        ok: false,
        reason: `hissa2_coverage_gap (${fmtSecShort(prev.shortEndSec)}->${fmtSecShort(curr.shortStartSec)}, overlap=${Math.abs(diff).toFixed(2)}s)`,
      }
    }
  }

  const last = sorted[sorted.length - 1]
  if (shortDurationSec > 0 && last.shortEndSec < shortDurationSec - 2.0) {
    return {
      ok: false,
      reason: `hissa2_coverage_gap (end ${fmtSecShort(last.shortEndSec)} < ${fmtSecShort(shortDurationSec - 2.0)})`,
    }
  }

  return {
    ok: true,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
  }
}

/**
 * FIX 3(c): Remove the trailing incomplete line / fragment from a partial Studio answer
 * and stitch the continuation turn text onto it.
 */
export function stitchContinuedStudioAnswer(
  previousPartialText: string,
  continuationTurnText: string,
): string {
  const prevCleaned = cleanStudioAnswerText(previousPartialText)
  if (!prevCleaned) return cleanStudioAnswerText(continuationTurnText)

  // Drop the last line of prevCleaned if it is incomplete / truncated
  const prevLines = prevCleaned.split('\n')
  while (prevLines.length > 0) {
    const lastLine = prevLines[prevLines.length - 1].trim()
    if (!lastLine) {
      prevLines.pop()
      continue
    }
    // Keep HISSA headings or complete HISSA 1 lines (before HISSA 2)
    const isHissaHeading = /^(?:={3,}\s*)?HISSA\s*[12]\b/i.test(lastLine)
    if (isHissaHeading) break

    const hasHissa2SoFar = /\bHISSA\s*2\b/i.test(prevCleaned)
    if (hasHissa2SoFar) {
      // Check if lastLine is a valid complete HISSA 2 line
      const lineTruncated = isTailTruncated(lastLine)
      if (lineTruncated) {
        prevLines.pop()
        continue
      }
    } else {
      // In HISSA 1: a complete line has "mm:ss.mmm - mm:ss.mmm (f1-f2 frames): description"
      const isCompleteHissa1Line =
        /^(?:\d+:)?\d{1,2}:\d{2}\.\d{3}\s*(?:-|–|—|to)\s*(?:\d+:)?\d{1,2}:\d{2}\.\d{3}\s*\(\d+\s*-\s*\d+\s*frames\)\s*:\s*\S+/i.test(
          lastLine,
        )
      if (!isCompleteHissa1Line) {
        prevLines.pop()
        continue
      }
    }
    break
  }

  // Clean continuation text without stripping before HISSA 1 (since continuation usually only has remaining lines)
  let cont = (continuationTurnText || '').replace(/\r\n/g, '\n').trim()
  cont = cont.replace(/^[ \t]*(?:edit|more_vert|content_copy|flag|auto_awesome)[ \t]*$/gim, '')
  cont = cont.replace(/^(?:\s*(?:edit|more_vert|content_copy|flag|auto_awesome)\b\s*)+/i, '').trim()
  cont = cont.replace(
    /(?:\n|\s)*(?:Sources\s+help\b|Google\s+Search\s+Suggestions\b|Display\s+of\s+Search\s+Suggestions\s+is\s+required\b)[\s\S]*$/i,
    '',
  )
  cont = cont.replace(
    /(?:[\s\n]+(?:thumb_upthumb_down|thumb_up|thumb_down|more_vert|edit|content_copy|flag|\d+m\s*\d+(?:\.\d+)?s|\d+(?:\.\d+)?s))+\s*$/gi,
    '',
  ).trim()

  const stitched = `${prevLines.join('\n').trim()}\n${cont}`
  return cleanStudioAnswerText(stitched)
}

/**
 * Pure, synchronous validator for AI Studio chunk-map answers.
 * Runs immediately after fetching the answer (zero sleep/await).
 * Normalizes text to tolerate wrapped lines, flattened DOM text (0 newlines), multi-line entries, and UI/grounding noise.
 */
export function validateStudioAnswer(
  text: string,
  options?: { shortWindowSec?: number },
): StudioValidationResult {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()

  const emptyStats: StudioValidationStats = {
    rawLength: raw.length,
    cleanedLength: 0,
    matchLineCount: 0,
    notFoundLineCount: 0,
    totalValidHissa2Lines: 0,
    maxShortEndSec: null,
  }

  if (!trimmed) {
    return {
      ok: false,
      reason: 'empty',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Reject prompt echo (e.g. if clipboard copied the user prompt instead of model turn)
  if (isPromptEchoText(trimmed)) {
    return {
      ok: false,
      reason: 'prompt_echo',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 3: Specific internal/error phrases (checked early so short error messages report the exact phrase)
  const lower = trimmed.toLowerCase()
  for (const phrase of SPECIFIC_ERROR_PHRASES) {
    if (lower.includes(phrase)) {
      return {
        ok: false,
        reason: `error_message:${phrase}`,
        cleanedText: '',
        stats: emptyStats,
      }
    }
  }

  // FIX 3(b): Reject thinking-only text before missing_hissa / empty checks
  if (isThinkingOnlyText(trimmed)) {
    return {
      ok: false,
      reason: 'thinking_only',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  const preCleaned = cleanStudioAnswerText(trimmed)

  // Check 1: Too short (< 100 chars)
  if (preCleaned.length < 100) {
    return {
      ok: false,
      reason: 'empty',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 2: Both "HISSA 1" and "HISSA 2" must be present, and HISSA 1 must appear before HISSA 2
  const hissa1Match = /HISSA\s*1\b/i.exec(preCleaned)
  const hissa2Match = /HISSA\s*2\b/i.exec(preCleaned)
  if (!hissa1Match || !hissa2Match || hissa1Match.index >= hissa2Match.index) {
    return {
      ok: false,
      reason: 'missing_hissa',
      cleanedText: '',
      stats: emptyStats,
    }
  }

  // Check 6: Strip any thinking leak / preamble before "HISSA 1"
  const cleanedText = cleanStudioAnswerText(preCleaned.slice(hissa1Match.index).trim())

  // Extract HISSA 2 body in a newline-independent way:
  // Match only the HISSA 2 heading (and optional subtitle like "— MOVIE MAP TIME"), stopping before the first "Short" or timestamp token
  const hissa2InCleaned =
    /HISSA\s*2\b(?:(?!\bShort\b|\b(?:\d+:)?\d{1,2}:\d{2})[^\r\n])*\r?\n?/i.exec(cleanedText)
  const hissa2Body = hissa2InCleaned
    ? cleanedText.slice(hissa2InCleaned.index + hissa2InCleaned[0].length).trim()
    : ''

  if (!hissa2Body) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        ...emptyStats,
        cleanedLength: cleanedText.length,
      },
    }
  }

  // Normalize HISSA 2 body: replace line breaks with spaces and collapse consecutive whitespace
  const normalizedHissa2 = hissa2Body.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()

  if (!normalizedHissa2) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        ...emptyStats,
        cleanedLength: cleanedText.length,
      },
    }
  }

  // Check 4: HISSA 2 must have at least one valid match line (via parseChunkMatches) or NOT FOUND line
  const parsedMatches = parseChunkMatches(normalizedHissa2, 0, 0, 'studio')
  const matchLineCount = parsedMatches.length

  let notFoundLineCount = 0
  let maxShortEndSec: number | null = null

  for (const m of parsedMatches) {
    if (maxShortEndSec === null || m.shortEnd > maxShortEndSec) {
      maxShortEndSec = m.shortEnd
    }
  }

  // Match NOT FOUND entries in normalized text
  const notFoundPattern =
    /\bShort[:\s]+((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:-|–|—|to)\s*((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:-->|->|—>|=>|→|:|-|–|—)?\s*NOT[\s_]*FOUND\b/gi
  let nfMatch: RegExpExecArray | null
  while ((nfMatch = notFoundPattern.exec(normalizedHissa2)) !== null) {
    notFoundLineCount += 1
    const endSec = parseClockSec(nfMatch[2])
    if (endSec !== null && (maxShortEndSec === null || endSec > maxShortEndSec)) {
      maxShortEndSec = endSec
    }
  }

  // Fallback: If no "Short ... --> NOT FOUND" matched but "NOT FOUND" is present in text
  if (notFoundLineCount === 0 && /\bNOT[\s_]*FOUND\b/i.test(normalizedHissa2)) {
    const rawMatches = normalizedHissa2.match(/\bNOT[\s_]*FOUND\b/gi)
    if (rawMatches) {
      notFoundLineCount = rawMatches.length
    }
  }

  const totalValidHissa2Lines = matchLineCount + notFoundLineCount
  if (totalValidHissa2Lines === 0) {
    return {
      ok: false,
      reason: 'empty_hissa2',
      cleanedText,
      stats: {
        rawLength: raw.length,
        cleanedLength: cleanedText.length,
        matchLineCount: 0,
        notFoundLineCount: 0,
        totalValidHissa2Lines: 0,
        maxShortEndSec,
      },
    }
  }

  // Check 5: Truncation check on the tail of HISSA 2
  if (isTailTruncated(normalizedHissa2)) {
    return {
      ok: false,
      reason: 'truncated_last_line',
      cleanedText,
      stats: {
        rawLength: raw.length,
        cleanedLength: cleanedText.length,
        matchLineCount,
        notFoundLineCount,
        totalValidHissa2Lines,
        maxShortEndSec,
      },
    }
  }

  // Check 7: Soft warning (never rejects) if HISSA 2 lines did not reach near the end of the short window
  let reachedShortEnd: boolean | undefined
  let softWarning: string | undefined
  if (options?.shortWindowSec && options.shortWindowSec > 0) {
    if (maxShortEndSec !== null && maxShortEndSec >= options.shortWindowSec - 3) {
      reachedShortEnd = true
    } else {
      reachedShortEnd = false
      softWarning = `HISSA 2 max short end (${maxShortEndSec !== null ? `${maxShortEndSec.toFixed(1)}s` : 'none'}) is before short window end (${options.shortWindowSec.toFixed(1)}s)`
    }
  }

  return {
    ok: true,
    reason: 'ok',
    cleanedText,
    stats: {
      rawLength: raw.length,
      cleanedLength: cleanedText.length,
      matchLineCount,
      notFoundLineCount,
      totalValidHissa2Lines,
      maxShortEndSec,
      reachedShortEnd,
      softWarning,
    },
  }
}
