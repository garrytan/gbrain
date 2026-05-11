# Kage-Assisted Contribution Sprint

## Goal

Show how a repo-local memory and code graph harness can help an outside
contributor land a focused set of gbrain fixes without repeatedly rediscovering
the same repository structure.

This guide is a contribution case study. It does not install Kage, does not
change gbrain runtime behavior, and does not add `.agent_memory` artifacts to
this repository.

## What the Maintainer Gets

Without a repo memory layer: every new coding agent starts by re-reading the
same files, re-running broad searches, and asking the maintainer for context the
repo already taught a previous agent.

With a repo memory layer: the contributor can ask one task-shaped question, get
the relevant files, tests, prior fixes, and graph neighborhoods, then capture
the verified learning for the next issue.

## Sprint Results

The sprint opened ten focused pull requests against existing issues:

| PR | Issue | Change |
|----|-------|--------|
| [#818](https://github.com/garrytan/gbrain/pull/818) | [#813](https://github.com/garrytan/gbrain/issues/813) | Fix git submodule flag placement for `code-sync` |
| [#821](https://github.com/garrytan/gbrain/pull/821) | [#713](https://github.com/garrytan/gbrain/issues/713) | Preserve `whoami` identity through stdio MCP calls |
| [#822](https://github.com/garrytan/gbrain/pull/822) | [#799](https://github.com/garrytan/gbrain/issues/799) | Make `doctor` skip generated dependency folders |
| [#823](https://github.com/garrytan/gbrain/pull/823) | [#709](https://github.com/garrytan/gbrain/issues/709) | Add Astro frontmatter/script/style support to code sync |
| [#824](https://github.com/garrytan/gbrain/pull/824) | [#693](https://github.com/garrytan/gbrain/issues/693) | Keep `doctor --json` stdout machine-parseable |
| [#825](https://github.com/garrytan/gbrain/pull/825) | [#485](https://github.com/garrytan/gbrain/issues/485) | Restore positional directory handling for `check-backlinks` |
| [#826](https://github.com/garrytan/gbrain/pull/826) | [#486](https://github.com/garrytan/gbrain/issues/486) | Add npm fallback for `check-update` |
| [#827](https://github.com/garrytan/gbrain/pull/827) | [#394](https://github.com/garrytan/gbrain/issues/394) | Keep `dream --dry-run --json` stdout clean |
| [#828](https://github.com/garrytan/gbrain/pull/828) | [#430](https://github.com/garrytan/gbrain/issues/430) | Preserve mixed-case slugs through import and chunk lookup |
| [#829](https://github.com/garrytan/gbrain/pull/829) | [#380](https://github.com/garrytan/gbrain/issues/380) | Support `put --file` and reject unknown shared operation flags |

One extra pull request, [#819](https://github.com/garrytan/gbrain/pull/819),
covered MCP array schema item validation but is not counted in the ten because
an upstream duplicate was already in flight.

## Kage Metrics From The Contributor Worktree

The contributor ran Kage locally against gbrain. The generated memory and graph
artifacts stayed in the contributor worktree.

| Metric | Value |
|--------|-------|
| Indexed files | 756 |
| Symbols | 27,572 |
| Imports | 2,899 |
| Calls | 47,136 |
| Routes | 20 |
| Tests | 5,364 |
| Indexer coverage | 100% |
| Structural workers | 8 |
| Approved memory packets | 12 |
| Memory graph | 274 entities, 352 edges, 13 episodes |
| Evidence-backed graph edges | 352 of 352 |
| Estimated indexed source context | 1,796,180 tokens |
| Typical recall context | ~1,800 tokens |
| Estimated source tokens avoided per recall | ~1,794,380 tokens |

The important number is not the raw token estimate. It is that issue work moved
from "scan the repo again" to "retrieve a small, source-backed slice, then
verify with tests."

## Examples

### Issue #394: quiet JSON output for dream

Kage query:

```bash
kage recall "issue 394 dream --dry-run --json preamble stdout valid JSON tests" --project .
```

Useful context returned:

- `src/commands/dream.ts`
- `src/core/cycle.ts`
- `src/commands/embed.ts`
- `test/dream.test.ts`

How it helped: the recalled code neighborhood showed that the noisy preamble
came through the dream command path, while embed has its own standalone behavior.
The fix kept embed output intact and made dream's structured output parseable.

Captured learning:

```bash
kage learn --project . --type bug_fix \
  --title "dream JSON output must keep stdout clean" \
  --learning "When fixing dream --dry-run --json, suppress human progress output only in the dream structured-output path. Do not globally silence embed."
```

### Issue #430: mixed-case slug import

Kage query:

```bash
kage recall "mixed-case slug put_page lowercased slug upsertChunks Page not found" --project .
```

Useful context returned:

- `src/core/import-file.ts`
- chunk upsert paths for PGLite and Postgres
- prior memory about slug normalization bugs

How it helped: the memory made the bug look like a cross-path normalization
problem, not a narrow import-only defect. The fix preserved the canonical slug
through import and chunk lookup.

### Issue #380: `put --file` and unknown flags

Kage query:

```bash
kage recall "put --file ignored unknown flags should error CLI put command operations tests" --project .
```

Useful context returned:

- CLI shared operation flag parsing
- `put` command implementation
- tests that assert invalid flags fail before database work

How it helped: the change added the missing `--file` behavior while also
preventing silent typos in shared operation flags.

## Suggested Adoption Model

Kage is optional for gbrain. A low-friction maintainer path would be:

1. Try it locally on a fork or contributor branch.
2. Review the recall quality, generated graph, and captured memories.
3. If useful, add an `AGENTS.md` policy in a separate PR.
4. Decide explicitly whether any `.agent_memory/packets/` files should be
   committed. Do not commit generated caches or private local state.

Kage should complement gbrain, not replace it. GBrain is the durable personal
knowledge brain. Kage is repo-local engineering memory: bugs, decisions, test
workflows, code graph context, and change summaries tied to source files.

## Setup

Kage package and docs:

- GitHub: <https://github.com/kage-core/Kage>
- npm: <https://www.npmjs.com/package/@kage-core/kage-graph-mcp>
- hosted graph viewer: <https://kage-core.github.io/Kage/viewer/>

Codex setup:

```bash
npm install -g @kage-core/kage-graph-mcp
kage setup codex --project . --write
kage init --project .
kage setup verify-agent --agent codex --project .
```

Claude Code setup:

```bash
npm install -g @kage-core/kage-graph-mcp
kage setup claude-code --project . --write
kage init --project .
kage setup verify-agent --agent claude-code --project .
```

Useful commands during issue work:

```bash
kage recall "issue or task description" --project .
kage code-graph "symbol, path, or test name" --project .
kage learn --project . --type bug_fix --title "..." --learning "..."
kage refresh --project .
kage viewer --project .
```

## How To Verify

1. Read the linked PRs and confirm each maps to a real issue and focused diff.
2. Run Kage locally on a fork and compare recall results before and after
   capturing a bug-fix memory.
3. Open the viewer and verify the graph shows both code structure and memory
   links without requiring generated artifacts to be committed.
4. Keep adoption human-gated: no org, global, public, or shared memory assets
   should be published automatically.
