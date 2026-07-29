# codex-cli — GPT chat via the Codex CLI OAuth subscription

The `codex-cli` recipe routes `gateway.chat` / `gateway.toolLoop` through the
local `codex` CLI's ChatGPT OAuth session, so a ChatGPT Plus/Pro subscription
covers the calls instead of per-token `OPENAI_API_KEY` billing. It is the GPT
sibling of the `claude-cli` recipe.

```bash
gbrain config set chat_model codex-cli:gpt-5.6-terra
# or behind claude-cli in a fallback chain:
gbrain config set chat_fallback_chain '["codex-cli:gpt-5.6-terra"]'
```

`codex-cli:gpt-5.6-terra` (subscription) sits alongside `openai:gpt-5.6`
(API key, per-token billing) the same way `claude-cli:*` sits alongside
`anthropic:*`. Token usage is not reported on the CLI's output channel, so
usage fields are undefined and the budget ledger treats these calls as
nominal.

`GBRAIN_CODEX_CLI_BIN` overrides the binary path if `codex` is not on `PATH`.

## Host requirements

### CLI version

Needs a `codex` new enough to have `--ignore-user-config` and the
`gpt-5.6-terra` / `gpt-5.6-sol` model ids — 0.145.0 or later. Older builds
fail in confusing ways: the Ubuntu snap's stable channel lagged at 0.114.0,
whose default `gpt-5.3-codex` is not available under ChatGPT-account auth at
all (`{"detail":"The 'gpt-5.3-codex' model is not supported when using Codex
with a ChatGPT account."}`). `sudo snap refresh codex` if you are on the snap.

### Sandbox-confined installs (snap) — set TMPDIR

Each call spawns `codex exec` from a dedicated scratch directory, passed as
both `-C` (so `AGENTS.md` auto-discovery finds no local files) and the parent
of the `-o` output file. The child must therefore be able to open that
directory.

The default location is under `os.tmpdir()`, which a sandbox-confined `codex`
cannot reach: snap's `home` interface permits only **non-hidden** paths under
`$HOME`, so nothing in `/tmp` is accessible. The failure surfaces as a bare
errno that names neither the path nor the cause:

```
codex-cli exited 1: Error: No such file or directory (os error 2)
```

Point `TMPDIR` at a non-hidden directory inside `$HOME`:

```bash
export TMPDIR="$HOME/gbrain-tmp"
```

A hidden directory (`~/.gbrain/tmp`) does **not** work under snap
confinement — the `home` interface excludes dotfiles. This is also why the
adapter cannot simply default to a dotdir in `$HOME`.

### Minimal Docker images — install ca-certificates

`codex` is a separate Rust process that trusts the OS certificate store,
unlike Bun's `fetch` which bundles its own roots. Base images that ship no
trust store at all (e.g. `oven/bun:1`) make every `chatgpt.com` /
`api.openai.com` call fail with:

```
invalid peer certificate: UnknownIssuer
```

Add the trust store to the image:

```dockerfile
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
```

(`apk add --no-cache ca-certificates` on Alpine/musl.)

## Isolation notes

The subprocess is deliberately kept close to a raw LLM rather than a full
Codex agent:

- `--ignore-user-config` stops `~/.codex/config.toml` from loading, so user
  MCP servers stay out — including gbrain's own MCP, which would otherwise
  recurse and contend for the PGLite single-writer lock. Auth state
  (`auth.json`) still loads.
- `--sandbox read-only` pins the agent sandbox down for defense in depth.
- `--skip-git-repo-check` skips the repo probe in the scratch cwd.
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` are scrubbed from the child env, so an
  inherited key cannot silently flip billing back to per-token API usage.
- Codex has no `--system-prompt` flag, so system messages render as a leading
  `## System` section of the stdin prompt. The prompt goes over stdin because
  argv has a hard size ceiling that subagent prompts routinely exceed.

Tool use rides the same prompt-instructed
`<use_tools>[{id,name,input}]</use_tools>` protocol the `claude-cli` provider
teaches.
