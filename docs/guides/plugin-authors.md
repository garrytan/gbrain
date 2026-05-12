# Plugin authors guide (v0.15)

`gbrain` discovers subagent definitions from outside this repo via
`GBRAIN_PLUGIN_PATH`. If you maintain a downstream agent (your OpenClaw
deployment, a workflow host, a private tool) and want to ship custom
subagents alongside it, drop a plugin directory on that env path.

This guide is for plugin authors. The CLI user doesn't need to read it.

## Minimum viable plugin

```
/path/to/my-plugin/
├── gbrain.plugin.json
└── subagents/
    └── my-summarizer.md
```

`gbrain.plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "plugin_version": "gbrain-plugin-v1"
}
```

`subagents/my-summarizer.md`:

```markdown
---
name: my-summarizer
model: claude-sonnet-4-6
allowed_tools:
  - brain_search
  - brain_get_page
---

You are a brain page summarizer. Given a slug, fetch the page and produce
a 3-sentence summary.
```

## Turning it on

```bash
export GBRAIN_PLUGIN_PATH="/path/to/my-plugin"
gbrain jobs work           # worker startup prints the plugin load line
gbrain agent run "summarize meetings/2026-04-20" --subagent-def my-summarizer
```

Multiple plugins: colon-separated, just like `$PATH`.

```bash
export GBRAIN_PLUGIN_PATH="/path/to/plugin-a:/path/to/plugin-b"
```

## Rules (strict by design)

**Path policy.** Absolute paths only. Relative paths, `~`-prefixed paths,
and URL-style paths (`https://`, `file://`) are rejected with a warning.
You control where your plugin lives on disk; `gbrain` doesn't guess.

**Collision policy.** If two plugins ship a subagent with the same `name`,
the one listed FIRST in `GBRAIN_PLUGIN_PATH` wins. The other is dropped
with a warning naming both sources.

**Trust policy.** Plugins ship subagent definitions ONLY in v0.15:

- You **cannot** declare new tools.
- You **cannot** extend the brain tool allow-list.
- You **cannot** override any `agentSafe` or similar flag.
- Your `allowed_tools:` frontmatter field MUST subset the derived brain
  tool registry. Names not in the registry are rejected at plugin load
  time (worker startup), NOT at subagent dispatch time — so a typo in
  your plugin gives you a loud startup error, not a silent "tool never
  fires" at 3am.

v0.16+ may open up plugin-declared tools with a separate contract. Don't
expect it.

For host-native tool or HTTP route packages, use the host-adapter boundary in
[`docs/guides/host-adapters.md`](host-adapters.md) instead of adding host
runtime assumptions to a GBrain plugin definition.

## `gbrain.plugin.json`

| field            | type   | required | notes                                                              |
|------------------|--------|----------|--------------------------------------------------------------------|
| `name`           | string | yes      | Human-readable plugin id. Shows up in warnings and collision logs. |
| `version`        | string | yes      | Your plugin's semver. Informational.                               |
| `plugin_version` | string | yes      | Contract lock. Must equal `"gbrain-plugin-v1"` for v0.15.          |
| `subagents`      | string | no       | Subdir name (default `subagents`). Escape-attempts are rejected.   |
| `description`    | string | no       | Shown in future `gbrain plugin list`.                              |

## Subagent definition files

Plain markdown with YAML frontmatter. The body is the system prompt. The
frontmatter controls runtime behavior.

Recognized frontmatter fields:

| field           | type     | required | notes                                                                                   |
|-----------------|----------|----------|-----------------------------------------------------------------------------------------|
| `name`          | string   | no       | Subagent identifier used as `--subagent-def`. Defaults to the file basename.            |
| `model`         | string   | no       | Anthropic model id. Defaults to the handler default (sonnet).                           |
| `max_turns`     | number   | no       | Cap on assistant turns. Defaults to 20.                                                 |
| `allowed_tools` | string[] | no       | Whitelist of tool names. Must subset the derived brain registry. Rejected on mismatch.  |

Unknown frontmatter fields are preserved but ignored by the handler. v0.16
may consume more of them.

## Caveats that will bite you

1. **Plugin definitions can't change during a run.** The loader reads the
   disk once at worker startup. Editing a subagent def doesn't re-take
   effect until you restart the worker. This is deliberate — live
   reloads would break crash-resumable replay.

2. **`~/.gbrain/audit/subagent-jobs-*.jsonl` is local only.** If your
   worker runs on a different host than the `gbrain agent logs` caller,
   the CLI won't see heartbeats from that worker. v0.16 will unify this;
   for now assume worker + CLI share a filesystem.

3. **Tool calls always run with `ctx.remote = true`.** Even on local CLI
   invocation. Tools that gate on `remote=true` (file_upload's strict
   confinement, put_page's namespace check) will apply. Good default; a
   subagent definition that wants local-filesystem reach beyond the brain
   can't have it.

4. **`put_page` writes are namespace-scoped.** A subagent with id 42 can
   only write under `wiki/agents/42/...`. This is enforced both in the
   tool schema (the slug pattern shown to the model) AND server-side in
   the `put_page` operation (fail-closed if `viaSubagent=true`). Don't
   try to route around it; you'll get `permission_denied`.

## Example: a downstream-OpenClaw plugin

```
~/your-openclaw/
└── gbrain-plugin/
    ├── gbrain.plugin.json
    └── subagents/
        ├── meeting-ingestion.md
        ├── signal-detector.md
        └── daily-task-prep.md
```

`~/your-openclaw/gbrain-plugin/gbrain.plugin.json`:

```json
{
  "name": "your-openclaw",
  "version": "2026.4.20",
  "plugin_version": "gbrain-plugin-v1",
  "description": "Your OpenClaw's personal-brain subagents"
}
```

Environment:

```bash
export GBRAIN_PLUGIN_PATH="$HOME/your-openclaw/gbrain-plugin"
```

Then your OpenClaw calls `gbrain agent run --subagent-def meeting-ingestion
--fanout-by transcript ...` and its definitions load automatically.
