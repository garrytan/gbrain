//! The caller record of an authenticated principal, built by the store (multi-user lane L4, design
//! note M2: "the store derives ... member and group identity").
//!
//! A port of `remoteCallerAccess` (src/core/access/caller.ts) for a caller that names no audience:
//! the brain's remote read policy (`remotePolicyFrom`, src/core/search/private-visibility.ts), the
//! live member a token is bound to with its groups (`liveIdentity`), owner detection, member
//! lineage, folder-rule access (`folderAccessForAll`), the owner's audience-kind members and the
//! labelled-only grant. The output is the `CallerAccess` JSON shape `access_derive` reads, so a
//! multi-user server can derive every privacy policy from a record no client rendered.
//!
//! Inputs that are not store records come from the server: whether the operation only reads
//! (`readOnly`), the private-pages and private-facts sources of the verified grant, and the process
//! privacy hatch (`GBRAIN_REMOTE_PRIVATE_PAGES`, an operator setting of the serving process).
//!
//! The differential suite (`test/rust-access-record.serial.test.ts`) compares it with
//! `remoteCallerAccess` on the same Rust brain.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::access_derive::{access_id_ok, normalize_principal};
use crate::access_members::AccessMemberLookup;
use crate::{Result, Store};

const REMOTE_PRIVATE_PAGES_KEY: &str = "search.remote_private_pages";
const ACCESS_RESTRICTIONS_KEY: &str = "access.restrictions_present";
const OWNER_MEMBER_KEY: &str = "access.owner_member";
const OWNER_READS_RESTRICTED_KEY: &str = "access.owner_reads_restricted";
const MEMBERS_READ_LINEAGE_KEY: &str = "access.members_read_lineage";
const SCHEMA_VERSION_KEY: &str = "version";

/// What the server supplies besides the store's records.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordInputs {
    /// The operation only reads (member lineage applies to reads only).
    #[serde(default)]
    pub read_only: bool,
    /// The verified grant's private-pages sources, when the call may read them.
    #[serde(default)]
    pub private_readable_sources: Vec<String>,
    /// The verified grant's private-facts sources, when the call may read them.
    #[serde(default)]
    pub private_fact_sources: Vec<String>,
    /// The serving process's privacy hatch (`GBRAIN_REMOTE_PRIVATE_PAGES=1`).
    #[serde(default)]
    pub process_privacy_relaxed: bool,
}

/// `parseInt(text, 10)`: leading whitespace, an optional sign, then at least one digit.
fn parse_int_prefix(text: &str) -> Option<i64> {
    let t = text.trim_start();
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// JavaScript's `String.prototype.trim` for the values config holds.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The brain's remote read policy (`remotePolicyFrom`), as JSON.
fn remote_policy(store: &Store, process_privacy_relaxed: bool) -> Result<Value> {
    let get = |k: &str| store.get_config(k);
    let owner = get(OWNER_MEMBER_KEY)?
        .map(|v| js_trim(&v).to_string())
        .filter(|v| access_id_ok(v));
    let relaxed_config = get(REMOTE_PRIVATE_PAGES_KEY)?
        .is_some_and(|v| matches!(v.as_str(), "visible" | "true" | "1"));
    let mut p = json!({
        "privacyRelaxed": process_privacy_relaxed || relaxed_config,
        "restricted": get(ACCESS_RESTRICTIONS_KEY)?.as_deref() == Some("1"),
        "ownerMember": owner,
        "ownerReadsRestricted": get(OWNER_READS_RESTRICTED_KEY)?.is_some_and(|v| js_trim(&v) == "1"),
        "membersReadLineage": get(MEMBERS_READ_LINEAGE_KEY)?.is_some_and(|v| js_trim(&v) == "1"),
    });
    if let Some(v) = get(SCHEMA_VERSION_KEY)?
        .as_deref()
        .and_then(parse_int_prefix)
    {
        p["schemaVersion"] = json!(v);
    }
    Ok(p)
}

/// The member rows the record reads (`readAccessMembers`).
fn member_rows(store: &Store, lookup: AccessMemberLookup) -> Result<Vec<Value>> {
    Ok(store
        .read_access_members(&lookup)?
        .as_array()
        .cloned()
        .unwrap_or_default())
}

fn is_live(row: &Value) -> bool {
    row.get("disabled_at").is_none_or(Value::is_null)
        && row.get("tombstoned_at").is_none_or(Value::is_null)
}

/// `liveIdentity(engine, 'legacy_token', tokenId)`: the token's live member and its groups, sorted.
fn live_identity(store: &Store, token_id: &str) -> Result<Vec<String>> {
    let Some(live) = store.read_live_credential("legacy_token", token_id)? else {
        return Ok(vec![]);
    };
    let Some(member) = live
        .get("member_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(vec![]);
    };
    let rows = member_rows(
        store,
        AccessMemberLookup {
            id: Some(member.clone()),
            email: None,
            include_removed: false,
        },
    )?;
    let Some(row) = rows.into_iter().next().filter(is_live) else {
        return Ok(vec![]);
    };
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if normalize_principal(&format!("member:{id}")).as_deref()
        != Some(format!("member:{id}").as_str())
    {
        return Ok(vec![]);
    }
    let groups: Vec<String> = row
        .get("groups")
        .and_then(Value::as_array)
        .map(|g| {
            g.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut identity = vec![format!("member:{id}")];
    for g in groups {
        let p = format!("group:{g}");
        if normalize_principal(&p).as_deref() == Some(p.as_str()) {
            identity.push(p);
        }
    }
    identity.sort();
    Ok(identity)
}

/// `folderAccessFor(engine, identity)`; an unreadable rulebook satisfies nothing and covers everything.
fn folder_access(store: &Store, identity: &[String]) -> (Vec<String>, Vec<Value>) {
    match store.read_folder_access(identity) {
        Ok(rows) => {
            let mut satisfied: Vec<String> = rows
                .rules
                .iter()
                .filter(|r| r.readable_by.iter().any(|reader| identity.contains(reader)))
                .map(|r| format!("{}:{}", r.source_id, r.rule_id))
                .collect();
            satisfied.sort();
            let coverage = rows
                .coverage
                .iter()
                .map(|c| json!({ "source_id": c.source_id, "prefix": c.prefix }))
                .collect();
            (satisfied, coverage)
        }
        Err(_) => (
            vec![],
            vec![json!({ "source_id": "!unreadable", "prefix": "" })],
        ),
    }
}

/// `audienceMemberIds`: the live members of kind `audience`, by id; empty when unreadable.
fn audience_member_ids(store: &Store) -> Vec<String> {
    let Ok(rows) = member_rows(
        store,
        AccessMemberLookup {
            id: None,
            email: None,
            include_removed: false,
        },
    ) else {
        return vec![];
    };
    let mut ids: Vec<String> = rows
        .iter()
        .filter(|r| r.get("kind").and_then(Value::as_str) == Some("audience") && is_live(r))
        .filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|id| access_id_ok(id))
        .collect();
    ids.sort();
    ids
}

/// `labelledOnlyFor(engine, [identity])`: a member of the identity carries the labelled-only grant and is not the
/// configured owner; an unreadable member table reads as yes.
fn labelled_only_for(store: &Store, identity: &[String]) -> bool {
    let members: Vec<&str> = identity
        .iter()
        .filter_map(|p| p.strip_prefix("member:"))
        .filter(|id| access_id_ok(id))
        .collect();
    if members.is_empty() {
        return false;
    }
    let read = || -> Result<bool> {
        let owner = store
            .get_config(OWNER_MEMBER_KEY)?
            .map(|v| v.trim_matches(' ').to_string());
        let rows = member_rows(
            store,
            AccessMemberLookup {
                id: None,
                email: None,
                include_removed: true,
            },
        )?;
        Ok(rows.iter().any(|r| {
            let id = r.get("id").and_then(Value::as_str).unwrap_or_default();
            r.get("labelled_only").and_then(Value::as_bool) == Some(true)
                && members.contains(&id)
                && owner.as_deref() != Some(id)
        }))
    };
    read().unwrap_or(true)
}

impl Store {
    /// The caller record of the live token `token_id` (`remoteCallerAccess` with no audience), as `CallerAccess`
    /// JSON. A token with no live member reads with the empty identity, as an unbound credential does.
    pub fn token_caller_record(&self, token_id: &str, inputs: &RecordInputs) -> Result<Value> {
        let policy = remote_policy(self, inputs.process_privacy_relaxed)?;
        let restricted = policy["restricted"] == json!(true);
        let owner_member = policy["ownerMember"].as_str().map(str::to_string);
        let identity = if restricted || owner_member.is_some() {
            live_identity(self, token_id)?
        } else {
            vec![]
        };
        let owner = owner_member
            .as_ref()
            .is_some_and(|o| identity.contains(&format!("member:{o}")));
        let lineage = inputs.read_only
            && identity.iter().any(|p| p.starts_with("member:"))
            && (owner || policy["membersReadLineage"] == json!(true));
        let (satisfied, coverage) = if restricted {
            folder_access(self, &identity)
        } else {
            (vec![], vec![])
        };
        let relaxed = policy["privacyRelaxed"] == json!(true);
        Ok(json!({
            "identity": identity,
            "audience": null,
            "audienceIdentities": [],
            "satisfiedRuleIds": satisfied,
            "folderCoverage": coverage,
            "privateReadableSources": inputs.private_readable_sources,
            "privateFactSources": inputs.private_fact_sources,
            "hidePrivate": !relaxed && !owner,
            "owner": owner,
            "lineage": lineage,
            "ownerReadsRestricted": owner && lineage && policy["ownerReadsRestricted"] == json!(true),
            "audienceKindMembers": if owner && lineage { audience_member_ids(self) } else { vec![] },
            "labelledOnly": !owner && restricted && labelled_only_for(self, &identity),
            "applyRemoteReadPolicy": false,
            "restricted": restricted,
            "remotePolicy": policy,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_prefix_follows_javascript() {
        assert_eq!(parse_int_prefix("330"), Some(330));
        assert_eq!(parse_int_prefix("  42abc"), Some(42));
        assert_eq!(parse_int_prefix("-7"), Some(-7));
        assert_eq!(parse_int_prefix("abc"), None);
        assert_eq!(parse_int_prefix(""), None);
    }
}
