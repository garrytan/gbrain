# The brain store: doctor access reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads behind three `gbrain doctor` checks: `access_pages_read_by_nobody`, `owner_identity` and
`owner_only_marks_triggers`. PGLite and Postgres run the same SQL as before: `src/core/engine-sql/doctor-access.ts` for the page
and binding reads, with the folder-rule text pinned by `test/doctor-access-sql.test.ts` against `ruleCoversSql`, and
`src/core/engine-sql/owner-only-marks.ts` for the trigger state. The TypeScript side is
`src/core/rust-engine/store-members/doctor-access.ts`; the store side is `rust/crates/gbrain-store/src/access_doctor.rs`.
`test/engine-parity/doctor-access.test.ts` compares the whole checks on PGLite, Postgres and Rust.

## Served from the store

| JS | Reads |
| --- | --- |
| `brain.listPagesReadByNobody({ by: 'labelled', live })` | the live labelled pages whose normalized readers (`page_readers`) name none of `live` and not `!nobody`; member pages left out |
| `brain.listPagesReadByNobody({ by: 'rule', sourceId, prefix, admitted })` | the live pages of one source a folder rule covers, not closed on purpose, that no identity in `admitted` reads (every covered page when `admitted` is empty) |
| `brain.ownerOnlyGuarded()` | whether the brain holds an owner-only source or an owner-only mark |

`ownerOnlyMarkTriggers` is answered from `ownerOnlyGuarded` in TypeScript. SQL marks the rows an owner-only delete leaves derived
through five BEFORE DELETE triggers (`sources`, `pages`, `facts`, `takes`, `timeline_entries`); a role that does not own a table
cannot create its trigger, and the read names the missing ones. The store has no triggers to miss: every delete it serves marks
inline in the same write (`owner_only_marks.rs`). The rows SQL's facts, takes and timeline triggers mark are the descendants a
`derivation_inputs` edge names, and the store holds no such edges (`recordDerivationEdges` has no store member, loss row 34); a
page's own takes and timeline rows go with the page. So the store reports:

| Field | Rust answer | Why |
| --- | --- | --- |
| `missing` | `[]` | no trigger exists to be missing |
| `closed` | `false` | the unguarded mark is set only when a trigger was missing |
| `rowSecurity` | `false` | the store has no database logins whose reads row-level security narrows |
| `held` | the guard (`ownerOnlyGuarded`) | SQL keeps a flag that stays set once the brain held owner-only data; the store reads the sources and the marks on every delete instead |
| `unflagged` | `false` | there is no held flag a data-only restore could leave unset |
| `deniedLogins`, `closedLogins` | `[]` | no database logins |
| `role` | `''` | no database role (printed only in the missing-trigger fix) |

`ensure` and `installing` change nothing: there is nothing to create. When the store gets `derivation_inputs`, its deletes must
mark the descendants as SQL's triggers do before this answer stays true.

Differences from the SQL a caller can see on a Rust brain:

- The 5-second statement deadline of `access_pages_read_by_nobody` is not enforced: `listPagesReadByNobody` takes the same
  `opts` (`timeoutMs`, `signal`) and the Rust member ignores them, as PGLite does.
- The rows come by (source, slug); the SQL has no ORDER BY, and the check sorts them.

## Members with no writer on a Rust brain (answer empty)

`access_member_sources` (v299) is written only through `executeRaw` (`src/core/access/member-sources.ts`, `gbrain access member
sources add`), which a Rust brain refuses, so no source is bound to a member there. This answers `[]` in TypeScript with no store
call, which is what the same read finds on a PGLite brain nothing has bound a source on:

| JS | Resolves | Reads |
| --- | --- | --- |
| `listAccessMemberSources()` | `[]` | every member-source binding, for the owner identity's Google sources |

The parity case that binds a source stops on the Rust arm at that write; when the write is served, the case runs there and this
read has to come from the store too.
