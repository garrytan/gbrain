# Secrets resolution via command-substitution

Status: shipping in v0.27.0.

## Problem

gbrain reads three API keys directly from `process.env`: `OPENAI_API_KEY` (embeddings + transcription fallback), `ANTHROPIC_API_KEY` (synthesize phase + query expansion + subagent loop), and `GROQ_API_KEY` (transcription default). For users who don't want to keep these in `~/.zshrc` or any other dotfile, the only workaround today is a wrapper script that exports the env at exec time — but the keys still land in `process.env` of the gbrain process and get inherited by every spawned child (shell jobs, the jobs-work daemon, future autopilot launchd units).

## Goal

Let users configure a shell command that gbrain runs at first-use to fetch each key. Examples:

- macOS Keychain: `security find-generic-password -a $USER -s gbrain-openai -w`
- Linux pass: `pass show gbrain/openai`
- 1Password CLI: `op read "op://Personal/openai/credential"`
- HashiCorp Vault, gpg, age — anything that prints the secret to stdout.

Resolved secrets land in module-private memory only. They never enter `process.env`, so they don't leak via `ps -E`, don't inherit into spawned children, and don't show in `gbrain config show`. Backwards compatible — env vars still work when no command is configured.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mechanism | Command-substitution config | Cross-platform; no new runtime deps. Works for Keychain, pass, 1Password CLI, Vault, gpg, age, etc. without gbrain needing to know about any of them. |
| Precedence | Command > env var | If you've configured a Keychain command, you want the secure path. Env stays as fallback. |
| Subprocess inheritance | None | Resolved values never written to `process.env`. Subprocess gbrain invocations re-resolve via their own config load. |
| Failure semantics | Throw loudly | A configured-but-broken resolver is a real misconfig (Keychain locked, item missing, ACL not granted). Silently falling back to env would mask the bug. |
| Caching | In-memory, process-lifetime | Each `gbrain` exec resolves once; restart to rotate. Keeps Keychain prompts to one per process. No on-disk cache of resolved values. |
| Coverage | OPENAI / ANTHROPIC / GROQ | Three keys actually used by gbrain today. DEEPGRAM is referenced by transcription but not yet a first-class secret — falls back to env-only until a follow-up minor. |

## Code shape

`src/core/secrets.ts` exports:

```ts
export type SecretName = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GROQ_API_KEY';

export function getSecret(name: SecretName): string | undefined;
export function clearSecretsCache(): void;          // test-only
export function resolveAllConfiguredSecrets(): SecretResolutionStatus[];  // for doctor
```

`getSecret(name)` resolution order:

1. Module-private cache hit → return.
2. `loadConfig().secrets[`${name.toLowerCase()}_command`]` set → run via `execSync` with 10s timeout, trim, cache, return.
3. `process.env[name]` set → cache and return.
4. Otherwise → return undefined.

A configured command that exits non-zero throws with exit code + stderr in the message. A command that resolves to empty stdout throws with the command in the message.

## Config schema

```jsonc
{
  "engine": "pglite",
  "database_path": "...",
  "secrets": {
    "openai_api_key_command": "security find-generic-password -a $USER -s gbrain-openai -w",
    "anthropic_api_key_command": "security find-generic-password -a $USER -s gbrain-anthropic -w",
    "groq_api_key_command": "pass show gbrain/groq"
  }
}
```

Three optional string fields under `secrets`. Resolved values never written back to the config object surfaced by `loadConfig()`, so `gbrain config show` displays only the *commands* (which point at the secrets store but are not themselves sensitive).

## Read-site changes

Nine `process.env.*_API_KEY` reads in `src/` (non-test) become `getSecret('*_API_KEY')`:

- `src/core/operations.ts:382` — `noEmbed` skip-check
- `src/core/transcription.ts` — provider auto-detect + per-provider key getter (2 sites)
- `src/core/cycle/patterns.ts:68` — pattern phase skip-check
- `src/core/cycle/synthesize.ts` — significance verdict + judge-client construction
- `src/core/search/hybrid.ts:116` — vector skip-check

Three SDK constructors get explicit `apiKey`:

- `src/core/embedding.ts:23` — `new OpenAI({ apiKey: getSecret('OPENAI_API_KEY') })`
- `src/core/cycle/synthesize.ts:347` — `new Anthropic({ apiKey })`
- `src/core/search/expansion.ts:28` — `new Anthropic({ apiKey: getSecret('ANTHROPIC_API_KEY') })`

`src/core/config.ts:99` keeps its existing `process.env.OPENAI_API_KEY` merge — it's the env→config-merge that surfaces the env var as a config field for callers reading `cfg.openai_api_key`. Removing it would create a circular dep (`loadConfig` → `getSecret` → `loadConfig`). Backwards-compatible behavior unchanged.

## Doctor check

`gbrain doctor` adds a `secret_resolution` filesystem check. For every configured `secrets.*_command`, it actually runs the command and reports:

- `ok` — all configured commands resolved (or no commands configured)
- `fail` — one or more commands failed; message includes which keys + the stderr from each

Resolved values are NEVER printed — only success/failure and stderr from failures.

## Verification on a real laptop

1. Store keys:
   ```
   security add-generic-password -a "$USER" -s "gbrain-openai" -w
   security add-generic-password -a "$USER" -s "gbrain-anthropic" -w
   ```
2. Edit `~/.gbrain/config.json` to add the `secrets:` section above.
3. Confirm env is empty:
   ```
   unset OPENAI_API_KEY ANTHROPIC_API_KEY
   gbrain doctor   # secret_resolution: ok (2 commands resolved)
   ```
4. End-to-end:
   ```
   gbrain sync ~/brain    # embeds; succeeds
   gbrain query "hello"   # vector search runs; succeeds
   ```
5. Confirm no env leak: while `gbrain serve` is running, `ps -E -p <pid> | grep -i api_key` returns nothing.

## Out of scope (filed as follow-ups)

- **Native Keychain via Node bindings** — adds a native dep with no portability win.
- **Per-secret TTL / rotation** — re-running command on each new gbrain process is fine.
- **DATABASE_URL secret resolution** — separate concern; postgres-only deployments; can land in a follow-up minor.
- **DEEPGRAM_API_KEY** — referenced by transcription but not yet wired into the resolver. Falls back to env-only until it joins the SecretName union.
- **Wrapper script for autopilot launchd plists** — once this lands, autopilot install can pre-warm the secrets cache from config; not strictly required since each `gbrain` exec re-resolves.
