# Connect GBrain to Claude Code

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.
>
> Want the **full agent** — identity, per-turn context, schedules, and a private
> repo as its durable body — not just a memory? That's `gbrain bootstrap`:
> see the paste block in the README and [docs/guides/bootstrap.md](../guides/bootstrap.md).
> Open a new empty folder (bootstrap creates the private repo for you), or make an
> empty private repo under your own account and open the clone — bootstrap adopts it.

## Option 0: Install as a Claude Code plugin

gbrain ships as a native Claude Code plugin — MCP server + the curated
brain-first skill set:

```
/plugin marketplace add garrytan/gbrain
/plugin install gbrain@gbrain
```

Two **persona variants** ship from the same marketplace — curated subsets
for sessions that don't want all 65 skills in the native manifest:

```
/plugin install gbrain-coding@gbrain    # brain-first coding persona
/plugin install gbrain-daily@gbrain     # daily personal-brain persona
```

Install exactly ONE gbrain plugin per machine — every variant serves the same
`gbrain` MCP server name, so two installed variants would double-serve.
Curation lives in `skills/plugin-lanes.json#personas` (one recorded reason
per skill). Alternative without a marketplace round-trip:
`gbrain skillpack scaffold --harness claude-code` copies the same persona set
into your user-scope skills dir with a local-edit-respecting update lens
(see docs/guides/skillpacks-as-scaffolding.md).

(CLI form: `claude plugin marketplace add garrytan/gbrain` +
`claude plugin install gbrain@gbrain`.) Prerequisites and behavior match the
[Codex plugin](CODEX.md#install-as-a-codex-plugin-recommended): the gbrain CLI
installed (`bun install -g github:garrytan/gbrain#latest-stable`), a brain
(`gbrain init`), `starter` MCP surface with `--source-guard`, and the same
routing rules (`GBRAIN_SOURCE`/`GBRAIN_BRAIN_ID` env — dotfiles don't apply
to a plugin-launched serve). Positioning: the plugin is the lightweight
brain+skills path; `gbrain bootstrap` remains the deep lane (identity, hooks,
push protocol). One approval-UX difference: the bootstrap lane pre-approves
`mcp__gbrain` via `permissions.allow` for headless runs; plugin-provided MCP
tools use the plugin lane's own approval flow.

## Option 1: Local (recommended, zero server needed)

```bash
claude mcp add gbrain -- gbrain serve --surface verbs
```

That's it. Claude Code spawns `gbrain serve` as a stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

`--surface verbs` exposes the seven-verb memory protocol (`recall`, `remember`,
`entity`, `synthesize`, `forget`, `context_pack`, `delta` —
[MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)),
the surface built for agents and quickstarts. `--surface starter` adds the
daily-driver set on top (core page/search/graph ops + capture). Drop the flag for the full
operation catalog (`get_page`, `put_page`, `search`, graph ops, …) — `full` is
the default and what existing installs already run.

## Option 2: Remote, one command (fastest from a bearer token)

If GBrain is running somewhere as an HTTP server (`gbrain serve --http`, see the
[ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md)) and you have a bearer token,
let `gbrain connect` generate the wire-up for you.

On the host (or anywhere `gbrain` is installed), mint a token and print the block:

```bash
gbrain auth create "claude-code"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx
```

`gbrain connect` prints a short, copy-paste block. Paste it into Claude Code — it
runs the `claude mcp add` for you and tells the agent to call `get_brain_identity`
and `list_skills` so it immediately knows what the brain can do.

Already on the machine you want to wire up? Skip the copy-paste and let `connect`
do it directly, with a built-in token smoke-test:

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app --token gbrain_xxx --install
```

(`--install` runs `claude mcp add`, then verifies the token by calling
`get_brain_identity` — so a wrong or expired token fails now, not silently on the
agent's first request. The URL is normalized: a bare host without `/mcp` gets it
appended; pass an explicit `https://` scheme.)

Pipe-friendly machine output (token redacted unless `--show-token`):

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --json
```

## Option 3: Remote, manual `claude mcp add`

Equivalent to what `gbrain connect` generates, if you'd rather run it yourself:

```bash
claude mcp add gbrain -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Replace `YOUR-DOMAIN` with your ngrok domain and `YOUR_TOKEN` with a token from
`gbrain auth create "claude-code"`.

> A `gbrain auth create` token is a long-lived, full-access secret. Keep it
> private (it lands in `~/.claude.json`), and prefer a scoped/short-lived token
> where your host supports one.

## Verify

In Claude Code, try:

```
search for [any topic in your brain]
```

You should see results from your GBrain knowledge base.

> **`list_skills` returns nothing?** Skill discovery is gated by `mcp.publish_skills`
> on the host. New brains from `gbrain init` default it ON; brains upgraded from an
> older release stay OFF until you opt in. Enable it on the host with
> `gbrain config set mcp.publish_skills true`. Skill discovery and the core tools
> named here (search, query, get_page, put_page, think, find_experts) are
> full-surface — on `--surface verbs` the agent sees only the seven memory verbs,
> and `list_skills` isn't on the surface at all. `capture` is on the starter and
> full surfaces (prefer it for quick notes — auto-slug + dedupe; `put_page` for
> full-control writes); if your tool list doesn't carry it, use `put_page`, or
> `remember` on the verbs surface.
> Why brains differ on the default: [tutorial A1](../tutorials/connect-coding-agent.md#a1-on-the-host-serve-over-http).

## Ambient recall at session boundaries (v0.45.7)

Two frozen verbs close the "no question fired" gap for long-lived sessions:
`context_pack` (session-start warm-up + post-compaction rehydration) and
`delta` ("what changed since my last wake" for heartbeats). Both are zero-LLM,
sub-second, world-visibility by default, and available on `--surface verbs`.

- **Automatic (PGLite brains via `gbrain bootstrap`):** the bootstrap hook
  installer wires `SessionStart` (injects a warm pack; also fires on
  post-compaction re-entry, `source=compact`) and `PreCompact` (banks the
  window's standing entities so that rehydration pack is warm) into
  `.claude/settings.local.json`. Nothing to call; `GBRAIN_HOOKS=0` disables.
- **Manual (any brain, incl. remote/Postgres):** call the verbs yourself at
  boundaries — `context_pack(entities, budget_tokens)` at session start /
  after compaction, `delta(session_id, budget_tokens)` on wakes. See
  [ambient recall](../guides/ambient-recall.md) for the placement frontier
  and the per-verb latency table.

## Remove

```bash
claude mcp remove gbrain     # the Option 1 local/stdio registration
# Installed as the Option 0 plugin instead? Remove it with:
#   claude plugin uninstall gbrain@gbrain
```
