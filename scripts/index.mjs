#!/usr/bin/env node
// usage-mode indexer: folds ~/.claude/projects/**/*.jsonl into a small rollup.
//
// Incremental by design: per-file byte offsets are remembered, so only the
// tail of each transcript is read after the first run. Requests are deduped
// across files, because the same assistant response is written into every
// transcript that inherited it (resumes, forks, sidechains, compaction).
//
// Writes <home>/rollup.json and prints a one-line JSON summary on stdout.

import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1]
}

const HOME = value('home', join(homedir(), '.claude', 'usage-mode'))
const PROJECTS = value('projects', join(homedir(), '.claude', 'projects'))
const PRICING = value('pricing', join(import.meta.dirname, '..', 'data', 'pricing.json'))
const RETENTION_DAYS = Number(value('retention', 45))
const RECENT_HOURS = Number(value('recent-hours', 8))
const RECENT_CAP = 8000
const LOCK_STALE_MS = 10 * 60 * 1000

const STATE = join(HOME, 'index-state.json')
const SEEN = join(HOME, 'seen.json')
const ROLLUP = join(HOME, 'rollup.json')
const LOCK = join(HOME, 'index.lock')

const DEFAULT_WEIGHTS = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  output: 5,
}

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const writeJsonAtomic = async (path, data) => {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, path)
}

const hourKey = ms => new Date(ms).toISOString().slice(0, 13)
const dayKey = ms => new Date(ms).toISOString().slice(0, 10)

/**
 * Every .jsonl under the projects tree, at any depth: a project folder holds
 * its main transcripts, and under each session folder sit the subagent and
 * workflow-agent transcripts, which spend real tokens and so are counted too.
 */
const transcripts = async () => {
  const found = []
  const walk = async (dir, project) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path, project ?? entry.name)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && project !== null) {
        found.push({ path, project })
      }
    }
  }
  let folders = []
  try {
    folders = await readdir(PROJECTS, { withFileTypes: true })
  } catch {
    return found
  }
  for (const folder of folders) {
    if (folder.isDirectory()) await walk(join(PROJECTS, folder.name), folder.name)
  }
  return found
}

/**
 * Reads whole lines from `start`, handing each to `onLine`, and returns the
 * byte offset of the last complete line's end — a half-written line at the
 * tail is left for the next run.
 */
const foldTail = (path, start, onLine) =>
  new Promise((resolve, reject) => {
    let consumed = start
    let buf = ''
    const stream = createReadStream(path, { start, encoding: 'utf8' })
    stream.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        consumed += Buffer.byteLength(line, 'utf8') + 1
        if (line.length > 0) onLine(line)
      }
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(consumed))
  })

const AGENT_CWD = /^(agent-[0-9a-f]+|wf_[0-9a-z-]+)$/
/**
 * A project folder's readable name. The folder encodes an absolute path with
 * every separator turned into a hyphen, and a username may itself hold one, so
 * the last `-Projects-` is the only landmark worth trusting.
 */
const readableFolder = folder => {
  const at = folder.lastIndexOf('-Projects-')
  return at === -1 ? folder.replace(/^-+/, '') : folder.slice(at + 10)
}
/**
 * Where the work happened: the working directory's own name, falling back to
 * the project folder when the cwd is just a subagent's or workflow's scratch id.
 */
const projectName = (cwd, folder) => {
  const name = cwd ? basename(cwd) : ''
  return name === '' || AGENT_CWD.test(name) ? readableFolder(folder) : name
}

const pricingFor = (pricing, model) => {
  const table = pricing.models ?? {}
  if (table[model]) return table[model]
  let best = null
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  return best === null ? null : table[best]
}

/**
 * The rates that apply to one request. Haiku 5.5 is priced by prompt size, so
 * a model may carry tiers instead of rates: the first whose ceiling the prompt
 * fits under wins, and the last one has none.
 */
const ratesFor = (rates, m) => {
  if (!rates?.tiers) return rates
  const prompt = m.input + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h

  return rates.tiers.find(tier => tier.maxPromptTokens == null || prompt <= tier.maxPromptTokens) ?? null
}

/** Dollars for one record, or null when the model has no verified rates. */
const costOf = (table, defaults, m) => {
  const rates = ratesFor(table, m)
  if (!rates || rates.input == null || rates.output == null) return null
  const perM = n => n / 1_000_000
  const write5m = rates.cacheWrite5m ?? rates.input * (defaults.cacheWrite5mMultiplier ?? 1.25)
  const write1h = rates.cacheWrite1h ?? rates.input * (defaults.cacheWrite1hMultiplier ?? 2)
  const read = rates.cacheRead ?? rates.input * (defaults.cacheReadMultiplier ?? 0.1)
  return (
    perM(m.input) * rates.input +
    perM(m.output) * rates.output +
    perM(m.cacheWrite5m) * write5m +
    perM(m.cacheWrite1h) * write1h +
    perM(m.cacheRead) * read
  )
}

const main = async () => {
  await mkdir(HOME, { recursive: true })

  // One indexer at a time; a stale lock is taken over.
  const held = await readJson(LOCK, null)
  if (held && Date.now() - held.at < LOCK_STALE_MS && !flag('force')) {
    process.stdout.write(JSON.stringify({ skipped: 'locked', since: held.at, rollupPath: ROLLUP }) + '\n')
    return
  }
  await writeFile(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')

  try {
    const pricing = await readJson(PRICING, { models: {}, defaults: {} })
    const weights = { ...DEFAULT_WEIGHTS, ...(pricing.weights ?? {}) }
    const defaults = pricing.defaults ?? {}

    const fresh = flag('full')
    const state = fresh ? { files: {} } : await readJson(STATE, { files: {} })
    const seen = fresh ? {} : await readJson(SEEN, {})
    const previous = fresh ? null : await readJson(ROLLUP, null)

    const horizon = Date.now() - RETENTION_DAYS * 86_400_000
    const recentFrom = Date.now() - RECENT_HOURS * 3_600_000

    const hours = { ...(previous?.hours ?? {}) }
    const models = new Map()
    const projects = new Map()
    for (const row of previous?.models ?? []) models.set(row.model, { ...row })
    for (const row of previous?.projects ?? []) projects.set(row.project, { ...row })
    const recent = (previous?.recent ?? []).filter(row => row.t >= recentFrom)

    const unpriced = new Set(previous?.unpricedModels ?? [])
    let newRecords = 0
    let scannedFiles = 0
    let totalRecords = previous?.totalRecords ?? 0

    const take = (line, project) => {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        return
      }
      if (row.type !== 'assistant') return
      const usage = row.message?.usage
      if (!usage) return

      const id =
        row.requestId ?? row.message?.id ?? (row.sessionId && row.uuid ? `${row.sessionId}:${row.uuid}` : null)
      if (id === null) return
      const when = Date.parse(row.timestamp ?? '')
      if (!Number.isFinite(when) || when < horizon) return
      const day = dayKey(when)
      if (seen[id] !== undefined) return
      seen[id] = day

      const cache = usage.cache_creation ?? {}
      const m = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite5m: cache.ephemeral_5m_input_tokens ?? 0,
        cacheWrite1h: cache.ephemeral_1h_input_tokens ?? 0,
      }
      // Older records carry only the total; attribute it to the 5m bucket.
      const writeTotal = usage.cache_creation_input_tokens ?? 0
      if (m.cacheWrite5m + m.cacheWrite1h === 0 && writeTotal > 0) m.cacheWrite5m = writeTotal

      const model = row.message?.model ?? 'unknown'
      if (model === '<synthetic>') return
      const rates = pricingFor(pricing, model)
      const usd = costOf(rates, defaults, m)
      if (usd === null) unpriced.add(model)

      const weighted =
        m.input * weights.input +
        m.cacheWrite5m * weights.cacheWrite5m +
        m.cacheWrite1h * weights.cacheWrite1h +
        m.cacheRead * weights.cacheRead +
        m.output * weights.output

      const name = projectName(row.cwd, project)
      const hk = hourKey(when)
      const bucket = hours[hk] ?? (hours[hk] = { weighted: 0, usd: 0, requests: 0 })
      bucket.weighted += weighted
      bucket.requests += 1
      if (usd !== null) bucket.usd += usd

      const modelRow =
        models.get(model) ??
        models
          .set(model, {
            model,
            requests: 0,
            input: 0,
            output: 0,
            thinking: 0,
            cacheWrite: 0,
            cacheRead: 0,
            weighted: 0,
            usd: 0,
          })
          .get(model)
      modelRow.requests += 1
      modelRow.input += m.input
      modelRow.output += m.output
      modelRow.thinking += m.thinking
      modelRow.cacheWrite += m.cacheWrite5m + m.cacheWrite1h
      modelRow.cacheRead += m.cacheRead
      modelRow.weighted += weighted
      if (usd !== null && modelRow.usd !== null) modelRow.usd += usd

      const projectRow =
        projects.get(name) ??
        projects.set(name, { project: name, requests: 0, weighted: 0, usd: 0 }).get(name)
      projectRow.requests += 1
      projectRow.weighted += weighted
      if (usd !== null && projectRow.usd !== null) projectRow.usd += usd

      if (when >= recentFrom) recent.push({ t: when, weighted, usd, model, project: name })

      newRecords += 1
      totalRecords += 1
    }

    const startedAt = Date.now()
    for (const { path, project } of await transcripts()) {
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      const known = state.files[path]
      // A file that shrank or was replaced is read from the top again.
      const isSame = known && known.ino === info.ino && info.size >= known.size
      const from = isSame ? known.offset : 0
      if (isSame && info.size === known.size && info.mtimeMs === known.mtimeMs) continue
      scannedFiles += 1
      try {
        const offset = await foldTail(path, from, line => take(line, project))
        state.files[path] = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, offset }
      } catch {
        // An unreadable transcript is skipped, not fatal.
      }
    }

    // Prune everything past the retention horizon.
    const oldestHour = hourKey(horizon)
    for (const key of Object.keys(hours)) if (key < oldestHour) delete hours[key]
    const oldestDay = dayKey(horizon)
    for (const [id, day] of Object.entries(seen)) if (day < oldestDay) delete seen[id]

    const byWeight = (a, b) => b.weighted - a.weighted
    const rollup = {
      generatedAt: Date.now(),
      scannedFiles,
      newRecords,
      totalRecords,
      elapsedMs: Date.now() - startedAt,
      retentionDays: RETENTION_DAYS,
      hours,
      recent: recent.slice(-RECENT_CAP),
      models: [...models.values()].sort(byWeight),
      projects: [...projects.values()].sort(byWeight).slice(0, 25),
      unpricedModels: [...unpriced].sort(),
      error: null,
    }

    await writeJsonAtomic(ROLLUP, rollup)
    await writeJsonAtomic(STATE, state)
    await writeJsonAtomic(SEEN, seen)

    process.stdout.write(
      JSON.stringify({
        ok: true,
        rollupPath: ROLLUP,
        home: HOME,
        scannedFiles,
        newRecords,
        totalRecords,
        elapsedMs: rollup.elapsedMs,
        unpriced: rollup.unpricedModels.length,
      }) + '\n',
    )
  } finally {
    await unlink(LOCK).catch(() => {})
  }
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }) + '\n')
  process.exitCode = 1
})
