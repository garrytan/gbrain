## Source-config secret exposure (security item of the test-reduction plan)

A stored `webhook_secret` leaked through two surfaces. Both now route through `redactSourceConfig()`, and every surface that reads and serializes `sources.config` has a behavioral test that stores a secret-bearing config and asserts the secret never appears in output. Stored config is never mutated by the fix or the tests (each leak test asserts the stored secret is still intact).

### Leaks found and fixed

| Surface | How it leaked | Fix |
|---|---|---|
| `sources_add` op result, printed by `gbrain call sources_add` | Attaching a path to an existing path-less source (#3903 attach path) returned the full `SourceRow`, including the raw `config` with `webhook_secret` | `src/core/ops/sources.ts`: return `config: redactSourceConfig(parseSourceConfig(row.config))` |
| Managed `gbrain sources add <id> --path` (attach), its idempotent replay, and the `source_lifecycle` administration op | Outcome carried `config: {...source.config, ...input.config}`; the same outcome is persisted in `persistence_topology_changes` and replayed on retry | `src/core/persistence/source-lifecycle.ts`: outcome `config` goes through `redactSourceConfig()`, so neither the receipt nor the retained journal row holds the secret |

Behavior change on an intentional reveal: `sources webhook set` printed the new secret twice (config summary + GitHub paste block). The summary line now reads `webhook_secret: (shown once below)`, and the paste block still prints it once. `sources webhook rotate` already printed it once and is unchanged.

### Secret-bearing keys

`SECRET_KEYS` stays `{webhook_secret}`. Every other key the codebase reads is a pointer, not a credential: `gh_token_env` / `g_token_env` name env vars, `gh_app_pem_path` names a key file, `g_token_command` names a mint command, `g_account` is a vault pointer, and `remote_url` with embedded credentials is rejected by `parseRemoteUrl`. Recorded in the header of `scripts/check-source-config-leak.sh`.

### New tests and mutation evidence

Every test passes on the real code. Each row applied one targeted production mutation (scripted in `(scratch) src-secret/mutate.py`, restored after each run) and ran the named test with `-t`.

| # | Mutation (production code) | File | Test (`-t`) | Result under mutation |
|---|---|---|---|---|
| M1 | `sources list --json` emits `config` | `src/commands/sources.ts` | source-config-secret-surfaces "list, status" | 0 pass / 1 fail |
| M2 | `webhook show` prints the stored secret | `src/commands/sources.ts` | "list, status" | 0 pass / 1 fail |
| M3 | `sources status --json` spreads config | `src/commands/sources.ts` | "list, status" | 0 pass / 1 fail |
| M4 | `archived --json` lists raw config | `src/commands/sources.ts` | "list, status" | 0 pass / 1 fail |
| M5 | `remove --dry-run` echoes config | `src/commands/sources.ts` | "list, status" | 0 pass / 1 fail |
| M6 | re-wrapped-config warning interpolates config | `src/core/sources-load.ts` | "re-wrapped" | 0 pass / 1 fail |
| M7 | `webhook set` prints the secret twice (pre-fix output) | `src/commands/sources.ts` | "webhook set" | 0 pass / 1 fail |
| M8 | `webhook rotate` prints the secret twice | `src/commands/sources.ts` | "webhook rotate" | 0 pass / 1 fail |
| M8b | `webhook rotate` also prints the old secret | `src/commands/sources.ts` | "webhook rotate" | 0 pass / 1 fail |
| M9 | `sources_add` returns raw config (pre-fix) | `src/core/ops/sources.ts` | "gbrain call" | 0 pass / 1 fail |
| M10 | `listSources` (remote `sources_list`) returns config | `src/core/sources-ops.ts` | "remote MCP" | 0 pass / 1 fail |
| M11 | `getSourceStatus` (remote `sources_status`) returns config | `src/core/sources-ops.ts` | "remote MCP" | 0 pass / 1 fail |
| M12 | sync report (remote `get_status_snapshot`) returns config | `src/core/sync-status-report.ts` | "remote MCP" | 0 pass / 1 fail |
| M13 | remote `run_doctor` federation_health message echoes configs | `src/commands/doctor/checks/routing-federation.ts` | "doctor" | 0 pass / 1 fail |
| M13c | local `doctor --json` source_config_shape message echoes configs | `src/commands/doctor/checks/core-health.ts` | "doctor" | 0 pass / 1 fail |
| M14 | managed add receipt returns raw config (pre-fix) | `src/core/persistence/source-lifecycle.ts` | "managed" | 0 pass / 1 fail |
| M15 | backup metadata inventories raw source config | `src/core/backup/snapshot.ts` | agent-install-backup.serial "full backup" | 0 pass / 1 fail (manifest assertion) |
| M16 | restore reconnect lines / receipt echo detached config | `src/core/backup/quarantine.ts` | agent-install-backup.serial "full backup" | 0 pass / 1 fail (reconnect assertion) |
| M17 | `GET /admin/api/sources` returns raw rows | `src/commands/serve-http.ts` | e2e/serve-http-oauth "admin source access" | 0 pass / 1 fail |

Pre-fix run of the new file on unmodified master: 5 pass / 3 fail (webhook set printed 2 occurrences; `gbrain call sources_add` and the managed receipt returned the raw secret). Post-fix: 8 pass / 0 fail.

A first doctor mutation that edited `checkFederationHealth` survived because local doctor never runs that check (only `run_doctor` does). The test was extended to cover remote `run_doctor` too, and both doctor mutations (M13, M13c) now fail it.

### Audited surfaces with no leak (explicit field projections, now pinned)

`sources list/status/webhook show/current/archived/remove --dry-run` (human and `--json`), parse warnings, remote MCP `sources_list` / `sources_status` / `get_status_snapshot` / `run_doctor`, local `doctor --json`, admin API `GET /admin/api/sources`, backup metadata, restore reconnect lines and `restore-receipt.json`, and `.jsonl`/`.log` files under `GBRAIN_HOME` after managed administration. The MCP request log stores caller params, never results. Internal readers (sync, autopilot, resolver, destructive guard, webhook HMAC check, connectors, minion authority digest, company brain) only use config as a predicate.

Kept by contract: the full-database backup archive (`sensitive-full-database-state`) and the private 0600 restore inventory `.gbrain/restore-detached.json`, which intentionally retains detached source configs so the operator can reconnect them.

### Deleted tests

None. `src/core/source-config-redact.ts` is kept, and it is now imported by two runtime serializers, so the orphan-module test-only count dropped from 45 to 44 (the ceiling of 46 is unchanged).
