# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [Unreleased]

**A master-red flake in the deferred-publish synthesis test is fixed.** `test/managed-synthesis-postprocess.test.ts` "#5854: a postprocess publish still pending after its wait is deferred, then finished by the next ordinary cycle" released the writer lock before disposing the in-process persistence consumer. Whenever the consumer drained the deferred publish in that gap, the "next ordinary cycle" found nothing left to write, and `written_slugs` came back `[]` (master run 41476223139, shard 14). The test now disposes the consumer before it releases the lock, so the next cycle is the only thing that can finish the publish. The assertions are unchanged. Forced probe: a 1.5 s pause after the lock release fails the old order with the exact CI diff and passes the new order (3 of 3).

## [0.60.551.0] - 2026-11-02

**The nightly opencode door now gates its nonce check on a paid Haiku turn, and a free-tier refusal fails in seconds with its reason instead of after eight silent minutes (#6049).** OpenCode's anonymous free models now cap usage per IP, and CI runners hit the cap. Past it, `opencode run` waits out the server's retry-after, which is hours, and prints nothing, so the keyless check timed out twice (about 487 s) with an empty reply and Heavy Tests went red on days the runner's IP was capped. The only trace was a `stream error` line in opencode's own log file. The paid check also could not have run in CI, because the test preload strips `ANTHROPIC_API_KEY` unless `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, so a requested paid tier refused itself as keyless.

### What changed

| Situation | Before | Now |
|---|---|---|
| Free-tier quota refusal during a door turn | two 240 s timeouts, then `Expected to contain: "kestrel-…" Received: ""` | the turn ends on the logged refusal; the test fails in about 11 s with `provider error(s): AI_APICallError: Free usage limit reached…` and makes no second attempt |
| Nightly Heavy Tests, opencode door | keyless lane gates on 5 tests, including the free-tier nonce check (T4) | keyless lane gates on T1-T3 (4 tests); the credentialed lane runs every night and its paid nonce check (T5) gates; T4 runs only in the non-gating latest-version canary |
| Paid nonce check model | `anthropic/claude-haiku-4-5` | `anthropic/claude-haiku-5-5`, validated against `opencode models --refresh` before any spend (1.18.18's bundled catalog predates it) |
| Credentialed lane in CI | `ANTHROPIC_API_KEY` stripped by the test preload, so the paid tier refused to run | the step sets `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`; one Haiku turn a night |

### Itemized changes

- `test/helpers/agent-harness.ts`: `opencodeOneShotTurn` reads main-turn `stream error` lines from `<XDG_DATA_HOME>/opencode/log` written during the turn, returns them as `streamErrors`, and ends the turn on a quota refusal (`providerRefusal`). A provider rate limit, which opencode retries through, does not end it. `runOneShotSpawn` takes an `abortWhen` poll, and once it kills the child, a descendant that holds the output pipes open gets 8 s instead of the rest of the timeout.
- `test/helpers/agent-harness.unit.test.ts`: stub-binary probes pin the quota fast-fail (it hangs to the timeout without the fix), the fast-fail with a descendant holding the pipes, a transient error and a rate limit that opencode recovers from, and per-turn log offsets.
- `test/e2e/install-real-opencode.serial.test.ts`: T4 runs only with `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`, adds logged stream errors to its provider-error message, and skips its second attempt after a quota refusal. T5 pins `anthropic/claude-haiku-5-5`, refreshes the model list before its spend gate, and, like T4, reads the turn's JSON events and requires a `gbrain_*` MCP tool call, since opencode's file tools could find the nonce without one.
- `.github/workflows/heavy-tests.yml`: the schedule requests the credentialed lane (`GBRAIN_PAID_LANES=0` still turns it off), the keyless lane expects 4 passes and its summary warns that no nonce check gates the run when `GBRAIN_PAID_LANES=0`, the credentialed step keeps provider keys, and the canary sets `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`. `test/scripts/heavy-door-workflow.test.ts` pins all four.
- `docs/mcp/OPENCODE-CLI-PIN.md`: the per-IP free cap, where its trace is logged, the new gating split and two triage rows.

**A merge slot's full-ci runs can now clear gstack's remote gate on their own, so each tree runs the full suite once.** `gstack-pregate clear --remote pregate.json/remote_gate --run <Test run> --run <E2E run> --allow-repo-commands` verifies both runs on GitHub (same tree, both full jobs green in the newest attempt, no newer red run, under 24 hours old) and checks that the files they executed cover the gate's inventory. Checked against Test run 41342917113 and E2E run 41342918866 on one tree: `REUSE: accepted … tests=68132` and `PREGATE_VERIFY: ok`, with all 5,701 inventory files covered. A tree that changes the full-ci workflows or the scripts that attest their runs still can't vouch for itself. It gets no inventory, so gstack refuses those runs and the gate runs, the same rule remote-gate reuse already follows. That rule now covers seven files: `ci-manifest.ts` joins the list.

### Itemized changes

- `.gstack/pregate.json`: `run_profiles` `test` (`test.yml`, `full-suite`, artifact `full-suite-tree`) and `e2e` (`e2e.yml`, `e2e-full-suite`, artifact `e2e-full-suite-tree`), both accepting `workflow_dispatch` and `push`, plus `remote_gate_runs` with `bash scripts/pregate-remote-gate.sh --list` as the inventory.
- `.gstack/ship-policy.json`: `min_gstack_version` 1.91.377.0, the first gstack that reads these keys. An older gstack now refuses with an upgrade fix instead of an invalid-config error.
- `scripts/pregate-remote-gate.sh`: the files whose change stops a tree's own full-ci runs from attesting to it are now seven: `test.yml`, `e2e.yml`, `ci-reuse.ts`, `ci-full-suite-tree.sh`, `ci-executed-counts.ts`, `lib/gh-issue.ts` and, new, `ci-manifest.ts`, which writes the `ci-manifest.json` that `ci-full-suite-tree.sh` trusts for completeness, executed files and counts. A tree that changes `ci-manifest.ts` therefore no longer reuses its full-ci and runs the gate. `--list` refuses (no inventory) for a tree that changes any of the seven, or the inventory's own builders `pregate-remote-gate.sh` and `ci-ubicloud.ts`, relative to `origin/master`, when there is no `origin/master`, and under `GBRAIN_PREGATE_REUSE=0`. Both paths run one check, and `--list` adds the two builders. `test/scripts/pregate-remote-gate.test.ts` pins this.
- `docs/ci-event-parity.md`: the profiles and the refusal.

**`ubi-runner.sh reap` now destroys only the caller's own VMs, and pack, usage and reap work on macOS and on an empty project (gstack #3756, #3746).** Reap used to destroy any owner's VM whose TTL had ended. That is how one project's `up` destroyed another lane's VMs (GST-573). Now it destroys only VMs whose owner tag equals `UBI_OWNER` and logs `reap: left N expired VMs of other owners` for the rest. The operator reaper, `reap-expired.ts`, still covers every owner. gbrain keeps `UBI_REAP=0` by default, so `up` still reaps nothing unless asked. On macOS, `pack` exited 1 under bsdtar after the VM was already created. On a project with no VMs, Ubicloud's bare-newline list read as a VM named `-`, and reap died on it. A failed size read made `usage` print a short total, which the quota preflight took as room.

### Itemized changes

- `scripts/ubicloud/ubi-runner.sh`, ported from gstack 74836e41 and 693ee713:
  - `cmd_reap` checks the owner tag first and counts other owners' expired VMs. The quota refusal says reap frees only this owner's VMs and names `usage` and `reap-expired.ts` for the rest.
  - `vm_rows` skips a blank row.
  - `cmd_usage` exits 1 with no total when the list or a size read fails, and skips a VM whose `show` answers 404.
  - `quota_preflight` retries an unreadable usage while `UBI_QUOTA_WAIT` lasts, then logs it and leaves the decision to the API.
  - `cmd_pack` builds `files.tar`, appends `.git` with `tar -rf` and gzips it, with `COPYFILE_DISABLE=1` on every tar call.
- `test/scripts/ubi-runner-run.test.ts` and `test/scripts/ubi-runner.test.ts` pin the owner-scoped reap, the empty project, the unreadable usage and `COPYFILE_DISABLE`. The six new cases and the two updated reap cases fail on the old runner. The updated cases expected another owner's VM destroyed and now expect it kept.
- `test/scripts/ubi-runner-bsd-userland.test.ts` runs `pack` under bsdtar. It fails on the old runner and is skipped where no bsdtar is installed. `test/helpers/mock-ubicloud-api.ts` gains `listBody`, `ghosts` and a `show` fault.
- `scripts/ubicloud/README.md`: reap's owner scope.

**Two test-isolation flakes are fixed (found when this release's new test file moved files between CI shards).**

- `test/context-pack-pinned-federation.test.ts` set `search.remote_private_pages=visible` and left its engine in the process-wide privacy cache, so a later test file in the same CI shard saw private pages and `test/private-visibility.test.ts` failed. Its `afterAll` now resets that cache.
- `test/db-lock-fencing.test.ts` waited a fixed 120 ms for the lock refresher's second retry, which a busy runner could miss. It now waits for eight retries, up to 5 s, so its not-aborted check still covers a run of failed refreshes, with the same assertions.

## [0.60.550.0] - 2026-11-02

**Security: the stdio MCP server and the remaining hook lanes no longer let the session directory's bunfig.toml or .env run, and the hook's git probes no longer run a checkout's core.fsmonitor (#8426, #8428, #8427, #8435, #8436).** Claude Code, Codex and opencode start user-scope stdio MCP servers in the session's directory, just as they run hooks there, so with a script-mode install the `gbrain serve` entry `gbrain setup` and `gbrain bootstrap hooks` registered ran a cloned repository's `bunfig.toml` preload once per session, with nothing to approve. The user-global opencode entry `gbrain bootstrap hooks --harness opencode` writes did the same. Those entries now start serve through the same `<gbrain config dir>/hook-launcher/gbrain-hook` the setup hooks use, and `gbrain serve` reads `.gbrain-source`, a mounted brain's persistence socket, relative `file_upload` paths and the upload root from the session directory the launcher records, without changing its own directory.

- The hooks from `gbrain bootstrap hooks` (the workspace lane), `gbrain bootstrap harness` and the Codex `SessionEnd` capture both write now start gbrain through the launcher too, and the gbrain plugins' per-turn hook changes into the plugin directory before it starts gbrain. The plugin hook now needs gbrain 0.60.547.0 or newer (it exits silently on an older CLI, which would read the plugin directory as the session's).
- `gbrain post-upgrade` moves a user-scope `gbrain setup claude-code` MCP entry setup still owns onto the launcher, checking it again under setup's lock, and takes the entry's `GBRAIN_HOME` only from hooks or an MCP entry that install's receipt owns, so another install sharing the Claude settings file never redirects it to a different brain. It rewrites no Codex entry, the turn-rule hook included (a rewrite recomputes the trust of every install's groups in the shared hooks.json): for `gbrain setup codex`'s MCP table and hooks it prints the `gbrain setup codex` command, and for every `gbrain bootstrap` entry the bootstrap command that rewrites it, run from the workspace. An entry you edited after setup wrote it is kept and named, and the refresh stops when another install replaced the receipt it planned from.
- `gbrain doctor` (`harness_wiring`, `hook_session_cwd`) now also covers the stdio MCP entries and the bootstrap, harness and Codex capture lanes, with the command that fixes each. Only a user-scope Claude Code entry setup owns gets an agent-runnable fix. It reruns the install that owns the entry with its recorded `--no-hooks`, `--source` and `--gbrain-bin`, so the rerun turns nothing on and keeps the binary the install chose instead of whatever `gbrain` is first on PATH. Every `gbrain setup codex` rerun is now the user's to run, because it rewrites the shared hooks.json and its trust.
- `gbrain hook`'s git probes run with `-c core.fsmonitor=false`, and a session outside the workspace the install receipt names runs no git at all, so a `.git/config` from an extracted archive or shared folder cannot run a command at session start.
- The readiness fix for an unwired Claude Code or Codex now names `gbrain setup <harness> --no-hooks` instead of `claude mcp add` / `codex mcp add`, so the entry it writes goes through the launcher; it also writes the brain-first block and records hooks as off. When `gbrain setup` already wired that harness, the fix reruns that install with the decisions its receipt recorded (the Codex rerun is the user's to run), so it never turns an install's hooks off. The install docs now teach `gbrain setup claude-code` / `gbrain setup codex` instead of a bare stdio `mcp add`. A project-scope `.mcp.json` and committed `.claude/settings.json` hooks stay PATH-resolved, because they belong to the repository.

## [0.60.549.0] - 2026-11-02

**GPT models that fill every optional tool argument with `""` or `null` can read pages again in SkillOpt rollouts and `gbrain call`.** GPT-6.1 Sol sends `known_as_of: ""`, `cursor: ""`, `section: ""` and `grep: ""` instead of leaving those arguments out. MCP dispatch and the subagent tool registry already treated `""` on an optional string argument, and `null` on any optional argument, as not provided. The SkillOpt rollout and write-capture registries and `gbrain call` passed the arguments to the handler unchanged. There `known_as_of: ""` sent `get_page` into its recorded-time branch, which refused with "known_as_of must be an ISO 8601 instant", so a SkillOpt probe on GPT-6.1 Sol saw every `get_page` call fail and the model answered from search snippets. The same empty arguments broke about 30 other read operations on those paths (`search`, `get_links`, `traverse_graph`, `recall`, `whois` and more). All three paths now run the same step as MCP dispatch. Empty optional arguments are dropped, then the arguments are checked against the operation's schema. A missing required argument or a non-empty invalid value still refuses with `invalid_params`. The SkillOpt registries now also refuse a wrong-typed or out-of-enum argument before the handler runs, with the same `invalid_params` error MCP returns. Over remote MCP, `memory_recall` with `acting_user: ""` or `acting_user: null` refused with `actor_not_attested`, because the attested-actor check read the arguments before they were normalized. It now reads the normalized arguments, so an empty `acting_user` means the same as leaving it out. A non-empty `acting_user` is still accepted only on an attested call and only when it matches the `x-qm-actor` header.

### Itemized changes

- `src/core/skillopt/rollout.ts`, `src/core/skillopt/write-capture.ts`: each read tool drops `""` and `null` optional arguments (`normalizeOptionalParams`), then validates (`findInvalidParam`, refusing through `schemaInvalidParams`), before calling the handler. In a rollout, the shared-skill read authorization still runs first.
- `src/mcp/server.ts` (`handleToolCall`, behind `gbrain call`): drops empty optional arguments before validation, and the handler receives the cleaned arguments.
- `src/mcp/dispatch.ts` (`dispatchToolCall`): the audience and attested-actor checks on a remote call read the normalized arguments.
- `test/tool-args-empty-optional-sol.test.ts`: drives `get_page` with every optional string set to `""`, and again with every optional argument set to `null`, through MCP over HTTP (remote) and stdio (local), `gbrain call`, the subagent registry and both SkillOpt registries. It checks that a missing slug and non-empty bad values still refuse, then sweeps every read operation and checks that empty optional arguments give the same outcome as omitting them. Reverting any one of the three fixes fails it.

## [0.60.548.0] - 2026-11-02

**Meeting notes now flow into the brain on a schedule, with no custom script.**

A new `meetings` source kind imports meetings from Fireflies (the first provider behind a provider interface) into one page per meeting: title, date, attendees, the provider's summary, action items and keywords, and optionally the transcript. You save the API key once on stdin with `gbrain connectors auth fireflies --token -` (probed before it is saved, 0600, never in argv, config or the database), add the source with `gbrain sources add meetings --kind meetings --provider fireflies`, and run the first sync yourself. After that, autopilot keeps it fresh every `--sync-interval-min` minutes (default 60) and waits out the provider's rate limit. Nothing syncs until you register a source and run its first sync.

It works on a brain with no Git repository, where pages and the sync position are recorded in the database. On a brain with a Git checkout, `--dir` inside it records each page with a commit before its database row, and a missing checkout holds the meeting instead of writing it to the database alone. The record mode is chosen when the source is added and never re-inferred.

| Situation | What happens |
|---|---|
| The key's owner did not attend the meeting | the page is private |
| A meeting the provider is still processing | re-checked every sync; published when its summary arrives (or after 48 hours) |
| A meeting edited upstream | the page updates and facts extracted from the old version are retired |
| A meeting deleted upstream (inside the lookback) | the page is deleted and its facts are retired |
| A key for a different account | refused (`connector_account_changed`) before anything is imported, even after the source's config changes |
| Summary text that looks like a facts table, citation or timeline row | made inert before it lands in the page |

Guide: [docs/guides/meeting-and-slack-sources.md](docs/guides/meeting-and-slack-sources.md).

**Slack channels can flow into the brain the same way.** A new `slack` source kind reads the channels you name through your own internal Slack app and writes one page per channel per day, in the chat layout the conversation parser reads, with thread replies under their parent. Save the bot token with `gbrain connectors auth slack --token -`, then `gbrain sources add slack --kind slack --channels C0123ABCDEF`; the add checks the token and every channel first and refuses with the fix (a missing scope, or "invite the app to the channel"). It works on a brain with no Git repository, re-reads the last 7 days on every sync so edits and deletions converge (retiring the facts of the old page), keeps private channels private and out of any Git checkout, and moves a channel that becomes private out of the checkout. A channel the app loses is held while the others keep syncing.

For both kinds, `gbrain sync --source <id> --full` re-reads the whole history window, `--dry-run` fetches and writes nothing (these sources have no preview), and `gbrain connectors status fireflies` (or `slack`) reports whether a key is saved without printing it.

### Known limits

- Fact retirement on a changed page still needs a redesign ([#8432](https://github.com/garrytan/gbrain/issues/8432)): on a managed brain a retirement can race the page's own write and is not retried if it fails, every new Slack message retires and re-extracts its whole day's facts, and facts from an unchanged prefix of a long page are not re-asserted.
- Slack ([#7971](https://github.com/garrytan/gbrain/issues/7971)): a channel window too big for the per-run request cap (`s_max_requests`) or over 500 history pages does not make progress, and in Git record mode a channel that becomes private leaves HEAD but stays in Git history.
- A meetings window with more than 20,000 meetings stops with `listing_unbounded`; use a smaller `--history-days`. `connectors status` does not read a source's `--token-env`.

## [0.60.547.0] - 2026-11-02

**Security: gbrain's hooks no longer let the session directory's bunfig.toml or .env run (#8424).** A script-mode install (`bun install -g`, `bun link`) runs gbrain as a Bun script, and Bun applies the working directory's `bunfig.toml` (a top-level `preload` runs before any gbrain code) and loads its `.env` files first. Claude Code and Codex run hooks in the session's directory, so with the hooks `gbrain setup claude-code|codex` writes, or the per-turn rule hook from `--instructions-only`, `gbrain connect --install` and `gbrain bootstrap harness`, opening a session in a cloned repository ran that repository's code as you on every prompt, with nothing to approve. Each of those hooks now starts gbrain through `<gbrain config dir>/hook-launcher/gbrain-hook`, a small sh script that records the session directory in `GBRAIN_HOOK_CWD`, changes into its own directory and starts gbrain there. Its directory holds only the launcher, and it refuses to start gbrain if anything else appears there.

- `gbrain post-upgrade` moves existing hooks onto the launcher. That covers the turn-rule hook in Claude Code's user settings and in Codex's hooks.json, and the hooks of each user-scope `gbrain setup claude-code` install whose MCP entry is unchanged. A Codex turn-rule hook moves only when Codex already runs it, so an upgrade never trusts a hook you did not approve, and a hook you edited after setup wrote it is kept and named instead. `gbrain setup codex`'s hooks are not moved by an upgrade: rewriting them re-trusts them, so post-upgrade prints the `gbrain setup codex` command that does it, and doctor keeps flagging them until it runs. `gbrain setup <harness>` and `gbrain setup <harness> --instructions-only` rewrite them on their next run.
- `gbrain doctor` (`harness_wiring`) warns with the new code `hook_session_cwd` when a hook still starts gbrain in the session directory, or its launcher is missing, changed or shares its directory with a file gbrain did not write, and names the setup command that fixes it. Project-scope installs get the command to run from their project directory.
- Not covered yet: the stdio MCP server `gbrain setup` registers, which the harness also starts in the session's directory (#8426); the capture hooks from `gbrain bootstrap`'s own lanes and the gbrain plugins' hooks (#8428); and script-mode commands you run by hand in an untrusted checkout (SECURITY.md).
- The launcher rewrite never leaves a temp file in its own directory, and doctor finds a setup hook whose `_gbrain` marker Claude Code dropped by its receipt hash.
- `gbrain hook` resolves the recorded session directory the way the shell's working directory resolves, so project-scope rules still match under a symlinked path, and a `.env` in the session directory cannot set `GBRAIN_HOOK_CWD`.

## [0.60.546.0] - 2026-11-02

**QM can use gbrain as its memory provider. A trusted system that names the person (`x-qm-actor`) reads and writes as that linked member, each member's saved facts stay on their own page and are recalled by them alone, and `memory_recall` / `memory_write` give QM one plain-text read and one batched write (GST-359).**

### What changed

| Situation | Before | Now |
|---|---|---|
| A trusted system that names the person (QM) | | a client-credentials client granted `gbrain auth rescope --client <id> --attest-actor qm [--attest-ops <list>]` sends `x-qm-actor: <canonical id>`; each attested operation runs as the member that id is linked to (`gbrain access member link <member> --qm <id>`, `unlink`, `links`), never reading private pages, and queued writes and jobs re-check the link and the operation list. `capture`, `extract_facts`, take writes and `list_write_conflicts` are not attestable yet. Refusals carry `structuredContent.error` (`actor_not_attested`, `actor_unlinked`). Every MCP server's `serverInfo` now has a one-line `description` |
| A member saves a fact remotely (`remember` attested as a person, or from a credential bound to one member) | from a member-bound credential, went on the entity page as a fact every reader of the source recalled; an attested call could not run `remember` | goes on the member's own page `memory/members/<member>` (created with `readable_by: [member:<id>]`), private, with the entity kept as metadata; only that member recalls it, and it never dedups against, supersedes or contests another page's fact, never consolidates into a take and keeps its readers through a fence rebuild and relink. Two people's identical words make two facts. The page must name that member alone, or the fact is refused; remote `put_page`, `edit_page`, `delete_page` and every other remote page write under `memory/members/` are refused (`permission_denied`) unless the caller is that member. A member id a repo brain would store under another slug (`a--b`, `zed-`) holds no member facts (`invalid_params`) |
| One attest client serving several people | hot memory, `delta` cursors, write receipts and agent jobs were keyed by the client | each is keyed by the person too: Alice and Bob on one session id never share a hot-memory payload or a `delta` cursor, Bob and the bare client get `not_found` for Alice's receipt (`get_write_request`, `list_write_requests`, `cancel_write_request`) and agent job (`get_agent_job`, and the client's own `get_job`, `wait_job`, `get_job_progress`, `list_jobs` and `cancel_job`), and Alice's `request_id` never replays for Bob. `remember`, `delta`, the receipt ops, `submit_agent` and `get_agent_job` are now attestable |
| QM's memory provider | | `memory_recall {query, max_chars?}` answers the attested person's own recent facts first, then the facts they may read ranked by the query, one plain line per fact cut within `max_chars` (200-12000, default 6000), keyword-only on a keyless brain; `memory_write {facts, idempotency_key}` saves 1-20 facts on that person's own page through `remember`'s writer, with request ids derived per person from the key so a replay returns the first receipt. Results ride `structuredContent`, and every refusal carries `structuredContent.error`; an unlinked person gets an empty recall with `code: "actor_unlinked"`. `get_write_request` joins the default attested operations. A request carrying `x-qm-audience` is refused until channel audiences are served (`audience_not_supported`). `forget` from an attested person or a member-bound credential reaches only that member's own page. `remember` and `memory_write` take `valid_from` only as an ISO 8601 date or time in years 0001-9999. Contract: `docs/contracts/qm-memory-provider/v1.json`; guide: `docs/guides/qm.md` |
| An attested `forget` or `forget_fact` | refused (`op_not_attested`) | withdraws only a fact on the person's own member page, and only there: another member's copy of the same claim stays active and rememberable |

### What to watch for after you upgrade

- A call that sends `x-qm-actor` or an `acting_user` argument from a credential without the attest right is now refused (`actor_not_attested`) instead of reading as the credential; tokens issued before this upgrade never attest, so a QM client takes a fresh client-credentials token after it is granted.
- Migration v286 adds `access_member_links`, the attest columns on access tokens and OAuth clients, and the grant type on OAuth tokens; it is database-only, so a repo-less brain gets it unchanged.
- Writers never dedup, supersede or contest across member pages: `extract_facts`, capture and supersession leave member-page facts out of their candidates, so a write never learns that another member saved the same claim.
- A member's facts go only on `memory/members/<member>`, so a credential whose `bound_slug_prefixes` do not cover that page is refused (`permission_denied`) by `remember` and `memory_write` for that member.
- `memory_write` binds its idempotency key to the whole batch, so a retry under the same key with more, fewer or different facts refuses (`idempotency_conflict`), and a batch with an invalid fact saves nothing.
- The QM contract QM vendors is `docs/contracts/qm-memory-provider/v1.json`; the guide is `docs/guides/qm.md`.

## [0.60.545.0] - 2026-11-02

**The hosted gbrain.io install now tells the agent the brain is there.**

Before, the hosted install in README.md, docs/INSTALL.md, INSTALL_FOR_AGENTS.md and AGENTS.md stopped at `claude mcp add` or `codex mcp add`, so nothing in the harness told the model to use the new MCP server, and in harness trials a server nobody mentions is almost never called. Each now installs the gbrain CLI with Bun (`bun install -g github:garrytan/gbrain#latest-stable`) and runs `gbrain setup claude-code --instructions-only` or `gbrain setup codex --instructions-only` after the MCP entry is in place. That writes the brain-first block into `~/.claude/CLAUDE.md` or Codex's `AGENTS.md` (or its non-empty `AGENTS.override.md`) and the per-turn rule hook, without creating a local brain. Each harness line checks for an existing `gbrain` entry first and keeps it (`mcp get` output goes to /dev/null, since it can print a stored token), adds the hosted entry otherwise, and skips the setup step when that harness isn't installed. Adding `--no-instructions` to that `gbrain setup` command takes them out, and a bare `mcp add` still works.

## [0.60.544.0] - 2026-11-02

**The remote gate stops waiting on an artifact GitHub has refused for good, and bench and eval scripts no longer fail pregate for having no test lane (#8370, #7690).** When reading a full run's `executed-identities` artifact failed, `fetchArtifactJson` marked every failure transient, so a 403 or an expired artifact's 410 kept the gate polling for up to 90 minutes before it fell back to VMs. Only no response, a 5xx, a 429 or a rate-limit 403 is transient now. Any other 4xx refuses reuse at once and the gate goes straight to VMs. This never made a gate pass, because a transient read was always `none` and never `reuse`. Separately, `scripts/bench/**` and the system-one eval runners and generators now declare that they need no test lane, so a PR that touches them no longer fails pregate with `PREGATE_NO_LANE`. The unit-lane PostgreSQL arms job also gets real headroom back. Its committed weights had drifted about 24% below what the files now take, so by measured times the busiest of master's 13 shards takes 694 s against its 570 s budget.

### What changed

| `unit-postgres-arms` (both arms, the CI cell) | Before | Now |
|---|---|---|
| Weights | mined from older runs, scaled by 0.763, 6 listed files unweighted (charged the 29 s p75) | median of the `ARM_FILE` times in eight full-ci runs from 2026-11-01 (41296667994, 41307060384, 41310113203, 41324518709, 41342917113, 41347700875, and train M's 41351675051 and 41365617585, covering every suite #8404, #8405, #8407 and M added), every listed file weighted |
| Shards | 13 | 19 |
| Two-worker makespan, largest shard, against the unchanged 570 s budget | 526.4 s (7.7% headroom) by the committed weights; 694.3 s by the fresh ones | 476.3 s (16.4% headroom) |
| Measured job wall time | 438-923 s per job in train M's run 41365617585, against the 20-minute step timeout | about 475 s per shard, by the same measurements |
| PostgreSQL-only cell, largest shard | 487.2 s | 333.8 s |

### Itemized changes

- `scripts/lib/gh-issue.ts`: `fetchArtifactJson` marks a failed artifact read transient only for no response, a 5xx, a 429 or a 403 whose message names a rate limit (#8370). Both clients' artifact downloads now carry the HTTP status and the response text, so the `gh` CLI client (used when no `GH_TOKEN` is set) classifies the same way. A rate-limit 403 stays transient whether its headers (`x-ratelimit-remaining: 0`, `retry-after`) or its text (rate limit, abuse detection) say so, and so does a refusal from the artifact storage the download redirects to, since a fresh read mints a new signed URL.
- `test/scripts/ci-reuse.test.ts`: a probe checks that 403, 404 and 410 are refusals and that 429, a rate-limit 403, a 502 and no response stay transient, and that a refused receipt ends the gate's wait at once. It fails without the fix.
- `.gstack/pregate.json`: `scripts/bench/**`, `docs/eval/system-one/runners/**` and `docs/eval/system-one/generators/**` declare no lane (`[]`), which applies only where no test maps the file, so the VM-setup scripts keep `test/scripts/vm-setup-usage.test.ts` (#7690).
- `scripts/postgres-arm-weights.json`: re-mined with `bun scripts/postgres-unit-arms.ts mine` from those eight runs' 98 job logs, unscaled.
- `scripts/postgres-unit-arms.ts`: `ARM_SHARDS` 19; `.github/workflows/persistence-validation.yml`: the matrix, job name and `run` argument follow it (pinned by `test/scripts/postgres-unit-arms.test.ts`, whose budget and assertion are unchanged). Check names become `Unit-lane PostgreSQL arms N/19 / Bun …`; none is a required check.
- `docs/architecture/key-files/ci-health-and-test-guards.md`, `scripts/ubicloud/README.md`: shard count.

## [0.60.543.0] - 2026-11-01

**A shared brain can now keep a page to the members it names, inside one source. Put `readable_by: [alice-example, group:team-a]` in a page's frontmatter, bind each member's token, OAuth client or stdio server to a member, and remote reads of that page answer only for them. Nothing changes until a page names readers or a member is created.**

### What changed

| Situation | Before | Now |
|---|---|---|
| A page names `readable_by` | ignored: every remote caller granted the source read it | read remotely only by a credential bound to a listed member (directly or through a group); everyone else gets the canonical `not_found` on every read path, and a remote write to it answers `page_not_found` |
| Escape hatches and `--private-pages granted-sources` | relaxed `visibility: private` | still relax only `visibility: private`; they never open a page to an unlisted member |
| A `visibility: private` page that also names readers | hidden remotely | still hidden from a listed member unless that member's credential also has `--private-pages granted-sources` |
| Atoms, concepts and chronicle events derived from a restricted page | followed the origin's visibility | readable by no remote caller |
| Members and groups | | `gbrain access member add\|disable\|enable\|rm\|list`, `gbrain access group add\|rm\|list`, `gbrain access who-can-read <slug>`, `gbrain access check --token\|--client <name>`; `--member` and `--may-act-for` on `auth create`, `auth rescope` and `auth register-client`; config `mcp.stdio_member` for a stdio server; `--as <member>` previews one member's view from the local CLI; `whoami` and `grant_diagnosis` show member and groups |
| Doctor | | `access_readers_malformed`, `access_unknown_readers`, `access_recent_narrowings`, `access_page_readers_backfill`, `access_policy_pending`, `access_policy_widening_held`, `access_policy_invalid`, `access_policy_store_mismatch` |
| Folder rules | | `gbrain access rule add\|rm\|list\|status\|history\|revert\|export\|import\|migrate`, `gbrain access apply` and `gbrain access resume` keep whole folders of a source to named members; a page under a rule is read remotely only by a member listed on every rule covering it and on its own `readable_by`. Rules live in the database on a repo-less source and in `.gbrain/access.yml` on a git-backed one |
| Changing folder rules | | narrowing applies at once; widening is held until `gbrain access apply --source <id>` previews it and `--yes --expect <plan_hash>` approves it; an unfinished apply reads as nobody remotely until `gbrain access resume --source <id>` |
| `gbrain export` and `gbrain import` | pages only | an export carries each source's applied folder rules under `.gbrain/`, and import installs them before publishing any page (`--access-policy <source>` maps a multi-source export) |
| A shared agent (one bot serving a channel or many DMs) | read as its own credential, so it saw one view for everyone | its harness names each turn's audience (`X-Gbrain-On-Behalf-Of: alice-example, guest` or request-level `_meta.on_behalf_of`); the call reads only what every entry may read, within the agent's source grant, and only a one-member audience keeps the agent's private-page relaxation. The credential lists whom it may act for (`gbrain auth rescope --token <name> --may-act-for <list>`); every response carries `_meta.access`, and `whoami` returns it |

### What to watch for after you upgrade

- A page that already carried `readable_by` before this release reads as nobody remotely until you run `gbrain repair access` (preview) and then `gbrain repair access --apply`. Doctor's `access_page_readers_backfill` lists them.
- On a brain with any restriction, the escape hatches no longer turn the remote read filter off, and secondary surfaces (proactive brief, retrieval reflex, entity resolution, known-as-of) hide restricted pages from every remote caller, listed members included.
- A credential bound to a disabled or removed member is refused at verification (`access_member_disabled`).
- Works the same on a repo-less brain: members, groups, bindings and folder rules live in the database. A source records which store holds its folder rules when its first rule is created, and only `gbrain access rule migrate --source <id>` moves them; doctor `access_policy_store_mismatch` names it when the filesystem changes.
- The member-access and folder-rule SQL functions end their pinned `search_path` with `pg_temp`, like every other gbrain function (#7632), and frontmatter recovery never guesses a duplicated `readable_by` key: the file is held until a person fixes it.
- Remote callers can no longer write pages under `.gbrain/`.
- A database rebuilt from a git-backed source replays its committed `.gbrain/access.yml` history, so a removal that was held stays held. The source reads as nobody remotely until the replay finishes, and a shallow clone stays that way until `git fetch --unshallow`.
- A page renamed into a ruled folder takes its atoms, concepts, chronicle events and `derived_from` pages with it, through later renames too and after another page takes its old slug (migration v285 keeps rename history for this; slug resolution does not use it).
- On Postgres, a database role that neither owns the folder access tables nor bypasses row-level security now needs read policies on them, and an unfiltered policy on `slug_rename_history` (docs/ENGINES.md, "Folder access tables"). Without them its page writes are refused with `writer_coordinator_required` (`unreadable_state`) and its reads show nothing, instead of reading the tables as empty and treating every page as unruled. The owner, BYPASSRLS roles and PGLite are unaffected.
- A harness that sends an audience its credential's `may_act_for` does not list gets `on_behalf_of_not_permitted` with the operator's command; an audience inside tool arguments is always refused (`on_behalf_of_in_arguments`). `may_act_for: *` is accepted and doctor warns (`access_may_act_for_wildcard`).

## [0.60.542.0] - 2026-11-01
