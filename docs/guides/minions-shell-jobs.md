# Minions shell jobs — move deterministic crons off the gateway

## 30 seconds

```bash
# Run your first shell job:
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --params '{"cmd":"echo hello","cwd":"/tmp"}' --follow
# → exit_code: 0, stdout_tail: "hello\n", duration_ms: 43
```

That's it. Your cron scripts now have a home with retry, backoff, DLQ, and
`gbrain jobs list` visibility, without each one booting a full LLM session.

**PGLite users:** `gbrain jobs work` does not run on PGLite (exclusive file
lock). Every crontab invocation must use `--follow` for inline execution.
Postgres users can run a persistent worker; see recipes below.

---

## Why it exists

If your agent runs deterministic scripts from cron (token refresh, API fetch,
scrape + write), each one pays the cost of a full LLM session on the gateway.
Fourteen simultaneous fires on a Series A deployment pin CPU at 100% and block
live messages. None of those scripts need reasoning. They need a shell.

Shell jobs move them to the Minions worker: one deterministic-script execution
per cron, zero LLM tokens, unified visibility and retry.

---

## Security model (read this)

Shell exec is a large blast radius. We ship two independent gates, both must
pass:

1. **MCP boundary.** `submit_job` with `name: 'shell'` is rejected when
   `ctx.remote === true` (MCP callers). Independent of the env flag. Remote
   agents can never submit shell jobs. `MinionQueue.add('shell', ...)` has its
   own guard too, so an in-process handler can't programmatically bypass this.
2. **Env flag.** The worker only registers the shell handler when
   `GBRAIN_ALLOW_SHELL_JOBS=1` is set on the worker process. Default: off. Your
   agent opts in per-host.

**What the env allowlist does AND does not do.** Shell jobs run with a minimal
env: `PATH, HOME, USER, LANG, TZ, NODE_ENV`. Your secrets like `OPENAI_API_KEY`
and `DATABASE_URL` are NOT passed to the child. You opt-in additional keys per
job via `env: { ... }` (non-secret values only — see "Secrets" below) or via
`inherit: ["database_url"]` (recommended for secrets — names only in the row,
values resolved at child-spawn from `gbrain config set`). This stops accidental
`$OPENAI_API_KEY` interpolation in a user-authored script. It does **not**
sandbox filesystem reads: a shell script can `cat ~/.env` or any file the
worker process can read. The operator picks a safe `cwd`. That is the trust
boundary.

**Audit trail, not forensic insurance.** Every submission writes a JSONL line
to `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl` (ISO-week rotation; override
with `GBRAIN_AUDIT_DIR`). Failures log to stderr and don't block submission, so
a disk-full adversary could silently disable the trail. Good for "what did
this cron submit last Tuesday", not for security-critical forensics.

**The command text is logged as-is.** If you embed a secret in `cmd`
(`curl -H 'Authorization: Bearer ...'`), it shows up in the audit file. Put
secrets in `env:` instead.

---

## Migrate a cron

### Postgres worker (recommended)

On one terminal, start a persistent worker:

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work
```

Rewrite crontab to submit shell jobs (no `--follow`):

```cron
# Before (LLM gateway):
#   OpenClaw cron: x-garrytan-unified
# After (Minions worker):
3 13,16,19,22,1,4,7,10 * * * \
  gbrain jobs submit shell \
    --params '{"cmd":"node scripts/x-garrytan-daily.mjs","cwd":"/data/.openclaw/workspace"}' \
    --max-attempts 3 --timeout-ms 300000
```

Worker claims the job on next poll, runs it, records `exit_code` +
`stdout_tail` + `stderr_tail` in the result. Failures retry per
`--max-attempts` with exponential backoff.

### PGLite (inline execution)

PGLite doesn't support the persistent worker daemon. Every crontab invocation
uses `--follow` to run inline:

```cron
# Each cron tick spawns a short-lived worker that runs the job inline.
3 13,16,19,22,1,4,7,10 * * * \
  GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
    --params '{"cmd":"node scripts/x-garrytan-daily.mjs","cwd":"/data/.openclaw/workspace"}' \
    --follow --timeout-ms 300000
```

Note: `--follow` blocks the crontab slot until the job finishes. If 14 shell
crons land at the same minute and each takes 30s, they serialize through
crontab's spawning limits. Postgres + persistent worker scales better.

### Calling `gbrain` itself from a shell job — use `inherit:` for DATABASE_URL {#secrets}

A common pattern is submitting shell jobs that run `gbrain` CLI commands:

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}'
```

`inherit: ["database_url"]` tells the worker to look up `database_url` from its
own `loadConfig()` (file + env merged) and inject the value into the child's
env as `GBRAIN_DATABASE_URL`. The job row in `minion_jobs.data` stores
`inherit: ["database_url"]` — **names only, never values**. The shell-audit
JSONL records the same. Pre-enqueue validation rejects the submission if the
worker can't resolve the requested key, with a paste-ready
`gbrain config set database_url <value>` hint.

**Why not just write the URL into `env:` directly?** Pre-v0.36.5.0 callers
wrote things like:

```jsonc
// ❌ Deprecated as of v0.36.5.0 — REJECTED at submit time.
{
  "cmd": "gbrain stats",
  "cwd": "/data/gbrain",
  "env": { "GBRAIN_DATABASE_URL": "postgresql://..." }
}
```

This planted plaintext secrets in `minion_jobs.data` (DB row) and in the
shell-audit JSONL. Anyone with read access to the brain DB (or a brain dump,
or a shared brain via the mounts feature) saw the URL. v0.36.5.0 doesn't
forbid that pattern — the validator trusts the agent — but **prefer
`inherit:`** for any secret you want kept out of the row. Names land in the
row; values resolve at child-spawn from the worker's config.

**Scope:** v0.36.5.0 `inherit:` is **free-form**. Pass any snake_case
config-key name and the worker resolves the value from `loadConfig()` at
child-spawn time:

- `inherit: ["database_url"]` → child env `GBRAIN_DATABASE_URL`
- `inherit: ["anthropic_api_key"]` → child env `ANTHROPIC_API_KEY`
- `inherit: ["openai_api_key"]` → child env `OPENAI_API_KEY`
- `inherit: ["voyage_api_key"]` → child env `VOYAGE_API_KEY`
- `inherit: ["groq_api_key", "zeroentropy_api_key"]` → both injected
- Or any arbitrary config-key your worker has (`my_custom_field` →
  `MY_CUSTOM_FIELD`)

The env-key name is derived by uppercasing the config-key name. The one
override is `database_url` → `GBRAIN_DATABASE_URL` (plain `DATABASE_URL` is
ambiguous in most Postgres-app contexts).

Pre-enqueue validation fail-fasts if the worker can't resolve a requested
name. The validator does NOT police which secrets you choose to inherit —
the agent submitting the minion is in the same uid as the worker, so it's
your call.

**Output-side leakage (read this).** The `inherit:` allowlist prevents
secrets from landing in the JOB ROW INPUT fields (`data.cmd`, `data.argv`,
`data.env`). By default it does NOT scrub the OUTPUT fields — if your
script prints the secret to stdout or stderr (`echo "$GBRAIN_DATABASE_URL"`,
`psql "$GBRAIN_DATABASE_URL"` echoing the URL on error), the value lands
plaintext in `result.stdout_tail` / `result.stderr_tail` / `error_text`,
and from there into the brain DB row.

**`redact_secrets: true` opts into output-side scrubbing.** Set it per-job
(or pass `--redact-secrets` on the CLI):

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"],
  "redact_secrets": true
}'

# Or, equivalently:
gbrain jobs submit shell \
  --params '{"cmd":"gbrain sync --skip-failed","cwd":"/data/gbrain","inherit":["database_url"]}' \
  --redact-secrets
```

When `redact_secrets: true`, the worker resolves each name in `inherit:` to
a value, runs the child, then string-replaces every occurrence of those
values in `stdout_tail` / `stderr_tail` (and in the `error_text` derived from
`stderr_tail` on non-zero exit) with `<REDACTED:name>` before persistence.
Only `inherit:`-resolved values are scrubbed; caller-supplied `env:` values
are not (those are the "I'm fine with this in the row" channel by design).

**Heuristic, not perfect.** The redactor uses literal string-replace. A
script that base64-encodes the secret before printing, or that emits it
one character at a time, will bypass the scrub. Those are adversarial
shapes — the agent + the script are in the same trust domain, so this
layer defends against accidental echo (the common case), not deliberate
exfiltration.

**Three rules for shell-job authors who deal with secrets:**

- **Prefer not to echo secrets at all.** Even with `redact_secrets`, less
  output means less risk if the redactor ever has an edge-case miss.
- **Wrap noisy CLI tools to suppress URLs on error.** `psql --quiet`,
  `pg_dump --quiet`, or pipe through
  `2>&1 | sed 's|postgresql://[^@]*@|postgresql://REDACTED@|g'`.
- **Inspect with `gbrain jobs get <id>` after a failure** to verify what
  actually persisted.

### Submitting with `argv` (no shell interpolation)

For programmatic callers assembling commands from JSON, use `argv` instead of
`cmd`. No shell, no injection surface:

```bash
gbrain jobs submit shell \
  --params '{"argv":["node","scripts/fetch.mjs","--date","2026-04-19"],"cwd":"/data"}' \
  --follow
```

---

## Debug a failed job

```bash
# List dead shell jobs
gbrain jobs list --status dead

# Inspect one
gbrain jobs get 42
# → error_text, stacktrace, result.stdout_tail, result.stderr_tail

# Submission audit log (operator trail, not forensic)
cat ~/.gbrain/audit/shell-jobs-*.jsonl | jq '.'

# First-time failure mode: submitted without env flag on the worker
gbrain jobs list --status waiting --name shell
# If rows pile up here, no worker with GBRAIN_ALLOW_SHELL_JOBS=1 is running.
```

---

## Limitations

- **Filesystem reads are not sandboxed.** See "Security model" above. Don't
  point `cwd` at a directory full of secrets.
- **Audit log is advisory.** Disk-full or EACCES silently disables it.
- **Cancel latency is lock-renewal-bounded** (~7-15 s by default). A cancelled
  child keeps running until the next lock-renewal tick fails.
- **`--follow` claim order** is by priority/created_at. If another job is
  waiting in the same queue at the time of `--follow`, that one runs first.
- **`cwd` symlink TOCTOU.** The absolute-path check doesn't guard against
  symlinks pointing elsewhere at execution time. Operator-scope concern.

---

## Errors {#errors}

| Error | What it means | Fix |
|---|---|---|
| `shell: specify exactly one of cmd or argv` | `cmd` and `argv` are mutually exclusive. Both absent is also invalid. | Choose one. `cmd` for shell-interpolated strings; `argv` for structured args. |
| `shell: cwd is required and must be an absolute path` | `cwd` must be a string starting with `/`. | Set `cwd` in `--params` to an absolute path. |
| `shell: argv must be an array of strings` | `argv` has a non-string entry or isn't an array. | Pass `argv: ["bin","arg1","arg2"]`. |
| `shell: env values must all be strings` | `env` has a number/bool/object value. | Stringify: `"env":{"COUNT":"3"}` not `"env":{"COUNT":3}`. |
| `shell: inherit must be an array of config-key names` | `inherit` wasn't an array. | Pass `"inherit": ["database_url", ...]`. |
| `shell: inherit entries must be non-empty strings` | An element of `inherit` was empty, non-string, or null. | Use snake_case config-key names like `database_url`, `anthropic_api_key`. |
| `shell: inherit name "<X>" must match [a-z][a-z0-9_]*` | Name failed snake_case regex (uppercase, leading digit/underscore, special char). | Use the config-key name verbatim — `database_url`, not `DATABASE_URL`. |
| `shell: inherit requested "<X>" but worker has no <X> configured` | Worker can't resolve the requested name from `loadConfig()`. | Run `gbrain config set <X> <value>` on the worker host, OR check the config file at `~/.gbrain/config.json`. |
| `shell: redact_secrets must be a boolean if set` | Caller passed a non-boolean for `redact_secrets`. | Pass `true` or `false` (or omit). The CLI `--redact-secrets` flag sets it automatically. |
| `permission_denied: shell jobs cannot be submitted over MCP` | An MCP client tried to submit a shell job. By design CLI-only. | Submit from CLI or via a trusted operation handler (`ctx.remote === false`). |
| `protected job name 'shell' requires CLI or operation-local submitter` | A caller invoked `MinionQueue.add('shell', ...)` without the `trusted` opt-in. | Pass `{ allowProtectedSubmit: true }` as the 4th arg. CLI and `submit_job` do this automatically. |
| `aborted: timeout` / `aborted: cancel` / `aborted: shutdown` / `aborted: lock-lost` | The worker's abort signal fired mid-execution. Child got SIGTERM, 5s grace, then SIGKILL. | Expected: timeout / user cancel / deploy restart / stall. Inspect `gbrain jobs get` to see which. |
| `exit N: <stderr_tail_500>` | Script exited non-zero. | Read `stderr_tail` in `gbrain jobs get`. |
