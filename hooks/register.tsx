import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { Live, Rollup } from '../types'

const PANE = 'usage'
const INDEX_EVERY_MS = 120_000
const WARN_AT = [80, 95]

const EMPTY: Live = {
  at: 0,
  windows: [],
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  costUsd: null,
  hasRead: false,
}

const live = atom({ plugin: 'usage-mode', key: 'live' } as const, EMPTY)
const rollup = atom({ plugin: 'usage-mode', key: 'rollup' } as const, null)
const phase = atom({ plugin: 'usage-mode', key: 'phase' } as const, 'idle')
const indexError = atom({ plugin: 'usage-mode', key: 'indexError' } as const, null)
const isHidden = atom({ plugin: 'usage-mode', key: 'isHidden' } as const, false)

const FIVE_HOUR_MS = 5 * 3_600_000

const LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const bar = (percent: number, cells = 10) => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const compact = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : `${Math.round(n)}`

const money = (usd: number) =>
  usd < 0.01 ? '$0' : usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`

const commas = (n: number) => Math.round(n).toLocaleString('en-US')

const forHumans = (ms: number) => {
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const atClock = (ms: number) => {
  const when = new Date(ms)

  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** The theme key for a percentage: colour marks the state, nothing else. */
const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : undefined)

/** Weighted tokens and equivalent spend the indexer recorded from `from` to now. */
const sumSince = (index: Rollup | null, from: number) => {
  const nothing = { weighted: 0, usd: 0 }
  if (index === null) return nothing
  const add = (sum: typeof nothing, part: { weighted: number; usd: number | null }) => ({
    weighted: sum.weighted + part.weighted,
    usd: sum.usd + (part.usd ?? 0),
  })
  const rows = index.recent.filter(row => row.t >= from)
  if (rows.length > 0 || from >= Date.now() - 8 * 3_600_000) {
    return rows.reduce(add, nothing)
  }
  // Beyond the per-request rows, the hourly buckets carry it.
  const firstHour = new Date(from).toISOString().slice(0, 13)

  return Object.entries(index.hours)
    .filter(([hour]) => hour >= firstHour)
    .reduce((sum, [, bucket]) => add(sum, bucket), nothing)
}

/**
 * When the five-hour window would fill at the present rate.
 *
 * The engine gives the window's exact end, so its start is known; the
 * transcripts give what has gone into it. Dividing the two against the
 * percentage already reported calibrates the rate per point on this account,
 * without the mod having to know how a plan weighs a model.
 */
const project = (state: Live, index: Rollup | null) => {
  const window = state.windows.find(one => one.kind === 'five_hour')
  if (!window?.resetsAt || window.percentUsed < 2) return null
  const resetsAt = Date.parse(window.resetsAt)
  const startedAt = resetsAt - FIVE_HOUR_MS
  const now = Date.now()
  const elapsed = now - startedAt
  if (elapsed <= 60_000) return null
  const { weighted, usd } = sumSince(index, startedAt)
  if (weighted <= 0) return null
  const perMs = weighted / elapsed
  const perPoint = weighted / window.percentUsed
  const left = (100 - window.percentUsed) * perPoint
  const fillsIn = left / perMs

  return {
    perHour: perMs * 3_600_000,
    weighted,
    usd,
    fillsAt: now + fillsIn,
    resetsAt,
    isAhead: now + fillsIn < resetsAt,
  }
}

/** Runs the indexer and takes in what it wrote. */
const reindex = async ($: EngineInterface, isFull = false) => {
  if ((await read($, phase)) === 'running') return
  await update($, phase, () => 'running')
  try {
    let node = (await $.store.get('nodePath')) as string | undefined
    if (node === undefined) {
      const found = await $.process.run(['/bin/sh', '-lc', 'command -v node'])
      node = found.stdout.trim().split('\n')[0] || 'node'
      await $.store.set('nodePath', node)
    }
    const argv = [node, `${$.plugin.root}/scripts/index.mjs`]
    if (isFull) argv.push('--full', '--force')
    const ran = await $.process.run(argv)
    const said = JSON.parse(ran.stdout.trim().split('\n').pop() ?? '{}')
    if (said.rollupPath === undefined) {
      throw new Error(said.error ?? said.skipped ?? 'the indexer wrote no rollup path')
    }
    const written = JSON.parse(await $.fs.read(said.rollupPath)) as Rollup
    await update($, rollup, () => written)
    await update($, indexError, () => null)
    await update($, phase, () => 'idle')
  } catch (error) {
    // A broken node path or an unreadable rollup is shown in the pane rather
    // than swallowed; the writes themselves may fail if the session is gone.
    const why = String((error as Error)?.message ?? error)
    try {
      await update($, indexError, () => why)
      await update($, phase, () => 'failed')
    } catch {
      // The session went away mid-read; nothing left to tell.
    }
  }
}

const takeReading = async ($: EngineInterface, reading: SessionMeasureInput | Awaited<ReturnType<EngineInterface['session']['usage']>>) => {
  const next: Live = {
    at: Date.now(),
    windows: reading.rateLimits.map(one => ({
      kind: one.kind,
      percentUsed: one.percentUsed,
      resetsAt: one.resetsAt,
    })),
    contextTokens: reading.context?.tokens ?? null,
    contextWindow: reading.context?.window ?? null,
    contextPercent: reading.context?.percent ?? null,
    costUsd: reading.cost?.usd ?? null,
    hasRead: true,
  }
  await update($, live, () => next)

  for (const window of next.windows) {
    for (const mark of WARN_AT) {
      if (window.percentUsed < mark) continue
      const key = `warned:${window.kind}:${window.resetsAt ?? 'none'}:${mark}`
      if ((await $.store.get(key)) === true) continue
      await $.store.set(key, true)
      const left = window.resetsAt ? `, resets in ${forHumans(Date.parse(window.resetsAt) - Date.now())}` : ''
      $.ui.toast(`${LABEL[window.kind] ?? window.kind} limit at ${window.percentUsed}%${left}`)
    }
  }
}

export const register: Register = on => {
  let indexedAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-report',
      description: 'Plan limits, context fill and token burn, in a pane',
    })
    void (async () => {
      const now = await $.session.usage()
      await takeReading($, now)
      await reindex($)
      indexedAt = Date.now()
    })()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await takeReading($, e)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (Date.now() - indexedAt > INDEX_EVERY_MS) {
      indexedAt = Date.now()
      void reindex($)
    }

    return next(e)
  })

  on('command.run', { command: 'usage-report' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Usage' })
    void reindex($)
    const state = await read($, live)
    const index = await read($, rollup)
    const lines = state.windows.map(
      one =>
        `${LABEL[one.kind] ?? one.kind}: ${one.percentUsed}%${
          one.resetsAt ? ` (resets in ${forHumans(Date.parse(one.resetsAt) - Date.now())})` : ''
        }`,
    )
    if (state.contextPercent !== null) lines.push(`context: ${state.contextPercent}%`)
    const ahead = project(state, index)
    if (ahead !== null) {
      lines.push(
        ahead.isAhead
          ? `burn: ${compact(ahead.perHour)}/h, fills the 5h window about ${atClock(ahead.fillsAt)}`
          : `burn: ${compact(ahead.perHour)}/h, inside the window`,
      )
    }

    return {
      text: opened.isPlaced
        ? `Usage pane open. ${lines.join(' · ')}`
        : `${lines.join(' · ')}\n(The pane needs a wider window; these are the same figures.)`,
    }
  })

  // The band: one row above the prompt, the whole state at a glance.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, live)
    if (e.props.hasSurvey || !state.hasRead || (await read($, isHidden))) {
      return next(e)
    }
    const index = await read($, rollup)
    const { Box, Button, Text } = $.ui.resolve(e)
    const ahead = project(state, index)
    const shown = state.windows.filter(one => one.kind in LABEL || one.kind === 'spend_limit')

    return (
      <Box gap={1}>
        {shown.map(one => (
          <Text key={one.kind} tabular color={tone(one.percentUsed)} dimColor={one.percentUsed < 75}>
            {LABEL[one.kind] ?? one.kind} {bar(one.percentUsed)} {Math.round(one.percentUsed)}%
          </Text>
        ))}
        {state.contextPercent !== null && (
          <Text tabular dimColor={state.contextPercent < 75} color={tone(state.contextPercent)}>
            ctx {Math.round(state.contextPercent)}%
          </Text>
        )}
        {ahead !== null && (
          <Text tabular dimColor>
            {compact(ahead.perHour)}/h{ahead.isAhead ? ` · full ${atClock(ahead.fillsAt)}` : ''}
          </Text>
        )}
        <Button key="report" label="Report" onPress={() => $.ui.open({ id: PANE, title: 'Usage' })} />
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  // The pane: the full report, limits first, then what filled them.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, live)
    const index = await read($, rollup)
    const at = await read($, phase)
    const failed = await read($, indexError)
    const ahead = project(state, index)
    const lastDay = sumSince(index, Date.now() - 86_400_000)

    const Row = ({ label, percent, note }: { label: string; percent: number; note: string }) => (
      <Box gap={1}>
        <Text tabular dimColor>
          {label.padEnd(12)}
        </Text>
        <Text tabular color={tone(percent)}>
          {bar(percent, 14)} {String(Math.round(percent)).padStart(3)}%
        </Text>
        <Text tabular dimColor>
          {note}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>PLAN</Text>
          {state.windows.length === 0 && <Text dimColor>No plan window reported (API key, or no reading yet).</Text>}
          {state.windows.map(one => (
            <Row
              key={one.kind}
              label={one.kind === 'five_hour' ? '5-hour' : one.kind === 'seven_day' ? 'weekly' : one.kind}
              percent={one.percentUsed}
              note={
                one.resetsAt
                  ? `resets ${atClock(Date.parse(one.resetsAt))} · ${forHumans(Date.parse(one.resetsAt) - Date.now())}`
                  : ''
              }
            />
          ))}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>CONTEXT</Text>
          {state.contextPercent === null ? (
            <Text dimColor>Not reported yet.</Text>
          ) : (
            <Row
              label="this session"
              percent={state.contextPercent}
              note={`${commas(state.contextTokens ?? 0)} / ${commas(state.contextWindow ?? 0)}`}
            />
          )}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>BURN · counted locally; dollars are equivalent API spend, not a bill</Text>
          {ahead === null ? (
            <Text dimColor>Not enough of this window measured yet.</Text>
          ) : (
            <Box flexDirection="column">
              <Text tabular>
                {compact(ahead.weighted)} this window · {compact(ahead.perHour)}/h · {money(ahead.usd)}
              </Text>
              <Text tabular dimColor>
                {ahead.isAhead
                  ? `at this rate the window fills about ${atClock(ahead.fillsAt)}, ${forHumans(
                      ahead.resetsAt - ahead.fillsAt,
                    )} before it resets`
                  : `at this rate it resets first, ${atClock(ahead.resetsAt)}`}
              </Text>
            </Box>
          )}
          <Text tabular dimColor>
            {compact(lastDay.weighted)} in the last 24h · {money(lastDay.usd)}
          </Text>
        </Box>

        {index !== null && (
          <Box flexDirection="column">
            <Text dimColor>
              MODELS · last {index.retentionDays} days ·{' '}
              {money(index.models.reduce((sum, row) => sum + (row.usd ?? 0), 0))}
            </Text>
            {index.models.slice(0, 6).map(row => (
              <Box key={row.model} gap={1}>
                <Text tabular dimColor>
                  {row.model.padEnd(20).slice(0, 20)}
                </Text>
                <Text tabular>{money(row.usd ?? 0).padStart(8)}</Text>
                <Text tabular dimColor>
                  {compact(row.weighted).padStart(7)} · {commas(row.requests).padStart(6)} req · out{' '}
                  {compact(row.output).padStart(6)} · cache read {compact(row.cacheRead)}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {index !== null && (
          <Box flexDirection="column">
            <Text dimColor>PROJECTS · last {index.retentionDays} days</Text>
            {index.projects.slice(0, 6).map(row => (
              <Box key={row.project} gap={1}>
                <Text tabular dimColor>
                  {row.project.padEnd(24).slice(0, 24)}
                </Text>
                <Text tabular>{money(row.usd ?? 0).padStart(8)}</Text>
                <Text tabular dimColor>
                  {compact(row.weighted).padStart(7)}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor color={failed === null ? undefined : 'error'}>
            {failed !== null
              ? `INDEX · failed: ${failed}`
              : index === null
              ? at === 'running'
                ? 'INDEX · reading transcripts'
                : 'INDEX · nothing read yet'
              : `INDEX · ${commas(index.totalRecords)} responses · ${index.scannedFiles} files last pass · ${forHumans(
                  Date.now() - index.generatedAt,
                )} ago${at === 'running' ? ' · reading' : ''}`}
          </Text>
          {index !== null && index.unpricedModels.length > 0 && (
            <Text dimColor>
              No rates for {index.unpricedModels.length} models, so no dollars are shown. Fill data/pricing.json.
            </Text>
          )}
          <Box gap={1}>
            <Button key="refresh" label="Refresh" onPress={() => reindex($)} />
            <Button key="rebuild" label="Rebuild index" onPress={() => reindex($, true)} />
            <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      </Box>
    )
  })
}
