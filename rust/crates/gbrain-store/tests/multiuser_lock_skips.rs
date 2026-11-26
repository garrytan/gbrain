//! The lock skips that pass in multi-user mode, each proven with explicit transactions that run
//! optimistically (`OpenOptions::multiuser`; interface I-1, lane L1).
//!
//! The PGLite and Postgres engines take a row lock, an advisory lock, `SKIP LOCKED` or a page-key lock
//! at these sites. The Rust store takes none. With multi-user mode off its explicit transactions hold
//! the writer, so nothing can change a row between the skip and the commit. With it on they do not:
//! another commit can land in between, and a site passes (`lock_skips::MULTIUSER_PROVEN`) only when
//! something else keeps the member's invariant. Each test here opens a multi-user brain, runs the
//! member inside an optimistic transaction and lands a concurrent writer of the row the SQL locked
//! between the member and the commit:
//!
//! - read set: the member read the row through the transaction handle, so the commit refuses
//!   `write_conflict` and keeps none of the transaction's writes; the same sequence with no writer
//!   commits (so the refusal is the writer's doing), and a rerun from a fresh snapshot sees the change.
//! - `SKIP LOCKED` claims: two transactions claim at once and never both claim a row; the loser
//!   refuses `write_conflict` and its rerun claims the next row or none.
//! - single flight: two transactions hold one page key one after the other.
//! - lease: a lease taken over between the check and the commit refuses the commit.
//!
//! Each test names the row it proves in `MULTIUSER_PROVEN` (`proven_rows_name_their_tests` checks the
//! table against this file). A site that is not in the table refuses `engine_capability_missing` in
//! multi-user mode (`a_site_without_a_proof_refuses_in_multi_user_mode_and_passes_with_it_off`).

mod common;

use common::TempDir;
use gbrain_store::env::uuid_from_bytes;
use gbrain_store::error::{ENGINE_CAPABILITY_MISSING, WRITE_CONFLICT};
use gbrain_store::lock_skips::{Guarantee, MULTIUSER_PROVEN, proven};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::transactions::{TxnMode, TxnOptions};
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::fmt::Debug;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

/// 2027-01-15T08:00:00Z.
const T0: i64 = 1_800_000_000_000_000;
const MINUTE: i64 = 60_000_000;
/// The config row a transaction writes so it has something to lose.
const MARK: &str = "proof.mark";
/// This file, as `MULTIUSER_PROVEN` names it.
const FILE: &str = "rust/crates/gbrain-store/tests/multiuser_lock_skips.rs";

/// A clock the test moves and ids it counts.
struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

/// A multi-user brain on the concurrent record store, and the clock it reads.
struct Brain {
    store: Store,
    clock: Arc<Clock>,
    _dir: TempDir,
}

impl std::ops::Deref for Brain {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

impl Brain {
    fn advance(&self, micros: i64) {
        self.clock.now.fetch_add(micros, Ordering::SeqCst);
    }
}

fn brain(name: &str) -> Brain {
    let dir = TempDir::new(name);
    let clock = Arc::new(Clock {
        now: AtomicI64::new(T0),
        ids: AtomicU64::new(1),
    });
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(
        Arc::new(OccKv::new(kv).unwrap()),
        clock.clone(),
        OpenOptions {
            multiuser: true,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    assert!(store.multiuser());
    assert!(
        !store.serialized_transactions(),
        "multi-user mode withholds serialized_transactions"
    );
    Brain {
        store,
        clock,
        _dir: dir,
    }
}

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

/// An optimistic transaction (a store bound to it).
fn begin(b: &Brain) -> Store {
    let t = b.begin_bound(optimistic()).unwrap();
    assert!(t.transaction_optimistic(), "the transaction is optimistic");
    t
}

/// Builds the argument a store fn takes from its JSON form, as the binding does.
fn args<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn mark(s: &Store) -> Option<String> {
    s.get_config(MARK).unwrap()
}

/// The row of `site` in the proven table, with the guarantee and this test named.
fn row_of(site: &str, guarantee: Guarantee, test: &str) {
    let row = proven(site).unwrap_or_else(|| panic!("{site} has no row in MULTIUSER_PROVEN"));
    assert_eq!(row.guarantee, guarantee, "{site}");
    assert_eq!(row.test, format!("{FILE}::{test}"), "{site}");
}

/// The read-set proof of one member. `member` runs through a store handle and reads the row the SQL
/// engines lock; `writer` is the concurrent writer of that row.
///
/// 1. In multi-user mode the member passes (a refusal would be `engine_capability_missing`).
/// 2. Control: an optimistic transaction that runs the member and writes `MARK` commits when nothing
///    else wrote the row.
/// 3. The same sequence with `writer` committing between the member and the commit refuses the commit
///    `write_conflict` and keeps none of the transaction's writes.
/// 4. A rerun from a fresh snapshot runs the member again, sees the writer's change and commits.
///
/// Returns what the member answered before the writer and what the rerun answered.
fn proves_read_set<T: Debug>(
    b: &Brain,
    site: &str,
    member: impl Fn(&Store) -> gbrain_store::Result<T>,
    writer: impl FnOnce(&Brain),
) -> (T, T) {
    let outside = member(&b.store);
    if let Err(e) = &outside {
        assert_ne!(
            e.code, ENGINE_CAPABILITY_MISSING,
            "{site} refused in multi-user mode: {e:?}"
        );
    }
    let control = begin(b);
    let before =
        member(&control).unwrap_or_else(|e| panic!("{site} failed in a transaction: {e:?}"));
    control.set_config(MARK, "control").unwrap();
    control.commit_transaction().unwrap();
    assert_eq!(mark(&b.store).as_deref(), Some("control"), "{site}");

    let t = begin(b);
    member(&t).unwrap();
    t.set_config(MARK, "lost").unwrap();
    writer(b);
    let err = t.commit_transaction().expect_err(&format!(
        "{site}: the commit survived a concurrent writer of the row it read"
    ));
    assert_eq!(err.code, WRITE_CONFLICT, "{site}: {err:?}");
    assert_eq!(
        mark(&b.store).as_deref(),
        Some("control"),
        "{site}: a refused commit kept a write"
    );

    let rerun = begin(b);
    let after = member(&rerun).unwrap();
    rerun.set_config(MARK, "rerun").unwrap();
    rerun.commit_transaction().unwrap();
    assert_eq!(mark(&b.store).as_deref(), Some("rerun"), "{site}");
    (before, after)
}

fn put_page(s: &Store, slug: &str, body: &str) -> Value {
    let input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": body, "timeline": "" }));
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// The table itself.

/// Every row of the table names a test in this file that exists, and the table holds no row twice.
#[test]
fn proven_rows_name_their_tests() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/multiuser_lock_skips.rs"),
    )
    .unwrap();
    let mut seen = std::collections::BTreeSet::new();
    for row in MULTIUSER_PROVEN {
        assert!(seen.insert(row.site), "{} is listed twice", row.site);
        let (file, name) = row.test.split_once("::").expect("a row names file::test");
        assert_eq!(file, FILE, "{}", row.site);
        assert!(
            source.contains(&format!("fn {name}(")),
            "{} names {name}, which is not in this file",
            row.site
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Rows the SQL engines lock FOR UPDATE / FOR SHARE: the member reads them through the handle.

/// `lockAccessPolicy`. The member itself reads nothing (the SQL lock takes the source and policy-state
/// rows); what replaces the lock is the read every caller (`access/policy.ts`: `lockSource` then
/// `installRulebook`) makes next, the applied rules of the source. Two rule-set changes of one source
/// that interleave refuse the second commit, so no rule set is applied over another unseen.
#[test]
fn lock_access_policy_second_rule_set_refuses_write_conflict() {
    row_of(
        "lockAccessPolicy",
        Guarantee::ReadSet,
        "lock_access_policy_second_rule_set_refuses_write_conflict",
    );
    let b = brain("mu-access-policy");
    b.ensure_access_policy_state("default").unwrap();
    let rule = |id: &str, prefix: &str| -> gbrain_store::access_policy::AccessRuleChanges {
        args(
            json!({ "remove": [], "insert": [{ "rule_id": id, "prefix": prefix,
            "readable_by": ["alice"], "covers_derived": true }], "pending": [], "revision": 1, "actor": "test" }),
        )
    };
    let (before, after) = proves_read_set(
        &b,
        "lockAccessPolicy",
        |s| {
            s.lock_access_policy("default")?;
            Ok(s.list_access_rules("default")?.len())
        },
        |b| {
            b.apply_access_rule_changes("default", &rule("r1", "people/"))
                .unwrap()
        },
    );
    assert_eq!((before, after), (0, 1));
}

/// `readPageRevisionForShare`: the revision read is validated, so a write that moves the page between
/// the read and the commit refuses the commit.
#[test]
fn read_page_revision_for_share_refuses_when_the_page_moved() {
    row_of(
        "readPageRevisionForShare",
        Guarantee::ReadSet,
        "read_page_revision_for_share_refuses_when_the_page_moved",
    );
    let b = brain("mu-page-revision");
    put_page(&b, "notes/a", "one");
    let (before, after) = proves_read_set(
        &b,
        "readPageRevisionForShare",
        |s| s.read_page_revision_for_share("default", "notes/a"),
        |b| {
            put_page(b, "notes/a", "two");
        },
    );
    assert_ne!(before, after, "the rerun reads the new revision");
}

/// `lockReconcileRevision` is a revision compare (Cas): true while the page is at the revision the
/// caller read. A page that moves before the commit refuses the commit, and the rerun's compare
/// against the old revision is false.
#[test]
fn lock_reconcile_revision_compare_refuses_when_the_page_moved() {
    row_of(
        "lockReconcileRevision",
        Guarantee::Cas,
        "lock_reconcile_revision_compare_refuses_when_the_page_moved",
    );
    let b = brain("mu-reconcile");
    let revision = put_page(&b, "notes/a", "one")["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_string();
    let lock = gbrain_store::facts::reconcile::LockArgs {
        source_id: "default".into(),
        slug: "notes/a".into(),
        revision: Some(revision),
    };
    let (before, after) = proves_read_set(
        &b,
        "lockReconcileRevision",
        |s| s.lock_reconcile_revision(&lock),
        |b| {
            put_page(b, "notes/a", "two");
        },
    );
    assert_eq!((before, after), (true, false));
}

/// `lockDreamMapConfigRow`: the breaker map row read is validated, so two read-modify-writes of it
/// do not both apply.
#[test]
fn lock_dream_map_config_row_refuses_when_the_row_changed() {
    row_of(
        "lockDreamMapConfigRow",
        Guarantee::ReadSet,
        "lock_dream_map_config_row_refuses_when_the_row_changed",
    );
    let b = brain("mu-dream-config");
    let key: gbrain_store::dream_config::DreamMapKeyArgs = args(json!({ "key": "dream.map" }));
    b.ensure_dream_map_config_row(&key).unwrap();
    let (before, after) = proves_read_set(
        &b,
        "lockDreamMapConfigRow",
        |s| {
            s.lock_dream_map_config_row(&key)
                .map(|row| row.map(|r| r["value"].clone()))
        },
        |b| {
            b.write_dream_map_config_row(&args(json!({ "key": "dream.map", "value": "{\"a\":1}" })))
                .unwrap()
        },
    );
    assert_eq!(before, Some(json!("{}")));
    assert_eq!(after, Some(json!("{\"a\":1}")));
}

/// `lockRegisteredSourceIds`: registered ids are read (an absent id is a read of an absent key), so a
/// source registered or removed before the commit refuses it.
#[test]
fn lock_registered_source_ids_refuses_when_a_source_appears() {
    row_of(
        "lockRegisteredSourceIds",
        Guarantee::ReadSet,
        "lock_registered_source_ids_refuses_when_a_source_appears",
    );
    let b = brain("mu-registered-sources");
    let ids = ["default".to_string(), "late".to_string()];
    let (before, after) = proves_read_set(
        &b,
        "lockRegisteredSourceIds",
        |s| s.lock_registered_source_ids(&ids),
        |b| {
            b.insert_source("late", "late", None, &serde_json::Map::new())
                .unwrap();
        },
    );
    assert_eq!(before, ["default"]);
    assert_eq!(after, ["default", "late"]);
}

/// `lockLivePagesByKey`: the live rows of the named pages; a page soft-deleted before the commit
/// refuses it.
#[test]
fn lock_live_pages_by_key_refuses_when_a_page_is_deleted() {
    row_of(
        "lockLivePagesByKey",
        Guarantee::ReadSet,
        "lock_live_pages_by_key_refuses_when_a_page_is_deleted",
    );
    let b = brain("mu-live-pages");
    put_page(&b, "notes/a", "one");
    let refs: Vec<gbrain_store::trust::tier_reads::PageKeyRef> =
        args(json!([{ "source_id": "default", "slug": "notes/a" }]));
    let (before, after) = proves_read_set(
        &b,
        "lockLivePagesByKey",
        |s| s.lock_live_pages_by_key(&refs).map(|rows| rows.len()),
        |b| {
            b.soft_delete_page("notes/a", Some("default")).unwrap();
        },
    );
    assert_eq!((before, after), (1, 0));
}

/// `lockSegmentedGenerationPage`: the page row and its body state; a page write before the commit
/// refuses it.
#[test]
fn lock_segmented_generation_page_refuses_when_the_page_changed() {
    row_of(
        "lockSegmentedGenerationPage",
        Guarantee::ReadSet,
        "lock_segmented_generation_page_refuses_when_the_page_changed",
    );
    let b = brain("mu-generation-page");
    let id = put_page(&b, "notes/a", "one")["id"].as_i64().unwrap();
    let (before, after) = proves_read_set(
        &b,
        "lockSegmentedGenerationPage",
        |s| {
            s.lock_segmented_generation_page(id)
                .map(|row| row.map(|r| r.slug))
        },
        |b| {
            put_page(b, "notes/a", "two");
        },
    );
    assert_eq!(before, Some("notes/a".to_string()));
    assert_eq!(after, before);
}

// ---------------------------------------------------------------------------------------------
// Facts.

fn seed_fact(b: &Brain, page: &str, text: &str, row: u32) -> u64 {
    let out = b
        .insert_facts(&args(json!({
            "rows": [{ "fact": text, "entity_slug": "people/e-example", "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": "world", "source": "fence" }],
            "sourceId": "default",
        })))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

/// `readPairFactRow` with `lock`: the fact row read is validated, so a fact expired before the commit
/// refuses it and the rerun reads the expiry.
#[test]
fn read_pair_fact_row_refuses_when_the_fact_changed() {
    row_of(
        "readPairFactRow",
        Guarantee::ReadSet,
        "read_pair_fact_row_refuses_when_the_fact_changed",
    );
    let b = brain("mu-pair-fact");
    put_page(&b, "notes/a", "body");
    let id = seed_fact(&b, "notes/a", "Erin rows boats.", 1);
    let pair: gbrain_store::facts::remember_reads::PairFactArgs =
        args(json!({ "id": id, "lock": true }));
    let (before, after) = proves_read_set(
        &b,
        "readPairFactRow",
        |s| {
            s.read_pair_fact_row(&pair)
                .map(|row| row.map(|r| r["expired_at"].clone()))
        },
        |b| {
            assert!(b.expire_fact(&args(json!({ "id": id }))).unwrap());
        },
    );
    assert_eq!(before, Some(Value::Null));
    assert_ne!(after, before);
}

/// `readReplacementTarget` with `lock`: the target fact and the withdrawal ledger rows that reach it
/// are read through the handle; a change to the fact before the commit refuses it.
#[test]
fn read_replacement_target_refuses_when_the_fact_changed() {
    row_of(
        "readReplacementTarget",
        Guarantee::ReadSet,
        "read_replacement_target_refuses_when_the_fact_changed",
    );
    let b = brain("mu-replacement-target");
    put_page(&b, "notes/a", "body");
    let id = seed_fact(&b, "notes/a", "Erin rows boats.", 1);
    let target: gbrain_store::facts::remember_reads::ReplacementTargetArgs =
        args(json!({ "targetId": id, "sourceId": "default", "lock": true }));
    let (before, after) = proves_read_set(
        &b,
        "readReplacementTarget",
        |s| {
            s.read_replacement_target(&target)
                .map(|row| row.map(|r| r["expired_at"].clone()))
        },
        |b| {
            assert!(b.expire_fact(&args(json!({ "id": id }))).unwrap());
        },
    );
    assert_eq!(before, Some(Value::Null));
    assert_ne!(after, before);
}

/// `lockFactForWithdrawal`: the fact row and its withdrawal subject; a fact that changes before the
/// commit refuses it, so a withdrawal never commits over a fact it did not read.
#[test]
fn lock_fact_for_withdrawal_refuses_when_the_fact_changed() {
    row_of(
        "lockFactForWithdrawal",
        Guarantee::ReadSet,
        "lock_fact_for_withdrawal_refuses_when_the_fact_changed",
    );
    let b = brain("mu-withdrawal-fact");
    put_page(&b, "notes/a", "body");
    let id = seed_fact(&b, "notes/a", "Erin rows boats.", 1);
    let query: gbrain_store::memory_mutation_reads::WithdrawalClaimQuery = args(json!({
        "id": id, "sourceId": "default", "worldOnly": true, "memberPage": null, "remoteFloor": null }));
    let (before, after) = proves_read_set(
        &b,
        "lockFactForWithdrawal",
        |s| s.lock_fact_for_withdrawal(&query),
        |b| {
            assert!(b.expire_fact(&args(json!({ "id": id }))).unwrap());
        },
    );
    assert_eq!(before.unwrap()["fact"], "Erin rows boats.");
    assert!(after.is_some());
}

// ---------------------------------------------------------------------------------------------
// Credentials.

fn token_row(name: &str, hash: &str, grant: Option<&str>) -> gbrain_store::jobs::TokenInsert {
    args(json!({
        "name": name, "token_hash": hash, "scopes": ["read"], "permissions": { "source_id": "default" },
        "source_grant": grant, "source_id": null, "federated_read": null, "allowed_operations": null,
        "takes_holders": null,
    }))
}

/// `lockActiveAccessTokens`: the active token rows `auth rescope` edits; a token revoked before the
/// commit refuses it.
#[test]
fn lock_active_access_tokens_refuses_when_a_token_is_revoked() {
    row_of(
        "lockActiveAccessTokens",
        Guarantee::ReadSet,
        "lock_active_access_tokens_refuses_when_a_token_is_revoked",
    );
    let b = brain("mu-active-tokens");
    let id = b
        .insert_access_token(&token_row("harness", "h1", Some("default")))
        .unwrap();
    let (before, after) = proves_read_set(
        &b,
        "lockActiveAccessTokens",
        |s| {
            s.lock_active_access_tokens(None, Some("harness"))
                .map(|rows| rows.as_array().unwrap().len())
        },
        |b| {
            b.revoke_access_token(&id).unwrap();
        },
    );
    assert_eq!((before, after), (1, 0));
}

/// `lockLegacyAccessTokens`: every active token still on the legacy shape (a scan of the table); a
/// token revoked or converted before the commit refuses it.
#[test]
fn lock_legacy_access_tokens_refuses_when_a_token_changes() {
    row_of(
        "lockLegacyAccessTokens",
        Guarantee::ReadSet,
        "lock_legacy_access_tokens_refuses_when_a_token_changes",
    );
    let b = brain("mu-legacy-tokens");
    let id = b
        .insert_access_token(&token_row("legacy", "h1", None))
        .unwrap();
    let (before, after) = proves_read_set(
        &b,
        "lockLegacyAccessTokens",
        |s| {
            s.lock_legacy_access_tokens()
                .map(|rows| rows.as_array().unwrap().len())
        },
        |b| {
            b.revoke_access_token(&id).unwrap();
        },
    );
    assert_eq!((before, after), (1, 0));
}

fn oauth_client(b: &Brain, id: &str) {
    b.insert_oauth_client(&args(
        json!({ "client_id": id, "client_name": id, "scope": "read" }),
    ))
    .unwrap();
}

/// `readOauthCodeForUpdate`: a code is single use. Two exchanges of one code both read it; the second
/// commit refuses because the first deleted it, and the rerun reads null.
#[test]
fn read_oauth_code_for_update_second_exchange_refuses() {
    row_of(
        "readOauthCodeForUpdate",
        Guarantee::ReadSet,
        "read_oauth_code_for_update_second_exchange_refuses",
    );
    let b = brain("mu-oauth-code");
    oauth_client(&b, "c1");
    b.insert_oauth_code(&args(json!({ "code_hash": "h1", "client_id": "c1", "scopes": ["read"],
        "code_challenge": "challenge", "code_challenge_method": "S256", "redirect_uri": "https://app.example/cb",
        "state": "st", "resource": null, "expires_at": 1_900_000_000 })))
        .unwrap();
    let (before, after) = proves_read_set(
        &b,
        "readOauthCodeForUpdate",
        |s| {
            s.read_oauth_code_for_update("h1", "c1")
                .map(|row| row.is_null())
        },
        |b| b.delete_oauth_code("h1", "c1").unwrap(),
    );
    assert_eq!((before, after), (false, true));
}

/// `readOauthRefreshTokenForUpdate`: a refresh token is rotated once. Two rotations both read it; the
/// second refuses because the first deleted it, and the rerun reads null.
#[test]
fn read_oauth_refresh_token_for_update_second_rotation_refuses() {
    row_of(
        "readOauthRefreshTokenForUpdate",
        Guarantee::ReadSet,
        "read_oauth_refresh_token_for_update_second_rotation_refuses",
    );
    let b = brain("mu-oauth-refresh");
    oauth_client(&b, "c1");
    b.insert_oauth_token(&args(json!({ "token_hash": "r1", "token_type": "refresh", "client_id": "c1",
        "scopes": ["read"], "expires_at": 1_900_000_000, "resource": null, "created_at": 1_800_000_000,
        "grant_type": "authorization_code" })))
        .unwrap();
    let (before, after) = proves_read_set(
        &b,
        "readOauthRefreshTokenForUpdate",
        |s| {
            s.read_oauth_refresh_token_for_update("r1", "c1")
                .map(|row| row.is_null())
        },
        |b| b.delete_oauth_refresh_token("r1", "c1").unwrap(),
    );
    assert_eq!((before, after), (false, true));
}

// ---------------------------------------------------------------------------------------------
// Page body, page origins, held rows.

const STAGING: &str = "11111111-1111-4111-8111-111111111111";

/// `lockBodyStagingState`: the purge flip reads a staging's state; a staging that moves (aborted,
/// committed) before the commit refuses it.
#[test]
fn lock_body_staging_state_refuses_when_the_staging_moved() {
    row_of(
        "lockBodyStagingState",
        Guarantee::ReadSet,
        "lock_body_staging_state_refuses_when_the_staging_moved",
    );
    let b = brain("mu-body-staging");
    b.open_body_staging(&args(json!({
        "id": STAGING, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": "44444444-4444-4444-8444-444444444444", "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a",
        "pageId": null, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
        "declaredBytes": 10, "declaredSha256": null, "reservedBytes": 10,
        "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    })))
    .unwrap();
    let (before, after) = proves_read_set(
        &b,
        "lockBodyStagingState",
        |s| s.lock_body_staging_state(STAGING),
        |b| {
            b.set_body_staging_state(STAGING, "aborted", &Default::default())
                .unwrap()
        },
    );
    assert_eq!(before.as_deref(), Some("open"));
    assert_eq!(after.as_deref(), Some("aborted"));
}

/// `listOriginClaims` with page-key locks: PGLite queues two writes of one file behind an advisory
/// lock per origin spelling. Here the claims of a spelling are read through the handle, so a second
/// page that claims the file between the read and the commit refuses the first commit.
#[test]
fn list_origin_claims_refuses_when_another_page_claims_the_file() {
    row_of(
        "listOriginClaims",
        Guarantee::ReadSet,
        "list_origin_claims_refuses_when_another_page_claims_the_file",
    );
    let b = brain("mu-origin-claims");
    let put_at = |s: &Store, slug: &str, path: &str| {
        let input: PageInput = args(
            json!({ "type": "note", "title": slug, "compiled_truth": "Body.",
            "timeline": "", "source_path": path }),
        );
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    };
    put_at(&b, "notes/a", "a.md");
    let spellings = ["shared.md".to_string()];
    let opts: gbrain_store::write_guards::OriginClaimOptions =
        args(json!({ "lockKeys": ["origin:default:shared.md"] }));
    let (before, after) = proves_read_set(
        &b,
        "listOriginClaims",
        |s| {
            s.list_origin_claims("default", &spellings, &opts)
                .map(|claims| claims.len())
        },
        |b| put_at(b, "notes/b", "shared.md"),
    );
    assert_eq!((before, after), (0, 1));
}

fn declare_tier(s: &Store, tier: &str) {
    s.apply_write_trust(
        &["gbrain.write_trust_tier".to_string()],
        &[tier.to_string()],
    )
    .unwrap();
}

/// A page with one take stamped `operator_curated`, returning (page id, take id).
fn page_with_curated_take(b: &Brain) -> (i64, i64) {
    let page_id = put_page(b, "p", "body")["id"].as_i64().unwrap();
    declare_tier(b, "operator_curated");
    let take: gbrain_store::takes::TakeInput = args(json!({
        "page_id": page_id, "row_num": 1, "claim": "curated", "kind": "take",
        "holder": "alice-example", "weight": 0.5, "active": true }));
    b.add_takes_batch(&[take]).unwrap();
    b.clear_write_trust();
    let options: gbrain_store::takes::ListTakesOptions =
        args(json!({ "page_id": page_id, "limit": 50 }));
    let id = b.list_takes(&options).unwrap()[0]["id"].as_i64().unwrap();
    (page_id, id)
}

/// `listHeldTakeRows`: the stamped tier of a take read against the writer's; a take another writer
/// deletes or restamps before the commit refuses the commit, so a lower tier never overwrites a take
/// it did not see.
#[test]
fn list_held_take_rows_refuses_when_the_take_changed() {
    row_of(
        "listHeldTakeRows",
        Guarantee::ReadSet,
        "list_held_take_rows_refuses_when_the_take_changed",
    );
    let b = brain("mu-held-takes");
    let (page_id, id) = page_with_curated_take(&b);
    let spec: gbrain_store::takes::HeldTakeSpec =
        args(json!({ "ids": [id], "writer": "agent_written" }));
    let (before, after) = proves_read_set(
        &b,
        "listHeldTakeRows",
        |s| {
            s.list_held_take_rows(&spec, &s.fence_context())
                .map(|rows| rows.len())
        },
        |b| b.delete_take_rows(page_id, &[json!(1)]).unwrap(),
    );
    assert_eq!((before, after), (1, 0));
}

/// `listGuardedTakeRows`: the stored takes of the pages a batch deletes or changes; a take added,
/// changed or deleted on the page before the commit refuses it.
#[test]
fn list_guarded_take_rows_refuses_when_the_page_takes_changed() {
    row_of(
        "listGuardedTakeRows",
        Guarantee::ReadSet,
        "list_guarded_take_rows_refuses_when_the_page_takes_changed",
    );
    let b = brain("mu-guarded-takes");
    let (page_id, _) = page_with_curated_take(&b);
    declare_tier(&b, "agent_written");
    let query: gbrain_store::trust::held_rows::GuardedTakeRowsQuery =
        args(json!({ "incoming": [], "gone": [{ "page_id": page_id, "row_num": 1 }] }));
    let (before, after) = proves_read_set(
        &b,
        "listGuardedTakeRows",
        |s| {
            s.list_guarded_take_rows(&query, &s.fence_context())
                .map(|rows| rows.len())
        },
        |b| b.delete_take_rows(page_id, &[json!(1)]).unwrap(),
    );
    assert_eq!((before, after), (1, 0));
}

/// `listHeldRows` on takes and on timeline entries (a page's rows more trusted than the writer): a
/// row of the page that changes before the commit refuses it.
#[test]
fn list_held_rows_refuses_when_a_row_of_the_page_changed() {
    row_of(
        "listHeldRows",
        Guarantee::ReadSet,
        "list_held_rows_refuses_when_a_row_of_the_page_changed",
    );
    let b = brain("mu-held-rows");
    let (page_id, take) = page_with_curated_take(&b);
    let query: gbrain_store::trust::held_rows::HeldRowsQuery = args(
        json!({ "table": "takes", "pageId": page_id, "ids": [take], "writer": "agent_written" }),
    );
    let (before, after) = proves_read_set(
        &b,
        "listHeldRows",
        |s| {
            s.list_held_rows(&query, &s.fence_context())
                .map(|rows| rows.len())
        },
        |b| b.delete_take_rows(page_id, &[json!(1)]).unwrap(),
    );
    assert_eq!((before, after), (1, 0));

    // Timeline entries: an entry added to the table before the commit refuses it.
    let entry = |summary: &str| {
        let input: gbrain_store::timeline::TimelineInput =
            args(json!({ "date": "2026-03-01", "summary": summary }));
        input
    };
    declare_tier(&b, "operator_curated");
    assert!(
        b.add_timeline_entry("p", &entry("curated"), &Default::default())
            .unwrap()
    );
    b.clear_write_trust();
    let timeline_id = b.get_timeline("p", &Default::default()).unwrap()[0]["id"]
        .as_i64()
        .unwrap();
    let query: gbrain_store::trust::held_rows::HeldRowsQuery = args(json!({
        "table": "timeline_entries", "pageId": page_id, "ids": [timeline_id], "writer": "agent_written" }));
    let (before, after) = proves_read_set(
        &b,
        "listHeldRows",
        |s| {
            s.list_held_rows(&query, &s.fence_context())
                .map(|rows| rows.len())
        },
        |b| {
            assert!(
                b.add_timeline_entry("p", &entry("another"), &Default::default())
                    .unwrap()
            );
        },
    );
    assert_eq!((before, after), (1, 1));
}

/// `listHeldTimelineRows`: the timeline rows by id with their stamped tier; a timeline row added or
/// changed before the commit refuses it.
#[test]
fn list_held_timeline_rows_refuses_when_the_timeline_changed() {
    row_of(
        "listHeldTimelineRows",
        Guarantee::ReadSet,
        "list_held_timeline_rows_refuses_when_the_timeline_changed",
    );
    let b = brain("mu-held-timeline");
    put_page(&b, "p", "body");
    let entry = |summary: &str| -> gbrain_store::timeline::TimelineInput {
        args(json!({ "date": "2026-03-01", "summary": summary }))
    };
    declare_tier(&b, "operator_curated");
    assert!(
        b.add_timeline_entry("p", &entry("curated"), &Default::default())
            .unwrap()
    );
    b.clear_write_trust();
    let id = b.get_timeline("p", &Default::default()).unwrap()[0]["id"]
        .as_i64()
        .unwrap();
    let spec: gbrain_store::timeline::HeldTimelineSpec =
        args(json!({ "ids": [id], "writer": "agent_written" }));
    let (before, after) = proves_read_set(
        &b,
        "listHeldTimelineRows",
        |s| {
            s.list_held_timeline_rows(&spec, &s.fence_context())
                .map(|rows| rows.len())
        },
        |b| {
            assert!(
                b.add_timeline_entry("p", &entry("another"), &Default::default())
                    .unwrap()
            );
        },
    );
    assert_eq!((before, after), (1, 1));
}

// ---------------------------------------------------------------------------------------------
// The persistence journal: counters, write requests, effects.

const REQ_1: &str = "b0000000-0000-4000-8000-0000000000b1";
const REQ_2: &str = "b0000000-0000-4000-8000-0000000000b2";
const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const KEYS: [&str; 2] = ["principal:local_cli:parity-writer", "brain"];

fn incarnation(s: &Store, source: &str) -> String {
    s.read_source_membership(source).unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Admits a queued `put_page` request (its counters charged) and returns its id.
fn admit(s: &Store, request: &str, slug: &str, kind: &str) -> String {
    admit_in(s, "default", request, slug, kind)
}

fn admit_in(s: &Store, source: &str, request: &str, slug: &str, kind: &str) -> String {
    let insert: gbrain_store::persistence::WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": source, "sourceIncarnation": incarnation(s, source),
        "pageId": null, "slug": slug, "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": { "kind": kind }, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": KEYS,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    s.lock_persistence_counters(&KEYS.map(String::from))
        .unwrap();
    s.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Queues `effects` for the admitted request `id`.
fn queue_effects(s: &Store, id: &str, effects: Value) {
    let spec: gbrain_store::persistence::PublicationEffectsSpec = args(json!({
        "requestId": id, "revision": "e0000000-0000-4000-8000-0000000000e1", "sourceId": "default",
        "sourceIncarnation": incarnation(s, "default"), "worktreeId": null, "effects": effects,
    }));
    s.insert_publication_effects(&spec).unwrap();
}

fn effect_ids(s: &Store, request: &str) -> Vec<String> {
    s.read_request_effects(request)
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect()
}

/// `lockPersistenceCounters`: creates a missing counter row at zero and returns every named row. The
/// rows are read through the handle, so an admission that charges them before the commit refuses it.
#[test]
fn lock_persistence_counters_refuses_when_a_counter_was_charged() {
    row_of(
        "lockPersistenceCounters",
        Guarantee::ReadSet,
        "lock_persistence_counters_refuses_when_a_counter_was_charged",
    );
    let b = brain("mu-counters");
    let keys = KEYS.map(String::from);
    let (before, after) = proves_read_set(
        &b,
        "lockPersistenceCounters",
        |s| s.lock_persistence_counters(&keys),
        |b| {
            admit(b, REQ_1, "notes/a", "put_page");
        },
    );
    assert_ne!(before, after, "the rerun reads the charged counters");
}

/// `lockEffectRow`: the effect row read before a settle; an effect claimed or settled before the
/// commit refuses it.
#[test]
fn lock_effect_row_refuses_when_the_effect_was_claimed() {
    row_of(
        "lockEffectRow",
        Guarantee::ReadSet,
        "lock_effect_row_refuses_when_the_effect_was_claimed",
    );
    let b = brain("mu-effect-row");
    let id = admit(&b, REQ_1, "notes/a", "put_page");
    queue_effects(
        &b,
        &id,
        json!([{ "kind": "embedding", "data": { "slug": "notes/a", "page_id": 1 } }]),
    );
    let effect = effect_ids(&b, &id).remove(0);
    let fence = host_fence(&b);
    let (before, after) = proves_read_set(
        &b,
        "lockEffectRow",
        |s| {
            s.lock_effect_row(&effect)
                .map(|row| row.map(|r| r["state"].clone()))
        },
        |b| {
            b.stamp_effect_claim(&args(json!({ "id": effect, "token": TOKENS[0],
                "ownerJson": "{\"pid\":7}", "fence": fence })))
                .unwrap()
                .unwrap();
        },
    );
    assert_eq!(before, Some(json!("queued")));
    assert_eq!(after, Some(json!("running")));
}

/// `lockEffectClaimRow`: the claim row read (`{ state, execution_token }`) before a stamp.
#[test]
fn lock_effect_claim_row_refuses_when_the_effect_was_claimed() {
    row_of(
        "lockEffectClaimRow",
        Guarantee::ReadSet,
        "lock_effect_claim_row_refuses_when_the_effect_was_claimed",
    );
    let b = brain("mu-effect-claim-row");
    let id = admit(&b, REQ_1, "notes/a", "put_page");
    queue_effects(
        &b,
        &id,
        json!([{ "kind": "embedding", "data": { "slug": "notes/a", "page_id": 1 } }]),
    );
    let effect = effect_ids(&b, &id).remove(0);
    let numeric: i64 = effect.parse().unwrap();
    let fence = host_fence(&b);
    let (before, after) = proves_read_set(
        &b,
        "lockEffectClaimRow",
        |s| {
            s.lock_effect_claim_row(numeric)
                .map(|row| row["state"].clone())
        },
        |b| {
            b.stamp_effect_claim(&args(json!({ "id": effect, "token": TOKENS[0],
                "ownerJson": "{\"pid\":7}", "fence": fence })))
                .unwrap()
                .unwrap();
        },
    );
    assert_eq!((before, after), (json!("queued"), json!("running")));
}

/// The host registration every protected write of a multi-user brain carries (lane L5): a lease held
/// for hours, so the clock tests below do not expire it.
fn host_fence(b: &Brain) -> gbrain_store::leases::LeaseToken {
    let origin = gbrain_store::write_origin::WriteOrigin {
        host_id: "proof-host".into(),
        incarnation: "0190a000-0000-7000-8000-000000000001".into(),
        writer_id: "local_cli:proof".into(),
    };
    b.acquire_lease("consumer:proof", &origin, 10 * 60 * 60_000)
        .unwrap()
        .expect("the host lease is free")
}

const TOKENS: [&str; 3] = [
    "f0000000-0000-4000-8000-000000000001",
    "f0000000-0000-4000-8000-000000000002",
    "f0000000-0000-4000-8000-000000000003",
];

/// Two optimistic transactions claim at once through `claim`, which returns the id it claimed. Both
/// see the same row, so they would both claim it; the loser's commit refuses `write_conflict`, so the
/// row has one claimant. The loser's rerun, from a fresh snapshot, claims the next row; a third claim
/// finds none. Returns the ids claimed by the winner, the loser's rerun and the third.
fn two_claimants(
    b: &Brain,
    site: &str,
    claim: impl Fn(&Store, &str) -> Option<String>,
) -> (String, String, Option<String>) {
    let a = begin(b);
    let loser = begin(b);
    let won = claim(&a, TOKENS[0]).unwrap_or_else(|| panic!("{site}: nothing to claim"));
    let same = claim(&loser, TOKENS[1]).expect("the second claimant sees the same row");
    assert_eq!(won, same, "{site}: both claimants read the same row");
    a.commit_transaction().unwrap();
    let err = loser
        .commit_transaction()
        .expect_err(&format!("{site}: both claimants committed the same row"));
    assert_eq!(err.code, WRITE_CONFLICT, "{site}: {err:?}");

    let rerun = begin(b);
    let next =
        claim(&rerun, TOKENS[1]).unwrap_or_else(|| panic!("{site}: the rerun found no next row"));
    assert_ne!(next, won, "{site}: the rerun claimed the row again");
    rerun.commit_transaction().unwrap();

    let last = begin(b);
    let none = claim(&last, TOKENS[2]);
    last.commit_transaction().unwrap();
    (won, next, none)
}

/// `selectClaimableWrite` (`FOR UPDATE SKIP LOCKED` in SQL): two claimants never take one request.
#[test]
fn select_claimable_write_never_hands_one_request_to_two_claimants() {
    row_of(
        "selectClaimableWrite",
        Guarantee::ReadSet,
        "select_claimable_write_never_hands_one_request_to_two_claimants",
    );
    let b = brain("mu-claim-write");
    // Requests of one source run one at a time (each source is a root of its own queue), so the
    // second request lives in a second source and both are claimable at once.
    b.insert_source("other", "other", None, &serde_json::Map::new())
        .unwrap();
    let first = admit(&b, REQ_1, "notes/a", "put_page");
    let second = admit_in(&b, "other", REQ_2, "notes/b", "put_page");
    let fence = host_fence(&b);
    let spec = gbrain_store::persistence::ClaimableSpec {
        fence: Some(fence.clone()),
        ..Default::default()
    };
    let (won, next, none) = two_claimants(&b, "selectClaimableWrite", |s, token| {
        let row = s.select_claimable_write(&spec).unwrap()?;
        let id = row["id"].as_str().unwrap().to_string();
        s.stamp_write_claim(&args(
            json!({ "id": id, "token": token, "leaseMs": 60_000.0, "fence": fence }),
        ))
        .unwrap()
        .map(|claimed| claimed["id"].as_str().unwrap().to_string())
    });
    assert_eq!((won, next, none), (first.clone(), second.clone(), None));
    // The winner of the first row holds its claim token.
    let principal = gbrain_store::journal::Principal {
        kind: "local_cli".into(),
        id: "parity-writer".into(),
    };
    let held = b.read_write_request(&principal, REQ_1).unwrap().unwrap();
    assert_eq!(held["execution_token"], json!(TOKENS[0]));
}

/// `selectClaimableEffect` (`FOR UPDATE SKIP LOCKED` in SQL), with `lockEffectClaimRow` as the claim
/// path reads it: two claimants never take one effect.
#[test]
fn select_claimable_effect_never_hands_one_effect_to_two_claimants() {
    row_of(
        "selectClaimableEffect",
        Guarantee::ReadSet,
        "select_claimable_effect_never_hands_one_effect_to_two_claimants",
    );
    let b = brain("mu-claim-effect");
    let mut ids = Vec::new();
    for (request, slug) in [(REQ_1, "notes/a"), (REQ_2, "notes/b")] {
        let id = admit(&b, request, slug, "put_page");
        queue_effects(
            &b,
            &id,
            json!([{ "kind": "git", "data": { "relative_path": format!("{slug}.md") } }]),
        );
        ids.push(effect_ids(&b, &id).remove(0));
    }
    let fence = host_fence(&b);
    let (won, next, none) = two_claimants(&b, "selectClaimableEffect", |s, token| {
        let row = s.select_claimable_effect(HOST, &[]).unwrap();
        if row.is_null() {
            return None;
        }
        let id = row["id"].as_str().unwrap().to_string();
        let locked = s.lock_effect_claim_row(id.parse().unwrap()).unwrap();
        assert_eq!(locked["state"], "queued");
        s.stamp_effect_claim(&args(
            json!({ "id": id, "token": token, "ownerJson": "{\"pid\":7}", "fence": fence }),
        ))
        .unwrap()
        .map(|claimed| claimed["id"].as_str().unwrap().to_string())
    });
    assert_eq!((won, next, none), (ids[0].clone(), ids[1].clone(), None));
}

/// `claimCoalescedGitEffects` (`FOR UPDATE SKIP LOCKED` in SQL): two claimers of one worktree's ready
/// Git effects never take one effect. Both read the same candidate, so the loser's commit refuses
/// `write_conflict` (the effect it stamped was read through its handle); its rerun claims the next
/// effect and a third claim finds none.
#[test]
fn claim_coalesced_git_effects_never_hands_one_effect_to_two_claimants() {
    row_of(
        "claimCoalescedGitEffects",
        Guarantee::ReadSet,
        "claim_coalesced_git_effects_never_hands_one_effect_to_two_claimants",
    );
    const WORKTREE: &str = "f0000000-0000-4000-8000-0000000000a1";
    let b = brain("mu-claim-coalesced");
    b.insert_worktree(&args(
        json!({ "id": WORKTREE, "ownerHostId": HOST, "state": "active" }),
    ))
    .unwrap();
    let mut ids = Vec::new();
    for (request, slug) in [(REQ_1, "notes/a"), (REQ_2, "notes/b")] {
        let id = admit(&b, request, slug, "put_page");
        let spec: gbrain_store::persistence::PublicationEffectsSpec = args(json!({
            "requestId": id, "revision": "e0000000-0000-4000-8000-0000000000e1", "sourceId": "default",
            "sourceIncarnation": incarnation(&b, "default"), "worktreeId": WORKTREE,
            "effects": [{ "kind": "git", "data": { "relative_path": format!("{slug}.md") } }],
        }));
        b.insert_publication_effects(&spec).unwrap();
        ids.push(effect_ids(&b, &id).remove(0));
    }
    let claim = |s: &Store| -> Option<String> {
        let rows = s
            .claim_coalesced_git_effects(&args(json!({
                "hostId": HOST, "worktreeId": WORKTREE, "limit": 1, "deadOwners": [],
                "ownerJson": "{\"pid\":7}",
            })))
            .unwrap();
        assert!(rows.len() <= 1, "limit 1 claims at most one effect");
        rows.first()
            .map(|row| row["id"].as_str().unwrap().to_string())
    };
    let (won, next, none) = two_claimants(&b, "claimCoalescedGitEffects", |s, _| claim(s));
    assert_eq!((won, next, none), (ids[0].clone(), ids[1].clone(), None));
    for id in &ids {
        let row = b.lock_effect_row(id).unwrap().unwrap();
        assert_eq!(row["state"], "running");
        assert_eq!(row["attempts"], 1, "each effect was claimed once");
    }
}

const OWED: &str = "owed-page-purge";

/// A held concept: a synthesized concept tombstone whose re-derive mark is open at its own delete.
fn hold_concept(b: &Brain, slug: &str, id: u64) -> String {
    let input: PageInput = args(
        json!({ "type": "concept", "title": slug, "compiled_truth": "narrative",
        "frontmatter": { "synthesized_by": "synthesize_concepts:v1" } }),
    );
    b.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    b.soft_delete_page(slug, Some("default")).unwrap();
    b.mark_needs_rederive(&args(json!({ "table": "pages", "ids": [id.to_string()],
        "sourceId": "default", "requestId": null, "reason": "input_purged",
        "hiddenNow": [id.to_string()] })))
        .unwrap();
    b.read_held_concept(id as i64, OWED)
        .unwrap()
        .expect("the concept is held")
        .deleted_us
}

/// `lockHeldConcept` (`FOR UPDATE` on the tombstone in SQL): whether the tombstone is still held at its
/// delete instant. The held predicate is read through the handle (page, re-derive mark, owed-purge
/// checkpoint), so an owner purge that becomes owed before the commit refuses it; the rerun answers false.
#[test]
fn lock_held_concept_refuses_when_the_hold_ended() {
    row_of(
        "lockHeldConcept",
        Guarantee::ReadSet,
        "lock_held_concept_refuses_when_the_hold_ended",
    );
    let b = brain("mu-held-concept");
    let deleted = hold_concept(&b, "concepts/held", 1);
    let (before, after) = proves_read_set(
        &b,
        "lockHeldConcept",
        |s| s.lock_held_concept(1, "default", "concepts/held", &deleted, OWED),
        |b| {
            b.insert_op_checkpoint_if_absent(OWED, "1", &json!([]))
                .unwrap();
        },
    );
    assert_eq!((before, after), (true, false));
}

/// `lockLiveConceptMembers` (`FOR SHARE` on the member pages in SQL): how many members are live at the
/// revision the rebuild read. Each member page is read through the handle, so a member rewritten before the
/// commit refuses it; the rerun counts the member no longer at that revision.
#[test]
fn lock_live_concept_members_refuses_when_a_member_changed() {
    row_of(
        "lockLiveConceptMembers",
        Guarantee::ReadSet,
        "lock_live_concept_members_refuses_when_a_member_changed",
    );
    let b = brain("mu-concept-members");
    let revision = put_page(&b, "notes/m1", "one")["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_string();
    let members = [gbrain_store::concept_rebuild::MemberRevision {
        slug: "notes/m1".into(),
        revision,
    }];
    let (before, after) = proves_read_set(
        &b,
        "lockLiveConceptMembers",
        |s| s.lock_live_concept_members("default", &members),
        |b| {
            put_page(b, "notes/m1", "two");
        },
    );
    assert_eq!((before, after), (1, 0));
}

/// `lockNoopEmbeddingWindow` (`FOR UPDATE SKIP LOCKED` in SQL): two settlers of the window never settle
/// one effect; the loser refuses and its rerun's window holds the next effect.
#[test]
fn lock_noop_embedding_window_never_hands_one_effect_to_two_settlers() {
    row_of(
        "lockNoopEmbeddingWindow",
        Guarantee::ReadSet,
        "lock_noop_embedding_window_never_hands_one_effect_to_two_settlers",
    );
    let b = brain("mu-noop-window");
    let mut ids = Vec::new();
    for (request, slug) in [(REQ_1, "notes/a"), (REQ_2, "notes/b")] {
        let id = admit(&b, request, slug, "put_page");
        queue_effects(
            &b,
            &id,
            json!([{ "kind": "embedding", "data": { "slug": slug, "page_id": 1 } }]),
        );
        ids.push(effect_ids(&b, &id).remove(0));
    }
    let (won, next, none) = two_claimants(&b, "lockNoopEmbeddingWindow", |s, _| {
        let window = s.lock_noop_embedding_window("0", 1).unwrap();
        let rows = window["rows"].as_array().unwrap();
        let id = rows.first()?["id"].as_str().unwrap().to_string();
        let settled = s
            .settle_noop_embedding_rows(std::slice::from_ref(&id))
            .unwrap();
        assert_eq!(settled.len(), 1);
        Some(id)
    });
    assert_eq!((won, next, none), (ids[0].clone(), ids[1].clone(), None));
    for id in &ids {
        let row = b.lock_effect_row(id).unwrap().unwrap();
        assert_eq!(row["state"], "committed");
        assert_eq!(row["attempts"], 1, "each effect settled once");
    }
}

/// `lockOverdueHold`: the held request read before a release; a request that changes before the
/// commit refuses it.
#[test]
fn lock_overdue_hold_refuses_when_the_request_changed() {
    row_of(
        "lockOverdueHold",
        Guarantee::ReadSet,
        "lock_overdue_hold_refuses_when_the_request_changed",
    );
    let b = brain("mu-overdue-hold");
    let id = admit(&b, REQ_1, "notes/a", "put_page");
    let fence = host_fence(&b);
    let (before, after) = proves_read_set(
        &b,
        "lockOverdueHold",
        |s| s.lock_overdue_hold("import", Some(&id), Some("abc"), 0.0),
        |b| {
            b.stamp_write_claim(&args(
                json!({ "id": id, "token": TOKENS[0], "leaseMs": 60_000.0, "fence": fence }),
            ))
            .unwrap()
            .unwrap();
        },
    );
    assert_eq!((before, after), (false, false));
}

/// `listGitEffectsCarryingReason` and `listPageGitEffectsForStrip`: the Git effects a purge strips
/// are read through the handle; an effect rewritten before the commit refuses it, so the purge never
/// commits over data it did not read.
#[test]
fn purge_effect_reads_refuse_when_an_effect_changed() {
    row_of(
        "listGitEffectsCarryingReason",
        Guarantee::ReadSet,
        "purge_effect_reads_refuse_when_an_effect_changed",
    );
    row_of(
        "listPageGitEffectsForStrip",
        Guarantee::ReadSet,
        "purge_effect_reads_refuse_when_an_effect_changed",
    );
    let b = brain("mu-purge-effects");
    let id = admit(&b, REQ_1, "notes/a", "put_page");
    queue_effects(
        &b,
        &id,
        json!([{ "kind": "git", "data": {
        "slug": "notes/a", "relative_path": "notes/a.md", "commit_line": "reason: leaked-secret" } }]),
    );
    let effect = effect_ids(&b, &id).remove(0);
    let rewrite = |b: &Brain| {
        b.set_purge_effect_data(&args(json!({ "effectId": effect,
            "data": "{\"slug\":\"notes/a\",\"relative_path\":\"notes/a.md\"}" })))
            .unwrap()
    };
    let carrying = args(json!({
        "sourceId": "default", "needle": "leaked-secret", "escaped": "leaked-secret", "foldedJson": "leaked-secret" }));
    let (before, after) = proves_read_set(
        &b,
        "listGitEffectsCarryingReason",
        |s| {
            s.list_git_effects_carrying_reason(&carrying)
                .map(|rows| rows.len())
        },
        rewrite,
    );
    assert_eq!((before, after), (1, 0));

    // Back to carrying the reason, then the strip read.
    b.set_purge_effect_data(&args(json!({ "effectId": effect,
        "data": "{\"slug\":\"notes/a\",\"commit_line\":\"x\"}" })))
        .unwrap();
    let strip = args(json!({ "sourceId": "default", "slug": "notes/a" }));
    let (before, after) = proves_read_set(
        &b,
        "listPageGitEffectsForStrip",
        |s| {
            s.list_page_git_effects_for_strip(&strip)
                .map(|rows| rows.len())
        },
        rewrite,
    );
    assert_eq!((before, after), (1, 0));
}

// ---------------------------------------------------------------------------------------------
// Leases and single flight.

fn cycle_lock(
    token: &str,
    pid: i64,
    fence: &gbrain_store::leases::LeaseToken,
) -> gbrain_store::jobs::LockAcquire {
    args(
        json!({ "holderPid": pid, "holderHost": "proof-host", "acquisitionToken": token,
        "ttlMinutes": 1.0, "stealGraceSeconds": 0.0, "fence": fence }),
    )
}

/// `assertCycleLease` (`FOR KEY SHARE` on the lock row in SQL): the lock is held under the caller's
/// token and unexpired. A lock row that another process takes over (the steal of an expired lock, or
/// any refresh or release) between the check and the commit refuses the commit; the rerun's check
/// answers false.
///
/// The check is made at the transaction's own time, as the SQL engines' `now()` is: a lease that merely
/// runs out between the check and the commit, with nobody retaking it, does not refuse the commit
/// there either (`an_expired_but_untaken_cycle_lock_does_not_refuse_the_commit`).
#[test]
fn assert_cycle_lease_refuses_when_the_lock_is_retaken() {
    row_of(
        "assertCycleLease",
        Guarantee::ReadSet,
        "assert_cycle_lease_refuses_when_the_lock_is_retaken",
    );
    let b = brain("mu-cycle-lease");
    let fence = host_fence(&b);
    let t1 = "a0000000-0000-4000-8000-0000000000a1";
    let t2 = "a0000000-0000-4000-8000-0000000000a2";
    assert!(
        b.acquire_cycle_lock("gbrain-sync:default", &cycle_lock(t1, 100, &fence))
            .unwrap()
            .is_some()
    );
    let (before, after) = proves_read_set(
        &b,
        "assertCycleLease",
        |s| s.assert_cycle_lease_fenced("gbrain-sync:default", t1, Some(&fence)),
        |b| {
            // The first holder's minute runs out and a second process steals the lock.
            b.advance(2 * MINUTE);
            assert!(
                b.acquire_cycle_lock("gbrain-sync:default", &cycle_lock(t2, 200, &fence))
                    .unwrap()
                    .is_some()
            );
        },
    );
    assert_eq!((before, after), (true, false));
}

/// The parity note of `assert_cycle_lease_refuses_when_the_lock_is_retaken`: expiry alone is not a
/// change to any row, so the commit is not refused; it is the same on PGLite and Postgres, where the
/// `FOR KEY SHARE` check reads `ttl_expires_at > now()` once and holds only against a takeover.
#[test]
fn an_expired_but_untaken_cycle_lock_does_not_refuse_the_commit() {
    let b = brain("mu-cycle-lease-expiry");
    let fence = host_fence(&b);
    let token = "a0000000-0000-4000-8000-0000000000a1";
    b.acquire_cycle_lock("gbrain-sync:default", &cycle_lock(token, 100, &fence))
        .unwrap()
        .unwrap();
    let t = begin(&b);
    assert!(
        t.assert_cycle_lease_fenced("gbrain-sync:default", token, Some(&fence))
            .unwrap()
    );
    t.set_config(MARK, "committed").unwrap();
    b.advance(5 * MINUTE);
    t.commit_transaction().unwrap();
    assert_eq!(mark(&b).as_deref(), Some("committed"));
    // A check made after the expiry answers false.
    let late = begin(&b);
    assert!(
        !late
            .assert_cycle_lease_fenced("gbrain-sync:default", token, Some(&fence))
            .unwrap()
    );
    late.rollback_transaction().unwrap();
}

/// `lockPageKeys` and `holdPageKeys`: the keys are held in the brain's single-flight table until the
/// transaction ends, so two creators of one slug run one after the other. The second waits for the
/// key, then reads the first's page: the slug is created once and nobody refuses.
#[test]
fn page_keys_are_held_single_flight_so_a_slug_is_created_once() {
    row_of(
        "holdPageKeys",
        Guarantee::SingleFlight,
        "page_keys_are_held_single_flight_so_a_slug_is_created_once",
    );
    row_of(
        "lockPageKeys",
        Guarantee::SingleFlight,
        "page_keys_are_held_single_flight_so_a_slug_is_created_once",
    );
    let b = Arc::new(brain("mu-page-keys"));
    let key = || gbrain_store::transactions::PageKeyHint {
        source_id: "default".into(),
        slug: "notes/new".into(),
        incarnation: None,
    };
    let scope = gbrain_store::pages::ReadScope::default();
    // The store call that checks the keys passes in multi-user mode.
    b.lock_page_keys(&[gbrain_store::pages::PageKey {
        source_id: "default".into(),
        slug: "notes/new".into(),
    }])
    .unwrap();

    let first = begin(&b);
    assert_eq!(first.hold_page_keys(&[key()], false).unwrap().len(), 1);
    assert!(
        first
            .read_page_snapshot("notes/new", &scope)
            .unwrap()
            .is_none()
    );
    put_page(&first, "notes/new", "created by the first");

    // A transaction with a deadline cannot take the held key.
    let busy = b
        .begin_bound(TxnOptions {
            deadline: Some(std::time::Instant::now() + std::time::Duration::from_millis(30)),
            ..optimistic()
        })
        .unwrap();
    let err = busy.hold_page_keys(&[key()], false).unwrap_err();
    assert_eq!(err.code, gbrain_store::error::TIMEOUT);
    assert!(err.message.starts_with("key_wait: "), "{}", err.message);
    busy.rollback_transaction().unwrap();

    // The second creator waits for the key.
    let store = b.clone();
    let second = std::thread::spawn(move || {
        let t = begin(&store);
        t.hold_page_keys(&[key()], false).unwrap();
        let existed = t.read_page_snapshot("notes/new", &scope).unwrap().is_some();
        if !existed {
            put_page(&t, "notes/new", "created by the second");
        }
        t.commit_transaction().map(|_| existed)
    });
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !second.is_finished(),
        "the second creator did not wait for the key"
    );
    first.commit_transaction().unwrap();
    assert!(
        second
            .join()
            .unwrap()
            .expect("the waiter commits without a refusal"),
        "the second creator read the first's page"
    );
    let page = b
        .read_page_snapshot("notes/new", &Default::default())
        .unwrap()
        .unwrap();
    assert_eq!(page["page"]["compiled_truth"], "created by the first");
}

// ---------------------------------------------------------------------------------------------
// Rust members behind the TypeScript sites of the mention pass (R14) and the derivation sweep (R15).
// They are not marked sites (`mention_state.rs` and `derivation_sweep.rs` skip no lock of their own),
// so they have no row; these tests prove the reads the TypeScript sites rely on are validated.

fn entry(name: &str, target: &str) -> gbrain_store::mention_state::EntryKeyRow {
    gbrain_store::mention_state::EntryKeyRow {
        source_id: "default".into(),
        name_norm: name.into(),
        target_slug: target.into(),
        case_sensitive: false,
    }
}

/// R14, `lockMentionSources` / `lockMentionEntries`: the advisory locks serialize two mention passes of
/// one source. Each pass reads the saved gazetteer entries, diffs them against what it computed and
/// applies the difference. Two passes that interleave both read the same entries; the second commit
/// refuses `write_conflict` and its rerun diffs against the first's entries, so no entry is applied
/// twice or removed from under a pass that did not see it. The per-page state rows work the same way.
#[test]
fn two_mention_passes_of_one_source_never_both_apply_their_diff() {
    let b = brain("mu-mention-pass");
    let page = put_page(&b, "people/alice", "Alice")["id"]
        .as_i64()
        .unwrap();
    let revision = |s: &Store| {
        s.read_mention_page_revisions(&[page]).unwrap()[0]["revision"]
            .as_str()
            .unwrap()
            .to_string()
    };
    // One pass: read the saved entries, add what is missing, record the page as scanned.
    let pass = |s: &Store, want: &gbrain_store::mention_state::EntryKeyRow| {
        let saved = s.list_gazetteer_entry_keys("default").unwrap();
        let added: Vec<_> = if saved.contains(want) {
            vec![]
        } else {
            vec![want.clone()]
        };
        s.apply_gazetteer_entry_changes("default", &[], &added)
            .unwrap();
        s.upsert_page_mention_state(
            "default",
            &[gbrain_store::mention_state::PageRevisionInput {
                id: page,
                revision: revision(s),
            }],
            1,
            "1",
        )
        .unwrap();
        added.len()
    };
    let a = begin(&b);
    let loser = begin(&b);
    assert_eq!(pass(&a, &entry("alice", "people/alice")), 1);
    assert_eq!(
        pass(&loser, &entry("alice", "people/alice")),
        1,
        "both read no entries"
    );
    a.commit_transaction().unwrap();
    assert_eq!(loser.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    let rerun = begin(&b);
    assert_eq!(
        pass(&rerun, &entry("alice", "people/alice")),
        0,
        "the rerun sees the first pass's entry"
    );
    rerun.commit_transaction().unwrap();
    assert_eq!(b.list_gazetteer_entry_keys("default").unwrap().len(), 1);
}

/// R15, `continueDerivationSweep` (TypeScript: `page-purge-sweep.ts`): the sweep reads a batch of
/// derivation rows and deletes those that hold the purged claim. A row written into the walked range
/// before the sweep's commit refuses the commit and the sweep's deletes are not kept; two sweeps of one
/// source never both end the record.
#[test]
fn a_derivation_sweep_refuses_when_the_rows_it_walked_change() {
    let b = brain("mu-derivation-sweep");
    let meta: gbrain_store::page_body::SegmentedPageMeta =
        args(json!({ "type": "note", "title": "n" }));
    let page = b
        .create_segmented_page_shell(
            "notes/sweep",
            &meta,
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let sha = "ab".repeat(32);
    let derivation = |occurrence: i64,
                      excerpt: &str|
     -> gbrain_store::page_body::SegmentDerivationInput {
        args(
            json!({ "pageId": page, "kind": "links", "occurrenceId": occurrence, "version": 1,
            "segmentSha256": sha, "contextHash": sha, "state": "done", "output": { "excerpt": excerpt } }),
        )
    };
    b.upsert_segment_derivations(&[derivation(1, "Alice likes tea"), derivation(2, "harmless")])
        .unwrap();
    b.record_derivation_purge_row(&args(json!({
        "requestId": "c0000000-0000-4000-8000-0000000000c1", "sourceId": "default",
        "needles": [" alice likes tea "], "patterns": ["%alice%likes%tea%"], "pageIds": [] })))
        .unwrap();
    let sweep = |s: &Store| {
        s.continue_derivation_sweep(&args(json!({ "sourceId": "default", "first": null,
            "inline": false, "batchRows": 100, "totalMs": 5000, "inlineMs": 5000 })))
            .unwrap()
    };
    let rows = |s: &Store| {
        s.read_segment_derivations(page, &Default::default())
            .unwrap()
            .len()
    };
    assert_eq!(rows(&b), 2);

    // A row written into the walked range between the sweep and its commit refuses the commit.
    let t = begin(&b);
    sweep(&t);
    b.upsert_segment_derivations(&[derivation(3, "another harmless row")])
        .unwrap();
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(rows(&b), 3, "the refused sweep deleted nothing");

    // Two sweeps of the source: the second refuses, and its rerun finds the walk done.
    let first = begin(&b);
    let second = begin(&b);
    sweep(&first);
    sweep(&second);
    first.commit_transaction().unwrap();
    assert_eq!(
        second.commit_transaction().unwrap_err().code,
        WRITE_CONFLICT
    );
    let rerun = begin(&b);
    sweep(&rerun);
    rerun.commit_transaction().unwrap();
    assert_eq!(
        rows(&b),
        2,
        "the claim row went once, the harmless rows stay"
    );
}

// ---------------------------------------------------------------------------------------------
// A site without a proof.

/// A site that is not in the table refuses `engine_capability_missing` in multi-user mode, before it
/// reads or writes anything, and the same call passes with multi-user mode off. Every marked Rust site
/// has a row now, so the unproven site is an id with none (the refusal is by id, whichever member asks).
#[test]
fn a_site_without_a_proof_refuses_in_multi_user_mode_and_passes_with_it_off() {
    const UNPROVEN: &str = "siteWithNoProof";
    assert!(proven(UNPROVEN).is_none());
    let on = brain("mu-unproven-on");
    let before = on.commit_version().unwrap();
    let err = on.assert_serialized_transactions(UNPROVEN).unwrap_err();
    assert_eq!(err.code, ENGINE_CAPABILITY_MISSING);
    assert!(
        err.message.starts_with(&format!(
            "serialized_transactions: {UNPROVEN} has no guarantee proven under multi-user mode"
        )),
        "{}",
        err.message
    );
    assert_eq!(
        on.commit_version().unwrap(),
        before,
        "a refusal writes nothing"
    );

    let dir = TempDir::new("mu-unproven-off");
    let off = Store::open_dir(&dir.path().join("brain"), OpenOptions::default()).unwrap();
    assert!(!off.multiuser());
    assert!(off.serialized_transactions());
    off.assert_serialized_transactions(UNPROVEN).unwrap();
}
