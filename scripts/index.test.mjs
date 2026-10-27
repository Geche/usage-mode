// Tests for the indexer: the part of the mod with arithmetic in it.
//
// Each test builds a throwaway transcript tree and pricing file, runs the
// indexer over them as the mod does, and reads back the rollup it wrote.
// Plain node — no Claude Code and no network, so CI can run it anywhere.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const INDEXER = join(import.meta.dirname, 'index.mjs')

/** Round per-MTok rates that make the expected dollars easy to read. */
const PRICING = {
  models: {
    'test-model': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
    'tiered-model': {
      tiers: [
        { maxPromptTokens: 100_000, input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
        { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
      ],
    },
  },
  defaults: { cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2, cacheReadMultiplier: 0.1 },
  weights: { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
}

let counter = 0

/** One assistant record, in the shape a transcript holds. */
const response = (over = {}) => {
  counter += 1

  return {
    type: 'assistant',
    timestamp: new Date(over.at ?? Date.now() - 60_000).toISOString(),
    requestId: over.requestId ?? `req_test_${counter}`,
    uuid: `uuid-${counter}`,
    sessionId: 'session-1',
    cwd: over.cwd ?? '/Users/me/Projects/demo',
    message: {
      model: over.model ?? 'test-model',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        ...(over.usage ?? {}),
      },
    },
  }
}

/** A workspace with a projects tree, a pricing file and a home for the state. */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-mode-test-'))
  const projects = join(root, 'projects')
  const home = join(root, 'home')
  const pricing = join(root, 'pricing.json')
  mkdirSync(projects, { recursive: true })
  writeFileSync(pricing, JSON.stringify(PRICING))

  return {
    root,
    /** Writes records as a transcript at a path under the projects tree. */
    transcript(relativePath, records) {
      const full = join(projects, relativePath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, records.map(one => JSON.stringify(one)).join('\n') + '\n')

      return full
    },
    append(full, records) {
      appendFileSync(full, records.map(one => JSON.stringify(one)).join('\n') + '\n')
    },
    /** Runs the indexer and returns [summary, rollup]. */
    run(...extra) {
      const stdout = execFileSync(
        process.execPath,
        [INDEXER, '--home', home, '--projects', projects, '--pricing', pricing, ...extra],
        { encoding: 'utf8' },
      )
      const summary = JSON.parse(stdout.trim().split('\n').pop())
      const rollup = JSON.parse(readFileSync(join(home, 'rollup.json'), 'utf8'))

      return [summary, rollup]
    },
  }
}

const modelRow = (rollup, model) => rollup.models.find(row => row.model === model)

test('counts one response and prices it from the table', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
  ])

  const [summary, rollup] = w.run()

  assert.equal(summary.newRecords, 1)
  assert.equal(summary.totalRecords, 1)
  assert.equal(modelRow(rollup, 'test-model').usd, 60) // $10 input + $50 output
})

test('counts a response only once however many transcripts carry it', () => {
  const w = workspace()
  const shared = response({ requestId: 'req_shared', usage: { output_tokens: 1_000_000 } })
  // The same response, as a resume and a fork each keep their own copy.
  w.transcript('-Users-me-Projects-demo/first.jsonl', [shared])
  w.transcript('-Users-me-Projects-demo/second.jsonl', [shared])
  w.transcript('-Users-me-Projects-demo/third.jsonl', [shared])

  const [summary, rollup] = w.run()

  assert.equal(summary.newRecords, 1)
  assert.equal(modelRow(rollup, 'test-model').requests, 1)
  assert.equal(modelRow(rollup, 'test-model').usd, 50)
})

test('reads only what was appended since the last run', () => {
  const w = workspace()
  const path = w.transcript('-Users-me-Projects-demo/session.jsonl', [response({})])

  const [first] = w.run()
  assert.equal(first.newRecords, 1)
  assert.equal(first.scannedFiles, 1)

  const [unchanged] = w.run()
  assert.equal(unchanged.newRecords, 0)
  assert.equal(unchanged.scannedFiles, 0, 'an untouched transcript is not opened again')

  w.append(path, [response({}), response({})])
  const [grown] = w.run()
  assert.equal(grown.newRecords, 2)
  assert.equal(grown.totalRecords, 3)
})

test('leaves a half-written last line for the next run', () => {
  const w = workspace()
  const path = w.transcript('-Users-me-Projects-demo/session.jsonl', [response({})])
  const whole = JSON.stringify(response({ requestId: 'req_second' }))
  appendFileSync(path, whole.slice(0, 40)) // no trailing newline: still being written

  const [first] = w.run()
  assert.equal(first.newRecords, 1, 'the torn line is not parsed')

  appendFileSync(path, whole.slice(40) + '\n')
  const [second] = w.run()
  assert.equal(second.newRecords, 1, 'and is read once it is whole')
  assert.equal(second.totalRecords, 2)
})

test('re-reads a transcript from the top when it shrinks', () => {
  const w = workspace()
  const path = w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ requestId: 'req_a' }),
    response({ requestId: 'req_b' }),
  ])
  w.run()

  // Rotated or rewritten in place, smaller than the offset we remembered.
  truncateSync(path, 0)
  writeFileSync(path, JSON.stringify(response({ requestId: 'req_c' })) + '\n')
  const [second] = w.run()

  assert.equal(second.scannedFiles, 1)
  assert.equal(second.newRecords, 1)
})

test('finds subagent and workflow transcripts at any depth', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [response({})])
  w.transcript('-Users-me-Projects-demo/session/subagents/agent-abc.jsonl', [response({})])
  w.transcript('-Users-me-Projects-demo/session/subagents/workflows/wf_1/agent-def.jsonl', [response({})])

  const [summary] = w.run()

  assert.equal(summary.scannedFiles, 3)
  assert.equal(summary.newRecords, 3)
})

test('prices the two cache-write lifetimes at their own rates', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/a.jsonl', [
    response({
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
      },
    }),
  ])
  w.transcript('-Users-me-Projects-demo/b.jsonl', [
    response({
      model: 'test-model',
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      },
    }),
  ])

  const [, rollup] = w.run()

  // $12.50 for the 5-minute write, $20 for the hour one.
  assert.equal(modelRow(rollup, 'test-model').usd, 32.5)
})

test('attributes a legacy combined cache-write total to the short lifetime', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ usage: { cache_creation_input_tokens: 1_000_000 } }),
  ])

  const [, rollup] = w.run()

  assert.equal(modelRow(rollup, 'test-model').usd, 12.5)
})

test('does not charge thinking tokens on top of the output they are part of', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({
      usage: {
        output_tokens: 1_000_000,
        output_tokens_details: { thinking_tokens: 800_000 },
      },
    }),
  ])

  const [, rollup] = w.run()
  const row = modelRow(rollup, 'test-model')

  assert.equal(row.usd, 50, 'the 800k thinking tokens are already inside the 1M output')
  assert.equal(row.thinking, 800_000, 'but they are still reported')
})

test('picks a tier from the prompt the request actually sent', () => {
  const w = workspace()
  // 100,000 prompt tokens exactly: the cheaper tier still applies.
  w.transcript('-Users-me-Projects-demo/small.jsonl', [
    response({
      model: 'tiered-model',
      usage: { input_tokens: 100_000, output_tokens: 1_000_000 },
    }),
  ])
  const [, atTheLine] = w.run()
  assert.equal(modelRow(atTheLine, 'tiered-model').usd, 5.1) // $0.10 input + $5 output

  const over = workspace()
  over.transcript('-Users-me-Projects-demo/big.jsonl', [
    response({
      model: 'tiered-model',
      usage: { input_tokens: 100_001, output_tokens: 1_000_000 },
    }),
  ])
  const [, aboveIt] = over.run()
  assert.equal(Math.round(modelRow(aboveIt, 'tiered-model').usd * 100) / 100, 51) // $1.00 + $50
})

test('reports an unpriced model instead of guessing a figure', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ model: 'model-nobody-priced', usage: { output_tokens: 1_000_000 } }),
  ])

  const [summary, rollup] = w.run()

  assert.deepEqual(rollup.unpricedModels, ['model-nobody-priced'])
  assert.equal(summary.unpriced, 1)
  const row = modelRow(rollup, 'model-nobody-priced')
  assert.equal(row.usd, 0, 'no dollars are invented')
  assert.equal(row.weighted, 5_000_000, 'but the tokens are still counted')
})

test('leaves out responses older than the retention window', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ requestId: 'req_recent' }),
    response({ requestId: 'req_ancient', at: Date.now() - 100 * 86_400_000 }),
  ])

  const [summary] = w.run('--retention', '45')

  assert.equal(summary.newRecords, 1)
})

test('ignores a synthetic response, which spends nothing', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({ model: '<synthetic>', usage: { output_tokens: 1_000_000 } }),
    response({}),
  ])

  const [summary] = w.run()

  assert.equal(summary.newRecords, 1)
})

test('names a project from its folder when the cwd is a scratch id', () => {
  const w = workspace()
  w.transcript('-Users-lawrence-eq-Projects-my-app/session/subagents/agent-a1.jsonl', [
    response({ cwd: '/tmp/whatever/agent-a1b2c3d4e5f60718' }),
  ])
  w.transcript('-Users-lawrence-eq-Projects-my-app/session.jsonl', [response({ cwd: '/work/my-app' })])

  const [, rollup] = w.run()
  const names = rollup.projects.map(row => row.project).sort()

  // The hyphen in the username must not throw off the folder decoding.
  assert.deepEqual(names, ['my-app'])
})

test('skips a record with no usage block', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: new Date().toISOString(), requestId: 'req_x', message: { model: 'test-model' } },
    response({}),
  ])

  const [summary] = w.run()

  assert.equal(summary.newRecords, 1)
})

test('survives a line that is not JSON', () => {
  const w = workspace()
  const path = w.transcript('-Users-me-Projects-demo/session.jsonl', [response({})])
  appendFileSync(path, '{ this is not json\n')
  w.append(path, [response({})])

  const [summary] = w.run()

  assert.equal(summary.newRecords, 2)
  assert.equal(summary.ok, true)
})

// The pricing table the mod ships with — a wrong rate here is a wrong bill
// everywhere, and nothing else in the suite would notice.

const SHIPPED = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'pricing.json'), 'utf8'))

test('the shipped pricing table is dated and complete', () => {
  assert.ok(SHIPPED.verifiedAt, 'an undated table cannot be checked against the published one')
  assert.ok(!Number.isNaN(Date.parse(SHIPPED.verifiedAt)), 'verifiedAt is a date')

  for (const [model, rates] of Object.entries(SHIPPED.models)) {
    if (rates.tiers) {
      assert.ok(rates.tiers.length >= 2, `${model}: a tiered model needs more than one tier`)
      assert.equal(
        rates.tiers.at(-1).maxPromptTokens,
        undefined,
        `${model}: the last tier must be open-ended, or a big prompt falls through unpriced`,
      )
      for (const tier of rates.tiers) {
        assert.equal(typeof tier.input, 'number', `${model}: every tier needs an input rate`)
        assert.equal(typeof tier.output, 'number', `${model}: every tier needs an output rate`)
      }
      continue
    }
    for (const field of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']) {
      assert.equal(typeof rates[field], 'number', `${model}: ${field} is missing or not a number`)
    }
    assert.ok(rates.output > rates.input, `${model}: output should cost more than input`)
    assert.ok(rates.cacheRead < rates.input, `${model}: a cache read should cost less than fresh input`)
    assert.ok(rates.cacheWrite1h > rates.cacheWrite5m, `${model}: the hour write should cost more`)
  }
})

test('the shipped table prices a known record to a known figure', () => {
  const w = workspace()
  w.transcript('-Users-me-Projects-demo/session.jsonl', [
    response({
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      },
    }),
  ])

  const [, rollup] = w.run('--pricing', join(import.meta.dirname, '..', 'data', 'pricing.json'))

  // Opus 5: $5 input + $25 output + $0.50 read + $6.25 5m write + $10 1h write.
  assert.equal(modelRow(rollup, 'claude-opus-5').usd, 46.75)
})

test('every model the shipped table names is priced by the indexer', () => {
  const w = workspace()
  const models = Object.keys(SHIPPED.models)
  w.transcript(
    '-Users-me-Projects-demo/session.jsonl',
    models.map(model => response({ model, usage: { output_tokens: 1000 } })),
  )

  const [, rollup] = w.run('--pricing', join(import.meta.dirname, '..', 'data', 'pricing.json'))

  assert.deepEqual(rollup.unpricedModels, [], 'a model in the table must never come back unpriced')
  assert.equal(rollup.models.length, models.length)
})

// The release-tag check, which is the last thing between a wrong version and a
// published release.

const TAG_CHECK = join(import.meta.dirname, 'check-release-tag.mjs')

/** A folder holding just the two manifests, and the check's result on a tag. */
const checkTag = (tag, { name = 'usage-mode', version = '1.2.3', listed = true } = {}) => {
  const folder = mkdtempSync(join(tmpdir(), 'usage-mode-tag-'))
  mkdirSync(join(folder, '.claude-plugin'))
  writeFileSync(join(folder, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
  writeFileSync(
    join(folder, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, plugins: listed ? [{ name, source: './' }] : [] }),
  )
  try {
    const stdout = execFileSync(process.execPath, [TAG_CHECK, tag, folder], { encoding: 'utf8' })

    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? '') }
  }
}

test('a tag that matches the manifest passes', () => {
  const result = checkTag('usage-mode--v1.2.3')

  assert.equal(result.ok, true)
  assert.match(result.stdout, /matches the manifest/)
})

test('a tag ahead of the manifest is refused', () => {
  const result = checkTag('usage-mode--v2.0.0')

  assert.equal(result.ok, false)
  assert.match(result.stderr, /the manifest says usage-mode--v1\.2\.3/)
  assert.match(result.stderr, /Bump "version"/)
})

test('a tag for another plugin is refused', () => {
  const result = checkTag('something-else--v1.2.3')

  assert.equal(result.ok, false)
  assert.match(result.stderr, /the manifest says/)
})

test('a version the marketplace does not list is refused', () => {
  const result = checkTag('usage-mode--v1.2.3', { listed: false })

  assert.equal(result.ok, false)
  assert.match(result.stderr, /does not list usage-mode/)
})

test('no tag at all is refused', () => {
  const folder = mkdtempSync(join(tmpdir(), 'usage-mode-tag-'))
  mkdirSync(join(folder, '.claude-plugin'))
  writeFileSync(join(folder, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: '1' }))
  let failed = false
  try {
    execFileSync(process.execPath, [TAG_CHECK], { encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: '' } })
  } catch (error) {
    failed = true
    assert.match(String(error.stderr ?? ''), /No tag given/)
  }
  assert.equal(failed, true)
})

test('the repository its own tag check is run against is consistent', () => {
  const root = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const stdout = execFileSync(
    process.execPath,
    [TAG_CHECK, `${manifest.name}--v${manifest.version}`, root],
    { encoding: 'utf8' },
  )

  assert.match(stdout, /matches the manifest/)
})
