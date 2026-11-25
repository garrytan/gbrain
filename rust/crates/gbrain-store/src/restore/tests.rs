//! Restore safety: what the census counts, what the quarantine changes, and that nothing else moves.

use super::*;
use crate::journal::WriterRegistration;
use crate::pages::{PageInput, PutPageOptions};
use crate::persistence::{PublicationEffectsSpec, TopologyChangeInsert, WriteRequestInsert};
use crate::sources::SourceInput;
use crate::test_support::store;
use std::collections::BTreeMap;

const RESTORE: &str = "restore-1";
const PURGE: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const KEYS: [&str; 2] = ["principal:local_cli:w", "brain"];

fn plan(sources: Value, settings: Value) -> QuarantinePlan {
    serde_json::from_value(
        json!({ "restore_id": RESTORE, "sources": sources, "settings": settings }),
    )
    .unwrap()
}

fn default_only() -> QuarantinePlan {
    plan(
        json!([{ "id": "default", "local_path": null, "rebased_path": null }]),
        json!([]),
    )
}

fn blocked(store: &Store, reason: &str) -> bool {
    store
        .restore_census(&[])
        .unwrap()
        .blockers
        .iter()
        .any(|b| b.reason == reason)
}

/// Every record of the store, by key.
fn dump(store: &Store) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let mut all = BTreeMap::new();
    store
        .read()
        .unwrap()
        .scan(&[1], &[0xFF; 64], false, &mut |k, v| {
            all.insert(k.to_vec(), v.to_vec());
            true
        })
        .unwrap();
    all
}

fn changed_tags(
    before: &BTreeMap<Vec<u8>, Vec<u8>>,
    after: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> BTreeSet<u8> {
    before
        .keys()
        .chain(after.keys())
        .filter(|k| before.get(*k) != after.get(*k))
        .map(|k| k[0])
        .collect()
}

fn admit_request(store: &Store, id: &str) -> String {
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "99999999-0000-4000-8000-000000000001", "requestId": id, "operation": "put_page",
        "sourceId": "default", "sourceIncarnation": incarnation, "pageId": null, "slug": "notes/a",
        "worktreeId": null, "topologyGeneration": null, "digest": "d", "intent": {}, "authority": {},
        "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v", "admitterHostId": null, "counterKeys": KEYS, "clientRequestId": null,
        "state": "queued", "deferredRefreshId": null,
    })).unwrap();
    store
        .lock_persistence_counters(&KEYS.map(String::from))
        .unwrap();
    store.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn job(store: &Store, status: &str) -> i64 {
    let spec = json!({ "insert": { "name": "work", "queue": "default", "status": status, "priority": 0,
        "data": { "keep": 1 }, "max_attempts": 3, "backoff_type": "fixed", "backoff_delay": 1000,
        "backoff_jitter": 0.0, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": { "version": 1, "kind": "application" } },
        "maxSpawnDepth": 5 });
    store
        .admit_job(&serde_json::from_value(spec).unwrap())
        .unwrap()
        .row["id"]
        .as_i64()
        .unwrap()
}

fn page(store: &Store, source: &str, slug: &str, origin: &str) {
    let input: PageInput = serde_json::from_value(
        json!({ "type": "note", "title": slug, "compiled_truth": "text", "source_path": origin }),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn source(store: &Store, id: &str, local_path: Option<&str>, config: Value) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "local_path": local_path, "config": config }))
            .unwrap();
    store.upsert_source(&input).unwrap();
}

#[test]
fn a_clean_brain_has_no_blocker_and_names_the_store_format_apart_from_any_archive() {
    let store = store();
    let census = store.restore_census(&[]).unwrap();
    assert!(
        census.blockers.is_empty() && census.unclassified.is_empty(),
        "{census:?}"
    );
    let identity = serde_json::to_value(&census.store).unwrap();
    assert_eq!(
        identity["engine_format_version"],
        store.info().format_version
    );
    assert!(identity.get("format_version").is_none());
    assert_eq!(identity["generation"], store.commit_version().unwrap());
    store.restore_quarantine(&default_only()).unwrap();
}

#[test]
fn every_kind_of_unfinished_work_refuses_by_name_and_the_refusal_changes_nothing() {
    let store = store();
    let id = admit_request(&store, "bbbbbbbb-0000-4000-8000-000000000001");
    assert!(
        blocked(&store, "pending_requests"),
        "a queued request with no effect still blocks"
    );
    assert_eq!(store.restore_census(&[]).unwrap().requests["queued"], 1);
    let (before, generation) = (dump(&store), store.commit_version().unwrap());
    let err = store.restore_quarantine(&default_only()).unwrap_err();
    assert_eq!(err.code, "restore_refused");
    assert_eq!(
        (dump(&store), store.commit_version().unwrap()),
        (before, generation),
        "a refusal commits nothing"
    );
    assert!(
        err.message.starts_with("pending_requests"),
        "{}",
        err.message
    );

    let stamp = crate::persistence::ClaimStamp {
        id: id.clone(),
        token: "ffffffff-0000-4000-8000-000000000001".into(),
        lease_ms: 60_000.0,
        phase_json: None,
    };
    store.stamp_write_claim(&stamp).unwrap();
    let census = store.restore_census(&[]).unwrap();
    assert_eq!((census.claims, census.requests["running"]), (1, 1));

    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let effects: PublicationEffectsSpec = serde_json::from_value(
        json!({ "requestId": id, "revision": "cccccccc-0000-4000-8000-000000000001",
        "sourceId": "default", "sourceIncarnation": incarnation, "worktreeId": null,
        "effects": [{ "kind": "embedding", "data": { "slug": "notes/a", "page_id": 1 } }] }),
    )
    .unwrap();
    store.insert_publication_effects(&effects).unwrap();
    assert_eq!(store.restore_census(&[]).unwrap().effects_live, 1);
    assert_eq!(
        store.restore_quarantine(&default_only()).unwrap_err().code,
        "restore_refused"
    );

    let fresh = crate::test_support::store();
    // A fresh store holds the config rows a brain starts with; a refusal adds none.
    let config_rows = |s: &Store| dump(s).keys().filter(|k| k[0] == keys::CONFIG).count();
    let config_before = config_rows(&fresh);
    let topology: TopologyChangeInsert = serde_json::from_value(
        json!({ "principalId": "99999999-0000-4000-8000-000000000001", "requestId": "dddddddd-0000-4000-8000-000000000001",
        "digest": "d", "operation": "archive", "sourceId": "default", "state": "recovering",
        "recovery": { "step": 1 }, "recoveryBytes": 10, "terminalBytes": 0 }),
    )
    .unwrap();
    fresh.insert_topology_change(&topology).unwrap();
    assert!(blocked(&fresh, "recovery_required"));
    assert_eq!(
        fresh.restore_quarantine(&default_only()).unwrap_err().code,
        "restore_refused"
    );
    assert_eq!(
        config_rows(&fresh),
        config_before,
        "no inventory row after a refusal"
    );
}

#[test]
fn a_purge_the_ledgers_lack_is_named_and_one_they_hold_is_not() {
    let store = store();
    store
        .insert_fact_purge(
            &serde_json::from_value(
                json!({ "sourceId": "default", "visibility": "world", "subject": "*",
        "factHash": "h", "requestId": PURGE }),
            )
            .unwrap(),
        )
        .unwrap();
    let absent = "aaaaaaaa-0000-4000-8000-000000000002";
    let census = store
        .restore_census(&[PURGE.to_uppercase(), absent.into()])
        .unwrap();
    assert_eq!(
        (census.purges_present, census.purges_missing),
        (vec![PURGE.to_string()], vec![absent.to_string()])
    );
    assert_eq!(
        census
            .blockers
            .iter()
            .map(|b| (b.reason, b.count))
            .collect::<Vec<_>>(),
        [("purge_replay", 1)]
    );
}

#[test]
fn a_record_of_a_kind_this_build_has_not_classified_fails_closed() {
    let store = store();
    store.write(|tx| tx.put(&[b'~', 1], b"x")).unwrap();
    store
        .write(|tx| tx.put(&[keys::JOBS, 0x2F, 1], b"token"))
        .unwrap();
    store
        .write(|tx| tx.put(&[keys::PERSISTENCE, 0x09], b"x"))
        .unwrap();
    let census = store.restore_census(&[]).unwrap();
    assert_eq!(
        census.unclassified,
        ["tag 0x7e", "jobs 0x2f", "persistence 0x09"]
    );
    assert_eq!(
        store
            .restore_quarantine(&default_only())
            .unwrap_err()
            .message,
        "unclassified_state: 3 (tag 0x7e, jobs 0x2f, persistence 0x09)"
    );
}

#[test]
fn the_known_lists_match_the_key_files() {
    let tags = |text: &str, pattern: &str| -> BTreeSet<u8> {
        let re = regex_lite(pattern);
        text.lines().filter_map(re).collect()
    };
    let keys_rs = include_str!("../keys.rs");
    let mut found = tags(keys_rs, "pub const ");
    found.retain(|b| *b >= 0x20); // the keyword kind bytes are numbers, not tags
    assert_eq!(
        found,
        KNOWN_TAGS.iter().copied().collect(),
        "classify a new key tag in restore.rs (authority needs a revoke step)"
    );
    let mut jobs = BTreeSet::new();
    for text in [
        include_str!("../jobs.rs"),
        include_str!("../jobs/oauth_clients.rs"),
        include_str!("../jobs/wake.rs"),
        include_str!("../jobs/spend.rs"),
        include_str!("../jobs/spend_log.rs"),
        include_str!("../jobs/subagent.rs"),
    ] {
        jobs.extend(tags(text, "const "));
    }
    jobs.retain(|b| *b < 0x80);
    let known: BTreeSet<u8> = JOBS_SUBTAGS.iter().copied().collect();
    assert!(
        jobs.is_subset(&known),
        "a jobs sub-tag this restore does not know: {:?}",
        jobs.difference(&known).collect::<Vec<_>>()
    );
}

/// `const NAME: u8 = b'x';` or `0xNN;` on one line: the byte, for the lines that declare one.
fn regex_lite(head: &str) -> impl Fn(&str) -> Option<u8> + '_ {
    move |line| {
        let rest = line
            .trim_start()
            .strip_prefix(head)
            .or_else(|| line.trim_start().strip_prefix("pub(crate) const "))?;
        let value = rest.split_once(": u8 = ")?.1.strip_suffix(';')?;
        match value.strip_prefix("b'") {
            Some(c) => c.strip_suffix('\'').and_then(|c| c.bytes().next()),
            None => u8::from_str_radix(value.strip_prefix("0x")?, 16).ok(),
        }
    }
}

#[test]
fn quarantine_detaches_rebases_disables_cancels_and_revokes_and_nothing_else_moves() {
    let store = store();
    // An archived source with a connector, a managed source with pages, a bare checkout, and a plain one.
    source(
        &store,
        "conn",
        Some("/old/conn"),
        json!({ "kind": "api", "remote_url": "https://x", "credential_cmd": "pass show x", "federated": true, "strategy": "s" }),
    );
    store.set_source_archived("conn", true).unwrap();
    source(
        &store,
        "managed",
        Some("/old/files/m"),
        json!({ "federated": false }),
    );
    source(
        &store,
        "checkout",
        Some("/home/me/repo"),
        json!({ "canonical": "git" }),
    );
    source(&store, "plain", None, json!({}));
    page(&store, "managed", "notes/a", "/old/files/m/a/b.md");
    page(&store, "managed", "notes/b", "/old/files/m/con.md");
    page(&store, "managed", "notes/c", "/elsewhere/c.md");
    page(&store, "plain", "notes/p", "/old/files/m/a/b.md");
    for (k, v) in [
        ("connectors.gmail.auto_sync", "true"),
        ("autopilot.dream.enabled", "true"),
        ("sync.repo_path", "/old/files/m/repo"),
        ("storage", "{}"),
        ("version", "319"),
        ("mine", "1"),
    ] {
        store.set_config(k, v).unwrap();
    }
    let jobs: Vec<i64> = [
        "waiting",
        "active",
        "delayed",
        "paused",
        "waiting-children",
        "completed",
        "failed",
    ]
    .iter()
    .map(|s| job(&store, s))
    .collect();
    for n in ["a", "b"] {
        store
            .register_local_writer(&WriterRegistration {
                id: format!(
                    "eeeeeeee-0000-4000-8000-00000000000{}",
                    if n == "a" { 1 } else { 2 }
                ),
                lane: "cli".into(),
                credential_hash: n.repeat(4),
                grant_ceiling: None,
            })
            .unwrap();
    }
    store
        .revoke_local_writer("eeeeeeee-0000-4000-8000-000000000002")
        .unwrap();
    // The revocation time the archive already held, read before the restore touches anything.
    let revoked_before = store
        .read_local_writer("eeeeeeee-0000-4000-8000-000000000002")
        .unwrap()
        .unwrap()["revoked_at"]
        .clone();
    assert!(!revoked_before.is_null());
    store
        .insert_oauth_client(
            &serde_json::from_value(
                json!({ "client_id": "c1", "client_name": "one", "scope": "read" }),
            )
            .unwrap(),
        )
        .unwrap();
    store.insert_oauth_client(&serde_json::from_value(json!({ "client_id": "c2", "client_name": "two", "deleted_at": "2026-01-01T00:00:00.000000Z" })).unwrap()).unwrap();

    let census = store.restore_census(&[]).unwrap();
    assert!(census.blockers.is_empty(), "{:?}", census.blockers);
    assert_eq!(census.jobs_live, 5);
    assert_eq!(census.authority.local_writers.len(), 1);
    assert_eq!(census.authority.oauth_clients, ["c1"]);
    let conn = census.sources.iter().find(|s| s.id == "conn").unwrap();
    assert_eq!(
        (
            conn.archived,
            conn.kind.as_deref(),
            conn.remote_url.as_deref()
        ),
        (true, Some("api"), Some("https://x"))
    );
    assert_eq!(
        census
            .settings
            .iter()
            .map(|s| s.key.as_str())
            .collect::<Vec<_>>(),
        [
            "autopilot.dream.enabled",
            "connectors.gmail.auto_sync",
            "storage",
            "sync.repo_path"
        ]
    );

    let p = plan(
        json!([
            { "id": "checkout", "local_path": "/home/me/repo", "rebased_path": null },
            { "id": "conn", "local_path": "/old/conn", "rebased_path": null },
            { "id": "default", "local_path": null, "rebased_path": null },
            { "id": "managed", "local_path": "/old/files/m", "rebased_path": "/new/root/files/m" },
            { "id": "plain", "local_path": null, "rebased_path": null },
        ]),
        json!([
            { "key": "connectors.gmail.auto_sync", "value": "false" }, { "key": "autopilot.dream.enabled", "value": "false" },
            { "key": "sync.repo_path", "value": "/new/root/files/m/repo" }, { "key": "storage", "value": null },
        ]),
    );
    let (before, generation) = (dump(&store), store.commit_version().unwrap());
    let report = store.restore_quarantine(&p).unwrap();
    assert_eq!(
        store.commit_version().unwrap(),
        generation + 1,
        "one commit"
    );
    let after = dump(&store);
    assert_eq!(report.detached_sources, ["checkout", "conn"]);
    assert_eq!(report.rebased_sources, ["managed"]);
    assert_eq!(report.rebased_origins, 1);
    assert_eq!(report.changed_settings.len(), 4);
    assert_eq!(report.jobs_cancelled, 5);
    assert_eq!(
        (
            report.revoked.local_writers.len(),
            report.revoked.oauth_clients.clone()
        ),
        (1, vec!["c1".to_string()])
    );
    assert!(
        report
            .reconnect
            .iter()
            .any(|l| l.contains("2 legacy absolute page origins"))
    );
    assert!(
        report
            .reconnect
            .iter()
            .any(|l| l.contains("gbrain auth register-client"))
    );

    let conn = store.get_source_by_id("conn").unwrap().unwrap();
    assert_eq!(conn.local_path, None);
    assert_eq!(
        serde_json::to_value(&conn.config).unwrap(),
        json!({ "federated": true, "strategy": "s", "syncEnabled": false, "restore_detached": RESTORE })
    );
    assert_eq!(
        store
            .get_source_by_id("checkout")
            .unwrap()
            .unwrap()
            .local_path,
        None
    );
    assert_eq!(
        store
            .get_source_by_id("managed")
            .unwrap()
            .unwrap()
            .local_path
            .as_deref(),
        Some("/new/root/files/m")
    );
    assert!(
        store
            .list_all_sources(&Default::default())
            .unwrap()
            .iter()
            .all(|s| s.id != "conn"),
        "still archived"
    );
    for (slug, origin) in [
        ("notes/a", "/new/root/files/m/a/b.md"),
        ("notes/b", "/old/files/m/con.md"),
        ("notes/c", "/elsewhere/c.md"),
    ] {
        assert_eq!(
            crate::pages::read_page(&*store.read().unwrap(), "managed", slug)
                .unwrap()
                .unwrap()
                .source_path
                .as_deref(),
            Some(origin)
        );
    }
    let at = |source: &str, origin: &str| {
        keys::page_origin(
            source,
            origin,
            crate::pages::read_page(
                &*store.read().unwrap(),
                source,
                if source == "plain" {
                    "notes/p"
                } else {
                    "notes/a"
                },
            )
            .unwrap()
            .unwrap()
            .id,
        )
    };
    assert!(
        after.contains_key(&at("managed", "/new/root/files/m/a/b.md"))
            && !after.contains_key(&at("managed", "/old/files/m/a/b.md"))
    );
    assert!(
        after.contains_key(&at("plain", "/old/files/m/a/b.md")),
        "another source's origins are untouched"
    );

    for (k, v) in [
        ("connectors.gmail.auto_sync", Some("false")),
        ("autopilot.dream.enabled", Some("false")),
        ("sync.repo_path", Some("/new/root/files/m/repo")),
        ("storage", None),
        ("version", Some("319")),
        ("mine", Some("1")),
    ] {
        assert_eq!(store.get_config(k).unwrap().as_deref(), v, "{k}");
    }
    let inventory: Value =
        serde_json::from_str(&store.get_config(&report.inventory_key).unwrap().unwrap()).unwrap();
    assert_eq!(inventory["settings"].as_array().unwrap().len(), 4);
    assert_eq!(
        inventory["sources"][1]["config"]["credential_cmd"],
        "pass show x"
    );
    for (id, status) in jobs.iter().zip([
        "waiting",
        "active",
        "delayed",
        "paused",
        "waiting-children",
        "completed",
        "failed",
    ]) {
        let row = store.get_job(*id).unwrap().unwrap();
        let live = !matches!(status, "completed" | "failed");
        assert_eq!(
            row["status"],
            if live { "cancelled" } else { status },
            "{status}"
        );
        assert_eq!(
            row["data"]
                .get("__restore_previous_status")
                .and_then(Value::as_str),
            live.then_some(status)
        );
        assert_eq!(row["data"]["keep"], 1);
    }
    let writers = |id: &str| store.read_local_writer(id).unwrap().unwrap();
    let first = writers("eeeeeeee-0000-4000-8000-000000000001");
    assert!(!first["revoked_at"].is_null());
    assert_eq!(
        writers("eeeeeeee-0000-4000-8000-000000000002")["revoked_at"],
        revoked_before,
        "an earlier revocation keeps its first time"
    );
    assert_eq!(
        changed_tags(&before, &after),
        BTreeSet::from([
            keys::SOURCE,
            keys::CONFIG,
            keys::PAGE,
            keys::PAGE_ORIGIN,
            keys::JOBS,
            keys::WRITER,
            keys::META
        ])
    );
    let meta: Vec<_> = after
        .keys()
        .filter(|k| k[0] == keys::META && before.get(*k) != after.get(*k))
        .collect();
    assert_eq!(
        meta,
        [&keys::meta("format")],
        "only the format record changes under meta (the brain id)"
    );
    let (c1, c2) = (
        store.restore_census(&[]).unwrap(),
        serde_json::to_value(store.restore_census(&[]).unwrap().authority).unwrap(),
    );
    assert!(
        c1.authority.local_writers.is_empty() && c2["oauth_clients"] == json!([]),
        "nothing active is left"
    );
    assert_eq!(
        store.restore_quarantine(&p).unwrap_err().code,
        "invalid_state",
        "one restore id applies once"
    );
    assert_eq!(dump(&store), after);
}

/// Rewrites fields of a stored write request (a request in a state only a crash or a long run leaves).
fn patch_request(store: &Store, id: &str, patch: Value) {
    store
        .write(|tx| {
            let key = keys::request(id);
            let mut row: Value = crate::get_json(&*tx, &key)?.expect("the request exists");
            for (field, value) in patch.as_object().unwrap() {
                row[field] = value.clone();
            }
            crate::put_json(tx, &key, &row)
        })
        .unwrap();
}

/// A stored request's state and fields, and the blockers (reason, count) a census must name for it.
type Case<'a> = (&'a str, Value, &'a [(&'a str, u64)]);

#[test]
fn work_that_can_resume_blocks_a_restore_whatever_else_is_or_is_not_pending() {
    let cases: [Case; 5] = [
        (
            "deferred",
            json!({ "state": "deferred" }),
            &[("pending_requests", 1)],
        ),
        (
            "recovering",
            json!({ "state": "recovering" }),
            &[("recovery_required", 2)],
        ),
        (
            "finished with recovery data",
            json!({ "state": "committed", "recovery": { "step": 1 } }),
            &[("recovery_required", 1)],
        ),
        (
            "finished with recovery bytes",
            json!({ "state": "committed", "recovery_bytes": 10 }),
            &[("recovery_required", 1)],
        ),
        (
            "running, publication started, no recovery data",
            json!({ "state": "running", "publication_started": true }),
            &[("pending_requests", 1), ("recovery_required", 1)],
        ),
    ];
    for (label, patch, expected) in cases {
        let store = store();
        let id = admit_request(&store, "bbbbbbbb-0000-4000-8000-000000000003");
        patch_request(&store, &id, patch);
        let census = store.restore_census(&[]).unwrap();
        let blockers: Vec<_> = census
            .blockers
            .iter()
            .map(|b| (b.reason, b.count))
            .collect();
        assert_eq!(blockers, expected, "{label}");
        let (before, generation) = (dump(&store), store.commit_version().unwrap());
        assert_eq!(
            store.restore_quarantine(&default_only()).unwrap_err().code,
            "restore_refused",
            "{label}"
        );
        assert_eq!(
            (dump(&store), store.commit_version().unwrap()),
            (before, generation),
            "{label}"
        );
    }
    // A live effect blocks on its own, once its request has finished and nothing else is pending.
    let store = store();
    let id = admit_request(&store, "bbbbbbbb-0000-4000-8000-000000000004");
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let effects: PublicationEffectsSpec = serde_json::from_value(
        json!({ "requestId": id, "revision": "cccccccc-0000-4000-8000-000000000002",
        "sourceId": "default", "sourceIncarnation": incarnation, "worktreeId": null,
        "effects": [{ "kind": "embedding", "data": { "slug": "notes/a", "page_id": 1 } }] }),
    )
    .unwrap();
    store.insert_publication_effects(&effects).unwrap();
    patch_request(&store, &id, json!({ "state": "committed" }));
    let census = store.restore_census(&[]).unwrap();
    assert_eq!(
        census.requests.values().sum::<u64>(),
        0,
        "no request is pending"
    );
    assert_eq!(census.effects_live, 1);
    assert!(blocked(&store, "pending_requests"));
    assert_eq!(
        store.restore_quarantine(&default_only()).unwrap_err().code,
        "restore_refused"
    );
}

#[test]
fn a_plan_that_does_not_match_the_store_changes_nothing() {
    let store = store();
    source(&store, "managed", Some("/old/m"), json!({}));
    store.set_config("version", "319").unwrap();
    let before = dump(&store);
    let wrong_path = plan(
        json!([{ "id": "default", "local_path": null, "rebased_path": null }, { "id": "managed", "local_path": "/other", "rebased_path": null }]),
        json!([]),
    );
    let missing = plan(
        json!([{ "id": "default", "local_path": null, "rebased_path": null }]),
        json!([]),
    );
    let off_list = plan(
        json!([{ "id": "default", "local_path": null, "rebased_path": null }, { "id": "managed", "local_path": "/old/m", "rebased_path": null }]),
        json!([{ "key": "version", "value": "1" }]),
    );
    let not_off = plan(
        json!([{ "id": "default", "local_path": null, "rebased_path": null }, { "id": "managed", "local_path": "/old/m", "rebased_path": null }]),
        json!([{ "key": "autopilot.x.enabled", "value": "true" }]),
    );
    for bad in [wrong_path, missing, off_list, not_off] {
        assert_eq!(
            store.restore_quarantine(&bad).unwrap_err().code,
            "invalid_argument"
        );
        assert_eq!(dump(&store), before);
    }
}

#[test]
fn origins_move_one_to_one_and_unsafe_ones_stay() {
    let to = "/new/root/files";
    assert_eq!(
        rebase_origin("/old/files/a/b.md", "/old/files", to).as_deref(),
        Some("/new/root/files/a/b.md")
    );
    assert_eq!(
        rebase_origin("/old/files/a/b.md", "/old/files/", to).as_deref(),
        Some("/new/root/files/a/b.md")
    );
    for kept in [
        "/old/files",
        "/old/filesx/a.md",
        "/elsewhere/a.md",
        "/old/files/a/../b.md",
        "/old/files//a.md",
        "/old/files/a/con.txt",
        "/old/files/a/b.",
        "/old/files/a\\b.md",
    ] {
        assert_eq!(rebase_origin(kept, "/old/files", to), None, "{kept}");
    }
}

#[test]
fn only_automation_and_path_rows_are_settings() {
    assert_eq!(setting_kind("connectors.gmail.auto_sync"), Some("disable"));
    assert_eq!(setting_kind("autopilot.dream.enabled"), Some("disable"));
    assert_eq!(setting_kind("sync.repo_path"), Some("path"));
    assert_eq!(setting_kind("storage"), Some("delete"));
    for other in [
        "connectors.a.b.auto_sync",
        "connectors..auto_sync",
        "autopilot..enabled",
        "version",
        "storage.x",
    ] {
        assert_eq!(setting_kind(other), None, "{other}");
    }
}

/// `jobs 0x2B` is the `access_tokens` table of `rust-engine/main` (`jobs/access_tokens.rs`, absent from
/// this base): `m 0x2B <token id> -> TokenRecord`. A restore does not revoke it here, so it must refuse and say what it is.
#[test]
fn archived_access_tokens_are_refused_by_name_and_never_counted_as_nothing() {
    let store = store();
    let token = [
        &[keys::JOBS, 0x2B][..],
        b"11111111-0000-4000-8000-000000000001",
    ]
    .concat();
    store
        .write(|tx| tx.put(&token, br#"{"name":"claude","revoked_at":null}"#))
        .unwrap();
    let census = store.restore_census(&[]).unwrap();
    assert_eq!(census.unclassified, ["access tokens (jobs 0x2b)"]);
    assert_eq!(
        serde_json::to_value(&census.blockers).unwrap(),
        json!([{ "reason": "unclassified_state", "count": 1, "detail": "access tokens (jobs 0x2b)" }])
    );
    let before = dump(&store);
    let err = store.restore_quarantine(&default_only()).unwrap_err();
    assert_eq!(err.code, "restore_refused");
    assert_eq!(
        err.message,
        "unclassified_state: 1 (access tokens (jobs 0x2b))"
    );
    assert_eq!(
        dump(&store),
        before,
        "the token row is left exactly as archived"
    );
}

/// A brain on a real directory (`FORMAT` and `records.redb`), reopened by path.
fn on_disk(name: &str) -> (Store, std::path::PathBuf) {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp")
        .join(format!("restore-{name}-{}", std::process::id()))
        .join("brain");
    let _ = std::fs::remove_dir_all(&dir);
    (Store::open_dir(&dir, Default::default()).unwrap(), dir)
}

/// The code an open refused with.
fn open_err(opened: Result<Store>) -> &'static str {
    opened.err().expect("the open is refused").code
}

fn format_file(dir: &std::path::Path) -> crate::FormatRecord {
    format::read(dir).unwrap().unwrap()
}

#[test]
fn a_restore_gives_the_store_a_fresh_brain_id_that_open_accepts() {
    let (store, dir) = on_disk("rotate");
    let old = store.brain_id().to_string();
    let report = store.restore_quarantine(&default_only()).unwrap();
    assert_eq!(report.previous_brain_id, old);
    assert_ne!(report.brain_id, old);
    assert!(
        report
            .reconnect
            .iter()
            .any(|l| l.contains(&report.brain_id) && l.contains(&old))
    );
    assert_eq!(
        format_file(&dir).brain_id,
        report.brain_id,
        "FORMAT follows the commit"
    );
    // The still-open handle reports the fresh id too, not the one the restore replaced.
    assert_eq!(store.brain_id(), report.brain_id);
    assert_eq!(store.info().brain_id, report.brain_id);
    assert_eq!(
        store.get_brain_identity().unwrap()["brain_id"],
        report.brain_id
    );
    assert_eq!(
        store.restore_census(&[]).unwrap().store.brain_id,
        report.brain_id
    );
    store.close();
    let reopened = Store::open_dir(&dir, Default::default()).unwrap();
    assert_eq!(reopened.brain_id(), report.brain_id);
    assert_eq!(
        reopened.restore_census(&[]).unwrap().store.brain_id,
        report.brain_id
    );
    reopened.close();
    Store::open_dir_read_only(&dir).unwrap().close();
}

#[test]
fn a_crash_between_the_record_and_format_leaves_a_pair_open_repairs() {
    let (store, dir) = on_disk("crash");
    let old_format = format_file(&dir);
    let report = store.restore_quarantine(&default_only()).unwrap();
    assert_ne!(
        report.brain_id, old_format.brain_id,
        "the pair is a real rotation"
    );
    store.close();
    // The record committed with the new id; the process died before FORMAT was renamed.
    format::write(&dir, &old_format).unwrap();
    let stale = std::fs::read(dir.join(format::FORMAT_FILE)).unwrap();
    // A read-only open accepts the pair and writes nothing.
    assert_eq!(
        Store::open_dir_read_only(&dir).unwrap().brain_id(),
        report.brain_id
    );
    assert_eq!(std::fs::read(dir.join(format::FORMAT_FILE)).unwrap(), stale);
    // A normal open rebuilds FORMAT from the record.
    assert_eq!(
        Store::open_dir(&dir, Default::default())
            .unwrap()
            .brain_id(),
        report.brain_id
    );
    assert_eq!(format_file(&dir).brain_id, report.brain_id);
}

#[test]
fn a_format_that_names_some_other_brain_is_still_refused() {
    let (store, dir) = on_disk("other");
    let mut other = format_file(&dir);
    other.brain_id = "00000000-0000-4000-8000-000000000001".into();
    store.close();
    format::write(&dir, &other).unwrap();
    assert_eq!(
        open_err(Store::open_dir(&dir, Default::default())),
        "store_corrupt"
    );
    // A rotated brain refuses a FORMAT that names neither its id nor the one it rotated from.
    let (store, dir) = on_disk("other-rotated");
    store.restore_quarantine(&default_only()).unwrap();
    store.close();
    format::write(&dir, &other).unwrap();
    assert_eq!(
        open_err(Store::open_dir(&dir, Default::default())),
        "store_corrupt"
    );
    assert_eq!(open_err(Store::open_dir_read_only(&dir)), "store_corrupt");
}

#[test]
fn a_refused_or_failed_restore_keeps_the_brain_id() {
    let (store, dir) = on_disk("keep");
    let (old, format_before) = (store.brain_id().to_string(), format_file(&dir));
    let wrong = plan(
        json!([{ "id": "default", "local_path": "/nope", "rebased_path": null }]),
        json!([]),
    );
    assert_eq!(
        store.restore_quarantine(&wrong).unwrap_err().code,
        "invalid_argument"
    );
    admit_request(&store, "bbbbbbbb-0000-4000-8000-000000000002");
    assert_eq!(
        store.restore_quarantine(&default_only()).unwrap_err().code,
        "restore_refused"
    );
    store.close();
    assert_eq!(format_file(&dir), format_before);
    assert_eq!(
        Store::open_dir(&dir, Default::default())
            .unwrap()
            .brain_id(),
        old
    );
}

#[test]
fn a_restore_inside_an_open_transaction_is_refused_and_leaves_the_brain_id_pair_intact() {
    let (store, dir) = on_disk("bound");
    let (old, format_before) = (store.brain_id(), format_file(&dir));
    let tx = store.begin_transaction(false).unwrap();
    assert_eq!(
        tx.restore_quarantine(&default_only()).unwrap_err().code,
        "invalid_state"
    );
    assert_eq!(
        (tx.brain_id(), store.brain_id()),
        (old.clone(), old.clone())
    );
    tx.rollback_transaction().unwrap();
    drop(tx);
    store.close();
    assert_eq!(format_file(&dir), format_before);
    let reopened = Store::open_dir(&dir, Default::default()).unwrap();
    assert_eq!(
        reopened.brain_id(),
        old,
        "the brain still opens, with its own id"
    );
}

#[test]
fn rebased_origins_that_would_collide_refuse_the_restore_and_change_nothing() {
    let managed = |origin_b: &str| {
        let store = store();
        source(&store, "managed", Some("/old/m"), json!({}));
        page(&store, "managed", "notes/a", "/old/m/a.md");
        page(&store, "managed", "notes/b", origin_b);
        store
    };
    let moved = || {
        plan(
            json!([{ "id": "default", "local_path": null, "rebased_path": null },
                   { "id": "managed", "local_path": "/old/m", "rebased_path": "/new/m" }]),
            json!([]),
        )
    };
    // B already sits where A would land: two live pages on /new/m/a.md.
    let store = managed("/new/m/a.md");
    let (before, generation, id) = (
        dump(&store),
        store.commit_version().unwrap(),
        store.brain_id(),
    );
    assert_eq!(
        store.restore_quarantine(&moved()).unwrap_err().code,
        "origin_claimed"
    );
    assert_eq!(
        (
            dump(&store),
            store.commit_version().unwrap(),
            store.brain_id()
        ),
        (before, generation, id)
    );
    // The same restore with no collision goes through.
    let report = managed("/new/m/b.md").restore_quarantine(&moved()).unwrap();
    assert_eq!(report.rebased_origins, 1);
}

#[test]
fn a_settings_plan_that_does_not_cover_the_store_refuses_and_changes_nothing() {
    let held = [
        ("autopilot.x.enabled", "true"),
        ("connectors.slack.auto_sync", "true"),
        ("sync.repo_path", "/old/repo"),
    ];
    let change = |key: &str| {
        let value = if key == "sync.repo_path" {
            json!("/new/repo")
        } else {
            json!("false")
        };
        json!({ "key": key, "value": value })
    };
    let with = |keys: &[&str]| {
        plan(
            json!([{ "id": "default", "local_path": null, "rebased_path": null }]),
            Value::Array(keys.iter().map(|k| change(k)).collect()),
        )
    };
    let all: Vec<&str> = held.iter().map(|(k, _)| *k).collect();
    let fresh = || {
        let store = store();
        for (k, v) in held {
            store.set_config(k, v).unwrap();
        }
        store
    };
    let late = fresh();
    late.set_config("autopilot.late.enabled", "true").unwrap();
    // The plan was made for `held` only; a key that appeared since is not covered.
    let cases = [
        ("one setting missing", fresh(), with(&all[..2])),
        ("every setting missing", fresh(), with(&[])),
        (
            "a setting listed twice",
            fresh(),
            with(&[all[0], all[0], all[1], all[2]]),
        ),
        ("a key added after the census", late, with(&all)),
    ];
    for (label, store, plan) in cases {
        let (before, generation, id) = (
            dump(&store),
            store.commit_version().unwrap(),
            store.brain_id(),
        );
        assert_eq!(
            store.restore_quarantine(&plan).unwrap_err().code,
            "invalid_argument",
            "{label}"
        );
        assert_eq!(
            (
                dump(&store),
                store.commit_version().unwrap(),
                store.brain_id()
            ),
            (before, generation, id),
            "{label}"
        );
        assert_eq!(
            store.get_config("autopilot.x.enabled").unwrap().as_deref(),
            Some("true"),
            "{label}"
        );
    }
    let store = fresh();
    store.restore_quarantine(&with(&all)).unwrap();
    assert_eq!(
        store.get_config("autopilot.x.enabled").unwrap().as_deref(),
        Some("false")
    );
}

#[test]
fn a_windows_origin_the_restore_cannot_rebase_is_named_in_the_report() {
    let store = store();
    source(&store, "managed", Some("C:\\old\\files"), json!({}));
    page(&store, "managed", "notes/a", "C:\\old\\files\\a.md");
    page(&store, "managed", "notes/u", "\\\\host\\share\\u.md");
    let report = store
        .restore_quarantine(&plan(
            json!([{ "id": "default", "local_path": null, "rebased_path": null },
                   { "id": "managed", "local_path": "C:\\old\\files", "rebased_path": "/new/files" }]),
            json!([]),
        ))
        .unwrap();
    assert_eq!(report.rebased_origins, 0);
    assert!(
        report
            .reconnect
            .iter()
            .any(|l| l.contains("2 legacy absolute page origins were preserved")),
        "{:?}",
        report.reconnect
    );
}
