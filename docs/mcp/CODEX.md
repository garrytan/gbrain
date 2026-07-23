# Connect GBrain to Codex

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.

Codex CLI (`@openai/codex`, v0.130+) supports remote streamable-HTTP MCP servers
with a bearer token read from an environment variable. The token lives in your
shell env, not in Codex's config file.

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

> **`list_skills` empty?** It's gated by `mcp.publish_skills` on the host (default
> ON for `gbrain init` brains, OFF for brains upgraded from older releases). Enable
> it on the host: `gbrain config set mcp.publish_skills true`. The core tools
> (search, query, get_page, put_page, think, find_experts) work regardless.
> `capture` is CLI-only, not an MCP tool — write over MCP with `put_page`.

## Remove

```bash
codex mcp remove gbrain
```

## Notes

- The token is a long-lived, full-access secret. Keep `GBRAIN_REMOTE_TOKEN` out of
  version control and prefer a scoped token if your host supports one.
- Local stdio also works if you run the brain on the same machine:
  `codex mcp add gbrain -- gbrain serve`.
