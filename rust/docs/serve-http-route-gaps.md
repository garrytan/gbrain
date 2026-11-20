# serve-http on a Rust brain: the calls that differ, by owner

Every call of the [route table](serve-http-routes.md) at 8e72de1bb6 that is not equal on PGLite and Rust: 64 of 218.
"Rust result" is what the Rust arm answered. "Cause" is the first site Rust stops at (file:line at 8e72de1bb6); a site in
brackets is reached on PGLite only, after the first one. "Owner" is the lane or the commit that removes the cause.

## Count per owner

| Owner | Calls |
| --- | --- |
| lane 6 (section B MCP tools) | 9 |
| lane 14 (run_doctor, run_onboard, ops reads) | 3 |
| lane 1 (write-misc.ts member and group reads) | 0 |
| route-gaps-rust (section C: the remote MCP writes and the reads that follow them) | 25 |
| a commit on another branch (named in the row) | 16 |
| not a gap (named reason) | 11 |
| total | 64 |

## Section C: remote MCP writes (route-gaps-rust)

All are `POST /mcp` `tools/call` with the legacy token. On 8e72de1bb6 every one of them stops at the same place first.

| Route | Method | Rust result | Cause | Owner |
| --- | --- | --- | --- | --- |
| add_tag, add_timeline_entry, append_page, capture, put_page, remove_tag, restore_page, revert_version, takes_add, takes_resolve, takes_supersede, takes_update (12) | POST | 200, `permission_denied` (`host_only`) "The owning token is revoked." for a live token | `src/core/rust-engine/store-members/persistence.ts:116-117`: `readAccessTokenWriteGrant` and `readOAuthClientWriteGrant` answer null, so `authorizeWrite` (`src/core/persistence/authority.ts:206-207`, legacy token; the OAuth branch denies the same way) denies | rust-token-member-binding 5a32485552 (3e7a6e9ace, in cli-members-next f2283364a4) |

This is a silent answer (a wrong reason, not a refusal by name). It is the other lane's code, so this branch does not
change it.

Behind that stop, a probe-only stand-in that answers the two grant reads with the PGLite rows shows the next stops:

| Next stop | Cause | Owner |
| --- | --- | --- |
| 1 | `getChunks` with `requireSafeChunks`, refused by name at `src/core/rust-engine/store-members/chunks.ts:64` (via `src/core/import-chunk-reuse.ts:53`) | rust-engine/main bc16a64c9e |
| 2 | the body timeline insert, raw at `src/core/persistence/canonical-projections.ts:605` (via `pipelined`, `src/core/page-state/transactions.ts:84`) | rust-engine/main 071ccd4615 |
| reached on PGLite only | `src/core/trust/page-write.ts:287`, `:293` | rust-engine/main a4698dca17 |
| reached on PGLite only | `src/core/trust/fence-guard.ts:207`, `src/core/persistence/page-append.ts:437` | rust-engine/main 03260fb910 |
| not on the Rust path | `src/core/persistence/managed-mode.ts:92`, `topology-recovery.ts:227`, `effect-journal.ts:293`, `:296`, `journal.ts:1141`, `:1149` (each sits behind a Rust or PGLite-only guard) | none needed |

No site past stop 2 can be seen on this base. rust-engine/main alone cannot serve the probe: its Rust arm answers 500 to
the legacy token and cannot register the OAuth clients, which the work on this lane added.

The 13 reads below differ only because the writes above wrote nothing on Rust. Each is expected to be equal once
section C clears; each is checked again then.

| Route | Rust result |
| --- | --- |
| chronicle_day, chronicle_since, get_timeline | no timeline row (the PGLite add_timeline_entry row is missing) |
| get_page, get_chunks, search_exact, recall | the page has no appended text: `origin` `legacy`, one chunk |
| get_versions, get_write_attribution | no version rows, last writer is the seed |
| get_stats, get_brain_identity | `chunk_count` 4 (PGLite 5), `timeline_entry_count` 0 (PGLite 1) |
| list_pages, get_recent_salience | same pages in another order (notes/widget-0 was not updated) |

## Lane 6: section B MCP tools

| Route | Method | Rust result | Cause | Owner |
| --- | --- | --- | --- | --- |
| cache_stats | POST /mcp | refused by name | `src/core/search/query-cache.ts:425` | lane 6 |
| delete_page | POST /mcp | refused by name | `src/core/repair/origin-carry.ts:121` | lane 6 |
| get_status_snapshot | POST /mcp | refused by name | `src/core/sync-status-report.ts:136` | lane 6 |
| list_write_conflicts | POST /mcp | refused by name | `src/core/persistence/drift-conflicts.ts:298` [`:326`, `:331`] | lane 6 |
| ontology_propose | POST /mcp | refused by name | `src/core/belief/writers.ts:41` [`src/core/trust/supersede-handlers.ts:169`] | lane 6 |
| put_pages | POST /mcp | refused by name | `src/core/persistence/page-batch.ts:117` | lane 6 |
| schema_stats | POST /mcp | refused by name | `src/core/schema-pack/stats.ts:178` [`:217`] | lane 6 |
| get_job_stats | POST /mcp | refused by name | `src/core/ops/jobs.ts:292` | lane 6 |
| rank_entities | POST /mcp | equal body, refusal caught and swallowed | `src/core/verbs/entity-variants.ts:161` | lane 6 |

## Lane 14: run_doctor, run_onboard and the ops reads

| Route | Method | Rust result | Cause | Owner |
| --- | --- | --- | --- | --- |
| /admin/api/ops | GET | 200, `capacity.status` `unknown` with the refusal as its reason | `src/commands/doctor/checks/persistence-capacity.ts:33`, `src/core/persistence/terminal-failures.ts:241`, `sync-movement.ts:141`, `sync-admission.ts:84`, `persistence-compaction.ts:24`, `soak-counters.ts:90`, `src/commands/doctor/schema-pack-checks.ts:118`, `src/core/persistence/capacity-view.ts:34` | lane 14 |
| run_doctor | POST /mcp | refused by name at 36 of the 77 sites PGLite reads, first `src/core/timeline-dedup-repair.ts:80` | see the run_doctor trace | lane 14 |
| run_onboard | POST /mcp | refused by name | `src/core/onboard/checks.ts:712`, `:781`, `:54` | lane 14 |

## Owned by a commit on another branch

| Route | Method | Rust result | Cause | Owner |
| --- | --- | --- | --- | --- |
| /admin/api/calibration/pattern/:id | GET | 500 (PGLite 404) | `src/commands/calibration.ts:72` | rust-engine/main a51d656180 |
| /admin/api/calibration/profile | GET | 500 (PGLite 200) | `src/commands/calibration.ts:72` | rust-engine/main a51d656180 |
| /admin/api/calibration/charts/:type | GET | 500 (PGLite 200) | `src/commands/calibration.ts:72` | rust-engine/main a51d656180 |
| get_calibration_profile | POST /mcp | refused by name | `src/commands/calibration.ts:72` | rust-engine/main a51d656180 |
| /admin/api/clients | GET | 503 `administration_unavailable` (PGLite 200) | `src/commands/serve-http-clients.ts:21` | collate-equal 9891337c0c |
| schema_review_orphans | POST /mcp | refused by name | `src/core/schema-pack/review.ts:146` | collate-equal 50d309535b |
| /metrics | GET | same body; the refusal is caught, so the terminal-failure counters read nothing | `src/core/persistence/terminal-failures.ts:241` [`:247`, `:106`] | cli-members-next 059b3907c4, 9604e80a30 |
| initialize (OAuth token) | POST /mcp | same body; the refusals are caught, so the readiness and backup notices are missing | `src/core/readiness.ts:698`, `:618`, `src/core/backup/coverage.ts:128` [`:112`] | cli-members-next 02fa409e22, 6988b1b902, bc29c9bc2c, 97cc4bad57 |
| get_brain_health | POST /mcp | `status` `unknown` (PGLite `ok`) | `src/core/persistence/sync-blocked.ts:32` [`sync-failures.ts:171`, `:202`, `sync-pass-row.ts:185`] | cli-members-next 059b3907c4, 8d5ebffdd6, 6284f56c0e |
| forget, forget_fact | POST /mcp | `unavailable` (PGLite `not_found`) | `src/core/trust/supersede-handlers.ts:142` [`src/core/persistence/memory-mutations.ts:439`, `forget-prepare.ts:108`] | rust-engine/main 6998ccdaf2, 4ead15b915 |
| get_health | POST /mcp | refused by name | `src/core/ops/admin.ts:73` | rust-belief-batch 0895649aab |
| get_tags | POST /mcp | refused by name | `src/core/ops/tags.ts:90` | quote-tier-reads 8f106d51c3 |
| cancel_write_request, get_write_request, list_write_requests | POST /mcp | refused by name | `readAccessTokenReceiptGrant` at `src/core/ops/persistence.ts:72` | token-grant-gaps 331d167a46 |

## Not a gap

| Route | Method | Difference | Reason |
| --- | --- | --- | --- |
| /health | GET | `engine` `rust` (PGLite `pglite`) | the engine name |
| /admin/api/full-stats | GET | `engine` `rust` | the engine name |
| /admin/api/oauth-requests/:id | GET | `expiresAt` | the request time |
| cancel_job, get_job, list_jobs, wait_job | POST /mcp | `__submitter` and `submitted_by.via`, `source_uri` | the probe's own command line (`cli:<arm>`) and the submit time |
| query, search, think, whoami | POST /mcp | the embedding notice names `gbrain embeddings enable`; query and search also differ in `timings` | intended: a Rust brain turns vectors on in place (`src/core/readiness.ts:190`) |

`recall` has the same embedding notice and is counted under section C, for its missing appended text.
