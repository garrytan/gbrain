//! The `access_tokens` members (`insertAccessToken`, `findActiveAccessTokens`, `setAccessTokenMinTrust`, `readLiveAccessTokenScope`). What the parity
//! file cannot see lives here: the stored message of each refusal (the TypeScript member turns it into SQLSTATE 23514 /
//! 23505 and the constraint name), that a refused write leaves the table as it was, and the generated ids.

mod memory_env;

use gbrain_store::jobs::TokenInsert;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn insert(b: &Brain, row: Value) -> Result<String, gbrain_store::error::StoreError> {
    let row: TokenInsert = serde_json::from_value(row).unwrap();
    b.insert_access_token(&row)
}

fn token(name: &str, hash: &str, extra: Value) -> Value {
    let mut row = json!({
        "name": name, "token_hash": hash, "scopes": ["read"], "permissions": { "source_id": "wiki" },
        "source_grant": "default", "source_id": null, "federated_read": null, "allowed_operations": null, "takes_holders": null,
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    row
}

fn found(b: &Brain, target: &str) -> Vec<Value> {
    b.find_active_access_tokens(target)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn an_insert_returns_a_fresh_id_each_time_and_the_row_is_found_by_id_and_by_name() {
    let b = brain("tokens-insert");
    let a = insert(&b, token("harness", "h1", json!({}))).unwrap();
    let c = insert(&b, token("harness", "h2", json!({}))).unwrap();
    assert_ne!(a, c);
    assert_eq!(
        found(&b, &a),
        vec![json!({ "id": a, "name": "harness", "min_trust": null })]
    );
    let both = found(&b, "harness");
    assert_eq!(both.len(), 2, "a name two active tokens share finds both");
    assert!(both[0]["id"].as_str() < both[1]["id"].as_str(), "by id");
    assert!(found(&b, "nobody").is_empty());
}

#[test]
fn a_revoked_token_is_not_found_and_a_repeated_hash_or_bad_value_is_refused_and_leaves_the_table() {
    let b = brain("tokens-refused");
    let live = insert(&b, token("live", "h1", json!({}))).unwrap();
    insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    assert_eq!(found(&b, "live").len(), 1);
    assert!(found(&b, "gone").is_empty(), "a revoked row never matches");

    let dup = insert(&b, token("other", "h1", json!({}))).expect_err("a repeated hash");
    assert_eq!(dup.code, "constraint_violation");
    assert_eq!(
        dup.message,
        "duplicate key value violates unique constraint \"access_tokens_token_hash_key\""
    );
    let grant = insert(
        &b,
        token("bad-grant", "h3", json!({ "source_grant": "everything" })),
    )
    .expect_err("a source grant outside the list");
    assert_eq!(
        grant.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_source_grant_check\""
    );
    let tier = insert(&b, token("bad-tier", "h4", json!({ "min_trust": "bogus" })))
        .expect_err("a tier outside the six");
    assert_eq!(
        tier.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_min_trust_check\""
    );
    assert!(
        found(&b, "other").is_empty()
            && found(&b, "bad-grant").is_empty()
            && found(&b, "bad-tier").is_empty()
    );
    assert_eq!(found(&b, &live).len(), 1);
}

#[test]
fn a_floor_is_set_cleared_and_refused_without_touching_the_row() {
    let b = brain("tokens-floor");
    let id = insert(&b, token("t", "h1", json!({}))).unwrap();
    assert!(
        b.set_access_token_min_trust(&id, Some("tool_observed"))
            .unwrap()
    );
    assert_eq!(found(&b, &id)[0]["min_trust"], json!("tool_observed"));
    let err = b
        .set_access_token_min_trust(&id, Some("bogus"))
        .expect_err("a tier outside the six");
    assert_eq!(
        err.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_min_trust_check\""
    );
    assert_eq!(
        found(&b, &id)[0]["min_trust"],
        json!("tool_observed"),
        "the refused write changed nothing"
    );
    assert!(b.set_access_token_min_trust(&id, None).unwrap());
    assert_eq!(found(&b, &id)[0]["min_trust"], Value::Null);
    assert!(
        !b.set_access_token_min_trust("00000000-0000-4000-8000-000000000000", Some("unknown"))
            .unwrap()
    );
}

#[test]
fn the_name_read_answers_each_asked_token_once_by_id_a_revoked_one_included() {
    let b = brain("tokens-names");
    let live = insert(&b, token("live", "h1", json!({}))).unwrap();
    let gone = insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    insert(&b, token("unasked", "h3", json!({}))).unwrap();
    let ids = [&live, &gone, &live, &"not-a-token".to_string()].map(|s| s.to_string());
    let mut want = vec![
        json!({ "id": live, "name": "live" }),
        json!({ "id": gone, "name": "gone" }),
    ];
    want.sort_by(|a, c| a["id"].as_str().cmp(&c["id"].as_str()));
    assert_eq!(b.read_access_token_names(&ids).unwrap(), Value::Array(want));
    assert_eq!(b.read_access_token_names(&[]).unwrap(), json!([]));
}

const MINUTE_US: i64 = 60_000_000;

#[test]
fn the_list_is_newest_first_with_the_columns_not_kept_at_their_defaults_and_no_hash() {
    let b = brain("tokens-list");
    let first = insert(&b, token("older", "hash-older", json!({}))).unwrap();
    b.clock.advance(1_000_000);
    let second = insert(&b, token("newer", "hash-newer", json!({}))).unwrap();
    let rows = b.list_access_tokens().unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![second.as_str(), first.as_str()]
    );
    assert_eq!(rows[0]["name"], "newer");
    assert_eq!(rows[0]["scopes"], json!(["read"]));
    assert_eq!(rows[0]["revoked_at"], Value::Null);
    assert_eq!(rows[0]["last_used_at"], Value::Null);
    assert_eq!(rows[0]["member_id"], Value::Null);
    assert_eq!(rows[0]["private_pages"], "none");
    assert_eq!(rows[0]["private_facts"], "none");
    assert_eq!(rows[1]["created_at"], "2027-01-15T08:00:00.000000Z");
    assert!(
        rows.iter().all(|r| r.get("token_hash").is_none()),
        "no listed row carries the hash"
    );
}

#[test]
fn the_whole_row_list_keeps_revoked_tokens_newest_first_with_a_tie_by_id_and_no_hash() {
    let b = brain("tokens-whole-rows");
    let older = insert(&b, token("older", "hash-older", json!({}))).unwrap();
    b.clock.advance(1_000_000);
    let tie_a = insert(&b, token("tie-a", "hash-tie-a", json!({}))).unwrap();
    let tie_b = insert(&b, token("tie-b", "hash-tie-b", json!({}))).unwrap();
    b.revoke_access_token(&older).unwrap();
    let rows = b.list_access_token_rows().unwrap();
    let rows = rows.as_array().unwrap();
    let mut tied = [tie_a.clone(), tie_b.clone()];
    tied.sort();
    let want: Vec<&str> = tied
        .iter()
        .map(String::as_str)
        .chain([older.as_str()])
        .collect();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        want,
        "newest first, the same instant ordered by id, the revoked token kept"
    );
    assert_ne!(rows[2]["revoked_at"], Value::Null);
    assert_eq!(rows[0]["revoked_at"], Value::Null);
    assert_eq!(rows[2]["created_at"], "2027-01-15T08:00:00.000000Z");
    assert!(
        rows.iter().all(|r| r.get("token_hash").is_none()),
        "no row carries the hash"
    );
}

#[test]
fn a_revoke_by_name_stamps_every_active_token_of_that_name_once_and_ends_its_liveness() {
    let b = brain("tokens-revoke-name");
    let a = insert(&b, token("shared", "hash-a", json!({}))).unwrap();
    let c = insert(&b, token("shared", "hash-c", json!({}))).unwrap();
    let other = insert(&b, token("other", "hash-o", json!({}))).unwrap();
    assert!(b.access_token_live(&a).unwrap());
    b.clock.advance(5_000_000);
    let mut want = vec![a.clone(), c.clone()];
    want.sort();
    assert_eq!(b.revoke_access_tokens_named("shared").unwrap(), want);
    assert!(
        b.revoke_access_tokens_named("shared").unwrap().is_empty(),
        "a revoked token is not revoked twice"
    );
    assert!(!b.access_token_live(&a).unwrap());
    assert!(!b.access_token_live(&c).unwrap());
    assert!(b.access_token_live(&other).unwrap());
    assert!(found(&b, "shared").is_empty());
    let rows = b.list_access_tokens().unwrap();
    let revoked: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] == "shared")
        .map(|r| r["revoked_at"].clone())
        .collect();
    assert_eq!(
        revoked,
        vec![
            json!("2027-01-15T08:00:05.000000Z"),
            json!("2027-01-15T08:00:05.000000Z")
        ]
    );
}

#[test]
fn a_revoke_by_id_returns_the_name_once_and_the_grant_read_stops_finding_it() {
    let b = brain("tokens-revoke-id");
    let id = insert(&b, token("solo", "hash-s", json!({}))).unwrap();
    assert_eq!(
        b.read_active_access_token_grant(&id.to_ascii_uppercase())
            .unwrap(),
        Some(json!({ "permissions": { "source_id": "wiki" }, "private_pages": "none" }))
    );
    assert!(b.access_token_live(&id).unwrap());
    assert!(
        !b.access_token_live("00000000-0000-4000-8000-0000000000c1")
            .unwrap()
    );
    assert_eq!(
        b.revoke_access_token(&id.to_ascii_uppercase())
            .unwrap()
            .as_deref(),
        Some("solo")
    );
    assert_eq!(b.revoke_access_token(&id).unwrap(), None);
    assert_eq!(
        b.revoke_access_token("00000000-0000-4000-8000-0000000000c1")
            .unwrap(),
        None
    );
    assert_eq!(b.read_active_access_token_grant(&id).unwrap(), None);
    assert!(!b.access_token_live(&id).unwrap());
}

#[test]
fn the_bearer_read_finds_the_active_token_by_hash_without_the_hash_and_not_after_revoke() {
    let b = brain("tokens-by-hash");
    let id = insert(
        &b,
        token("bearer", "hash-b", json!({ "min_trust": "tool_observed" })),
    )
    .unwrap();
    insert(&b, token("other", "hash-o", json!({}))).unwrap();
    let row = b
        .read_active_access_token_by_hash("hash-b")
        .unwrap()
        .unwrap();
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["name"], json!("bearer"));
    assert_eq!(row["scopes"], json!(["read"]));
    assert_eq!(row["source_grant"], json!("default"));
    assert_eq!(row["min_trust"], json!("tool_observed"));
    assert_eq!(row["grant_revision"], json!(1));
    assert_eq!(row["private_pages"], json!("none"));
    assert_eq!(row["member_id"], Value::Null);
    assert!(row.get("token_hash").is_none());
    assert_eq!(b.read_active_access_token_by_hash("hash-").unwrap(), None);
    assert_eq!(b.read_active_access_token_by_hash("nope").unwrap(), None);
    b.revoke_access_token(&id).unwrap();
    assert_eq!(b.read_active_access_token_by_hash("hash-b").unwrap(), None);
    assert!(
        b.read_active_access_token_by_hash("hash-o")
            .unwrap()
            .is_some()
    );
}

#[test]
fn the_job_principal_read_finds_the_token_by_id_in_any_case_revoked_or_not_without_the_hash() {
    let b = brain("tokens-by-id");
    let id = insert(
        &b,
        token(
            "legacy",
            "hash-l",
            json!({ "scopes": ["admin"], "source_grant": null }),
        ),
    )
    .unwrap();
    insert(&b, token("other", "hash-o", json!({}))).unwrap();
    let row = b
        .read_access_token(&id.to_ascii_uppercase())
        .unwrap()
        .unwrap();
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["name"], json!("legacy"));
    assert_eq!(row["scopes"], json!(["admin"]));
    assert_eq!(row["permissions"], json!({ "source_id": "wiki" }));
    assert_eq!(row["source_grant"], Value::Null);
    assert_eq!(row["revoked_at"], Value::Null);
    assert!(row.get("token_hash").is_none());
    assert_eq!(
        b.read_access_token("00000000-0000-4000-8000-0000000000c9")
            .unwrap(),
        None
    );
    b.revoke_access_token(&id).unwrap();
    let revoked = b.read_access_token(&id).unwrap().unwrap();
    assert_eq!(revoked["name"], json!("legacy"));
    assert!(
        revoked["revoked_at"].is_string(),
        "a revoked token is read with its revoked_at"
    );
}

#[test]
fn the_last_use_stamp_is_null_until_a_check_and_waits_a_minute_before_it_moves() {
    let b = brain("tokens-last-used");
    let id = insert(&b, token("seen", "hash-s", json!({}))).unwrap();
    let last = |b: &Brain| {
        let row = b
            .read_active_access_token_by_hash("hash-s")
            .unwrap()
            .unwrap();
        let listed = b.list_access_tokens().unwrap();
        assert_eq!(
            listed[0]["last_used_at"], row["last_used_at"],
            "the list and the bearer read agree"
        );
        row["last_used_at"].clone()
    };
    assert_eq!(last(&b), Value::Null);
    b.touch_access_token_last_used(&id, true).unwrap();
    let first = last(&b);
    assert_eq!(first, json!(gbrain_store::env::iso(memory_env::T0)));
    b.clock.advance(MINUTE_US - 1);
    b.touch_access_token_last_used(&id, true).unwrap();
    assert_eq!(last(&b), first, "inside 60 seconds nothing changes");
    b.clock.advance(1);
    b.touch_access_token_last_used(&id, true).unwrap();
    assert_eq!(
        last(&b),
        first,
        "exactly 60 seconds is not older than now() - 60 s"
    );
    b.clock.advance(1);
    b.touch_access_token_last_used(&id, true).unwrap();
    assert_eq!(
        last(&b),
        json!(gbrain_store::env::iso(memory_env::T0 + MINUTE_US + 1))
    );
}

#[test]
fn the_unified_stamp_leaves_a_row_with_no_source_grant_and_the_legacy_stamp_does_not() {
    let b = brain("tokens-last-used-unified");
    let id = insert(&b, token("old", "hash-o", json!({ "source_grant": null }))).unwrap();
    b.touch_access_token_last_used(&id, true).unwrap();
    let row = b
        .read_active_access_token_by_hash("hash-o")
        .unwrap()
        .unwrap();
    assert_eq!(row["last_used_at"], Value::Null);
    b.touch_access_token_last_used(&id, false).unwrap();
    let row = b
        .read_active_access_token_by_hash("hash-o")
        .unwrap()
        .unwrap();
    assert!(row["last_used_at"].is_string());
    b.touch_access_token_last_used("00000000-0000-0000-0000-00000000dead", true)
        .unwrap();
}

#[test]
fn a_legacy_token_converts_once_with_one_more_revision_and_a_bad_kind_leaves_it() {
    use gbrain_store::jobs::TokenGrantColumns;
    let b = brain("tokens-legacy-convert");
    let id = insert(&b, token("old", "hash-l", json!({ "source_grant": null }))).unwrap();
    let columns = |kind: &str| -> TokenGrantColumns {
        serde_json::from_value(json!({
            "source_grant": kind, "source_id": "wiki", "federated_read": null,
            "allowed_operations": ["query"], "takes_holders": ["world"],
        }))
        .unwrap()
    };
    assert!(
        b.convert_legacy_access_token_grant(&id, &columns("sideways"))
            .is_err()
    );
    let row = b
        .read_active_access_token_by_hash("hash-l")
        .unwrap()
        .unwrap();
    assert_eq!(row["source_grant"], Value::Null);
    let before = row["grant_revision"].as_i64().unwrap();
    let converted = b
        .convert_legacy_access_token_grant(&id.to_ascii_uppercase(), &columns("default"))
        .unwrap()
        .unwrap();
    assert_eq!(converted["id"], json!(id));
    assert_eq!(converted["source_grant"], json!("default"));
    assert_eq!(converted["source_id"], json!("wiki"));
    assert_eq!(converted["allowed_operations"], json!(["query"]));
    assert_eq!(converted["takes_holders"], json!(["world"]));
    assert_eq!(converted["grant_revision"], json!(before + 1));
    assert!(converted["last_used_at"].is_string());
    assert!(converted.get("token_hash").is_none());
    let row = b
        .read_active_access_token_by_hash("hash-l")
        .unwrap()
        .unwrap();
    assert_eq!(row, converted);
    assert_eq!(
        b.convert_legacy_access_token_grant(&id, &columns("default"))
            .unwrap(),
        None
    );
    assert_eq!(
        b.convert_legacy_access_token_grant(
            "00000000-0000-0000-0000-00000000dead",
            &columns("default")
        )
        .unwrap(),
        None
    );
}

fn locked(b: &Brain, id: Option<&str>, name: Option<&str>) -> Vec<Value> {
    b.lock_active_access_tokens(id, name)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn the_rescope_read_finds_active_tokens_by_id_in_any_case_or_exact_name_oldest_first_without_the_hash()
 {
    let b = brain("tokens-lock");
    let late = insert(
        &b,
        token(
            "twin",
            "h-late",
            json!({ "created_at": "2026-02-02T00:00:00Z" }),
        ),
    )
    .unwrap();
    let early = insert(
        &b,
        token(
            "twin",
            "h-early",
            json!({ "created_at": "2026-01-01T00:00:00Z" }),
        ),
    )
    .unwrap();
    let gone = insert(
        &b,
        token(
            "solo",
            "h-gone",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    let ids: Vec<Value> = locked(&b, None, Some("twin"))
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!(early), json!(late)], "oldest first");
    let by_id = locked(&b, Some(&late.to_ascii_uppercase()), None);
    assert_eq!(by_id.len(), 1);
    assert_eq!(by_id[0]["name"], json!("twin"));
    assert_eq!(by_id[0]["private_pages"], json!("none"));
    assert!(by_id[0].get("token_hash").is_none());
    assert!(
        locked(&b, None, Some("Twin")).is_empty(),
        "the name is exact"
    );
    assert!(
        locked(&b, None, Some("solo")).is_empty(),
        "a revoked token is left out"
    );
    assert!(locked(&b, Some(&gone), None).is_empty());
    assert!(locked(&b, Some("00000000-0000-4000-8000-0000000000c9"), None).is_empty());
    assert!(b.lock_active_access_tokens(None, None).is_err());
    assert!(
        b.lock_active_access_tokens(Some(&late), Some("twin"))
            .is_err()
    );
}

#[test]
fn a_grant_write_sets_the_columns_scopes_and_permissions_with_one_more_revision_and_a_bad_kind_leaves_the_row()
 {
    use gbrain_store::jobs::TokenGrantColumns;
    let b = brain("tokens-grant-write");
    let id = insert(&b, token("laptop", "hash-g", json!({}))).unwrap();
    let columns = |kind: &str| -> TokenGrantColumns {
        serde_json::from_value(json!({
            "source_grant": kind, "source_id": "default", "federated_read": ["default", "work"],
            "allowed_operations": ["query"], "takes_holders": ["world"],
        }))
        .unwrap()
    };
    let before = b
        .read_active_access_token_by_hash("hash-g")
        .unwrap()
        .unwrap();
    let revision = before["grant_revision"].as_i64().unwrap();
    let refused = b
        .write_access_token_grant(&id, &columns("everything"), None, json!({ "x": 1 }))
        .expect_err("a source grant outside the list");
    assert_eq!(refused.code, "constraint_violation");
    assert_eq!(
        refused.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_source_grant_check\""
    );
    assert_eq!(
        b.read_active_access_token_by_hash("hash-g")
            .unwrap()
            .unwrap(),
        before,
        "a refused write leaves the row"
    );

    let written = b
        .write_access_token_grant(
            &id.to_ascii_uppercase(),
            &columns("federated"),
            None,
            json!({ "keep": 1 }),
        )
        .unwrap();
    assert_eq!(written, Some(revision as i32 + 1));
    let row = b
        .read_active_access_token_by_hash("hash-g")
        .unwrap()
        .unwrap();
    assert_eq!(row["source_grant"], json!("federated"));
    assert_eq!(row["federated_read"], json!(["default", "work"]));
    assert_eq!(row["allowed_operations"], json!(["query"]));
    assert_eq!(row["takes_holders"], json!(["world"]));
    assert_eq!(row["scopes"], json!(["read"]), "no scopes keeps them");
    assert_eq!(row["permissions"], json!({ "keep": 1 }));

    let written = b
        .write_access_token_grant(
            &id,
            &columns("scalar"),
            Some(vec!["read".into(), "write".into()]),
            json!({}),
        )
        .unwrap();
    assert_eq!(written, Some(revision as i32 + 2));
    let row = b
        .read_active_access_token_by_hash("hash-g")
        .unwrap()
        .unwrap();
    assert_eq!(row["scopes"], json!(["read", "write"]));
    assert_eq!(
        b.write_access_token_grant(
            "00000000-0000-4000-8000-00000000dead",
            &columns("default"),
            None,
            json!({})
        )
        .unwrap(),
        None,
        "an id no token has writes nothing"
    );
}

#[test]
fn the_private_grants_are_kept_read_back_and_refused_outside_the_two_values() {
    let b = brain("tokens-private-grants");
    let id = insert(&b, token("laptop", "hash-p", json!({}))).unwrap();
    let row = || {
        b.read_active_access_token_by_hash("hash-p")
            .unwrap()
            .unwrap()
    };
    assert_eq!(
        (
            row()["private_pages"].clone(),
            row()["private_facts"].clone()
        ),
        (json!("none"), json!("none"))
    );
    b.write_access_token_private_grant(
        &id.to_ascii_uppercase(),
        "private_pages",
        "granted_sources",
    )
    .unwrap();
    b.write_access_token_private_grant(&id, "private_facts", "granted_sources")
        .unwrap();
    assert_eq!(row()["private_pages"], json!("granted_sources"));
    assert_eq!(row()["private_facts"], json!("granted_sources"));
    let grant = b.read_access_token_write_grant(&id).unwrap().unwrap();
    assert_eq!(grant["private_pages"], json!("granted_sources"));
    assert_eq!(grant["private_facts"], json!("granted_sources"));
    let listed = b.lock_active_access_tokens(Some(&id), None).unwrap();
    assert_eq!(listed[0]["private_pages"], json!("granted_sources"));

    for (axis, constraint) in [
        ("private_pages", "access_tokens_private_pages_check"),
        ("private_facts", "access_tokens_private_facts_check"),
    ] {
        let refused = b
            .write_access_token_private_grant(&id, axis, "everything")
            .expect_err("a value outside the two");
        assert_eq!(refused.code, "constraint_violation");
        assert_eq!(
            refused.message,
            format!(
                "new row for relation \"access_tokens\" violates check constraint \"{constraint}\""
            )
        );
    }
    assert_eq!(
        row()["private_pages"],
        json!("granted_sources"),
        "a refused write leaves the row"
    );
    let other = b
        .write_access_token_private_grant(&id, "scopes", "none")
        .expect_err("another axis");
    assert_eq!(other.code, "invalid_argument");
    b.write_access_token_private_grant(
        "00000000-0000-4000-8000-00000000dead",
        "private_pages",
        "none",
    )
    .unwrap();

    b.write_access_token_private_grant(&id, "private_pages", "none")
        .unwrap();
    assert_eq!(row()["private_pages"], json!("none"));
    assert_eq!(row()["private_facts"], json!("granted_sources"));
}

#[test]
fn the_migration_read_finds_the_active_tokens_with_no_source_grant_oldest_first_without_the_hash() {
    let b = brain("tokens-lock-legacy");
    let late = insert(
        &b,
        token(
            "late",
            "h-late",
            json!({ "source_grant": null, "created_at": "2026-02-02T00:00:00Z" }),
        ),
    )
    .unwrap();
    let early = insert(
        &b,
        token(
            "early",
            "h-early",
            json!({ "source_grant": null, "created_at": "2026-01-01T00:00:00Z" }),
        ),
    )
    .unwrap();
    insert(&b, token("unified", "h-unified", json!({}))).unwrap();
    insert(
        &b,
        token(
            "gone",
            "h-gone",
            json!({ "source_grant": null, "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    let rows = b.lock_legacy_access_tokens().unwrap();
    let rows = rows.as_array().unwrap();
    let ids: Vec<Value> = rows.iter().map(|r| r["id"].clone()).collect();
    assert_eq!(
        ids,
        vec![json!(early), json!(late)],
        "oldest first, the unified and revoked tokens left out"
    );
    assert_eq!(rows[0]["name"], json!("early"));
    assert_eq!(rows[0]["source_grant"], Value::Null);
    assert_eq!(rows[0]["permissions"], json!({ "source_id": "wiki" }));
    assert!(rows[0].get("token_hash").is_none());
}

#[test]
fn the_scope_read_answers_a_live_tokens_stored_opt_out_and_creation_time_and_null_for_a_revoked_or_missing_token()
 {
    use gbrain_store::jobs::CredentialKind;
    let b = brain("tokens-scope");
    let live = insert(&b, token("live", "h1", json!({}))).unwrap();
    let gone = insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    let scope = b.read_live_access_token_scope(&live).unwrap();
    assert_eq!(
        scope["reads_unscoped"],
        Value::Null,
        "a minted token has not opted out"
    );
    let created = scope["created_at"].as_str().unwrap();
    assert!(created.ends_with('Z') && created.len() == 27, "{created}");
    b.write_credential_reads_unscoped(CredentialKind::Token, &live, true)
        .unwrap();
    let opted = b.read_live_access_token_scope(&live).unwrap();
    let stamp = opted["reads_unscoped"]
        .as_str()
        .expect("the stored opt-out time");
    assert!(stamp.ends_with('Z') && stamp.len() == 27, "{stamp}");
    b.write_credential_reads_unscoped(CredentialKind::Token, &live, false)
        .unwrap();
    assert_eq!(
        b.read_live_access_token_scope(&live).unwrap()["reads_unscoped"],
        Value::Null,
        "a cleared opt-out reads null again"
    );
    assert_eq!(b.read_live_access_token_scope(&gone).unwrap(), Value::Null);
    assert_eq!(
        b.read_live_access_token_scope("00000000-0000-4000-8000-000000000000")
            .unwrap(),
        Value::Null
    );
}
