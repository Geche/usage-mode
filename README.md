# usage-mode

[![CI](https://github.com/Geche/usage-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/Geche/usage-mode/actions/workflows/ci.yml)

Keeps your Claude Code usage in view: a row above the prompt showing every plan
window, the context fill and your current token burn, with a fuller report in a
pane and the same figures as text from `/usage-report`.

Two sources sit behind it, and only one is treated as authoritative. The
engine's own reading (`$.session.usage()`, refreshed on `session.measure`) gives
the plan windows as percentages with their reset times, and the live context
fill — those numbers are never computed here. Everything historical comes from
the transcripts under `~/.claude/projects`, which `scripts/index.mjs` folds into
a small rollup: per-model and per-project totals, hourly buckets, and
per-request rows for the last few hours.

The indexer is incremental. It remembers each transcript's inode, size and byte
offset, so after the first pass it reads only what was appended — a full pass
over ~1,600 transcripts takes seconds, an incremental one milliseconds. Requests
are deduplicated on `requestId`, because the same assistant response is written
into every transcript that inherited it (resumes, forks, subagents, workflow
agents, compaction), and counting those twice is the classic way these tools
overstate usage. Cache writes are split into their 5-minute and 1-hour buckets,
which are priced differently, and thinking tokens are left inside the output
count they already belong to.

## Installing

At the prompt of a terminal session:

```
/plugin install usage-mode --marketplace Geche/usage-mode
```

Answer `y` to `Add marketplace?`, then press Enter to take the user scope. From a
shell instead:

```
claude plugin install usage-mode --marketplace Geche/usage-mode
```

In the desktop app, where `/plugin` does not run: click + beside the prompt box,
then Plugins, then Add marketplace with `Geche/usage-mode`, then Add plugin.

## Using it

- The band draws itself once the first reading lands; `Hide` puts it away for
  the session.
- `/usage-report` opens the pane and prints the same figures, so it still works
  where a pane has no room.
- `Refresh` re-runs the indexer; `Rebuild index` re-reads every transcript from
  the top.
- Nothing leaves the machine, and no transcript content is read into the
  rollup — only counts.
## Burn rate and the projection

The engine reports when the five-hour window resets, so its start is known
exactly; the transcripts say what has gone into it. Dividing those against the
percentage already reported calibrates how much a point of this account's limit
costs, without the mod needing to know how a plan weighs one model against
another. That is what the `full HH:MM` figure in the band means: when the window
would fill at the present rate.

"Weighted tokens" is a local pacing unit, not a billing figure — output counts
five times input, cache reads a tenth, matching the shape of the published
rates. The weights live in `data/pricing.json`.

## Dollars

`data/pricing.json` carries every current model's rates, taken verbatim from
Anthropic's pricing page and dated in the file — input, output, both cache-write
rates and the cache read rate, all explicit. They are explicit because cache
reads do not follow a fixed fraction of input: most models read at a tenth, but
Opus 5.5 and Sonnet 5.5 read at a twentieth and Fable 5.1 at a fortieth, so a
multiplier would overstate the models whose usage is mostly cache reads — which,
in a long agent session, is nearly all of it. Haiku 5.5 is priced by prompt
size, so it carries two tiers and the indexer picks one per request from that
request's own prompt tokens.

A model missing from the table is still counted in tokens and reported as
unpriced rather than guessed at, so no figure here is one the mod invented.

The dollar columns are *equivalent API spend* — what this usage would have cost
through the API. On a subscription they are a sense of scale, not a bill.

## Developing

Four commands, and the first two need no Claude Code at all:

```
node --check scripts/index.mjs
node --test scripts/*.test.mjs
claude plugin validate . --strict
claude plugin test .
```

The indexer tests build throwaway transcript trees and run the indexer over
them, so they cover the arithmetic that matters: deduplication across
transcripts, the byte offsets behind incremental runs, a half-written last line,
a rotated file, the two cache-write lifetimes, prompt-size tiers, the retention
horizon, and every rate in `data/pricing.json`. `claude plugin validate` reads
the manifests and the hooks module the way the engine will, and `claude plugin
test` runs the mod's own tests against each surface it draws on.

Type-checking is a local step only: `tsc -p .` needs the declarations the engine
writes into `.claude-plugin/types/` when it loads the mod, and those are
per-machine and not in the repository. CI covers the module by running it
instead.

To run the mod from this folder while working on it:

```
claude --plugin-dir .
```

CI runs all four commands on every push and pull request — the indexer tests on
Node 20, 22 and 24, and the Claude Code steps against a pinned version, with a
weekly run against the latest release to catch the engine moving underneath.

## Releasing

The version in `.claude-plugin/plugin.json` is the one that counts. Bump it,
commit, then:

```
claude plugin tag . --push
```

That creates and pushes `usage-mode--v<version>`, checking first that the
manifest and the marketplace entry agree. The push starts the release workflow,
which re-runs every check, refuses a tag that disagrees with the manifest, and
publishes a GitHub release whose notes carry the install line and the commits
since the previous tag.

