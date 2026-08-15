# Connect GBrain to Codex

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.
>
> Want the **full agent** — identity, memory, schedules, and a private repo as its
> durable body — not just a connection? That's `gbrain bootstrap`: see the paste
> block in the README and [docs/guides/bootstrap.md](../guides/bootstrap.md).

Recent versions of the Codex CLI (`@openai/codex`) support remote
streamable-HTTP MCP servers with a bearer token read from an environment
variable. On THIS page's `gbrain connect` path the token lives in your shell
env, not in Codex's config file. The exception is `gbrain bootstrap harness`
(local agent-framework boxes): framework-spawned codex inherits no shell
profile, so that lane writes the token INLINE into a managed, 0600
`[mcp_servers.gbrain]` block in the codex config — stated in its consent
block, removable with `gbrain bootstrap harness --remove`.

## Fastest path: `gbrain connect`

Run anywhere `gbrain` is installed (mint a token on the brain host first):

```bash
gbrain auth create "codex"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent codex
```

This prints a copy-paste block. Or wire it up directly and smoke-test the token:

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent codex --install
```

`--install` runs `codex mcp add` for you, then makes one real call to the brain so
a wrong/expired token fails right away. Because Codex reads the token from the env
var at runtime, keep `GBRAIN_REMOTE_TOKEN` exported in your shell profile.

## Manual setup

```bash
export GBRAIN_REMOTE_TOKEN=gbrain_xxx
codex mcp add gbrain --url https://YOUR-DOMAIN.ngrok.app/mcp \
  --bearer-token-env-var GBRAIN_REMOTE_TOKEN
```

Codex stores the env-var *name* (`GBRAIN_REMOTE_TOKEN`), not the token itself, and
reads the value when it launches the MCP server. Add the `export` line to your
`~/.zshrc` / `~/.bashrc` so it's set in every session.

## Verify

In Codex, ask it to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

`get_brain_identity` confirms whose brain you're connected to; `list_skills` shows
everything it can do.

> **`list_skills` empty?** It's gated by `mcp.publish_skills` on the host — enable
> it with `gbrain config set mcp.publish_skills true`. The core tools (search,
> query, get_page, put_page, think, find_experts) work regardless; `capture` is
> CLI-only, so write over MCP with `put_page`. Why brains differ on the default:
> [tutorial A1](../tutorials/connect-coding-agent.md#a1-on-the-host-serve-over-http).

## Remove

```bash
codex mcp remove gbrain
```

## Notes

- The token is a long-lived, full-access secret. Keep `GBRAIN_REMOTE_TOKEN` out of
  version control and prefer a scoped token if your host supports one.
- Local stdio also works if you run the brain on the same machine:
  `codex mcp add gbrain -- gbrain serve --surface verbs` — the memory-verb
  protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)); drop the flag
  for the full operation catalog.
- **Ambient recall (Codex has no lifecycle hooks — use the pull path).** At the
  start of a topical thread and after a compaction, call
  `context_pack(entities, budget_tokens)` to warm the standing entities; on a
  periodic wake call `delta(session_id, budget_tokens)` for "what changed since
  my last wake" (deduped per session). Both are zero-LLM, sub-second, world-only
  by default, and on `--surface verbs`. See
  [ambient recall](../guides/ambient-recall.md) for the placement frontier.
