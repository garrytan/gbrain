//! The reads of `get_write_attribution` (src/core/ops/attribution.ts; SQL in
//! src/core/engine-sql/write-attribution.ts): the write receipts a page, its versions, facts,
//! takes and timeline entries carry, and the request and local-writer rows that name them. Each
//! read answers the statement PGLite runs, filter before pick. The store keeps no `oauth_clients`
//! or `access_tokens` table, so the TypeScript member refuses those two name reads instead of
//! answering empty. What each read answers: rust/docs/store/write_attribution.md.

use crate::env::iso;
use crate::error::StoreError;
use crate::facts::{OwnerOnlyCache, PrivacyPolicy, hidden_by_policy, read_fact};
use crate::journal::{RequestRecord, read_writer_record};
use crate::kv::{KvRead, scan_prefix};
use crate::owner_only::{OwnerOnlyForm, OwnerOnlySources};
use crate::pages::{VersionRecord, read_page_by_id};
use crate::persistence::uuid_param;
use crate::takes::take_at;
use crate::timeline::TimelineRecord;
use crate::write_receipt::WriteReceipt;
use crate::{Result, Store, get_json, keys};
use serde::Deserialize;
use serde_json::{Value, json};

/// `authority->>'agentLabel'`: text as is, null when missing or JSON null, JSON text otherwise.
fn json_text(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(other) => Value::String(other.to_string()),
    }
}

fn opt_iso(us: Option<i64>) -> Value {
    us.map_or(Value::Null, |us| Value::String(iso(us)))
}

/// A stored `trust_tier`: none reads `unknown`. Pages, facts, takes and timeline entries carry
/// `NOT NULL DEFAULT 'unknown'`; a version snapshot copies the page's tier, and the store keeps
/// an `unknown` snapshot as none.
fn row_tier(t: Option<&str>) -> Value {
    match t {
        Some(t) if !t.is_empty() => Value::String(t.to_string()),
        _ => Value::String("unknown".into()),
    }
}

/// The row-attribution columns of `rowTarget` (`cols`), for a row with `receipt`.
fn row_json(
    id: u64,
    receipt: &WriteReceipt,
    created_at_us: i64,
    trust_tier: Value,
    write_origin: Option<&Value>,
) -> Value {
    json!({
        "id": id,
        "w_req": receipt.write_request_id,
        "w_kind": receipt.write_principal_kind,
        "w_id": receipt.write_principal_id,
        "created_at": iso(created_at_us),
        "l_req": receipt.last_write_request_id,
        "l_kind": receipt.last_write_principal_kind,
        "l_id": receipt.last_write_principal_id,
        "last_written_at": opt_iso(receipt.last_written_at_us),
        "trust_tier": trust_tier,
        "write_origin": write_origin.cloned().unwrap_or(Value::Null),
    })
}

/// The row `readRowAttribution` picks: a fact, a take or a timeline entry of a page.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowAttributionTarget {
    /// `facts WHERE id AND source_id AND (entity_slug = slug OR source_markdown_slug = slug)`,
    /// then `visibility = 'world'` under `worldOnly` and the private-provenance policy.
    #[serde(rename_all = "camelCase")]
    Fact {
        id: u64,
        source_id: String,
        slug: String,
        #[serde(default)]
        world_only: bool,
        #[serde(default)]
        exclude_private: Option<PrivacyPolicy>,
    },
    /// `takes WHERE page_id AND row_num`, then `holder = ANY(holders)` when holders are given, then
    /// the take's own owner-only test (`ownerOnlyTakeAllowedSql`) in `owner_only`'s form.
    #[serde(rename_all = "camelCase")]
    Take {
        page_id: u64,
        row_num: i32,
        #[serde(default)]
        holders: Option<Vec<String>>,
        #[serde(default)]
        owner_only: OwnerOnlyForm,
    },
    /// `timeline_entries WHERE id AND page_id`, then the entry's own owner-only test
    /// (`ownerOnlyTimelineAllowedSql`) in `owner_only`'s form.
    #[serde(rename_all = "camelCase")]
    Timeline {
        id: u64,
        page_id: u64,
        #[serde(default)]
        owner_only: OwnerOnlyForm,
    },
}

/// A take's or timeline entry's own owner-only test for a caller who is not the owner. The
/// closed form hides every row while the brain holds an owner-only source or a mark. The
/// function form reads the row's own lineage behind its guard: marked, or derived (by its
/// recorded inputs, `derivation_inputs.rs`) from an owner-only row. The row's page is tested
/// apart, as in SQL. A target that names no form takes `closed`.
fn row_owner_only_hidden(
    read: &dyn KvRead,
    form: OwnerOnlyForm,
    table: &str,
    id: u64,
) -> Result<bool> {
    match form {
        OwnerOnlyForm::Off => Ok(false),
        OwnerOnlyForm::Closed => Ok(OwnerOnlySources::read(read)?.guarded()),
        OwnerOnlyForm::Fn => {
            let sources = OwnerOnlySources::read(read)?;
            Ok(sources.guarded() && sources.row_lineage(read, table, id, None)?)
        }
    }
}

fn version_row(v: &VersionRecord) -> Value {
    json!({
        "id": v.id,
        "w_req": v.receipt.written.request_id,
        "w_kind": v.receipt.written.principal_kind,
        "w_id": v.receipt.written.principal_id,
        "a_req": v.receipt.archived.request_id,
        "a_kind": v.receipt.archived.principal_kind,
        "a_id": v.receipt.archived.principal_id,
        "trust_tier": row_tier(v.trust_tier.as_deref()),
    })
}

fn page_versions(read: &dyn KvRead, page_id: u64) -> Result<Vec<VersionRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::version_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<VersionRecord>(v) {
            Ok(row) => out.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

fn timeline_entry(read: &dyn KvRead, page_id: u64, id: u64) -> Result<Option<TimelineRecord>> {
    let mut found = None;
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(row) if row.id == id => found = Some(row),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        found.is_none() && failure.is_none()
    })?;
    failure.map_or(Ok(found), Err)
}

impl Store {
    /// `persistence_requests WHERE id = ANY(ids::uuid[])`: `{id, operation, completed_at,
    /// agent_label}` per stored request. A non-UUID id refuses, as the cast does.
    pub fn read_write_request_attributions(&self, ids: &[String]) -> Result<Vec<Value>> {
        let ids = ids
            .iter()
            .map(|id| uuid_param(id, "write request id"))
            .collect::<Result<Vec<_>>>()?;
        let read = self.read()?;
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(r) = get_json::<RequestRecord>(&*read, &keys::request(&id))? {
                out.push(json!({
                    "id": r.id,
                    "operation": r.operation,
                    "completed_at": opt_iso(r.completed_at_us),
                    "agent_label": json_text(r.authority.get("agentLabel")),
                }));
            }
        }
        Ok(out)
    }

    /// `persistence_local_writers WHERE id::text = ANY(ids)`: `{id, lane}` per registration, a
    /// revoked one included (the read ignores `revoked_at`).
    pub fn read_local_writer_lanes(&self, ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for id in ids {
            if id.contains('\0') || !seen.insert(id.as_str()) {
                continue;
            }
            if let Some((stored, lane)) = read_writer_record(&*read, id)?
                && stored == *id
            {
                out.push(json!({ "id": stored, "lane": lane }));
            }
        }
        Ok(out)
    }

    /// `pages WHERE id = page_id`: the live revision and its write receipt, tier and origin.
    pub fn read_page_revision_attribution(&self, page_id: u64) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?.map(|p| {
            json!({
                "revision": p.knowledge_revision,
                "req": p.revision_receipt.request_id,
                "kind": p.revision_receipt.principal_kind,
                "pid": p.revision_receipt.principal_id,
                "trust_tier": row_tier(p.trust_tier.as_deref()),
                "write_origin": p.write_origin.clone().unwrap_or(Value::Null),
            })
        }))
    }

    /// `page_versions WHERE id = ANY(ids)`, each version named with its page: the writer, the
    /// archiving writer and the tier of the snapshot.
    pub fn read_version_attributions(&self, versions: &[(u64, u64)]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for &(page_id, id) in versions {
            if !seen.insert(id) {
                continue;
            }
            if let Some(v) = get_json::<VersionRecord>(&*read, &keys::version(page_id, id))? {
                out.push(version_row(&v));
            }
        }
        Ok(out)
    }

    /// The oldest snapshot of a page (`ORDER BY snapshot_at, id LIMIT 1`): `{req, kind, pid}`.
    pub fn read_oldest_version_attribution(&self, page_id: u64) -> Result<Option<Value>> {
        let read = self.read()?;
        let oldest = page_versions(&*read, page_id)?
            .into_iter()
            .min_by_key(|v| (v.snapshot_at_us, v.id));
        Ok(oldest.map(|v| v.receipt.written.to_json()))
    }

    /// The row `target` names, filtered before the pick, with its write receipts, tier and origin.
    pub fn read_row_attribution(&self, target: &RowAttributionTarget) -> Result<Option<Value>> {
        let read = self.read()?;
        match target {
            RowAttributionTarget::Fact {
                id,
                source_id,
                slug,
                world_only,
                exclude_private,
            } => {
                let Some(f) = read_fact(&*read, *id)? else {
                    return Ok(None);
                };
                let slug_match = f.entity_slug.as_deref() == Some(slug.as_str())
                    || f.source_markdown_slug.as_deref() == Some(slug.as_str());
                if f.source_id != *source_id
                    || !slug_match
                    || (*world_only && f.visibility != "world")
                    || hidden_by_policy(
                        &*read,
                        &f,
                        exclude_private,
                        &mut OwnerOnlyCache::default(),
                    )?
                {
                    return Ok(None);
                }
                Ok(Some(row_json(
                    f.id,
                    &f.receipt,
                    f.created_at_us,
                    row_tier(Some(&f.trust_tier)),
                    f.write_origin.as_ref(),
                )))
            }
            RowAttributionTarget::Take {
                page_id,
                row_num,
                holders,
                owner_only,
            } => {
                let Some(t) = take_at(&*read, *page_id, *row_num)? else {
                    return Ok(None);
                };
                if holders.as_ref().is_some_and(|h| !h.contains(&t.holder))
                    || row_owner_only_hidden(&*read, *owner_only, "takes", t.id)?
                {
                    return Ok(None);
                }
                // The take's stored trust_tier and write_origin, as `store_take` stamped them.
                Ok(Some(row_json(
                    t.id,
                    &t.receipt,
                    t.created_at_us,
                    row_tier(t.trust.trust_tier.as_deref()),
                    t.trust.write_origin.as_ref(),
                )))
            }
            RowAttributionTarget::Timeline {
                id,
                page_id,
                owner_only,
            } => {
                let Some(e) = timeline_entry(&*read, *page_id, *id)? else {
                    return Ok(None);
                };
                if row_owner_only_hidden(&*read, *owner_only, "timeline_entries", e.id)? {
                    return Ok(None);
                }
                Ok(Some(row_json(
                    e.id,
                    &e.receipt,
                    e.created_at_us,
                    row_tier(e.trust.trust_tier.as_deref()),
                    e.trust.write_origin.as_ref(),
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::InsertFactArgs;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::takes::TakeInput;
    use crate::test_support::store;
    use crate::write_trust::{WRITE_PRINCIPAL_ID, WRITE_PRINCIPAL_KIND, WRITE_REQUEST};

    const R1: &str = "0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
    const R2: &str = "0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e02";

    /// Opens the write context of request `req` by the local writer `who`.
    fn act(store: &Store, req: &str, who: &str) {
        let names = [WRITE_REQUEST, WRITE_PRINCIPAL_KIND, WRITE_PRINCIPAL_ID].map(String::from);
        let values = [req, "local_cli", who].map(String::from);
        store.apply_write_trust(&names, &values).unwrap();
    }

    fn put(store: &Store, slug: &str, body: &str) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": body}))
                .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let read = store.read().unwrap();
        crate::pages::read_page(&*read, "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    #[test]
    fn a_version_names_its_writer_and_archiver_and_reads_an_unknown_tier() {
        let store = store();
        act(&store, R1, "w1");
        let page = put(&store, "people/a", "one");
        act(&store, R2, "w2");
        let version = store.create_version("people/a", Some("default")).unwrap();
        let id = version["id"].as_u64().unwrap();
        put(&store, "people/a", "two");

        let live = store.read_page_revision_attribution(page).unwrap().unwrap();
        assert_eq!(
            (live["req"].as_str(), live["pid"].as_str()),
            (Some(R2), Some("w2"))
        );
        assert_eq!(live["trust_tier"], "unknown");
        let rows = store
            .read_version_attributions(&[(page, id), (page, id), (page, id + 9)])
            .unwrap();
        assert_eq!(rows.len(), 1, "a repeated or missing id adds no row");
        assert_eq!(rows[0]["w_req"], R1);
        assert_eq!(rows[0]["a_req"], R2);
        assert_eq!(rows[0]["a_id"], "w2");
        // An unknown snapshot tier is kept as none; PG's copied column reads `unknown`.
        assert_eq!(rows[0]["trust_tier"], "unknown");
        // A version named under another page is not that page's version.
        assert!(
            store
                .read_version_attributions(&[(page + 1, id)])
                .unwrap()
                .is_empty()
        );
        let oldest = store
            .read_oldest_version_attribution(page)
            .unwrap()
            .unwrap();
        assert_eq!(oldest, json!({"req": R1, "kind": "local_cli", "pid": "w1"}));
        assert!(
            store
                .read_page_revision_attribution(page + 9)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_take_or_fact_outside_its_holder_or_visibility_filter_reads_nothing() {
        let store = store();
        act(&store, R1, "w1");
        let page = put(&store, "people/a", "one");
        let take: TakeInput = serde_json::from_value(json!({
            "page_id": page, "row_num": 1, "claim": "c", "kind": "take", "holder": "garry", "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        let take = |holders: Option<Vec<&str>>| {
            store
                .read_row_attribution(&RowAttributionTarget::Take {
                    page_id: page,
                    row_num: 1,
                    holders: holders.map(|h| h.into_iter().map(String::from).collect()),
                    owner_only: OwnerOnlyForm::Off,
                })
                .unwrap()
        };
        let own = take(None).unwrap();
        assert_eq!(
            (own["w_req"].as_str(), own["trust_tier"].as_str()),
            (Some(R1), Some("unknown"))
        );
        assert_eq!(take(Some(vec!["garry"])), Some(own));
        assert_eq!(take(Some(vec!["alice"])), None);
        assert_eq!(
            take(Some(vec![])),
            None,
            "an empty holder list admits nobody"
        );

        let args: InsertFactArgs = serde_json::from_value(json!({
            "input": {"fact": "p", "entity_slug": "people/a", "source": "mcp:remember", "visibility": "private"},
            "sourceId": "default",
        }))
        .unwrap();
        let fact = store.insert_fact(&args).unwrap()["id"].as_u64().unwrap();
        let read = |world_only: bool, source: &str, slug: &str| {
            store
                .read_row_attribution(&RowAttributionTarget::Fact {
                    id: fact,
                    source_id: source.into(),
                    slug: slug.into(),
                    world_only,
                    exclude_private: None,
                })
                .unwrap()
        };
        assert_eq!(read(false, "default", "people/a").unwrap()["w_id"], "w1");
        assert_eq!(
            read(true, "default", "people/a"),
            None,
            "a private fact is not a world fact"
        );
        assert_eq!(read(false, "alt", "people/a"), None);
        assert_eq!(read(false, "default", "people/b"), None);
    }

    #[test]
    fn a_take_reads_the_trust_tier_and_write_origin_its_write_stamped() {
        use crate::write_trust::{WRITE_ORIGIN, WRITE_TRUST_TIER};
        let store = store();
        act(&store, R1, "w1");
        let page = put(&store, "people/a", "one");
        let names = [
            WRITE_REQUEST,
            WRITE_PRINCIPAL_KIND,
            WRITE_PRINCIPAL_ID,
            WRITE_TRUST_TIER,
            WRITE_ORIGIN,
        ]
        .map(String::from);
        let values = [
            R1,
            "local_cli",
            "w1",
            "agent_written",
            r#"{"channel":"mcp","tool":"t"}"#,
        ]
        .map(String::from);
        store.apply_write_trust(&names, &values).unwrap();
        let take: TakeInput = serde_json::from_value(json!({
            "page_id": page, "row_num": 1, "claim": "c", "kind": "take", "holder": "garry", "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        let row = store
            .read_row_attribution(&RowAttributionTarget::Take {
                page_id: page,
                row_num: 1,
                holders: None,
                owner_only: OwnerOnlyForm::Off,
            })
            .unwrap()
            .unwrap();
        // The stored tier and origin, not the column default `unknown` and NULL.
        assert_eq!(row["trust_tier"], "agent_written");
        assert_eq!(row["write_origin"]["channel"], "mcp");
        assert_eq!(row["write_origin"]["tool"], "t");
    }

    #[test]
    fn the_closed_owner_only_form_alone_hides_a_take_or_timeline_entry() {
        use crate::sources::SourceInput;
        use crate::timeline::{AddTimelineOptions, TimelineInput, TimelineOptions};
        let store = store();
        act(&store, R1, "w1");
        let page = put(&store, "people/a", "one");
        let take: TakeInput = serde_json::from_value(json!({
            "page_id": page, "row_num": 1, "claim": "c", "kind": "take", "holder": "garry", "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        let entry = TimelineInput {
            date: Some("2026-01-02".into()),
            source: Some("cal".into()),
            summary: Some("Joined".into()),
            detail: None,
        };
        assert!(
            store
                .add_timeline_entry("people/a", &entry, &AddTimelineOptions::default())
                .unwrap()
        );
        let entry_id = store
            .get_timeline("people/a", &TimelineOptions::default())
            .unwrap()[0]["id"]
            .as_u64()
            .unwrap();
        let read = |owner_only: OwnerOnlyForm| {
            let take = store
                .read_row_attribution(&RowAttributionTarget::Take {
                    page_id: page,
                    row_num: 1,
                    holders: None,
                    owner_only,
                })
                .unwrap()
                .is_some();
            let entry = store
                .read_row_attribution(&RowAttributionTarget::Timeline {
                    id: entry_id,
                    page_id: page,
                    owner_only,
                })
                .unwrap()
                .is_some();
            (take, entry)
        };
        // No owner-only source yet: every form reads both rows, so the hidden case is not vacuous.
        for form in [OwnerOnlyForm::Off, OwnerOnlyForm::Fn, OwnerOnlyForm::Closed] {
            assert_eq!(
                read(form),
                (true, true),
                "{form:?} before an owner-only source"
            );
        }
        store
            .upsert_source(&SourceInput {
                id: "chat".into(),
                name: Some("chat".into()),
                config: Some(json!({"kind": "imessage"}).as_object().unwrap().clone()),
                ..SourceInput::default()
            })
            .unwrap();
        assert_eq!(
            read(OwnerOnlyForm::Closed),
            (false, false),
            "the closed form hides both"
        );
        // The rows have no lineage here (no take or timeline marks, no derivation inputs).
        assert_eq!(
            read(OwnerOnlyForm::Fn),
            (true, true),
            "the function form reads the lineage"
        );
        assert_eq!(
            read(OwnerOnlyForm::Off),
            (true, true),
            "the owner reads both"
        );
    }
}
