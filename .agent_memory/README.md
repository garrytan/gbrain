# Kage Shared Agent Memory

Kage is a repo-local memory and code graph harness for coding agents. It lets a
team share not just files, but the reusable engineering context around those
files: why a bug happened, which paths matter, what tests proved the fix, and
what the next agent should recall before editing.

This directory is a committed Kage memory bundle for gbrain. It is intended to
be shared with teammates through Git, so the next agent starts with prior
contributor context instead of rediscovering it from scratch.

## What is included

- `packets/`: reviewed memory packets for bug fixes, repo maps, and workflow
  context.
- `graph/`: memory graph entities, edges, and evidence episodes connecting
  memories to paths, tests, commands, packages, and tags.
- `indexes/`: lookup indexes used by recall.
- `metrics.json`: high-level Kage metrics for the indexed repo.
- `structural/` and `code_graph/`: generated structural/code graph artifacts
  for files, symbols, imports, calls, routes, and tests.

## How a teammate uses it

After this directory is merged:

```bash
git pull
npm install -g @kage-core/kage-graph-mcp
kage setup verify-agent --agent codex --project .
kage recall "issue 394 dream --dry-run --json stdout" --project .
```

If the agent client reads `AGENTS.md`, it will also see the Kage bootstrap
policy added in this PR and should recall repo memory automatically before
implementation questions or code changes.

For Claude Code:

```bash
git pull
npm install -g @kage-core/kage-graph-mcp
kage setup verify-agent --agent claude-code --project .
kage recall "mixed-case slug import chunks Page not found" --project .
```

Claude Code users get the same bootstrap through `CLAUDE.md`.

Open the graph viewer:

```bash
kage viewer --project .
```

## What teammates should see

Example queries this bundle can answer:

- `issue 394 dream --dry-run --json stdout`
  - Recalls the dream/embed JSON stdout fix, the relevant files, and the
    targeted validation.
- `mixed-case slug import chunks Page not found`
  - Recalls the slug canonicalization fix across import and chunk writes.
- `check-backlinks positional dir`
  - Recalls the CLI parsing bug, target parser, and backlink tests.
- `Astro code sync coverage`
  - Recalls the `.astro` sync/chunking/link-reference change and test suite.

## Team workflow

1. Before editing, ask Kage for task-shaped context:

   ```bash
   kage recall "the issue or bug you are fixing" --project .
   ```

2. Inspect the returned paths and tests.
3. Make the change and verify it.
4. Capture the reusable learning:

   ```bash
   kage learn --project . --type bug_fix --title "short title" --learning "verified fix and why it works"
   ```

5. Refresh the artifact before opening or updating a PR:

   ```bash
   kage refresh --project .
   ```

The useful part is not just search. The shared memory preserves why fixes were
made, which tests proved them, and which code paths were involved.

## Why this is shareable

The memory is committed as repo-local data, not stored in one contributor's
agent session. When a teammate clones or pulls the repo, they receive the same
approved packets and graph artifacts. Their agent can ask Kage for context using
the local repository path and get the same bug-fix explanations, path links, and
test evidence.
