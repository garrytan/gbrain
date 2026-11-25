//! Restore safety for a restored brain: what `gbrain backup restore` must know and change before it
//! publishes a Rust brain, as typed members (PGLite runs 66 SQL statements for this step; Rust
//! refuses raw SQL).
//!
//! `restore_census` is one read. It counts what could run again on its own (unfinished write
//! requests, claims, effects, recovery records, jobs), what authority the archive holds, every
//! source and the config rows a restore changes, which purges the caller expects are in the
//! ledgers, and any record of a kind this build has not classified. `blockers` names each reason
//! to refuse: `pending_requests`, `recovery_required`, `purge_replay`, `archived_authority`,
//! `shared_skill_state` and `unclassified_state`. Nothing on this engine cancels a request with a receipt, and nothing
//! revokes archived authority yet, so those are refusals, never repairs.
//!
//! `restore_quarantine` is one write transaction that repeats the safety census and refuses
//! (`restore_refused`) while a blocker stands, then detaches sources, rebases managed paths and
//! page origins, turns off automation settings and cancels unfinished jobs. It revokes nothing: a
//! store that holds a live OAuth client or a live local writer registration is refused as
//! `archived_authority`, and one with shared-skill publication activated, any shared-skill member,
//! delivery batch or policy, or `mcp.publish_skills` on is refused as `shared_skill_state`, before any
//! record changes, and an access-token, OAuth token or OAuth code
//! record lands in `unclassified`, which refuses by name. The store keeps no shared-skill table.
//! Page text, facts, links and source incarnations are not touched.

use crate::config::ConfigValueRow;
use crate::error::{
    INVALID_ARGUMENT, INVALID_STATE, ORIGIN_CLAIMED, RESTORE_REFUSED, Result, STORE_CORRUPT,
    StoreError,
};
use crate::kv::{KvRead, KvWrite, prefix_end, scan_prefix};
use crate::pages::{PageRecord, claimed_origin};
use crate::sources::{SourceRecord, all_sources, source_key};
use crate::{Store, StoredFormat, format, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Every key tag of `keys.rs`. A tag outside this list is state this restore has not classified.
/// `test/restore.rs` compares it with the constants of `keys.rs`.
const KNOWN_TAGS: &[u8] = b"MCSPIKTVJjWLlUOEDGopekbFNAQYZHgsnrquRcXBwvdmtafixzyh1";
/// The `jobs` sub-tags (`jobs.rs` lists them); a later one may hold authority (a token table).
const JOBS_SUBTAGS: &[u8] = &[
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16,
    0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x20, 0x21, 0x22, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A,
];
/// The `persistence` sub-tags (`persistence.rs` lists them).
const PERSISTENCE_SUBTAGS: &[u8] = &[1, 2, 3, 4, 5, 6, 7];
/// `persistence_requests` states that can still run, and the one that has a recovery in flight.
const UNFINISHED: [&str; 3] = ["queued", "deferred", "running"];
const PATH_SETTINGS: [&str; 4] = [
    "sync.repo_path",
    "mcp.skills_dir",
    "dream.synthesize.session_corpus_dir",
    "dream.synthesize.meeting_transcripts_dir",
];

#[derive(Debug, Clone, Serialize)]
pub struct StoreIdentity {
    /// The store's record format (`FORMAT`), never the archive container's version.
    pub engine_format_version: u32,
    pub schema_version: u32,
    pub brain_id: String,
    /// The commit sequence the census read.
    pub generation: u64,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Authority {
    pub local_writers: Vec<String>,
    pub oauth_clients: Vec<String>,
}

/// Shared-skill state a restore does not quarantine: the activated publication flag, any member
/// (`x 0x05`), delivery batch (`x 0x06`) or policy (`x 0x07`), and `mcp.publish_skills` on. The
/// catalog token secret (`x 0x04`) alone is the inert default of every brain and does not count.
fn shared_skill_state(read: &dyn KvRead) -> Result<Vec<String>> {
    let mut found = Vec::new();
    if crate::shared_skill_publication::publication_activated(read)? {
        found.push("publication activated".to_string());
    }
    for (sub, what) in [
        (0x05, "members"),
        (0x06, "delivery batches"),
        (0x07, "policies"),
    ] {
        let mut count = 0u64;
        scan_prefix(read, &[keys::ACCESS_MEMBERS, sub], false, &mut |_, _| {
            count += 1;
            true
        })?;
        if count > 0 {
            found.push(format!("{count} shared-skill {what}"));
        }
    }
    if read
        .get(&keys::text(keys::CONFIG, &["mcp.publish_skills"]))?
        .is_some_and(|v| v.eq_ignore_ascii_case(b"true"))
    {
        found.push("mcp.publish_skills on".to_string());
    }
    Ok(found)
}

impl Authority {
    /// The names a refusal shows: the ids, never a credential.
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if !self.local_writers.is_empty() {
            parts.push(format!("local writers {}", self.local_writers.join(", ")));
        }
        if !self.oauth_clients.is_empty() {
            parts.push(format!("OAuth clients {}", self.oauth_clients.join(", ")));
        }
        parts.join("; ")
    }
}

#[derive(Debug, Serialize)]
pub struct Blocker {
    pub reason: &'static str,
    pub count: u64,
    /// What the blocker is, when it can be named (the unclassified records).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SourceFact {
    pub id: String,
    pub archived: bool,
    pub local_path: Option<String>,
    pub kind: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Census {
    pub store: StoreIdentity,
    /// Unfinished write requests by state (`queued`, `deferred`, `running`, `recovering`).
    pub requests: BTreeMap<String, u64>,
    pub claims: u64,
    pub effects_live: u64,
    pub recovery_records: u64,
    pub jobs_live: u64,
    pub authority: Authority,
    pub sources: Vec<SourceFact>,
    /// The config rows `restore_quarantine` may change (`setting_kind`), with their values.
    pub settings: Vec<ConfigValueRow>,
    pub purges_present: Vec<String>,
    pub purges_missing: Vec<String>,
    pub unclassified: Vec<String>,
    pub blockers: Vec<Blocker>,
}

/// One source as the archive declared it: `local_path` is the original path, `rebased_path` the
/// restored path of a managed source (`null` for any other).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanSource {
    pub id: String,
    pub local_path: Option<String>,
    pub rebased_path: Option<String>,
}

/// One config row to change: the caller computed `value` (`null` deletes the row).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanSetting {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuarantinePlan {
    pub restore_id: String,
    /// Every source of the store, archived ones included; a mismatch refuses.
    pub sources: Vec<PlanSource>,
    pub settings: Vec<PlanSetting>,
}

#[derive(Debug, Serialize)]
pub struct QuarantineReport {
    pub detached_sources: Vec<String>,
    pub rebased_sources: Vec<String>,
    pub rebased_origins: u64,
    pub changed_settings: Vec<String>,
    pub jobs_cancelled: u64,
    /// The brain id before the restore and the fresh one the restored store now has.
    pub previous_brain_id: String,
    pub brain_id: String,
    pub reconnect: Vec<String>,
    /// The config row that keeps what was replaced (an inert record a later backup carries).
    pub inventory_key: String,
}

#[derive(Deserialize)]
struct Liveness {
    #[serde(default)]
    state: String,
    #[serde(default)]
    recovery: Option<Value>,
    #[serde(default)]
    recovery_bytes: i64,
    #[serde(default)]
    execution_token: Option<Value>,
    #[serde(default)]
    claim_expires_at: Option<Value>,
    #[serde(default)]
    publication_started: bool,
}

/// Held for the whole of `restore_quarantine`, id rotation and `FORMAT` update included.
static RESTORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Deserialize)]
struct PurgeId {
    request_id: Option<String>,
}

/// What a restore may change in a config row: turn it off, rebase a path, or delete it.
fn setting_kind(key: &str) -> Option<&'static str> {
    let middle = |head: &str, tail: &str| {
        key.strip_prefix(head)
            .and_then(|k| k.strip_suffix(tail))
            .filter(|m| !m.is_empty())
    };
    if middle("connectors.", ".auto_sync").is_some_and(|m| !m.contains('.'))
        || middle("autopilot.", ".enabled").is_some()
    {
        Some("disable")
    } else if PATH_SETTINGS.contains(&key) {
        Some("path")
    } else {
        (key == "storage").then_some("delete")
    }
}

/// `checkedRelativePath` (`agent-install/state.ts`): a plain relative path that is safe on every
/// platform the archive may be restored to.
fn plain_relative(rel: &str) -> bool {
    const RESERVED: [&str; 6] = ["con", "prn", "aux", "nul", "conin$", "conout$"];
    let reserved = |seg: &str| {
        let lower = seg.to_lowercase();
        let rest = RESERVED
            .iter()
            .find_map(|n| lower.strip_prefix(n))
            .or_else(|| {
                ["com", "lpt"].iter().find_map(|n| {
                    let r = lower.strip_prefix(n)?;
                    let mut chars = r.chars();
                    "123456789¹²³"
                        .contains(chars.next()?)
                        .then_some(chars.as_str())
                })
            });
        rest.is_some_and(|r| {
            r.trim_start_matches(' ').is_empty() || r.trim_start_matches(' ').starts_with('.')
        })
    };
    !rel.is_empty()
        && !rel
            .chars()
            .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
        && rel.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && !seg.ends_with(['.', ' '])
                && !reserved(seg)
        })
}

/// An absolute path of the machine the archive came from: POSIX, a Windows drive or a UNC path.
/// Only the first kind is rebased; the others are kept unchanged and named in the report.
fn is_absolute_origin(origin: &str) -> bool {
    let b = origin.as_bytes();
    origin.starts_with('/')
        || origin.starts_with("\\\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

/// `origin` moved from under `from` to under `to`; `None` when it is not under `from` or what
/// follows is not a plain relative path (the caller keeps it unchanged).
fn rebase_origin(origin: &str, from: &str, to: &str) -> Option<String> {
    let rel = origin
        .strip_prefix(from.trim_end_matches('/'))?
        .strip_prefix('/')?;
    plain_relative(rel).then(|| format!("{}/{rel}", to.trim_end_matches('/')))
}

/// The distinct bytes that follow `prefix` in the store, from `first` up.
fn next_bytes(read: &dyn KvRead, prefix: &[u8], first: u8) -> Result<Vec<u8>> {
    let end = prefix_end(prefix).unwrap_or_else(|| vec![0xFF; 64]);
    let (mut found, mut at) = (Vec::new(), u16::from(first));
    while at <= 0xFF {
        let mut start = prefix.to_vec();
        start.push(at as u8);
        let mut hit = None;
        read.scan(&start, &end, false, &mut |k, _| {
            hit = k.get(prefix.len()).copied();
            false
        })?;
        let Some(byte) = hit else { break };
        found.push(byte);
        at = u16::from(byte) + 1;
    }
    Ok(found)
}

/// A record kind this restore does not handle, named when a later lane's family is known to use it:
/// `rust-engine/main` keeps the `access_tokens` table at `jobs 0x2B` (`jobs/access_tokens.rs`).
/// This restore revokes no token; a record of that kind refuses.
fn describe_unclassified(label: &str, byte: u8) -> String {
    match (label, byte) {
        ("jobs", 0x2B) => "access tokens (jobs 0x2b)".into(),
        ("jobs", 0x2C) => "OAuth tokens (jobs 0x2c)".into(),
        ("jobs", 0x2D) => "OAuth codes (jobs 0x2d)".into(),
        _ => format!("{label} 0x{byte:02x}"),
    }
}

fn unclassified_state(read: &dyn KvRead) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let checks: [(&[u8], &[u8], &str); 3] = [
        (&[], KNOWN_TAGS, "tag"),
        (&[keys::JOBS], JOBS_SUBTAGS, "jobs"),
        (&[keys::PERSISTENCE], PERSISTENCE_SUBTAGS, "persistence"),
    ];
    for (prefix, known, label) in checks {
        let first = if prefix.is_empty() { 1 } else { 0 };
        for byte in next_bytes(read, prefix, first)? {
            if !known.contains(&byte) {
                out.push(describe_unclassified(label, byte));
            }
        }
    }
    Ok(out)
}

/// Streams the records under `prefix`, one decoded value at a time (a brain keeps every request).
fn each_record<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    prefix: &[u8],
    f: &mut dyn FnMut(T),
) -> Result<()> {
    let mut bad = false;
    scan_prefix(read, prefix, false, &mut |_, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(record) => f(record),
            Err(_) => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a request, effect or recovery record is not readable",
        ));
    }
    Ok(())
}

fn purge_ids_present(read: &dyn KvRead, wanted: &BTreeSet<String>) -> Result<BTreeSet<String>> {
    let mut present = BTreeSet::new();
    if wanted.is_empty() {
        return Ok(present);
    }
    // The fact purge ledger (`F 0x0F`), the page purge ledger (`F 0x0C`) and the take purge ledger (`F 0x10`).
    for sub in [0x0F, 0x0C, 0x10] {
        each_record(read, &[keys::FACT, sub], &mut |p: PurgeId| {
            if let Some(id) = p.request_id.map(|id| id.to_lowercase())
                && wanted.contains(&id)
            {
                present.insert(id);
            }
        })?;
    }
    Ok(present)
}

/// Every config row a restore may change (`setting_kind`), as the store holds it now.
fn safety_settings(read: &dyn KvRead) -> Result<Vec<ConfigValueRow>> {
    let mut settings = Vec::new();
    scan_prefix(read, &[keys::CONFIG], false, &mut |k, v| {
        if let (Ok(key), Ok(value)) = (std::str::from_utf8(&k[1..]), std::str::from_utf8(v))
            && setting_kind(key).is_some()
        {
            settings.push(ConfigValueRow {
                key: key.into(),
                value: value.into(),
            });
        }
        true
    })?;
    Ok(settings)
}

fn census_in(read: &dyn KvRead, purge_ids: &[String], store: StoreIdentity) -> Result<Census> {
    let mut requests = BTreeMap::<String, u64>::new();
    let (mut claims, mut recovery_records) = (0, 0);
    each_record(read, &[keys::REQUEST], &mut |r: Liveness| {
        let unfinished = UNFINISHED.contains(&r.state.as_str()) || r.state == "recovering";
        if unfinished {
            *requests.entry(r.state.clone()).or_default() += 1;
            claims += u64::from(r.execution_token.is_some() || r.claim_expires_at.is_some());
        }
        recovery_records += u64::from(
            r.recovery.is_some()
                || r.recovery_bytes != 0
                || r.state == "recovering"
                || (r.publication_started
                    && r.state != "committed"
                    && UNFINISHED.contains(&r.state.as_str())),
        );
    })?;
    let mut effects_live = 0;
    // `d 0x05`: effects; `d 0x03`: topology changes (`persistence.rs` lists the keys).
    each_record(read, &[keys::PERSISTENCE, 0x05], &mut |e: Liveness| {
        effects_live += u64::from(e.state == "queued" || e.state == "running");
        recovery_records += u64::from(e.recovery.is_some() || e.recovery_bytes != 0);
    })?;
    each_record(read, &[keys::PERSISTENCE, 0x03], &mut |t: Liveness| {
        recovery_records +=
            u64::from(t.recovery.is_some() || t.recovery_bytes != 0 || t.state == "recovering");
    })?;
    let wanted: BTreeSet<String> = purge_ids.iter().map(|id| id.to_lowercase()).collect();
    let present = purge_ids_present(read, &wanted)?;
    let missing: Vec<String> = wanted.difference(&present).cloned().collect();
    let settings = safety_settings(read)?;
    let text =
        |s: &SourceRecord, key: &str| s.config.get(key).and_then(Value::as_str).map(str::to_owned);
    let sources = all_sources(read)?
        .iter()
        .map(|s| SourceFact {
            id: s.id.clone(),
            archived: s.archived,
            local_path: s.local_path.clone(),
            kind: text(s, "kind"),
            remote_url: text(s, "remote_url"),
        })
        .collect();
    let (unfinished, recovering) = (
        requests
            .iter()
            .filter(|(s, _)| s.as_str() != "recovering")
            .map(|(_, n)| n)
            .sum::<u64>(),
        requests.get("recovering").copied().unwrap_or(0),
    );
    let unclassified = unclassified_state(read)?;
    let authority = Authority {
        local_writers: crate::journal::active_writer_ids(read)?,
        oauth_clients: crate::jobs::live_client_ids(read)?,
    };
    let shared_skills = shared_skill_state(read)?;
    let blockers = [
        ("pending_requests", unfinished + effects_live),
        ("recovery_required", recovering + recovery_records),
        ("purge_replay", missing.len() as u64),
        (
            "archived_authority",
            (authority.local_writers.len() + authority.oauth_clients.len()) as u64,
        ),
        ("shared_skill_state", shared_skills.len() as u64),
        ("unclassified_state", unclassified.len() as u64),
    ]
    .into_iter()
    .filter(|(_, count)| *count > 0)
    .map(|(reason, count)| Blocker {
        reason,
        count,
        detail: match reason {
            "unclassified_state" => Some(unclassified.join(", ")),
            "archived_authority" => Some(authority.describe()),
            "shared_skill_state" => Some(shared_skills.join(", ")),
            _ => None,
        },
    })
    .collect();
    Ok(Census {
        store,
        requests,
        claims,
        effects_live,
        recovery_records,
        jobs_live: crate::jobs::live_job_count(read)?,
        authority,
        sources,
        settings,
        purges_present: present.into_iter().collect(),
        purges_missing: missing,
        unclassified,
        blockers,
    })
}

/// Detaches or rebases one source, recording what it replaced in `inventory` and `report`.
fn quarantine_source(
    tx: &mut dyn KvWrite,
    mut record: SourceRecord,
    planned: &PlanSource,
    restore_id: &str,
    report: &mut QuarantineReport,
    inventory: &mut Vec<Value>,
) -> Result<()> {
    let text = |key: &str| record.config.get(key).is_some_and(Value::is_string);
    let external = (record.local_path.is_some() && planned.rebased_path.is_none())
        || text("kind")
        || text("remote_url");
    let (id, original) = (record.id.clone(), record.local_path.clone());
    if external {
        inventory.push(json!({ "id": id, "local_path": original, "config": record.config }));
        // Config is replaced, not merged: a kept `kind`, `remote_url` or credential command could
        // make a later sync clone, fetch or run a command from the old machine's settings.
        let mut kept = Map::new();
        for key in ["federated", "strategy"] {
            if let Some(v) = record.config.get(key)
                && (key == "strategy" && v.is_string() || key == "federated" && v.is_boolean())
            {
                kept.insert(key.into(), v.clone());
            }
        }
        if record.config.get("qm_scope") == Some(&Value::Bool(true)) {
            kept.insert("qm_scope".into(), Value::Bool(true));
        }
        kept.insert("syncEnabled".into(), Value::Bool(false));
        kept.insert("restore_detached".into(), json!(restore_id));
        record.config = kept;
        record.local_path = None;
        report.detached_sources.push(id.clone());
        report.reconnect.push(format!("Source {id}: external connector/checkout detached; review its private restore inventory and explicitly reconnect before enabling sync."));
    } else {
        record.local_path = planned.rebased_path.clone();
        if planned.rebased_path.is_some() {
            report.rebased_sources.push(id.clone());
        }
    }
    put_json(tx, &source_key(&id), &record)?;
    if let (false, Some(from), Some(to)) = (external, &original, &planned.rebased_path) {
        let mut moved = Vec::new();
        let mut preserved = 0;
        // The live origin each page will hold, moved or kept: two pages on one origin refuse the
        // restore before anything is written (`pages_live_origin_key`).
        let mut finals = BTreeMap::<String, u64>::new();
        let mut claimed = false;
        each_record(
            &*tx,
            &keys::text(keys::PAGE, &[&id, ""]),
            &mut |page: PageRecord| {
                let Some(origin) = page.source_path.clone() else {
                    return;
                };
                let next = rebase_origin(&origin, from, to);
                let mut after = page.clone();
                after.source_path = Some(next.clone().unwrap_or(origin.clone()));
                if let Some(live) = claimed_origin(&after) {
                    claimed |= finals.insert(live, page.id).is_some_and(|p| p != page.id);
                }
                match next {
                    Some(next) => moved.push((page, next)),
                    None => preserved += u64::from(is_absolute_origin(&origin)),
                }
            },
        )?;
        if claimed {
            return Err(StoreError::new(
                ORIGIN_CLAIMED,
                format!(
                    "source {id}: the rebased page origins would give two live pages one origin"
                ),
            ));
        }
        report.rebased_origins += moved.len() as u64;
        for (before, next) in moved {
            let mut after = before.clone();
            after.source_path = Some(next);
            put_json(tx, &keys::page(&after.source_id, &after.slug), &after)?;
            // The origin index (`o`) holds live pages only, in step with `source_path`.
            if let Some(old) = claimed_origin(&before) {
                tx.delete(&keys::page_origin(&before.source_id, &old, before.id))?;
            }
            if let Some(new) = claimed_origin(&after) {
                tx.put(&keys::page_origin(&after.source_id, &new, after.id), &[])?;
            }
        }
        if preserved > 0 {
            report.reconnect.push(format!("Source {id}: {preserved} legacy absolute page origins were preserved unchanged because they could not be safely rebased; review before syncing. Remembered text is unchanged."));
        }
    }
    Ok(())
}

impl Store {
    fn restore_identity(&self) -> Result<StoreIdentity> {
        let info = self.info();
        Ok(StoreIdentity {
            engine_format_version: info.format_version,
            schema_version: info.schema_version,
            brain_id: info.brain_id,
            generation: self.commit_version()?,
        })
    }

    /// The restore-safety census (see the module text). `purge_request_ids` are the committed
    /// purges the caller needs the ledgers to hold; those it does not find are `purges_missing`.
    pub fn restore_census(&self, purge_request_ids: &[String]) -> Result<Census> {
        census_in(&*self.read()?, purge_request_ids, self.restore_identity()?)
    }

    /// The restore changes, in one write transaction (see the module text). A second call with
    /// the same `restore_id` is `invalid_state`; a blocker is `restore_refused`.
    pub fn restore_quarantine(&self, plan: &QuarantinePlan) -> Result<QuarantineReport> {
        // One restore at a time: a second one rotating the id while the first has not yet written `FORMAT`
        // could leave `FORMAT` behind the record by more than one rotation, which an open refuses.
        let _one_at_a_time = RESTORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // The new id and `FORMAT` are published at once; inside an outer transaction a rollback
        // would leave them naming a brain the records never had.
        if self.bound.is_some() {
            return Err(StoreError::new(
                INVALID_STATE,
                "a restore changes the brain's identity and cannot run inside a transaction",
            ));
        }
        if plan.restore_id.is_empty() || plan.restore_id.contains('\0') {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "a restore id is a non-empty name",
            ));
        }
        let identity = self.restore_identity()?;
        let inventory_key = format!("restore.{}.detached_execution", plan.restore_id);
        let config_key = keys::text(keys::CONFIG, &[&inventory_key]);
        let report = self.write(|tx| {
            if tx.get(&config_key)?.is_some() {
                return Err(StoreError::new(INVALID_STATE, format!("restore {} was already applied", plan.restore_id)));
            }
            let census = census_in(&*tx, &[], identity.clone())?;
            if let Some(b) = census.blockers.first() {
                let named = b.detail.as_ref().map_or(String::new(), |d| format!(" ({d})"));
                return Err(StoreError::new(RESTORE_REFUSED, format!("{}: {}{named}", b.reason, b.count)));
            }
            let now = self.env.now_micros();
            let mut report = QuarantineReport {
                detached_sources: vec![],
                rebased_sources: vec![],
                rebased_origins: 0,
                changed_settings: vec![],
                jobs_cancelled: 0,
                previous_brain_id: identity.brain_id.clone(),
                brain_id: String::new(),
                reconnect: vec![],
                inventory_key: inventory_key.clone(),
            };
            let mut sources = Vec::new();
            let records = all_sources(&*tx)?;
            let declared: BTreeMap<&str, &PlanSource> = plan.sources.iter().map(|s| (s.id.as_str(), s)).collect();
            if declared.len() != plan.sources.len()
                || records.len() != declared.len()
                || records.iter().any(|r| declared.get(r.id.as_str()).is_none_or(|p| p.local_path != r.local_path))
            {
                return Err(StoreError::new(INVALID_ARGUMENT, "the source inventory does not match the archived store"));
            }
            for record in records {
                let planned = declared[record.id.as_str()];
                quarantine_source(tx, record, planned, &plan.restore_id, &mut report, &mut sources)?;
            }
            // Every setting the store holds is accounted for, once: a plan that leaves one out would
            // leave archived automation or an old machine's path switched on.
            let held: BTreeSet<String> = safety_settings(&*tx)?.into_iter().map(|r| r.key).collect();
            let planned_keys: BTreeSet<&String> = plan.settings.iter().map(|c| &c.key).collect();
            if planned_keys.len() != plan.settings.len()
                || planned_keys.len() != held.len()
                || !held.iter().all(|k| planned_keys.contains(k))
            {
                return Err(StoreError::new(INVALID_ARGUMENT, "the settings plan does not match the archived store"));
            }
            let mut settings = Vec::new();
            for change in &plan.settings {
                let kind = setting_kind(&change.key);
                let allowed = match (kind, &change.value) {
                    (Some("disable"), Some(v)) => v.as_str() == "false",
                    (Some("path"), _) | (Some("delete"), None) => true,
                    _ => false,
                };
                let key = keys::text(keys::CONFIG, &[&change.key]);
                let Some(before) = tx.get(&key)?.filter(|_| allowed) else {
                    return Err(StoreError::new(INVALID_ARGUMENT, format!("setting {} cannot be changed by a restore", change.key)));
                };
                let before = String::from_utf8_lossy(&before).into_owned();
                if change.value.as_deref() == Some(before.as_str()) {
                    continue;
                }
                match &change.value {
                    Some(v) => tx.put(&key, v.as_bytes())?,
                    None => tx.delete(&key)?,
                }
                let what = match (&change.value, kind) {
                    (None, _) => "detached",
                    (_, Some("path")) => "rebased to restored managed files",
                    _ => "disabled",
                };
                report.changed_settings.push(change.key.clone());
                report.reconnect.push(format!("Database setting {}: {what}; prior value retained in the private restore inventory.", change.key));
                settings.push(json!({ "key": change.key, "value": before }));
            }
            report.jobs_cancelled = crate::jobs::quarantine_jobs(tx, &plan.restore_id, now)?;
            // A fresh brain id, in the format record (committed with everything above). `FORMAT` follows
            // after the commit; a crash between leaves a record that names the id it rotated from, and
            // the next open rebuilds `FORMAT` from it.
            let mut format: StoredFormat = get_json(&*tx, &keys::meta("format"))?
                .ok_or_else(|| StoreError::new(STORE_CORRUPT, "the format record went missing"))?;
            report.brain_id = self.env.new_uuid();
            if report.brain_id == format.brain_id {
                return Err(StoreError::new(INVALID_STATE, "the fresh brain id equals the old one"));
            }
            format.rotated_from = Some(std::mem::replace(&mut format.brain_id, report.brain_id.clone()));
            put_json(tx, &keys::meta("format"), &format)?;
            report.reconnect.push(format!("The restored brain has a new identity ({}; it was {}): anything that names the old brain id, such as local writer credential files and owner sockets, does not apply to it.", report.brain_id, report.previous_brain_id));
            let inventory = json!({ "sources": sources, "settings": settings, "reconnect": report.reconnect });
            tx.put(&config_key, inventory.to_string().as_bytes())?;
            Ok(report)
        })?;
        // The open handle reports the committed id from here on, then `FORMAT` follows the committed record by atomic rename; the next open repairs it if this is cut short.
        self.set_brain_id(&report.brain_id);
        if let Some(dir) = &self.dir
            && let Some(mut on_disk) = format::read(dir)?
        {
            on_disk.brain_id = report.brain_id.clone();
            format::write(dir, &on_disk)?;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests;
