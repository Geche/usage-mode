import { expect, mock, test } from 'claude-code/testing'
import type { SessionMeasureInput } from 'claude-code'

/** The `on` a test body is handed; the kit keeps the type to itself. */
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const inThreeHours = () => new Date(Date.now() + 3 * 3_600_000).toISOString()
const inSixDays = () => new Date(Date.now() + 6 * 86_400_000).toISOString()

const reading = (): SessionMeasureInput => ({
  context: { tokens: 129_420, window: 1_000_000, percent: 13 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 20, resetsAt: inThreeHours() },
    { kind: 'seven_day', percentUsed: 8, resetsAt: inSixDays() },
  ],
  cost: { usd: 1.5 },
  changed: ['context', 'rateLimits', 'cost'],
})

const BAND = {
  plugin: 'usage-mode',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'usage-mode',
  component: 'Pane',
  requestId: 'usage',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ROLLUP = {
  generatedAt: Date.now(),
  scannedFiles: 400,
  newRecords: 2,
  totalRecords: 12_000,
  elapsedMs: 42,
  retentionDays: 45,
  hours: {},
  recent: [
    { t: Date.now() - 3_600_000, weighted: 4_000_000, usd: 8.5, model: 'claude-opus-5', project: 'demo-app' },
    { t: Date.now() - 600_000, weighted: 2_000_000, usd: 4.25, model: 'claude-opus-5', project: 'demo-app' },
  ],
  models: [
    {
      model: 'claude-opus-5',
      requests: 3_000,
      input: 20_000,
      output: 1_500_000,
      thinking: 0,
      cacheWrite: 30_000_000,
      cacheRead: 900_000_000,
      weighted: 120_000_000,
      usd: 500,
    },
  ],
  projects: [{ project: 'demo-app', requests: 300, weighted: 20_000_000, usd: 42.5 }],
  unpricedModels: [],
  error: null,
}

/** The same rollup from before any rates were filled in. */
const UNPRICED = {
  ...ROLLUP,
  recent: ROLLUP.recent.map(row => ({ ...row, usd: null })),
  models: ROLLUP.models.map(row => ({ ...row, usd: null })),
  unpricedModels: ['claude-opus-5'],
}

/** The engine beneath the plugin: nothing draws, and a measurement echoes. */
const stubEngine = (on: TestOn) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.store(on, { nodePath: '/usr/bin/node' })
}

/** The two calls `reindex` makes, standing in for a machine. */
const stubIndexer = (on: TestOn, rollup: unknown = ROLLUP) => {
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, rollupPath: '/tmp/rollup.json' })}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.read', () => ({ value: JSON.stringify(rollup) }))
}

test('the band stays quiet until a reading lands', async ($, on) => {
  stubEngine(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
  await ui.unmount()
})

test('the band shows every plan window and the context fill', async ($, on) => {
  stubEngine(on)
  await $.session.measure(reading())

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    const fiveHour = await ui.find({ type: 'Text', text: /^5h / })
    expect(fiveHour?.text).toBe('5h ██░░░░░░░░ 20%')
    const weekly = await ui.find({ type: 'Text', text: /^7d / })
    expect(weekly?.text).toBe('7d █░░░░░░░░░ 8%')
    expect((await ui.find({ type: 'Text', text: /^ctx / }))?.text).toBe('ctx 13%')
    await ui.unmount()
  }
})

test('the band hides itself when asked', async ($, on) => {
  stubEngine(on)
  await $.session.measure(reading())
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^5h / })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /^5h / })).toBeUndefined()
  await ui.unmount()
})

test('the pane reports the windows, and the index once it is read', async ($, on) => {
  stubEngine(on)
  stubIndexer(on)
  await $.session.measure(reading())

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /PLAN/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^5-hour/ }))?.text).toContain('5-hour')
    expect(await ui.find({ type: 'Text', text: /CONTEXT/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /129,420/ }))?.text).toContain('1,000,000')
    await ui.unmount()
  }

  // Pressing Refresh runs the indexer and takes in what it wrote.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /INDEX/ }))?.text).toContain('nothing read yet')
  await ui.press({ key: 'refresh' })
  const index = await ui.find({ type: 'Text', text: /INDEX/ })
  expect(index?.text).toContain('12,000 responses')
  expect(await ui.find({ type: 'Text', text: /No rates for/ })).toBeUndefined()
  await ui.unmount()
})

test('the pane prices the window, the models and the projects', async ($, on) => {
  stubEngine(on)
  stubIndexer(on)
  await $.session.measure(reading())
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  // The two recent rows fall inside the five-hour window.
  expect((await ui.find({ type: 'Text', text: /this window/ }))?.text).toContain('$12.75')
  expect((await ui.find({ type: 'Text', text: /last 24h/ }))?.text).toContain('$12.75')
  expect((await ui.find({ type: 'Text', text: /^MODELS/ }))?.text).toContain('$500')
  expect(await ui.find({ type: 'Text', text: /\$42\.50/ })).toBeDefined()
  await ui.unmount()
})

test('an unpriced model is said to be unpriced, not guessed at', async ($, on) => {
  stubEngine(on)
  stubIndexer(on, UNPRICED)
  await $.session.measure(reading())
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ type: 'Text', text: /No rates for/ }))?.text).toContain('pricing.json')
  expect((await ui.find({ type: 'Text', text: /this window/ }))?.text).toContain('$0')
  await ui.unmount()
})

test('the burn rate projects when the window fills before it resets', async ($, on) => {
  stubEngine(on)
  stubIndexer(on)
  await $.session.measure(reading())
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  const burn = await ui.find({ type: 'Text', text: /this window/ })
  expect(burn?.text).toContain('6.0M this window')
  await ui.unmount()
})

test('the command answers with the same figures', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  stubEngine(on)
  stubIndexer(on)
  await $.session.measure(reading())

  const ran = await $.command.run({
    command: 'usage-report',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(ran.text).toContain('5h: 20%')
  expect(ran.text).toContain('context: 13%')
})
