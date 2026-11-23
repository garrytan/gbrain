# Design note: typed engine members for the retrieval reflex reads

Read against `rust-engine/hidden-refusals-2-rust` at 8530166f4d. `retrieval-reflex.ts` and `proactive-brief.ts` have not changed since efeb078093,
so the line numbers below hold for both. Nothing here has been built or run yet.
TL;DR: two typed members serve all six reads in `src/core/context/retrieval-reflex.ts`. A third member, for
`entityPages` (`src/core/context/proactive-brief.ts:203`), is needed before `context-pack --counterparty` can pass on Rust.
Every member delegates through the engine's own `executeRaw`, so the request-abort check stays (section 5).

## 1. The reads today
All six read `pages p`, filter `p.deleted_at IS NULL`, and splice in `${privacySql}`, which line 242 builds as follows:
`''` when `excludePrivate === false`, `AND privatePagesFilterForCaller('p')` when `forCaller` is set, and `AND remoteReadFloorSql('p')` otherwise.
`PREFIX` stands for `boundedBodyPrefixSql('p')`, which renders as `left(coalesce(p.compiled_truth, p.truth_lead), 65536)`. No read has a trust floor or a LIMIT.
- :78 weak-title (arm 2.6). Columns: slug, source_id, title, type, frontmatter, PREFIX. Where: `privacy AND source_id = ANY($1) AND lower(title) = ANY($2)`.
  Params: [sourceIds, norms]. No ORDER BY. The type exclusion (person, company, organization) and the uniqueness check run in JS.
- :357 alias live recheck. Columns: slug and source_id only. Where: `source_id = ANY($1) AND slug = ANY($2) privacy`, so privacy comes last. Params: [sourceIds, hit slugs].
- :417 name arms with the surname arm. Same columns as :78. Where: `privacy AND source_id = ANY($1) AND (lower(title) = ANY($2) OR slug = ANY($3)
  OR slug LIKE ANY($4) OR (lower(title) LIKE ANY($5) AND type = 'person')) ORDER BY p.id`. Params: [sourceIds, titlesLc, exactSlugs, `%/slug` suffixes, `% token` patterns].
  The surname patterns are LIKE-escaped. The slug suffixes are not escaped, so `_` stays a wildcard.
- :428 name arms without the surname arm. Same as :417 minus `$5`, with different line indentation. It runs whenever any candidate exists, even with empty arrays.
- :447 alias-only hydration. Columns: the full row. Where: `privacy AND source_id = ANY($1) AND slug = ANY($2)`. Params: [sourceIds, alias-only slugs]. No order.
- :531 CJK exact match. Columns: the full row. Where: `privacy AND source_id = ANY($1) AND (lower(title) = ANY($2) OR slug = ANY($3))`.
  Params: [sourceIds, cjkNorms, cjkNorms]. No order. Uniqueness per norm is checked in JS.
Composed at run time: the privacy mode (one of 3), the surname arm (one of 2 templates), and the source list (always a parameter).

## 2. Proposed members
Put the SQL in a new file, `src/core/engine-sql/reflex-reads.ts`. Each shape keeps its verbatim template literal, copied from today's file.
The builder picks a template; it does not compose clauses, because :417 and :428 differ in whitespace.
`reflexPrivacySql(privacy)` returns exactly the line-242 text, rendered inside the engine method so it runs in the caller's async context.
```ts
export type ReflexPrivacy = 'none' | 'caller' | 'floor';
export interface ReflexScope { sourceIds: readonly string[]; privacy: ReflexPrivacy }
export type ReflexPageMatch =
  | { kind: 'names'; titlesLc: readonly string[]; exactSlugs: readonly string[]; slugSuffixes: readonly string[]; surnamePatterns?: readonly string[] } // :417 if surnamePatterns is non-empty, else :428
  | { kind: 'slugs'; slugs: readonly string[] }       // :447
  | { kind: 'cjkExact'; norms: readonly string[] }    // :531
  | { kind: 'titles'; titlesLc: readonly string[] };  // :78
export interface ReflexPageRow { slug: string; source_id: string; title: string; type: string | null; frontmatter: Record<string, unknown> | null; compiled_truth: string | null } // today's PageRow, moved here and re-exported
readReflexLiveKeys(scope: ReflexScope, slugs: readonly string[]): Promise<Array<{ slug: string; source_id: string }>>; // :357
readReflexPages(scope: ReflexScope, match: ReflexPageMatch): Promise<ReflexPageRow[]>;
readBriefEntityPages(sourceId: string, slugs: readonly string[], opts: { privacy: ReflexPrivacy; eligibility?: ReadEligibility }): Promise<Array<{ slug: string; title: string | null; type: string | null }>>; // proactive-brief.ts:203
```
- PGLite and Postgres: each member is one delegating line through the engine's own `executeRaw`, as `readLongPageSizes` and `readEntityNewestFacts` do:
  `this.rawRead` in `src/core/pglite-engine.ts` and `this.executeRaw.bind(this)` in `src/core/postgres-engine.ts`.
  Do not follow `readEntityCardRows` (`preparationRead`): section 5 explains why.
- Rust, TypeScript side: add `src/core/rust-engine/store-members/reflex-reads.ts` and map all three members to `'pages'` in `members.ts`.
  The privacy mode maps to a store policy the way `retirementHopPolicy` does in `store-members/cli-entities.ts:67`:
  `storePageTextPolicy(member, () => privatePagesFilterForCaller('p') | remoteReadFloorSql('p'), { callerReaders: true })`.
  That helper is already exported from `store-members/private-provenance.ts:227`; import it and do not copy it.
  `eligibility` maps to `{ minTrust: floor ?? null, suppressFlagged }`, as `store-members/link-temporal.ts:115` does. `takeOptions` and `refuseMember` reject unknown kinds.
- Rust store: add `rust/crates/gbrain-store/src/cli_reads/reflex_reads.rs` and a napi binding at `rust/crates/gbrain-napi/src/families/reflex_reads.rs`.
  Model the binding on the `read_entity_card_rows` binding at `cli_entities.rs:253`. These helpers can be reused:
  `pages::read_page` (keyed by source and slug, used for the `slugs` kind and the live keys); `pages::all_pages` (`pages.rs:794`) for the title and suffix kinds.
  Also `pg_lower` (`cli_reads/pg_text.rs:29`), `facts::like` (`facts.rs:816`, which uses the `\` escape and the `%` and `_` wildcards), `page_hidden` with `PrivacyPolicy` (`facts/privacy.rs:256`).
  Also `page_body::truth_lead` (`page_body.rs:691`) with the 64K-character cut from `read_entity_card_rows` (`CARD_PREFIX_CHARS`, `cli_reads/entities.rs:139` and :397;
  move the cut into a shared function), and `TrustPolicy` (`trust/eligibility.rs:14`).
- New in Rust: filtering on several sources at once, LIKE ANY on slug and title, the `type = 'person'` guard, and sorting the `names` kind by page id.
  `all_pages` returns pages in (source, slug) order, so the sort is required. No CJK helper is needed: the CJK arm is exact equality, and n-grams stay in TypeScript.

## 3. Open choices
- How many members. Options: (a) one per read, six members; (b) one member with a union that also covers the live-key shape; (c) two members as above.
  Recommend (c). It mirrors `readEntityCardRows` (one member with a `match` union). It keeps one row type per member, and it touches about a third as much engine surface as (a).
- Privacy as a flag or as SQL. Recommend the 3-value `ReflexPrivacy` flag over passing `privacySql` text. The store can only check a policy it can name.
- `readBriefEntityPages`. Options: include it now, or leave it out and mark the context-pack case as a known Rust failure.
  Recommend including it. Without it, `resolvePullCounterparty` reaches the raw read at :203 next. That read has no catch, so a Rust brain refuses the whole call.

## 4. Catch changes
- :89, :364, :438, :454, :554 become `catch (err) { rethrowCapabilityRefusal(err); <today's fallback> }`. The helper is in `src/core/engine-capability-refusal.ts`.
- Two other spots also swallow refusals, and we fix them the same way:
  - the `Promise.allSettled` over `resolveAliases` (:334): rethrow `r.reason` for each rejected result, as `src/core/onboard/mcp-onboarding.ts:86` does;
  - `pageActivationVerdicts(...).catch(() => null)` (:602).
- Old brains without the `page_aliases` table and transient database errors still fail soft. Only a typed refusal gets through.

## 5. Wrapper check
Every wrapper around today's raw reads must stay around the typed members. This audit covers the six reflex reads and `proactive-brief.ts:203`.
- Request abort. Postgres `executeRaw` calls `throwIfRequestAborted()` (`src/core/request-signal.ts`) before each statement. The warm CLI socket
  and the Rust owner IPC server abort a request whose client left, and every later statement of that request is refused.
  `preparationRead` runs on `autocommitSql`, which keeps the read-only retry and the checkout gauge but skips that check.
  So the delegates go through `executeRaw`, as section 2 says. A unit test pins it: under `withRequestSignal` with an aborted signal,
  `readReflexPages` on Postgres throws `AbortError` and sends no statement.
- Time budgets. `withTimeout(…, TIMEOUT_MS)` (1.5 s) at `reflex.ts:217` and the turn-context deadline race at `turn-context.ts:569` (the 400 ms IPC budget)
  wrap the whole `resolveEntitiesToPointers` call. They stay as they are. None of the seven reads passes `timeoutMs`, `deadlineAt` or `signal` today,
  so the members take no such option.
- Memos and preparer views. No module under `src/core/persistence/` imports `retrieval-reflex.ts` or `proactive-brief.ts`.
  The reads never run behind `onceReads` (`persistence/authority.ts:292`) or `boundedReads`, so `TYPED_PREPARATION_READS` needs no entry.
- Test stubs and hand-built engines:
  - `test/bounded-lead.test.ts:215` spies on `executeRaw` to prove that reflex rows hold at most `BOUNDED_PREFIX_BYTES`.
    After the move that spy no longer sees reflex rows, and the test would still pass on the other reads in the same block.
    Add a spy on `readReflexPages` that records `compiled_truth` lengths, and assert that it saw at least one row.
  - `test/volunteer-context.test.ts:422` wraps the engine in a Proxy that fails only the events INSERT. Other properties pass through `Reflect.get`,
    so the members run unchanged. No edit; it stays in the check run.
  - `test/volunteer-events-delivery.test.ts:23` and :112 build engines with only `executeRaw` for the events INSERT of `logDeliveredReflexPointers`.
    They never reach the reads. No edit.
  - The other eight test files that call the reflex use `executeRaw` only to seed and to assert.
- The Promise.allSettled at :334 and the `.catch(() => null)` at :602 keep their fallbacks for every error except a typed refusal (section 4).

## 6. Parity cases (PGLite, Postgres, Rust)
Put the census cases in `scripts/rust-census/cases.ts` and add a new file, `test/engine-parity/retrieval-reflex.test.ts`, using `parityArms` from `harness.ts`. Every arm must give the same answer.
- Alias case. Seed: the fixture as is. Call: `volunteer-context --window "user: ask a-example about Brain Index" --json`.
  Answer: count 2, `people/alice-example` (arm alias) and `projects/brain-index` (arm title). Fails on Rust today: count 0 (:357, :428).
- Surname case. Seed: `people/quinn-zorvexample`, type person, title "Quinn Zorvexample". Call: `--window "user: did Zorvexample reply"`.
  Answer: count 1, arm title-surname. A second check uses the fixture's ambiguous "Example" window and expects 0 pointers and exit 0 on every arm.
  Fails on Rust today: the unique surname gives 0 (:417).
- CJK case. Seed: `people/ailisi-example`, type person, title "爱丽丝". Call: `--window "user: 爱丽丝 said hi"`.
  Answer: count 1, arm cjk-title, confidence 0.72. Fails on Rust today (:428, :531). Today the census arms agree only because the fixture has no CJK page.
- Counterparty case. Set config `context.proactive_brief` on. Call: `context-pack --entities people/alice-example --counterparty "Alice Example" --session-id census --json`.
  Answer: `brief.counterparty = { slug: "people/alice-example", display: "Alice Example" }`. Fails on Rust today: null (:428, then :203).
  Assert only the counterparty. The brief's items still come from raw reads in `proactive-brief.ts` (:424, :436, :482, :494, :502) whose catches return empty.
- Weak-title case, for :78. Call: `--window "user: ask about acme example today"`. Answer: `companies/acme-example`, arm weak-title, on every arm.
- Privacy and source cases, called directly on each engine. Seed a page with `visibility: private` and a second source holding a same-title page.
  Assert three things on every engine: with `excludePrivate` true, both as a local caller and as a world-only caller under `withCallerAccess`, the private page never resolves;
  with false, it does; with `sourceIds: [default]`, only default-source pages resolve.
Byte identity: a unit test renders each shape for all three privacy modes and compares it with the literal text from efeb078093.
Also add cases to `test/helpers/postgres-engine-sql-cases.ts` so the SQL-text goldens pin the text.
Ratchets (update as the reference commit c5c0089960 did): `scripts/engine-raw-sql-baseline.tsv` (retrieval-reflex goes from 6 to 0, proactive-brief from 10 to 9), coverage.tsv, rust-tally.tsv, and the golden files for exports and RLS scope.
The three declarations and six delegates raise the `engine.ts`, `pglite-engine.ts` and `postgres-engine.ts` ceilings, each with a named reason in `scripts/module-size-limits.tsv`.
The capability-refusal rule (20402af891) must report no catch in `retrieval-reflex.ts` or at `proactive-brief.ts:203` after the change.

## 7. Risks
- Privacy: the predicate is still rendered from the caller's own access record. PGLite and Postgres render it inside the call.
  Rust accepts only a rendering it can name. A caller whose grants, lineage or labelled-only access widen the policy gets a typed refusal from `storePageTextPolicy`, never a wider read.
  After this change that refusal is rethrown, so on Rust such a caller gets an error where it used to get an empty answer.
- Source isolation: Rust must filter on exactly `sourceIds`. It must never fall back to the engine's default source. An empty list must return no rows, as `= ANY('{}')` does in SQL.
- Speed: the title, suffix and surname kinds scan every page in Rust, because the store has no title index. The reflex runs under a 1.5 s budget per turn and a 400 ms budget over IPC.
  A title index built on the `page_index` hook would remove the scan. This is not needed for parity.
- Text matching: `lower()` and LIKE must behave the same in all three engines. `pg_lower` follows libc behaviour, as the entity card already relies on. Postgres runs on en_US.utf8.
- Some outer catches still swallow every error: `turn-context.ts:374`, the Arm 1 and Arm 2 catches in `reflex.ts` (:291 and :251), and the brief item arms.
  They are out of scope here and are listed so they stay visible. On Rust, a refusal rethrown by the reflex still ends as an empty block at these catches.
