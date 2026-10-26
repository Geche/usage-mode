/** One rate-limit window as the engine reports it, plus what we worked out locally. */
export type Window = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** The live reading: plan windows, context fill, session cost. */
export type Live = {
  at: number
  windows: Window[]
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  costUsd: number | null
  /** False until the first measurement lands, so the band can stay quiet. */
  hasRead: boolean
}

/** One model's share of the indexed window. */
export type ModelRow = {
  model: string
  requests: number
  input: number
  output: number
  thinking: number
  cacheWrite: number
  cacheRead: number
  weighted: number
  usd: number | null
}

/** One project's share of the indexed window. */
export type ProjectRow = {
  project: string
  requests: number
  weighted: number
  usd: number | null
}

/** What the indexer last wrote, as the mod holds it. */
export type Rollup = {
  generatedAt: number
  scannedFiles: number
  newRecords: number
  totalRecords: number
  elapsedMs: number
  retentionDays: number
  /** Hour bucket key (`2026-10-26T13`) to weighted tokens and dollars. */
  hours: Record<string, { weighted: number; usd: number | null; requests: number }>
  /** Per-request rows for the last few hours, for exact windowing. */
  recent: { t: number; weighted: number; usd: number | null; model: string; project: string }[]
  models: ModelRow[]
  projects: ProjectRow[]
  unpricedModels: string[]
  error: string | null
}

export type Phase = 'idle' | 'running' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'usage-mode': {
      live: Live
      rollup: Rollup | null
      phase: Phase
      indexError: string | null
      isHidden: boolean
    }
  }
}
