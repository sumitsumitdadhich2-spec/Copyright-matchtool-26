import assert from 'node:assert/strict'
import {
  checkHissa2ShortCoverage,
  cleanStudioAnswerText,
  isPromptEchoText,
  isThinkingOnlyText,
  stitchContinuedStudioAnswer,
  validateStudioAnswer,
} from '../lib/studio-result-validator'
import { extractHissa1And2EntriesFromResponse } from '../lib/studio-window-planner'

function fmtTs(sec: number): string {
  const mm = Math.floor(sec / 60)
  const ss = sec - mm * 60
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(3).padStart(6, '0')}`
}

// ============================================================================
// CASE (a): HISSA 1 = 104 lines, HISSA 2 = 9 lines (grouped NOT FOUND ranges)
// Must ACCEPT (count mismatch is never checked; coverage is contiguous 0..179s)
// ============================================================================
const shortDurationSec = 179.0 // 02:59.000
const hissa1Lines104: string[] = []
for (let i = 0; i < 104; i++) {
  const s = (i * shortDurationSec) / 104
  const e = ((i + 1) * shortDurationSec) / 104
  const f1 = Math.round(s * 24)
  const f2 = Math.round(e * 24)
  hissa1Lines104.push(`${fmtTs(s)} - ${fmtTs(e)} (${f1}-${f2} frames): Scene segment #${i + 1} action`)
}

// 9 HISSA 2 lines covering 00:00.000 to 02:59.000 contiguously
const hissa2Lines9 = [
  'Short 00:00.000 - 00:00.750 --> Movie 00:10.000 - 00:10.750 (240-258 frames)',
  'Short 00:00.750 - 00:01.500 --> Movie 00:10.750 - 00:11.500 (258-276 frames)',
  'Short 00:01.500 - 00:02.250 --> Movie 00:11.500 - 00:12.250 (276-294 frames)',
  'Short 00:02.250 - 00:03.000 --> Movie 00:12.250 - 00:13.000 (294-312 frames)',
  'Short 00:03.000 - 00:03.750 --> Movie 00:13.000 - 00:13.750 (312-330 frames)',
  'Short 00:03.750 - 00:04.500 --> Movie 00:13.750 - 00:14.500 (330-348 frames)',
  'Short 00:04.500 - 00:05.125 --> Movie 00:14.500 - 00:15.125 (348-363 frames)',
  'Short 00:05.125 - 00:05.792 --> Movie 00:15.125 - 00:15.792 (363-379 frames)',
  'Short 00:05.792 - 02:59.000 --> NOT FOUND - ye saare scenes is movie window me nahi hain (ye short video Texas ke hospital ke scenes par hai -> : . ...)',
]

const caseAText = [
  'edit',
  'more_vert',
  '=====================',
  'HISSA 1 — SHORT VIDEO TIME MAP',
  '=====================',
  ...hissa1Lines104,
  '=====================',
  'HISSA 2 — MOVIE MAP TIME',
  '=====================',
  ...hissa2Lines9,
  'Sources help',
  'Google Search Suggestions',
  'Display of Search Suggestions is required when using Grounding with Google Search. Learn more',
  'thumb_upthumb_down 6m31.5s',
].join('\n')

const valCaseA = validateStudioAnswer(caseAText, { shortWindowSec: shortDurationSec })
assert.equal(valCaseA.ok, true, `Case (a) must ACCEPT, got: ${valCaseA.reason}`)
assert.equal(valCaseA.stats.totalValidHissa2Lines, 9)
assert.ok(!valCaseA.cleanedText.includes('Sources help'), 'Grounding Sources must be stripped')
assert.ok(!valCaseA.cleanedText.includes('thumb_up'), 'thumb_up must be stripped')

const parsedCaseA = extractHissa1And2EntriesFromResponse(valCaseA.cleanedText)
assert.equal(parsedCaseA.hissa1Entries.length, 104, 'Should parse 104 HISSA 1 entries')
assert.equal(parsedCaseA.hissa2Entries.length, 9, 'Should parse 9 HISSA 2 entries')

const covCaseA = checkHissa2ShortCoverage(parsedCaseA.hissa2Entries, shortDurationSec)
assert.equal(covCaseA.ok, true, `Case (a) coverage must pass, got: ${covCaseA.reason}`)

// ============================================================================
// CASE (b): NOT FOUND note containing lowercase "short" + Movie frame range tail
// Both multiline and flattened (0-newline) must ACCEPT (NOT truncated)
// ============================================================================
const caseBMultiline = `HISSA 1 — SHORT VIDEO TIME MAP
00:00.000 - 00:05.792 (0-139 frames): Opening doctor conversation
00:05.792 - 02:59.000 (139-4296 frames): Hospital corridor scenes
HISSA 2 — MOVIE MAP TIME
Short 00:00.000 - 00:05.792 --> Movie 01:15.584 - 01:16.126 (1814-1827 frames)
Short 00:05.792 - 02:59.000 --> NOT FOUND - ye saare scenes is movie window me nahi hain (ye short video Texas ke hospital ... nahi hain)`

const caseBFlattened = caseBMultiline.replace(/\r?\n/g, ' ')
assert.equal((caseBFlattened.match(/\n/g) || []).length, 0, 'Flattened input has 0 newlines')

const valCaseBMulti = validateStudioAnswer(caseBMultiline, { shortWindowSec: 179 })
const valCaseBFlat = validateStudioAnswer(caseBFlattened, { shortWindowSec: 179 })
assert.equal(valCaseBMulti.ok, true, `Case (b) multiline must ACCEPT, got: ${valCaseBMulti.reason}`)
assert.equal(valCaseBFlat.ok, true, `Case (b) flattened must ACCEPT, got: ${valCaseBFlat.reason}`)

// Sub-test 3 from Fix 2: ending on "... --> Movie 01:15.584 - 01:16.126 (1814-1827 frames)"
const caseBEndsWithMovie = `HISSA 1 — SHORT VIDEO TIME MAP
00:00.000 - 00:00.542 (0-13 frames): Doctor looks up
HISSA 2 — MOVIE MAP TIME
Short 00:00.000 - 00:00.542 --> Movie 01:15.584 - 01:16.126 (1814-1827 frames)`
assert.equal(validateStudioAnswer(caseBEndsWithMovie, { shortWindowSec: 0.542 }).ok, true)
assert.equal(
  validateStudioAnswer(caseBEndsWithMovie.replace(/\r?\n/g, ' '), { shortWindowSec: 0.542 }).ok,
  true,
)

// ============================================================================
// CASE (c): Truncated at "Short 02:" -> REJECT ('truncated_last_line')
// Both multiline and flattened (0-newline) must give same result, and CONTINUE stitch fixes it
// ============================================================================
const caseCMultiline = `HISSA 1 — SHORT VIDEO TIME MAP
00:00.000 - 02:22.667 (0-3424 frames): First part of short
02:22.667 - 02:24.000 (3424-3456 frames): Second part of short
02:24.000 - 02:30.000 (3456-3600 frames): Third part of short
HISSA 2 — MOVIE MAP TIME
Short 00:00.000 - 02:22.667 --> NOT FOUND - not in this window
Short 02:22.667 - 02:24.000 --> Movie 18:16.667 - 18:18.000 (26320-26352 frames)
Short 02:`

const caseCFlattened = caseCMultiline.replace(/\r?\n/g, ' ')
const valCaseCMulti = validateStudioAnswer(caseCMultiline, { shortWindowSec: 150 })
const valCaseCFlat = validateStudioAnswer(caseCFlattened, { shortWindowSec: 150 })
assert.equal(valCaseCMulti.ok, false, 'Case (c) multiline must REJECT')
assert.equal(valCaseCMulti.reason, 'truncated_last_line')
assert.equal(valCaseCFlat.ok, false, 'Case (c) flattened must REJECT')
assert.equal(valCaseCFlat.reason, 'truncated_last_line')

// Verify CONTINUE stitching drops "Short 02:" and appends remaining line cleanly
const stitchedCaseC = stitchContinuedStudioAnswer(
  caseCFlattened,
  'Short 02:24.000 - 02:30.000 --> Movie 18:18.000 - 18:24.000 (26352-26496 frames)',
)
const valStitched = validateStudioAnswer(stitchedCaseC, { shortWindowSec: 150 })
assert.equal(valStitched.ok, true, `Stitched continuation must ACCEPT, got: ${valStitched.reason}`)
assert.equal(valStitched.stats.totalValidHissa2Lines, 3)

// ============================================================================
// CASE (d): Thinking-only text (e.g. cut off at "Movie: frame 4319" without HISSA 1)
// Must REJECT with reason === 'thinking_only'
// ============================================================================
const caseDThinkingOnly = `Thinking
Initiating Video Analysis
Let's check each sub-segment carefully.
MATCHED SECTION: checking hospital hallway
Sub-segment 1: 00:00.000 - 00:01.200, Offset = +14.250s
Comparing Short: frame 28 with Movie: frame 4319`

assert.equal(isThinkingOnlyText(caseDThinkingOnly), true, 'Must detect thinking-only text')
const valCaseD = validateStudioAnswer(caseDThinkingOnly, { shortWindowSec: 179 })
assert.equal(valCaseD.ok, false, 'Case (d) thinking-only must REJECT')
assert.equal(valCaseD.reason, 'thinking_only')

// Also verify coverage gap rejection (> 1.5s gap in HISSA 2)
const gapCheck = checkHissa2ShortCoverage(
  [
    { shortStartSec: 0, shortEndSec: 10 },
    { shortStartSec: 15, shortEndSec: 30 },
  ],
  30,
)
assert.equal(gapCheck.ok, false)
assert.ok(gapCheck.reason?.startsWith('hissa2_coverage_gap'))

console.log('ALL 4 REQUIRED TEST CASES (a, b, c, d) + COVERAGE & STITCHING PASSED!')
