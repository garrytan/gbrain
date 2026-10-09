<!-- gbrain-plugin-tree-stamp: 0.60.130.0 -->
# gbrain plugin skill tree (generated — do not hand-edit)

This tree is the curated skill set for the gbrain Codex and Claude Code
plugins. Regenerate with `bun run scripts/generate-plugin-tree.ts --out plugin`;
curation lives in `skills/plugin-lanes.json` (one recorded decision per
addition/exclusion).

## MCP surface note (read once)

The plugin's MCP server runs `gbrain serve --surface full` — 161
operations, the same surface every stdio registration gbrain writes pins.
Every gbrain operation the bundled skills name is on it. A harness that caps
its tool count can narrow this machine's plugin surface with
`GBRAIN_SURFACE=starter` (or `verbs`); the server honors it and new sessions
pick it up. Skills keep their first-class `gbrain` CLI paths for anything a
narrowed list leaves out.

## Requirements

- gbrain CLI installed: `bun install -g github:garrytan/gbrain#latest-stable`
  (the npm package named `gbrain` is unrelated — never `npm install -g gbrain`).
- A brain: `gbrain init` (the bundled `setup` skill walks the full path).
