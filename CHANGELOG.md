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

**The nightly opencode door now gates its nonce check on a paid Haiku turn, and a free-tier refusal fails in seconds with its reason instead of after eight silent minutes (#6049).** OpenCode's anonymous free models now cap usage per IP, and CI runners hit the cap. Past it, `opencode run` waits out the server's retry-after, which is hours, and prints nothing, so the keyless check timed out twice (about 487 s) with an empty reply and Heavy Tests went red on days the runner's IP was capped. The only trace was a `stream error` line in opencode's own log file. The paid check also could not have run in CI: the test preload strips `ANTHROPIC_API_KEY` unless `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, so a requested paid tier refused itself as keyless.

### What changed

| Situation | Before | Now |
|---|---|---|
| Free-tier quota refusal during a door turn | two 240 s timeouts, then `Expected to contain: "kestrel-…" Received: ""` | the turn ends on the logged refusal; the test fails in about 11 s with `provider error(s): AI_APICallError: Free usage limit reached…` and makes no second attempt |
| Nightly Heavy Tests, opencode door | keyless lane gates on 5 tests, including the free-tier nonce check (T4) | keyless lane gates on T1-T3 (4 tests); the credentialed lane runs every night and its paid nonce check (T5) gates; T4 runs only in the non-gating latest-version canary |
| Paid nonce check model | `anthropic/claude-haiku-4-5` | `anthropic/claude-haiku-5-5`, validated against `opencode models --refresh` before any spend (1.18.18's bundled catalog predates it) |
| Credentialed lane in CI | `ANTHROPIC_API_KEY` stripped by the test preload, so the paid tier refused to run | the step sets `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`; one Haiku turn a night |

### Itemized changes

- `test/helpers/agent-harness.ts`: `opencodeOneShotTurn` reads main-turn `stream error` lines from `<XDG_DATA_HOME>/opencode/log` written during the turn, returns them as `streamErrors`, and ends the turn on a quota or rate-limit refusal (`providerRefusal`). `runOneShotSpawn` takes an `abortWhen` poll.
- `test/helpers/agent-harness.unit.test.ts`: stub-binary probes pin the quota fast-fail (it hangs to the timeout without the fix), a transient error that opencode recovers from, and per-turn log offsets.
- `test/e2e/install-real-opencode.serial.test.ts`: T4 runs only with `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`, adds logged stream errors to its provider-error message, and skips its second attempt after a quota refusal. T5 pins `anthropic/claude-haiku-5-5` and refreshes the model list before its spend gate.
- `.github/workflows/heavy-tests.yml`: the schedule requests the credentialed lane (`GBRAIN_PAID_LANES=0` still turns it off), the keyless lane expects 4 passes, the credentialed step keeps provider keys, and the canary sets `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`. `test/scripts/heavy-door-workflow.test.ts` pins all four.
- `docs/mcp/OPENCODE-CLI-PIN.md`: the per-IP free cap, where its trace is logged, the new gating split and two triage rows.

**A merge slot's full-ci runs can now clear gstack's remote gate on their own, so each tree runs the full suite once.** `gstack-pregate clear --remote pregate.json/remote_gate --run <Test run> --run <E2E run> --allow-repo-commands` verifies both runs on GitHub (same tree, both full jobs green in the newest attempt, no newer red run, under 24 hours old) and checks that the files they executed cover the gate's inventory. Checked against Test run 41342917113 and E2E run 41342918866 on one tree: `REUSE: accepted … tests=68132` and `PREGATE_VERIFY: ok`, with all 5,701 inventory files covered. A tree that changes the full-ci workflows or the scripts that attest their runs still can't vouch for itself. It gets no inventory, so gstack refuses those runs and the gate runs, the same rule remote-gate reuse already follows.

### Itemized changes

- `.gstack/pregate.json`: `run_profiles` `test` (`test.yml`, `full-suite`, artifact `full-suite-tree`) and `e2e` (`e2e.yml`, `e2e-full-suite`, artifact `e2e-full-suite-tree`), both accepting `workflow_dispatch` and `push`, plus `remote_gate_runs` with `bash scripts/pregate-remote-gate.sh --list` as the inventory.
- `.gstack/ship-policy.json`: `min_gstack_version` 1.91.377.0, the first gstack that reads these keys. An older gstack now refuses with an upgrade fix instead of an invalid-config error.
- `scripts/pregate-remote-gate.sh`: `--list` refuses (no inventory) for a tree that changes `test.yml`, `e2e.yml`, `ci-reuse.ts`, `ci-full-suite-tree.sh`, `ci-executed-counts.ts` or `lib/gh-issue.ts` relative to `origin/master`, when there is no `origin/master`, and under `GBRAIN_PREGATE_REUSE=0`. The reuse path and `--list` share one check. `test/scripts/pregate-remote-gate.test.ts` pins this.
- `docs/ci-event-parity.md`: the profiles and the refusal.

## [0.60.538.0] - 2026-11-01

**Agents connected over MCP now see the chronicle reads, takes reads and a quoted page's title and frontmatter quoted as source material, and the context gbrain's hooks inject quotes facts below "your notes" too.**

Before, #8367 left `chronicle_day`, `chronicle_since`, `chronicle_on_this_day`, `volunteer_chronicle`'s timeline, `takes_list`, `takes_search` and a quoted page's title and frontmatter returning agent-written text raw, and gbrain's per-turn hook and pushed context pack injected agent-written facts raw. Now a remote reader gets that text quoted when its stored tier is below `operator_curated`; owner-tier text and local reads are unchanged. **Harness authors: hook output can now hold quote fences** (a marker line naming the fact, then a code fence that closes on its own line).

### Itemized changes

- Chronicle reads quote each timeline row's summary and detail by its own page; `takes_list` and `takes_search` quote a claim below the owner's tier and its free-text `source` and `resolved_source`.
- Remote `get_page` and `fetch` quote a quoted page's title and every frontmatter string; `include_content` and fetch `text` fence the whole serialized markdown, and the `put_page` round trip still stores the page unchanged. A thin client's `gbrain get` then `gbrain put`, or an agent that rebuilds the markdown from `title` and `frontmatter`, stores the title and frontmatter without the fences. Titles on search rows and context cards, and a chronicle entry's `kind`, are still returned as stored.
- A thin client's paged `gbrain get` of a quoted page (above the inline limit) prints the page, and its `--json` content, inside one quote fence after verifying size and sha256.
- The per-turn push hook and the pushed context pack quote hot and entity facts below the owner's tier; a fact injected before this change is not injected again.
- `context_pack` counts the entity facts it withholds when the quote lookup fails (`suppressed`) instead of dropping them silently.
- Remote `remember` stores a fact copied out of a quoted read without the fence, and remote `add_timeline_entry` stores an entry copied out of `get_timeline` without it, so the replay key matches and the entry is not duplicated. `takes_add`, `takes_update` and `takes_supersede` do the same for a claim or source copied out of a quoted takes read.
- The `put_page` tool-call guard counts only summaries outside the content's own tool-call blocks, and admits a new turn that quotes a summary while every stored call stays; its refusal names `edit_page` first.
- Tests: `test/search-transcript-quote-followups.test.ts` (every item, red on master for the changed reads and writes) and `test/trust-keep-maintenance-reimport-8352.test.ts` (maintenance re-imports keep an owner note's tier), both on PGLite and Postgres.

## [0.60.537.0] - 2026-11-01

**One source's stuck writes can no longer starve another source's sync: a write refused for a missing ownership marker ends terminally with its own code and restore step, the shared local principal keeps a fair share for every source, and doctor names the source holding the slots (#8368)**

On Postgres, a bulk sync group whose checkout failed the ownership check when its worktree lock was taken threw out of the consumer and stayed `running`; after each lease lapse the owner claimed it into the same refusal, forever, while the source kept admitting more. A hundred of them filled the local CLI principal's outstanding cap, which every source's sync shares, so another source's sync stopped `write_capacity` and doctor read `ok`. Now a deterministic ownership refusal finishes every claimed, unpublished member `failed` (the single path already did), which releases its slot; transient failures keep retrying as before. A missing `.gbrain-owner.json` is refused `owner_marker_missing` instead of the generic identity refusal, and its fix is the verified self-transfer that re-creates it. At the principal cap a source holding less than its fair share (the cap over the sources holding outstanding requests on the local CLI principal) is still admitted, a sync publication group or page batch whole, the brain cap stays hard, and a refusal names the source holding the most slots. `persistence_capacity` warns when an outstanding-request cap is at 90% or more and its oldest request has waited over ten minutes, and names the source holding the most stalled requests.

### Itemized changes

- `src/core/persistence/consumer.ts`: `failRefusedClaims` settles a claimed group refused `recovery_required` or `owner_marker_missing` before publication, fenced on the claim token, no recovery record and publication not started; a member whose claim moved is left to its claimant and a connection loss gives the rest back.
- `src/core/persistence/owner-marker.ts`, `physical-root-record.ts`, `ownership.ts`: `owner_marker_missing` for an absent stamp under a reservation that identifies the directory exactly, with the self-transfer restore as its fix; a stamp naming another owner keeps `recovery_required`. Registered in `error-registry.ts`, `WRITE_ERROR_CODES`, the sync fault table and the terminal classifier (the receipt's fix is the restore step).
- `src/core/persistence/journal.ts`: `outstandingRefusal` applies the local CLI principal fair share on single and group admission (checked before the admission, so a group larger than the share is admitted whole) and names the top holder.
- `src/commands/doctor/checks/persistence-capacity.ts`: `details.outstanding[]` with holders; a holder's writer status as the fix when it is the only finding.
- `test/write-cap-wedge-8368.test.ts` (PGLite and Postgres, with `test/e2e/write-cap-wedge-8368-postgres.test.ts`).

## [0.60.536.0] - 2026-11-01

**Agents connected over MCP now see agent-written, ingested and unverified-origin text quoted as source material on search, recall, page, chunk, timeline, version and write-receipt reads, and conversation tool calls come back summarized on the reads that still returned them verbatim.**

Before, the quote fence (#8066) covered chat page types and conversation-derived facts only. A note an agent wrote over MCP, a fact saved with `remember`, a chat message saved into a member source, and every placement read through `get_timeline`, `search_exact`, `get_chunks`, `think`'s extractive answer or a write receipt reached a remote reader as plain text, and a conversation page's tool-call JSON came back verbatim through `get_page`, `fetch`, `search_exact`, `get_chunks` and `think`. Now any text whose stored trust tier is below "your notes" (`operator_curated`) is quoted for a remote reader on those reads: written by an agent, tool data, external, or unverified origin. The `chronicle_*` reads, `takes_search` and `takes_list`, and a quoted page's title and frontmatter still return stored text unquoted; #8377 tracks them.

**Remote MCP readers now see unverified-origin text quoted until you run trust backfill.** A note saved before gbrain tracked trust has no recorded origin, so it reads as unverified and is quoted for agents connected over MCP. Claim the sources that hold your own notes with `gbrain trust claim-sources` and run `gbrain trust backfill`; `gbrain doctor` (`trust_tiers`, `trust_sources_unclaimed`) names how many pages are affected and verifies the fix. Local reads are unchanged, nothing stored changes, and no trust tier is raised or lowered.

### Itemized changes

- `src/core/search/transcript-quote.ts`: `quotesTier` / `quotesStored` (a missing tier reads as `unknown`, so it fails closed); `quoteFacts` reads each fact's stored tier from the database for a remote reader.
- Search, query, recall, assemble_evidence, saved facts, context_pack, delta, `_meta.brain_hot_memory` (its cache key carries the quoting), `get_page` (body, timeline, windows), `fetch`, `get_timeline`, `get_chunks`, `search_exact`, `think`'s extractive fallback, `get_versions` and `known_as_of` reads (by the version's tier snapshot; a version without one reads as unverified) and `list_write_requests` / `get_write_request` outcome text quote by tier for remote readers.
- Tool-call blocks in conversation pages are summarized on `get_page`'s reading shape and `view: read` windows, `fetch`, `search_exact`, `get_chunks` and `think`; `include_content`, `view: markdown` and gbrain's thin client keep the stored bytes inside the fence. A remote `put_page` whose content holds a tool-call summary that a whole read of the stored conversation page never produces, or keeps a call's summary but fewer of that call than the page holds, refuses with `invalid_params` and stores nothing.
- A remote `put_page` round trip of any quoted page stores the body, never the fence; a forged fence in stored text stays inside the quote.
- Rendered context_pack/delta lines put a quoted fact's label on the marker line and close its fence on its own line.
- `gbrain doctor`: `trust_tiers` and `trust_sources_unclaimed` say remote readers see unverified pages quoted and name the claim and backfill commands.
- BrainBench poisoning: a payload inside a closed quote fence is judged by its fence's marker line, where its label is rendered.
- Tests: `test/search-transcript-quote-tiers.test.ts` (every placement and read surface, red on master), `test/search-transcript-quote-legacy-claim.test.ts` (legacy note quoted, raw again after claim and backfill), both on PGLite and Postgres; existing fixtures that stand for the owner's own notes now write at the owner tier (`test/helpers/owner-tier.ts`).

## [0.60.535.0] - 2026-11-01

**Master's fence-census suite passes again after the 2026 DST fallback.** The test 'the incremental pass in batches of one reads every page across a DST fallback in the session time zone' wrote fixed `updated_at` values in the 2026-11-01 New York fallback hour. The census only reads pages updated at or after its watermark (the database clock minus two minutes), so once the clock passed about 05:22Z on 2026-11-01 those pages began falling behind the watermark, and the test has failed on every run since. It now uses the next fallback that is still ahead of the database clock and asserts that the four instants read 01:20-04, 01:40-04, 01:10-05 and 01:30-05 in the session time zone, so the DST coverage can't quietly disappear. It also runs with the clock pinned inside the 2026 and 2027 fallback hours.

### Itemized changes

- `test/fence-census.test.ts`: the DST-fallback census test derives its instants from the next New York fallback after `now()`, checks their local text offsets, and runs at the real clock plus two pinned clocks (2026-11-01T05:30Z and 2027-11-07T05:30Z). With the old fixed instants, all three fail.

## [0.60.534.0] - 2026-11-01

**Merge train S: five sync, refresh and maintenance fixes land in one release.** Page writes create a missing source folder and name a missing checkout (#8106). A diverged managed checkout can publish itself on opt-in, and every refresh fetch is logged (#8102). Sync-lane wave 2 repairs quoted fence markers, releases agreeing file-drift holds, syncs plain directories and retires former-binding effects (#8077). The `synthesize` phase survives a local writer replace (#8111). A door commit during a refresh is waited out instead of failing the refresh as `refresh_dirty` (#8117).

### Missing source folders and checkouts (#8106)

**Page writes to a source whose directory is missing on the brain host no longer fail with a misleading `storage_error`. A source that is a folder inside a checkout now gets its folder created on the first write, and a source whose whole checkout is gone gets a refusal that says so. A checkout restored or copied into place, or one whose private ownership records lost their mode, now refuses with the exact owner step that fixes it.**

#### What changed

| Situation | Before | Now |
|---|---|---|
| The source is a folder inside a checkout and the folder is missing (Git keeps no empty folder, so a fresh clone of a repository whose member folder has no files yet lacks it) | every `put_page`, `capture` and `add_timeline_entry` to it failed with `storage_error` ("The canonical file target cannot be accessed as a regular file"), so a token granted only that member's source could save nothing | the write creates the folder and the page, and the same token reads it back |
| The source's whole checkout is missing (a brain copied to another machine or into a container without its source directories) | the same `storage_error`, whose fix told the agent to repair file permissions | `recovery_required` with `detail: source_checkout_missing`, naming the source; the fix is the read-only `gbrain sources writer status --source <id> --json`, which shows the registered path. Remote callers are not shown the path. Nothing is written, as before |
| The checkout was restored, copied or recreated at its recorded path (new inode or birth time) | `recovery_required` whose `fix` only said to read the receipt | `detail: physical_root_directory_changed`, and the `fix` is the owner-run relocated-root self-transfer (`gbrain sources writer transfer prepare` then `accept`, both with `--self-transfer --confirm-relocated-root`) with `next: tell_user_to_run`. The re-stamp stays a deliberate step on the brain host |
| An ownership record of the checkout became readable by other users (a recursive `chmod` of a copied brain) | `recovery_required` ("The private physical-checkout identity cannot be verified"), and doctor's `foreign_ownership_marker` called the file foreign and told the operator to remove it | `detail: ownership_record_not_private` with `gbrain doctor --only foreign_ownership_marker` as the fix; doctor now reports this brain's own record with its mode and the exact `chmod 600 '<path>'`, never removal, and lists each record once |

A token's source grant decides where it writes exactly as before; this changes only how the file path inside the granted source is resolved and how these refusals name their exit.

### Publishing a diverged checkout (#8102)

**A managed checkout that gets local commits while a sibling checkout pushes the same branch can now stay current without a person in the loop. Turn on `sources.refresh_publish_diverged` and a diverged `gbrain sources refresh` publishes the local commits merged with the upstream, then fast-forwards.**

Before, such a refresh always refused `refresh_diverged`, and the database lagged the upstream until someone ran the keep-checkout publish by hand or a scheduled publish caught up. That repeated every interval. The setting is the user's standing consent to push those local commits. It defaults to off, so nothing changes for existing brains.

#### What changed

| Situation | Before | Now |
|---|---|---|
| Diverged checkout, setting on | refused `refresh_diverged` | pushes HEAD merged with the upstream in memory (the `gbrain git commit-push --push-only --keep-checkout` publish), fast-forwards to the merge and reports `published` (sha, local commits, upstream commits merged) |
| Diverged checkout, setting off (the default) | refused `refresh_diverged` | unchanged; the refusal now also names the setting |
| A file both sides changed, setting on | n/a | refuses `integrate_conflict` naming the file; nothing is pushed, fenced or moved. With `gbrain.quarantine` on, the remote's version is published instead and the refresh names the ref that keeps this machine's version |
| An uncommitted edit to a file the upstream changed, setting on | n/a | refuses `refresh_dirty` before anything is pushed |
| An upstream rewritten by a force-push (it no longer holds a commit it held before), or no record of the upstream before the fetch, setting on | n/a | refuses `refresh_diverged` and pushes nothing, so the commits the rewrite removed never come back without the user |
| A force-push that lands after the refresh checked the upstream but before the publish pushes, setting on | n/a | refuses `push_unconfirmed` and pushes nothing. The publish is bound to the upstream the refresh checked (`--expect-remote`), so the removed commits never come back. Run the refresh again; it checks the new history first |
| A refusal after the publish landed | n/a | the refusal says the remote already holds the local commits |
| `--dry-run` | refused `refresh_diverged` | unchanged: a dry run never publishes |
| `gbrain config set sources.refresh_fetch_timeout_ms` / `sources.refresh_drain_wait_ms` | refused as an unknown key, although the refresh reads both | accepted |

#### Things to watch after you upgrade

- The publish needs a Git identity in the checkout for the merge commit, the same as the manual keep-checkout publish.
- It never uses a `--pull` that moves the checkout. The merge is built in memory and pushed, and the checkout moves only through the refresh's usual fast-forward.
- The push skips the checkout's pre-push hook, as the manual keep-checkout publish does. If you rely on a pre-push secret scanner, leave the setting off.
- The setting covers every managed checkout in the brain.
- If another publish of the same checkout is running, the refresh refuses at once instead of waiting; run it again.

#### Itemized changes

- `src/core/persistence/worktree-refresh.ts`: when `sources.refresh_publish_diverged` is on and the run is not a dry run, the precheck runs the keep-checkout publish (`gbrain git commit-push --push-only --keep-checkout` in a bounded child, never on the PGLite owner's event loop) for a diverged checkout (after refusing `refresh_dirty` first when an uncommitted edit touches a file the upstream changed), re-fetches and continues; it refuses `refresh_diverged` instead when the checkout holds a commit the upstream held before (reachable from the remote-tracking ref before this fetch, from its reflog, or from a completed refresh's target for the same upstream) but no longer contains, or when no record exists (no reflog entry, no completed refresh, and `core.logAllRefUpdates` off, so the ref before the fetch may already be past a force-push); every refresh fetch, with the setting on or off and in a dry run, records the move in the reflog, so a refusal's own fetch can never erase what the upstream held; the result carries `published` (with any quarantined or superseded paths, which the text output names), and a refusal after the publish says the remote already holds the local commits. The `refresh_diverged` suggestion names the setting.
- `src/commands/sources-refresh.ts`: a text line for the publish.
- `src/core/config-runtime-keys.ts`: registers `sources.refresh_publish_diverged`, `sources.refresh_fetch_timeout_ms` and `sources.refresh_drain_wait_ms`.
- Docs: `docs/guides/live-sync.md`, `docs/guides/write-refusals.md`, `docs/guides/troubleshooting.md`, `docs/guides/shared-checkout-git.md`, `docs/architecture/canonical-writers.md` and its census.
- Tests: `test/refresh-publish-diverged-7686.test.ts` (setting on and off, a conflict, quarantine, a dirty overlap, a refusal after the publish, a publish child that fails, and a dry run, on PGLite and on Postgres through `test/e2e/worktree-refresh-postgres.test.ts`). Tests 7c and 7d in `test/persistence-worktree-refresh.test.ts` share one fixture across their cells and run in about half the time, with every assertion kept (#7782).

#### How to get it

```bash
gbrain config set sources.refresh_publish_diverged true
```

### Sync-lane wave 2 (#8077)

**Sync-lane wave 2: a transcript that quotes a fence marker is repaired instead of held for a person, held files that already agree with their pages can be released, a plain directory added with `--force` syncs, and a parked effect left behind by a replaced binding has a guarded way out.**

A page that quotes a facts or takes marker in prose was held `invalid_fence` as `repeated_marker` for a person to fix. It is now held as `quoted_marker`, and `gbrain repair fences`, `gbrain repair content`, `gbrain sync unblock --apply` and the maintenance run fix it by wrapping each mention in backticks, with a receipt per file. No reader counts fence lines any differently (#8059). Older `file_drift` holds on pages with no import record are checked once more against the file's earlier versions (#7199, re-port of #7228). A held file that agrees with its page apart from formatting is released (#7931, #7950). A refused `repair file-drift --apply` no longer reserves its request id (#7931).

#### Itemized changes

- **#8059 quoted fence markers.** The new `src/core/fence-repair/quote-markers.ts` wraps prose mentions: an exact marker outside code and table lines, with text after it on its line or on a blockquote line, that doesn't close a fence holding rows and isn't directly above a table. The edit is kept only when every row of every fence keeps its line and kind, and when nothing `protectedRegions` hid becomes visible. Only the repair makes the edit; write paths just name the reason `quoted_marker`. Existing `invalid_fence` holds get one more screen through a hold-only `quote_version`, and the parser version stays the same. `forget` now finds the facts fence with the parser's code-aware locator.
- **Quoted-marker screen stays linear.** The write-path screen for prose-quoted markers found each mention's line by re-reading the page up to it, so a page with 40,000 mentions took 12 to 18 seconds and a 24 MiB page minutes. It now reads each page once, and the same 40,000 mentions take about 100 ms.
- **markerCarry.** A segmented read carries only a marker that a cut splits, not a whole one.
- **#7199 (re-port of #7228).** A record-less page that equals the file at the last synced commit, or one of its three earlier committed versions, imports without a hold. Side-unknown hold text now says what was compared. A pass that holds files for a person reports `held_needs_human`. Git tree listings are memoized by object id (GBRA-135).
- **#7931 parts 2 and 3.** A held file whose page agrees apart from formatting is released. The request id of a `repair file-drift` apply now includes the approved artifact digest, so an apply refused before publishing doesn't block the next preview.
- **#7950.** An agreeing held page found through `--slug` is listed `release_hold`, bound to the hold's `observed_at`. An empty preview applies nothing. Contributed by @Masashi-Ono0611 (supersedes #7953).
- **#7974.** The stale-mirror drift read no longer throws on an ambiguous slug path, and it compares contents. `slugPathFile` uses the source's slug-root mode and doesn't follow symlinks. `release_hold` needs the held path and a file hash. The `keep_file_bytes` and file-wins docs are corrected.
- **#7973.** `gbrain sync` on a plain directory added with `sources add --force` runs the import path instead of failing on `git rev-parse`. The managed Git path refuses with a typed `sync_not_applicable`.
- **#7988.** Activation marks a non-git root in its own directory, never in the metadata of the repository that contains it, such as a dotfiles `$HOME`.
- **#7985.** Parked effects of a former binding get their own group, with `settle-effects` as the next step. The exact retry names both bindings. `settle-effects --retire` (proof `former_binding_retired`) settles one only when its source was replaced or its page moved past the owed revision. The settlement is preview-first, bound to a hash, reversible with `--unsettle`, and never replays anything.
- **#7982.** Repeated transient pass stops build the abandoned-pass streak. An unfenced `lease_lost` stop never inserts a row. The pass-row and drain-holder readers compare against the database clock.
- **#8009.** The `repair provenance-stamps` preview and apply share one held-page filter, so the preview's count equals what the apply writes.
- **#7998 flake.** The page-embedding-lease harness pushes other queued effects out of the way before it drains the one under test.

### Synthesize postprocess after a writer replace (#8111)

**A dream cycle's `synthesize` phase no longer fails on every pass after `gbrain auth local-writer register cli --replace` (#8110).** Postprocess settles on the earlier request it already found, checked under the current local CLI writer's grant, instead of looking it up again under the new principal and publishing against a stale revision (`revision_conflict` forever). A synthesis child output whose own stdio writer was revoked warns once as a `permission_denied` conflict and leaves the page alone. Receipt lookups stay principal-scoped.

#### Itemized changes

- `src/core/cycle/synthesize-postprocess.ts`: settle on the found row; a revoked child writer is a one-time `permission_denied` conflict.
- Test: `test/managed-synthesis-postprocess.test.ts` (PGLite, and Postgres through its E2E wrapper).

### Door commits during a refresh (#8117)

**A `gbrain git commit-push` landing during a `gbrain sources refresh` no longer makes the refresh fail as `refresh_dirty` (#8117).** The refresh now runs its HEAD check and fast-forward merge under the checkout's commit lock, the same lock the door uses, so it waits for a door commit to finish instead of colliding with it on `.git/index.lock`.

#### Itemized changes

- `src/core/persistence/worktree-refresh.ts`: `fenceAndMerge` takes the checkout's commit lock (`brain-commit.lock` plus the legacy push lock, waiting `GBRAIN_COMMIT_LOCK_WAIT_SECONDS`, default 60) from the HEAD check through the merge. A lock still held past that wait aborts the fenced refresh as retryable `commit_lock_busy`. A git process outside the lock that holds `.git/index.lock` gets three short retries, then a retryable `git_index_locked` refusal instead of the caller-class `refresh_dirty`. Either way HEAD is unchanged and the next run starts fresh.
- Test: `test/worktree-refresh-index-lock-8117.test.ts`.

## [0.60.533.0] - 2026-11-01

**A delegated sync no longer reports `done` while it is still finishing.** The serve's sync runner published `done` before it re-checked the wanted markers and scheduled the deferred embeds. A client polling in that window saw a finished job with no embed backlog queued yet, and a second `sync_start` could begin while the first run was still settling its markers. Since #7941 the marker re-check also reads the checkout HEAD through git, which widened the window enough to fail `test/serve-sync-runner.serial.test.ts` intermittently on master (#8354). Both lanes (the shared-secret lane and the verified lane) now set `done` only after those steps, and a deadline or client abort that arrives after the run has finished no longer marks it `aborting`.

### Itemized changes

- `src/core/serve-sync-runner.ts`: `job.state = 'done'` moves after `settleRunMarkers` and `scheduleDeferredSyncEmbeds` in both lanes (#8354); the deadline and `sync_abort` skip a job whose run already returned its result.
- `test/serve-sync-runner.serial.test.ts`: a probe slows the post-run marker read and checks that `done` is only visible once the markers have settled and the deferred embeds are pending; a second probe aborts during that settle and checks the job still ends `done`. Both fail without the fix.

## [0.60.532.0] - 2026-11-01

**CI wave 3: a passed full-ci pair can now clear the remote gate without a second full suite on VMs, the import-rate scale gate no longer fails on one stall, an effect pass that loses its database connection gives its claims back at once, and the Ubicloud runner's teardown retries instead of leaking VMs (#7939, #8103, #8096, #7607, #8119).**

The `full-suite-tree` and `e2e-full-suite-tree` artifacts now record every test file the run executed and the executed test count, taken from the run's complete `ci-manifest.json`, so gstack's `pregate clear --run` can accept a passed full-ci pair on the same tree as run evidence. `bash scripts/pregate-remote-gate.sh --list` prints the gate's own inventory, and the seven files that never left a receipt on GitHub now do, or leave the gate. The import-rate gate sets aside at most one stall per import (a paused database container, a WAL checkpoint) and never work that recurs; a cost that lands only once in a 10k import is a known gap the 20k nightly still sees. An effect pass whose database connection drops while claiming or flushing git effects gives back every claim it had not finished as soon as the database answers, within 30 s and stopping on shutdown, instead of leaving them to a 2-minute lease. The remote gate's CI-reuse wait keeps waiting for the head's own dispatch, refuses when the run in progress fails, and treats a failed artifact download as retryable. The Ubicloud runner's `down` retries a timed-out or 5xx destroy with backoff until `UBI_DOWN_TIMEOUT`, `reap` bounds each VM's wait, and `UBI_REAP` refuses spellings it cannot read.

### Itemized changes

- `scripts/ci-full-suite-tree.sh`, `.github/workflows/test.yml`, `e2e.yml`: `files` and `tests` in tree.json from a complete, matching manifest; the full jobs need `executed-receipts`. The reconciliation crash suites run through `run-with-receipt.sh` (now accepting `bun --no-env-file test`); the keyed-only `test/e2e/skills.test.ts` leaves the keyless gate.
- `scripts/pregate-remote-gate.sh`, `scripts/ci-ubicloud.ts`: `--list` prints the gate inventory and fails on an empty one.
- `scripts/scale/gates.ts`: one-stall rule for `import_rate`; `import.<basis>.excused` names the time set aside (#7939).
- `src/core/persistence/effects.ts`: connection-loss give-back for claimed, set-aside and unflushed git effects, fenced on each claim's token (ported from #7607).
- `scripts/ci-reuse.ts`, `scripts/lib/gh-issue.ts`: the gate waits for a run in progress beside a missing one, refuses a refused receipt only on the head itself, and retries a failed download; an earlier attempt's ledger counts only when its job was carried over (#8096).
- `scripts/ubicloud/ubi-runner.sh`: `down` destroy retries with 1 to 60 s backoff, `reap` per-VM bound `UBI_REAP_DOWN_TIMEOUT`, strict `UBI_REAP` (#8103, #8096).
- `scripts/mine-shard-weights.ts`: prunes against tracked files in every mode; shard weights refreshed (#8119).
- Test fixes ported from #7607: page-embedding lease ordering, git-commit-push-6530 cases, timeline-chunk-reuse handback, segmented-prior-view heap sample, awk portability lint.

## [0.60.531.0] - 2026-10-31

**Five severe fixes: the secret scan now redacts keys that follow a JSON or percent escape, a connector page that turns private leaves Git HEAD, deleted pages no longer stay searchable under a scoped writer role, a stale freshness marker can no longer starve the job queue, and a slow embedder no longer loses `remember` writes (#7978, #7971, #7637, #7941, #8135).**

The secret scan's rules required a non-word character before a key, but a JSON escape (`\n`, `\t`, `\u0022`) and a percent-escape (`%22`) end on a word character, so a key at the start of an escaped tool-output string or inside a URL-encoded value was never redacted. Every rule now also matches right after such an escape (an escaped quote between a keyword like `password` and its value is still a gap, tracked in #8265), and a vendor key that recurs glued to a word (`token_<key>`) is scrubbed wherever the same key is claimed elsewhere in the document. On a managed connector source bound to a Git checkout, a page that turned private kept its public file at HEAD; it is now removed in the same publication. A page that already turned private before this release keeps its old public file until it is removed by hand (#8269). Under a database role with row-level security that lacks policies on the derived-state tables, deleting a page left its retrieval rows searchable and page versions lost their trust and attribution stamps without an error; those writes now refuse with `writer_coordinator_required`, and `docs/ENGINES.md` lists the policies such a role needs. A freshness marker naming a commit the source had already passed kept every sync queuing another top-priority follow-up; a completed run now settles it once the checkout has nothing left to import. A `remember` whose embed took longer than its 30 s preparation budget ended `preparation_stalled` with nothing saved; the fact is now saved without a vector and embedded later.

### Itemized changes

- `src/core/secret-scan.ts`: escape-boundary twin for every rule, run only on lines holding an escape; vendor and JWT values (20 to 512 characters) join the echo dictionary under their own 32-value cap, so planted vendor strings cannot crowd out a bearer token's echo (#7978). The `high_entropy_assignment` shapes moved to `src/core/secret-scan-assignment.ts` (module size cap).
- `src/core/persistence/connector-sync.ts`: a strict private import of a public page publishes the file removal from `preparePrivateTransition` (#7971 item 1).
- `src/core/derived-state-maintainers.ts`, migration v281: the eight derived-state maintainer triggers stay `SECURITY INVOKER` and fail closed when the caller's row-level security hides a table they need; `docs/ENGINES.md` "Derived-state maintainers" recipe (#7637).
- `src/core/notifier/store.ts`, `handoff.ts`, `resident.ts`: settlement takes the checkout HEAD after the run (#7941).
- `src/core/facts/single-prepare.ts`, `src/core/persistence/memory-prepare.ts`, `service.ts`: the fact embed is bounded inside the preparation deadline (#8135).

## [0.60.530.0] - 2026-10-31

**`gbrain sources refresh` no longer exits with a bare `internal_error` when another database transaction holds a row its fence needs. A fence that waits past its 5 s lock timeout now refuses as `refresh_lock_timeout`, and `why` names the open transactions holding those tables. Nothing moves, and a later run completes once the holder is gone. Any other unexpected error now prints a typed `internal_error` refusal with its stack in `why` and the refresh row it left, which the next run resumes.**

Before, a stuck transaction holding a source, worktree or brain row (a long-running job, for example) made an upstream-moved refresh fail after about 5 s with `canceling statement due to lock timeout`. That surfaced as a top-level `internal_error` with no `status`, no stack and no holder. If it happened after the drain, it also left a `draining` row for the next run to clean up.

### Itemized changes

- `src/core/persistence/worktree-refresh.ts`: Postgres `55P03` in either fence transaction (`fenceDraining`, `fenceAndMerge`) is the new `refresh_lock_timeout` refusal (registry, catalogue, `docs/guides/write-refusals.md`, `docs/guides/error-codes.md`). Its `why` lists the five oldest open transactions in the current database holding locks on `persistence_brain`, `persistence_worktrees`, `sources` or `persistence_worktree_refreshes` (pid, application, state, seconds open). These are candidates, and the blocker may not be among them, because `pg_locks` does not show which row each one holds; the fix says to confirm the blocker before ending any transaction. Plain readers, which cannot block the fence, are left out, the holders' SQL text is never copied into `why`, and a lookup that fails or takes longer than 3 s says so (the statement is cancelled at that bound, and after the drain the lookup runs only once the topology and worktree locks are released). A refusal after the drain aborts the draining row as other fence refusals do. That abort has its own 5 s lock timeout. When the same holder blocks it, the row stays `draining` for the next run instead of the refresh hanging, and the refusal says so.
- `src/core/persistence/worktree-refresh.ts`: `refreshWorktree` turns any other non-`OperationError` throw into `internal_error` with the error name, error code (a SQLSTATE or a Node code) and message (credentials, connection details and the home directory redacted), the stack in `why`, and a fix naming the active refresh row and its state, or saying the row could not be read (also when that lookup takes more than 3 s; its statements are cancelled at that bound). A deadlock (`40P01`), serialization failure (`40001`), cancelled statement (`57014`) or lock timeout outside the fence (`55P03`) is marked retryable. The fix repeats `--dry-run`, `--abandon`, `--resume`, `--wait-drain` and `--fetch-timeout-ms` when given. Home-directory redaction replaces only the home path itself, not a sibling path that shares its prefix. The row is not changed, and a host identity file that cannot be read still yields that refusal. A database access error the classifier recognizes (connection refused, a missing table) is rethrown unchanged, so it keeps its `gbrain db-repair` or `gbrain apply-migrations` fix. The already-current path no longer throws a `TypeError` of its own when a member sync rejects with a non-object.
- `src/commands/sources-refresh.ts`: refusals print `why` (a `why` key under `--json`, a `Why:` line otherwise).
- Test: `test/worktree-refresh-unexpected-throw.test.ts` (PGLite, and Postgres under `DATABASE_URL`; the lock-timeout cases hold a source row from a second connection, before the fence and after the drain, and check that a plain reader is not named and no SQL text is echoed; an unreadable host identity file still gives a typed refusal, an access error is not wrapped, credentials and the home directory are redacted without touching a sibling path, `--abandon` and `--dry-run` survive into the fix, a lookup that never answers still gives the refusal and is cancelled (row lookup and lock-holder lookup), transient SQLSTATEs are retryable, the holder list is worded as candidates, and an abort blocked by the same holder still returns and says the row stays draining).

## [0.60.529.0] - 2026-10-31

**A pull request that adds a file to the PGLite snapshot inputs no longer gets stopped at gstack's pregate secrets check by its own workflow cache keys (#8107).**

Pregate read every `key: pglite-snapshot-${{ runner.os }}-${{ hashFiles(...) }}` line in the workflow files as a possible secret (`env.kv`), and a branch can't allowlist findings on its own lines. `.gstack/pregate.json` now allowlists that one finding on those cache-key lines, and only when every `hashFiles` argument is a lowercase path or glob under `src/`, `test/` or `scripts/`. An argument with digits, capitals or a `./` prefix still gets flagged, and so does any recognized credential on the line. A new test checks that every cache-key line in the workflows is covered and that secret-shaped values are not. Nothing changes for users of the gbrain CLI.
