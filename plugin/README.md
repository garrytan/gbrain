<!-- gbrain-plugin-tree-stamp: 0.46.22.0 -->
# gbrain plugin skill tree (generated — do not hand-edit)

This tree is the curated skill set for the gbrain Codex and Claude Code
plugins. Regenerate with `bun run scripts/generate-plugin-tree.ts --out plugin`;
curation lives in `skills/plugin-lanes.json` (one recorded decision per
addition/exclusion).

## MCP surface note (read once)

The plugin's MCP server runs `gbrain serve --surface starter` — the
27-op daily-driver surface (the seven memory verbs + daily
brain ops + capture). 21
bundled skills reference gbrain operations beyond that surface; every one of
them has a first-class `gbrain` CLI path, which is the primary way skills
drive gbrain. When a skill step names an operation your MCP tool list doesn't
carry, run the equivalent `gbrain` CLI command, or widen this machine's
plugin surface with `GBRAIN_SURFACE=full` (the launcher honors it; new
sessions pick it up).

## Requirements

- gbrain CLI installed: `bun install -g github:garrytan/gbrain#latest-stable`
  (the npm package named `gbrain` is unrelated — never `npm install -g gbrain`).
- A brain: `gbrain init` (the bundled `setup` skill walks the full path).
