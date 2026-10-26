import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/paths'
import {
  buildStudioModelChain,
  getEffectiveModel,
  loadStudioModelQuotaState,
  markModelExhausted,
  nextPacificMidnight,
  resetModelQuotaState,
} from '../lib/studio-model-state'

async function runTests() {
  const statePath = path.join(DATA_DIR, 'studio-model-state.json')
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null

  try {
    // 1. Test nextPacificMidnight across 2 dates (PST winter UTC-8 and PDT summer UTC-7 + DST boundary)
    const winterNow = Date.parse('2026-01-15T18:30:00.000Z') // 2026-01-15 10:30 PST (UTC-8)
    const winterMidnight = nextPacificMidnight(winterNow)
    const expectedWinterMidnight = Date.parse('2026-01-16T08:00:00.000Z') // 2026-01-16 00:00 PST
    assert.equal(
      winterMidnight,
      expectedWinterMidnight,
      `Winter PST midnight mismatch: got ${new Date(winterMidnight).toISOString()}, expected ${new Date(expectedWinterMidnight).toISOString()}`,
    )

    const summerNow = Date.parse('2026-07-15T18:30:00.000Z') // 2026-07-15 11:30 PDT (UTC-7)
    const summerMidnight = nextPacificMidnight(summerNow)
    const expectedSummerMidnight = Date.parse('2026-07-16T07:00:00.000Z') // 2026-07-16 00:00 PDT
    assert.equal(
      summerMidnight,
      expectedSummerMidnight,
      `Summer PDT midnight mismatch: got ${new Date(summerMidnight).toISOString()}, expected ${new Date(expectedSummerMidnight).toISOString()}`,
    )

    // DST transition day (2026-03-08: PST -> PDT)
    const dstSpringNow = Date.parse('2026-03-08T09:30:00.000Z') // 2026-03-08 01:30 PST (before 2am spring forward)
    const dstSpringMidnight = nextPacificMidnight(dstSpringNow)
    const expectedDstSpringMidnight = Date.parse('2026-03-09T07:00:00.000Z') // 2026-03-09 00:00 PDT (UTC-7)
    assert.equal(
      dstSpringMidnight,
      expectedDstSpringMidnight,
      `DST spring-forward midnight mismatch: got ${new Date(dstSpringMidnight).toISOString()}`,
    )

    // 2. Test buildStudioModelChain order
    assert.deepEqual(buildStudioModelChain('Argon'), [
      'Argon',
      'Gemini 3.8 Flash',
      'Gemini 3.7 Flash',
      'Gemini 3.6 Flash',
    ])
    assert.deepEqual(buildStudioModelChain('Gemini 3.8 Flash'), [
      'Gemini 3.8 Flash',
      'Gemini 3.7 Flash',
      'Gemini 3.6 Flash',
    ])

    // 3. Test getEffectiveModel: Argon exhausted -> Gemini 3.8 Flash; after reset time -> back to Argon
    await resetModelQuotaState()
    const baseNow = Date.parse('2026-10-25T14:00:00.000Z') // 2026-10-25 07:00 PDT
    const initialEffective = await getEffectiveModel('Argon', undefined, baseNow)
    assert.equal(initialEffective, 'Argon', 'Initial effective model should be Argon')

    const { untilTimestamp } = await markModelExhausted('Argon', baseNow)
    assert.equal(
      untilTimestamp,
      Date.parse('2026-10-26T07:00:00.000Z'),
      'Argon exhaustion timestamp should equal next Pacific midnight',
    )

    const duringExhaustion = await getEffectiveModel('Argon', undefined, baseNow + 60_000)
    assert.equal(
      duringExhaustion,
      'Gemini 3.8 Flash',
      'When Argon is exhausted, getEffectiveModel("Argon") must return "Gemini 3.8 Flash"',
    )

    // After Pacific midnight reset time passes -> automatically returns to Argon and clears state
    const afterReset = await getEffectiveModel('Argon', undefined, untilTimestamp + 1000)
    assert.equal(
      afterReset,
      'Argon',
      'After reset time passes, getEffectiveModel("Argon") must return "Argon"',
    )
    const cleanedState = await loadStudioModelQuotaState(untilTimestamp + 1000)
    assert.equal(
      cleanedState.exhausted['Argon'],
      undefined,
      'Expired Argon entry should be removed from studio-model-state.json',
    )

    console.log('ALL TESTS PASSED: nextPacificMidnight (PST/PDT/DST) & getEffectiveModel')
  } finally {
    if (backup !== null) {
      fs.writeFileSync(statePath, backup, 'utf8')
    } else if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true })
    }
  }
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
