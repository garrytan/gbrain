/**
 * The multi-writer conformance support matrix: one row per case C01..C22
 * (docs/designs/rust-engine/multi-user-server.md, "Tests to write now", 1), and for each row where the case runs,
 * where it is not applicable and where it is pending, per arm.
 *
 * Pure data: no engine and no `bun:test` import. Three readers share it, so they can never disagree:
 *  - the parity harness (harness.ts) decides at runtime whether a `mwCase` case runs on an arm, and holds a `runs`
 *    cell to strict acceptance (the whole scenario and its inline invariant complete; a typed refusal, an adapter
 *    pending error or a named stop fails it);
 *  - `coverage.ts` renders the matrix into the generated coverage list;
 *  - `multi-writer-bar.ts` knows the expected (case, arm) set from it and fails closed on a missing result.
 *
 * Case ids and titles are shared names with the gbrain-evals multi-writer suite: never renumber or retitle a case.
 *
 * Un-pending a case when its lane lands is an edit to its cells here (plus, at store level, the adapter stub in
 * rust/crates/gbrain-store/tests/common/mu.rs), with the owning lane's tests green.
 */

/** Engine arms (parity harness) and store arms (cargo, `rust/crates/gbrain-store/tests/multi_writer_conformance.rs`). */
export const MW_ENGINE_ARMS = ['pglite', 'postgres', 'rust', 'rust-mu'] as const;
export const MW_STORE_ARMS = ['store-single', 'store-optimistic'] as const;
export const MW_ARMS = [...MW_ENGINE_ARMS, ...MW_STORE_ARMS] as const;
export type MwEngineArm = typeof MW_ENGINE_ARMS[number];
export type MwStoreArm = typeof MW_STORE_ARMS[number];
export type MwArm = typeof MW_ARMS[number];

export const MW_CASE_IDS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11',
  'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21', 'C22',
] as const;
export type MwCaseId = typeof MW_CASE_IDS[number];

/**
 * Case ids are shared names with the gbrain-evals suite, so a further scenario of a case is a variant of its row, never a
 * new id: `<id>.<name>`. A variant is an engine-level scenario with its own members and engine cells (no store cells).
 * Its parityTest name is the row's `<id> <title>` followed by `: <variant title>`, and its `mwCase` is the dotted id.
 */
export const MW_VARIANT_IDS = ['C06.partition', 'C21.log-off'] as const;
export type MwVariantId = typeof MW_VARIANT_IDS[number];

/**
 * A cell: `runs` (the case must pass, strictly), `n/a` (the arm cannot express the case, with why), or `pending`
 * (the arm will run it once `owner`'s work lands; `why` names the missing interface).
 */
export type MwCell =
  | { status: 'runs' }
  | { status: 'n/a'; why: string }
  | { status: 'pending'; owner: string; why: string };

export interface MwCase {
  id: MwCaseId;
  /** The design table's title, verbatim (shared with gbrain-evals). */
  title: string;
  /** The typed operation the case exercises (design table column 2). */
  operation: string;
  /** What must hold (design table column 3); the scenario asserts it inline. */
  invariant: string;
  /**
   * `compare`: the engine case returns observables the arms must agree on, so a Rust or rust-mu run needs a
   * reference arm that ran the case first (PGLite or Postgres); without one it records `prerequisite_missing` and
   * fails. `standalone`: the scenario asserts its invariant only and is counted in its own column, never as equal.
   */
  reference: 'compare' | 'standalone';
  /** A capability the engine itself must report on an arm whose cell is `runs` (I-8 name), checked at runtime. */
  needs?: 'multi_writer' | 'commit_log';
  /** What the case does NOT prove, where a reader could assume more (shown by the bar). */
  scope?: string;
  /** The exact typed BrainEngine members the engine-level case calls (also its parityTest `methods`). */
  members: readonly string[];
  /** Cargo test names in multi_writer_conformance.rs: run on a `runs` store cell; listed (not run) when pending. */
  storeTests: { runnable: readonly string[]; pending: readonly string[] };
  cells: Readonly<Record<MwArm, MwCell>>;
  /** Further engine-level scenarios of this case (see MW_VARIANT_IDS). */
  variants?: readonly MwVariant[];
}

export interface MwVariant {
  id: MwVariantId;
  /** The case this is a scenario of. */
  of: MwCaseId;
  /** Appended to the row's `<id> <title>` after `: ` in the parityTest name. */
  title: string;
  /** What must hold; the scenario asserts it inline. */
  invariant: string;
  reference: 'compare' | 'standalone';
  needs?: 'multi_writer' | 'commit_log';
  members: readonly string[];
  cells: Readonly<Record<MwEngineArm, MwCell>>;
}

/** Shorthands for the rows below. */
const RUNS: MwCell = { status: 'runs' };
const na = (why: string): MwCell => ({ status: 'n/a', why });
const pending = (owner: string, why: string): MwCell => ({ status: 'pending', owner, why });

/**
 * The rows: every id in MW_CASE_IDS appears exactly once, in order (test/multi-writer-cases.test.ts checks it, that each
 * title is the design table's, and that each row matches its parityTest declaration).
 *
 * Reading a row:
 *  - `members` are the BrainEngine members the engine case calls; the design table's operation names (column 2) are
 *    D20 names, and where no typed member of that name exists the case uses the member that does the same work.
 *  - pglite and postgres run what the engines already do. `rust` runs a case when its inline invariant holds on the
 *    single-writer Rust arm today (proven by running it there), so the exam guards against a regression when multi-user
 *    lands; where it does not hold, or needs a second connection the Rust arm cannot give yet, `rust` is pending with the
 *    owner. `rust-mu` runs exactly what `rust` runs and is pending on the same owner otherwise, except where a variant
 *    names its own owner.
 *  - store cells are `runs` where a plain cNN test exists in multi_writer_conformance.rs, else pending with the owner.
 *  - `reference`: `compare` where the case returns outcomes every arm must agree on; `standalone` where the arms
 *    cannot all run it (PGLite is `n/a`, or the load is spread over connections only some arms have), so it asserts
 *    its invariants only.
 */
export const MW_CASES: readonly MwCase[] = [
  {
    id: 'C01',
    title: 'same-page writers lose no update',
    operation: 'compare-and-set page write',
    invariant: 'every acknowledged write is in the history, or it got a typed `revision_conflict`',
    reference: 'compare',
    members: ['putPage', 'readPageSnapshot'],
    storeTests: {
      runnable: ['c01_same_page_writers_lose_no_update'],
      pending: ['c01_same_page_writers_lose_no_update_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C02',
    title: 'stale revision gets a typed conflict',
    operation: '`upsert_chunks` with expected revision',
    invariant: 'stale writer gets `revision_conflict`, a re-read succeeds',
    reference: 'compare',
    members: ['putPage', 'readPageSnapshot', 'upsertChunks', 'getChunks'],
    storeTests: {
      runnable: ['c02_stale_revision_gets_a_typed_conflict'],
      pending: ['c02_stale_revision_gets_a_typed_conflict_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C03',
    title: 'two claimers of one write never both claim',
    operation: '`claim_next_writes`',
    invariant: 'one claimant per request at a time',
    reference: 'compare',
    members: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'selectClaimableWrite', 'stampWriteClaim', 'renewWriteClaim'],
    storeTests: {
      runnable: ['c03_two_claimers_of_one_write_never_both_claim'],
      pending: ['c03_two_claimers_of_one_write_never_both_claim_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C04',
    title: 'eight workers claim each job once',
    operation: '`claim_next_job`',
    invariant: 'no double claim, none lost',
    reference: 'compare',
    members: ['admitJob', 'claimNextJob', 'getJob'],
    storeTests: {
      runnable: ['c04_eight_workers_claim_each_job_once'],
      pending: ['c04_eight_workers_claim_each_job_once_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C05',
    title: 'expired claim is reclaimed once',
    operation: '`reclaim_stalled_jobs`, `renew_job_lease`',
    invariant: 'reclaimed once; renewal with the old token refused',
    reference: 'compare',
    members: ['admitJob', 'claimNextJob', 'reclaimStalledJobs', 'renewJobLease', 'getJob'],
    storeTests: {
      runnable: ['c05_expired_claim_is_reclaimed_once', 'c05_expired_claim_is_reclaimed_once_multi_writer'],
      pending: [],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C06',
    title: 'stale holder\'s data write refused by its token',
    operation: '`acquire_lease`, `assert_lease` in the writing transaction',
    invariant: 'a paused holder cannot write protected data after a takeover',
    reference: 'compare',
    members: ['acquireCycleLock', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'],
    storeTests: {
      runnable: ['c06_stale_holder_data_write_refused_by_its_token', 'c06_old_holder_cannot_refresh_release_or_write_after_a_takeover', 'c06_partitioned_host_claims_and_leases_are_refused_by_reason'],
      pending: ['c06_stale_holder_data_write_refused_by_its_token_multi_writer', 'c06_partitioned_host_old_epoch_work_refused_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
    variants: [
      {
        id: 'C06.partition',
        of: 'C06',
        title: 'a host back from a partition with old-epoch work is refused',
        invariant: 'a holder whose lease lapsed and was taken over cannot write protected data with its old token, renew, or release; it re-acquires under a new epoch',
        reference: 'compare',
        members: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'],
        cells: {
          pglite: RUNS, postgres: RUNS,
          rust: RUNS,
          'rust-mu': RUNS,
        },
      },
    ],
  },
  {
    id: 'C07',
    title: 'effect claimed once, rerun after owner crash',
    operation: '`claim_effects`',
    invariant: 'one claimant; a crash between action and record lets it run again; no duplicate row',
    reference: 'compare',
    members: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'selectClaimableEffect', 'stampEffectClaim', 'completeEffectRow', 'readRequestEffects'],
    storeTests: {
      runnable: ['c07_effect_claimed_once_rerun_after_owner_crash', 'c07_effect_claimed_once_rerun_after_host_lease_expiry'],
      pending: ['c07_effect_claimed_once_by_racing_hosts_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C08',
    title: 'counter never over-admits',
    operation: '`reserve_capacity`',
    invariant: 'no over-admission, no lost update',
    reference: 'compare',
    members: ['reserveChronicleJudgeSlot', 'countRecentChronicleReservations'],
    storeTests: {
      runnable: ['c08_counter_never_over_admits'],
      pending: ['c08_counter_never_over_admits_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C09',
    title: 'idempotency key maps to one row',
    operation: '`admit_job`',
    invariant: 'concurrent submits of one key give one row',
    reference: 'compare',
    members: ['admitJob', 'listJobs'],
    storeTests: {
      runnable: ['c09_idempotency_key_maps_to_one_row'],
      pending: ['c09_idempotency_key_maps_to_one_row_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C10',
    title: 'facts of one entity form one total order',
    operation: '`append_fact`',
    invariant: 'one stable order per entity, no lost fact',
    reference: 'compare',
    members: ['insertFact', 'listFactsByEntity'],
    storeTests: {
      runnable: ['c10_facts_of_one_entity_form_one_total_order', 'c10_facts_of_one_entity_form_one_total_order_multi_writer'],
      pending: [],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C11',
    title: 'per-entity order equals commit order',
    operation: '`append_fact` with a sequence assigned at commit',
    invariant: 'the order a reader sees is commit order',
    reference: 'compare',
    members: ['insertFact', 'listFactsByEntity'],
    storeTests: {
      runnable: ['c11_per_entity_commit_sequences_are_distinct_and_no_fact_is_lost'],
      pending: ['c11_per_entity_order_equals_commit_order', 'c11_per_entity_order_equals_commit_order_multi_writer'],
    },
    cells: {
      pglite: pending('L5 hosts', 'new rule: SQL reads order facts by created_at, id, which is not commit order; facts carry no sequence assigned at commit yet'), postgres: pending('L5 hosts', 'new rule: SQL reads order facts by created_at, id, which is not commit order; facts carry no sequence assigned at commit yet'),
      rust: pending('L5 hosts', 'new rule: SQL reads order facts by created_at, id, which is not commit order; facts carry no sequence assigned at commit yet'),
      'rust-mu': pending('L5 hosts', 'new rule: SQL reads order facts by created_at, id, which is not commit order; facts carry no sequence assigned at commit yet'),
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C12',
    title: 'two transactions read only their own writes',
    operation: '`transaction(fn)`',
    invariant: 'each reads its own uncommitted writes, never the other\'s',
    reference: 'compare',
    members: ['transaction', 'putPage', 'getPage'],
    storeTests: {
      runnable: ['c12_two_transactions_read_only_their_own_writes'],
      pending: ['c12_two_transactions_read_only_their_own_writes_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C13',
    title: 'transactions on different keys do not wait',
    operation: '`transaction(fn)`',
    invariant: 'a commit on another key lands while a transaction is open',
    reference: 'standalone',
    needs: 'multi_writer',
    members: ['putPage', 'transaction', 'lockPageKeys'],
    storeTests: {
      runnable: ['c13_transactions_on_different_keys_both_land'],
      pending: ['c13_transactions_on_different_keys_do_not_wait_multi_writer'],
    },
    cells: {
      pglite: na('PGLite has one connection: a second transaction queues behind the open one (test/pglite-checkpoint-guard.test.ts:193-207)'), postgres: RUNS,
      rust: na('the single-writer Rust store: an open transaction holds the one writer, so a commit on another key waits by design (concurrency.rs, embedded one owner); optimistic transactions run only in multi-user mode'),
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C14',
    title: 'concurrent publishers, one winner',
    operation: '`publish_generation`',
    invariant: 'generations monotonic; never two winners',
    reference: 'compare',
    members: ['readLiveGenerationRow', 'activateGenerationRows', 'lockGenerationKey', 'transaction'],
    storeTests: {
      runnable: ['c14_concurrent_publishers_one_winner'],
      pending: ['c14_concurrent_publishers_one_winner_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C15',
    title: 'single flight holds only its keys',
    operation: '`single_flight(keys)`',
    invariant: 'sorted keys, released at commit or abort, never two holders',
    reference: 'compare',
    members: ['transaction', 'lockPageKeys', 'putPage', 'readPageSnapshot'],
    storeTests: {
      runnable: ['c15_single_flight_holds_only_its_keys'],
      pending: ['c15_single_flight_holds_only_its_keys_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C16',
    title: 'format upgrade runs once under concurrent openers',
    operation: '`upgrade_format`',
    invariant: 'exactly one upgrade; callers see old or new, never partial',
    reference: 'standalone',
    needs: 'commit_log',
    scope: 'Rust in multi-user mode with the commit log on (rust-mu, both routes): the upgrade driven is an older brain\'s first open with the log on (format 16). Five engines open it at once; one owns it and upgrades it, four are clients, and the log start and newest commit equal those of a brain a lone opener upgraded. PostgreSQL\'s equivalent (concurrent initSchema on a database behind the code) is not written.',
    members: ['putPage', 'getPage', 'getConfig', 'readCommitLog'],
    storeTests: {
      runnable: ['c16_format_upgrade_runs_once_under_concurrent_openers'],
      pending: ['c16_format_upgrade_runs_once_under_concurrent_openers_multi_writer'],
    },
    cells: {
      pglite: na('PGLite has one connection: a brain cannot be opened twice'),
      postgres: pending('L6 harness', 'no PostgreSQL scenario yet: the case drives the Rust commit-log format upgrade; a database behind the code with concurrent initSchema openers is the harness lane\'s to write'),
      rust: na('the upgrade the case drives (an older brain\'s first open with the commit log on) exists only in multi-user mode with the log on; the plain Rust arm keeps no log'),
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C17',
    title: 'a second opener becomes a client, never an error',
    operation: '`open_brain`',
    invariant: 'no busy error; calls in flight retry by request id',
    reference: 'standalone',
    members: ['putPage', 'getPage'],
    storeTests: {
      runnable: ['c17_a_second_raw_opener_is_refused_with_a_typed_store_locked'],
      pending: ['c17_second_opener_becomes_a_client_never_an_error_multi_writer'],
    },
    cells: {
      pglite: na('PGLite refuses a second opener by design'), postgres: RUNS,
      rust: na('plain Rust ends calls in flight at the owner\'s exit owner_unavailable, outcome_unknown (48 of 48 measured); only a multi-user owner hands them over and the client sends them again'),
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C18',
    title: '64 writers in 8 processes, no busy error',
    operation: 'all rows; the plan\'s stress cell',
    invariant: 'no lost update, no double claim, no busy error',
    reference: 'standalone',
    scope: 'Postgres runs: this process plus seven writer processes, 8 writers each, started together by a parent barrier. PGLite is in-memory (n/a); Rust: the same eight processes run (this one owns the brain, seven are owner-socket clients) and fail on admitJob from a client process, so Rust stays pending.',
    members: ['putPage', 'readPageSnapshot', 'admitJob', 'claimNextJob', 'listJobs'],
    storeTests: {
      runnable: ['c18_sixty_four_writers_no_busy_error'],
      pending: ['c18_sixty_four_writers_no_busy_error_multi_writer'],
    },
    cells: {
      pglite: na('PGLite is in-memory and one connection: seven writer processes cannot share it'), postgres: RUNS,
      rust: pending('L3 server', 'admitJob from a second process refuses engine_capability_missing (capability minion_queue): its policy argument carries functions (decide, parentAuthorityKind), which do not cross the owner socket, so nothing ran; 56 of 64 writers (the seven client processes) were refused. Page writes and claimNextJob from clients succeed. Needs a job-admission path a client can send (whole operation or a policy the owner builds)'),
      'rust-mu': pending('L3 server', 'admitJob from a second process refuses engine_capability_missing (capability minion_queue): its policy argument carries functions (decide, parentAuthorityKind), which do not cross the owner socket, so nothing ran; 56 of 64 writers (the seven client processes) were refused. Page writes and claimNextJob from clients succeed. Needs a job-admission path a client can send (whole operation or a policy the owner builds)'),
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C19',
    title: 'crash after commit keeps acknowledged writes',
    operation: 'crash robot',
    invariant: 'acknowledged writes present, none duplicated',
    reference: 'standalone',
    scope: 'Postgres: a writer-process crash (SIGKILL after acknowledged writes), not a database-server crash: the reopening engine is the parent\'s connected pool, so Postgres durability (WAL, fsync) is not exercised; that guarantee is Postgres\'s own. Rust: the store\'s own recovery of a brain directory the killed writer owned. PGLite is in-memory (n/a).',
    members: ['putPage', 'readPageSnapshot', 'admitJob', 'listJobs'],
    storeTests: {
      runnable: ['c19_crash_after_commit_keeps_acknowledged_writes', 'c19_crash_keeps_commit_times_rising_and_equal_to_last_commit_time'],
      pending: ['c19_crash_after_commit_keeps_acknowledged_writes_multi_writer'],
    },
    cells: {
      pglite: na('PGLite is in-memory: there is no durable brain for a killed writer to leave behind'), postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C20',
    title: 'no deadlock across two pages in both orders',
    operation: 'sorted keys, compare-and-set',
    invariant: 'no deadlock',
    reference: 'compare',
    members: ['putPage', 'readPageSnapshot', 'transaction', 'lockPageKeys'],
    storeTests: {
      runnable: ['c20_no_deadlock_across_two_pages_in_both_orders'],
      pending: ['c20_no_deadlock_across_two_pages_in_both_orders_multi_writer'],
    },
    cells: {
      pglite: RUNS, postgres: RUNS,
      rust: RUNS,
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },
  {
    id: 'C21',
    title: 'read-your-writes token on a second connection',
    operation: 'commit position as a token',
    invariant: 'a write acknowledged on connection A is seen by B given the token',
    reference: 'standalone',
    needs: 'commit_log',
    scope: 'Rust in multi-user mode with the commit log on (rust-mu, both routes): the brain\'s owner serves a loopback v3 listener, two served clients write and read, and the token is the cp1: position of the write (a served client\'s acknowledgement, or the owner\'s own lastCommitPosition). An owner-socket client of the same brain (ctx.sameBrainEngine) reads the same writes, but the owner socket sends no token, so only the served connections prove the token is carried and waited for. The read with the log off is the variant C21.log-off.',
    members: ['putPage', 'getPage'],
    storeTests: {
      runnable: ['c21_read_your_writes_token_on_a_second_connection'],
      pending: ['c21_read_your_writes_token_on_a_second_connection_multi_writer'],
    },
    cells: {
      pglite: na('PGLite has one connection'),
      postgres: na('a SQL engine keeps no commit log, so no commit position and no read token exists: lastCommitPosition refuses engine_capability_missing, reason commit_log'),
      rust: na('the plain Rust arm is single-user with the commit log off: it serves no v3 listener (listenServed refuses engine_capability_missing, reason served), so there is no second connection that carries a token'),
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
    variants: [
      {
        id: 'C21.log-off',
        of: 'C21',
        title: 'a read carrying a token is refused while the commit log is off',
        invariant: 'on a multi-user brain with no commit log the server cannot order positions: a read that carries a token ends owner_ipc_protocol (reason frame_malformed, min_position=unsupported), ran nothing and returned nothing, while the same read without a token returns the write',
        reference: 'standalone',
        needs: 'commit_log',
        members: ['putPage', 'getPage'],
        cells: {
          pglite: na('PGLite has one connection'),
          postgres: na('a SQL engine keeps no commit log and serves no v3 listener: no token read exists to refuse'),
          rust: na('the case opens its own multi-user brain with the commit log off (a plain Rust arm\'s own brain is single-user); it runs once, on the rust-mu arm'),
          'rust-mu': RUNS,
        },
      },
    ],
  },
  {
    id: 'C22',
    title: 'commit position strictly increases',
    operation: 'commit log',
    invariant: 'no two commits share a position; positions only grow',
    reference: 'standalone',
    needs: 'commit_log',
    members: ['putPage', 'transaction', 'readCommitLog', 'lastCommitPosition'],
    storeTests: {
      runnable: ['c22_commit_position_strictly_increases', 'c22_commit_position_strictly_increases_multi_writer', 'c22_logged_single_writer_positions_have_index_zero_and_each_matches_a_record'],
      pending: ['c22_follower_replay_keeps_commit_times_rising_and_row_times_above_the_floor_multi_writer'],
    },
    cells: {
      pglite: na('a SQL engine keeps no commit log: it refuses engine_capability_missing, reason commit_log'), postgres: na('a SQL engine keeps no commit log: it refuses engine_capability_missing, reason commit_log'),
      rust: na('the commit log is off on the plain Rust arm: it refuses engine_capability_missing, reason commit_log'),
      'rust-mu': RUNS,
      'store-single': RUNS, 'store-optimistic': RUNS,
    },
  },

];

export function mwCase(id: MwCaseId): MwCase {
  const row = MW_CASES.find((c) => c.id === id);
  if (row === undefined) throw new Error(`multi-writer-cases: no row for ${id}`);
  return row;
}

/** The variant `id` (`C06.partition`). */
export function mwVariant(id: MwVariantId): MwVariant {
  for (const row of MW_CASES) {
    const found = row.variants?.find((v) => v.id === id);
    if (found) return found;
  }
  throw new Error(`multi-writer-cases: no variant ${id}`);
}

/** The cell of variant `id` on engine arm `arm`. */
export function mwVariantCell(id: MwVariantId, arm: MwEngineArm): MwCell {
  return mwVariant(id).cells[arm];
}

/** The cell for `id` on `arm`. */
export function mwCell(id: MwCaseId, arm: MwArm): MwCell {
  return mwCase(id).cells[arm];
}
