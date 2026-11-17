# CLI contract map

Reference: gbrain `master` at `8bbfd0b5e8` (VERSION `0.60.733.0`). Every file:line below is in that commit. The agent-facing CLI contract the Rust port must keep is the command names, flags, `--json` output, stdout/stderr split and exit codes.

The CI-enforced list of public names is `docs/contracts/public-surface.json` in gbrain: 220 `cli-command`, 613 `cli-flag`, 707 `exit-code`, 503 `config-key`. Flattened copies are in [data/](data/) (`cli-commands-and-flags.txt`, `exit-codes.txt`, `config-keys.txt`, `ops-summary.tsv`). Regenerate them with `bun docs/research/rust-engine/scripts/dump-contract-data.ts <gbrain-checkout> docs/research/rust-engine/data`.

How the 220 commands split:

| Kind | Where defined | Count | Covered in |
|---|---|---|---|
| Op-backed commands (generated from an operation's `cliHints`) | `src/core/ops/*.ts` -> `src/core/operation-manifest.generated.ts` | 85 visible names + 3 aliases (115 ops have a CLI name; 30 are hidden) | Part A |
| CLI-only commands (command table) | `src/cli/command-table.ts` + `src/cli/commands/*.ts` (+ `src/commands/*.ts`) | 132 records | Part B |
| Usage class (agent-core / occasional / admin / setup / dev / hidden) for all 220 | gbrain `skills/`, MCP instructions, gbrain-evals call sites | 220 rows | Part C |

Nine names are both an op and a CLI-only command (`capture`, `advisor`, `sync`, `orphans`, `think`, `salience`, `anomalies`, `transcripts`, `whoknows`). At the top level the CLI-only command wins (`src/cli/main.ts:525`). Every op, hidden or not, is also reachable as `gbrain call <op> '<json>'`.

Evidence limits: the CLI was not executed. gbrain needs Bun >= 1.4.4 and the research host had 1.3.14, so `src/core/bun-floor.ts` refuses to start. All JSON examples come from tests, golden fixtures (`test/fixtures/agent-contract/`, `test/fixtures/goldens/cli/`) and code literals. Handler-free modules (manifest, tool-defs, surfaces) were imported directly with Bun to produce [data/](data/).

Contents:

- Part A. Op-backed commands and the shared CLI machinery: dispatch, argv parsing from `ParamDef`, global flags, agent contract v1 (`--json` documents, notices, error envelope), exit codes, the full op-command table, and detailed JSON examples for the agent-critical commands.
- Part B. CLI-only commands: dispatch phases, thin-client modes, flag validation, help, the full 132-record table by category, detailed sections for `init`, `import`, `sync`, `export`, `embed`, `extract`, `serve`, `doctor`, `status`, `jobs`, `eval`, `config`, `sources`, `capture`, `dream`, `upgrade`, `frontmatter`, `agent`, and portability risks.
- Part C. Which commands agents and evals use.

# Part A. Op-backed commands and the shared CLI machinery

Scope: the commands generated from operations (`cliHints.name` / aliases), plus the generic dispatch, argv parsing, output rendering, agent contract v1 and exit-code machinery they run on. CLI_ONLY command-table commands are out of scope here (other research part), except where they shadow an op name (section 0).

Source: gbrain (`github.com/garrytan/gbrain`) at `8bbfd0b5e8`. Every file:line below was read in that checkout. Nothing in the repo was modified.

Evidence caveat: the CLI could not be executed on this host. `package.json` requires Bun `>=1.4.4` and `src/core/bun-floor.ts` refuses to run on the installed 1.3.14 (`GBrain requires Bun 1.4.4 or newer (found Bun 1.3.14)`). All JSON examples below come from tests, from code literals, or from read-only Bun scripts that imported the handler-free manifest and command table (`local scratch scripts, not committed`, outside the repo). No live `--json` capture was done.

---

### 0. Summary and key numbers

| Item | Count / fact | Evidence |
|---|---|---|
| Operations in manifest | 204 | `operation-manifest.generated.ts`, ops-summary.tsv |
| Ops with a CLI name (`cliHints.name`) | 115 | dumped via `OPERATION_MANIFEST` |
| CLI name, visible (`cliOps` map) | 85 | `src/cli/op-manifest.ts:13-17` (hidden excluded) |
| CLI alias entries (`cliAliases`) | 3: `link-add`->`add_link`, `link-rm`->`remove_link`, `get_links`->`get_links` | `buildCliAliases`, `src/cli/flag-validation.ts:22-43` |
| Hidden ops with a CLI name | 30 | `cliHints.hidden` |
| Of those, also a CLI_ONLY table name (shadowed) | 9: `capture`, `advisor`, `sync`, `orphans`, `think`, `salience`, `anomalies`, `transcripts`, `whoknows` | CLI_ONLY wins: `src/cli/main.ts:525` runs before `runSharedOperation` (`main.ts:530`) |
| Hidden, not shadowed, not an alias | 21 | top-level dispatch -> `unknown_command` (`main.ts:546`); reachable only via `gbrain call` (section 1.4) or a CLI_ONLY router (e.g. `purge-deleted` via `src/commands/pages.ts`) |
| Ops with no CLI name at all | 89 | MCP-only; reachable via `gbrain call <op>` |
| Op CLI rows flagged `mutating` | 41 of 115 | manifest `mutating` |
| Op CLI rows flagged `localOnly` (thin client refuses) | 17 | `localOnly` (`main.ts:600-604`) |
| Op CLI rows flagged `cliOnly` (not an MCP tool) | 15 | `cliOnly` in ops-summary.tsv |
| Visible ops that the CLI lists by a different name than the op | e.g. `get`->`get_page`, `put`->`put_page`, `list`->`list_pages`, `tags`->`get_tags`, `links`->`get_links`, `backlinks`->`get_backlinks`, `timeline`->`get_timeline`, `stats`->`get_stats`, `find`->`find_pages`, `history`->`get_versions`, `link`->`add_link`, `unlink`->`remove_link`, `tag`->`add_tag`, `untag`->`remove_tag`, `delete`->`delete_page` | `cliHints.name` vs `op.name` |

Exit-code registry: 707 codes; 658 of them exit 1 (section 5).

---

### 1. How the generic op-to-CLI mapping works

#### 1.1 Entry and dispatch order

1. `src/cli.ts:80` installs the stdout interposer with `agentJsonGuardMode(argv)` only when `shouldForceExitAfterMain()` is true. The engine-free fast paths (`--version`, bare `gbrain`, `--help`) answer before the dispatcher is imported (`src/cli.ts` header; `cliFastPath`). `exitOnUnsupportedBun` runs first (`src/cli.ts`, `src/core/runtime-version.ts:64`).
2. `main()` (`src/cli/main.ts:289`):
   1. `runCliPreflight()` then `parseGlobalFlags(rawArgs)` (`main.ts:297-300`).
   2. `command = args[0]`; `--version`/`--help` short-circuit.
   3. `if (command === 'ask') command = 'query'` (DX alias, `main.ts:357`).
   4. `routeCommand(command, args.slice(1))` (`src/cli/command-route.ts:14-20`): `search --exact` -> `search-exact`, and `skills index|resolve|library|pin` -> `skill-resolver`. The `--exact` token is removed from subArgs. A `--exact` after a bare `--` routes nothing.
   5. Help: `cliHelpRequested` (`main.ts:332`) then `printRouterHelp` / `printCuratedHelp`, then `printOpHelp(op, command)` for an op (`main.ts` ~ lines 386-395; `printOpHelp` at `main.ts:2817`).
   6. `strictArgsRefusal` (`main.ts:416`) for destructive subcommands.
   7. **Unknown-flag gate**: `validateCommandFlags(command, subArgs)` (`main.ts:492`, `src/cli/flag-validation.ts:77`) runs before any engine. Refusal is `unknown_flag`, exit 2, with a did-you-mean from `CLI_FLAG_REGISTRY` (`src/cli/main.ts` ~ lines 493-505; `unknownFlagError` at `src/cli/cli-error.ts:137`).
   8. `if (CLI_ONLY.has(command))` -> `handleCliOnly` (`main.ts:525`). Shadowed names stop here.
   9. Otherwise `runSharedOperation(command, subArgs, cliOpts)` (`main.ts:530`, body at `main.ts:542`).

`OPERATION_MANIFEST` (`src/core/operation-manifest.generated.ts`) is handler-free. The dispatcher builds `cliOps` and `cliAliases` from it (`src/cli/op-manifest.ts:13-17`, `src/cli/flag-validation.ts:43`). The handler module (`src/core/operations.ts`) is loaded only inside `runSharedOperation` via `loadOperation` (`main.ts:546-548`).

#### 1.2 `runSharedOperation` (src/cli/main.ts:542-785), in order

| Step | Lines | What happens |
|---|---|---|
| Resolve | 545-548 | `cliOps.get(command) ?? cliAliases.get(command)`; unknown -> `unknown_command` (exit 2). `loadOperation(meta.name)`. |
| `put --file` | 554 | `runPutFile` (`src/cli/commands/append.ts`) runs first when a `--file` token is present. |
| Parse | 555 | `parseOpArgs(op, subArgs)` (section 2). |
| stdin fill | 557-558 | `applyStdinParam` (`main.ts:1205`). Only when the op's `cliHints.stdin` param is missing and `stdin` is not a TTY. |
| `query --image` | 560-572 | Path -> base64 + mime via `resolveQueryImage`. |
| Required params | 574-592 | Each `def.required` param missing -> `usageError` "Missing required parameter 'x' for 'gbrain <cli>'" (exit 2). |
| Thin client | 600-621 | `isThinClient(cfg)` = `!!config.remote_mcp` (`src/core/config.ts:602`). `localOnly` -> `refuseThinClient`. `--brain` refused. `--source` mapped to wire `source_id` (`applyThinClientSourceScope`, `main.ts:1266`). Then `runThinClientRouted` (`main.ts:809`). |
| Source-scope guard | 624-626 | `assertSingleSourceScopeFlag` (local path). |
| Live owner socket | 636-639 | `runDelegatedCliOperation` (`src/commands/persistence-delegate.ts:55`) -> `maybeDelegateLocalOperation` (`src/core/persistence/local-client.ts:148`). If a PGLite lock holder answers on its socket the op is delegated; otherwise falls through. Skipped with `--as`, or for an enforced member. |
| Connect | 642 | `connectEngine({ oneShotRead: op.scope === 'read' })` (`main.ts:2705`). |
| Context | ~ 675-690 | `makeContext(engine, params, op)` (`main.ts:1360`) under a wallclock timeout. |
| Handler | 660-725 | Read scope: `READ_OP_TIMEOUT_MS = 180_000` (`main.ts:662`); on timeout prints `<label> timed out (default 180000ms; pass --timeout=Ns to override).` and sets exit 124 (`main.ts:681`). Writes and admin are unbounded. |
| Normalize | 747 | `applyCliOpNotices(normalizeLocalResult(rawResult), params.json === true, ...)` (`normalizeLocalResult` = JSON round trip, `main.ts:118-120`). |
| Render | 753-757 | `formatResult(op.name, result, params)` (`main.ts:1538`) then `writeStdoutFinal(output)`. |
| Notices | 758 | `process.stderr.write(noticeText)` when present. |
| In-band failure | 759 | `reportInBandFailure(result, command)` (`src/cli/cli-error.ts:205`): `status:'error'` -> stderr line + exit 1. |
| Errors | catch / finally | Error -> `writeCliError(e, command)` and the verdict is set (`main.ts` ~ 765-776). `finishCliTeardown` runs in `finally`. The exit happens once in `runCli` (`main.ts:2857`). |

#### 1.3 Thin-client routing (`runThinClientRouted`, src/cli/main.ts:809-945)

- Calls `callRemoteTool(cfg, op.name, params, { timeoutMs, signal, writeWaitMs })`. The MCP tool name is the **op name** (`get_page`), not the CLI name (`get`).
- Timeout default: 180 s for `think`, 30 s otherwise (`main.ts:817`); `--timeout` overrides.
- SIGINT is wired to an AbortController (exit 130).
- Identity banner `[thin-client -> host · brain: N pages ... · vX]` on stderr (`main.ts:948-995`). Suppressed when `--quiet`, when stderr is not a TTY and `GBRAIN_BANNER !== '1'`, or with `GBRAIN_NO_BANNER=1` (`bannerSuppressed`, `main.ts:976`).
- Non-tool remote errors (`RemoteMcpError`): transport failures print human text on stderr and exit with `failExit` (1 for human output; under `--json` the mapped code exit). An aborted request exits 130 (`main.ts` ~ lines 890-933). Under `--json` `writeCliError(e, ..., { stderr: false })` writes the envelope on stdout (`main.ts` ~880-935). `tool_error` renders the server's own code and exit (`exitCliError`).
- The routed result is passed through `unpackToolResult`, `withRoutedDegradedStamp`, `hintAmbientNarrowing`, then the same `formatResult` as the local path (`main.ts:~852-870`).

#### 1.4 `gbrain call <tool> '<json>'` (src/commands/call.ts:36)

The generic escape hatch for **any** op name, including hidden and no-CLI-name ops:

- `--source <id>` is parsed anywhere in args (`call.ts:41-58`). Usage: `gbrain call [--source <id>] <tool> '<json>'`.
- Params must be a JSON object, else `Tool parameters must be a JSON object.`
- Tries the persistence delegate first (`maybeDelegateLocalOperation`, `call.ts:81`).
- Otherwise `handleToolCall(connected, tool, params, ...)` from `src/mcp/server.ts`: the same handler MCP uses.
- Output is always `JSON.stringify(result, bigintToStringReplacer, 2) + '\n'` (`call.ts:107`). Failure is the v1 envelope on stdout via `failCall` (`call.ts:~118-124`) and exit `exitCodeForCode(envelope.code, reason)`.
- `call` is in `EXPLAIN_CLAIMING_COMMANDS` (`src/core/cli-options.ts:146`), so `--explain` is claimed globally.

#### 1.5 Global flags (src/core/cli-options.ts, `parseGlobalFlags` at line 160)

`parseGlobalFlags` walks **all** of argv, not just the leading tokens (`cli-options.ts:176`). It builds a slot list and resolves ownership by the command word (the first plain token). Owned flags are handed back to the command in its own spelling.

| Flag | Behavior | Where |
|---|---|---|
| `--quiet` | `cliOpts.quiet = true` | `cli-options.ts:177-180` |
| `--progress-json` | progress mode json | `:181-184` |
| `--progress-interval <ms>` / `=<ms>` | progress tick | `:185-203` |
| `--timeout <v>` / `--timeout=<v>` | Claimed globally (`parseTimeout`, `:390`: plain ms, `s`, `m`, fractional) unless the command owns it: `sync`, `remote` (`TIMEOUT_OWNING_COMMANDS`, `:129`) | `:204-222`, slots resolved `:320-340` |
| `--timings` | Claimed by `query`/`search`/`ask` (`TIMINGS_CLAIMING_COMMANDS`, `:149`); otherwise passed through | `:234-236` |
| `--explain` | Claimed by `query`, `search`, `ask`, `call` (`EXPLAIN_CLAIMING_COMMANDS`, `:146`); otherwise passed through in place | `:228-235`, deferred-explain logic `:307-322` |
| `--brain <id>` / `--brain=<id>` | Must match `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` (`BRAIN_ID_RE`, `:~90`); a missing or bad value **throws** (`parseBrainValue`, `:95-107`) | `:238-250` |
| `--wait <seconds>` | Global write wait, 0 to 600, no units (`parseWaitSeconds`, `:77-89`, error `invalid_params`). Passed through for `sources writer movement` (`WAIT_OWNING_ROUTES`, `:158`) | `:254-262` |
| `--as <member>` | Preview reads as a member (GBRA-218). `access` owns its own `--as`. | `:264-272` |
| `--room [list]` | GBRA-498 room marks; bare `--room` = `''` | `:273-279` |
| `--accept-pending` / `--no-accept-pending` | Sets `acceptPending` (#5232) | `:281-283` |

Not global: `--source`, `--json`, `--dry-run`, `--help`, `--file`, `--image`, `--explain` on non-claiming ops. `--source` and `--json` are per-op flags; `json` and `dry_run` are CLI-local booleans that never reach the wire (see 2.4).

Quirk: because `parseGlobalFlags` does not stop at `--`, a global flag after `--` is still consumed (`cli-options.ts:176` loop has no `--` check). Contrast `parseOpArgs`, which does stop (`main.ts:1091`). See section 7.

#### 1.6 Source and brain resolution

- **Brain** (which database): `--brain` (global) -> `resolveBrainId` (`src/core/brain-resolver.ts`) over the ambient tiers `GBRAIN_BRAIN_ID` / `.gbrain-mount` / mount path / `host`. A thin client refuses `--brain` (`THIN_CLIENT_BRAIN_FLAG_MESSAGE`, `main.ts:1831`).
- **Source** (which `source_id` inside the brain): `makeContext` (`main.ts:1360`) calls `resolveSourceWithTier(engine, explicit)` (`src/core/source-resolver.ts`). Tiers are `flag` (`--source`), `env` (`GBRAIN_SOURCE`), `dotfile` (`.gbrain-source`), `local_path` (path match), `brain_default` (`sources.default`), and a final `'default'`. `call.ts` documents the same order (`call.ts:32`). `localFederatedSourceIds` widens an unqualified search-shaped read to federated sources when the tier is non-explicit (#2561, `main.ts:1386`).
- An op that **owns** `source` (`opOwnsSource`) receives it as its own param instead of routing scope (`main.ts:1377`).
- `source_id` / `source_ids` / `all_sources` are op params on most read ops (see section 4). `assertSingleSourceScopeFlag` refuses mixing the CLI `--source` with an op's own scope flag locally (`main.ts:624-626`).

#### 1.7 Persistence delegation and the warm CLI socket

- **Live PGLite owner** (`maybeDelegateLocalOperation`, `src/core/persistence/local-client.ts:148-160`): only for `pglite` brains with `database_path` and no `database_url`, and only when `inspectLockHolder` says the lock is held. If the holder answers on its owner socket, the op runs there. Once an owner is observed, every failure is final (no silent local fallback, per the comment at `local-client.ts:136-141`). Mutations get a `request_id` (`parseWriteRequestId` / `randomUUID`, `:155-157`).
- **Warm CLI socket** (`src/cli/cli-socket-client.ts:243`, `maybeServeFromCliSocket`): only for `CLI_SOCKET_COMMANDS = ['search','query','get','recall']` (`src/cli/cli-socket-client.ts:27`) and only for a local **postgres** brain, `host` brain, no `--explain`, no `--as`, no `--room` (`main.ts:519` gate). Socket path `$GBRAIN_HOME/.gbrain/run/`. `GBRAIN_CLI_SOCKET=0` disables it. A stale or refusing socket returns false and the cold path runs.
- **Enforced member** (`GBRAIN_ENFORCED_MEMBER`): `enforcedGate` runs first (`main.ts:317-323`). It decides allow/refuse per op via `src/cli/enforced-member-classes.ts`, and reads/writes are checked against the member (`main.ts` ~670-712).

#### 1.8 Output routing summary

| Mode | Where the single document goes | Notices | Errors |
|---|---|---|---|
| Human (default) | stdout: `formatResult` text | stderr (`[AGENT]` blocks when not a TTY; `Note [code]:` lines on a TTY) | stderr `Error [code]: ...`, `Fix:`, `Why:`, `Docs:` |
| `--json` | stdout: one document (`formatResult` JSON, 2-space indent) | object results get a `notices` key; array results send notices to stderr | stdout: one envelope (2-space indent); stderr: the human `Error [code]` lines |

Details in sections 2.5 and 3.

---

### 2. Argv parsing from `ParamDef` (`parseOpArgs`, src/cli/main.ts:1082-1180)

#### 2.1 Shape

Every op param is `op.params[name]` (`ParamDef`, `src/core/ops/contract.ts`). The CLI reads these fields from the manifest: `type` (string, number, integer, boolean, object, array), `required`, `enum`, `default`, `items`, `cliKeyValue`, `cliRange`, and `op.cliHints` (`name`, `positional[]`, `stdin`, `hidden`, `aliases`). A dump of the 115 CLI-backed ops is in section 4.

#### 2.2 Tokens

| Token | Rule | Lines |
|---|---|---|
| `--` | Ends options once. Later tokens are positionals even if they start with `--`. | `main.ts:1091` |
| `--key=value` | Splits on the first `=`, key `-` -> `_`. `json` and `dry_run` are booleans (`json=false` parses false). Known param: typed value. | `:1093-1110` |
| `--no-<flag>` | If `<flag>` is a boolean param, sets it to `false`. | `:1114-1120` |
| `--flag` (boolean) | Sets `true`. A following literal `true`/`false` is consumed as its value (#4602). Any other next token stays positional. | `:1122-1133` |
| `--json`, `--dry-run` | CLI-local booleans, same literal rule (`:1134-1143`). Not on the wire. | `:1134-1143` |
| `--flag value` (non-boolean) | Consumes the next token. If the next token is a **known flag of this op**, it is refused as "requires a value" (#5700, exit 2). | `:1144-1150` |
| bare token | Assigned to the next unfilled positional (`cliHints.positional`). | `:1170-1172` |
| excess bare token | **No branch.** The `else if (posIdx < positional.length)` has no `else`, so a surplus positional is dropped silently. | `:1170` |

Key naming: flags are kebab (`--expected-revision`), params are snake (`expected_revision`). The conversion is `replace(/-/g,'_')` on parse (`:1122`) and `replace(/_/g,'-')` for display (`printOpHelp`, `main.ts:2817-2838`).

#### 2.3 Value coercion (`src/cli/op-param-values.ts`)

- `opParamValue` (`:14-27`): `number`/`integer` must be finite (integer: `Number.isInteger`), else `usageError` "--x must be a number; got 'v'" (exit 2). String with `enum`: must be in the enum, else "must be one of: a, b, c" (exit 2). Other types pass through as raw strings.
- `opFlagValue` (`:33-35`): a `cliKeyValue` param collects repeats into a list.
- `opStructuredValue` (`:43-80`), applied to every param after the loop (`main.ts:1177-1179`):
  - `cliKeyValue` (`--where k=v`, `--where stage=seed,series-a`): builds an object. Repeated keys merge into arrays. `k=a,b` is a list. Missing `=` -> usage error. A single JSON object literal passes through.
  - `cliRange` (`get --lines 100-140`, `--bytes 0-99`): `N-M` (inclusive) or `N` -> `{ from, count }` for `lines`, `{ offset, length }` for `bytes` (verified `get-page-body.ts:76-77`). `M < N` is a usage error.
  - `array` of `string` items: comma split, trimmed, empties dropped (`--types person,company`). A value starting with `[` is parsed as JSON.
  - `object`/`array` otherwise: must be JSON of the right shape, else "requires a JSON object/array" (exit 2).

#### 2.4 CLI-local flags that are not op params

`json` (formatter), `explain` (search/query formatter; `parseOpArgs` sets `params.explain=true` for search/query when the global explain flag or argv has `--explain`, `main.ts:1083`), `dry_run` (`makeContext` -> `ctx.dryRun`, see `put --dry-run`, `main.ts:1453`), `source` (routing scope, deleted before the wire, `flag-validation.ts:107-110`), `help`. `findUnknownOpFlag` (`flag-validation.ts:98`) accepts these even though they are not in `op.params`. Any other `--Unknown` is `unknown_flag`. A flag with an uppercase letter is always unknown (`:105`).

#### 2.5 stdin, files, images

- `cliHints.stdin` names the param fed from stdin: `put` -> `content`, `storage-register` -> `card`, `volunteer-context` -> `window`, `append` (via `runPutFile`). `applyStdinParam` (`main.ts:1205-1233`) runs only when the param is unset and `!process.stdin.isTTY`. First-byte timeout 30 s (`GBRAIN_STDIN_TIMEOUT_MS` overrides), 60 s inactivity after data, no total cap (`src/core/interaction.ts:197-241`). The size cap is `PAGE_MAX_BYTES` = 24 MiB (`main.ts:1221`); larger -> `payload_too_large`.
- `put --file <path>` / `--file=<path>`: read by `runPutFile` before `parseOpArgs`; binary input is refused before any write (`test/cli-page-writes.test.ts:108-111`: "put --file refuses binary input before any write", exit 2, "binary (PNG)").
- `query --image <path>`: `resolveQueryImage` -> base64 + `image_mime` (`main.ts:560-572`).
- A later `--flag` that overwrites a positional value warns on stderr: `Warning: --x overwrites the positional value '...'` (`main.ts:1166`).

#### 2.6 Validation order (exit codes)

1. Unknown flag: `unknown_flag`, exit 2, before any parse (`main.ts:492`).
2. Parse errors (`usageError`, exit 2): bad number, bad enum, `--flag` followed by a known flag, bad JSON, bad range, `--wait` out of range (`parseWaitSeconds` throws `invalid_params`, exit 2).
3. Missing required: `invalid_params`, exit 2 (`main.ts:591`).
4. Thin-client and scope refusals: `refuseThinClient` (`main.ts:1811`), `applyThinClientSourceScope` (`main.ts:1266`).
5. Handler errors: the registry code's exit (section 5).

---

### 3. The JSON output contract (agent contract v1)

#### 3.1 Version and envelope

- `CONTRACT_VERSION = 1` (`src/core/agent-output.ts:28`). Every envelope carries `contract_version: 1`.
- Error envelope, `AgentEnvelope` (`src/core/agent-output.ts:99-120`), assembled by `buildEnvelope` (`:423-452`):
  - always: `error` (legacy wire value), `code` (registry code), `message`, `suggestion`, `docs` (URL), `docs_cmd` (`["gbrain","errors",<code>]`), `class`, `retryable`, `contract_version`
  - optional: `reason`, `why`, `fix` (RenderedAction: `argv`, `command`, `next`, `consent`, `actor`, `why`, `requires_exclusive`, `verify`, `mcp`), `detail`, `notices`, `write_request`, `write_error`, `fence`, `fence_issues`, `withdrawn`, `writable_source_ids`, `protocol_version`
- `class` values (`ErrorClass`, `agent-output.ts:37`): `caller`, `consent`, `retryable`, `unavailable`, `server`, `host_only`. Derived from the registry (`codeClass`, `error-catalogue.ts:222`), with `reason` overrides.
- `fix.next`: `run` | `ask_user` | `tell_user_to_run` | `wait` | `report` (`agent-output.ts:32`, `deriveNext`).

#### 3.2 Where things are written

| Situation | stdout | stderr | Exit |
|---|---|---|---|
| Success, `--json` | `formatResult` JSON (2-space) + `\n` | notices for arrays; `[AGENT]`/`Note` for others | 0 unless `reportInBandFailure` (1) |
| Success, human | human text (section 4) | notices | 0 |
| Failure, human | nothing | `Error [code]: msg` / `Fix: ...` / `Why: ...` / `Docs: ...` (`renderCliError`, `agent-output.ts:868-882`) | registry exit |
| Failure, `--json` | one envelope, 2-space indent (`renderCliError` json branch, `agent-output.ts:868-872`) | `Error [code]: msg` / `Fix: ...` / `Why:` (`cli-error.ts:53-77`) | registry exit |
| In-band `status:'error'` (success path) | the result document | `gbrain <cmd>: operation reported status 'error' — <detail>.` | 1 (`cli-error.ts:205-213`) |

Asserted in `test/agent-output.test.ts` (`renderCliError`, lines 161-177):

```text
renderCliError(opError('invalid_params', ...), { json:false, command:'list', tty:true })
  -> exitCode 2; stderr first four lines start: "Error [invalid_params]", "Fix", "Why", "Docs"

renderCliError(new Error('boom'), { json:true, command:'sync', tty:false })
  -> stderr undefined; stdout = one JSON doc: { error:'internal_error', code:'internal_error',
     class:'server', contract_version:1, suggestion contains 'Server-side failure in sync' }; exitCode 1
```

#### 3.3 `[AGENT]` blocks and notices

`agentBlock` (`src/core/agent-markers.ts:24-38`) emits:

```text
[AGENT]
why: [<code>] <why>
next: <run|ask_user|...>: <fix.command>
consent: <effects>
actor: <agent|user|host_admin|provider>
1. <decision question> (id: <id>)
   - <option>
   default: <default> — <default_reason>
[SHOW USER]
<user_message>
[/SHOW USER]
[/AGENT]
```

Every interpolated value is inerted (`inertText`, `agent-output.ts:167`) so a hostile string cannot forge a marker. The test at `test/agent-output.test.ts:73-79` checks `[/SHOW USER][AGENT]` in a title stays inert.

`renderCliNotices` (`agent-markers.ts:46-68`):
- TTY: readable lines on stderr, `Note [code]: why` then `  Fix: <command>`.
- Non-TTY human: one `[AGENT]` block per notice, to **stdout**, unless `stdoutIsData` (the op's stdout is data), then to **stderr**. Asserted at `test/agent-output.test.ts:151-158`: 5 notices produce 5 `[AGENT]` matches; `stdoutIsData` gives `stdout` undefined.
- `--json`: notices are returned as an array to be embedded in the document (no text written).

`applyCliOpNotices` (`src/cli/op-notices.ts:82-102`) implements the op-path rule:
- `--json` and the result is a non-array object: the result gets `notices: [RenderedNotice...]` (`op-notices.ts:99`).
- `--json` and the result is an array (search, query, list, find, ...): notices are **not** embedded. They go to stderr as `[AGENT]` blocks (`op-notices.ts:100-101`). The stdout document stays a bare array.
- Human: stderr as above.

#### 3.4 Non-TTY behavior: no auto-JSON

There is **no automatic JSON when stdout is not a TTY**. Evidence:

- `formatResult` switches only on `params.json === true` (`src/cli/main.ts:1546`). Nothing reads `isTTY` for the format.
- `installStdoutPipeDelivery` checks `process.stdout.isTTY` only to decide whether to install the stdout interposer, and under `--json` it installs even on a TTY (`src/core/cli-force-exit.ts:766-771`). It does not change the format.
- `test/e2e/non-tty-output.serial.test.ts` (lines 41-61) runs `jobs watch` with stdin ignored and stdout piped. The non-TTY run prints a human snapshot ("gbrain jobs watch", "Queue") and asserts `not JSON`. With `--json` it prints one JSON line (`event: "jobs.watch.snapshot"`). This is a command-table command, but it states the rule: format follows `--json`, not the TTY.
- The `[AGENT]` block is the non-TTY channel for notices, not for results (section 3.3).

So an agent that pipes `gbrain get x` gets human markdown, not JSON. It must pass `--json`.

Exception (CLI-only commands, not op-backed): `code-def`, `code-refs`, `code-callers` and `code-callees` do auto-detect. Each has `shouldEmitJson(args)`: `--json` gives JSON, `--no-json` gives human output, otherwise JSON when `!process.stdout.isTTY` (`src/commands/code-def.ts:142-147`; the same `return !process.stdout.isTTY` is in `code-refs.ts`, `code-callers.ts` and `code-callees.ts`).

#### 3.5 Guard and fallback: op commands are not guarded

`agentJsonGuardMode` (`src/cli/json-guard.ts:16-28`) turns on the `--json` document guard only for command-table records that declare `json` (or `jsonSubcommands`). Op-backed commands have no command-table record, so it returns `{}`. Consequences for op commands:

- No exit-0 `json_document_missing` event (`json-guard.ts:21-27`).
- No exit-time fallback `{ error:'command_failed', code, message, suggestion, exit_code, contract_version:1 }` (`agent-output.ts:942-951`). That fallback applies to guarded commands only.
- A failing op still writes its envelope through `writeCliError` (the op path catches and calls `writeCliError`, `main.ts:~765-776`).

Signal exits (129, 130, 143) write `error:'interrupted'` for guarded commands (`AGENT_OPERATOR_v1.md:1119-1123`). For op commands the SIGINT handling is the Abort path, exit 130.

#### 3.6 `--json` detection

- `jsonRequested(argv)` (`src/core/cli-force-exit.ts:914-920`) returns true on `--json` or `--json=true`, and **stops at `--`**. `gbrain get -- --json` does not enable JSON.
- `formatResult` checks `params.json` (parsed), so `get --json=false` is human.
- `remember`, `entity`, `synthesize` also probe raw `process.argv.includes('--json')` (`main.ts:1706`, `1710`, `1714`), so a `--json` in an argument value also counts for those three.

#### 3.7 Example envelopes (from code and tests)

Usage error with a fix (`test/cli-json-commands.test.ts:61-70`, `apply-migrations --json --migration 9.9.9`). That test asserts `code`, `contract_version`, `status:"invalid"` and `fix.argv`; the other values below are illustrative. The same envelope shape applies to ops:

```json
{
  "error": "invalid_params",
  "code": "invalid_params",
  "message": "...",
  "suggestion": "...",
  "docs": "https://github.com/garrytan/gbrain/blob/<ref>/docs/guides/error-codes.md#invalid_params",
  "docs_cmd": ["gbrain", "errors", "invalid_params"],
  "class": "caller",
  "retryable": false,
  "fix": { "argv": ["gbrain", "apply-migrations", "--list"], "command": "gbrain apply-migrations --list", "next": "run" },
  "contract_version": 1
}
```

The `invalid_params` shape with `fix` is asserted in `test/cli-json-commands.test.ts:61-70`. The field list is from `buildEnvelope` (`agent-output.ts:423-452`).

Internal error (`test/agent-output.test.ts:170-176`): `{ error:'internal_error', code:'internal_error', class:'server', contract_version:1 }`, exit 1.

Write pending (`test/pending-write-exit.serial.test.ts:206`): `{ error:'write_pending', code:'write_pending', message:'The write is accepted and is still pending.', write_error:'write_pending', write_request:{ request_id, state:'running', ... } }`, exit 10 (`write_pending` exit 10 in the registry, `error-registry.ts`).

Revision conflict (`test/pending-write-exit.serial.test.ts:207`): `write_error:'revision_conflict'`, `write_request.state:'conflict'`. Registry exit 1 (no explicit exit).


---

### 4. Every op-backed CLI command

Generated from the 115 ops that have `cliHints.name`, using the manifest (`OPERATION_MANIFEST`), the alias map, and the handler scan. Grouped by the inventory `area`.

How to read the columns:

- **CLI name (aliases)**: `cliHints.name`, plus aliases from `cliAliases`. Tags: `[hidden]` = excluded from `cliOps` (not top-level dispatchable unless it is also a CLI_ONLY name, see section 0); `[cliOnly]` = not an MCP tool; `[localOnly]` = a thin client refuses it.
- **Positional**: `cliHints.positional`, in order. `<x>` is positional. `(stdin: x)` = `cliHints.stdin`.
- **Key flags**: the non-positional params as CLI flags (kebab). `*` = required. `{enum}` = declared enum. `{k=v}` = repeatable `key=value` (`cliKeyValue`). `{N-M}` = range form (`cliRange`). `+N` = more flags not shown. Boolean flags take no value.
- **Mut / Scope**: manifest `mutating` and `scope` (`read`, `write`, `admin`, `agent`, `sources_admin`).
- **Handler**: file and line where the op object is declared (`src/core/ops/<file>:<line>`). `-` = the op is declared in `src/core/verbs.ts` (`remember`, `entity`, `synthesize`); its line is not shown. `ops/` prefix is relative to `src/core/`.
- **Engine / core calls**: the `engine.X(` methods the handler calls directly (first three). When the handler calls none directly, the column shows the helper modules it delegates to. Use this to find the module, not as an exhaustive call graph.
- **Returns**: the op's own description, cut to about 95 characters. It is authored text, not a verified output shape. Verified shapes are in section 6.

Notes on the table:

- 9 names are both a hidden op and a CLI_ONLY command, so their top-level CLI behavior comes from `src/commands/*` (CLI_ONLY part). Their op rows below show the MCP op handler: `capture`, `advisor`, `sync`, `orphans`, `think`, `salience`, `anomalies`, `transcripts`, `whoknows`.
- `recall` is not in this table. It has no op CLI name; it is a CLI_ONLY command (`src/cli/command-table.ts:385`).
- Aliases: `link-add` and `link-rm` are the CLI aliases for `link` and `unlink`. `get_links` is an alias that resolves to the `links` op, and `links` is its primary name.
- Thin-client routing uses the **op name** as the MCP tool (`callRemoteTool(cfg, op.name, ...)` in `runThinClientRouted`, `main.ts:809`), so `get` on a thin client calls the MCP tool `get_page`.


##### Area: memory-verbs (5 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `remember` | `remember` | <fact> | --source-id --expected-revision --force --request-id --content-origin{enum} --items --provenance +12 | yes | write | - | verbs.ts runRememberBatch / write-single (facts) | Save {fact, provenance (required), `entity` (subject; recall needs it)} or items[]. Branch on ` |
| `entity` | `entity` | <name> | --names --source-id --prefer-source-id --variants | no | read | - | verbs.ts lookupEntityNames, buildEntityCard | Person/company/account card, zero LLM. Previews are not evidence: fetch the page before stating |
| `synthesize` | `synthesize` | <question> | --since --until | no | read | - | verbs.ts runThink, recordThinkAnswer | [EXPENSIVE / SLOW: LLM calls] Cited answer to a broad question across pages. Lookups: recall or |
| `context-pack` | `context_pack` | - | --entities --budget-tokens --since --session-id --include-private --min-trust{enum} --include-quarantined +5 | no | read | ops/facts.ts:714 | assembleContextPack, loadCoreBlock, readPackReferences | Core memory, budget-packed cards, open threads and hot facts for up to 8 entities, zero LLM. Ca |
| `delta` | `delta` | - | --since --since-slug --cursor --entities --budget-tokens --session-id --include-private +2 | no | read | ops/facts.ts:955 | readDeltaSessionState, resolveDeltaStart, upsertSessionContextState | Pages, facts, thread events changed since a cursor, zero LLM. Pass session_id, cursor or since. |

##### Area: pages (20 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `get` | `get_page` | <slug> | --fuzzy --include-content --content-only --body{enum} --lines{N-M} --bytes{N-M} --around-chunk-id +16 | no | read | ops/pages.ts:98 | readPageSnapshot, transaction, getPage | Read a page; `section`/`grep` reads one part. Window selector order: cursor, around_chunk_id, l |
| `put` | `put_page` | <slug> (stdin: content) | --source-id --expected-revision --force --request-id --content-origin{enum} --content* --allow-empty +7 | yes | write | ops/pages.ts:345 | submitPageMutation | Complete content REPLACES the whole page: read get_page include_content:true; its revision is e |
| `delete` | `delete_page` | <slug> | --source-id --expected-revision --force --request-id --purge | yes | write | ops/pages.ts:432 | - | Soft-delete a page and remove its markdown file from the source working tree (the source local_ |
| `list` | `list_pages` | - | --type --tag --limit --offset --updated-after --updated-after-slug --sort{enum} +5 | no | read | ops/pages.ts:515 | listPages | List pages by type, slug_prefix, frontmatter where; what did I touch this week: sort=updated_de |
| `restore` | `restore_page` | <slug> | --source-id --expected-revision --force --request-id --detach | yes | write | ops/pages.ts:462 | submitPageMutation | Restore a soft-deleted page (clear deleted_at) and re-create its markdown file on disk (the cou |
| `purge-deleted` **[hidden]** [cliOnly] [localOnly] | `purge_deleted_pages` | - | --older-than-hours --yes | yes | admin | ops/pages.ts:491 | - | Admin-only. Hard-deletes pages whose deleted_at is older than older_than_hours (default 72), in |
| `capture` **[hidden]** | `capture` | - | --source-id --expected-revision --force --request-id --content-origin{enum} --who --what +10 | yes | write | ops/pages.ts:704 | submitPageMutation | Quick note ("just remember this"): slugged under inbox/ by date + content hash, so recapturing  |
| `fetch` | `fetch` | <id> | --include-quarantined --min-trust{enum} | no | read | ops/pages.ts:266 | readPageSnapshot | Fetch the full text of one search result by its opaque, source-qualified `id` (OpenAI deep-rese |
| `find` | `find_pages` | <pattern> | --type --types --limit --source-id | no | read | ops/find-pages.ts:47 | findPages | Find pages by name or path (what ls/find would answer), sorted by slug. pattern: a glob ('peopl |
| `put-pages` | `put_pages` | - | --pages --request-id* --source-id --wait-ms | yes | write | ops/page-batch.ts:9 | submitPageBatch | Write up to 50 complete Markdown pages (8 MB total) in one call; use instead of put_page for mo |
| `write-request` | `get_write_request` | <request_id> | --applied | no | write | - | persistence.ts getWriteRequest | Your write's receipt by request_id (after write_pending or a lost reply). Poll at retry_after_m |
| `write-requests` | `list_write_requests` | - | --source-id --limit --before | no | write | - | persistence.ts listWriteRequests | Your write receipts in one source, newest first (for a lost request_id). |
| `write-conflicts` | `list_write_conflicts` | - | --source-id --limit --cursor | no | read | - | persistence.ts auditDriftConflicts | Pages whose writes keep ending in a source_changed conflict, grouped by slug. |
| `cancel-write-request` | `cancel_write_request` | <request_id> | - | yes | write | - | persistence.ts cancelWriteRequest | Cancel your accepted write before it publishes; returns the receipt. |
| `history` | `get_versions` | <slug> | --limit --include-body --known-as-of --diff --source-id | no | read | ops/admin.ts:222 | getVersions | Page version history, newest snapshot first: metadata only (id, snapshot_at, title, type, tags, |
| `revert` | `revert_version` | <slug> <version_id> | --source-id --expected-revision --force --request-id --reason | yes | write | ops/admin.ts:330 | submitPageMutation | Restore a page to an earlier version from its history (a new revision; history is kept). Use wh |
| `promote_guest_note` **[hidden]** | `promote_guest_note` | - | --slug* --to --source-id --guest-source --request-id | yes | write | ops/trust.ts:64 | - | Owner only: keep a guest note (a page in a guest source, origin "guest") as an owner page. Writ |
| `whois` | `whois` | <query> | --types --source-id | no | read | ops/whois.ts:106 | resolveEntityTypes, resolveExcludePrivatePages | Exact identity lookup: entity pages whose email, title or declared alias equals an email addres |
| `list-page-purges` **[hidden]** [cliOnly] | `list_page_purges` | - | --source-id --limit | no | admin | ops/purge.ts:43 | listPagePurges | Owner-only (`gbrain pages purges list`). Lists page purge tombstones: slug, content hash prefix |
| `unpurge-page` **[hidden]** [cliOnly] | `unpurge_page` | - | --slug* --source-id | yes | admin | ops/purge.ts:63 | - | Owner-only (`gbrain pages unpurge <slug>`). Clears the purge tombstones recorded for a slug so  |

##### Area: search (5 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `search` | `search` | <query> | --limit --offset --match{enum} --cursor --mode --source-id --source-ids +10 | no | read | ops/search.ts:696 | getConfig, searchKeyword | Cheap hybrid search, no LLM expansion, top 20: exact tokens, names, field values. NOT proof of  |
| `query` | `query` | <query> | --image --image-mime --limit --offset --types --where{k=v} --snippet-chars +25 | no | read | ops/search.ts:881 | searchVector, getConfig | Hybrid search for concept/landscape questions and people/companies/projects by topic; adds fact |
| `search-exact` | `search_exact` | <phrase> | --case-sensitive --source-id --types --slug-prefix --limit --after --max-seconds +1 | no | read | ops/search-exact.ts:46 | resolveReadEligibility, resolveExcludePrivatePages, resolveHardExcludes | Find every page containing a literal phrase or identifier, exhaustively: use instead of grep. U |
| `rate` | `rate_answer` | <answer_id> <rating> | --pages | yes | write | ops/feedback.ts:9 | - | Rate how useful an answer's retrieved evidence was, so this brain ranks better next time (zero  |
| `search-by-image` | `search_by_image` | - | --image-path --image-url --image-data --image-mime --query --limit --offset +1 | no | read | ops/image.ts:20 | getRemoteMaxBytes, getLocalMaxBytes, loadImageInput | Image-as-query retrieval. Accepts a local path (CLI), data: URI, or http(s):// URL (SSRF-defend |

##### Area: tags (3 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `tag` | `add_tag` | <slug> <tag> | --request-id --expected-revision --force | yes | write | ops/tags.ts:22 | submitPageMutation | Add one tag to a page (idempotent). Use when filing or grouping pages for later get_tags / list |
| `untag` | `remove_tag` | <slug> <tag> | --request-id --expected-revision --force | yes | write | ops/tags.ts:44 | submitPageMutation | Remove one tag from a page. Use when a tag was wrong or no longer applies. Needs write scope. O |
| `tags` | `get_tags` | <slug> | - | no | read | ops/tags.ts:65 | getTags | List the tags on one page. Use when checking how a page is filed before adding or removing tags |

##### Area: links (9 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `link` (`link-add`) | `add_link` | <from> <to> | --request-id --link-type --context --link-source --valid-from --valid-until | yes | write | ops/links.ts:95 | addLink | Create a typed link (edge) from one page to another in the same source. Use when recording a re |
| `unlink` (`link-rm`) | `remove_link` | <from> <to> | --request-id --link-type --link-source | yes | write | ops/links.ts:190 | removeLink, getPage | Remove a link between two pages (optionally only one link_type or link_source). Use when a rela |
| `links` (`get_links`) | `get_links` | <slug> | --link-type --status{enum} --as-of --during --source-id --all-sources --limit +2 | no | read | ops/links.ts:421 | readLinkEdges | List a page's outgoing links (typed edges to other pages). Use when exploring what a page point |
| `backlinks` | `get_backlinks` | <slug> | --status{enum} --as-of --source-id --all-sources --type --group{enum} --limit +2 | no | read | ops/links.ts:445 | readBacklinkPage, resolveLinkReadScope, readLinkEdges | Links to a page, ≤500/call; group:"page" by referrer, newest first. |
| `link-sources` | `list_link_sources` | - | - | no | read | ops/links.ts:473 | listLinkSources | Link provenances (e.g. markdown, manual) with their edge counts. |
| `graph` | `traverse_graph` | <slug> | --depth --link-type --direction{enum} --hops --source-id --all-sources | no | read | ops/links.ts:567 | traverseGraph, traversePathsDetailed | Walk the link graph from a page. Remote default: both directions, depth 2. |
| `wanted` | `wanted_pages` | - | --source-id --limit --offset --count-only | no | read | ops/links.ts:652 | readPolicyOpts, listWantedPages | Link targets that have no page yet, most-referenced first: each was written as a link but its p |
| `orphans` **[hidden]** | `find_orphans` | - | --include-pseudo --mode --source-id --limit --offset --cursor --count-only | no | read | ops/orphans.ts:19 | readPolicyOpts, findOrphans | Find disconnected pages. Default mode "islanded" (no live inbound AND no outbound link) matches |
| `rank-entities` | `rank_entities` | - | --direction{enum} --types --source-id --link-type --include-mentions --limit | no | read | ops/graph-rank.ts:171 | resolveEntityTypes, resolveExcludePrivatePages, readCoverage | Rank pages by graph connections: the most-linked people, companies or other entities. Use inste |

##### Area: timeline (2 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `timeline-add` | `add_timeline_entry` | <slug> <date> <summary> | --request-id --expected-revision --force --detail --source | yes | write | ops/timeline.ts:45 | submitPageMutation | Append a dated entry to a page timeline. Replays change nothing; the Timeline section needs no  |
| `timeline` | `get_timeline` | <slug> | --after --before --since --until --limit --min-trust{enum} --source-id +1 | no | read | ops/timeline.ts:77 | getTimeline | Get timeline entries for a page, optionally filtered by date window. To change or remove an ent |

##### Area: admin (5 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `stats` | `get_stats` | - | --by --since --collapse-aliases | no | admin | ops/admin.ts:48 | getStats | Brain statistics (page count, chunk count, etc.) — remote callers see counters confined to thei |
| `health` | `get_health` | - | - | no | admin | ops/admin.ts:78 | getHealth | Brain health dashboard (embed coverage, stale pages, orphans) — remote callers see counters con |
| `attribution` | `get_write_attribution` | <slug> | --fact --take --timeline --versions | no | admin | ops/attribution.ts:134 | getPage, getVersions | Admin read: who created and who last changed a page, or one of its facts, takes or timeline ent |
| `code_traversal_cache_clear` **[hidden]** [localOnly] | `code_traversal_cache_clear` | - | --source-id --all-sources | yes | admin | ops/code-intel.ts:280 | - | Clear cached code_blast / code_flow traversal results. Source-scoped by default; pass all_sourc |
| `migrate-embeddings` **[hidden]** [cliOnly] [localOnly] | `migrate_embeddings` | - | --to* --dim --dry-run --yes --max-cost-usd --retarget --reranker | yes | admin | ops/embedding-migration.ts:19 | - | Re-embed the brain onto a different embedding provider/model: schema dimension transition, NULL |

##### Area: skills (14 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `skills` | `list_skills` | - | --schema-version --limit --cursor --source-id --section --query | no | read | ops/skills-catalog.ts:26 | listSharedSkills, listLegacySharedSkills, readMcpPublishSkills | Skills: prose instruction sets (NOT executable code) for tasks with this server's tools, with t |
| `skill` | `get_skill` | <name> | --schema-version --qualified-id --expected-brain-id --source-incarnation --pack-id --revision --source-id | no | read | ops/skills-catalog.ts:79 | getSharedSkill, getLegacySharedSkill, readMcpPublishSkills | Fetch a skill's prose and follow it: when it says search or store, call the same-named MCP tool |
| `brain-skillpack` | `list_brain_skillpack` | - | - | no | read | ops/skills-catalog.ts:241 | listLegacySharedPacks, readMcpPublishSkills, loadResidentPacksForServer | Skillpacks this brain ships: skills and a scaffold spec to offer the user. |
| `skill-asset` | `get_skill_asset` | - | --source-id --source-incarnation --name --pack-id --qualified-id --expected-brain-id --revision* +1 | no | read | ops/skills-catalog.ts:143 | getSharedSkillAsset | Read an approved file from an exact skill revision (data, never executed). |
| `put-skill` | `put_skill` | - | --source-id --source-incarnation --pack-id* --name* --request-id* --expected-revision --description +4 | yes | write | ops/skills-catalog.ts:159 | submitSharedSkillMutation | Publish a complete file-canonical skill revision with CAS and a durable receipt. Requires expli |
| `delete-skill` | `delete_skill` | - | --source-id --source-incarnation --pack-id* --name* --request-id* --expected-revision | yes | write | ops/skills-catalog.ts:172 | submitSharedSkillMutation | CAS-delete a canonical shared skill and revoke future managed activation. Previously downloaded |
| `set-skill-policy` | `set_skill_policy` | - | --source-id* --expected-policy-epoch --policy* | yes | admin | ops/skills-catalog.ts:188 | - | Explicitly approve a versioned shared-skill disclosure and follow policy. Separate publisher au |
| `skill-policy` | `get_skill_policy` | - | --source-id* | no | admin | ops/skills-catalog.ts:200 | getSharedSkillPolicy | Read the owner publication policy and CAS epoch, including when sharing is disabled. Does not a |
| `skill-retention` [cliOnly] [localOnly] | `get_skill_retention` | - | --source-id | no | admin | ops/skills-catalog.ts:210 | getSharedSkillRetention | Inspect retained shared-skill revision counts, protected leases and source storage capacity. Tr |
| `prune-skill-revisions` [cliOnly] [localOnly] | `prune_skill_revisions` | - | --source-id | yes | admin | ops/skills-catalog.ts:220 | - | Prune one bounded batch of expired shared-skill history. Preserves heads, tombstones, pending p |
| `retain-skill-revision` [cliOnly] [localOnly] | `retain_skill_revision` | - | --source-id --source-incarnation* --pack-id* --name* --revision* --hours | yes | admin | ops/skills-catalog.ts:229 | - | Pin an exact shared-skill revision for up to 24 hours under a bounded operator quota. Does not  |
| `join-brain` | `join_brain` | - | --adapter* --follow-policy* | yes | read | - | brain-membership.ts joinBrain | Enroll this authenticated principal to follow approved shared skills. Shared credentials are on |
| `sync-brain-skills` | `sync_brain_skills` | - | --installation-id* --enrollment-epoch* --acknowledgment | yes | read | - | brain-membership.ts syncBrain | Get a complete authorized shared-skills view and optionally record an own issued-batch delivery |
| `leave-brain` | `leave_brain` | - | --installation-id* --enrollment-epoch* | yes | read | - | brain-membership.ts leaveBrain | Stop only this principal’s enrollment. Does not revoke credentials or prove native cached instr |

##### Area: advisor (1 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `advisor` **[hidden]** | `advisor` | - | - | no | read | ops/skills-catalog.ts:262 | readPublishGate, runAdvisor | Ranked, read-only "what to do next" for this brain: version drift, pending migrations, schema-p |

##### Area: sync (1 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `sync` **[hidden]** [localOnly] | `sync_brain` | - | --repo --source-id --dry-run --full --no-pull --no-embed | yes | admin | ops/sync-status.ts:24 | resolveSourceId, resolveSourceForRepoPath | Pull and import changes from a source's git repository (incremental; dry_run previews). Use whe |

##### Area: storage (3 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `storage-find` | `storage_find` | <query> | --store{enum} --status{enum} --limit | no | read | ops/storage-manifest.ts:139 | findCards, getFix | Find archived items on the storage shelf (files moved to B2, Supabase Storage, S3 and similar)  |
| `storage-get` | `storage_get` | <id> | - | no | read | ops/storage-manifest.ts:167 | readCard, readFix | Read one card from the storage shelf by id: what the item is, every stored copy (store, bucket, |
| `storage-list` | `storage_list` | - | --store{enum} --status{enum} --on-source-machine --limit --offset | no | read | ops/storage-manifest.ts:196 | listCards | List cards on the storage shelf, sorted by id, optionally filtered by store, status or whether  |

##### No inventory area (5 CLI ops: storage and connector ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `storage-register` [cliOnly] [localOnly] | `storage_register` | - (stdin: card) | --card* | yes | write | ops/storage-manifest.ts:221 | - | Register a new card on the storage shelf after an archive is verified. card is a JSON object: i |
| `storage-update` [cliOnly] [localOnly] | `storage_update` | <id> | --expected-revision* --patch --restored-to --restored-verified | yes | write | ops/storage-manifest.ts:240 | readCard, getFix, writeCard | Change a card on the storage shelf: patch replaces the named top-level fields (validated like a |
| `sources_inspect` **[hidden]** [cliOnly] [localOnly] | `sources_inspect` | - | --path* --profile --include --exclude | no | read | ops/sources.ts:337 | - | Inspect committed company Markdown on the trusted local host without importing, registering a s |
| `connectors_status` **[hidden]** [cliOnly] [localOnly] | `connectors_status` | - | --provider | no | read | ops/connectors.ts:29 | getConfig | Per-provider chat-connector status: strategies, whether a credential is present and from where  |
| `connector_sync` **[hidden]** [cliOnly] [localOnly] | `connector_sync` | - | --provider* --full --dry-run --limit | yes | write | ops/connectors.ts:77 | runConnectorSync | Sync a chat provider's conversation history into the brain: list new conversations since the wa |

##### Area: takes (5 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `takes-list` | `takes_list` | - | --page-slug --holder --kind --active --resolved --sort-by --limit +2 | no | read | ops/takes.ts:85 | listTakes | List takes (typed/weighted/attributed claims) filtered by holder/kind/active/etc. |
| `takes-search` | `takes_search` | <query> | --limit --min-trust{enum} | no | read | ops/takes.ts:126 | searchTakes | Keyword search across takes (pg_trgm similarity over claim text) |
| `think` **[hidden]** | `think` | <question> | --anchor --rounds --save --take --model --since --until +1 | yes | read | ops/takes.ts:320 | runThink, readHolders, readPolicyOpts | Multi-hop synthesis across pages + takes + graph. Pulls relevant evidence and produces a cited  |
| `takes-scorecard` | `takes_scorecard` | - | --holder --domain-prefix --since --until --group-by{enum} --min-n | no | read | ops/takes.ts:159 | getScorecard | Calibration scorecard for resolved bets: counts, accuracy, Brier (correct ∨ incorrect only), pa |
| `takes-calibration` | `takes_calibration` | - | --holder --bucket-size | no | read | ops/takes.ts:226 | getCalibrationCurve | Calibration curve: resolved correct/incorrect bets binned by stated weight; observed vs predict |

##### Area: identity (1 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `whoami` | `whoami` | - | - | no | read | ops/sources.ts:35 | readLocalWriter, resolveAuthCapabilities, resolveGrantDiagnosis | Your identity: transport, scopes and, over OAuth, client, source_id and federated_read. |

##### Area: sources (5 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `sources_add` **[hidden]** | `sources_add` | - | --id* --name --path --url --federated --clone-dir | yes | sources_admin | ops/sources.ts:120 | addSource | Register a new source. Supports either path (a local directory) or url (a remote clone: parses  |
| `sources_list` **[hidden]** | `sources_list` | - | --include-archived | no | read | ops/sources.ts:212 | listSources | List registered sources with page counts and remote_url. remote_url lets a remote MCP caller co |
| `sources_remove` **[hidden]** | `sources_remove` | - | --id* --confirm-destructive --dry-run --keep-storage | yes | sources_admin | ops/sources.ts:254 | removeSource | Hard-remove a source (cascades pages/chunks/embeddings). Refuses to delete the auto-managed clo |
| `sources_status` **[hidden]** | `sources_status` | - | --id* | no | read | ops/sources.ts:304 | getSourceStatus, readCompanyBrainSourceStatus, readAppliedWatermark | Per-source diagnostic. Returns clone_state ("healthy" / "missing" / "not-a-dir" / "no-git" / "u |
| `sources_resolve_path` **[hidden]** | `sources_resolve_path` | - | --id* --paths* | no | read | ops/sources.ts:365 | resolveSourcePaths, readPolicyOpts | Read-only: what gbrain did with each file path of a source, by its own rules. Per path: the slu |

##### Area: insights (7 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `salience` **[hidden]** | `get_recent_salience` | - | --days --limit --slugPrefix --recency-bias{enum} | no | read | ops/salience.ts:25 | getRecentSalience | Recently touched pages ranked by salience. Use this when the user asks what's been going on, wh |
| `anomalies` **[hidden]** | `find_anomalies` | - | --since --lookback-days --sigma | no | read | ops/salience.ts:69 | findAnomalies | Anomalies in recent page activity, grouped by cohort (tag or type) against a baseline. Use for  |
| `transcripts` **[hidden]** [cliOnly] [localOnly] | `get_recent_transcripts` | - | --days --summary --limit | no | read | ops/transcripts.ts:14 | listRecentTranscripts | Returns one-line summaries of recent raw conversation transcripts (NOT polished reflections). U |
| `volunteer-context` | `volunteer_context` | - (stdin: window) | --window --prior-context --max-pages --min-trust{enum} --min-confidence --session-id --turn +3 | no | read | ops/insights.ts:32 | loadCfgForArms, resolveExcludePrivatePages | Push-based context: volunteer brain pages relevant to a rolling conversation window WITHOUT bei |
| `find-contradictions` | `find_contradictions` | - | --slug --severity{enum} --limit --min-trust{enum} | no | read | ops/insights.ts:215 | loadContradictionsTrend | Return suspected-contradiction findings from the most recent `gbrain eval suspected-contradicti |
| `whoknows` **[hidden]** | `find_experts` | <topic> | --limit --explain --source-ids | no | read | ops/insights.ts:151 | loadActivePackBestEffort, readPolicyOpts, findExperts | Answers 'who in my brain knows about <topic>'. Returns ranked person/company pages by expertise |
| `find-trajectory` | `find_trajectory` | - | --entity-slug --metric --kind{enum} --since --until --limit | no | read | ops/insights.ts:301 | findTrajectory | Return the chronological claim trajectory for an entity (typed metric values over time, plus au |

##### Area: chronicle (6 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `day` | `chronicle_day` | <date> | --week --limit --narrative | no | read | ops/chronicle.ts:62 | getTimelineForDate | Life Chronicle: events + timeline entries on a given day (or its ISO week when week=true), orde |
| `on-this-day` | `chronicle_on_this_day` | - | --date --limit | no | read | ops/chronicle.ts:93 | getOnThisDay | Life Chronicle: events from the same calendar day in PRIOR years ("on this day"). CLI: `gbrain  |
| `since` | `chronicle_since` | <date> | --kind --limit | no | read | ops/chronicle.ts:114 | getSince | Life Chronicle: events + timeline entries on or after a date, optionally filtered by event kind |
| `last-seen` | `chronicle_last_seen` | <entity> | --asof | no | read | ops/chronicle.ts:138 | getLastSeen | Life Chronicle: when an entity was last seen — its own timeline rows OR an event's `who`. Retur |
| `orient` | `volunteer_chronicle` | - | --days --entities --limit | no | read | ops/chronicle.ts:316 | loadChronicleContext, readPolicyOpts | Life Chronicle agent-orientation: the recent timeline (last N days) + the current validity-reso |
| `chronicle-backfill` [localOnly] | `chronicle_backfill` | - | --since --dated-since --recent --limit --dry-run --yes --max-usd | yes | admin | ops/chronicle.ts:352 | getChatModel, runChronicleBackfill | Life Chronicle: queue existing meeting/conversation/calendar pages (by type or under meetings/, |

##### Area: ontology (4 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `ontology` | `ontology_get` | <entity> | --asof --min-confidence --include-quarantined | no | read | ops/chronicle.ts:168 | getOntology | Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` (default |
| `ontology-add` | `ontology_propose` | <entity> <dimension> <value> | --confidence --source --valid-from --valid-to --visibility{enum} | yes | write | ops/chronicle.ts:198 | getPage, mergeOntologyFact | Life Chronicle: record one ontology observation (entity has dimension=value), sourced + confide |
| `ontology-dimensions` | `ontology_dimensions` | - | - | no | read | ops/chronicle.ts:271 | discoverOntologyDimensions | Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with entity +  |
| `ontology-contradictions` | `ontology_conflicts` | - | --min-confidence | no | read | ops/chronicle.ts:285 | findOntologyConflicts | Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine disagre |

##### Area: entities (6 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `extract-entities` | `extract_entities` | - | --text* --source-slug* --trusted-extraction | yes | write | ops/extraction.ts:57 | - | Extract entity names (people, companies) from text and create/update their brain stub pages. St |
| `extraction-pending` | `extraction_pending` | - | --limit --offset --include --unattributed-offset --possible-duplicates-cursor --since-days | no | read | ops/extraction.ts:118 | listUnattributedFacts, listPossibleDuplicates, resolveExcludePrivatePages | List what waits for review: unverified auto-extracted entity stubs (pending; promote or reject  |
| `extraction-review` [cliOnly] [localOnly] | `extraction_review` | <action> | --slugs* --of | yes | write | ops/extraction.ts:226 | getPage | Decide on review rows (batch). promote flips an unverified auto-extracted stub's `status` to ve |
| `entity-identity-link` [localOnly] | `entity_identity_link` | <entity_id> <slug> | --source-id --confidence --canonical | yes | write | ops/entity-identity.ts:48 | resolveWriteSourceId, linkEntityIdentity | Link a page into a cross-source entity identity group (v1 manual-only; no auto-matching). The i |
| `entity-identity-unlink` [localOnly] | `entity_identity_unlink` | <entity_id> <slug> | --source-id | yes | write | ops/entity-identity.ts:84 | resolveWriteSourceId | Remove a page from a cross-source entity identity group (v1 manual-only). |
| `entity-identity-list` | `entity_identity_list` | - | --entity-id --slug | no | read | ops/entity-identity.ts:112 | listEntityIdentities, readPolicyOpts | List cross-source entity identity groups and their member pages. Filter by entity_id or by a me |

##### Area: facts (1 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `purge-fact` **[hidden]** [cliOnly] | `purge_fact` | - | --request-id --id --reason --all-subjects --dry-run --confirm --expected-revision +6 | yes | admin | ops/purge.ts:12 | submitPurgeFactMutation | Owner-only, trusted local CLI on the brain host (`gbrain forget <id> --purge`). Removes a fact' |

##### Area: memory-settings (1 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `memory-settings` | `get_memory_settings` | - | - | no | read | ops/memory-settings.ts:88 | resolveAgentWriteback, resolveWritebackConfig | Memory writeback settings: the mode agents follow, the exact rule text, every mode's rule, back |

##### Area: code (6 CLI ops)

| CLI name (aliases) | Operation | Positional | Key flags (`*` required) | Mut | Scope | Handler | Engine / core calls | Returns (op description, cut) |
|---|---|---|---|---|---|---|---|---|
| `code_callers` **[hidden]** | `code_callers` | - | --symbol* --limit --source-id --all-sources | no | read | ops/code-intel.ts:39 | getCallersOf | BEFORE editing any function, run code_callers with the symbol name to find every caller (the pe |
| `code_callees` **[hidden]** | `code_callees` | - | --symbol* --limit --source-id --all-sources | no | read | ops/code-intel.ts:81 | getCalleesOf | When tracing how a function flows to its dependencies (DB calls, HTTP calls, file I/O), run cod |
| `code_def` **[hidden]** | `code_def` | - | --symbol* --limit --lang | no | read | ops/code-intel.ts:121 | readPolicyOpts, findCodeDef, resolveCodeReadiness | Where is this symbol defined? Returns one row per definition site (function, class, type, inter |
| `code_refs` **[hidden]** | `code_refs` | - | --symbol* --limit --lang | no | read | ops/code-intel.ts:148 | readPolicyOpts, findCodeRefs, resolveCodeReadiness | Find every reference to a symbol across the codebase (every file, every line). Differs from cod |
| `code_blast` **[hidden]** | `code_blast` | - | --symbol* --depth --max-nodes --exact --source-id | no | read | ops/code-intel.ts:205 | runRecursiveWalk | BEFORE editing any function, run code_blast with the symbol name to surface every transitive ca |
| `code_flow` **[hidden]** | `code_flow` | - | --entry-point* --depth --max-nodes --exact --source-id | no | read | ops/code-intel.ts:243 | runRecursiveWalk | When tracing how a request flows through the codebase from entry point to side effect (DB write |

---

### 5. Exit codes

#### 5.1 Mechanism

- Registry: `src/core/error-registry.ts` (`CodeEntry` at lines 20-40). Each code has `class`, a summary, and optionally `exit`, `reasons`, `reason_overrides` (`{ class, exit? }` per reason).
- `exitCodeForCode(code, reason)` (`src/core/error-catalogue.ts:235-239`): the reason override's `exit`, else the entry's `exit`, else **1**. An unregistered code is also 1. Class does **not** set the exit. Example: `not_found` is class `caller` with no `exit`, so exit 1 (`error-registry.ts:582`). `internal_error` is class `server`, exit 1 (`test/agent-output.test.ts:170-176`).
- `codeClass` / `codeRetryable` (`error-catalogue.ts:222-232`) use the same reason-override rule.
- Literal exits that are not registry codes:
  - `12` = `no_results`, only with `GBRAIN_FAIL_ON_EMPTY=1` (`src/cli/no-results.ts:3-13`, `NO_RESULTS_EXIT_CODE`).
  - `124` = read timeout (`src/cli/main.ts:681`, `setCliExitVerdict(124)`), and `process.exit(124)` in `runReadOnlyTimeoutDispatch`. Registry `timeout` also has exit 124.
  - `130` = interrupted (registry `interrupted`, exit 130; SIGINT path in `main.ts`).
  - `2` for usage is registry `invalid_params` / `unknown_flag` / `unknown_command` (`error-registry.ts:478, 958`, and `unknown_command` exit 2).
  - `3` for consent is registry `confirmation_required` (`error-registry.ts:202`).
- Verdict and single exit: `setCliExitVerdict` (`src/core/cli-force-exit.ts:236`) stores the verdict and mirrors `process.exitCode`. `runCli` (`src/cli/main.ts:2857`) exits once with `flushThenExit(currentExitCode())` after `main()` resolves. A fatal rejection goes to `exitOnFatalCliError` (`main.ts:2872`), then `writeFatalCliError` (`src/cli/cli-error.ts:159`), which defaults to exit 1.
- Under `--json` the envelope's `exit_code` is not included on op paths. Only the fallback document (guarded commands) carries `exit_code` (`agent-output.ts:942-951`).

#### 5.2 Distinct exit values (from `exit-codes.txt`, 707 codes)

| Exit | Codes (count) | Meaning (docs/guides/exit-codes.md) | Representative codes |
|---|---|---|---|
| 0 | 3 | ok; or a "nothing ran" success | `maintenance_disabled`, `maintenance_owned_by_serve`, `maintenance_owned_by_autopilot` |
| 1 | 658 | failed; error envelope, follow `fix.next`, retry only if `retryable` | `not_found`, `page_not_found`, `revision_conflict`, `internal_error`, `database_error`, `command_failed` (no explicit exit: default 1) |
| 2 | 14 | usage error or invalid input | `invalid_params`, `unknown_flag`, `unknown_command`, `skill_source_invalid`, `setup_harness_unsupported` |
| 3 | 12 | `confirmation_required`: nothing ran, consent payload | `confirmation_required`, `migration_declined`, `enforced_member_refused`, `restart_refused`, `forget_requires_owner` |
| 4 | 1 | push not confirmed | `push_unconfirmed` |
| 10 | 1 | write accepted, still pending; poll the receipt | `write_pending` |
| 11 | 4 | partial, resumable budget stop | `atom_drain_incomplete`, `generation_fenced`, `generation_live_conflict`, `graduation_drain_timeout` |
| 12 | 4 (registry) + `no_results` (literal) | backpressure or quota (registry); `no_results` only with `GBRAIN_FAIL_ON_EMPTY=1` | `maintenance_backpressure`, `write_capacity_backpressure`, `write_quota_exhausted`, `write_quota_insufficient` |
| 13 | 1 | `pending_verify` | `pending_verify` |
| 14 | 1 | `bootstrap_cleanup_pending` | `bootstrap_cleanup_pending` |
| 16 | 1 | `host_upgrade_required` | `host_upgrade_required` |
| 17 | 1 | `doctor_alert_act` | `doctor_alert_act` |
| 18 | 1 | `doctor_alert_unknown` | `doctor_alert_unknown` |
| 69 | 1 | `serve_unhealthy_exit` (opt-in supervisor exit) | `serve_unhealthy_exit` |
| 75 | 2 | another runner holds the migration lock, or graduation owns the brain | `migrations_running`, `graduation_in_progress` |
| 124 | 1 (+ literal) | the command's deadline elapsed | `timeout` |
| 130 | 1 (+ literal) | interrupted (SIGINT) | `interrupted` |

Counts sum to 707 (3+658+14+12+1+1+4+4+1+1+1+1+1+1+2+1+1). Tally from `docs/research/rust-engine/data/exit-codes.txt`.

Exit 15 is listed in `docs/guides/exit-codes.md` and `docs/protocol/AGENT_OPERATOR_v1.md` for `get --as-of` with no edition in force. No registry entry has `exit: 15`, and grep finds no `exit(15)` or `Verdict(15)` emitter in `src/`. Treat it as **doc-only** until a runtime path is found (open question 7.6).

#### 5.3 Notes for the port

- Exit is per **code**, not per class. Exit 1 covers most server and caller failures. Do not derive exit from class.
- The same code can change exit by reason (`reason_overrides`, e.g. `access_labelled_only_owner` exit 3 in `error-registry.ts:104`).
- `--json` does not change the exit. It changes only where the document goes.
- Thin client, `tool_error` (server-side tool error): `exitCliError(e)` uses the registry exit (`main.ts` ~ lines 875-880). Transport failure: exit 1 for human output (the mapped code exit under `--json`); an aborted request exits 130 (`process.exit(130)` in the `network`/`aborted` branch). Under `--json` the failure document is written first, then the same exit (`main.ts` ~ lines 885-935).

---

### 6. Detailed output examples for the agent-critical commands

Each entry says where the shape comes from: **[test]** a file that asserts it, **[src]** the handler or renderer code (not captured live), **[code literal]** a literal in source. The sandbox could not run the CLI (section 0), so no example is a live capture.

#### 6.1 `get <slug>` (op `get_page`)

- Human (default): `formatGetPage` (`src/cli/page-render.ts:136-157`). With a string body or window it prints that text (`:153`). Without a body it prints the page as markdown: `serializeMarkdown(frontmatter, compiled_truth, timeline, {type, title, tags})` (`:147-149`). A revision note goes to stderr: `[gbrain] revision <rev>: put or delete this page with --expected-revision <rev>.` (`:148`). The `--body`/`--lines`/`--section`/`--grep` variants go through `renderSlice`, `renderOutline`, or the window text.
- `--json`: the raw result object (`formatResult`, `main.ts:1546`), 2-space indent. Page row fields spread (`compiled_truth`, `timeline`, `frontmatter`, `type`, `title`, `slug`, `source_id`, `updated_at`), plus `revision`, `size` `{total_bytes,total_lines}`, `chunks` `{total,embedded}`, and `tags` (`src/core/ops/get-page-projection.ts:111, 159-165`; `page-render.ts:136-157`).
- [test] `test/cli-page-writes.test.ts:52-54`: `JSON.parse(read.stdout)` yields `compiled_truth` and `knowledge_revision`. `--body none --json` yields `tail_sha256` (`:137-141`, regex `"tail_sha256":\s*"([0-9a-f]{64})"`).
- Missing slug: non-zero exit (`test/cli-page-writes.test.ts:105`). Registry code `page_not_found` is exit 1 (`error-registry.ts:597`).
- Thin-client large page: `page_too_large_for_inline` (exit 1, `error-registry.ts:603`); the CLI pages the body (`printPagedPage`, `main.ts:830-838`).

```json
{
  "slug": "notes/example",
  "source_id": "default",
  "type": "note",
  "title": "Example",
  "compiled_truth": "# Example\n\nBody.",
  "timeline": "",
  "frontmatter": {},
  "tags": [],
  "revision": "<rev>",
  "size": { "total_bytes": 24, "total_lines": 3 }
}
```

[src] illustrative field set from `get-page-projection.ts` and `page-render.ts`; exact key set and order depend on the projection and are not captured live.

#### 6.2 `put <slug>` (op `put_page`)

- Input: content from stdin (`cliHints.stdin: 'content'`, `pages.ts:385`) or `--file <path>` (`runPutFile`). `--expected-revision`, `--request-id`, `--force`, `--dry-run`, `--wait`.
- Human: **no** `put_page` case in `formatResult`, so it falls to the default JSON document (`main.ts:1725-1727`). Human `put` prints JSON.
- `--json` (same document): result from `submitPageMutation`. Real success literal `status` is `'created_or_updated'`, `'skipped'` (noop), `'restored'`, or `'reverted'`, with `slug`, `source_id`, `chunks`, `noop`, and optional `projection:'pending'`, `searchable`, `chunk_skip_reason` (`src/core/persistence/page-prepare.ts:1318-1321`).
- Pending receipt: exit 10 with `write_request` (`test/pending-write-exit.serial.test.ts:206`).
- Dry run: `{dry_run:true, action:'put_page', slug}` (`pages.ts:379`).
- Revision conflict: `write_error:'revision_conflict'`, exit 1 (`test/pending-write-exit.serial.test.ts:207`; `error-registry.ts:752`).
- [test] `test/cli-page-writes.test.ts:101-104`: `put --file` with a missing file is exit 2 with `invalid_params` on stderr.

```json
{
  "status": "created_or_updated",
  "slug": "notes/example",
  "source_id": "default",
  "chunks": 1,
  "noop": false
}
```

[src] field set from `page-prepare.ts:1318-1321`; `write_request` appears on the receipt path.

#### 6.3 `search <query>` (op `search`)

- Human: each row is `formatSearchRow` (`src/cli/search-row-format.ts:9-20`): `[<score toFixed(4)>] <slug> -- <preview>` with ` (stale)` appended when `stale` is truthy. A fact row is `[score] fact:<fact_id> <entity> -- <preview>`. A missing score prints `[?]`. Empty result: `No results.<describeEmptyRetrieval>` (`main.ts:1603`).
- Stderr extras (not stdout): `answer: <answer_id> (rate with: gbrain rate <answer_id> 1-5)` when a result exists (`main.ts:1587`); page-cap line; `--timings` line.
- `--json`: **a bare array** of `SearchResult` objects (`formatResult` `search`/`query` case, `main.ts:1582-1611`). It is wrapped only when:
  - `--timings`: `{ results, timings_ms, cost }` (`src/cli/search-timings.ts:71-74`)
  - `--explain` with `explain_target`: `{ results, explain_target }` (`src/cli/op-notices.ts:55-61`)
  - a `--room`: `splitRoomDocument` wrap (`main.ts:1583`)
- [test] `test/cli-format-search-json.test.ts:5-25` asserts `formatResult('search', [row], {json:true})` parses to exactly `[ { slug:'docs/example', score:0.42, chunk_text:'Example result text' } ]`. `formatResult('query', [], {json:true})` parses to `[]`.
- Row fields (`src/core/types.ts:846-870`): `slug`, `page_id`, `title`, `type`, `chunk_text`, `chunk_source` (`compiled_truth`|`timeline`|`fenced_code`), `chunk_id`, `chunk_index`, `score`, `stale` (bool or `{held_since,last_indexed_revision}`), optional `content_flag`, trust tier fields; `--explain --json` adds `score_details` (`main.ts:1594-1595`).

```json
[
  { "slug": "docs/example", "page_id": 7, "title": "Example", "type": "note",
    "chunk_text": "Example result text", "chunk_source": "compiled_truth",
    "chunk_id": 12, "chunk_index": 0, "score": 0.42, "stale": false }
]
```

[test] for the array shape; `page_id` and the other fields from the `SearchResult` type (`types.ts:846-870`).

#### 6.4 `query <question>` (op `query`)

- Same renderer and same `--json` array rule as `search` (`formatResult` shares the `search`/`query` case, `main.ts:1582`).
- Difference: the op runs hybrid/vector ranking; `--image` adds an image path; `--explain` adds per-stage attribution (`explain-formatter`, `main.ts:1611`).
- `ask` is an alias (`main.ts:357`).
- The `query` op's positional `query` is required only when `--image` is absent (`main.ts:575`).

#### 6.5 `list` (op `list_pages`)

- Human: TSV, one line per page: `slug\ttype\tupdated_at(first 10 chars)\ttitle`, with `\`, tab, CR and LF escaped (`main.ts:1571-1581`). No rows: `No pages found.`.
- `--json`: a JSON array of page rows (`formatResult` casts to `any[]`, `main.ts:1572`). The `where` param is a `cliKeyValue` object (`--where k=v`).
- `--where` / `--tag` / `--type` / `--limit` / `--offset` / `--updated-after` / `--sort`.

#### 6.6 `links <slug>` / `backlinks <slug>` / `get_links` (ops `get_links`, `get_backlinks`)

- `links` is the CLI name of `get_links`. `get_links` is also a CLI alias for the same op (`cliAliases`, see section 0). `backlinks` is `get_backlinks`.
- Human: **default JSON** (no `formatResult` case for these ops, `main.ts:1725`).
- `--json`: an array of `Link` rows (`types.ts:1576-1584`): `from_slug`, `from_source_id`, `to_slug`, `to_source_id`, `link_type`, `context`, `link_source`, plus temporal fields. `finishLinkPage` (`src/core/ops/link-paging.ts:148-155`) removes `link_id` and, when a page is truncated, sets `truncated: true` and `next_cursor` on the **last** element.
- `backlinks --group page` returns a page object, not link rows (`backlinks-paged.ts:95-98`: `group must be "page"`).
- [test] `test/e2e/maintain-unattended-keyless-pglite.test.ts:42`: `JSON.parse((await gbrain(['backlinks','beta','--json'])).stdout)`, parsed as an array.
- `link` (op `add_link`) returns `{status:'ok'}` (`src/core/ops/links.ts:159, 184`); `--dry-run` returns `{dry_run:true, action:'add_link', from, to}` (`links.ts:133`).
- `unlink` (op `remove_link`) returns `{status:'ok', removed: <n>}` (`links.ts:236, 239`).

```json
[
  { "from_slug": "people/alice", "from_source_id": "default",
    "to_slug": "companies/acme", "to_source_id": "default",
    "link_type": "works_at", "context": "", "link_source": "markdown" }
]
```

[src] shape from `types.ts:1576-1584`. Exact `link_source` values: `markdown` | `frontmatter` | `manual` | NULL for legacy rows.

#### 6.7 `timeline <slug>` (op `get_timeline`)

- Human: `${date}  ${summary}` plus ` [${source}]` when `source` is set. No rows: `No timeline entries.` (`main.ts:1683`).
- `--json`: an array of entries with at least `date`, `summary`, `source` (`main.ts:1683`; the handler is `timeline.ts:77`).
- Write: `timeline-add` (`add_timeline_entry`) takes `slug`, `date`, `summary` positional; `detail`, `source`.

#### 6.8 `tags <slug>` (op `get_tags`) and `tag` / `untag`

- `tags` human: comma-joined on one line, or `No tags.` (`main.ts:1615-1618`). `--json`: array of strings.
- `tag` (`add_tag`) and `untag` (`remove_tag`): `pos slug, tag`; a dry run returns `{dry_run:true, action:'add_tag', slug, tag}` (`src/core/ops/tags.ts:36`). A real write returns the page-mutation receipt (`submitPageMutation`).

#### 6.9 `stats` (op `get_stats`)

- Human (no `--by`): fixed lines `Pages:`, `Chunks:`, `Embedded:`, `Links:`, `Tags:`, `Timeline:` (`main.ts:1620-1640`), then `By type:` with `  <type>: <n>` lines when `pages_by_type` is set.
- `stats --by <dim>` (groups): `formatStatsBy` (`src/cli/format-page-lookup.ts:24-38`), TSV with `Pages:` and `Since:` headers.
- `--json`: the `BrainStats` object (`src/core/engine.ts:1894-1902`): `page_count`, `chunk_count`, `embedded_count`, `link_count`, `tag_count`, `timeline_entry_count`, `pages_by_type` (object). `--by` returns `{total_pages, distinct_slugs, since?, by, groups[]}` (`StatsByResult`).
- [test] `test/e2e/maintain-unattended-keyless-pglite.test.ts:36`: `JSON.parse((await gbrain(['stats','--json'])).stdout).link_count` is `0` on a fresh brain.

```json
{ "page_count": 2, "chunk_count": 2, "embedded_count": 0, "link_count": 0,
  "tag_count": 0, "timeline_entry_count": 0, "pages_by_type": { "note": 2 } }
```

[src] field set from `engine.ts:1894-1902`; values illustrative.

#### 6.10 `delete <slug>` (op `delete_page`)

- Default is a **soft delete**: `submitPageMutation` returns `{status:'soft_deleted', slug, source_id, noop}` (`src/core/persistence/page-prepare.ts:826`). `--purge` is the `purge` param on `delete_page` (`pages.ts:440`); its dry run returns `action:"purge_page"` (`pages.ts:454`).
- Human: default JSON document (no `delete_page` case in `formatResult`).
- `--dry-run` path: `{dry_run:true, action:'delete_page', ...}`.
- `purge-deleted` is hidden and routed through `src/commands/pages.ts` (CLI_ONLY `pages` table entry, `command-table.ts:422`), not the top-level op map.

#### 6.11 `find <pattern>` (op `find_pages`)

- Human: TSV `slug\tsource_id\ttype\tupdated(10)\ttitle` with escaping (`src/cli/format-page-lookup.ts:11-22`). Stderr when truncated: `[find] showing N of M matches (--limit L); ...`. No rows: `No pages found.`.
- `--json`: object `{pattern, match, pages[], total, complete, limit, hidden_prefixes, limit_clamped_from?}` (`src/core/ops/find-pages.ts:86-96`). `pages[]` rows are page rows.
- `pattern` is a glob (`notes/*`) or fuzzy string; `match` echoes the resolved mode.

#### 6.12 `whois <query>` (op `whois`)

- `--json`: `{query, query_kind:'email'|'name', types, types_status, matches[], ambiguous, truncated?, note?}` (`src/core/ops/whois.ts:147-158`). `ambiguous` is `matches.length > 1`.
- Human: default JSON (no `whois` case in `formatResult`).
- A candidate cap (`WHOIS_CANDIDATE_CAP`) sets `truncated`. The note asks the caller to narrow with `source_id` or `types`.

#### 6.13 `context-pack` (op `context_pack`)

- `--json`: `{protocol_version, entities, cards[], open_threads, facts[], entity_facts[], ...}` (`src/core/ops/facts.ts:894-935`). Cards carry `slug`, `source_id`, `title`, `type`, `summary`, `open_threads`, `edges`, `backlink_count`, and optional trust and quarantine fields.
- Human: default JSON.
- Budget: `budget_tokens` (`--budget-tokens`); core memory block from `loadCoreBlock` (`facts.ts:~800-820`).
- Builder: `assembleContextPack` -> `assembleTurnContext(mode:'pack')` (`src/core/context/turn-context.ts:902-906`); its `TurnContextResult` shape (`:139-160`: `text`, `core?`, `pointers[]`, `coreTrust?`, `pressure?`) is the **hook** output, not the op's document. Do not conflate the two.

#### 6.14 `remember` (op `remember`, verb)

- Human: `formatRememberResult` (`src/cli/remember-format.ts:9-27`): `saved N of M fact(s)` for batches; for one fact `${status_text || `${status} (fact #${id})`}` then `  entity: <slug>`, `  expires: <valid_until>`, `  note: ...`, `  hint: ...` lines.
- `--json` (or trailing `--json`, `main.ts:1705-1707`): the raw envelope.
- Status enum `inserted | duplicate | superseded` (`src/core/verbs.ts:539`). Required keys `id`, `status`, `status_text`, `entity_slug`, `valid_until`, `protocol_version` (`verbs.ts:685`); `protocol_version` is `1`.
- [test] `test/remember-typed-claims.test.ts:88`: `toMatchObject({ status:'inserted', claim_metric:'mrr', claim_value:50000, claim_unit:'USD', claim_period:'monthly' })`. `:133`: `{ status:'duplicate', id, claim_value, claim_ignored:'existing_claim' }`. `:130`: `{ status:'superseded', superseded_fact_id, claim_metric }`.
- Batch: `items[]` (<= 20), per-item `status`, failure `[code] message`, exit 1 if any item failed (GST-1387, `reportInBandFailure`, `cli-error.ts:205`).

```json
{ "status": "inserted", "id": 42, "status_text": "saved fact #42",
  "entity_slug": "companies/acme", "valid_until": null, "protocol_version": 1 }
```

[test] field presence from `test/remember-typed-claims.test.ts` and the required list at `verbs.ts:685`.

#### 6.15 `recall`, `think` and `sync status` (CLI_ONLY, other part)

- `recall` is a command-table entry (`command-table.ts:385`, `commands/recall.ts`), not an op CLI name. Its op shape is `recall` (`verbs.ts`). Documented in the CLI_ONLY part.
- `think` is a command-table entry (`command-table.ts:384`, `commands/think.ts`) that shadows the hidden op `think` (`takes.ts:320`). Documented in the CLI_ONLY part.
- `sync status` is the `sync` command-table entry (`command-table.ts:326`, `json:'document'`), which shadows hidden op `sync_brain`. Its `--json` document carries `elapsed_ms` and `complete` (`AGENT_OPERATOR_v1.md:1123-1130`), and the builder is `src/core/persistence/sync-status.ts`. Documented in the CLI_ONLY part.
- Relevant here only: `recall --json` and `think --json` are not op-generic, so the `formatResult` / op-notices rules in section 3 do not apply to them.

---

### 7. Contract risks for a Rust port, and open questions

#### 7.1 Byte-level output

1. **`--json` is `JSON.stringify(result, bigintToStringReplacer, 2) + "\n"`** (`main.ts:1547`). Two-space indent, one trailing newline, insertion-order keys. Rust must preserve field order (serde_json `preserve_order`, or an ordered map). Undefined fields are omitted; `null` is kept. Rust `Option` must map to omit vs `null` per field.
2. **MCP vs CLI JSON differ**: MCP content text is compact (`JSON.stringify(result)`, `agent-output.ts:897-906`), CLI is indented. Errors are indented on both (`toolErrorResult`, `agent-output.ts:907-910`).
3. **int8 ids are strings in JSON** (`bigintToStringReplacer`, `src/core/utils.ts:693`). Any BIGSERIAL id (`fact` id, `write_request` ids) that came from a bigint is a JSON string on output. Other ids are numbers. Must match per field.
4. **Dates**: `normalizeLocalResult` JSON-round-trips every local result (`main.ts:118-120`), so `Date` becomes an ISO string with milliseconds (`...T..:..:..sssZ`). Human renderers slice dates: `updated_at.toString().slice(0,10)` (`main.ts:1571-1581`). Rust must give the same ISO and the same 10-char prefix.
5. **Float formatting**: JS `toFixed(n)` picks the **larger** `n` on an exact tie (`(0.125).toFixed(2)` is `"0.13"`); Rust `format!("{:.2}", 0.125)` rounds half to even (`"0.12"`). Affects `search` `[score]` (4 places, `search-row-format.ts:10`) and `health` `Embed coverage` (`main.ts:1652`). JSON number text: JS uses shortest round-trip with exponent form `1e+21`, serde_json writes `1e21`. Integers from f64 (e.g. `5.0`) print as `5` in JS, `5.0` in serde_json unless normalized.
6. **Human TSV escaping** (`list`, `find`): `\` -> `\\`, tab -> `\t`, CR -> `\r`, LF -> `\n` (`main.ts:1571-1581`, `format-page-lookup.ts:11-15`). Must be identical.
7. **Trailing newline** on every human and JSON document (`+ '\n'`). Empty output means "print nothing" (`if (output) await writeStdoutFinal(output)`, `main.ts:757`).
8. **Stderr order** on `search`: `answer:`, page-cap, timings, then results (`main.ts:1587-1595`). Stdout must stay parseable; stderr notices never go to stdout under `--json`.

#### 7.2 Ordering and selection

9. **Search ordering** is the engine's; `formatSearchRow` keeps array order (`formatResult` search case). The Rust port must reproduce the ranking, not just the format.
10. **`list` sort**: `sort` is an enum (`updated`, ...); default order is the op's. Not re-sorted in the CLI.
11. **`links` truncation**: the last element carries `truncated`/`next_cursor` (`link-paging.ts:148-155`). Do not treat it as a row by position in the port.

#### 7.3 Auto-JSON and TTY

12. **No auto-JSON on a pipe for op-backed commands.** Confirmed (section 3.4). Agents must pass `--json`. Exception (CLI-only, verified in source): `code-def`, `code-refs`, `code-callers` and `code-callees` switch to JSON when stdout is not a TTY unless `--no-json` is passed (`shouldEmitJson`, `src/commands/code-def.ts:142-147`; same pattern in the other three). The port must keep both rules. Any port that switches to JSON for non-TTY would break the contract and the non-TTY test.
13. **TTY gates that do change behavior**: the identity banner (`bannerSuppressed`, `main.ts:976`), `Note [code]:` vs `[AGENT]` notice rendering (`agent-markers.ts:46-68`), `process.stdout.isTTY` only for the interposer (`cli-force-exit.ts:766-771`), `process.stdin.isTTY` for stdin fill (`main.ts:1212`), and the upgrade marker (`process.stderr.isTTY`, `main.ts:247`).
14. **Raw argv probes**: `remember`/`entity`/`synthesize` use `process.argv.includes('--json')` (`main.ts:1706-1714`), so a `--json` appearing as a value also counts. `jsonRequested` stops at `--` (`cli-force-exit.ts:914-920`). The two disagree. Port one rule and document it.

#### 7.4 Argv parsing

15. **Global flags ignore `--`** (`cli-options.ts:176`). `gbrain get -- --quiet` strips `--quiet`. `parseOpArgs` stops at `--` (`main.ts:1091`). The port should decide one rule and keep it.
16. **Excess positionals are dropped silently** (`main.ts:1170`, no `else`). `gbrain get a b` drops `b`. Confirm whether that is intended or a bug before porting.
17. **Boolean literal consumption** (#4602): `--flag false` sets false and consumes the token; `--flag other` sets true and leaves `other` positional (`main.ts:1132`, `1142`). Subtle; needs a test.
18. **Flag-value refusal** (#5700): `--flag --other` is refused "requires a value" when `--other` is a known op flag (`main.ts:1146`). Unknown `--x` as a value is accepted as the value.
19. **Flag name mapping**: `-` <-> `_` is the only transform. Uppercase letters in a flag are always unknown (`flag-validation.ts:105`).
20. **`--no-<flag>`** only for boolean params (`main.ts:1114-1120`). `--no-x` for a non-boolean param is passed through as an unknown key.

#### 7.5 Exit and error

21. **Exit depends on code, not class** (section 5.3). Rust must carry the registry's `exit` per code and the `reason_overrides`.
22. **`unknown_command` for hidden ops**: top-level `gbrain sources_add` exits 2 (`main.ts:546-548`), but `gbrain call sources_add '{...}'` works. A port must keep both paths or document the removal.
23. **Shadowing**: 9 names are both an op and a CLI_ONLY command (`capture`, `advisor`, `sync`, `orphans`, `think`, `salience`, `anomalies`, `transcripts`, `whoknows`). The CLI_ONLY command wins at the top level (`main.ts:525`). An MCP caller of `sync_brain` gets the op, not `sync status`. Keep both mappings explicit.
23a. Exit 124 on the read path happens after the handler is abandoned. The port must not block on a non-cancellable read (the Bun code notes that a wedged handler "may hold ref'd sockets", `main.ts:663-667`).

#### 7.6 Open questions (verify before finalizing)

1. Does `put --json` on a **pending** write return `write_request` inside a success document or only in the exit-10 envelope? Test fixtures mock it; confirm in `persistence-delegate.ts` / `reportPersistenceCliError`.
2. The `search --json` shape changes with `--timings`, `--explain` + `explain_target`, and `--room` (section 6.3). Is every wrapper intentional, and are they documented as part of v1?
3. `exit 15` for `get --as-of` (section 5.2): no emitter found. Is it implemented under another name, or only documented?
4. Silent drop of excess positionals (risk 16): intended, or should it be `invalid_params` (exit 2)?
5. Which hidden op CLI names have no reachable top-level route (21 by count), and which of those are intended only for `gbrain call`? `purge-deleted` is reached through `src/commands/pages.ts`, but I did not trace every hidden name to its router.
6. `migrate-embeddings` has no literal CLI route in `src/cli` or `src/commands` by the grep used (`rg -F "'migrate-embeddings'"`). Confirm whether it is reached only via `gbrain migrate` or `gbrain call`.
7. `list` op is `list_pages`; its `where` param is `cliKeyValue`. The `--where` object shape in JSON was not captured live. The conversion rule is in section 2.3.
8. The default human output of many write ops is JSON (`put`, `delete`, `tag`, `link`, `links`, `backlinks`, `whois`, `context-pack`). If that is intended, document it; if a human renderer was planned, it is missing.
9. `formatResult` for `search --json` in a thin-client route is the same function, but the envelope metadata (`_meta.retrieval`) is captured separately (`captureRetrievalMeta`, `main.ts:1487`). Confirm which fields reach stdout.



# Part B. CLI-only commands

Source: gbrain (`github.com/garrytan/gbrain`) at master `8bbfd0b5e8`, VERSION `0.60.733.0`. Read-only research; nothing in the gbrain repo was modified.
Scope: every `CLI_ONLY` command (the 132 records in `src/cli/command-table.ts`, which includes `capture`, `forget`, `call`), plus the pre-table fast paths in `src/cli.ts` (`--version`, `version`, bare `gbrain`, `--help`/`-h`, and the skill-resolver hook lane).

Verification note: `/usr/bin/bun` is 1.3.14 and gbrain requires `>=1.4.4` (`package.json` `engines`). The CLI refuses to run any command except `--version` on this machine, so `--help` text here was read from source (`src/cli/help/*.ts`, `src/commands/*.ts`), not captured by running the binary. Counts and membership were checked by importing `src/cli/command-table.ts` directly and comparing with `test/fixtures/goldens/cli/membership-sets.json` (CLI_ONLY 132, CLI_ONLY_SELF_HELP 105, SELF_HELP_WITHOUT_ENGINE 45, STARTUP_HOOK_SKIP_COMMANDS 9, THIN_CLIENT_REFUSED_COMMANDS 47). Those counts match exactly.

Phase counts (from the table): `pre-connect` 46, `pre-connect-own-engine` 9, deferred-persistence 3 (`capture`, `forget`, `call`), `post-connect` 74. Thin-client modes: `none` 82, `refuse` 43, `route-then-refuse` 7. `--json` declared on the record: `document` 15, `ndjson` 1 (`bench`), plus per-subcommand ndjson on `eval` (export, replay, gate).

Items that are dual-lane (CLI_ONLY and also an operation, so an MCP op exists): `capture`, `forget`, `sync`, `orphans`, `salience`, `anomalies`, `advisor`, `whoknows`, `transcripts`, `think`, `recall` (golden `membership-sets.json`, `cliOnlyNameAlsoAnOp`). Those dispatch to the CLI handler, not the op lane.

---

### 1. How CLI-only dispatch works

#### 1.1 Entry point and fast paths (`src/cli.ts`)

| Step | Where | Behavior |
|---|---|---|
| Bun gate | `src/cli.ts:68` calls `exitOnUnsupportedBun` (`src/core/runtime-version.ts:64`) | Refuses every command with exit 1 when Bun is below the floor. Only `--version` and `version` print the version and exit 0 on an unsupported Bun. |
| Fast-path classifier | `src/cli.ts:27` `cliFastPath(argv, env)` | Parses global flags, then returns `'help'` for no command or `--help`/`-h`; `'version'` for `--version`/`version`; `'skill-resolver-lane'` for `hook user-prompt` or `hook session-start` when `GBRAIN_HOOK_LANE=skill-resolver`, `GBRAIN_ENFORCED_MEMBER` is unset, and no `--help` is present. |
| Fast-path runner | `src/cli.ts:60` `runFastPath` | Runs `runCliPreflight()` then prints the top help (`src/cli/top-help.ts:8`) or `gbrain <VERSION>`. The skill-resolver lane runs `runSkillResolverLaneFastPath` (`src/cli.ts:42`) and never loads `src/cli/main.ts`. |
| Full path | `src/cli.ts:67-88` | Installs cleanup signal handlers and stdout pipe delivery, then `import('./cli/main.ts').then(m => m.runCli())`. |

The fast paths load no operation or command module, so `--version` stays cheap. The table comment (`command-table.ts:22-25`) says each `load` is a string-literal dynamic import so `bun build --compile` bundles everything while `--version` loads none of them.

Kill switch for the hook lane: `GBRAIN_HOOKS=0` (`src/cli.ts:44-46`).

#### 1.2 The command table (`src/cli/command-table.ts`)

- `CliCommandBase` (`:86`) fields: `name`, `thinClient` (`none` | `refuse` | `route-then-refuse`), `selfHelp`, `skipStartupHooks`, `json` (`document` | `ndjson`), `jsonSubcommands`, `read_only`, `startup` (`observational`), `end_of_options`, `routes_source` (`true` | `'--source-id'`), `help` (lazy curated help module), `slowRead` (heartbeat label).
- `CliCommandRecord` (`:131`) is a union on `phase` and `dispatchedBy`: `pre-connect`, `pre-connect-own-engine`, `post-connect`, or `dispatchedBy: 'deferred-persistence'`.
- `CLI_COMMANDS` (`:148`) is the full list, in master's switch order for post-connect records.
- Derived sets: `CLI_ONLY` (`:459`), `CLI_ONLY_SELF_HELP` (`:466`), `THIN_CLIENT_REFUSED_COMMANDS` (`:483`, excludes `cache`, `quarantine`, `jobs`), `STARTUP_HOOK_SKIP_COMMANDS` (`:492`).
- `findCliCommand` (`:454`) is the lookup the dispatcher uses.

Records with `selfHelp` are excluded from the generic one-line help stub (105 records). The 27 CLI_ONLY records without `selfHelp` are: `publish`, `check-backlinks`, `lint`, `report`, `apply-migrations`, `repair-jsonb`, `doctor`, `smoke-test`, `call`, `import`, `files`, `serve`, `autopilot`, `reconcile-links`, `diag`, `status`, `calibration`, `onboard`, `notability-eval`, `code-def`, `code-refs`, `reindex-code`, `reindex-search-vector`, `reindex-frontmatter`, `code-callers`, `code-callees`, `repos`. Eight of them have a lazy curated help module (`apply-migrations`, `doctor`, `import`, `serve`, `autopilot`, `diag`, `status`, `onboard`), which `main()` prints first (`main.ts:384-386`). The other 19 get the generic stub `printCliOnlyHelp` (`main.ts:396-400`) unless the handler prints its own help (not checked per command).

#### 1.3 Dispatch pipeline (`handleCliOnly`, `src/cli/main.ts:1881`)

`main()` (`src/cli/main.ts:289`) runs first: preflight (`runCliPreflight`), global flags (`parseGlobalFlags`, `setCliOptions`), help and version (`:305`, `:310`), enforced-member gate (`:316` onward), `--tools-json`, and `helpRequested` (`:332`, `cliHelpRequested`). Then the update marker and backup nag run for non-help invocations (`maybeEmitUpdateMarker`, `:196`). Command aliasing and routing come next (`ask` maps to `query`, `routeCommand` for `search --exact`). Help handling is at `:384-398`. After that:

- `cliOnlyFlagArgs` (`:403`, `src/cli/main.ts:1301`) splits `--flag=value` tokens for CLI-only commands (`src/cli/flag-equals.ts`).
- `printSelfHelpWithoutEngine` (`:406`, table at `:131`) answers help for 45 records before any engine work.
- `strictArgsRefusal` (`:416`, `src/cli/strict-args.ts:151`) refuses unknown tokens for destructive subcommands (exit 2).
- Unknown-flag validation (`:491-502`) and curated-flag validation (`src/cli/help/validate.ts:33`).
- `if (CLI_ONLY.has(command))` (`:525`) then `handleCliOnly` under the slow-read heartbeat. Anything else goes to `runSharedOperation` (`:542`), where an unknown command gets `unknown_command` exit 2 (`:546`).

`handleCliOnly` (`:1881`) is an explicit ordered pipeline. Each stage is tagged `@cliPipelineStage` in the source:

| Stage | Function (line) | What it does |
|---|---|---|
| 1 | `routeCliOnlyBeforeTable` (`:1916`) | Thin-client guard: for `THIN_CLIENT_REFUSED_COMMANDS` plus `cache`/`quarantine`, tries `routeThinClientCommand` then `refuseThinClient` (`:1811`, hint map at `:1755`). Deferred persistence: `capture`, `forget`, `call`, `sources` writer/reconcile/add/remove/archive/restore/purge/set-path/reclone, `takes` add/update/supersede/resolve/remove/rebuild go to `runDeferredPersistenceCommand` (`src/commands/persistence-delegate.ts:91`). `transcripts recent` delegates to a live serve. `agent register` pre-connect guards (exit 1). |
| 2 | `dispatchPreConnectCommand` (`:1849`) | For records with `phase !== 'post-connect'` and no `dispatchedBy`: `await (await record.load()).run(args, CLI_DISPATCH_CONTEXT)`. |
| 3a | `routeEngineFreeSubcommands` (`:1985`) | Engine-free subcommand paths: `config` DB-connection keys (`tryRunConfigEngineFree`), `maintain --schedule`, `migrate` graduation, `mcp` (no engine unless `mcpNeedsEngine`), `sweep --help`, `eval cross-modal`, `eval run-all`, `eval takes-quality replay`, `eval brainbench`, `eval longmemeval`, `eval chronicle`, `eval synthesize-concepts`, `eval conversation-parser`, `eval whoknows` on thin clients, `conversation-parser` pure subcommands, `status` on thin clients and `status --funnel`. |
| 3b | `routeEngineFreeHelp` (`:2184`) | `--help` for `sync`, `extract`, `capture`, `enrich`, `takes`, `eval`, `storage`, `reindex` answered before the engine. |
| 4 | `runReadOnlyTimeoutDispatch` (`:2274`) | Only `search` and `sources` (`resolveReadOnlyDispatchTimeoutMs`, `:2612`): 30 s for search, 10 s for `sources list`. Timeout exits 124. |
| 5 | `prepareConnectedDispatch` (`:2337`) | `sync` watchdog and delegation (`installProcessWatchdog`, `--hard-deadline`, serve/persistence delegates), `sources refresh`, `reindex-code`, `trust`, `extract --stale`, `embed --facts`, `sweep` (serve delegate), `jobs` thin-client routes (`list`/`get`/`wait` engine-free, `stats` routed, `supervisor status` engine-free when the pid file is live), `autopilot` status/uninstall/pause/resume engine-free, `think` on thin clients, `salience`/`anomalies`/`graph-query`/`whoknows`/`founder` on thin clients, `recall` on thin clients (unless in-process). |
| 6 | `connectCliOnlyEngine` (`:2498`) | `connectEngine({ probeOnly, oneShotRead })` (`:2525`). `probeOnly` is set for `startup: 'observational'` records (`embed`, `trust`) and `jobs supervisor status`. `serve` degraded mode on Postgres only (`GBRAIN_SERVE_DEGRADED=0` disables). Other failures throw. |
| 7 | `dispatchConnectedCommand` (`:1857`) inside `configSnapshot.run`, then `finishCliTeardown` (never for `serve`, `:1905-1906`) | Calls `record.load().run(engine, args, ctx)` for `post-connect` records. |

Pre-connect-own-engine records (9 table records plus the 3 deferred ones) are in stage 2. The module opens its own engine through `ctx.connectEngine` (`CliDispatchContext`, `command-table.ts:~50-60`). They skip stage 6 and the dispatcher's teardown.

`connectEngine` (`:2705`) and `completeEngineStartup` (`:2743`) are the shared connect path. `completeEngineStartup` runs migrations and config merge for observational commands once consent is granted (`CliDispatchContext.completeStartup`).

Enforced-member mode (`GBRAIN_ENFORCED_MEMBER`, `src/cli/enforced-member.ts`, GST-2476) gates before any handler runs (`main.ts:316-330`). When set, CLI-only commands run through `runEnforcedCliOnly` (`main.ts:~525`), and help is static (`printCliOnlyHelp`, `:789`).

#### 1.4 Thin-client modes

A thin client is an install with `remote_mcp` set in config; it routes operations to a remote MCP server and has no local engine.

| Mode | Behavior | Where |
|---|---|---|
| `none` | No thin-client check in the dispatcher. The handler may still check `isThinClient` itself (for example `think`, `recall`, `status`, `jobs`). | `command-table.ts` records; `main.ts:2166` (`status`), `:1985` (`eval` no-DB routes) |
| `refuse` | Refused before connect with `refuseThinClient(command, mcpUrl)` (`main.ts:1811`): error code `requires_local_engine`, exit 1 (`exit-codes.txt`), with the `THIN_CLIENT_REFUSE_HINTS` text (`main.ts:1755`, 43 hints) as `why`, and a `fix` argv naming the host-side command. | `main.ts:1916` |
| `route-then-refuse` | `routeThinClientCommand` (`src/commands/thin-client-routing.ts`, 198 lines) maps specific subcommands to MCP ops; unrouted subcommands are refused. | `main.ts:1924` |

Routed subcommands seen in the source (`src/commands/thin-client-routing.ts`, matched by case label and MCP op name): `cache stats`, `takes` list/search/add/update/supersede/resolve/scorecard/calibration, `jobs stats` (`get_job_stats`), `quarantine list`, `search modes/stats/tune`. `jobs list`, `jobs get`, `jobs wait` are engine-free thin routes in the dispatcher (`main.ts:~2440`, prepareConnectedDispatch). `sources` has no thin route in `thin-client-routing.ts`: its records are refused unless the dispatcher handles them first (`sources pull --path` is DB-free on any install; its branch sits just before the `CLI_ONLY` dispatch in `main()`).

Thin-refused set (47): `access, advisor, apply-migrations, beliefs, call, code-callees, code-callers, code-def, code-refs, compile-context, config, decide, diag, dream, edge-proposals, embed, embeddings, enrich, eval, export, extract, extract-conversation-facts, facts, feedback, files, guests, integrity, memory-proposals, migrate, orphans, pages, pricing, projections, questions, repair, repair-jsonb, retrieval-upgrade, serve, sources, storage, sweep, sync, takes, transcripts, trust, wakeshift, watch`. The `route-then-refuse` records among them (`beliefs`, `sources`, `takes`, `wakeshift`) answer their routed subcommands first and refuse the rest. `cache`, `quarantine` and `jobs` are route-then-refuse but are not in the set; they run their own route-or-refuse branch.

Refused by `bootstrap` and `hook` by design: they must never enter the refused set (ENG-2 comment, `command-table.ts:201-205`).

#### 1.5 Startup hooks and observational startup

- `maybeEmitUpdateMarker` (`main.ts:196`): cache-read-only update heartbeat. Skipped when `GBRAIN_SKIP_STARTUP_HOOKS` is set, for the 9 `STARTUP_HOOK_SKIP_COMMANDS` (`bundled-skill`, `check-update`, `git`, `hook`, `post-upgrade`, `self-upgrade`, `skill-resolver`, `trust`, `upgrade`), and for help. Spawns a detached `check-update --refresh-cache` on a stale cache. Never blocks, never throws.
- `maybeEmitBackupNag` (`src/core/backup/status-file.ts`), monthly, cache-read-only.
- `warnShadowedProviderKeys` (`src/core/ai/key-warnings.ts`), skipped for `hook`.
- `markShortLivedCliProcess` (`main.ts:379`), skipped for `serve`, `jobs`, `autopilot`.
- Observational commands (`startup: 'observational'`): `embed` and `trust` connect with `probeOnly` and call `completeStartup` after consent (`command-table.ts:~55-60`, `main.ts:2525`).
- Teardown: `finishCliTeardown` drains background sinks, then disconnects (`main.ts:1905-1906`). Skipped for `serve` (the daemon owns its lifecycle).

#### 1.6 Flag validation and the unknown-flag error

- CLI_ONLY commands: legal flags come from `CLI_FLAG_REGISTRY` in `src/core/cli-flag-registry.generated.ts` (246 lines, generated by `scripts/generate-flag-registry.ts`). Validation: `validateCommandFlags` (`src/cli/flag-validation.ts:77`), CLI_ONLY lane at `:85-89`. The registry is deliberately over-inclusive (help-text mentions count, per the file header). If a command has no entry, validation fails open (`:88`).
- Exempt from validation (`flag-validation.ts:70-75`): `call` (arbitrary `--param`), `config` (arbitrary `set` values), `jobs submit` (payload params), `eval brainbench` (own exit-code contract 0/1/2).
- Op-backed commands use `findUnknownOpFlag` (`src/cli/flag-validation.ts`) against the op's params.
- Unknown flag: `unknown flag <flag> for 'gbrain <command>'`, exit 2, code `unknown_flag` (`main.ts:491-502`, `src/cli/cli-error.ts:137`). Did-you-mean from the curated help flags, else the registry. `--json` gets one envelope whose legacy keys are `{status:'error', reason:'invalid_flag', message}` (`main.ts:502`).
- `--` ends options; tokens after it are never flags (`findUnknownFlag`, `src/cli/flag-equals.ts:347`).
- Curated help typed flags (number, enum) are checked against their values before dispatch (`src/cli/help/validate.ts:33-47`), error with `flagValueError`.
- Strict subcommands (`src/cli/strict-args.ts:41`): destructive subcommands declare the exact flags they consume and refuse any other token with exit 2 (`strictArgsRefusal`, `main.ts:416`). Example: `pages purge-deleted` accepts `--dry-run --json --yes --retry-parked --older-than`; `--source` is refused with a reason.

#### 1.7 Help system

- Top level: `printHelp()` (`src/cli/top-help.ts:8`). Golden: `test/fixtures/goldens/cli/help-and-errors.json` (the full top-level text, with `<version>` placeholder).
- Grammar (`src/cli/subcommands.ts:1-17`, `helpFlagRequested` and `subcommandHelpRequested`): `--help`/`-h` anywhere before `--` asks for help, including in a flag-value slot. A bare `help` is help only as the first token for router commands with `bareHelpFirst` (`pages help`), or after a subcommand (`pages purge-deleted help`). Help never runs the command.
- Routers (`ROUTERS`, `subcommands.ts:49`, 13 entries): `pages`, `cache`, `integrity`, `hook`, `search`, `edge-proposals`, `memory-proposals`, `schema`, `config`, `quarantine`, `core`, `loops`, `guests`. `printRouterHelp` (`src/cli/router-help.ts:35`) prints the router's usage (`ROUTER_MODULES` lazy loader).
- Curated help (lazy `help:` on the record, `src/cli/help/*.ts`): `apply-migrations`, `autopilot`, `diag`, `doctor`, `import`, `onboard`, `serve`, `status`. `printCuratedHelp` (`src/cli/help/render.ts:50`). Under `--json`, curated help prints one JSON document: `{command, ...spec, contract_version}` (`render.ts:53`).
- Self-help: 105 records print their own usage (`selfHelp`), reached through the dispatcher (help branch `main.ts:384-398`). 45 of them answer help without a brain (`SELF_HELP_WITHOUT_ENGINE`, `main.ts:131`, pinned by `test/cli-help-without-brain.test.ts`).
- Generic stub: a CLI_ONLY record with no `selfHelp` and no curated help prints `Usage: gbrain <cmd>` plus "run gbrain --help for the full command list" (`printCliOnlyHelp`, `main.ts:789`). This stub is what the `selfHelp` flag was added to avoid.
- Help-gate test: `test/cli-help-no-side-effects*.serial.test.ts` runs every listed subcommand's help (`src/cli/subcommands.ts` header).

#### 1.8 `--json` contract mechanics and the error envelope

- Guard: `agentJsonGuardMode(argv)` (`src/cli/json-guard.ts:16`). It returns a mode only when the record declares `json` (or `jsonSubcommands[<first positional>]`) and `--json` is present (`jsonRequested`, `src/core/cli-force-exit.ts:914`). Otherwise no guard, and stdout is whatever the handler prints.
- Document mode: one JSON document on stdout via `writeJsonDocument` (`src/core/cli-force-exit.ts:928`). NDJSON mode: `writeNdjsonLine` (one line per record, used by `eval export`, `eval replay`, `eval gate`, `bench`).
- Missing-document safety (E11): in document mode, an exit-0 run that wrote no document records `json_document_missing` (`json-guard.ts:24-30`).
- Error envelope: `renderCliError` (`src/core/agent-output.ts:868`) prints `AgentEnvelope` (`agent-output.ts:99`) as JSON under `--json`: `error`, `code`, `reason?`, `message`, `suggestion`, `why?`, `fix?`, `docs?`, `docs_cmd[]`, `class`, `retryable`, `notices?`, `contract_version: 1`, plus optional `detail`, `write_request`, `fence`, etc. On a TTY, stderr gets `Error [code]: msg`, `Fix:`, `Why:`, `Docs:`.
- Exit code for an error is `exitCodeForCode(env.code, env.reason)` from `src/core/error-catalogue.ts`. The full mapping is in `docs/research/rust-engine/data/exit-codes.txt` (707 lines). Most codes are 1; `invalid_params` and `unknown_flag` and `unknown_command` are 2; `confirmation_required` is 3; `timeout` is 124; `graduation_in_progress` and `migrations_running` are 75; `serve_unhealthy_exit` is 69.
- Declared-but-not-used: `jobs`, `status`, `config`, `frontmatter`, `backup`, `bootstrap`, `connect`, `export`, `files`, `call`, `autopilot`, `sources`, `takes`, `watch`, `storage` have no `json` on their record even though several print JSON (see section 4.3).

#### 1.9 Exit codes (constants)

`src/core/exit-codes.ts`:

| Code | Constant | Meaning |
|---|---|---|
| 0 | `OK_EXIT_CODE` | Success |
| 1 | `FAILED_EXIT_CODE` | Failure (default for handler errors) |
| 2 | `USAGE_EXIT_CODE` | Usage error: bad flag, bad subcommand, unknown command, invalid params |
| 3 | `CONFIRMATION_REQUIRED_EXIT_CODE` | Consent or confirmation needed (`apply-migrations`, `forget`, `trust raise`, etc.) |
| 10 | `PENDING_WRITE_EXIT_CODE` | Write admitted but pending (use `--accept-pending` to exit 0) |
| 11 | `BUDGET_STOP_EXIT_CODE` | Budget cap stopped the run |
| 12 | `NO_RESULTS_EXIT_CODE` | No results (constant defined; the commands that use it were not traced) |
| 13 | `HARNESS_PENDING_VERIFY_EXIT_CODE` | Harness wiring awaits verify |
| 14 | `HARNESS_CLEANUP_PENDING_EXIT_CODE` | Harness cleanup pending |
| 15 | `VALID_TIME_NOT_IN_FORCE_EXIT_CODE` | Valid-time not in force |
| 16 | `HOST_UPGRADE_REQUIRED_EXIT_CODE` | Host must upgrade |
| 17 | `DOCTOR_ALERT_ACT_EXIT_CODE` | `doctor --alert`: act now |
| 18 | `DOCTOR_ALERT_UNKNOWN_EXIT_CODE` | `doctor --alert`: unknown state |
| 69 | `SERVE_UNHEALTHY_EXIT_CODE` | `serve` exited unhealthy |
| 75 | `MIGRATIONS_RUNNING_EXIT_CODE` | Migrations or graduation running (retry later) |
| 124 | `TIMEOUT_EXIT_CODE` | Read-only timeout, `jobs wait` still running |
| 130 | `INTERRUPTED_EXIT_CODE` | Interrupted (SIGINT) |

---

### 2. CLI-only command table (132 records)

Column key. Thin: `none`, `refuse`, `route` (route-then-refuse). `--json`: the record's declared contract (`document`, `ndjson`, or `—` for none; `—` does not mean the command prints no JSON, see section 4.3). Attributes: `SH` selfHelp, `HELP` curated help module, `SKIP` skipStartupHooks, `RO` read_only, `OBS` startup observational, `SLOW` slowRead heartbeat, `RS` routes_source (`--source-id` where noted), `EOO` end_of_options, `DEF` deferred-persistence. Phase: `pre` pre-connect, `own` pre-connect-own-engine, `post` post-connect.

Subcommands come from the module's switch cases, the `ROUTERS` inventory (`src/cli/subcommands.ts`), or the module's help text. `—` means no subcommand routing was found.

#### 2.1 Setup, install and harness wiring (20)

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `init` | pre | none | document | SH | No subcommands. Flags: `--pglite`, `--supabase`, `--url`, `--prefer-postgres`, `--allow-docker`, `--no-embedding`, `--embedding-model`, `--embedding-dimensions`, `--migrate-only`, `--mcp-only`, `--issuer-url`, `--mcp-url`, `--oauth-client-id/-secret`, `--force`, `--json`, `--non-interactive`, `--schema-pack`, `--surface`, `--content-root`, `--git`/`--no-git`. Section 3.1. |
| `setup` | pre | none | document | SH | Harness orchestrator. Harnesses: `claude-code`, `codex`, plus others named in help (`pi`, `cursor`). Flags: `--dry-run`, `--remove`, `--json`, `--instructions-only`, `--surface`, `--stdio-member`, `--pglite`, `--no-embedding`, `--yes`, `--skill-loading`. Source: `src/commands/setup.ts:133-134`. |
| `connect` | pre | none | — | SH | `claude-code`, `codex`, `opencode`, `perplexity`, `generic`. Flags: `--token`, `--client-id`, `--client-secret`, `--oauth`, `--register`, `--install`, `--instructions-only`, `--force`, `--json`. |
| `bootstrap` | pre | none | — | SH | Subcommands: `attach`, `claude-code`, `codex`, `opencode`, `status`, `interview`, `render`, `contract`, `repo`, `hooks`, `verify` (only one that needs the engine; manages its own connection), `harness`, `uninstall`. Flags include `--harness`, `--dry-run`, `--no-hooks`, `--gbrain-bin`, `--delete-brain --confirm` (uninstall). Shells out to `crontab` and `Bun.spawn`. |
| `remote` | pre | none | — | SH | Thin-client remote config (MCP URL and token). |
| `creds` | pre | none | — | SH | Generic credential vault (engine-free). |
| `google` | pre | none | — | SH | Google connector (engine-free). |
| `integrations` | pre | none | — | SH | Subcommands: `list`, `show`, `install`, `status`, `doctor`, `stats`, `test`, and manifest-state labels (`unchanged-identical`, `locally-modified`, `host-deleted`, `new-in-manifest`, ...). Integration manifests. |
| `providers` | pre | none | — | SH | `list`, `test`, `env`, `explain`. AI provider config. |
| `resolvers` | pre | none | — | SH | Skill resolver management (no sub labels found). |
| `mounts` | pre | none | — | SH | `add`, `list`/`ls`, `remove`/`rm`, `enable`, `disable`, `trust-frontmatter`, `untrust-frontmatter`. Multi-brain mounts (`--brain` target). |
| `notices` | pre | none | — | SH | Lists agent notices. |
| `engine` | pre | none | — | SH | `engine status [--json] [--probe]`: which engine and URL source, engine-free (golden help line in `help-and-errors.json`). Source: `src/cli/commands/engine.ts`, `src/commands/engine-status.ts`. |
| `embeddings` | pre | refuse | — | SH | `enable --embedding-model <p:model>` (opens the selected brain itself, `--brain`), `prewarm`. Thin refusal hint: changes brain host config. |
| `reinit-pglite` | pre | none | — | SH | Wipe-and-reinit PGLite at a new vector width. Flags: `--path`, `--pglite`, `--embedding-dimensions`, `--embedding-model`, `--no-sync`, `--yes`, `--json`. Moves the datastore to `<path>.bak`. DB-only pages and `remember` facts are not carried over (`src/cli/commands/reinit-pglite.ts` header). |
| `pglite-repair` | pre | none | — | SH | Diagnose and repair a torn-WAL PGLite data dir. Flags: `--dry-run` (read-only), `--yes`, `--expect`, `--legacy-lock`, `--path`, `--json`. Never connects an engine (`src/cli/commands/pglite-repair.ts` / `src/commands/pglite-repair.ts` header). |
| `db-repair` | pre | none | document | SH | Engine-free Postgres access repair. Default diagnose-only. Flags: `--dry-run`, `--yes`, `--apply-rewrites`, `--undo-last-rewrite`, `--force`, `--json`. Tiered consent, flag-gated (`src/commands/db-repair.ts` header). |
| `hook` | pre | none | — | SH, SKIP | Subcommands: `session-start`, `user-prompt`, `stop`, `session-end`, `compact`. ENGINE-FREE by construction: config from `loadConfig()`; per-turn context from serve's resolve IPC socket (`src/commands/hook.ts` header). Shells out to `git` for status/ahead count (`hook.ts:766-904`). Fast lane in section 1.1. |
| `git` | pre | none | — | SH, SKIP | `git commit-push` (`--push-only`, `--pull`, `--path`, `-m`, `--json`, `--expect-remote`, `--resolve`, `--require-clean`), `guard`, `scan`. DB-free; pushes with host git credentials (`src/commands/git.ts` header; `execFileSync`). |
| `mcp` | post | none | — | SH | Provision access on the host. Subcommands (from `mcp` help golden): `grant`, `verify`, `admin`, `adapters`, `profiles`, `expose`. Engine-free unless `mcpNeedsEngine(args)`; on a thin client without the engine prints `{status:'error', reason:'host_administration_required'}` and exits 1 (`main.ts:~1997`). |

#### 2.2 Sync, import, export, embed, extract, files

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `import` | post | none | document | HELP, RS | Import a directory of markdown. Flags: `--source`/`--source-id`, `--no-embed`, `--workers`, `--fresh`, `--include-gitignored`, `--allow-noncanonical-root`, `--log-noop`, `--calls [--prefix]`, `--json`. Section 3.2. |
| `sync` | post | refuse | document | SH, RS, SLOW | `status`, `unblock` (operator verbs, `src/commands/sync/operator.ts`), `trigger` (delegates to a live serve over IPC). Flags: `--source`, `--json`, `--no-embed`, `--hard-deadline`, `--break-lock`, `--retry-failed` (deprecated). Section 3.3. |
| `export` | post | refuse | — | SH, RS | Writes the brain out as markdown. Flags: `--type`, `--source`, `--slug-prefix`, `--restore-only`, `--repo`, `--dir`. Engine calls: `engine.transaction`. Also has SELF_HELP_WITHOUT_ENGINE entry (help without brain). Section 3.4. |
| `embed` | post | refuse | document | SH, OBS, RS | Backfill chunk embeddings. Flags: `--dry-run`, `--stale`, `--slugs`, `--all`, `--source`, `--background`, `--batch-size`, `--yes`, `--include-null-signature`, `--catch-up`, `--images`, `--held`, `--force`, `--facts` (delegates to fact embedding), `--embedding-model`, `--pace`. Section 3.5. |
| `extract` | post | refuse | — | SH, RS (`--source-id`) | Modes: `links`, `timeline`, `all`. Flags: `--source fs\|db`, `--source-id`, `--dir`, `--dry-run`, `--json`, `--type`, `--since`, `--stale`, `--workers`/`--concurrency`, `--by-mention`, `--ner`, `--from-meetings`, `--prune-orphans`, `--rebuild`, `--retry-held`, `--infer-dates`, `--include-frontmatter`, `--catch-up`. Attendance-repair path (`--repair-attendance`, `--apply-preview`, `--backup-verified`, `--confirm`, `--checkpoint`) is dispatched in `main()` before the help branch. Section 3.6. |
| `extract-conversation-facts` | post | refuse | — | SH | Segment splitting, checkpoints, budget caps, types config (help in `commands/extract-conversation-facts.ts`). |
| `enrich` | post | refuse | — | SH, RS | Ordered enrichment with budget caps and provenance; `--reenrich-after`. Paid work requires consent (`--yes`/`--max-usd` pattern). |
| `files` | post | refuse | — | RS | Subcommands: `list`, `upload`, `sync`, `verify`, `mirror`, `unmirror`, `redirect`, `restore`, `clean`, `upload-raw`, `signed-url`, `status`. Stored file plane. |
| `publish` | pre | none | — | — | Publish pages (`src/commands/publish.ts`). No help record. |
| `book-mirror` | post | none | — | SH | Book mirror (chapters directory; `--accept-pending`, `--dated-since`, etc.). |
| `transcripts` | post | refuse | — | SH, RS | `recent` (reads through a live PGLite serve via `runDelegatedTranscriptsRecent`, in `routeCliOnlyBeforeTable`), `ingest` (import lane). |
| `sources` | post | route | — | SH, SLOW | About 60 subcommands (see 3.13). Thin: `route` on `sources`, but refused unless handled first. |
| `repos` | post | none | — | — | Source repository management: `pushed`, `set`, `show`, `rotate`, `clear`, `add`, `list`, `remove`, `rename`, `default`, `attach`, `detach`, `federate`, `unfederate`, `mirror-readonly`, `mirror-writable`, `record-origin`, `set-strategy`, `set-pull-strategy`, `set-sync`, `refresh`, `git-reconcile`, `git-gap`, `host-repo`, `guard`, `reindex`, `canonical`, `archive`, `restore`, `purge`, `archived`, `current`, `status`, `webhook`, `tracked-branch`, `set-cr-mode`, `set-calendar`, `set-trust`, `writers`, `set-path`. |
| `reconcile-links` | post | none | — | — | Link reconciliation pass. |
| `edges-backfill` | post | none | — | SH, RS | Backfill graph edges. |
| `backfill` | post | none | — | SH | Backfill jobs (`--batch-size`, `--concurrency`, `--resume`, `--fresh`, `--list`, `--keep-index`, `--max-errors`, `--max-rows`, `--source`, `--json`). |
| `reindex` | post | none | — | SH | Reindex targets (`printReindexHelp`, `commands/reindex.ts`). Flags include `--multimodal`. |
| `reindex-code` | post | none | — | RS | Reindex code index. Thin: none, but `maybeDelegateReindexCode` (serve delegate) first. |
| `reindex-search-vector` | post | none | — | — | Rebuild vector index. |
| `reindex-frontmatter` | post | none | — | — | Rebuild frontmatter index. |
| `watch` | post | refuse | — | SH, RS | Streams against a local engine; stdin-turn protocol (`WATCH_HELP`). Wakeshift `watch` routes elsewhere. |
| `wakeshift` | post | route | — | SH | Report-back switch. Thin: only `watch` routes (`watch_job`, `watch_write_request`, `watch_cron`). |
| `sweep` | post | refuse | — | SH, RS | Maintenance sweep (`--once`). Serve delegate (`sweep-delegate.ts`) when a PGLite serve holds the lock. |

#### 2.3 Maintenance, repair, health, brain state

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `doctor` | own | none | document | HELP, SLOW | Health checks. Section 3.8. |
| `status` | post | none | — (record) | HELP, SLOW | Brain status snapshot. Section 3.9. |
| `diag` | post | refuse | document | HELP, RO, SLOW | Diagnostic bundle. Flags: `--json`, `--budget-ms` (default 30000), `--query`. Every section has `elapsed_ms` and `status` (`ok`, `not_read`, `not_applicable`, `error`). |
| `orphans` | post | refuse | — | SH, SLOW | Orphan page report. |
| `repair` | post | refuse | — | SH | Repair kinds with dry-run/apply contract (`REPAIR_HELP`). Thin refusal: repairs publish coordinated writes. |
| `repair-jsonb` | pre | refuse | — | — | JSONB repair (Postgres). No help record. |
| `integrity` | pre | refuse | — | SH | `check`, `auto`, `review`, `reset-progress`. |
| `maintain` | post | none | — | SH | Maintenance modes (`--schedule`, `--unschedule` are engine-free, GBRA-438). Usage block in `commands/maintain.ts`. |
| `cache` | pre | route | — | SH | `stats`, `clear`, `prune`. Thin: `cache stats` routed (`cache_stats`). |
| `check-backlinks` | pre | none | — | — | Backlink integrity check. |
| `check-resolvable` | pre | none | — | SH | Resolvability check. |
| `lint` | pre | none | — | — | Brain lint (`src/commands/lint.ts`). Subcommands not checked. |
| `frontmatter` | pre | none | — | SH | `validate`, `generate`, `audit`, `install-hook`. Section 3.17. |
| `smoke-test` | pre | none | — | — | Smoke test. |
| `report` | pre | none | — | — | Report command. |
| `anomalies` | post | none | — | SH, SLOW | Anomalous cohorts (`--sigma`, `--lookback-days`). Also an op (dual). |
| `salience` | post | none | — | SH | Salience view (`--kind`). Also an op (dual). |
| `features` | post | none | — | SH | Brain features and recommendations. Baseline `features --json` keys: `brain_score`, `recommendations[]` (`id`, `command`, `pitch`, `auto_fixable`). |
| `feedback` | post | refuse | — | SH | Feedback records. |
| `storage` | post | refuse | — | SH | `status` (+ `storage-*` ops, op-backed). |
| `config` | post | refuse | — | SH | `show`, `get <key>`, `set <key> <value>`, `unset <key>` (`--pattern`). DB-connection keys are engine-free (`tryRunConfigEngineFree`, `main.ts:1987`). Section 3.12. |
| `backup` | own | none | — | SH | `status` (verdict + per-asset table, `--json`), `check` (force recompute). Exit 0 ok, 1 warn. Baseline shape in section 3.8 notes. |
| `beliefs` | post | route | document | SH, RS | `enable`, `disable`, `status`, `reconcile`, `backfill`. `--json` contract declared; `trust backfill --dry-run` is observational. |
| `trust` | post | refuse | document | SH, SKIP, OBS | `pages`, `facts`, `takes` (trust levels). Observational; `maybeDelegateTrust` (serve delegate) first. |
| `pages` | post | refuse | — | SH | `purge-deleted`, `purges`, `unpurge`, `unsearchable`, `ghosts`, `status`. Strict flags for `purge-deleted` (section 1.6). Brain-wide only; `--source` refused. |
| `quarantine` | post | route | — | SH | `list`, `clear`, `scan`, `release`, `drop`. Thin: `quarantine list` routed (`quarantine_list`). |
| `memory-proposals` | post | refuse | — | SH | Owner review of proposed timeline entries and links: `list`, `show`, `approve`, `deny`. Host-local, never an MCP op. |
| `edge-proposals` | post | refuse | — | SH | Relationship-contradiction proposals: `list`, `show`, `accept`, `reject`, `undo`, `date`, `retry`. Host-local. |
| `questions` | post | refuse | — | SH, RS | Pinned questions (`questions_*` ops, trusted-local dispatch). |
| `migrate` | post | refuse | — | SH | `--to postgres\|pglite` (graduation: plan, then `--yes --expect`), `embeddings --to <p:model>` (re-embed). Graduation routing in `commands/migrate-graduation.ts`. Exit 75 while graduation runs. |
| `retrieval-upgrade` | post | refuse | — | SH | Retrieval upgrade state machine (state labels `switched`, `disabled`, `suggested`, `live`, `corrupt`, `locked`, `completed`, `incomplete`, same as `migrate`). Shares `migrationCliArgumentError` flag checks with `migrate embeddings` (`flag-validation.ts:81`). |
| `models` | post | none | — | SH | Model catalog and checks (`src/commands/models.ts`; subcommands not checked). |
| `pricing` | post | refuse | — | SH | `pricing.overrides` writes (trusted-local only; a remote caller could declare $0). |

#### 2.4 Search, eval, retrieval quality, context

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `eval` | post | refuse | jsonSubcommands: `export`, `replay`, `gate` = ndjson | SH | 19 subcommands in the help list, plus `--qrels` mode. Section 3.11. |
| `bench` | pre | none | ndjson | SH | Retrieval benchmark (`bench-publish.ts`): `--baseline`, `--from`, `--to`, `--label`, `--limit`, `--source`, `--tool`, `--threshold-jaccard`, `--threshold-latency-multiplier`, `--threshold-top1`, `--force`. |
| `routing-eval` | pre | none | — | SH | Routing eval. |
| `claw-test` | pre | none | — | SH | Claw scenario test (`test/fixtures/claw-test-scenarios`). |
| `notability-eval` | post | none | — | — | `mine`, `review`, `help`. |
| `calibration` | post | none | — | RS | Calibration analysis. |
| `compile-context` | own | refuse | — | SH, RS (`--source`) | `claude-code`, `codex`, `openclaw`, `codex-global`, `hermes` targets; check-mode exit codes. Thin refusal: reads the LOCAL brain. |
| `decide` | own | refuse | — | SH | `status`, `probe`, `enable`, `disable`, `calibrate`, `qualify`, `calibrations`, `dataset`, `receipts`. Opens its own engine; help and key probe answer without a brain. |
| `whoknows` | post | none | — | SH | Expert ranking (`--explain`). Also an op (`find_experts`). |
| `brainstorm` | post | none | — | SH | Brainstorm command. |
| `lsd` | post | none | — | SH | Open-loop brainstorm variant. |
| `takes` | post | route | — | SH | `list`, `search`, `embed`, `add`, `update`, `supersede`, `resolve`, `remove`, `rebuild`, `propose`, `horizon`, `journal`, `scorecard`, `calibration`, `grades`, `revisit`, `extract`. Thin: list/search/add/update/supersede/resolve/scorecard/calibration routed (`thin-client-routing.ts`). |
| `think` | post | none | — | SH, RS | Think/synthesis with gather-only fallback. Dual: also an op. Thin: routes to remote `think` op (180 s timeout, `main.ts:~800`). Section 3.18. |
| `recall` | post | none | — | SH, RS | Recall (dual with op). `recall --since-last-run` cursor is a file; `--watch` polls. Thin: routed unless `--query`/`--budget-tokens` in-process. |
| `graph-query` | post | none | — | SH, RS | Graph query (dual op). Thin: engine-free. |
| `code-def` | post | refuse | — | RS | Symbol definition lookup. No MCP op (`command-table.ts` comment, pages thin audit). |
| `code-refs` | post | refuse | — | RS | Symbol references. No MCP op. |
| `code-callers` | post | refuse | — | RS | Callers. No MCP op. |
| `code-callees` | post | refuse | — | RS | Callees. No MCP op. |
| `conversation-parser` | post | none | — | SH | `list-builtins`, `validate`, `scan <slug>`. The pure subcommands run before connect in `routeEngineFreeSubcommands` (`main.ts:1985`); `scan` needs a brain. |
| `advisor` | post | refuse | — | SH | Advisor (dual with op). |
| `founder` | post | none | — | SH | Founder view. Thin: engine-free. |
| `onboard` | post | none | — | HELP | Onboarding flow (`--auto`, `--check`, `--explain`, `--history`, `--max-usd`, `--target-score`, `--json`). |
| `protocol` | pre | none | — | SH | Memory-verbs protocol doc (MEMORY_VERBS v1). |
| `errors` | pre | none | document | SH, RO | Error catalogue. |
| `schema` | pre | none | — | SH | 37 subcommands (`SCHEMA_SUBCOMMANDS`, `subcommands.ts`): `active`, `list`, `show`, `validate`, `use`, `detect`, `suggest`, `review-candidates`, `init`, `fork`, `edit`, `diff`, `graph`, `lint`, `explain`, `review-orphans`, `downgrade`, `usage`, `stats`, `cardinality-preview`, `sync`, `reload`, `add-type`, `remove-type`, `update-type`, `add-alias`, `remove-alias`, `add-prefix`, `remove-prefix`, `add-link-type`, `remove-link-type`, `set-extractable`, `set-expert-routing`, `scaffold-extractable`. Router. |

#### 2.5 Jobs (Minions), agents, autopilot, dream, upgrade and migrations

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `jobs` | post | route | — (record) | SH | 16 subcommands (`JOBS_SUBCOMMANDS`, `src/commands/jobs.ts:448-466`): `authorize-legacy`, `submit`, `list`, `get`, `wait`, `cancel`, `retry`, `delete`, `prune`, `stats`, `smoke`, `child-readiness` (internal), `run-child` (internal), `work`, `supervisor`, `watch`. Section 3.10. |
| `agent` | post | none | — | SH, EOO | `run` (submits a `subagent` job), `logs <job_id>`, `register` (pre-connect thin guard). Section 3.19. |
| `autopilot` | post | none | — | HELP | `--install [--target macos\|linux-systemd\|ephemeral-container\|linux-cron]`, `--uninstall`, `--status [--json]`, `pause [--reason]`, `resume`, `--inline`, `--no-worker`, `--interval`. Status, uninstall, pause and resume are engine-free (`main.ts:~2455`). Installs launchd, systemd, or crontab entries (see 4.1). |
| `dream` | own | refuse | document | SH, RS | Dream cycle. Subcommands: `retriage`, `reset-key <key>` (`--list`). Phases via `--phase` (for example `lint`, `patterns`, `synthesize`). Section 3.15. |
| `apply-migrations` | pre | refuse | document | HELP | Apply pending schema migrations. Section 3.16. |
| `upgrade` | own | none | — | SH, SKIP | `binary` (atomic self-update of the compiled binary from GitHub releases, Sigstore-verified), `bun`, `bun-link` (linked repo: `git pull && bun install`). Section 3.16. |
| `post-upgrade` | pre | none | document | SH, SKIP | Post-upgrade steps. Module scan finds the same `bun-link`/`bun`/`binary` labels as `upgrade`. |
| `check-update` | pre | none | — | SH, SKIP | `binary`, `bun`. Fetches `https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/CHANGELOG.md` and an alpha version URL (`src/commands/check-update.ts:77-131`). |
| `self-upgrade` | pre | none | — | SH, SKIP | Self-upgrade mode, channel, snooze and update cache (`src/core/self-upgrade.ts`). Usage in its own `--help`. |

#### 2.6 Serve, auth, access, MCP and connectors

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `serve` | post | refuse | — | HELP | MCP server: stdio (default) or `--http`. Section 3.7. |
| `auth` | pre | none | — | SH | Token and OAuth client management: `create`, `list`, `revoke`, `set-min-trust`, `permissions`, `register-client`, `rescope`, `rescope-client`, `rescope-token`, `revoke-client`, `clients`, `test`. Usage is the `default:` branch of `runAuth`. |
| `access` | post | refuse | — | SH | Per-member read access (GBRA-218). Subcommands: `add`, `kind`, `labelled-only`, `disable`, `enable`, `set`, `rm`, `list`, `link`, `unlink`, `links`, `source`, `remove`, `show`, `clear`, `reads-restricted`, `member`, `owner`, `members-read-lineage`, `serves`, `group`, `who-can-read`, `check`. Usage prints before the engine (SELF_HELP_WITHOUT_ENGINE). |
| `guests` | post | refuse | — | SH | Guest source set-up: `init`, `promote`, `grant-owner-clients`. Trusted local CLI only (GBRA-504). |
| `connectors` | post | none | — | SH | `providers`, `auth`, `status`, `sync`, `logout`. Usage in `commands/connectors/index.ts`. |

#### 2.7 Skills

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `bundled-skill` | pre | none | document | SH, RO, SKIP | Bundled skill inspection (read-only). |
| `skill-resolver` | pre | none | — | SH, SKIP | `skills index`, `skills resolve` (GBRA-377). Engine-free on every install shape. Hook lane shares the module (`src/core/skills/resolver/*`). |
| `skillify` | pre | none | — | SH | Create a skill from a brain or session (no subcommand labels found). |
| `skillpack` | pre | none | — | SH | About 35 subcommands (module scan): `list`, `scaffold`, `reference`, `pin`, `unpin`, `restore`, `status`, `sync`, `setup`, `migrate-fence`, `scrub-legacy-fence-rows`, `harvest`, `diff`, `check`, `health`, `search`, `info`, `registry`, `doctor`, `init`, `init-brain-pack`, `pack`, `endorse`, `remove`, `install`, `uninstall`, `source`, `dir`, `config`, `pages`. Restores and installs write host state. |
| `skillpack-check` | pre | none | — | SH | Skillpack consistency check. |
| `skillopt` | post | none | — | SH | Skill optimisation loop (help in `src/core/skillopt/help.ts`). |

#### 2.8 Capture, brain content and sessions

| Command | Phase | Thin | `--json` | Attributes | Subcommands / key flags / notes |
|---|---|---|---|---|---|
| `capture` | own (deferred) | none | — | SH, RS, DEF | Capture a thought: positional text, `--file`, `--stdin`, `--slug`, `--source`, `--force`, `--kind`, `--type`, `--who`, `--where`, `--what`, `--depth`, `--quiet`. Refuses binary content (`src/commands/capture.ts:369-384`). Section 3.14. |
| `forget` | own (deferred) | none | — | SH, DEF | Forget and purge family (usage printed before any engine). Section 3.14. |
| `call` | own (deferred) | refuse | — | DEF | Generic op invoker: `gbrain call <op> '<json>'`. Arbitrary `--param` names; exempt from flag validation. Section 3.14. |
| `append` | own | none | — | SH, RS | Append a page or text: `--file`, `--expect-tail`, `--expected-revision`, `--separator`, `--force`, `--request-id`, `--source`. Uses an upload session when the text is over one request. |
| `facts` | own | refuse | — | SH, RS | Facts relink to entity pages (`#5836`); trusted local CLI only. |
| `projections` | own | refuse | — | SH | Projections drain. Output modes: `human-tty`, `human-plain`, `json`, `quiet`. Refuses a resident-held PGLite brain before opening an engine (`#5401`). |
| `core` | post | none | — | SH | Always-loaded core memory: `list`, `show`, `status`, `add`, `remove`, `diff`, `ack`, `init`, `suggest`. Router (`ROUTERS.core`). |
| `loops` | post | none | — | SH, RS | Open loops: `list`, `show`, `done`, `drop`, `mute`, `unmute`. Router (`ROUTERS.loops`). |
| `waiting` | post | none | — | SH, RS | Open-loop waiting list (`runWaiting` in `loops.ts`). |
| `friction` | pre | none | — | SH | `log`, `render`, `list`, `summary`, `diff`. |

#### 2.9 Counts check

Reconciled against `src/cli/command-table.ts` after writing: all 132 records appear exactly once in the section 2 tables (checked by script that parses the table rows). Groups are by primary use; some commands also fit a neighbouring group.

---

### 3. Detailed sections for agent- and eval-critical commands

Evidence labels: `[code]` = read in source, `[fixture]` = from a test fixture or golden (path given), `[help]` = from the module's usage text.

#### 3.1 `init`

- Phase `pre-connect`, thin `none`, selfHelp, `--json` document (`command-table.ts:~157`). Module `src/cli/commands/init.ts` runs `runInit` (`src/commands/init.ts`). Runs before the terminator and opens its own engine: `engine.connect`, `initSchema`, `setConfig`, `getConfig`, `getStats`, `disconnect` [code `src/commands/init.ts`].
- Usage [help `src/commands/init.ts:1837-1880`]: `gbrain init [flags]`. Examples: `--pglite` (local, no API key), `--supabase` (interactive), `--url postgresql://...`, `--mcp-only --issuer-url ... --mcp-url ... --oauth-client-id ... --oauth-client-secret ...` (thin-client mode), `--prefer-postgres [--allow-docker]` (install ladder: env URL, Supabase token, local PG, docker, PGLite).
- Key flags [code, from the handler]: `--pglite`, `--supabase`, `--url`, `--local-postgres`, `--prefer-postgres`, `--allow-docker`, `--allow-create-db`, `--no-embedding`, `--embedding-model`, `--embedding-dimensions`, `--chat-model`, `--expansion-model`, `--search-mode`, `--schema-pack`, `--surface`, `--migrate-only`, `--mcp-only`, `--mcp-url`, `--issuer-url`, `--oauth-client-id`, `--oauth-client-secret`, `--content-root`, `--git`/`--no-git`, `--db-only`, `--path`, `--key`, `--non-interactive`, `--force`, `--skip-embed-check`, `--json`. Full registry: `src/core/cli-flag-registry.generated.ts` entry `init`.
- JSON document [fixture `test/fixtures/agent-contract/v1/journey/init-first-run.json`]: top-level `status` (`"success"`), `engine` (`"pglite"`), `path`, `pages` (0), `embedding_check` (`{ok, skipped}`), `content` (`{version, brain_id, source_id, source_incarnation, root, repository_kind, backup, status, stage, pending_actions[], owned_root, fresh_root_activation, root_identity}`), `notices[]` (each with `code`, `kind`, `why`, `fix`). Paths and UUIDs are placeholders in the fixture.
- Exit: `0` on success. Errors use the error-catalogue exit for their code (`migrations_running` is 75). The handler's own exit codes were not traced.
- Thin: `none` (init creates a local brain). The thin-client MCP-only form (`--mcp-only`) writes only config.

#### 3.2 `import`

- Phase `post-connect`, thin `none` (per record), `--json` document, `routes_source` true, curated help `src/cli/help/import.ts`.
- Usage [help]: `gbrain import <dir> [--source <id> | --source-id <id>] [--no-embed] [--workers <n>] [--fresh] [--include-gitignored] [--allow-noncanonical-root] [--log-noop] [--calls [--prefix <slug prefix>]] [--json]`.
- Engine calls [code, `src/cli/commands/import.ts`, `src/commands/import.ts`]: `engine.getConfig`, `setConfig`, `executeRaw`, `logIngest`. Uses `git rev-parse HEAD` (`execFileSync`, `src/commands/import.ts:1043`) for provenance. Also `--cached`/`--include-gitignored` flags suggest git file listing (not traced further).
- Exit: `1` if any file errors (`setCliExitVerdict(1)` when `importResult.errors > 0`, `src/cli/commands/import.ts`). Abort errors (`ImportAbortError`, preflight failures, such as the content-sanity hard-block) exit with the abort's exit code.
- Privacy-label notice is rendered to stderr unless `--json` (`src/cli/commands/import.ts`).

#### 3.3 `sync`

- Phase `post-connect`, thin `refuse` (hint: "sync runs on the host; use `sync_brain` MCP op or run `gbrain sync` on the host"), `--json` document, `routes_source` true, `slowRead` for `sync status`.
- Subcommands / verbs: `sync status [--source <id>]` (engine-bound read; no watchdog and no serve delegation, `main.ts:2340-2350`), `sync unblock`, `sync trigger` (runs inside a live serve over IPC, `maybeTriggerThroughServe`, `main.ts:~2375`). Plain `gbrain sync` runs the full pass.
- Flags [code]: `--source`, `--json`, `--no-embed`, `--timeout <dur>` (extends the hard deadline by a grace period, `src/core/sync-reconcile.ts:270-275`), `--hard-deadline <dur>` (out-of-band process watchdog that SIGKILLs at the deadline even when the event loop is starved, `prepareConnectedDispatch` in `main.ts`; a progress window from the env-derived stall setting, `resolveStallAbortSeconds`, lets a run that is still importing outlive the deadline), `--break-lock` (recovery named in the `sync_in_progress` refusal), `--retry-failed` (deprecated, `noteRetryFailedDeprecated`), `--help`.
- JSON: with `--json`, human logs go to stderr and stdout carries one JSON envelope [code `src/commands/sync.ts:452`]. Refusals with an agent-contract `fix` (for example `sync_not_applicable`, `writer_coordinator_required`) render through `writeCliError` (`src/cli/commands/sync.ts`). Golden shapes: `test/fixtures/goldens/sync/pass-outcomes.json` (keys: `delegated.continuation_job_id`, `delegated.drain{eta_seconds, outcome, passes, processed, rate_pages_per_min, remaining, stop_reason, waived, written}`, `delegated.incomplete`, `delegated.next{code, command, docs}`; `stop_reason` example `admission_paused`).
- Busy lock: `sync_in_progress` refusal with `reason: 'lock_busy'`, exit 1 [code `src/cli/commands/sync.ts`; exit-codes.txt `sync_in_progress 1`].
- Delegation order (`prepareConnectedDispatch`, `main.ts:2337`): sync-persistence delegate, then serve delegate (PGLite host brains, `LiveServeLockError` avoidance), then the engine connect.

#### 3.4 `export`

- Phase `post-connect`, thin `refuse`, selfHelp, `routes_source`. No `--json` on the record. Output is the brain written out as markdown files, not a JSON document.
- Flags [help/code, `src/commands/export.ts`, `src/cli/commands/export.ts`]: `--type`, `--source`, `--slug-prefix`, `--restore-only` (with `--source`, `--repo`, `--dir`, `--slug-prefix`), `--repo`, `--dir`, `--help`.
- Engine calls: `engine.transaction` [code `src/commands/export.ts`]. `runExport` also runs with no engine for `--help` (`SELF_HELP_WITHOUT_ENGINE`, `main.ts:131-134`).
- `eval export` is a different command (ndjson; section 3.11).

#### 3.5 `embed`

- Phase `post-connect`, thin `refuse` (hint: "embed runs on the host"), `--json` document, `routes_source`, startup `observational` (connects probe-only until consent, `main.ts:2525`).
- Flags [code `src/commands/embed.ts`, `src/cli/commands/embed.ts`]: `--dry-run`, `--stale`, `--slugs`, `--all`, `--source`, `--background`, `--priority`, `--batch-size`, `--yes` (cost consent), `--include-null-signature`, `--catch-up`, `--images`, `--held`, `--force`, `--facts` (delegates to fact embedding, `embed-facts-delegate.ts`, `main.ts:~2440`), `--embedding-model`, `--pace`, `--pace-max-concurrency`.
- Engine calls [code]: `countStaleChunks`, `listStaleChunks`, `listPages`, `getChunks`, `readPageSnapshot`, `listChunklessPagesWithContent`, `countChunklessPagesWithContent`, `listAllSources`, `transaction`.
- JSON: `--json` routes progress and cost lines to stderr. On failure it prints one v1 error envelope on stdout (`process.exit(writeCliError(e, 'embed', {json: true}))`, `src/commands/embed.ts:~1054`).
- Exit: embedding failures are exit 1 (`embedding_*` codes, `embedding_backfill_stalled`, all in exit-codes.txt). Cost-stop verdicts use `embedCostStopVerdict` [code]; whether that path uses `BUDGET_STOP_EXIT_CODE` (11) was not traced.

#### 3.6 `extract`

- Phase `post-connect`, thin `refuse`, selfHelp, `routes_source: '--source-id'` (its `--source` is the mode selector `fs|db`, not a source id).
- Modes [help `src/commands/extract.ts:843-865`]: `links`, `timeline`, `all`; with `--source fs` (files under `--dir <brain-dir>`) or `--source db` (database pages). Other forms: `--by-mention --source db`, `--by-mention --rebuild`, `--ner`, `--from-meetings`, `--prune-orphans` (timeline), `--stale`, `--retry-held`, `--catch-up`, `--infer-dates`, `--include-frontmatter`, `--workers`/`--concurrency`, `--type`, `--since`, `--dry-run`, `--json`, `--explain`.
- Engine calls [code]: `readPageSnapshot`, `readPageSnapshotsBatch`, `listAllPageRefs`, `listStalePagesForExtraction`, `countStalePagesForExtraction`, `markPagesExtractedBatch`, `markPagesAttendanceBlocked`, `getPage`, `getAllSlugs`, `addLinksBatch`, `transaction`, `executeRaw`.
- `extract --stale` is delegated to a live serve (`extract-stale-delegate.ts`) before connect.
- JSON: `--json` on `extract` is a flag in its help but the record has no `json` contract, so the stdout guard does not apply.

#### 3.7 `serve`

- Phase `post-connect`, thin `refuse` (hint: serve needs a local engine; thin clients use the remote MCP server), curated help `src/cli/help/serve.ts`, no `--json`, no selfHelp (curated help covers `--help`).
- Usage [help `src/cli/help/serve.ts`]:
  - `gbrain serve [--surface verbs|starter|full] [--advertise verbs|starter|full] [--access full|read-only] [--source-guard] [--stdio-idle-timeout <s>] [--stdio-member <id>] [--fail-fast] [--cli-socket]` (stdio, default)
  - `gbrain serve --http [--port <n>] [--bind <host>] [--public-url <url>] [--token-ttl <s>] [--enable-dcr] [--surface …] [--advertise …]`
- Flag list [help]: `--http`, `--surface` (env `GBRAIN_SURFACE` > `--surface` > config `mcp_surface` > `full` for stdio; `--http` ignores `GBRAIN_SURFACE`), `--advertise`, `--access`, `--source-guard`, `--stdio-idle-timeout` (0 = never), `--stdio-member`, `--fail-fast`, `--cli-socket` (Postgres only; private Unix socket under `$GBRAIN_HOME/.gbrain/run/`), `--port` (default 3131), `--bind` (default 127.0.0.1), `--public-url`, `--token-ttl` (default 3600), `--enable-dcr`, `--enable-dcr-insecure`, `--log-full-params`, `--suppress-bootstrap-token`, `--print-admin-token`.
- Thin client: bare `serve` is a stdio bridge to the remote brain and takes only `--surface`, `--advertise`, `--source-guard` (help text).
- Degraded mode (`connectCliOnlyEngine`, `main.ts:2498`): a `serve` with no brain, a missing brain, or an unreadable config answers in status-only mode instead of exiting; a Postgres connect failure starts a degraded engine that re-probes on each call. PGLite keeps die-on-startup. `GBRAIN_SERVE_DEGRADED=0|false` disables. `--fail-fast` exits non-zero with a classified envelope on stderr instead (`serve-fail-fast.ts`).
- Lifecycle: `serve` never runs teardown (`main.ts:1905-1906`); engine-graduation guard exits 75 while a run owns the brain (`graduation-serve-guard.ts`). Serve writes its own log through `installServeLogSink` (rotate and dedupe when stdout/stderr is a file).
- Hook CWD: `captureHookSessionCwd()` runs first for `serve` (`GBRAIN_HOOK_CWD`, `main.ts:303`).
- PGLite single-writer lock: while a serve holds the lock, other CLI commands that need the engine fail with `LiveServeLockError` or delegate over the serve IPC socket (sync, sweep, transcripts recent, persistence writes). This is why several commands have serve delegates.
- Exit: `69` (`SERVE_UNHEALTHY_EXIT_CODE`) for unhealthy exit; `75` during graduation.

#### 3.8 `doctor`

- Phase `pre-connect-own-engine` (the module opens its own engine, so it can report on a broken DB), thin `none`, `--json` document, curated help `src/cli/help/doctor.ts`, `slowRead` heartbeat `doctor checks` (not for `--remediate`/`--fix`).
- Flags [help `src/cli/help/doctor.ts`]: `--json`, `--fast`, `--tier ops|quick|standard|deep`, `--budget-ms <n>`, `--only <check>[,…]`, `--fix [--dry-run]`, `--remediate`, `--remediation-plan`, `--yes`, `--scope all|brain`, `--source <id>`, `--skills-dir <path>`, `--no-migrate`, `--locks`, `--probe`, `--probe-pglite`, `--index-audit`, `--content-audit`, `--include-repairs`, `--expect <…>`, `--max-usd <n>`, `--max-cost <n>`, `--target-score <n>`, `--max-jobs <n>`, `--no-embed`, `--resume <…>`, `--alert`.
- Output: `DoctorReport` (`src/commands/doctor.ts:194`), `schema_version: 2`:
  - `status`: `healthy` | `warnings` | `unhealthy`.
  - `health_score`: `100 − 20×fails − 5×warns`, floor 0 (legacy, byte-identical).
  - `brain_checks_score`, `category_scores` `{brain, skill, ops, meta}`.
  - `checks[]`: `{name, status: ok|warn|fail, message, category, details?, fix?, issues?, elapsed_ms?}` (`Check`, `src/commands/doctor.ts:146`).
  - Optional: `top_issues[]` (ranked, root cause before symptom), `alert` (`{level: none|act|unknown, items, unknown, docs}`), `engine` (`postgres|pglite`), `db_url_source`, `capped_by[]` (for example `embeddings_disabled`), `unknown_scores[]`, `unknown_count`, `tier`, `complete`, `unknown_sections[]`, `last_known_sections[]`, `elapsed_ms`, `budget_ms`.
- Shape examples [fixture]: `test/fixtures/goldens/doctor/json-pglite-fresh.json` (`args: ["doctor","--json","--skills-dir","<home>/skills"]`, `exit_code: 0`, report keys above), `json-postgres-unreachable.json`, `json-pglite-degraded.json`, `json-postgres-fresh.json`, `json-pglite-fast.json`. Baseline key paths [fixture `test/fixtures/agent-contract/v0.60.37-json-documents.json`, `doctor --json`, exit 0, 22 keys]: `$.brain_checks_score`, `$.category_scores.{brain,meta,ops,skill}`, `$.checks[].{category,details,message,name,status}`, `$.db_url_source`, `$.engine`, `$.health_score`, `$.schema_version`, `$.status`, `$.top_issues`.
- Exit: `0` when no `fail` check; `1` when any check fails (`src/commands/doctor.ts:551`). With `--alert`, the exit is the alert report's (`17` act, `18` unknown; `printAlertReport`, `doctor.ts:536`).
- Other `--json` docs in the same family: `doctor --locks --json` prints `{status: 'ok'|'blockers_found', blockers}` or `{status:'unavailable', reason:'no_engine'}` or `{status:'not_applicable', engine}` (`doctor.ts:660-682`).
- Backup coverage (`backup status --json`) has its own baseline [fixture, exit 1 in baseline]: `$.assets[].{detail, fix_argv, id, kind, state}`, 26 keys in total.
- Thin client: `doctor` is `none`, and `src/core/doctor-remote.ts` (`RemoteDoctorReport`) renders the remote MCP `run_doctor` result instead.

#### 3.9 `status` (and `stats`)

- Phase `post-connect`, thin `none`, curated help `src/cli/help/status.ts`, `slowRead` `the brain status snapshot` (not for `--funnel`). The record has no `json` contract (section 4.3).
- Usage [help]: `gbrain status [--json] [--section sync|cycle|locks|workers|queue|autopilot] [--fast | --deadline-ms <ms>]`, or `gbrain status --funnel [--json] [--enable | --delete]`.
- `--json` envelope [code `src/commands/status.ts:33-40`]: `{schema_version: 1, sync, cycle, locks?, workers?, queue?, autopilot?}`. Sections may be omitted (thin-client mode, `--section` filter, or a section-build failure).
- Thin client: engine-free. `status` routes sync and cycle through the `get_status_snapshot` MCP op, and locks and autopilot render as "local-only — N/A on remote brain" (`main.ts:2166-2172`, `status.ts` header).
- Exit: `0`, `1` or `2` from `runStatus` (`status.ts` ~`:896-930`, `{exitCode}` result).
- `stats` is not a CLI_ONLY command. It is an operation defined in `src/core/ops/admin.ts` (flags `--by`, `--collapse-aliases`, `--since`), so it is covered by the op-backed inventory, not this report.

#### 3.10 `jobs` (Minions)

- Phase `post-connect`, thin `route-then-refuse` (not in the refused set; `list`, `get`, `wait` engine-free over MCP, `stats` routed to `get_job_stats`, `supervisor status` local when the pid file is live, other subcommands refused with a hint), selfHelp (`jobs` appears in `SELF_HELP_WITHOUT_ENGINE`, `main.ts:~150`). The record has no `json` contract (section 4.3).
- Subcommands [code `src/commands/jobs.ts:448-466`, help `JOBS_HELP` at `jobs.ts:~150-200`]:
  - `authorize-legacy --ids <list> | --select "<expr>" [--expect <hash> --yes] [--json]`
  - `submit <name> [--params JSON] [--follow] [--priority N] [--delay Nms] [--max-attempts N] [--max-stalled N] [--max-waiting N] [--backoff-type fixed|exponential] [--backoff-delay Nms] [--backoff-jitter 0..1] [--timeout-ms Nms] [--lock-duration-ms Nms] [--idempotency-key K] [--queue Q] [--dry-run] [--yes] [--max-usd USD|off] [--redact-secrets]`
  - `list [--status S] [--queue Q] [--limit N] [--json]`, `list --finished-since ISO|CURSOR`, `list --group SPEND_GROUP`
  - `get <id> [--json]`, `wait <id> [--timeout 10m] [--json]` (exit 0 completed, 1 failed/dead/cancelled, 124 still running)
  - `cancel <id> | --group G | --select …`, `retry <id>`, `delete <id>`, `prune [--older-than 30d] [--dry-run]`
  - `stats [--queue Q] [--cluster-errors] [--json]`
  - `smoke [--sigkill-rescue] [--wedge-rescue]`
  - `watch [--json] [--follow] [--refresh-ms=N]`
  - `work [--queue Q] [--concurrency N] [--max-rss MB] [--health-interval MS] [--nice N] [--job-isolation inline|process]`
  - `supervisor [start] [--detach] [--json] [--concurrency N] [--queue Q] [--pid-file PATH] [--max-crashes N] [--allow-shell-jobs] [--cli-path PATH] [--max-rss MB] [--nice N] [--job-isolation inline|process]`; `supervisor status [--json] [--pid-file]`; `supervisor stop [--json] [--pid-file]`.
  - Internal: `child-readiness`, `run-child` (spawned by the job-isolation path with `CHILD_ENV` values; see `src/core/minions/job-isolation.ts`, `run-child.ts`).
- Output:
  - `stats --json` baseline [fixture `v0.60.37-json-documents.json`, exit 0, 15 keys]: `$.by_status`, `$.by_type`, `$.divergent`, `$.queue`, `$.queue_health.active`, and more.
  - `supervisor start --detach --json` returns `{event, supervisor_pid, pid_file}` [help].
  - `supervisor --json` (foreground) emits JSONL events; `supervisor stop` exits 0 only on a verified drain; exit 2 when another supervisor holds the PID lock [help `jobs.ts:213-229`].
  - `wait` exit codes as above.
- Engine: `MinionQueue` (`src/core/minions/*`), the worker registry; `jobs work` is a daemon. `jobs` runs in a local scope (`withLocalScope`) so the worker's AI calls use the process gateway (`jobs.ts:~470`).
- Startup: `jobs supervisor status` is `probeOnly` (`main.ts:2525`). `jobs` is excluded from the short-lived CLI marking so the in-process queue stays up for the worker (`main.ts:379`).

#### 3.11 `eval`

- Phase `post-connect`, thin `refuse` (eval routes for `whoknows` only), selfHelp, `jsonSubcommands: {export: 'ndjson', replay: 'ndjson', gate: 'ndjson'}`.
- Subcommands [help `src/commands/eval.ts:415-470`, dispatch `src/commands/eval.ts`]: `replay`, `retrieval-quality`, `gate`, `compare`, `run-all`, `brainbench`, `longmemeval`, `cross-modal`, `code-retrieval`, `brainstorm`, `whoknows`, `suspected-contradictions`, `trajectory`, `conversation-parser`, `chronicle`, `takes-quality` (`run|trend|regress|replay`), `export` and `prune`, `synthesize-concepts`. Plain `eval --qrels <path|json>` runs the retrieval evaluator, with `--config-a`, `--config-b`, `--strategy hybrid|keyword|vector`, `--rrf-k`, `--expand|--no-expand`, `--dedup-*`, `--limit`, `--k`.
- Engine-free paths (dispatch before connect, `routeEngineFreeSubcommands`, `main.ts:1985`): `cross-modal`, `run-all`, `takes-quality replay`, `brainbench`, `longmemeval`, `chronicle`, `synthesize-concepts`, `conversation-parser`. `whoknows` on a thin client. `longmemeval` and `brainbench` bring their own in-memory PGLite; `brainbench --llm/--decide` configure the gateway from config.
- Exit codes:
  - `brainbench`: `0` pass, `1` regression, `2` error or inconclusive [code `eval-brainbench.ts:403-420`; flag-validation exempt because CI reads the codes].
  - `gate`: `1` when thresholds are breached (`eval-gate.ts:554-558`, `gate_failed`); usage refusals exit 2 (`writeCliRefusal`/`usageError`).
  - `run-all`: `setCliExitVerdict` (`1` when a suite failed) [code `main.ts`].
  - `synthesize-concepts`: exits non-zero with `{ok:false, status:'not_implemented'}` (scaffold, `main.ts:2050-2054` region).
- ndjson output: `export` and `replay` and `gate` write one `{schema_version, ...row}` per line via `writeNdjsonLine` (`src/commands/eval-export.ts:149`). `replay` takes `--against FILE.ndjson` (required; error `not_found`/`parse_error`, `eval-replay.ts:457-490`) and `--mode balanced`. `export` takes `--since 7d|1h|30m` and `--tool query|search` (`eval-export.ts:63-77`).
- Fixtures: `test/fixtures/eval-baselines/`, `test/fixtures/conversation-formats/`, `test/fixtures/calibration/`.

#### 3.12 `config`

- Phase `post-connect`, thin `refuse` (hint: config operates on the host brain), selfHelp, no `json` record contract. Router `CONFIG_SUBCOMMANDS = ['show','get','set','unset']` (`subcommands.ts`, `bareHelpFirst`).
- `config get <key>`: prints the bare value to stdout and a line naming the plane on stderr (`[config] source: file plane (~/.gbrain/config.json)`) [code `src/commands/config.ts:934-950`]. Dotted keys resolve nested file values. `mcp.publish_wakeshift` is special-cased.
- `config get` for `self_upgrade.*` reads the file plane only; missing key exits 1 with `Config key not found: <key>` (`config.ts:661-672`).
- `config set <key> <value>`: arbitrary value strings (flag validation exempt). `config unset <key>` and `unset --pattern <prefix>`. `config show`.
- DB-connection keys are engine-free (`tryRunConfigEngineFree`, `main.ts:1987`) so `config set database_url` works while the database is down.
- Keys: the inventory `config-keys.txt` (502 lines) lists the keys read by the code.

#### 3.13 `sources`

- Phase `post-connect`, thin `route-then-refuse` (no MCP route in `thin-client-routing.ts`; refused unless a dispatcher branch handles the subcommand), selfHelp, `slowRead` for `sources status`.
- Subcommands [code `src/commands/sources.ts` case labels]: `add`, `archive`, `archived`, `attach`, `canonical`, `clear`, `connect`, `current`, `default`, `detach`, `federate`, `git-gap`, `git-reconcile`, `guard`, `harden`, `host-repo`, `inspect`, `list`, `mirror-readonly`, `mirror-writable`, `pull`, `purge`, `push`, `pushed`, `reconcile`, `record-origin`, `refresh`, `reindex`, `remove`, `rename`, `reset-upstream`, `resolve-path`, `restore`, `retry-held`, `rotate`, `set`, `set-calendar`, `set-cr-mode`, `set-path`, `set-pull-strategy`, `set-strategy`, `set-sync`, `set-trust`, `shared-skills`, `show`, `status`, `tracked-branch`, `unfederate`, `unharden`, `webhook`, `writer`, `writers`, `audit`, `reclone`, `demo company-brain`.
- Engine-free branches before the dispatcher: `sources inspect`, `sources connect` (probe-only), `sources demo company-brain` (`main.ts`, the `sources` branches before the `CLI_ONLY` dispatch), `sources pull --path <dir>` (DB-free durability pull for the harden cron, never opens PGLite).
- Persistence subcommands go through the deferred-persistence delegate: `writer`, `reconcile`, `add`, `remove`, `archive`, `restore`, `purge`, `set-path`, `reclone` (`main.ts:1933`). `sources remove|archive|purge default` is refused (usage error, exit 2, `persistence-delegate.ts:98-103`).
- `sources list --json` baseline [fixture, exit 0, 8 keys]: `$.sources[].{federated, id, last_sync_at, local_path, mirror_read_only, …}`.
- `sources remove default --json` baseline [fixture]: exit `1` with `error: "invalid_params"`. Current source uses usage exit `2` (see 4.3).

#### 3.14 `capture`, `forget`, `call`

- All three are `dispatchedBy: 'deferred-persistence'`: handled by `runDeferredPersistenceCommand` (`routeCliOnlyBeforeTable`, `main.ts:1916-1935`), not the table step. `capture` and `forget` are dual-lane (also operations `capture`, `forget`).
- Pipeline: the handler parses input, then a local write goes to the live owner through `maybeDelegateLocalOperation` (`src/core/persistence/local-client.ts`) or to the remote MCP server for thin clients; otherwise it connects a local engine lazily.
- `capture`: `"thought"` inline, `--file PATH`, `--stdin`, `--slug`, `--source`, `--force`, and type or kind flags. Refuses binary content (`capture.ts:369-384`). `--help` answers before any engine (`routeEngineFreeHelp`).
- Writes return exit `10` (`PENDING_WRITE_EXIT_CODE`) when admitted but pending; `--accept-pending` makes that exit 0 (`write-wait.ts`, `persistence-delegate.ts` comments). Pending receipts name a poll command (`pollCommand`).
- `forget`: usage for `forget` and the purge family is printed before any engine (`#5575 DX-11`).
- `call <op> '<json>'`: the generic op invoker. It takes arbitrary `--param` names, so flag validation is exempt. Thin: `refuse` with the hint "call dispatches against a local engine" (`main.ts:1756`). Exit 1 on a missing page (`page_not_found`, baseline `call get_page {"slug":"no-such-page"}`: `$.error`, `$.message`, `$.suggestion`, exit 1).

#### 3.15 `dream`

- Phase `pre-connect-own-engine`, thin `refuse`, selfHelp (both `dream --help` and `dream retriage --help`, `command-table.ts:~272`), `--json` document, `routes_source`. `dream` is in `SELF_HELP_WITHOUT_ENGINE` (`main.ts:~150`): the IRON RULE is that help never touches the engine.
- Subcommands: `retriage [flags]` (`--help` has its own usage) and `reset-key <key>` / `reset-key --list`. Default run: phases and budget.
- Flags seen in the handler and registry: `--phase`, `--once`, `--dry-run`, `--json`, `--input <file>`, `--from`, `--to`, `--date`, `--window`, `--source`, `--source-id`, `--drain`, `--pull`, `--dir`, `--limit`, `--list`, `--max-usd`, `--threshold`, `--audit-rejects`, `--cancel-unmatched`, `--reconcile-queue`, `--eval-run`, `--unsafe-bypass-dream-guard`, `--yes`, `--force`, `--install`.
- Baseline `dream --json` [fixture, exit 0, 32 keys, depth 2]: `$.brain_dir`, `$.duration_ms`, `$.phases[]` with `{details, duration_ms, pages_recomputed, …}`.
- Engine calls: `getConfig` [code `src/commands/dream.ts`]; the cycle itself lives under `src/core/cycle/`.
- Fixture: `test/fixtures/dream-budget-schema-v1.jsonl`.

#### 3.16 `apply-migrations`, `upgrade`, `post-upgrade`

- `apply-migrations`: phase `pre-connect`, thin `refuse`, `--json` document, curated help `src/cli/help/apply-migrations.ts`.
  - Usage [help]: `gbrain apply-migrations [--yes | --non-interactive] [--dry-run [--json]] [--list] [--mode always|pain_triggered|off]`; `--migration <vX.Y.Z> | --force-retry <vX.Y.Z> | --force-orchestrator | --force-schema | --force`; export-only: `--migration 0.53.0 --export-db-only --content-root <path> [--export-source <id>] --dry-run --json`.
  - Other flags: `--skip-verify`, `--require-db`, `--host-dir`, `--no-autopilot-install`, `--confirm-quiesced`, `--backup-confirmed`, `--acknowledge-no-backup`, `--accept-reviewed-inventory <…>`, `--force-all`.
  - Exit codes [exit-codes.txt]: `3` (`confirmation_required`, consent needed), `75` (`migrations_running`), `13` (`pending_verify`), `14` (`bootstrap_cleanup_pending`), `1` (general). Post-upgrade and `doctor` both point users here (`fix.argv: ['gbrain','apply-migrations','--yes']`, `test/terminal-schema-missing-6904.test.ts`).
- `upgrade`: phase `pre-connect-own-engine`, thin `none`, `skipStartupHooks`, selfHelp.
  - Subcommands: `binary`, `bun`, `bun-link` [module scan].
  - Flags [registry]: `--check`, `--check-downgrade`, `--yes`, `--restart-only`, `--swap-only`, `--stop-mcp`, `--no-restart`, `--no-autopilot-install`, `--ff-only`, `--refs`, `--tags`, `--channel`, `--changed`, `--catch-up`, `--concurrency`, `--backup-confirmed`, `--acknowledge-no-backup`, `--confirm-quiesced`, `--confirm-relocated-root`, `--content-root`, `--json`, `--markdown`, `--no-bun-floor-check`, `--quiet`, `--non-interactive`.
  - Binary path: `runBinarySelfUpdate` (`src/core/binary-self-update.ts`) downloads a release from `https://github.com/garrytan/gbrain/releases`, checks Sigstore, and swaps the binary atomically. Failure prints the releases URL and `phase: 'binary-self-update'` (`upgrade.ts:136-193`).
  - Bun path: a linked repo prints `git pull && bun install` guidance (`upgrade.ts:110`). Restart after upgrade runs `spawnSync('gbrain', ['upgrade','--restart-only', …])` with `GBRAIN_SKIP_STARTUP_HOOKS=1` and a 900 s timeout (`upgrade.ts:340`).
  - Engine calls [code]: `connect`, `initSchema`, `getConfig`, `setConfig`, `disconnect`.
  - Registry lists `--no-bun-floor-check`, which implies the Bun-floor check is on by default (not traced further).
- `post-upgrade`: phase `pre-connect`, `--json` document, `skipStartupHooks`. Runs the steps after an upgrade (engine migrations). Exact steps were not traced.

#### 3.17 `frontmatter validate`

- `frontmatter` is `pre-connect`, thin `none`, selfHelp. No `json` on the record, though `validate --json` exists (section 4.3).
- Usage [code `src/commands/frontmatter.ts` header and usage block]:
  - `gbrain frontmatter validate <path>... [--json] [--importable] [--fix [--include-ambiguous]] [--dry-run]`
  - `gbrain frontmatter validate --stdin [--path <source-relative path>] [--importable] [--json]`
  - `gbrain frontmatter validate --staged [<path>...] [--importable] [--json]`
  - `gbrain frontmatter generate <path> [--fix] [--dry-run] [--json] [--include-catch-all]`
  - `gbrain frontmatter audit [--source <id>] [--json]`
  - `gbrain frontmatter install-hook [--source <id>] [--force] [--uninstall]`
- Validation mode: strict producer rule by default (any error fails); `--importable` relaxes to the importer's rule [code header]. `--staged` reads git blobs from the index (`git` shell-out).
- Exit: non-zero on errors; the exact exit code is in the handler [not traced].
- `install-hook` writes a git hook into the brain checkout (host-local).

#### 3.18 `think`

- Phase `post-connect`, thin `none`, selfHelp, `routes_source`. Dual lane: `think` is also an operation (`cliOnlyNameAlsoAnOp`, golden `membership-sets.json`).
- Thin client: dispatcher routes to `runThinkCli`, which calls the remote `think` op via `callRemoteTool` (180 s timeout, `main.ts:~800` `think` special case). `--save` and `--take` stay server-gated; the CLI warns on thin clients.
- Local: `runThink` plus `persistSynthesis`. `--save` and `--take` are honored on the local CLI (`remote=false`) [module header `src/commands/think.ts`].
- The module header says "Reads ANTHROPIC_API_KEY from the env; degrades to gather-only output with a warning if missing." That line may predate the current AI gateway and was not checked against the code. Treat it as unverified.

#### 3.19 `agent run` (and `logs`, `register`)

- Phase `post-connect`, thin `none`, selfHelp, `end_of_options: true` (a bare `--` ends flags, so `agent run -- --help` submits the literal prompt).
- Usage [code `src/commands/agent.ts:87-117`, header]: `gbrain agent run [flags] <prompt>`, `gbrain agent logs <job_id> [--follow] [--since <spec>]`, `gbrain agent register <name> --harness <h> [flags]`.
- `run` submits a `subagent` job with `queue.add('subagent', data, submitOpts, …)` (`agent.ts:336`, also `:391`, `:405` aggregator and `:431` fan-out children). Without `--follow` (or with `--detach`) it prints the job id and exits [code `agent.ts:~348`]. Fan-out: `--fanout-manifest`; parent and aggregator jobs are linked.
- Flags [registry]: `--follow`, `--no-follow`, `--detach`, `--model`, `--max-turns`, `--timeout-ms`, `--tools`, `--subagent-def`, `--source`, `--preset`, `--harness`, `--mcp-only`, `--http`, `--port`, `--since`, `--flags`, `--show-token`, `--reissue`, `--scopes`, `--allow-old-serve`, `--federated-read`, `--json`.
- `register` thin guard (pre-connect, `main.ts:~1960`): refuses with `{ok:false, reason:'thin_client', message}` on `--json` (else stderr), exit 1. A live PGLite serve holds the lock: refused with `pglite_live_serve` and the serve pid (exit 1).
- `logs <job_id>`: reads the job's log stream; `--follow` tails.

#### 3.20 `hook` and the PGLite-specific commands

- `hook`: engine-free by construction (`src/commands/hook.ts` header, plan D5): config from `loadConfig()`, per-turn context from the serve resolve IPC socket. Events: `session-start`, `user-prompt`, `stop`, `session-end`, `compact`. Two fast paths skip the dispatcher: `user-prompt` and `session-start` under `GBRAIN_HOOK_LANE=skill-resolver` (`src/cli.ts:27-46`). `GBRAIN_HOOKS=0` disables all. `hook` never enters the thin-client refused set (ENG-2). Startup hooks are skipped (`skipStartupHooks`).
- `pglite-repair`: diagnose and repair a torn-WAL PGLite data dir in place. Never connects an engine. `--dry-run` read-only. Flags `--yes`, `--expect`, `--legacy-lock`, `--path`, `--json`. Auto-repair runs in `PGLiteEngine.connect()` on `wasm-abort` unless `GBRAIN_PGLITE_WAL_REPAIR=off`.
- `reinit-pglite`: last-resort width change for pgvector (PGLite cannot `ALTER COLUMN TYPE vector(N)`). Moves the datastore to `<path>.bak`, re-inits at the new width, re-syncs the repo. DB-only pages and `remember` facts are not carried over. Turning embeddings on for a keyless brain uses in-place enablement instead (`embeddings enable`).
- `engine status [--json] [--probe]`: which engine and URL source, engine-free.
- `db-repair`: Postgres only, engine-free, diagnose-only by default. Tiered consent: `--yes` and `--apply-rewrites` for config rewrites; `--undo-last-rewrite`.

---

### 4. Contract risks and open questions for the Rust port

#### 4.1 Shell-outs, installers and self-upgrade (portability)

| Area | What gbrain does (evidence) | Port consideration |
|---|---|---|
| Service installers (`autopilot`) | `--install` writes a launchd plist (macOS), a systemd user unit (`linux-systemd`), a crontab line (`linux-cron`), or an ephemeral-container target. Runs `launchctl bootout`/`load`, `systemctl --user is-system-running` and `disable --now`, and edits crontab (`src/commands/autopilot.ts:629`, `:677`, `:723-725`, crontab refs). | Platform-specific. Decide whether v1 supports installing services or only prints the unit/plist for the user. `autopilot --status` and `--uninstall` must stay engine-free (`main.ts` note at autopilot dispatch). |
| `bootstrap` | Uses `crontab` and `Bun.spawn` (`src/commands/bootstrap.ts`). | Same as above. |
| `setup`, `connect` | `Bun.spawn` and `execFileSync` (`src/commands/setup.ts`, `src/commands/connect.ts`). `setup` may run `bun install` (`setup.ts` grep). | Harness wiring writes host config files for Claude Code, Codex and others. Keep the file formats byte-compatible or the harness breaks. |
| `upgrade binary` | Downloads from `https://github.com/garrytan/gbrain/releases`, verifies a Sigstore chain, and swaps the binary atomically (`src/core/binary-self-update.ts`, `upgrade.ts:136-193`). | A Rust binary cannot replace itself through the Bun path. Either reimplement the same release/verify/swap flow for the Rust artifact or retire `upgrade binary`. |
| `upgrade bun`, `bun-link` | `git pull && bun install` guidance for a linked repo; `spawnSync('gbrain', ['upgrade','--restart-only', …])` after upgrade (`upgrade.ts:110`, `:340`). | Bun-only. Likely not ported. |
| `check-update`, startup marker | Background `check-update --refresh-cache` detached spawn; fetches `raw.githubusercontent.com/.../latest-stable/CHANGELOG.md` and an alpha version URL (`check-update.ts:77-131`, `main.ts:196`). | Port the cache-read marker and the version check; the detached spawn needs a Rust equivalent. Respect `GBRAIN_SKIP_STARTUP_HOOKS`. |
| `git commit-push` | Pushes with the host's git credentials (`src/commands/git.ts` header; `execFileSync`). | Must use the host `git` binary or an equivalent. Concurrency protocol lives in `src/core/git/commit-push.ts`. |
| `hook` git reads | `git -C <root> status --porcelain`, `branch --show-current`, `rev-list --count origin/<b>..HEAD`, `remote get-url origin` (`src/commands/hook.ts:766-904`). | The stop/session-end hook depends on git output format. Port the exact commands or the exact output semantics. |
| `import` provenance | `git -C <dir> rev-parse HEAD` (`src/commands/import.ts:1043`). | Returns the git HEAD; the Rust port needs the same value. |
| `frontmatter --staged`, `install-hook` | Reads git index blobs; writes a hook into the brain checkout. | Git-dependent. |
| `sources` git modes | `git-reconcile`, `git-gap`, `guard`, `mirror-readonly`, `webhook`, `harden` (`src/commands/sources.ts`). | Largest git surface in the CLI. Scope it in the sources report. |
| Bun runtime gate and cwd `.env` | `exitOnUnsupportedBun` (`src/core/runtime-version.ts:64`); cwd `.env` quarantine and `~/.gbrain/.env` load in `runCliPreflight` (`main.ts:290`). The `init` journey notice mentions a session directory's `bunfig.toml` and `.env` never loading (`test/fixtures/agent-contract/v1/journey/init-first-run.json`). | Rust has no Bun gate. Keep the `.env` precedence (cwd quarantine, then `~/.gbrain/.env`) since agents rely on it. |
| `hook` fast lane | `GBRAIN_HOOK_LANE=skill-resolver` plus `hook user-prompt\|session-start` (`src/cli.ts:27-46`). | Harness-facing contract. Must keep the env var and argv shape. |

#### 4.2 PGLite-specific commands and storage

| Command / mechanism | Evidence | Question for Rust storage |
|---|---|---|
| `pglite-repair` | Repairs torn-WAL PGLite data dir in place; never connects an engine (`src/commands/pglite-repair.ts` header). Auto-repair on `wasm-abort` in `PGLiteEngine.connect()`, disabled by `GBRAIN_PGLITE_WAL_REPAIR=off`. | Only meaningful if the Rust engine uses PGLite files. If not, drop the command and the env var. |
| `reinit-pglite` | Last-resort width change for pgvector (`vector(N)`), moves the datastore to `<path>.bak`; DB-only pages and `remember` facts are lost (`src/cli/commands/reinit-pglite.ts`). | Equivalent for Rust: a re-embed or re-create. Decide whether the destructive-warning text is part of the contract. |
| Single-writer lock | A live `gbrain serve` holds the PGLite lock. Other commands get `LiveServeLockError` or delegate over the serve IPC socket: `sync`, `sweep`, `transcripts recent`, persistence writes, `extract --stale`, `embed --facts`, `reindex-code`, `trust`, `agent register` guard (`main.ts:1916`, `:2337` onward; `probeLivePgliteHolder`). | Biggest architectural point. If Rust uses a server-side store with multi-process access, the IPC delegates may be unnecessary. If it keeps single-writer embedded storage, the IPC protocol (`src/core/persistence/ipc.ts`, `src/core/serve-invocation.ts`) becomes part of the port. |
| `engine status` | Reports engine kind and URL source, engine-free (`src/commands/engine-status.ts`). Used in the help golden. | Keep the output shape for agents. |
| `migrate --to postgres\|pglite` | Graduation between engines. Exit 75 while a run owns the brain; exit 11 for drain timeout (`graduation_drain_timeout`); `graduation-serve-guard.ts`. | Only needed if both engines are supported. Decide whether Rust supports graduation at all. |
| `serve --cli-socket` | Postgres only; answers CLI search/query/get/recall over a Unix socket in `$GBRAIN_HOME/.gbrain/run/` (`serve.ts` help). | Optional optimisation. |
| `init` engine ladder | `--pglite`, `--supabase`, `--url`, `--prefer-postgres` (env URL, Supabase token, local PG, docker, PGLite). | The ladder includes PGLite as the default. Rust v1 may support only some rungs; the choice changes first-run output. |

#### 4.3 Contract drift and gaps between the table and actual stdout

These are facts the Rust port should not infer from the record table alone:

1. Commands that print JSON without a `json` record field (so no stdout guard, no `json_document_missing` safety, and no `--json` declaration in the table): `status` (`schema_version: 1` envelope), `jobs` (`stats`, `list`, `get`, `wait`, `watch`, `supervisor --json`), `config` (`get` bare value only; no `--json` on `get`), `frontmatter validate --json`, `backup status --json` (baseline exit 1), `bootstrap verify --json`, `connect --json`, `google status --json` (baseline exit 1), `autopilot --status --json`, `sources list --json`, `features --json`, `call` (op output). Use `test/fixtures/agent-contract/v0.60.37-json-documents.json` for key paths (it covers doctor, backup, jobs, sources, autopilot, google, features, dream, call).
2. Baseline exit codes are older than current code. The baseline (`v0.60.37-json-documents.json`, captured at v0.60.37.0) records `sources remove default --json` as exit 1 with `error: "invalid_params"`. Current code refuses with a usage error (exit 2, `src/commands/persistence-delegate.ts:98-103`), and `exit-codes.txt` maps `invalid_params` to 2. Treat the baseline as stale for exit codes; regenerate it against current master before the port relies on it.
3. Records that declare `--json` but whose subcommands differ (`eval`) are pinned per subcommand by `jsonSubcommands`. Other per-subcommand JSON shapes (`jobs`, `sources`, `takes`, `beliefs`) are not declared.
4. Help text is hand-written TypeScript template strings (no generator). Top-level help is pinned by `test/fixtures/goldens/cli/help-and-errors.json`; per-command help is not golden-pinned except through the help-gate tests (`test/cli-help-no-side-effects-*.serial.test.ts`).
5. `CLI_FLAG_REGISTRY` is over-inclusive (help-text mentions count, file header) and fails open when a command is missing. It is good for "unknown flag" detection, not for an exact list of accepted flags. Use the handler source for exact flags.
6. Exempt from unknown-flag validation: `call`, `config`, `jobs submit`, `eval brainbench` (`src/cli/flag-validation.ts:70-75`). Keep the exemptions; CI reads brainbench exit 0/1/2.
7. Dual-lane commands (CLI_ONLY and also an operation): `capture`, `forget`, `sync`, `orphans`, `salience`, `anomalies`, `advisor`, `whoknows`, `transcripts`, `think`, `recall`. For each, the CLI handler and the MCP op may differ (the CLI reads its own flags). The `membership-sets.json` golden lists them as `cliOnlyNameAlsoAnOp`.
8. Phase ordering is contract. `test/fixtures/goldens/cli/dispatch-phase.json` and `membership-sets.json` pin: help before flag validation, flag validation before connect, thin-client guard before the table step, `agent register` guards before connect, and `bootstrap`/`hook` never in the thin-client refused set (ENG-2).
9. Engine-free commands are contract. 45 records answer `--help` without a brain (`SELF_HELP_WITHOUT_ENGINE`), and several run with no brain at all (`init`, `setup`, `hook`, `bootstrap` except `verify`, `pglite-repair`, `db-repair`, `engine status`, `eval` no-DB subcommands, `conversation-parser` pure subcommands). `test/cli-help-without-brain.test.ts` runs the CLI with an empty `GBRAIN_HOME` and requires exit 0 plus real help.

#### 4.4 Open questions for the main agent

1. Scope for the first version of the Rust port. Suggested tiers:
   - P0 (agent and eval contract): `init`, `import`, `sync`, `export`, `embed`, `extract`, `serve` (stdio and `--http`), `doctor`, `status`, `jobs` (submit, list, get, wait, work, stats), `eval` (export, replay, gate, brainbench, plus `--qrels`), `capture`, `forget`, `call`, `dream`, `agent run`/`logs`, `hook`, `frontmatter validate`, `apply-migrations`, `config get`/`set`, `sources list`/`add`/`status`, `access check`.
   - P1: `setup`, `connect`, `bootstrap`, `mcp grant`/`verify`, `pages`, `takes`, `memory-proposals`, `edge-proposals`, `core`, `loops`, `auth`, `diag`, `backup status`.
   - P2 or retire: `autopilot` installers, `upgrade` (Bun paths), `self-upgrade`, `check-update`, `pglite-repair`, `reinit-pglite`, `skillpack` family, `integrations`, `migrate` graduation.
2. Keep Bun-era `--help` text byte-identical, or accept new wording? Golden tests pin top-level help only.
3. PGLite data-dir compatibility: does Rust need to open existing PGLite brains (a migration step), or is migration out of scope?
4. Job isolation. `jobs work --job-isolation process` and `supervisor` spawn child processes that run `jobs run-child` with env-passed paths. If Rust keeps this, the child entry point and the env contract (`CHILD_ENV`, `src/core/minions/job-isolation.ts`) must be kept.
5. Whether `think` keeps the `ANTHROPIC_API_KEY` behavior described in its module header (possibly stale; see 3.18).
6. Git behavior: call the host `git` binary (matches current semantics) or use a library. The `hook` status and `git commit-push` outputs must match.
7. Whether the ~27 CLI_ONLY records without `selfHelp` (for example `publish`, `lint`, `report`, `smoke-test`, `reindex-*`, `code-*`, `repos`) need the generic one-line stub or real help. Their `--help` path was not traced in detail.
8. `GBRAIN_*` env vars read by the CLI preflight and dispatch (for example `GBRAIN_HOME`, `GBRAIN_SKIP_STARTUP_HOOKS`, `GBRAIN_HOOKS`, `GBRAIN_ENFORCED_MEMBER`, `GBRAIN_HOOK_LANE`, `GBRAIN_SERVE_DEGRADED`, `GBRAIN_PGLITE_WAL_REPAIR`, `GBRAIN_SURFACE`, `GBRAIN_HOOK_CWD`, `GBRAIN_NICE`) are part of the agent contract. A full list was not compiled.

#### 4.5 Not verified in this pass

- Running the CLI (Bun version gate, section 0 note). All behavior is from source and fixtures.
- Exact exit codes for `init`, `export`, `frontmatter validate`, `status`, `serve` subcommands, `setup`, `connect`, `bootstrap`, `skillpack`, and most maintenance commands. The per-code mapping in `exit-codes.txt` applies.
- Subcommand lists for `models`, `lint`, `check-backlinks`, `smoke-test`, `report`, `publish`, `reindex-*`, `skillify`, `skillopt`, `notability-eval`, `skillpack-check`, `repos` beyond the module scan.
- Line numbers marked `~` in this document are approximate; the function names next to them are exact.

---

### 5. Evidence index

Source (in gbrain (`github.com/garrytan/gbrain`)):

- Command table and records: `src/cli/command-table.ts` (records `:148`, `CLI_ONLY` `:459`, `CLI_ONLY_SELF_HELP` `:466`, `THIN_CLIENT_REFUSED_COMMANDS` `:483`, `STARTUP_HOOK_SKIP_COMMANDS` `:492`).
- Dispatcher: `src/cli/main.ts` (`main` `:289`, `printSelfHelpWithoutEngine` `:177`, `SELF_HELP_WITHOUT_ENGINE` `:131`, `maybeEmitUpdateMarker` `:196`, `printCliOnlyHelp` `:789`, `cliOnlyFlagArgs` `:1301`, `refuseThinClient` `:1811`, `THIN_CLIENT_REFUSE_HINTS` `:1755`, `CLI_DISPATCH_CONTEXT` `:1835`, `dispatchPreConnectCommand` `:1849`, `dispatchConnectedCommand` `:1857`, `handleCliOnly` `:1881`, `routeCliOnlyBeforeTable` `:1916`, `routeEngineFreeSubcommands` `:1985`, `routeEngineFreeHelp` `:2184`, `runReadOnlyTimeoutDispatch` `:2274`, `prepareConnectedDispatch` `:2337`, `connectCliOnlyEngine` `:2498`, `connectEngine` `:2705`, `completeEngineStartup` `:2743`).
- Entry: `src/cli.ts` (`cliFastPath` `:27`, `runFastPath` `:60`, entry `:67-88`).
- Flags: `src/cli/flag-validation.ts` (`validateCommandFlags` `:77`), `src/cli/flag-equals.ts`, `src/cli/strict-args.ts` (`STRICT_SUBCOMMANDS` `:41`), `src/core/cli-flag-registry.generated.ts`, `scripts/generate-flag-registry.ts`.
- Help: `src/cli/top-help.ts` (`printHelp` `:8`), `src/cli/subcommands.ts` (`ROUTERS` `:49`, grammar header), `src/cli/router-help.ts` (`printRouterHelp` `:35`), `src/cli/help/render.ts` (`printCuratedHelp` `:50`), `src/cli/help/validate.ts` (`curatedFlagError` `:33`), `src/cli/help/{apply-migrations,autopilot,diag,doctor,import,onboard,serve,status}.ts`.
- JSON and errors: `src/cli/json-guard.ts` (`agentJsonGuardMode` `:16`), `src/core/cli-force-exit.ts` (`jsonRequested` `:914`, `writeJsonDocument` `:928`), `src/cli/cli-error.ts` (`writeCliError` `:53`, `exitCliError` `:89`, `usageError` `:122`, `unknownFlagError` `:137`), `src/core/agent-output.ts` (`AgentEnvelope` `:99`, `renderCliError` `:868`), `src/core/error-catalogue.ts`, `src/core/exit-codes.ts`.
- Runtime gate: `src/core/runtime-version.ts` (`exitOnUnsupportedBun` `:64`).
- Deferred persistence: `src/commands/persistence-delegate.ts` (`runDeferredPersistenceCommand` `:91`), `src/commands/thin-client-routing.ts`.
- Handlers cited: `src/commands/{init,import,sync,export,embed,extract,serve,doctor,status,jobs,eval,config,sources,capture,dream,upgrade,apply-migrations,frontmatter,think,agent,hook,git,bootstrap,setup,connect,check-update,autopilot}.ts`, `src/cli/commands/*.ts` (thin wrappers), `src/commands/doctor.ts` (`Check` `:146`, `DoctorReport` `:194`), `src/commands/eval-export.ts`, `src/commands/eval-gate.ts`, `src/commands/eval-brainbench.ts`, `src/commands/eval-replay.ts`.
- Infrastructure note: `src/cli/command-table.ts` comment about `bun build --compile` autoload (`scripts/check-compile-autoload.sh`).

Fixtures and tests (in gbrain `test/`):

- `fixtures/agent-contract/v0.60.37-json-documents.json`: JSON key paths for doctor, backup, jobs stats, sources list, autopilot status, google status, features, dream, call. Exit codes as of v0.60.37.0 (stale, see 4.3).
- `fixtures/agent-contract/v1/journey/init-first-run.json`, `status-only-missing-brain.json`, `caller-mistake.json`, `recall-degraded.json`, `status-only-lock-held.json`: envelope and init shapes.
- `fixtures/agent-contract/v1/*.json`: error envelope, notices, receipts, withdrawn refusal, json fallback.
- `fixtures/goldens/doctor/*.json`: `json-pglite-fresh`, `json-pglite-fast`, `json-pglite-degraded`, `json-postgres-fresh`, `json-postgres-unreachable`, `json-postgres-unreachable-fast`, `content-pglite-json`, `hot-checks-*-json`.
- `fixtures/goldens/cli/*.json`: `help-and-errors` (top-level help), `membership-sets` (CLI_ONLY sets, dual-lane list), `dispatch-phase` (per-command phase, thin mode, switch case), `thin-client-cases` and `thin-client-routing`, `engine-free-db-down`, `tools-json`, `literal-imports`.
- `fixtures/goldens/sync/pass-outcomes.json`: sync delegated outcome shape.
- `fixtures/goldens/jobs/handler-registry.json`, `fixtures/goldens/setup/fresh-setup-migration-ledger.json`.
- Tests named in this report: `test/cli-command-table.test.ts`, `test/cli-flag-validation.test.ts`, `test/cli-help-without-brain.test.ts`, `test/cli-help-no-side-effects-{2,3,4}.serial.test.ts`, `test/hook-command.serial.test.ts`, `test/terminal-schema-missing-6904.test.ts`, `test/doctor-alert-w4.test.ts`, `test/fix-routing.test.ts`, `test/persistence-file-import.test.ts`, `test/thin-client-contract-skew.test.ts`.

Inventory (in `docs/research/rust-engine/data/`): `cli-commands-and-flags.txt` (flags per public command), `ops-summary.tsv` (204 ops; CLI_ONLY cross-check), `exit-codes.txt` (error code to exit code).



# Part C. Which commands agents and evals use

Source: [agent-and-eval-usage.md](agent-and-eval-usage.md) section 3. Classification rules:

### 3a. Rules

Each command gets one class by its primary purpose. Eval use and agent references are separate columns, so a reader can see a dependency without it changing the class.

- **agent-core**: a verb in the 7-tool verbs surface, or a memory-loop op named in `src/mcp/instructions.ts` (`search`, `query`, `get_page`, `put_page`, `remember`, `recall`, `entity`, `forget`, `context_pack`, `volunteer_context`, `whoami`, `get_backlinks`, `request_tools`, `memory_conversation_mode`), plus CLI names that map to those ops or to `serve` and `call`. Only memory and retrieval operations an agent calls during a task.
- **agent-occasional**: an agent calls it in a specific workflow (skills, starter surface, or instructions), not in the everyday loop: ingest, takes, skills, storage, graph, insights, transcripts.
- **admin/maintenance**: operator tooling (repair, reindex, upgrade, migrations, jobs, sources, config, doctor, backup, sync, export/import, pricing, storage administration). Agents may run some of these as checks; that does not make them agent-core.
- **setup/install**: bring-up and host wiring (`init`, `setup`, `bootstrap`, `engine`, `connect`, `auth`, `creds`, `providers`, `google`, `remote`, `mcp`, `onboard`, `integrations`, skillpack install).
- **dev/eval-only**: benchmarks, eval runners, routing/skillpack checks, smoke tests.
- **hidden/internal**: harness-invoked (`hook`), aliases (`get_links`, `link-add`, `link-rm`), plumbing with no agent or skill references (`conversation-parser`, `compile-context`, `protocol`, `founder`).
- **MCP classes**: `hidden/internal` = not in the public contract (18 ops; CLI-only or local-only). `agent-core` = verbs or instruction-named ops. `agent-occasional` = starter surface, or any skill/doc/instruction/eval reference. `admin/maintenance` = everything else.

### C.1 CLI commands (220)

Columns: skills/ = refs in `skills/` excluding `migrations/`; migration = refs in `skills/migrations/`; agent docs = refs in templates and the top-level agent guides; plugin/instr = refs in `plugin/skills/` (mirror) plus `src/mcp/instructions.ts`, `openclaw.plugin.json`, `src/openclaw-context-engine.ts`, `plugin/README.md`; MCP op = the op whose `cliHints` names this CLI command (`ops-summary.tsv`); eval use = verified call site, `classify only` = listed in the eval's write-path set, `MCP:` = reached only through MCP; phase = command-table dispatch phase (`pre`/`post`/`-` = op-dispatched, not in the table).

| # | CLI command | class | skills/ refs | migration-note refs | agent docs refs | plugin/instructions refs | MCP op (cliHints) | eval use (verified site) | phase |
|---|---|---|---:|---:|---:|---:|---|---|---|
| 1 | `access` | admin/maintenance | 3 | 0 | 4 | 3 | - | - | post |
| 2 | `advisor` | agent-occasional | 9 | 0 | 0 | 8 | `advisor` | - | post |
| 3 | `agent` | agent-occasional | 15 | 0 | 7 | 15 | - | - | post |
| 4 | `anomalies` | agent-occasional | 1 | 0 | 0 | 1 | `find_anomalies` | - | post |
| 5 | `append` | agent-occasional | 3 | 0 | 0 | 3 | - | - | pre |
| 6 | `apply-migrations` | admin/maintenance | 12 | 81 | 8 | 12 | - | Y: shim.py:574, nightly/smokes/harness.ts | pre |
| 7 | `attribution` | admin/maintenance | 0 | 2 | 0 | 0 | `get_write_attribution` | - | - |
| 8 | `auth` | setup/install | 3 | 19 | 1 | 3 | - | Y: p5-brain.ts:168, lifecycle-experiment.ts:213 | pre |
| 9 | `autopilot` | admin/maintenance | 9 | 10 | 8 | 8 | - | - | post |
| 10 | `backfill` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 11 | `backlinks` | agent-core | 8 | 0 | 4 | 7 | `get_backlinks` | - | - |
| 12 | `backup` | admin/maintenance | 2 | 3 | 3 | 2 | - | - | pre |
| 13 | `beliefs` | dev/eval-only | 0 | 0 | 0 | 0 | - | - | post |
| 14 | `bench` | dev/eval-only | 0 | 0 | 0 | 0 | - | - | pre |
| 15 | `book-mirror` | agent-occasional | 7 | 4 | 0 | 7 | - | - | post |
| 16 | `bootstrap` | setup/install | 32 | 6 | 52 | 29 | - | - | pre |
| 17 | `brain-skillpack` | agent-occasional | 0 | 0 | 0 | 0 | `list_brain_skillpack` | - | - |
| 18 | `brainstorm` | agent-occasional | 0 | 0 | 0 | 0 | - | - | post |
| 19 | `bundled-skill` | setup/install | 0 | 0 | 0 | 0 | - | - | pre |
| 20 | `cache` | admin/maintenance | 0 | 1 | 0 | 0 | - | - | pre |
| 21 | `calibration` | agent-occasional | 1 | 0 | 0 | 1 | - | - | post |
| 22 | `call` | agent-core | 8 | 6 | 5 | 6 | - | Y: lifecycle/drivers.ts:93, p4-stream/run.ts:209, facts-absorb-gate.ts:171 | pre |
| 23 | `cancel-write-request` | agent-occasional | 0 | 0 | 0 | 0 | `cancel_write_request` | - | - |
| 24 | `capture` | agent-occasional | 22 | 0 | 1 | 21 | `capture` | classify only: cat41/classify.ts:54 | pre |
| 25 | `check-backlinks` | admin/maintenance | 11 | 10 | 1 | 11 | - | - | pre |
| 26 | `check-resolvable` | admin/maintenance | 11 | 2 | 0 | 5 | - | - | pre |
| 27 | `check-update` | admin/maintenance | 0 | 2 | 1 | 0 | - | - | pre |
| 28 | `chronicle-backfill` | admin/maintenance | 0 | 2 | 0 | 0 | `chronicle_backfill` | - | - |
| 29 | `claw-test` | dev/eval-only | 0 | 0 | 0 | 0 | - | - | pre |
| 30 | `code-callees` | agent-occasional | 0 | 0 | 0 | 0 | - | - | post |
| 31 | `code-callers` | agent-occasional | 0 | 4 | 0 | 0 | - | - | post |
| 32 | `code-def` | agent-occasional | 0 | 2 | 0 | 0 | - | - | post |
| 33 | `code-refs` | agent-occasional | 0 | 3 | 0 | 0 | - | - | post |
| 34 | `compile-context` | hidden/internal | 0 | 1 | 1 | 0 | - | - | pre |
| 35 | `config` | admin/maintenance | 50 | 91 | 16 | 48 | - | Y: p5-brain.ts:164, p4-stream/run.ts:207, shim.py:625 | post |
| 36 | `connect` | setup/install | 9 | 2 | 0 | 9 | - | - | pre |
| 37 | `connectors` | admin/maintenance | 14 | 0 | 3 | 14 | - | - | post |
| 38 | `context-pack` | agent-core | 0 | 0 | 2 | 0 | `context_pack` | - | - |
| 39 | `conversation-parser` | hidden/internal | 5 | 0 | 0 | 5 | - | - | post |
| 40 | `core` | agent-occasional | 2 | 0 | 0 | 0 | - | - | post |
| 41 | `creds` | setup/install | 0 | 0 | 0 | 0 | - | - | pre |
| 42 | `day` | agent-occasional | 2 | 2 | 0 | 2 | `chronicle_day` | - | - |
| 43 | `db-repair` | admin/maintenance | 14 | 0 | 5 | 13 | - | - | pre |
| 44 | `decide` | dev/eval-only | 1 | 16 | 4 | 0 | - | - | pre |
| 45 | `delete` | admin/maintenance | 5 | 1 | 1 | 5 | `delete_page` | - | - |
| 46 | `delete-skill` | agent-occasional | 0 | 0 | 0 | 0 | `delete_skill` | - | - |
| 47 | `delta` | agent-core | 0 | 0 | 2 | 0 | `delta` | - | - |
| 48 | `diag` | admin/maintenance | 1 | 0 | 0 | 1 | - | - | post |
| 49 | `doctor` | admin/maintenance | 74 | 130 | 34 | 72 | - | Y: shim.py:582, shim.py:905 (quiesce gate) | pre |
| 50 | `dream` | admin/maintenance | 18 | 30 | 1 | 18 | - | Y: chronicle-lift.ts:232 (dream --phase chronicle) | pre |
| 51 | `edge-proposals` | admin/maintenance | 0 | 3 | 0 | 0 | - | - | post |
| 52 | `edges-backfill` | admin/maintenance | 1 | 1 | 0 | 1 | - | - | post |
| 53 | `embed` | admin/maintenance | 12 | 20 | 7 | 12 | - | Y: lifecycle-experiment.ts:251 (embed --stale) | post |
| 54 | `embeddings` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | pre |
| 55 | `engine` | setup/install | 16 | 0 | 2 | 16 | - | - | pre |
| 56 | `enrich` | agent-occasional | 1 | 1 | 0 | 1 | - | - | post |
| 57 | `entity` | agent-core | 7 | 1 | 4 | 6 | `entity` | - | - |
| 58 | `entity-identity-link` | admin/maintenance | 0 | 0 | 0 | 0 | `entity_identity_link` | - | - |
| 59 | `entity-identity-list` | admin/maintenance | 0 | 0 | 0 | 0 | `entity_identity_list` | - | - |
| 60 | `entity-identity-unlink` | admin/maintenance | 0 | 0 | 0 | 0 | `entity_identity_unlink` | - | - |
| 61 | `errors` | agent-occasional | 3 | 0 | 2 | 2 | - | - | pre |
| 62 | `eval` | dev/eval-only | 31 | 14 | 4 | 16 | - | Y: scripts/run-shootout-phase1.sh:188 | post |
| 63 | `export` | admin/maintenance | 0 | 1 | 0 | 0 | - | Y: predictive/cli-arm.ts:183 | post |
| 64 | `extract` | admin/maintenance | 17 | 38 | 10 | 17 | - | Y: lifecycle-experiment.ts:158, p5-agent.ts:115 | post |
| 65 | `extract-conversation-facts` | agent-occasional | 6 | 3 | 0 | 6 | - | Y: workload-suites/bench.ts:258 | post |
| 66 | `extract-entities` | agent-occasional | 0 | 0 | 0 | 0 | `extract_entities` | - | - |
| 67 | `extraction-pending` | admin/maintenance | 0 | 0 | 0 | 0 | `extraction_pending` | - | - |
| 68 | `extraction-review` | admin/maintenance | 0 | 0 | 0 | 0 | `extraction_review` | - | - |
| 69 | `facts` | agent-occasional | 1 | 4 | 0 | 1 | - | - | pre |
| 70 | `features` | admin/maintenance | 4 | 0 | 0 | 3 | - | - | post |
| 71 | `feedback` | admin/maintenance | 0 | 1 | 0 | 0 | - | - | post |
| 72 | `fetch` | agent-occasional | 0 | 0 | 0 | 0 | `fetch` | - | - |
| 73 | `files` | agent-occasional | 25 | 16 | 0 | 25 | - | - | post |
| 74 | `find` | agent-occasional | 2 | 0 | 4 | 1 | `find_pages` | - | - |
| 75 | `find-contradictions` | agent-occasional | 2 | 0 | 0 | 2 | `find_contradictions` | - | - |
| 76 | `find-trajectory` | agent-occasional | 0 | 0 | 0 | 0 | `find_trajectory` | - | - |
| 77 | `forget` | agent-core | 6 | 2 | 0 | 6 | - | MCP: correction-adapters.ts:102 | pre |
| 78 | `founder` | hidden/internal | 0 | 3 | 1 | 0 | - | - | post |
| 79 | `friction` | agent-occasional | 7 | 0 | 0 | 7 | - | - | pre |
| 80 | `frontmatter` | admin/maintenance | 14 | 8 | 7 | 14 | - | - | pre |
| 81 | `get` | agent-core | 38 | 4 | 8 | 36 | `get_page` | Y (argv): write-contract-gen.ts:166-169 | - |
| 82 | `get_links` | hidden/internal | 0 | 0 | 0 | 0 | - | - | - |
| 83 | `git` | agent-occasional | 10 | 1 | 8 | 10 | - | Y (argv, not run): write-contract-gen.ts:145 | pre |
| 84 | `google` | setup/install | 13 | 1 | 1 | 13 | - | - | pre |
| 85 | `graph` | agent-occasional | 3 | 4 | 1 | 3 | `traverse_graph` | - | - |
| 86 | `graph-query` | agent-occasional | 19 | 9 | 5 | 19 | - | - | post |
| 87 | `guests` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 88 | `health` | admin/maintenance | 13 | 2 | 0 | 13 | `get_health` | - | - |
| 89 | `history` | agent-occasional | 3 | 2 | 0 | 3 | `get_versions` | - | - |
| 90 | `hook` | hidden/internal | 0 | 0 | 0 | 0 | - | - | pre |
| 91 | `import` | agent-occasional | 10 | 0 | 1 | 10 | - | Y: p5-agent.ts:80, chronicle-lift.ts:222 | post |
| 92 | `init` | setup/install | 17 | 12 | 16 | 17 | - | Y: cat40/gbrain-arm.ts:396, p5-brain.ts:160, shim.py:571 | pre |
| 93 | `integrations` | setup/install | 0 | 12 | 3 | 0 | - | - | pre |
| 94 | `integrity` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | pre |
| 95 | `jobs` | admin/maintenance | 72 | 74 | 6 | 67 | - | Y: memory-trust/flag-rate.ts:182, p8-write-cost.ts:132, shim.py:499 | post |
| 96 | `join-brain` | agent-occasional | 0 | 0 | 0 | 0 | `join_brain` | - | - |
| 97 | `last-seen` | agent-occasional | 0 | 0 | 0 | 0 | `chronicle_last_seen` | - | - |
| 98 | `leave-brain` | agent-occasional | 0 | 0 | 0 | 0 | `leave_brain` | - | - |
| 99 | `link` | agent-occasional | 12 | 0 | 7 | 12 | `add_link` | classify only: cat41/classify.ts:54 | - |
| 100 | `link-add` | hidden/internal | 0 | 0 | 0 | 0 | - | - | - |
| 101 | `link-rm` | hidden/internal | 0 | 0 | 0 | 0 | - | - | - |
| 102 | `link-sources` | agent-occasional | 3 | 0 | 0 | 3 | `list_link_sources` | - | - |
| 103 | `links` | agent-occasional | 1 | 0 | 0 | 1 | `get_links` | - | - |
| 104 | `lint` | admin/maintenance | 3 | 10 | 1 | 3 | - | - | pre |
| 105 | `list` | agent-occasional | 5 | 0 | 4 | 4 | `list_pages` | - | - |
| 106 | `loops` | agent-occasional | 6 | 0 | 1 | 6 | - | - | post |
| 107 | `lsd` | agent-occasional | 8 | 0 | 0 | 8 | - | - | post |
| 108 | `maintain` | admin/maintenance | 10 | 0 | 1 | 8 | - | - | post |
| 109 | `mcp` | setup/install | 56 | 2 | 6 | 54 | - | - | post |
| 110 | `memory-proposals` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 111 | `memory-settings` | admin/maintenance | 0 | 0 | 0 | 0 | `get_memory_settings` | - | - |
| 112 | `migrate` | admin/maintenance | 9 | 15 | 2 | 9 | - | - | post |
| 113 | `models` | admin/maintenance | 8 | 3 | 0 | 7 | - | Y: shim.py:642 | post |
| 114 | `mounts` | admin/maintenance | 3 | 3 | 1 | 3 | - | - | pre |
| 115 | `notability-eval` | dev/eval-only | 0 | 0 | 0 | 0 | - | - | post |
| 116 | `notices` | agent-occasional | 4 | 0 | 0 | 4 | - | - | pre |
| 117 | `on-this-day` | agent-occasional | 0 | 0 | 0 | 0 | `chronicle_on_this_day` | - | - |
| 118 | `onboard` | setup/install | 15 | 0 | 6 | 13 | - | - | post |
| 119 | `ontology` | agent-occasional | 0 | 0 | 0 | 0 | `ontology_get` | - | - |
| 120 | `ontology-add` | agent-occasional | 0 | 0 | 0 | 0 | `ontology_propose` | - | - |
| 121 | `ontology-contradictions` | agent-occasional | 0 | 0 | 0 | 0 | `ontology_conflicts` | - | - |
| 122 | `ontology-dimensions` | agent-occasional | 0 | 0 | 0 | 0 | `ontology_dimensions` | - | - |
| 123 | `orient` | agent-occasional | 0 | 0 | 0 | 0 | `volunteer_chronicle` | - | - |
| 124 | `orphans` | admin/maintenance | 1 | 0 | 0 | 1 | `find_orphans` | - | post |
| 125 | `pages` | agent-occasional | 4 | 2 | 0 | 4 | - | - | post |
| 126 | `pglite-repair` | admin/maintenance | 3 | 0 | 0 | 3 | - | - | pre |
| 127 | `post-upgrade` | admin/maintenance | 1 | 14 | 8 | 1 | - | - | pre |
| 128 | `pricing` | admin/maintenance | 7 | 2 | 0 | 7 | - | - | post |
| 129 | `projections` | admin/maintenance | 0 | 1 | 0 | 0 | - | - | pre |
| 130 | `protocol` | hidden/internal | 0 | 0 | 0 | 0 | - | - | pre |
| 131 | `providers` | setup/install | 2 | 0 | 0 | 0 | - | - | pre |
| 132 | `prune-skill-revisions` | admin/maintenance | 0 | 0 | 0 | 0 | `prune_skill_revisions` | - | - |
| 133 | `publish` | admin/maintenance | 19 | 9 | 0 | 19 | - | - | pre |
| 134 | `put` | agent-core | 17 | 3 | 2 | 17 | `put_page` | Y: predictive/cli-arm.ts (put); write-contract-gen.ts | - |
| 135 | `put-pages` | agent-occasional | 0 | 0 | 0 | 0 | `put_pages` | - | - |
| 136 | `put-skill` | agent-occasional | 0 | 0 | 0 | 0 | `put_skill` | - | - |
| 137 | `quarantine` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 138 | `query` | agent-core | 59 | 7 | 10 | 56 | `query` | MCP: shim.py STARTER_CALLS | - |
| 139 | `questions` | agent-occasional | 0 | 0 | 0 | 0 | - | - | post |
| 140 | `rank-entities` | agent-occasional | 0 | 0 | 0 | 0 | `rank_entities` | - | - |
| 141 | `rate` | agent-occasional | 0 | 1 | 0 | 0 | `rate_answer` | - | - |
| 142 | `recall` | agent-core | 21 | 3 | 4 | 20 | - | Y: predictive/cli-arm.ts:193; facts-absorb-gate.ts:171 (via call) | post |
| 143 | `reconcile-links` | admin/maintenance | 0 | 3 | 0 | 0 | - | - | post |
| 144 | `reindex` | admin/maintenance | 0 | 12 | 0 | 0 | - | - | post |
| 145 | `reindex-code` | admin/maintenance | 0 | 5 | 0 | 0 | - | - | post |
| 146 | `reindex-frontmatter` | admin/maintenance | 0 | 3 | 0 | 0 | - | - | post |
| 147 | `reindex-search-vector` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 148 | `reinit-pglite` | admin/maintenance | 1 | 0 | 0 | 1 | - | - | pre |
| 149 | `remember` | agent-core | 5 | 1 | 4 | 4 | `remember` | Y (argv): write-contract-gen.ts:123 | - |
| 150 | `remote` | setup/install | 0 | 0 | 0 | 0 | - | - | pre |
| 151 | `repair` | admin/maintenance | 14 | 44 | 4 | 12 | - | - | post |
| 152 | `repair-jsonb` | admin/maintenance | 0 | 0 | 3 | 0 | - | - | pre |
| 153 | `report` | admin/maintenance | 0 | 7 | 0 | 0 | - | classify only: cat41/classify.ts:54 | pre |
| 154 | `repos` | admin/maintenance | 0 | 1 | 0 | 0 | - | - | post |
| 155 | `resolvers` | agent-occasional | 0 | 0 | 0 | 0 | - | - | pre |
| 156 | `restore` | admin/maintenance | 10 | 2 | 1 | 9 | `restore_page` | - | - |
| 157 | `retain-skill-revision` | admin/maintenance | 0 | 0 | 0 | 0 | `retain_skill_revision` | - | - |
| 158 | `retrieval-upgrade` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 159 | `revert` | admin/maintenance | 1 | 1 | 0 | 1 | `revert_version` | - | - |
| 160 | `routing-eval` | dev/eval-only | 2 | 0 | 0 | 2 | - | - | pre |
| 161 | `salience` | agent-occasional | 1 | 0 | 0 | 1 | `get_recent_salience` | - | post |
| 162 | `schema` | agent-occasional | 96 | 1 | 0 | 93 | - | - | pre |
| 163 | `search` | agent-core | 63 | 6 | 10 | 60 | `search` | Y (search modes): shim.py:641, cat40/rerank-pool-replay.ts:688 | - |
| 164 | `search-by-image` | agent-occasional | 0 | 0 | 0 | 0 | `search_by_image` | - | - |
| 165 | `search-exact` | agent-occasional | 0 | 0 | 0 | 0 | `search_exact` | - | - |
| 166 | `self-upgrade` | admin/maintenance | 10 | 0 | 2 | 10 | - | - | pre |
| 167 | `serve` | agent-core | 28 | 29 | 12 | 28 | - | Y: cat40/gbrain-arm.ts:93, shim.py:684 | post |
| 168 | `set-skill-policy` | admin/maintenance | 0 | 0 | 0 | 0 | `set_skill_policy` | - | - |
| 169 | `setup` | setup/install | 10 | 0 | 15 | 11 | - | - | pre |
| 170 | `since` | agent-occasional | 0 | 0 | 0 | 0 | `chronicle_since` | - | - |
| 171 | `skill` | agent-occasional | 1 | 0 | 0 | 0 | `get_skill` | - | - |
| 172 | `skill-asset` | agent-occasional | 0 | 0 | 0 | 0 | `get_skill_asset` | - | - |
| 173 | `skill-policy` | admin/maintenance | 0 | 0 | 0 | 0 | `get_skill_policy` | - | - |
| 174 | `skill-resolver` | agent-occasional | 0 | 0 | 0 | 0 | - | - | pre |
| 175 | `skill-retention` | admin/maintenance | 0 | 0 | 0 | 0 | `get_skill_retention` | - | - |
| 176 | `skillify` | agent-occasional | 8 | 0 | 0 | 0 | - | - | pre |
| 177 | `skillopt` | dev/eval-only | 13 | 5 | 0 | 9 | - | - | post |
| 178 | `skillpack` | setup/install | 22 | 12 | 6 | 12 | - | - | pre |
| 179 | `skillpack-check` | dev/eval-only | 4 | 0 | 0 | 4 | - | - | pre |
| 180 | `skills` | agent-occasional | 5 | 0 | 8 | 3 | `list_skills` | - | - |
| 181 | `smoke-test` | dev/eval-only | 5 | 0 | 0 | 4 | - | - | pre |
| 182 | `sources` | admin/maintenance | 40 | 87 | 12 | 40 | - | Y: p5-brain.ts:161, lifecycle-experiment.ts:208, write-contract-gen.ts:152 | post |
| 183 | `stats` | admin/maintenance | 6 | 12 | 5 | 5 | `get_stats` | Y: cat41/scenarios.ts:186 | - |
| 184 | `status` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 185 | `storage` | admin/maintenance | 6 | 1 | 0 | 6 | - | - | post |
| 186 | `storage-find` | agent-occasional | 4 | 0 | 4 | 3 | `storage_find` | - | - |
| 187 | `storage-get` | agent-occasional | 1 | 0 | 0 | 1 | `storage_get` | - | - |
| 188 | `storage-list` | agent-occasional | 0 | 0 | 0 | 0 | `storage_list` | - | - |
| 189 | `storage-register` | admin/maintenance | 1 | 0 | 0 | 1 | `storage_register` | - | - |
| 190 | `storage-update` | admin/maintenance | 1 | 0 | 0 | 1 | `storage_update` | - | - |
| 191 | `sweep` | admin/maintenance | 6 | 0 | 6 | 6 | - | Y: p5-brain.ts:194 | post |
| 192 | `sync` | admin/maintenance | 62 | 44 | 16 | 61 | `sync_brain` | Y: predictive/cli-arm.ts (sync), write-contract-gen.ts:131 | post |
| 193 | `sync-brain-skills` | agent-occasional | 0 | 0 | 0 | 0 | `sync_brain_skills` | - | - |
| 194 | `synthesize` | agent-core | 0 | 0 | 0 | 0 | `synthesize` | - | - |
| 195 | `tag` | agent-occasional | 1 | 0 | 0 | 1 | `add_tag` | classify only: cat41/classify.ts:54 | - |
| 196 | `tags` | agent-occasional | 1 | 0 | 0 | 1 | `get_tags` | - | - |
| 197 | `takes` | agent-occasional | 3 | 7 | 1 | 3 | - | - | post |
| 198 | `takes-calibration` | agent-occasional | 0 | 0 | 0 | 0 | `takes_calibration` | - | - |
| 199 | `takes-list` | agent-occasional | 0 | 0 | 0 | 0 | `takes_list` | - | - |
| 200 | `takes-scorecard` | agent-occasional | 0 | 0 | 0 | 0 | `takes_scorecard` | - | - |
| 201 | `takes-search` | agent-occasional | 0 | 0 | 0 | 0 | `takes_search` | - | - |
| 202 | `think` | agent-occasional | 3 | 3 | 1 | 3 | `think` | MCP: shim.py FULL_SURFACE_CALLS | post |
| 203 | `timeline` | agent-occasional | 7 | 3 | 4 | 6 | `get_timeline` | - | - |
| 204 | `timeline-add` | agent-occasional | 7 | 0 | 3 | 7 | `add_timeline_entry` | classify only: cat41/classify.ts:54 | - |
| 205 | `transcripts` | agent-occasional | 17 | 1 | 4 | 15 | `get_recent_transcripts` | - | post |
| 206 | `trust` | admin/maintenance | 0 | 0 | 0 | 0 | - | - | post |
| 207 | `unlink` | agent-occasional | 1 | 0 | 0 | 1 | `remove_link` | - | - |
| 208 | `untag` | agent-occasional | 0 | 0 | 0 | 0 | `remove_tag` | - | - |
| 209 | `upgrade` | admin/maintenance | 9 | 69 | 13 | 9 | - | - | pre |
| 210 | `volunteer-context` | agent-core | 0 | 0 | 0 | 0 | `volunteer_context` | - | - |
| 211 | `waiting` | agent-occasional | 13 | 1 | 2 | 13 | - | - | post |
| 212 | `wakeshift` | agent-occasional | 0 | 0 | 0 | 0 | - | - | post |
| 213 | `wanted` | agent-occasional | 1 | 0 | 0 | 1 | `wanted_pages` | - | - |
| 214 | `watch` | agent-occasional | 0 | 0 | 0 | 0 | - | - | post |
| 215 | `whoami` | agent-core | 0 | 0 | 0 | 0 | `whoami` | - | - |
| 216 | `whois` | agent-occasional | 8 | 0 | 1 | 8 | `whois` | - | - |
| 217 | `whoknows` | agent-occasional | 4 | 0 | 0 | 4 | `find_experts` | - | post |
| 218 | `write-conflicts` | admin/maintenance | 0 | 0 | 0 | 0 | `list_write_conflicts` | - | - |
| 219 | `write-request` | agent-occasional | 22 | 0 | 2 | 22 | `get_write_request` | - | - |
| 220 | `write-requests` | agent-occasional | 0 | 0 | 0 | 0 | `list_write_requests` | - | - |

