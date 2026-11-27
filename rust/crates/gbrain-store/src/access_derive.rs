//! The store's own derivation of a caller's privacy policy (multi-user lane L4, design note M2,
//! audit rows A12, B1-B3).
//!
//! Today a TypeScript member renders the caller's page or fact policy as PGLite SQL, compares that
//! text with the texts of a few reference caller records (`renderForStoreCaller`), and sends the
//! store the flag bag (`PrivacyPolicy`, `facts/privacy.rs`) of the reference it matched, or refuses
//! with `engine_capability_missing` when it matched none (`store-members/private-provenance.ts`,
//! `page-visibility.ts`, `fact-visibility.ts`, `remote-floor.ts`). A multi-user server cannot trust
//! a flag bag a client rendered. This module derives the same answer in the store from the raw
//! caller record and the brain's settings, with no SQL: every SQL fragment the members compare is
//! modelled here as a structured key that is equal for two caller records exactly when the two
//! rendered texts are equal. The helpers below then follow the TypeScript helpers step by step
//! (the same reference records, the same order, the same flags read off the matched reference).
//!
//! The derivation is pure: the inputs are an [`AccessContext`] (the caller record, or none, the
//! settings snapshot the renderer read, and the request). It is used two ways:
//! - self-check mode (`GBRAIN_RUST_ACCESS_SELF_CHECK=1` under `GBRAIN_RUST_MULTIUSER=1`): the
//!   TypeScript member derives as before, asks the store for its derivation of the same context,
//!   and refuses before the read when the two differ in any field;
//! - server mode: the store derives the policy itself from a scope it built (`scope.rs`).
//!
//! Where the key model cannot tell two texts apart that TypeScript would tell apart (or the
//! reverse), the result differs and self-check refuses: a divergence never widens a read. The one
//! known case is an explicit member-read identity that fails `validIdentity` and happens to equal a
//! quoted SQL literal (`storeMemberReadPolicy`'s `named` test reads the text): the store refuses it.
//!
//! The differential suite (`test/rust-access-derive.serial.test.ts`) runs every request over a generated
//! corpus of caller records and settings against the TypeScript helpers.

use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `MEMBER_PAGE_PREFIX` (access/principals.ts).
const MEMBER_PAGE_PREFIX: &str = "memory/members/";
/// `OWNER_ONLY_LINEAGE_SINCE` and `OWNER_ONLY_READ_MODE_SINCE` (access/owner-only.ts).
const OWNER_ONLY_LINEAGE_SINCE: i64 = 320;
const OWNER_ONLY_READ_MODE_SINCE: i64 = 328;
/// `CONCEPT_INPUTS_PRIVATE_SINCE` (search/private-visibility.ts).
const CONCEPT_INPUTS_PRIVATE_SINCE: i64 = 311;

// ---------------------------------------------------------------------------------------------
// Validators (ports of the TypeScript ones; every identity, rule id and source id embedded in a
// rendered text passed one of these).
// ---------------------------------------------------------------------------------------------

/// `ACCESS_ID_RE`: `^[a-z0-9][a-z0-9._-]{0,63}$`.
pub(crate) fn access_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// `normalizePrincipal` (access/principals.ts): trim spaces, lowercase ASCII, `group:<id>` or a
/// member id with or without `member:`.
pub(crate) fn normalize_principal(raw: &str) -> Option<String> {
    let v: String = raw
        .trim_matches(' ')
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if let Some(g) = v.strip_prefix("group:") {
        return access_id_ok(g).then(|| v.clone());
    }
    let id = v.strip_prefix("member:").unwrap_or(&v);
    access_id_ok(id).then(|| format!("member:{id}"))
}

/// `validIdentity`: every entry is already a normalized principal.
pub(crate) fn valid_identity(identity: &[String]) -> bool {
    identity
        .iter()
        .all(|p| normalize_principal(p).as_deref() == Some(p.as_str()))
}

/// `validQualifiedRuleId` (access/folder-rules.ts).
fn valid_rule_id(id: &str) -> bool {
    let Some(i) = id.find(':') else { return false };
    if i == 0 {
        return false;
    }
    let (src, rule) = (&id[..i], &id[i + 1..]);
    let s = src.as_bytes();
    s.len() <= 32
        && (s[0].is_ascii_lowercase() || s[0].is_ascii_digit())
        && s[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'-'))
        && access_id_ok(rule)
}

/// `isValidSourceId` (`SOURCE_ID_RE`: `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`).
pub(crate) fn valid_source_id(s: &str) -> bool {
    let b = s.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.len() {
        1 => edge(b[0]),
        2..=32 => {
            edge(b[0])
                && edge(b[b.len() - 1])
                && b[1..b.len() - 1].iter().all(|&c| edge(c) || c == b'-')
        }
        _ => false,
    }
}

/// One `[a-z0-9][a-z0-9._-]*` path segment.
fn segment_ok(seg: &str) -> bool {
    let b = seg.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// `validPrefix` (access/folder-rules.ts): a folder prefix (`a/b/`) or a slug, at most 512 bytes,
/// with no `..`.
fn valid_prefix(prefix: &str) -> bool {
    if prefix.len() > 512 || prefix.contains("..") || prefix.is_empty() {
        return false;
    }
    let body = prefix.strip_suffix('/').unwrap_or(prefix);
    !body.is_empty() && body.split('/').all(segment_ok)
}

/// `[...new Set(v)].sort()` for ASCII principals and ids (code-unit order equals byte order).
fn sorted_unique(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in v {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out.sort();
    out
}

/// `[...new Set(v)]`: first occurrence order.
fn unique(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in v {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The caller record and the settings snapshot.
// ---------------------------------------------------------------------------------------------

/// One folder-coverage entry (`FolderCoverage`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub source_id: String,
    pub prefix: String,
}

/// The attested actor (`CallerAccess.actor`): only its member reaches a rendered text.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Actor {
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub external_id: String,
    pub member: String,
}

/// The remote policy a request read (`RemotePolicy`): only its presence and `schemaVersion` reach a
/// rendered text (`readSchemaVersion`); the other fields are kept by the caller record only.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePolicy {
    #[serde(default)]
    pub schema_version: Option<i64>,
}

/// A caller record as `withCallerAccess` leaves it (`CallerAccess`, search/private-visibility.ts).
/// The TypeScript side sends `callerAccessRecord()` as is; the store's own scope builds the same
/// shape. Unknown fields are kept out of the derivation: a field this module does not know cannot
/// reach a rendered text it models, and the differential suite would show a new one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerRecord {
    #[serde(default)]
    pub identity: Vec<String>,
    #[serde(default)]
    pub audience: Option<Vec<String>>,
    #[serde(default)]
    pub audience_identities: Vec<Vec<String>>,
    #[serde(default)]
    pub actor: Option<Actor>,
    #[serde(default)]
    pub satisfied_rule_ids: Vec<String>,
    #[serde(default)]
    pub folder_coverage: Vec<Coverage>,
    #[serde(default)]
    pub private_readable_sources: Vec<String>,
    #[serde(default)]
    pub private_fact_sources: Vec<String>,
    #[serde(default = "yes")]
    pub hide_private: bool,
    #[serde(default)]
    pub owner: bool,
    #[serde(default)]
    pub owner_reads: Option<bool>,
    #[serde(default)]
    pub lineage: bool,
    #[serde(default)]
    pub owner_reads_restricted: bool,
    #[serde(default)]
    pub audience_kind_members: Vec<String>,
    #[serde(default)]
    pub labelled_only: bool,
    #[serde(default)]
    pub apply_remote_read_policy: bool,
    #[serde(default = "yes")]
    pub restricted: bool,
    #[serde(default)]
    pub remote_policy: Option<RemotePolicy>,
}

fn yes() -> bool {
    true
}

/// The settings the renderer read in the same context (`accessSettingsSnapshot()`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessSettings {
    /// `honorAliases()`: `visibility.honor_aliases` as the process (or the embedded engine) reads it.
    pub honor_aliases: bool,
    /// `processPrivacyRelaxed()`: the no-record default of `hidePrivate` is its negation.
    pub process_privacy_relaxed: bool,
    /// The engine scope's recorded schema version (`schemaVersionSeen`), read when the record
    /// carries no remote policy; none outside an engine scope.
    #[serde(default)]
    pub scope_schema_version: Option<i64>,
}

/// A record patch (`Partial<CallerAccess>` handed to `withCallerAccess`). `Some(None)` on an
/// optional field is an explicit `null`.
#[derive(Default, Clone)]
struct Patch {
    identity: Option<Vec<String>>,
    audience: Option<Option<Vec<String>>>,
    audience_identities: Option<Vec<Vec<String>>>,
    actor: Option<Option<Actor>>,
    satisfied_rule_ids: Option<Vec<String>>,
    folder_coverage: Option<Vec<Coverage>>,
    private_readable_sources: Option<Vec<String>>,
    private_fact_sources: Option<Vec<String>>,
    hide_private: Option<bool>,
    owner: Option<bool>,
    owner_reads: Option<bool>,
    lineage: Option<bool>,
    owner_reads_restricted: Option<bool>,
    audience_kind_members: Option<Vec<String>>,
    labelled_only: Option<bool>,
    restricted: Option<bool>,
    remote_policy: Option<Option<RemotePolicy>>,
}

/// The current record, or none (outside any caller record).
type Cur = Option<CallerRecord>;

/// `currentCallerAccess()`: the record, or the default one outside a record.
fn eff(cur: &Cur, s: &AccessSettings) -> CallerRecord {
    cur.clone().unwrap_or_else(|| CallerRecord {
        identity: vec![],
        audience: None,
        audience_identities: vec![],
        actor: None,
        satisfied_rule_ids: vec![],
        folder_coverage: vec![],
        private_readable_sources: vec![],
        private_fact_sources: vec![],
        hide_private: !s.process_privacy_relaxed,
        owner: false,
        owner_reads: None,
        lineage: false,
        owner_reads_restricted: false,
        audience_kind_members: vec![],
        labelled_only: false,
        apply_remote_read_policy: false,
        restricted: true,
        remote_policy: None,
    })
}

/// `withCallerAccess(patch, ...)` over `cur`: the record the callback runs under.
fn with(cur: &Cur, patch: &Patch, s: &AccessSettings) -> Cur {
    let base = eff(cur, s);
    let identity = patch
        .identity
        .clone()
        .unwrap_or_else(|| base.identity.clone());
    let sources = patch
        .private_readable_sources
        .clone()
        .unwrap_or_else(|| base.private_readable_sources.clone());
    let valid_ids = !identity.is_empty() && valid_identity(&identity);
    let fresh = patch.identity.is_some() || patch.audience_identities.is_some();
    let fact_sources = patch.private_fact_sources.clone().unwrap_or_else(|| {
        if fresh {
            vec![]
        } else {
            base.private_fact_sources.clone()
        }
    });
    let audience_identities: Vec<Vec<String>> = patch
        .audience_identities
        .clone()
        .unwrap_or_else(|| {
            if fresh {
                vec![]
            } else {
                base.audience_identities.clone()
            }
        })
        .iter()
        .map(|id| {
            if !id.is_empty() && valid_identity(id) {
                sorted_unique(id)
            } else {
                vec![]
            }
        })
        .collect();
    let audience = match &patch.audience {
        Some(a) => a.clone(),
        None if fresh => None,
        None => base.audience.clone(),
    };
    let actor = match &patch.actor {
        Some(a) => a.clone(),
        None if fresh => None,
        None => base.actor.clone(),
    };
    let satisfied_ok = valid_ids || audience_identities.iter().any(|id| !id.is_empty());
    let satisfied = if satisfied_ok {
        patch.satisfied_rule_ids.clone().unwrap_or_else(|| {
            if fresh {
                vec![]
            } else {
                base.satisfied_rule_ids.clone()
            }
        })
    } else {
        vec![]
    };
    let owner = patch
        .owner
        .unwrap_or(if fresh { false } else { base.owner });
    let single = audience_identities.len() <= 1;
    let lineage_in = patch
        .lineage
        .unwrap_or(if fresh { false } else { base.lineage });
    let orr_in = patch.owner_reads_restricted.unwrap_or(if fresh {
        false
    } else {
        base.owner_reads_restricted
    });
    let akm_in = patch.audience_kind_members.clone().unwrap_or_else(|| {
        if fresh {
            vec![]
        } else {
            base.audience_kind_members.clone()
        }
    });
    let read = single && lineage_in;
    let owner_read = owner && read;
    let audience_valid = audience.as_ref().map(|a| {
        a.iter()
            .all(|e| e == "guest" || normalize_principal(e).as_deref() == Some(e.as_str()))
    });
    Some(CallerRecord {
        identity: if valid_ids && single {
            sorted_unique(&identity)
        } else {
            vec![]
        },
        audience: match (audience, audience_valid) {
            (Some(a), Some(true)) => Some(a),
            (Some(_), _) => Some(vec!["guest".to_string()]),
            (None, _) => None,
        },
        audience_identities: if audience_identities.len() > 1 {
            audience_identities
        } else {
            vec![]
        },
        actor,
        satisfied_rule_ids: if !satisfied.is_empty() && satisfied.iter().all(|r| valid_rule_id(r)) {
            sorted_unique(&satisfied)
        } else {
            vec![]
        },
        folder_coverage: patch
            .folder_coverage
            .clone()
            .unwrap_or_else(|| base.folder_coverage.clone()),
        private_readable_sources: if !sources.is_empty()
            && sources.iter().all(|x| valid_source_id(x))
        {
            unique(&sources)
        } else {
            vec![]
        },
        private_fact_sources: if !fact_sources.is_empty()
            && fact_sources.iter().all(|x| valid_source_id(x))
        {
            unique(&fact_sources)
        } else {
            vec![]
        },
        hide_private: patch
            .hide_private
            .unwrap_or(if fresh { true } else { base.hide_private }),
        owner,
        owner_reads: Some(patch.owner_reads.unwrap_or(if fresh {
            false
        } else {
            base.owner_reads == Some(true)
        })),
        lineage: read,
        owner_reads_restricted: owner_read && orr_in,
        audience_kind_members: if owner_read && akm_in.iter().all(|id| access_id_ok(id)) {
            sorted_unique(&akm_in)
        } else {
            vec![]
        },
        labelled_only: patch.labelled_only.unwrap_or(if fresh {
            false
        } else {
            base.labelled_only
        }),
        apply_remote_read_policy: base.apply_remote_read_policy,
        restricted: patch.restricted.unwrap_or(base.restricted),
        remote_policy: match &patch.remote_policy {
            Some(Some(rp)) => Some(rp.clone()),
            _ => base.remote_policy.clone(),
        },
    })
}

/// `withoutCallerAccess(() => withCallerAccess(patch, ...))`.
fn fresh_record(patch: &Patch, s: &AccessSettings) -> Cur {
    with(&None, patch, s)
}

/// `renderForStoreCaller(record, ...)`: the reference context for `record`, which keeps the
/// caller's remote policy. An empty record with no remote policy renders outside any record.
fn reference(cur: &Cur, mut patch: Patch, empty: bool, s: &AccessSettings) -> Cur {
    let rp = eff(cur, s).remote_policy;
    if empty && rp.is_none() {
        return None;
    }
    if let (Some(rp), None) = (rp, &patch.remote_policy) {
        patch.remote_policy = Some(Some(rp));
    }
    fresh_record(&patch, s)
}

// ---------------------------------------------------------------------------------------------
// Rendered fragments as keys: equal exactly when the TypeScript text is equal.
// ---------------------------------------------------------------------------------------------

/// The owner-only test of a text (`ownerOnlyAllowedSql` and its fact, take and timeline twins):
/// none for an owner read, else the form for the read's schema version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnerOnlyText {
    None,
    Closed,
    Fn,
    Mode,
}

/// The read's schema version (`readSchemaVersion`).
fn schema(cur: &Cur, s: &AccessSettings) -> Option<i64> {
    match cur.as_ref().and_then(|r| r.remote_policy.as_ref()) {
        Some(rp) => rp.schema_version,
        None => s.scope_schema_version,
    }
}

fn owner_only_text(cur: &Cur, s: &AccessSettings) -> OwnerOnlyText {
    if eff(cur, s).owner {
        return OwnerOnlyText::None;
    }
    owner_only_form(cur, s)
}

/// `ownerOnlyForm(readSchemaVersion())`: the form of the test for a record that is not the owner's.
fn owner_only_form(cur: &Cur, s: &AccessSettings) -> OwnerOnlyText {
    match schema(cur, s) {
        Some(v) if v >= OWNER_ONLY_READ_MODE_SINCE => OwnerOnlyText::Mode,
        Some(v) if v >= OWNER_ONLY_LINEAGE_SINCE => OwnerOnlyText::Fn,
        _ => OwnerOnlyText::Closed,
    }
}

/// `ownerOnlyFormIn`: the store's `ownerOnly` for a text whose owner-only test is `t`.
fn owner_only_flag(t: OwnerOnlyText) -> &'static str {
    match t {
        OwnerOnlyText::None => "off",
        OwnerOnlyText::Closed => "closed",
        OwnerOnlyText::Fn | OwnerOnlyText::Mode => "fn",
    }
}

/// Comparison mode: `normalizeConceptInputs` reads the inline and the function form of the
/// concept-input test as one.
#[derive(Clone, Copy)]
struct Cx<'a> {
    s: &'a AccessSettings,
    norm: bool,
}

/// `privacyPartSql(p)`: the aliases test (process setting) and the concept-input form.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PrivacyPart {
    honor: bool,
    concept_fn: bool,
}

fn privacy_part(cur: &Cur, cx: Cx) -> PrivacyPart {
    let concept_fn =
        !cx.norm && schema(cur, cx.s).is_some_and(|v| v >= CONCEPT_INPUTS_PRIVATE_SINCE);
    PrivacyPart {
        honor: cx.s.honor_aliases,
        concept_fn,
    }
}

/// One mapped `coverageSql` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CoverageText {
    False,
    Whole(String),
    Prefix(String, String),
}

/// `coverageSql`: live outside a record, else the record's entries.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CoverageKey {
    Live,
    Record(Vec<CoverageText>),
}

fn coverage(cur: &Cur) -> CoverageKey {
    match cur {
        None => CoverageKey::Live,
        Some(r) => CoverageKey::Record(
            r.folder_coverage
                .iter()
                .map(|c| {
                    if !valid_source_id(&c.source_id)
                        || (!c.prefix.is_empty() && !valid_prefix(&c.prefix))
                    {
                        CoverageText::False
                    } else if c.prefix.is_empty() {
                        CoverageText::Whole(c.source_id.clone())
                    } else {
                        CoverageText::Prefix(c.source_id.clone(), c.prefix.clone())
                    }
                })
                .collect(),
        ),
    }
}

/// `folderRulesAllowedSql(alias, satisfied, derived)`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FolderKey {
    ids: Vec<String>,
    derived: bool,
    coverage: CoverageKey,
}

fn folder(satisfied: &[String], derived: bool, cur: &Cur) -> FolderKey {
    let ids = if !satisfied.is_empty() && satisfied.iter().all(|r| valid_rule_id(r)) {
        sorted_unique(satisfied)
    } else {
        vec![]
    };
    FolderKey {
        ids,
        derived,
        coverage: coverage(cur),
    }
}

/// `readersAllowedSql(alias, identity)`: the listed principals, in the order given.
fn readers(identity: &[String]) -> Vec<String> {
    if !identity.is_empty() && valid_identity(identity) {
        identity.to_vec()
    } else {
        vec![]
    }
}

/// `accessAllowedForAllSql`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AccessKey {
    Short(OwnerOnlyText),
    Full {
        readers: Vec<Vec<String>>,
        folder: FolderKey,
        owner_only: OwnerOnlyText,
    },
    Lineage(Box<LineageKey>),
}

fn access_all(
    identities: &[Vec<String>],
    satisfied: &[String],
    derived: bool,
    cur: &Cur,
    s: &AccessSettings,
) -> AccessKey {
    let oo = owner_only_text(cur, s);
    if !eff(cur, s).restricted {
        return AccessKey::Short(oo);
    }
    let list: Vec<Vec<String>> = if identities.is_empty() {
        vec![vec![]]
    } else {
        identities.to_vec()
    };
    AccessKey::Full {
        readers: list.iter().map(|i| readers(i)).collect(),
        folder: folder(satisfied, derived, cur),
        owner_only: oo,
    }
}

/// `satisfiedFor(identity)`.
fn satisfied_for(identity: &[String], cur: &Cur, s: &AccessSettings) -> Vec<String> {
    let a = eff(cur, s);
    if identity.is_empty() || identity.len() != a.identity.len() {
        return vec![];
    }
    let mut sorted = identity.to_vec();
    sorted.sort();
    if sorted.iter().zip(a.identity.iter()).all(|(x, y)| x == y) {
        a.satisfied_rule_ids
    } else {
        vec![]
    }
}

/// `accessAllowedSql(alias, identity, satisfied?, derived)`.
fn access_allowed(
    identity: &[String],
    satisfied: Option<&[String]>,
    derived: bool,
    cur: &Cur,
    s: &AccessSettings,
) -> AccessKey {
    let sat = match satisfied {
        Some(x) => x.to_vec(),
        None => satisfied_for(identity, cur, s),
    };
    access_all(&[identity.to_vec()], &sat, derived, cur, s)
}

/// `lineageReadPage`.
fn lineage_read_page(a: &CallerRecord) -> Option<String> {
    if !a.lineage {
        return None;
    }
    let member = a.identity.iter().find_map(|p| p.strip_prefix("member:"))?;
    access_id_ok(member).then(|| format!("{MEMBER_PAGE_PREFIX}{member}"))
}

/// `audiencePages`.
fn audience_pages(a: &CallerRecord) -> Vec<String> {
    if a.owner && a.lineage {
        a.audience_kind_members
            .iter()
            .filter(|id| access_id_ok(id))
            .map(|id| format!("{MEMBER_PAGE_PREFIX}{id}"))
            .collect()
    } else {
        vec![]
    }
}

/// `lineageAccessSql(alias, access, ownPage, derived)`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LineageKey {
    Short {
        orr: bool,
        own_page: Option<String>,
        audience: Vec<String>,
        owner_only: OwnerOnlyText,
    },
    Full {
        readers: Vec<String>,
        audience: Vec<String>,
        folder: FolderKey,
        orr_page: Option<(String, CoverageKey)>,
        origin_identity: Vec<String>,
        origin_satisfied: Vec<String>,
        orr: bool,
        own_page: String,
        owner_only: OwnerOnlyText,
    },
}

/// `lineageAccessSql` for the record `a` (which need not be `cur`'s own: `ownerReadPolicyFragment`
/// builds one), rendered in `cur` (coverage, schema).
fn lineage_access(
    a: &CallerRecord,
    own_page: &str,
    derived: bool,
    cur: &Cur,
    s: &AccessSettings,
) -> LineageKey {
    let audience = audience_pages(a);
    let oo = if a.owner {
        OwnerOnlyText::None
    } else {
        owner_only_form(cur, s)
    };
    if !a.restricted {
        return LineageKey::Short {
            orr: a.owner_reads_restricted,
            own_page: a.owner_reads_restricted.then(|| own_page.to_string()),
            audience: if a.owner_reads_restricted {
                audience
            } else {
                vec![]
            },
            owner_only: oo,
        };
    }
    LineageKey::Full {
        readers: readers(&a.identity),
        audience: audience.clone(),
        folder: folder(&a.satisfied_rule_ids, derived, cur),
        orr_page: a
            .owner_reads_restricted
            .then(|| (own_page.to_string(), coverage(cur))),
        origin_identity: if valid_identity(&a.identity) {
            a.identity.clone()
        } else {
            vec![]
        },
        origin_satisfied: if a.satisfied_rule_ids.iter().all(|r| valid_rule_id(r)) {
            a.satisfied_rule_ids.clone()
        } else {
            vec![]
        },
        orr: a.owner_reads_restricted,
        own_page: own_page.to_string(),
        owner_only: oo,
    }
}

/// `labelledOnlySql(alias, access, readers)`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LabelledKey {
    identity: Vec<String>,
    satisfied: Vec<String>,
    lineage: bool,
}

fn labelled(a: &CallerRecord) -> LabelledKey {
    let mut all: Vec<String> = a.identity.clone();
    for id in &a.audience_identities {
        all.extend(id.iter().cloned());
    }
    let ident = sorted_unique(&all);
    LabelledKey {
        identity: if !ident.is_empty() && valid_identity(&ident) {
            ident
        } else {
            vec![]
        },
        satisfied: if a.satisfied_rule_ids.iter().all(|r| valid_rule_id(r)) {
            a.satisfied_rule_ids.clone()
        } else {
            vec![]
        },
        lineage: a.lineage && !a.owner,
    }
}

/// A privacy conjunct: `'TRUE'`, or the privacy part widened to private-readable sources.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PrivacyKey {
    True,
    Part {
        sources: Vec<String>,
        part: PrivacyPart,
    },
}

/// A page policy text over one alias.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PageKey {
    /// `(${access}[ AND ${labelled}] AND ${privacy})` with the labelled conjunct inside the access
    /// part (`callerAccessSql`), or none.
    Base {
        access: AccessKey,
        labelled: Option<LabelledKey>,
        privacy: PrivacyKey,
    },
    /// `(${plain} AND ${labelled})` (`remoteReadFloorSql` for a labelled-only caller).
    FloorLabelled {
        plain: Box<PageKey>,
        labelled: LabelledKey,
    },
    /// `'FALSE'` (`ownerReadPolicyFragment` with no member page).
    False,
}

/// `callerAccessSql(alias)`: the access key and the labelled-only conjunct.
fn caller_access(cur: &Cur, s: &AccessSettings) -> (AccessKey, Option<LabelledKey>) {
    let a = eff(cur, s);
    let allowed = match lineage_read_page(&a) {
        Some(page) => AccessKey::Lineage(Box::new(lineage_access(&a, &page, false, cur, s))),
        None if !a.audience_identities.is_empty() => {
            access_all(&a.audience_identities, &a.satisfied_rule_ids, false, cur, s)
        }
        None => access_allowed(&a.identity, None, false, cur, s),
    };
    (allowed, a.labelled_only.then(|| labelled(&a)))
}

/// `privacyForCaller(alias, privacyPartSql(alias))`.
fn caller_privacy(cur: &Cur, cx: Cx) -> PrivacyKey {
    let a = eff(cur, cx.s);
    if a.hide_private {
        PrivacyKey::Part {
            sources: a.private_readable_sources.clone(),
            part: privacy_part(cur, cx),
        }
    } else {
        PrivacyKey::True
    }
}

/// `privatePagesFilterForCaller(alias)`.
fn page_caller(cur: &Cur, cx: Cx) -> PageKey {
    let (access, labelled) = caller_access(cur, cx.s);
    PageKey::Base {
        access,
        labelled,
        privacy: caller_privacy(cur, cx),
    }
}

/// `privatePagesFilterFragment(alias, derived)` (also `readPolicyFragment(alias, [], true[, []])`).
fn page_plain(cur: &Cur, derived: bool, cx: Cx) -> PageKey {
    PageKey::Base {
        access: access_allowed(&[], Some(&[]), derived, cur, cx.s),
        labelled: None,
        privacy: PrivacyKey::Part {
            sources: vec![],
            part: privacy_part(cur, cx),
        },
    }
}

/// `remoteReadFloorSql(alias)`.
fn page_floor(cur: &Cur, cx: Cx) -> PageKey {
    let plain = page_plain(cur, false, cx);
    let a = eff(cur, cx.s);
    if a.labelled_only {
        PageKey::FloorLabelled {
            plain: Box::new(plain),
            labelled: labelled(&a),
        }
    } else {
        plain
    }
}

/// `readPolicyFragment(alias, identity, hidePrivate, satisfied?, derived)` for one identity.
fn read_policy(
    identity: &[String],
    hide: bool,
    satisfied: Option<&[String]>,
    derived: bool,
    cur: &Cur,
    cx: Cx,
) -> PageKey {
    PageKey::Base {
        access: access_allowed(identity, satisfied, derived, cur, cx.s),
        labelled: None,
        privacy: if hide {
            PrivacyKey::Part {
                sources: vec![],
                part: privacy_part(cur, cx),
            }
        } else {
            PrivacyKey::True
        },
    }
}

/// `ownerReadPolicyFragment(alias, identity, satisfied)`.
fn owner_read_policy(identity: &[String], satisfied: &[String], cur: &Cur, cx: Cx) -> PageKey {
    let mut a = eff(cur, cx.s);
    a.identity = identity.to_vec();
    a.satisfied_rule_ids = satisfied.to_vec();
    a.owner = true;
    a.lineage = true;
    a.owner_reads_restricted = false;
    a.audience_kind_members = vec![];
    a.restricted = true;
    match lineage_read_page(&a) {
        Some(page) => PageKey::Base {
            access: AccessKey::Lineage(Box::new(lineage_access(&a, &page, false, cur, cx.s))),
            labelled: None,
            privacy: PrivacyKey::Part {
                sources: vec![],
                part: privacy_part(cur, cx),
            },
        },
        None => PageKey::False,
    }
}

/// The page fragment a page-text policy compares (`rendered` in `storePageTextPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageFragment {
    /// `privatePagesFilterForCaller('p')`.
    Caller,
    /// `remoteReadFloorSql('p')`.
    Floor,
    /// `privatePagesFilterFragment('p')`, which `readPolicyFragment('p', [], true)` renders too.
    Plain,
}

fn page_fragment(f: PageFragment, cur: &Cur, cx: Cx) -> PageKey {
    match f {
        PageFragment::Caller => page_caller(cur, cx),
        PageFragment::Floor => page_floor(cur, cx),
        PageFragment::Plain => page_plain(cur, false, cx),
    }
}

// ---- facts -------------------------------------------------------------------------------------

/// `labelledOnlyFactSql(facts)`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LabelledFactKey {
    None,
    Own {
        member: Option<String>,
        lineage: Option<LabelledKey>,
    },
}

fn labelled_fact(cur: &Cur, s: &AccessSettings) -> LabelledFactKey {
    let a = eff(cur, s);
    if !a.labelled_only {
        return LabelledFactKey::None;
    }
    let lone = if a.audience_identities.is_empty() {
        a.identity
            .iter()
            .find_map(|p| p.strip_prefix("member:"))
            .map(str::to_string)
    } else {
        None
    };
    let member = a.actor.as_ref().map(|x| x.member.clone()).or(lone);
    let member = member.filter(|m| access_id_ok(m));
    let lineage = (a.lineage && !a.owner).then(|| labelled(&a));
    LabelledFactKey::Own { member, lineage }
}

/// `sharedHeldRuledSql(facts)`.
fn shared_held(cur: &Cur, s: &AccessSettings) -> Option<Vec<String>> {
    let a = eff(cur, s);
    if a.owner_reads_restricted {
        return None;
    }
    let sat = if a.restricted {
        a.satisfied_rule_ids.clone()
    } else {
        vec![]
    };
    Some(if !sat.is_empty() && sat.iter().all(|r| valid_rule_id(r)) {
        sorted_unique(&sat)
    } else {
        vec![]
    })
}

/// `privateEntityFilterForCaller(facts)`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EntityKey {
    policy: PageKey,
    shared_held: Option<Vec<String>>,
}

fn entity(cur: &Cur, cx: Cx) -> EntityKey {
    let a = eff(cur, cx.s);
    let policy = if a.labelled_only {
        page_caller(
            &with(
                cur,
                &Patch {
                    labelled_only: Some(false),
                    ..Patch::default()
                },
                cx.s,
            ),
            cx,
        )
    } else {
        page_caller(cur, cx)
    };
    EntityKey {
        policy,
        shared_held: shared_held(cur, cx.s),
    }
}

/// The member-page case of `privateProvenanceFilterUnderPolicy`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProvenancePolicy {
    Plain(Box<PageKey>),
    Lineage {
        audience: Vec<String>,
        member_pages: Box<PageKey>,
        other: Box<LineageKey>,
        privacy: PrivacyKey,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FactKey {
    /// `privateProvenanceFilterUnderPolicy(facts)`.
    UnderPolicy {
        member: Option<(String, Box<PageKey>)>,
        otherwise: Box<ProvenancePolicy>,
        entity: Box<EntityKey>,
        labelled: LabelledFactKey,
        owner_only: OwnerOnlyText,
    },
    /// `privateFactFilterForCaller(facts)`.
    ForCaller {
        provenance: (Box<PageKey>, OwnerOnlyText),
        entity: Box<EntityKey>,
        labelled: LabelledFactKey,
    },
    /// `remoteProvenanceFloorSql(facts)`: the provenance fragment, wrapped when labelled-only.
    Floor {
        provenance: (Box<PageKey>, OwnerOnlyText),
        labelled: LabelledFactKey,
    },
}

fn fact_under_policy(cur: &Cur, cx: Cx) -> FactKey {
    let a = eff(cur, cx.s);
    let hide = !cur.as_ref().is_some_and(|r| !r.hide_private);
    let member = match &a.actor {
        Some(actor) => Some(actor.member.clone()),
        None if !a.audience_identities.is_empty() => None,
        None => a
            .identity
            .iter()
            .find_map(|p| p.strip_prefix("member:"))
            .map(str::to_string),
    };
    let own_page = lineage_read_page(&a);
    let audience = audience_pages(&a);
    let otherwise = match own_page {
        Some(page) => ProvenancePolicy::Lineage {
            audience: audience.clone(),
            member_pages: Box::new(read_policy(&[], hide, Some(&[]), true, cur, cx)),
            other: Box::new(lineage_access(&a, &page, true, cur, cx.s)),
            privacy: if hide {
                PrivacyKey::Part {
                    sources: vec![],
                    part: privacy_part(cur, cx),
                }
            } else {
                PrivacyKey::True
            },
        },
        None => ProvenancePolicy::Plain(Box::new(read_policy(&[], hide, Some(&[]), true, cur, cx))),
    };
    let member = member.filter(|m| access_id_ok(m)).map(|m| {
        let policy = read_policy(
            &a.identity,
            hide,
            Some(&a.satisfied_rule_ids),
            true,
            cur,
            cx,
        );
        (m, Box::new(policy))
    });
    FactKey::UnderPolicy {
        member,
        otherwise: Box::new(otherwise),
        entity: Box::new(entity(cur, cx)),
        labelled: labelled_fact(cur, cx.s),
        owner_only: owner_only_text(cur, cx.s),
    }
}

/// `privateProvenanceFilterFragment(facts)`.
fn provenance_fragment(cur: &Cur, cx: Cx) -> (Box<PageKey>, OwnerOnlyText) {
    (
        Box::new(page_plain(cur, true, cx)),
        owner_only_text(cur, cx.s),
    )
}

fn fact_for_caller(cur: &Cur, cx: Cx) -> FactKey {
    FactKey::ForCaller {
        provenance: provenance_fragment(cur, cx),
        entity: Box::new(entity(cur, cx)),
        labelled: labelled_fact(cur, cx.s),
    }
}

fn fact_floor(cur: &Cur, cx: Cx) -> FactKey {
    FactKey::Floor {
        provenance: provenance_fragment(cur, cx),
        labelled: labelled_fact(cur, cx.s),
    }
}

/// The fact fragment a fact policy compares (`rendered` in `storePrivacyPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactFragment {
    /// `privateProvenanceFilterUnderPolicy('facts')`.
    UnderPolicy,
    /// `privateFactFilterForCaller('facts')`.
    ForCaller,
    /// `privateFactFilterForReader('facts')`: the first for an owner, the second otherwise.
    ForReader,
}

fn fact_fragment(f: FactFragment, cur: &Cur, cx: Cx) -> FactKey {
    match f {
        FactFragment::UnderPolicy => fact_under_policy(cur, cx),
        FactFragment::ForCaller => fact_for_caller(cur, cx),
        FactFragment::ForReader if eff(cur, cx.s).owner => fact_under_policy(cur, cx),
        FactFragment::ForReader => fact_for_caller(cur, cx),
    }
}

// ---------------------------------------------------------------------------------------------
// Flags read off a matched reference (`pagePolicyFlags`, `factPolicyFlags`).
// ---------------------------------------------------------------------------------------------

/// The privacy part of a page key is present (`sql.includes(privateSnapshotFilterFragment(alias))`).
fn page_has_privacy(k: &PageKey) -> bool {
    match k {
        PageKey::Base { privacy, .. } => matches!(privacy, PrivacyKey::Part { .. }),
        PageKey::FloorLabelled { plain, .. } => page_has_privacy(plain),
        PageKey::False => false,
    }
}

/// The owner-only test of a page key's access part.
fn page_owner_only(k: &PageKey) -> OwnerOnlyText {
    let of = |a: &AccessKey| match a {
        AccessKey::Short(o) => *o,
        AccessKey::Full { owner_only, .. } => *owner_only,
        AccessKey::Lineage(l) => match l.as_ref() {
            LineageKey::Short { owner_only, .. } | LineageKey::Full { owner_only, .. } => {
                *owner_only
            }
        },
    };
    match k {
        PageKey::Base { access, .. } => of(access),
        PageKey::FloorLabelled { plain, .. } => page_owner_only(plain),
        PageKey::False => OwnerOnlyText::None,
    }
}

/// `pagePolicyFlags(text)`.
fn page_flags(k: &PageKey, s: &AccessSettings) -> Map<String, Value> {
    let privacy = page_has_privacy(k);
    let mut m = Map::new();
    m.insert("honorAliases".into(), json!(s.honor_aliases && privacy));
    m.insert("entityPrivacy".into(), json!(privacy));
    m.insert(
        "ownerOnly".into(),
        json!(owner_only_flag(page_owner_only(k))),
    );
    m
}

/// The provenance page's privacy part is present (`sql.includes(privacyAliasSql('pp'))` with the
/// aliases honoured, `privateSnapshotFilterFragment('pp')` in general).
fn fact_pp_privacy(k: &FactKey) -> bool {
    match k {
        FactKey::UnderPolicy {
            member, otherwise, ..
        } => {
            let other = match otherwise.as_ref() {
                ProvenancePolicy::Plain(p) => page_has_privacy(p),
                ProvenancePolicy::Lineage {
                    member_pages,
                    privacy,
                    ..
                } => page_has_privacy(member_pages) || matches!(privacy, PrivacyKey::Part { .. }),
            };
            other || member.as_ref().is_some_and(|(_, p)| page_has_privacy(p))
        }
        FactKey::ForCaller { provenance, .. } | FactKey::Floor { provenance, .. } => {
            page_has_privacy(&provenance.0)
        }
    }
}

fn fact_owner_only(k: &FactKey) -> OwnerOnlyText {
    match k {
        FactKey::UnderPolicy { owner_only, .. } => *owner_only,
        FactKey::ForCaller { provenance, .. } | FactKey::Floor { provenance, .. } => provenance.1,
    }
}

/// `factPolicyFlags(text)`.
fn fact_flags(k: &FactKey, s: &AccessSettings) -> Map<String, Value> {
    let entity_privacy = match k {
        FactKey::UnderPolicy { entity, .. } | FactKey::ForCaller { entity, .. } => {
            page_has_privacy(&entity.policy)
        }
        FactKey::Floor { .. } => false,
    };
    let mut m = Map::new();
    m.insert(
        "honorAliases".into(),
        json!(s.honor_aliases && fact_pp_privacy(k)),
    );
    m.insert("entityPrivacy".into(), json!(entity_privacy));
    m.insert(
        "ownerOnly".into(),
        json!(owner_only_flag(fact_owner_only(k))),
    );
    m
}

// ---------------------------------------------------------------------------------------------
// The requests and the derivation.
// ---------------------------------------------------------------------------------------------

/// What a member asks the store to derive: one variant per TypeScript chokepoint, with the inputs
/// that helper reads besides the caller record.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeriveRequest {
    /// `storePageTextPolicy(member, rendered, opts)`.
    PageText {
        fragment: PageFragment,
        #[serde(default, rename = "callerReaders")]
        caller_readers: bool,
        #[serde(default, rename = "noReaders")]
        no_readers: bool,
        /// The record the call site rendered its fragment in, when that is not the current one (the
        /// text is then fixed: countOpenPages renders it before it enters the empty-identity record).
        #[serde(default, rename = "renderedIn")]
        rendered_in: Option<Box<RenderedIn>>,
    },
    /// `storePrivacyPolicy(member, excludePrivate, rendered, opts)`.
    Fact {
        #[serde(rename = "excludePrivate")]
        exclude_private: bool,
        fragment: FactFragment,
        #[serde(default, rename = "callerReaders")]
        caller_readers: bool,
    },
    /// `storeFloorPolicy(member)`.
    FloorPolicy {},
    /// `storeMemberReadPolicy(member, q)`.
    MemberRead {
        owner: bool,
        identity: Vec<String>,
        satisfied: Vec<String>,
    },
    /// page-visibility.ts `callerPolicy(member, 'access')`.
    MemberAccess {},
    /// `storeRemoteFloor(member)`.
    RemoteFloor {},
    /// `storeVisibility(member, visibility)`.
    Visibility {
        #[serde(default)]
        list: Option<Vec<String>>,
    },
    /// `pagePolicyFlags(privatePagesFilterFragment('p'))`: the no-caller page policy's flags.
    PlainPageFlags {},
    /// The member-access part alone for the caller, unwidened (`retirementHopPolicy`'s `access` branch,
    /// store-members/cli-entities.ts).
    AccessPartPlain {},
    /// A member-access policy for an explicit identity and satisfied set (`memberAccessPolicy`,
    /// store-members/list-reads.ts); no identity for the folder-rules read.
    MemberAccessPolicy {
        #[serde(default)]
        identity: Option<Vec<String>>,
        satisfied: Vec<String>,
    },
    /// The owner-only form a take or timeline row is read under (`rowOwnerOnly`, store-members/write-attribution.ts).
    RowOwnerOnly {},
    /// An owner read of a fact's pages (`storeOwnerReachPolicy`, store-members/private-provenance.ts).
    OwnerReach {
        identity: Vec<String>,
        satisfied: Vec<String>,
    },
    /// The open-page count's member-access floor (`countOpenPages`, store-members/access-setup.ts).
    OpenPageFloor {},
    /// A writer's read policy (`writerPolicy`, store-members/remote-links.ts readLinkTargetPages).
    WriterPolicy { policy: WriterReadPolicyIn },
    /// The snapshot visibility a version pick reports (`pickValidTimeEdition`, store-members/trust-tier-reads.ts)
    /// is the canonical one for the page policy's readers.
    SnapshotPolicy {
        identity: Vec<String>,
        #[serde(rename = "privateReadableSources")]
        private_readable_sources: Vec<String>,
    },
    /// `pagePolicyFlags(privacyPartSql('p')).honorAliases` (readPagePrivacyHidden).
    PrivacyPartAliases {},
    /// `enforcedMemberPolicy` (store-members/page-mutation-reads.ts): the policy of one of the enforced member CLI's reads
    /// around a write, for the member's `identity` and the rules it `satisfied`.
    EnforcedMemberPolicy {
        view: EnforcedView,
        identity: Vec<String>,
        satisfied: Vec<String>,
    },
}

/// The text an enforced member read judges a page by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcedView {
    /// `memberViewPolicySql(identity, satisfied, false)`: `readPolicyFragment('p', identity, true, satisfied)`.
    MemberView,
    /// `hiddenSlugsPolicySql()`: the caller's member access, then the privacy part.
    HiddenSlugs,
}

/// The context a fixed fragment text was rendered in: a record, or none.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderedIn {
    #[serde(default)]
    pub record: Option<CallerRecord>,
}

/// A writer's read policy (`WriterReadPolicy`, engine-sql/remote-links.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterReadPolicyIn {
    pub identities: Vec<Vec<String>>,
    pub satisfied_rule_ids: Vec<String>,
    pub folder_coverage: Vec<Coverage>,
    pub owner: bool,
    pub labelled_only: bool,
}

/// The per-call derivation context: immutable, everything the renderer read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessContext {
    /// `callerAccessRecord()`: none outside a caller record (distinct from an empty record).
    #[serde(default)]
    pub record: Option<CallerRecord>,
    pub settings: AccessSettings,
    pub request: DeriveRequest,
}

/// The store's answer, in the exact JSON shape the TypeScript helper returns, so the self-check
/// compares values and server mode can hand the same value to the store's policy readers.
#[derive(Debug, Clone, PartialEq)]
pub enum Derived {
    /// The helper's value (a policy, a visibility record, a remote floor, a flag).
    Value(Value),
    /// The helper returns `undefined` (no policy asked for).
    None,
    /// The helper refuses with `engine_capability_missing`.
    Refuse(&'static str),
}

impl Derived {
    /// The JSON the self-check compares: the value, `{"$none": true}` or `{"$refuse": true}`.
    pub fn to_json(&self) -> Value {
        match self {
            Derived::Value(v) => v.clone(),
            Derived::None => json!({ "$none": true }),
            Derived::Refuse(why) => json!({ "$refuse": true, "why": why }),
        }
    }
}

/// The caller's reader record (`StoreCallerReaders`).
struct Readers {
    identity: Vec<String>,
    private_readable_sources: Vec<String>,
}

/// `judgeWidenedCaller(judge)`.
fn judge_widened<T>(
    cur: &Cur,
    s: &AccessSettings,
    judge: impl Fn(&Cur, &Readers) -> Option<T>,
) -> Option<T> {
    let a = eff(cur, s);
    let readers = Readers {
        identity: a.identity.clone(),
        private_readable_sources: a.private_readable_sources.clone(),
    };
    if let Some(v) = judge(cur, &readers) {
        return Some(v);
    }
    if a.restricted {
        return None;
    }
    let cur2 = with(
        cur,
        &Patch {
            restricted: Some(true),
            ..Patch::default()
        },
        s,
    );
    judge(&cur2, &readers)
}

fn readers_patch(r: &Readers) -> Patch {
    Patch {
        identity: Some(r.identity.clone()),
        private_readable_sources: Some(r.private_readable_sources.clone()),
        ..Patch::default()
    }
}

fn with_readers(m: &mut Map<String, Value>, r: &Readers) {
    m.insert("identity".into(), json!(r.identity));
    m.insert(
        "privateReadableSources".into(),
        json!(r.private_readable_sources),
    );
}

fn with_open(mut v: Map<String, Value>, open: bool) -> Value {
    if open {
        v.insert("open".into(), json!(true));
    }
    Value::Object(v)
}

/// `CallerReference` (private-provenance.ts `callerReference`): what the caller's own grants add to a fresh reference record\n/// (`record`: the labelled-only grant and a member's lineage read) and to the policy the store reads (`flags`: `ownerRead`, and\n/// `labelledOnly` with the member a fact is read on).
struct CallerReference {
    record: Patch,
    flags: Map<String, Value>,
}

/// `callerReference()`, in the record `cur`: none when the caller's grants are not modelled (a labelled-only audience of
/// several identities). The owner's own lineage is the owner record's, never this: an owner has an empty reference.
fn caller_reference(cur: &Cur, s: &AccessSettings) -> Option<CallerReference> {
    let a = eff(cur, s);
    let none = CallerReference {
        record: Patch::default(),
        flags: Map::new(),
    };
    if a.owner {
        return Some(none);
    }
    if a.labelled_only && !a.audience_identities.is_empty() {
        return None;
    }
    let lone = a
        .identity
        .iter()
        .find_map(|p| p.strip_prefix("member:"))
        .map(str::to_string);
    let member = a.actor.as_ref().map(|x| x.member.clone()).or(lone);
    let mut flags = Map::new();
    if a.lineage {
        flags.insert("ownerRead".into(), json!(true));
    }
    if a.labelled_only {
        let terms = labelled(&a);
        let mut t = Map::new();
        t.insert("identity".into(), json!(terms.identity));
        t.insert("satisfiedRuleIds".into(), json!(terms.satisfied));
        if a.lineage {
            t.insert("lineage".into(), json!(true));
        }
        if let Some(m) = member.filter(|m| !m.is_empty()) {
            t.insert("member".into(), json!(m));
        }
        flags.insert("labelledOnly".into(), Value::Object(t));
    }
    Some(CallerReference {
        record: Patch {
            labelled_only: a.labelled_only.then_some(true),
            lineage: a.lineage.then_some(true),
            ..Patch::default()
        },
        flags,
    })
}

/// `{ ...patch, ...reference.record }`: the grants the caller's own record adds to a reference record.
fn with_grants(mut patch: Patch, reference: &Patch) -> Patch {
    if reference.labelled_only.is_some() {
        patch.labelled_only = reference.labelled_only;
    }
    if reference.lineage.is_some() {
        patch.lineage = reference.lineage;
    }
    patch
}

/// `{ ...map, ...flags }`.
fn merge_flags(m: &mut Map<String, Value>, flags: &Map<String, Value>) {
    for (k, v) in flags {
        m.insert(k.clone(), v.clone());
    }
}

/// `storePageTextPolicy`.
fn derive_page_text(
    cur: &Cur,
    s: &AccessSettings,
    fragment: PageFragment,
    caller_readers: bool,
    no_readers: bool,
    rendered_in: Option<&RenderedIn>,
) -> Derived {
    let open_flag = !eff(cur, s).restricted;
    let cx = Cx { s, norm: true };
    let fixed = rendered_in.map(|r| page_fragment(fragment, &r.record, cx));
    let policy = judge_widened(cur, s, |cur2, caller_readers_rec| {
        let access = eff(cur2, s);
        let open = !access.restricted;
        let text = fixed
            .clone()
            .unwrap_or_else(|| page_fragment(fragment, cur2, cx));
        let base_patch = if open {
            Patch {
                restricted: Some(false),
                ..Patch::default()
            }
        } else {
            Patch::default()
        };
        let baseline_cur = reference(cur2, base_patch, !open, s);
        let baseline = page_caller(&baseline_cur, cx);
        if text == baseline {
            return Some(page_flags(&baseline, s));
        }
        // The remote read floor: the no-caller page policy of a fresh record (privacy on), served as a caller record
        // with no readers, grants or coverage.
        let floor_patch = Patch {
            hide_private: Some(true),
            restricted: open.then_some(false),
            ..Patch::default()
        };
        let floor = page_plain(&reference(cur2, floor_patch, false, s), false, cx);
        if text == floor {
            let mut m = page_flags(&floor, s);
            m.insert("identity".into(), json!([]));
            m.insert("privateReadableSources".into(), json!([]));
            m.insert("callerRecord".into(), json!(true));
            return Some(m);
        }
        // The remote read floor under a caller record that holds pending folder prefixes, and that of a labelled-only caller: the
        // plain fragment (ANDed, for a labelled-only caller, with its conjunct), rendered in the caller's record. The record's
        // coverage is sent with the labelled-only terms.
        if !access.owner
            && access.audience_identities.is_empty()
            && (access.labelled_only || !access.folder_coverage.is_empty())
        {
            let terms = if access.labelled_only {
                caller_reference(cur2, s).and_then(|r| r.flags.get("labelledOnly").cloned())
            } else {
                None
            };
            let mut patch = readers_patch(caller_readers_rec);
            patch.satisfied_rule_ids = Some(access.satisfied_rule_ids.clone());
            patch.folder_coverage = Some(access.folder_coverage.clone());
            if access.labelled_only {
                patch.labelled_only = Some(true);
                if access.lineage {
                    patch.lineage = Some(true);
                }
            }
            patch.hide_private = Some(true);
            patch.restricted = Some(!open);
            let caller_floor = page_floor(&reference(cur2, patch, false, s), cx);
            if (terms.is_some() || !access.labelled_only) && text == caller_floor {
                let mut m = page_flags(&caller_floor, s);
                m.insert("identity".into(), json!([]));
                m.insert("privateReadableSources".into(), json!([]));
                m.insert("callerRecord".into(), json!(true));
                if !access.folder_coverage.is_empty() {
                    m.insert(
                        "folderCoverage".into(),
                        serde_json::to_value(&access.folder_coverage).unwrap_or(Value::Null),
                    );
                }
                if let Some(t) = terms {
                    m.insert("labelledOnly".into(), t);
                }
                return Some(m);
            }
        }
        if !caller_readers && !no_readers {
            return None;
        }
        if no_readers {
            let patch = Patch {
                identity: Some(vec![]),
                private_readable_sources: Some(vec![]),
                hide_private: Some(true),
                restricted: Some(!open),
                ..Patch::default()
            };
            let canonical = page_caller(&reference(cur2, patch, false, s), cx);
            if text != canonical {
                return None;
            }
            let mut m = page_flags(&canonical, s);
            m.insert("identity".into(), json!([]));
            m.insert("privateReadableSources".into(), json!([]));
            return Some(m);
        }
        let satisfied = access.satisfied_rule_ids.clone();
        let cov = access.folder_coverage.clone();
        let mut patch = readers_patch(caller_readers_rec);
        patch.satisfied_rule_ids = Some(satisfied.clone());
        patch.folder_coverage = Some(cov.clone());
        patch.hide_private = Some(true);
        patch.restricted = Some(!open);
        // The caller's labelled-only grant and lineage read ride in the reference record and in the flags the store reads.
        let caller_ref = caller_reference(cur2, s);
        let canonical = page_caller(
            &reference(
                cur2,
                with_grants(
                    patch.clone(),
                    caller_ref.as_ref().map_or(&Patch::default(), |r| &r.record),
                ),
                false,
                s,
            ),
            cx,
        );
        let stored = |m: &mut Map<String, Value>| {
            if !satisfied.is_empty() {
                m.insert("satisfiedRuleIds".into(), json!(satisfied));
            }
            if !cov.is_empty() {
                m.insert(
                    "folderCoverage".into(),
                    serde_json::to_value(&cov).unwrap_or(Value::Null),
                );
            }
            m.insert("callerRecord".into(), json!(true));
        };
        if let Some(r) = &caller_ref
            && text == canonical
        {
            let mut m = page_flags(&canonical, s);
            with_readers(&mut m, caller_readers_rec);
            stored(&mut m);
            merge_flags(&mut m, &r.flags);
            return Some(m);
        }
        if caller_readers && access.owner {
            let mut owner_patch = patch;
            owner_patch.hide_private = Some(access.hide_private);
            owner_patch.owner = Some(true);
            if access.owner_reads == Some(true) {
                owner_patch.owner_reads = Some(true);
            }
            let owner = page_caller(&reference(cur2, owner_patch.clone(), false, s), cx);
            if text == owner {
                let mut m = page_flags(&owner, s);
                with_readers(&mut m, caller_readers_rec);
                stored(&mut m);
                return Some(m);
            }
            // The remote owner's lineage read (the opt-in off, no audience members): the owner read rule.
            if owner_lineage_served(&access) {
                let mut lineage_patch = owner_patch;
                lineage_patch.lineage = Some(true);
                let lineage = page_caller(&reference(cur2, lineage_patch, false, s), cx);
                if text == lineage {
                    let mut m = page_flags(&lineage, s);
                    with_readers(&mut m, caller_readers_rec);
                    stored(&mut m);
                    m.insert("ownerRead".into(), json!(true));
                    return Some(m);
                }
            }
        }
        None
    });
    match policy {
        Some(m) => Derived::Value(with_open(m, open_flag)),
        None => Derived::Refuse(
            "excludePrivate for a caller whose member pages, grants or lineage widen the policy",
        ),
    }
}

/// Which fact record a policy matched (`storePrivacyPolicy`'s record list).
#[derive(Clone, Copy, Default)]
struct FactRecord {
    owner: bool,
    folders: bool,
    lineage: bool,
}

/// The remote owner's lineage read is served as the owner read rule: a lineage read with the owner opt-in off and
/// no audience-kind members (`access.lineage && !access.ownerReadsRestricted && !access.audienceKindMembers.length`).
fn owner_lineage_served(access: &CallerRecord) -> bool {
    access.lineage && !access.owner_reads_restricted && access.audience_kind_members.is_empty()
}

/// `storePrivacyPolicy`.
fn derive_fact(
    cur: &Cur,
    s: &AccessSettings,
    exclude_private: bool,
    fragment: FactFragment,
    caller_readers: bool,
) -> Derived {
    if !exclude_private {
        return Derived::None;
    }
    let open_flag = !eff(cur, s).restricted;
    let cx = Cx { s, norm: true };
    let forms = [
        (FactFragment::UnderPolicy, true),
        (FactFragment::ForCaller, false),
    ];
    let policy = judge_widened(cur, s, |cur2, readers| {
        let open = !eff(cur2, s).restricted;
        let text = fact_fragment(fragment, cur2, cx);
        for (form, _) in forms {
            let base_patch = if open {
                Patch {
                    restricted: Some(false),
                    ..Patch::default()
                }
            } else {
                Patch::default()
            };
            let baseline_cur = reference(cur2, base_patch, !open, s);
            let baseline = fact_fragment(form, &baseline_cur, cx);
            if text == baseline {
                return Some(fact_flags(&baseline, s));
            }
        }
        if !caller_readers {
            return None;
        }
        let own = readers
            .identity
            .iter()
            .find_map(|p| p.strip_prefix("member:"))
            .map(str::to_string);
        let access = eff(cur2, s);
        // The caller's own folder rules and pending prefixes (`callerFolders`); a satisfied rule is sent only when every
        // id is a valid qualified id, as sharedHeldRuledSql renders it.
        let satisfied = access.satisfied_rule_ids.clone();
        let cov = access.folder_coverage.clone();
        let valid_rules = satisfied.iter().all(|r| valid_rule_id(r));
        let with_folders = |p: &mut Patch| {
            p.satisfied_rule_ids = Some(satisfied.clone());
            p.folder_coverage = Some(cov.clone());
        };
        // A labelled-only grant rides in the reference record and the flags (`callerReference`). A lineage read refuses: the
        // fact policy under lineage judges every provenance page by the member's lineage, which the store does not model.
        let reference_grants = if access.lineage && !access.owner {
            None
        } else {
            caller_reference(cur2, s)
        };
        let Some(grants) = reference_grants else {
            return None;
        };
        let mut records: Vec<(Patch, FactRecord)> = Vec::new();
        let mut reader = readers_patch(readers);
        reader.hide_private = Some(true);
        reader.restricted = Some(!open);
        records.push((
            with_grants(reader.clone(), &grants.record),
            FactRecord::default(),
        ));
        if !satisfied.is_empty() || !cov.is_empty() {
            let mut folder = with_grants(reader.clone(), &grants.record);
            with_folders(&mut folder);
            let kind = FactRecord {
                folders: true,
                ..FactRecord::default()
            };
            records.push((folder, kind));
        }
        if access.owner {
            let mut owner = reader;
            owner.hide_private = Some(access.hide_private);
            owner.owner = Some(true);
            if access.owner_reads == Some(true) {
                owner.owner_reads = Some(true);
            }
            let kind = FactRecord {
                owner: true,
                ..FactRecord::default()
            };
            records.push((owner.clone(), kind));
            // The remote owner's lineage read (the opt-in off, no audience members), with its folders.
            if owner_lineage_served(&access) {
                let mut lineage = owner;
                with_folders(&mut lineage);
                lineage.lineage = Some(true);
                let kind = FactRecord {
                    owner: true,
                    folders: true,
                    lineage: true,
                };
                records.push((lineage, kind));
            }
        }
        for (record, kind) in records {
            let is_owner_record = kind.owner;
            let rec_cur = reference(cur2, record, false, s);
            for (form, member_case) in forms {
                let canonical = fact_fragment(form, &rec_cur, cx);
                if text != canonical {
                    continue;
                }
                let member_page = own.as_ref().map(|m| format!("{MEMBER_PAGE_PREFIX}{m}"));
                // `canonical.includes(`pp.slug = '${memberPage}'`)`: the member case renders it only for
                // a member id that passes ACCESS_ID_RE.
                let judged = member_case
                    && member_page.is_some()
                    && matches!(&canonical, FactKey::UnderPolicy { member: Some((m, _)), .. } if own.as_deref() == Some(m.as_str()));
                let provenance_privacy_off = is_owner_record && !fact_pp_privacy(&canonical);
                let mut m = fact_flags(&canonical, s);
                with_readers(&mut m, readers);
                if judged {
                    m.insert("memberPage".into(), json!(member_page));
                }
                if kind.folders {
                    if !satisfied.is_empty() && valid_rules {
                        m.insert("satisfiedRuleIds".into(), json!(satisfied));
                    }
                    if !cov.is_empty() {
                        m.insert(
                            "folderCoverage".into(),
                            serde_json::to_value(&cov).unwrap_or(Value::Null),
                        );
                    }
                }
                if provenance_privacy_off {
                    m.insert("provenancePrivacyOff".into(), json!(true));
                }
                merge_flags(&mut m, &grants.flags);
                if kind.lineage {
                    m.insert("ownerRead".into(), json!(true));
                }
                return Some(m);
            }
        }
        None
    });
    match policy {
        Some(m) => Derived::Value(with_open(m, open_flag)),
        None => Derived::Refuse(
            "excludePrivate for a caller whose member pages, grants or lineage widen the policy",
        ),
    }
}

/// `storeFloorPolicy`.
fn derive_floor_policy(cur: &Cur, s: &AccessSettings) -> Derived {
    let cx = Cx { s, norm: true };
    let text = fact_floor(cur, cx);
    let floor = |k: &FactKey, open: bool| {
        let mut m = fact_flags(k, s);
        m.insert("entityPrivacy".into(), json!(false));
        m.insert("provenanceOnly".into(), json!(true));
        Derived::Value(with_open(m, open))
    };
    let unscoped = fact_floor(&None, cx);
    if text == unscoped {
        return floor(&unscoped, false);
    }
    let a = eff(cur, s);
    let patch = Patch {
        restricted: Some(a.restricted),
        owner: Some(a.owner),
        ..Patch::default()
    };
    let fresh = fact_floor(&reference(cur, patch, false, s), cx);
    if text == fresh {
        return floor(&fresh, !a.restricted);
    }
    Derived::Refuse(
        "the remote provenance floor for a caller whose labelled-only grant, folder coverage or relaxed privacy changes it",
    )
}

/// `storeMemberReadPolicy` and `storeOwnerReadPolicy`.
fn derive_member_read(
    cur: &Cur,
    s: &AccessSettings,
    owner: bool,
    identity: &[String],
    satisfied: &[String],
) -> Derived {
    let cx = Cx { s, norm: true };
    if !satisfied.is_empty() {
        return Derived::Refuse("a member page whose reader meets a folder rule");
    }
    // `identity.every(id => text.includes(`'${id}'`))`: the text names every id exactly when the
    // readers test lists them; an invalid identity is refused (see the module comment).
    let named_in_text = identity.is_empty() || valid_identity(identity);
    if owner {
        let text = owner_read_policy(identity, &[], cur, cx);
        let refc = owner_read_policy(
            identity,
            &[],
            &reference(cur, Patch::default(), true, s),
            cx,
        );
        if text != PageKey::False && text == refc && named_in_text {
            let flags = page_flags(&refc, s);
            if flags.get("ownerOnly") == Some(&json!("off")) {
                let mut m = flags;
                m.insert("identity".into(), json!(identity));
                m.insert("ownerRead".into(), json!(true));
                return Derived::Value(Value::Object(m));
            }
        }
        return Derived::Refuse(
            "an owner read of a member page whose policy is not the one the store models",
        );
    }
    let text = read_policy(identity, true, Some(satisfied), false, cur, cx);
    let open = !eff(cur, s).restricted;
    let base_patch = if open {
        Patch {
            restricted: Some(false),
            ..Patch::default()
        }
    } else {
        Patch::default()
    };
    let refc = read_policy(
        identity,
        true,
        Some(&[]),
        false,
        &reference(cur, base_patch, !open, s),
        cx,
    );
    let named = open || named_in_text;
    if text == refc && named {
        let mut m = page_flags(&refc, s);
        m.insert("identity".into(), json!(identity));
        return Derived::Value(with_open(m, open));
    }
    Derived::Refuse("a member page read whose policy is not the one the store models")
}

/// page-visibility.ts `callerPolicy(member, 'access')`.
fn derive_member_access(cur: &Cur, s: &AccessSettings) -> Derived {
    let policy = judge_widened(cur, s, |cur2, readers| {
        let (text, lab) = caller_access(cur2, s);
        let text_oo = page_owner_only(&PageKey::Base {
            access: text.clone(),
            labelled: None,
            privacy: PrivacyKey::True,
        });
        let mut off = Map::new();
        off.insert("honorAliases".into(), json!(false));
        off.insert("entityPrivacy".into(), json!(false));
        off.insert("ownerOnly".into(), json!(owner_only_flag(text_oo)));
        let empty = caller_access(&reference(cur2, Patch::default(), true, s), s);
        if (text.clone(), lab.clone()) == empty {
            return Some(off);
        }
        let mut patch = readers_patch(readers);
        patch.hide_private = Some(true);
        let canonical = caller_access(&reference(cur2, patch.clone(), false, s), s);
        if (text.clone(), lab.clone()) == canonical {
            with_readers(&mut off, readers);
            return Some(off);
        }
        // The same record with the caller's folder rules (an ordinary member that satisfies a rule too), and with the grants
        // when it has any.
        let grants = caller_reference(cur2, s)?;
        let access = eff(cur2, s);
        patch.satisfied_rule_ids = Some(access.satisfied_rule_ids.clone());
        patch.folder_coverage = Some(access.folder_coverage.clone());
        let with_grants_ref = caller_access(
            &reference(cur2, with_grants(patch, &grants.record), false, s),
            s,
        );
        if (text, lab) != with_grants_ref {
            return None;
        }
        with_readers(&mut off, readers);
        off.insert("callerRecord".into(), json!(true));
        merge_flags(&mut off, &grants.flags);
        if !access.satisfied_rule_ids.is_empty() {
            off.insert("satisfiedRuleIds".into(), json!(access.satisfied_rule_ids));
        }
        if !access.folder_coverage.is_empty() {
            off.insert(
                "folderCoverage".into(),
                serde_json::to_value(&access.folder_coverage).unwrap_or(Value::Null),
            );
        }
        Some(off)
    });
    match policy {
        Some(m) => Derived::Value(Value::Object(m)),
        None => Derived::Refuse(
            "a caller whose member pages, grants or lineage widen the member-access policy",
        ),
    }
}

/// `storeRemoteFloor`.
fn derive_remote_floor(cur: &Cur, s: &AccessSettings) -> Derived {
    let cx = Cx { s, norm: true };
    let got = fact_floor(cur, cx);
    let floor = |k: &FactKey, restricted: bool| {
        Derived::Value(json!({
            "honorAliases": s.honor_aliases && fact_pp_privacy(k),
            "restricted": restricted,
            "ownerOnly": owner_only_flag(fact_owner_only(k)),
        }))
    };
    let unscoped = fact_floor(&None, cx);
    if got == unscoped {
        return floor(&unscoped, true);
    }
    let a = eff(cur, s);
    let patch = Patch {
        restricted: Some(a.restricted),
        owner: Some(a.owner),
        remote_policy: Some(a.remote_policy.clone()),
        ..Patch::default()
    };
    let fresh = fact_floor(&fresh_record(&patch, s), cx);
    if got != fresh {
        return Derived::Refuse(
            "a remote provenance floor the store does not model (a labelled-only caller, folder coverage or a relaxed privacy setting)",
        );
    }
    floor(&fresh, a.restricted)
}

/// `callerMember()` (access/member-facts.ts).
fn caller_member(cur: &Cur, s: &AccessSettings) -> Option<String> {
    let a = eff(cur, s);
    if let Some(actor) = &a.actor {
        // `if (!member) return 'FALSE'`: an empty member widens nothing.
        return (!actor.member.is_empty()).then(|| actor.member.clone());
    }
    if !a.audience_identities.is_empty() {
        return None;
    }
    a.identity
        .iter()
        .find_map(|p| p.strip_prefix("member:"))
        .filter(|m| access_id_ok(m))
        .map(str::to_string)
}

/// `privateFactSources()`.
fn private_fact_sources(cur: &Cur, s: &AccessSettings) -> Vec<String> {
    let a = eff(cur, s);
    if a.audience.is_some() || a.actor.is_some() || a.labelled_only {
        vec![]
    } else {
        a.private_fact_sources
    }
}

/// The member-page widening of a visibility list (`memberFactAdmitSql`): the member and its page policy.
type MemberWidening = Option<(String, PageKey)>;
/// The private-facts grant widening (`grantedPrivateFactSql`): the granted sources, and the member widening it reads.
type GrantWidening = Option<(Vec<String>, MemberWidening)>;

/// `factVisibilitySql(facts, list)`: the listed values, and the member-page and grant widenings.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VisibilityKey {
    listed: Vec<&'static str>,
    widened: Option<(MemberWidening, GrantWidening)>,
}

fn visibility_key(list: &[String], cur: &Cur, cx: Cx) -> VisibilityKey {
    let known: Vec<&'static str> = ["world", "private"]
        .into_iter()
        .filter(|v| list.iter().any(|x| x == v))
        .collect();
    if known.contains(&"private") {
        return VisibilityKey {
            listed: known,
            widened: None,
        };
    }
    let member = caller_member(cur, cx.s).map(|m| (m, page_caller(cur, cx)));
    let sources = private_fact_sources(cur, cx.s);
    let granted = (!sources.is_empty()).then(|| (sources, member.clone()));
    if member.is_none() && granted.is_none() {
        return VisibilityKey {
            listed: known,
            widened: None,
        };
    }
    VisibilityKey {
        listed: known,
        widened: Some((member, granted)),
    }
}

/// `storeVisibility`.
fn derive_visibility(cur: &Cur, s: &AccessSettings, list: Option<&[String]>) -> Derived {
    let Some(list) = list.filter(|l| !l.is_empty()) else {
        return Derived::Value(json!({}));
    };
    let cx = Cx { s, norm: false };
    let text = visibility_key(list, cur, cx);
    if text.widened.is_none() {
        return Derived::Value(json!({ "visibility": list }));
    }
    let open_flag = !eff(cur, s).restricted;
    let widen = judge_widened(cur, s, |cur2, readers| {
        let text = visibility_key(list, cur2, cx);
        let pfs = private_fact_sources(cur2, s);
        // `callerFolders()`: the caller's own folder rules and pending prefixes.
        let access = eff(cur2, s);
        let satisfied = access.satisfied_rule_ids.clone();
        let cov = access.folder_coverage.clone();
        let with_folders = !satisfied.is_empty() || !cov.is_empty();
        // The labelled-only grant and a lineage read change how the member page is judged (`callerReference`), never what
        // else is shown.
        let grants = caller_reference(cur2, s)?;
        let records: &[bool] = if with_folders {
            &[false, true]
        } else {
            &[false]
        };
        for &folders in records {
            let mut patch = readers_patch(readers);
            if folders {
                patch.satisfied_rule_ids = Some(satisfied.clone());
                patch.folder_coverage = Some(cov.clone());
            }
            patch.private_fact_sources = Some(pfs.clone());
            patch.hide_private = Some(true);
            let fresh_cur = reference(cur2, with_grants(patch, &grants.record), false, s);
            if text != visibility_key(list, &fresh_cur, cx) {
                continue;
            }
            let fresh_pfs = eff(&fresh_cur, s).private_fact_sources;
            let mut m = Map::new();
            if let Some(member) = caller_member(&fresh_cur, s) {
                // `callerReadersPagePolicy(readers)`, or `callerFoldersPagePolicy(readers, folders)`, with the outer `open` flag.
                let mut pp = Patch {
                    identity: Some(readers.identity.clone()),
                    private_readable_sources: Some(readers.private_readable_sources.clone()),
                    hide_private: Some(true),
                    ..Patch::default()
                };
                if folders {
                    pp.satisfied_rule_ids = Some(satisfied.clone());
                    pp.folder_coverage = Some(cov.clone());
                }
                let page = page_caller(&reference(cur2, pp, false, s), Cx { s, norm: false });
                let mut policy = page_flags(&page, s);
                with_readers(&mut policy, readers);
                if folders {
                    policy.insert("callerRecord".into(), json!(true));
                    if !satisfied.is_empty() {
                        policy.insert("satisfiedRuleIds".into(), json!(satisfied));
                    }
                    if !cov.is_empty() {
                        policy.insert(
                            "folderCoverage".into(),
                            serde_json::to_value(&cov).unwrap_or(Value::Null),
                        );
                    }
                }
                merge_flags(&mut policy, &grants.flags);
                m.insert("member".into(), json!(member));
                m.insert("memberPagePolicy".into(), with_open(policy, open_flag));
            }
            m.insert("privateFactSources".into(), json!(fresh_pfs));
            return Some(Value::Object(m));
        }
        None
    });
    match widen {
        Some(w) => Derived::Value(json!({ "visibility": list, "widen": w })),
        None => Derived::Refuse(
            "a visibility list widened by member pages or grants for a caller the store does not model",
        ),
    }
}

/// `{ honorAliases: false, entityPrivacy: false, ownerOnly }` for a member-access text (no privacy part).
fn access_off(access: &AccessKey) -> Map<String, Value> {
    let oo = page_owner_only(&PageKey::Base {
        access: access.clone(),
        labelled: None,
        privacy: PrivacyKey::True,
    });
    let mut m = Map::new();
    m.insert("honorAliases".into(), json!(false));
    m.insert("entityPrivacy".into(), json!(false));
    m.insert("ownerOnly".into(), json!(owner_only_flag(oo)));
    m
}

/// `retirementHopPolicy`'s `access` branch: member access alone when the caller's text is the no-record one, or the
/// one a fresh record (no remote policy) of the caller's readers renders.
fn derive_access_part_plain(cur: &Cur, s: &AccessSettings) -> Derived {
    let text = caller_access(cur, s);
    let mut off = access_off(&text.0);
    if text == caller_access(&None, s) {
        return Derived::Value(Value::Object(off));
    }
    let a = eff(cur, s);
    let patch = Patch {
        identity: Some(a.identity.clone()),
        private_readable_sources: Some(a.private_readable_sources.clone()),
        hide_private: Some(true),
        ..Patch::default()
    };
    if text == caller_access(&fresh_record(&patch, s), s) {
        off.insert("identity".into(), json!(a.identity));
        off.insert(
            "privateReadableSources".into(),
            json!(a.private_readable_sources),
        );
        return Derived::Value(Value::Object(off));
    }
    Derived::Refuse("a caller whose member pages, grants or lineage widen the member-access policy")
}

/// `memberAccessPolicy` (store-members/list-reads.ts).
fn derive_member_access_policy(
    cur: &Cur,
    s: &AccessSettings,
    identity: Option<&[String]>,
    satisfied: &[String],
) -> Derived {
    let a = eff(cur, s);
    let owner_only = match identity {
        Some(id) => owner_only_flag(page_owner_only(&PageKey::Base {
            access: access_allowed(id, None, false, cur, s),
            labelled: None,
            privacy: PrivacyKey::True,
        })),
        None => "off",
    };
    Derived::Value(json!({
        "honorAliases": false,
        "entityPrivacy": false,
        "identity": identity.unwrap_or_default(),
        "satisfiedRuleIds": satisfied,
        "folderCoverage": serde_json::to_value(&a.folder_coverage).unwrap_or(Value::Null),
        "callerRecord": true,
        "ownerOnly": owner_only,
        "open": !a.restricted,
    }))
}

/// `storeOwnerReachPolicy`: the owner read of a fact's pages (`ownerReadPolicyFragment('pp')`) and its readable
/// rendering (`readPolicyFragment('pp', identity, true, satisfied)`) must both equal those of a reference record (no
/// record, the caller's folder coverage, or that and the owner flag); the owner text holds no owner-only test.
fn derive_owner_reach(
    cur: &Cur,
    s: &AccessSettings,
    identity: &[String],
    satisfied: &[String],
) -> Derived {
    let cx = Cx { s, norm: true };
    let owner = |c: &Cur| owner_read_policy(identity, satisfied, c, cx);
    let readable = |c: &Cur| read_policy(identity, true, Some(satisfied), false, c, cx);
    let owner_text = owner(cur);
    let readable_text = readable(cur);
    // `[...identity, ...satisfied].every(id => ownerText.includes(`'${id}'`))`: the owner text names an identity only
    // when it is valid, and a satisfied rule only when every one is a valid qualified id.
    let named = (identity.is_empty() || valid_identity(identity))
        && satisfied.iter().all(|r| valid_rule_id(r))
        && (owner_text != PageKey::False || (identity.is_empty() && satisfied.is_empty()));
    let a = eff(cur, s);
    let open = !a.restricted;
    if named {
        let in_record = || Patch {
            folder_coverage: Some(a.folder_coverage.clone()),
            restricted: Some(!open),
            ..Patch::default()
        };
        let base = if open {
            Patch {
                restricted: Some(false),
                ..Patch::default()
            }
        } else {
            Patch::default()
        };
        let refs: [(Patch, bool, bool); 3] = [
            (base, !open, open),
            (in_record(), false, true),
            (
                Patch {
                    owner: Some(true),
                    ..in_record()
                },
                false,
                true,
            ),
        ];
        for (patch, empty, caller_record) in refs {
            let rc = reference(cur, patch, empty, s);
            let owner_ref = owner(&rc);
            let readable_ref = readable(&rc);
            if owner_text != owner_ref || readable_text != readable_ref {
                continue;
            }
            let honor = s.honor_aliases && page_has_privacy(&readable_ref);
            if page_owner_only(&owner_ref) != OwnerOnlyText::None
                || (s.honor_aliases && page_has_privacy(&owner_ref)) != honor
            {
                continue;
            }
            let mut m = Map::new();
            m.insert("honorAliases".into(), json!(honor));
            m.insert("entityPrivacy".into(), json!(true));
            m.insert(
                "ownerOnly".into(),
                json!(owner_only_flag(page_owner_only(&readable_ref))),
            );
            m.insert("identity".into(), json!(identity));
            if !satisfied.is_empty() {
                m.insert("satisfiedRuleIds".into(), json!(satisfied));
            }
            if open {
                m.insert("open".into(), json!(true));
            }
            if caller_record {
                m.insert("callerRecord".into(), json!(true));
                if !a.folder_coverage.is_empty() {
                    m.insert(
                        "folderCoverage".into(),
                        serde_json::to_value(&a.folder_coverage).unwrap_or(Value::Null),
                    );
                }
            }
            return Derived::Value(Value::Object(m));
        }
    }
    Derived::Refuse("an owner read of a fact's pages whose policy is not one the store models")
}

/// `countOpenPages`'s floor: `accessAllowedSql('p', [], [])` must equal the no-caller member-access rendering, or the
/// rendering of a fresh record with no identity and the caller's folder coverage.
fn derive_open_page_floor(cur: &Cur, s: &AccessSettings) -> Derived {
    let floor = (access_allowed(&[], Some(&[]), false, cur, s), None);
    let mut access = access_off(&floor.0);
    if floor == caller_access(&reference(cur, Patch::default(), true, s), s) {
        return Derived::Value(Value::Object(access));
    }
    let a = eff(cur, s);
    let patch = Patch {
        identity: Some(vec![]),
        satisfied_rule_ids: Some(vec![]),
        folder_coverage: Some(a.folder_coverage.clone()),
        restricted: Some(a.restricted),
        ..Patch::default()
    };
    if floor != caller_access(&reference(cur, patch, false, s), s) {
        return Derived::Refuse("an open-page floor rendered in a caller record");
    }
    if !a.folder_coverage.is_empty() {
        access.insert(
            "folderCoverage".into(),
            serde_json::to_value(&a.folder_coverage).unwrap_or(Value::Null),
        );
    }
    Derived::Value(with_open(access, !a.restricted))
}

/// A page text that is a member-access part and `TRUE` (`callerAccessSql` for a reference record, `renderWriterReadPolicy` for a
/// writer whose labelled-only conjunct is judged apart: see [`derive_writer_policy`]).
#[derive(Debug, Clone, PartialEq, Eq)]
struct AccessAndTrue {
    inner: (AccessKey, Option<LabelledKey>),
}

/// `sqlAppliedSets(identity, satisfied)`: a whole set is emptied when any entry of it is invalid.
fn sql_applied_sets(identity: &[String], satisfied: &[String]) -> (Vec<String>, Vec<String>) {
    (
        if !identity.is_empty() && valid_identity(identity) {
            identity.to_vec()
        } else {
            vec![]
        },
        if !satisfied.is_empty() && satisfied.iter().all(|r| valid_rule_id(r)) {
            satisfied.to_vec()
        } else {
            vec![]
        },
    )
}

/// `writerPolicy` (store-members/access-policies.ts): a labelled-only writer's text is the rest of the policy ANDed with the
/// labelled-only conjunct, so the rest is served as for any writer and the conjunct goes to the store as data
/// (`labelledOnlyTerms`: the sets `labelledOnlySql` embeds).
fn derive_writer_policy(cur: &Cur, s: &AccessSettings, w: &WriterReadPolicyIn) -> Derived {
    if !w.labelled_only {
        return derive_unlabelled_writer_policy(cur, s, w);
    }
    let rest = derive_unlabelled_writer_policy(
        cur,
        s,
        &WriterReadPolicyIn {
            labelled_only: false,
            ..w.clone()
        },
    );
    let Derived::Value(Value::Object(mut m)) = rest else {
        return rest;
    };
    let terms = labelled(&CallerRecord {
        identity: vec![],
        audience_identities: w.identities.clone(),
        satisfied_rule_ids: w.satisfied_rule_ids.clone(),
        lineage: false,
        owner: false,
        ..eff(&None, s)
    });
    m.insert(
        "labelledOnly".into(),
        json!({ "identity": terms.identity, "satisfiedRuleIds": terms.satisfied }),
    );
    Derived::Value(Value::Object(m))
}

/// `unlabelledWriterPolicyRendered`: the member-access and privacy parts of the writer's read policy.
fn derive_unlabelled_writer_policy(cur: &Cur, s: &AccessSettings, w: &WriterReadPolicyIn) -> Derived {
    let wcur = with(
        cur,
        &Patch {
            folder_coverage: Some(w.folder_coverage.clone()),
            owner: w.owner.then_some(true),
            ..Patch::default()
        },
        s,
    );
    let text_access = access_all(&w.identities, &w.satisfied_rule_ids, false, &wcur, s);
    let text = AccessAndTrue {
        inner: (text_access.clone(), None),
    };
    let fragment = |patch: Patch, empty: bool| AccessAndTrue {
        inner: caller_access(&reference(cur, patch, empty, s), s),
    };
    let off = access_off(&text_access);
    if text == fragment(Patch::default(), true) {
        return Derived::Value(Value::Object(off));
    }
    // A writer with no identity (an unbound or anonymous writer): its policy renders in a record of its own folder coverage,
    // so the store reads that coverage instead of the live pending prefixes (callerRecord).
    let no_identity = |off: Map<String, Value>| {
        let mut m = off;
        m.insert("identity".into(), json!([]));
        if !w.folder_coverage.is_empty() {
            m.insert(
                "folderCoverage".into(),
                serde_json::to_value(&w.folder_coverage).unwrap_or(Value::Null),
            );
        }
        m.insert("callerRecord".into(), json!(true));
        Derived::Value(Value::Object(m))
    };
    let no_identity_record = || {
        fragment(
            Patch {
                identity: Some(vec![]),
                satisfied_rule_ids: Some(vec![]),
                folder_coverage: Some(w.folder_coverage.clone()),
                ..Patch::default()
            },
            false,
        )
    };
    if w.identities.is_empty() && text == no_identity_record() {
        return no_identity(off);
    }
    let identity = w.identities.first();
    // The sets the SQL applies, never the raw ones: the store matches entries one by one and would admit what the text denies.
    let (applied_identity, applied_rules) = sql_applied_sets(
        identity.map_or(&[], |i| i.as_slice()),
        &w.satisfied_rule_ids,
    );
    if w.identities.len() == 1 && identity.is_some_and(|i| !i.is_empty()) && applied_identity.is_empty() {
        // One identity holding an invalid entry reads as a writer with no identity. Beside rules the SQL still applies it is a
        // policy the store cannot hold, and an owner record is not modelled for it.
        if !applied_rules.is_empty() {
            return Derived::Refuse("a writer whose identity holds an invalid entry beside satisfied folder rules");
        }
        if text == no_identity_record() {
            return no_identity(off);
        }
        return Derived::Refuse(
            "a writer whose identity holds an invalid entry and whose record is not a plain member record",
        );
    }
    // The owner speaking for itself renders the same text without the owner-only clause, which `off` reads as no test.
    let one_identity = |owner: bool, folders: bool| {
        let Some(identity) = identity.filter(|_| w.identities.len() == 1) else {
            return false;
        };
        let mut patch = Patch {
            identity: Some(identity.clone()),
            private_readable_sources: Some(vec![]),
            hide_private: Some(true),
            owner: owner.then_some(true),
            ..Patch::default()
        };
        if folders {
            patch.satisfied_rule_ids = Some(w.satisfied_rule_ids.clone());
            patch.folder_coverage = Some(w.folder_coverage.clone());
        }
        text == fragment(patch, false)
    };
    if one_identity(false, false) || one_identity(true, false) {
        let mut m = off;
        m.insert("identity".into(), json!(applied_identity));
        m.insert("privateReadableSources".into(), json!([]));
        return Derived::Value(Value::Object(m));
    }
    // One identity under folder rules it satisfies and the pending prefixes its record names: the record's own folder access
    // (callerRecord), as the no-identity form above, judged for that identity.
    if identity.is_some()
        && (!w.satisfied_rule_ids.is_empty() || !w.folder_coverage.is_empty())
        && (one_identity(false, true) || one_identity(true, true))
    {
        let mut m = off;
        m.insert("identity".into(), json!(applied_identity));
        m.insert("privateReadableSources".into(), json!([]));
        m.insert("callerRecord".into(), json!(true));
        if !applied_rules.is_empty() {
            m.insert("satisfiedRuleIds".into(), json!(applied_rules));
        }
        if !w.folder_coverage.is_empty() {
            m.insert(
                "folderCoverage".into(),
                serde_json::to_value(&w.folder_coverage).unwrap_or(Value::Null),
            );
        }
        return Derived::Value(Value::Object(m));
    }
    Derived::Refuse("a writer whose owner record or identities widen the member-access policy")
}

/// `callerReadersAllowedSql(alias, 'snapshot')` as a key: the readers part and the labelled-only conjunct.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SnapReaders {
    OwnPage {
        readers: Vec<String>,
        own: String,
        audience: Vec<String>,
    },
    Audience {
        readers: Vec<String>,
        audience: Vec<String>,
    },
    Each(Vec<Vec<String>>),
}

/// `snapshotVisibleSql()` (trust-tier-reads.ts) as a key: the caller's snapshot readers, its labelled-only conjunct,
/// and its privacy over the snapshot (the private-readable sources it widens to, or none when privacy is off).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapKey {
    readers: SnapReaders,
    labelled: Option<LabelledKey>,
    privacy: Option<Vec<String>>,
}

fn snapshot_key(cur: &Cur, s: &AccessSettings) -> SnapKey {
    let a = eff(cur, s);
    let own = if a.owner_reads_restricted {
        lineage_read_page(&a)
    } else {
        None
    };
    let audience = audience_pages(&a);
    let readers = match own {
        Some(own) => SnapReaders::OwnPage {
            readers: readers(&a.identity),
            own,
            audience,
        },
        None if !audience.is_empty() => SnapReaders::Audience {
            readers: readers(&a.identity),
            audience,
        },
        None => {
            let ids = if a.audience_identities.is_empty() {
                vec![a.identity.clone()]
            } else {
                a.audience_identities.clone()
            };
            SnapReaders::Each(ids.iter().map(|i| readers(i)).collect())
        }
    };
    SnapKey {
        readers,
        labelled: a.labelled_only.then(|| labelled(&a)),
        privacy: a.hide_private.then(|| a.private_readable_sources.clone()),
    }
}

/// `pickValidTimeEdition`'s snapshot check: the caller's snapshot text equals the no-record one, or the canonical one
/// for the page policy's readers (each also with the caller widened to its restricted rendering).
fn derive_snapshot_policy(
    cur: &Cur,
    s: &AccessSettings,
    identity: &[String],
    sources: &[String],
) -> Derived {
    let served = judge_widened(cur, s, |cur2, _| {
        let text = snapshot_key(cur2, s);
        if text == snapshot_key(&None, s) {
            return Some(true);
        }
        let patch = Patch {
            identity: Some(identity.to_vec()),
            private_readable_sources: Some(sources.to_vec()),
            hide_private: Some(true),
            ..Patch::default()
        };
        (text == snapshot_key(&reference(cur2, patch, false, s), s)).then_some(true)
    });
    match served {
        Some(_) => Derived::Value(json!(true)),
        None => Derived::Refuse(
            "a caller whose snapshot policy is not the canonical one for its readers",
        ),
    }
}

/// `enforcedMemberPolicy`: the member read text, compared with the same text rendered for a fresh record of just the member's
/// identity and rules (no labelled-only grant, lineage, audience or owner record), so the store applies exactly the text that
/// was rendered. The sets sent are the ones the SQL applies, never the raw ones.
fn derive_enforced_member_policy(
    cur: &Cur,
    s: &AccessSettings,
    view: EnforcedView,
    identity: &[String],
    satisfied: &[String],
) -> Derived {
    let cx = Cx { s, norm: true };
    let access = eff(cur, s);
    let (applied_identity, applied_rules) = sql_applied_sets(identity, satisfied);
    if applied_identity.is_empty() && !applied_rules.is_empty() {
        return Derived::Refuse("a member whose identity holds an invalid entry beside satisfied folder rules");
    }
    let render = |at: &Cur| -> PageKey {
        match view {
            EnforcedView::MemberView => read_policy(identity, true, Some(satisfied), false, at, cx),
            EnforcedView::HiddenSlugs => {
                let (allowed, labelled) = caller_access(at, s);
                PageKey::Base {
                    access: allowed,
                    labelled,
                    privacy: PrivacyKey::Part {
                        sources: vec![],
                        part: privacy_part(at, cx),
                    },
                }
            }
        }
    };
    let patch = Patch {
        identity: Some(applied_identity.clone()),
        private_readable_sources: Some(vec![]),
        hide_private: Some(true),
        owner: Some(false),
        restricted: Some(access.restricted),
        satisfied_rule_ids: Some(applied_rules.clone()),
        folder_coverage: Some(access.folder_coverage.clone()),
        ..Patch::default()
    };
    let reference_text = render(&reference(cur, patch, false, s));
    if render(cur) != reference_text {
        return Derived::Refuse(
            "a member whose labelled-only grant, lineage, audience or owner record changes the read policy",
        );
    }
    let mut m = page_flags(&reference_text, s);
    m.insert("identity".into(), json!(applied_identity));
    m.insert("privateReadableSources".into(), json!([]));
    m.insert("satisfiedRuleIds".into(), json!(applied_rules));
    m.insert(
        "folderCoverage".into(),
        serde_json::to_value(&access.folder_coverage).unwrap_or(Value::Null),
    );
    m.insert("callerRecord".into(), json!(true));
    if !access.restricted {
        m.insert("open".into(), json!(true));
    }
    Derived::Value(Value::Object(m))
}

/// The derivation: what the TypeScript helper named by the request returns in this context.
pub fn derive(ctx: &AccessContext) -> Derived {
    let cur = &ctx.record;
    let s = &ctx.settings;
    match &ctx.request {
        DeriveRequest::PageText {
            fragment,
            caller_readers,
            no_readers,
            rendered_in,
        } => derive_page_text(
            cur,
            s,
            *fragment,
            *caller_readers,
            *no_readers,
            rendered_in.as_deref(),
        ),
        DeriveRequest::Fact {
            exclude_private,
            fragment,
            caller_readers,
        } => derive_fact(cur, s, *exclude_private, *fragment, *caller_readers),
        DeriveRequest::FloorPolicy {} => derive_floor_policy(cur, s),
        DeriveRequest::MemberRead {
            owner,
            identity,
            satisfied,
        } => derive_member_read(cur, s, *owner, identity, satisfied),
        DeriveRequest::MemberAccess {} => derive_member_access(cur, s),
        DeriveRequest::RemoteFloor {} => derive_remote_floor(cur, s),
        DeriveRequest::Visibility { list } => derive_visibility(cur, s, list.as_deref()),
        DeriveRequest::PrivacyPartAliases {} => Derived::Value(json!(s.honor_aliases)),
        DeriveRequest::PlainPageFlags {} => Derived::Value(Value::Object(page_flags(
            &page_plain(cur, false, Cx { s, norm: false }),
            s,
        ))),
        DeriveRequest::OpenPageFloor {} => derive_open_page_floor(cur, s),
        DeriveRequest::AccessPartPlain {} => derive_access_part_plain(cur, s),
        DeriveRequest::MemberAccessPolicy {
            identity,
            satisfied,
        } => derive_member_access_policy(cur, s, identity.as_deref(), satisfied),
        DeriveRequest::RowOwnerOnly {} => {
            Derived::Value(json!(owner_only_flag(owner_only_text(cur, s))))
        }
        DeriveRequest::OwnerReach {
            identity,
            satisfied,
        } => derive_owner_reach(cur, s, identity, satisfied),
        DeriveRequest::WriterPolicy { policy } => derive_writer_policy(cur, s, policy),
        DeriveRequest::EnforcedMemberPolicy {
            view,
            identity,
            satisfied,
        } => derive_enforced_member_policy(cur, s, *view, identity, satisfied),
        DeriveRequest::SnapshotPolicy {
            identity,
            private_readable_sources,
        } => derive_snapshot_policy(cur, s, identity, private_readable_sources),
    }
}

/// `derive` over a JSON context, as napi and the self-check call it.
pub fn derive_json(ctx: &Value) -> crate::Result<Value> {
    let ctx: AccessContext = serde_json::from_value(ctx.clone())
        .map_err(|e| crate::StoreError::invalid(format!("access derivation context: {e}")))?;
    Ok(derive(&ctx).to_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> AccessSettings {
        AccessSettings {
            honor_aliases: true,
            process_privacy_relaxed: false,
            scope_schema_version: Some(330),
        }
    }

    fn ctx(record: Option<Value>, request: Value) -> Value {
        json!({ "record": record, "settings": { "honorAliases": true, "processPrivacyRelaxed": false, "scopeSchemaVersion": 330 }, "request": request })
    }

    #[test]
    fn validators_match_the_typescript_patterns() {
        assert!(access_id_ok("alice-example"));
        assert!(!access_id_ok("Alice"));
        assert!(!access_id_ok(""));
        assert_eq!(
            normalize_principal(" Member:Bob ").as_deref(),
            Some("member:bob")
        );
        assert_eq!(
            normalize_principal("group:team-a").as_deref(),
            Some("group:team-a")
        );
        assert!(normalize_principal("group:").is_none());
        assert!(valid_rule_id("wiki:team.page"));
        assert!(!valid_rule_id(":x"));
        assert!(valid_source_id("a"));
        assert!(!valid_source_id("a-"));
        assert!(valid_prefix("people/"));
        assert!(valid_prefix("people/alice"));
        assert!(!valid_prefix("people//"));
        assert!(!valid_prefix("a/../b"));
    }

    #[test]
    fn no_record_reads_the_no_caller_page_policy() {
        let got = derive_json(&ctx(
            None,
            json!({ "mode": "page_text", "fragment": "caller", "callerReaders": true }),
        ))
        .unwrap();
        assert_eq!(
            got,
            json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" })
        );
    }

    #[test]
    fn a_member_reads_its_readers_policy() {
        let record = json!({ "identity": ["group:team-a", "member:alice-example"], "restricted": true, "hidePrivate": true });
        let got = derive_json(&ctx(
            Some(record),
            json!({ "mode": "page_text", "fragment": "caller", "callerReaders": true }),
        ))
        .unwrap();
        assert_eq!(
            got["identity"],
            json!(["group:team-a", "member:alice-example"])
        );
        assert_eq!(got["callerRecord"], json!(true));
    }

    #[test]
    fn an_audience_or_lineage_caller_refuses() {
        let record = json!({ "identity": [], "audienceIdentities": [["member:a"], ["member:b"]], "audience": ["member:a", "member:b"] });
        let got = derive_json(&ctx(
            Some(record),
            json!({ "mode": "page_text", "fragment": "caller", "callerReaders": true }),
        ))
        .unwrap();
        assert_eq!(got["$refuse"], json!(true));
        let record = json!({ "identity": ["member:a"], "lineage": true });
        let got = derive_json(&ctx(Some(record), json!({ "mode": "fact", "excludePrivate": true, "fragment": "under_policy", "callerReaders": true }))).unwrap();
        assert_eq!(got["$refuse"], json!(true));
    }

    /// Family `page_text`: main's `storePageTextPolicy` compares the plain text with a canonical record that carries the
    /// caller's labelled-only grant, so a labelled-only caller whose plain text does not name that grant is refused. The store
    /// served it (a bad-audience, labelled-only, folder-covered caller read as an ordinary member).
    #[test]
    fn page_text_refuses_a_labelled_only_caller_whose_plain_text_does_not_name_the_grant() {
        // The record `callerAccessRecord()` holds for that caller (a bad audience entry reads as the guest audience).
        let record = json!({
            "identity": [], "audience": ["guest"], "audienceIdentities": [],
            "actor": { "system": "chat", "external_id": "u1", "member": "alice-example" },
            "satisfiedRuleIds": ["wiki:team"], "folderCoverage": [{ "source_id": "wiki", "prefix": "" }],
            "privateReadableSources": [], "privateFactSources": [], "hidePrivate": true, "owner": false,
            "lineage": false, "ownerReadsRestricted": false, "audienceKindMembers": [], "labelledOnly": true,
            "applyRemoteReadPolicy": false, "restricted": true, "remotePolicy": null, "ownerReads": true
        });
        let got = derive_json(&ctx(
            Some(record),
            json!({ "mode": "page_text", "fragment": "plain", "callerReaders": true }),
        ))
        .unwrap();
        assert_eq!(got["$refuse"], json!(true), "got {got}");
    }

    /// Family `fact`: main's `factPolicy` takes `reference = (access.lineage && !access.owner) ? undefined : callerReference()`
    /// and refuses when there is none. A non-owner lineage read is therefore refused for every fragment, `for_caller` included.
    #[test]
    fn fact_refuses_a_non_owner_lineage_read_for_every_fragment() {
        // The record `callerAccessRecord()` holds for that caller (an invalid identity and rule id are normalised away).
        let record = json!({
            "identity": [], "audience": ["member:alice-example"], "audienceIdentities": [],
            "actor": { "system": "chat", "external_id": "u1", "member": "alice-example" },
            "satisfiedRuleIds": [], "folderCoverage": [{ "source_id": "BAD", "prefix": "x/" }],
            "privateReadableSources": ["wiki"], "privateFactSources": ["wiki"], "hidePrivate": true,
            "owner": false, "lineage": true, "ownerReadsRestricted": false, "audienceKindMembers": [],
            "labelledOnly": false, "applyRemoteReadPolicy": false, "restricted": true,
            "remotePolicy": { "privacyRelaxed": false, "restricted": true, "schemaVersion": 300 }, "ownerReads": true
        });
        let got = derive_json(&ctx(
            Some(record),
            json!({ "mode": "fact", "excludePrivate": true, "fragment": "for_caller", "callerReaders": true }),
        ))
        .unwrap();
        assert_eq!(got["$refuse"], json!(true), "got {got}");
    }

    #[test]
    fn a_fact_policy_not_asked_for_is_none() {
        let got = derive_json(&ctx(
            None,
            json!({ "mode": "fact", "excludePrivate": false, "fragment": "for_caller" }),
        ))
        .unwrap();
        assert_eq!(got, json!({ "$none": true }));
    }

    #[test]
    fn the_settings_reach_the_flags() {
        let mut s = settings();
        s.honor_aliases = false;
        s.scope_schema_version = None;
        let d = derive(&AccessContext {
            record: None,
            settings: s,
            request: DeriveRequest::FloorPolicy {},
        });
        assert_eq!(
            d,
            Derived::Value(
                json!({ "honorAliases": false, "entityPrivacy": false, "ownerOnly": "closed", "provenanceOnly": true })
            )
        );
    }

    /// `labelledOnlySql`: `if (!access.lineage || access.owner) return named` — an owner read never
    /// takes the lineage branch of the labelled-only conjunct. At the outcome level this is not
    /// observable today (every record that reaches the conjunct is a labelled-only record, and no
    /// reference record the helpers compare against is one, so both forms refuse alike); this pins
    /// the key itself so the store renders what TypeScript renders the day a reference can be one.
    #[test]
    fn the_labelled_only_lineage_branch_is_never_an_owner_read() {
        let rec = |owner: bool, lineage: bool| -> CallerRecord {
            serde_json::from_value(json!({ "identity": ["member:alice-example"], "labelledOnly": true, "owner": owner, "lineage": lineage })).unwrap()
        };
        assert!(
            labelled(&rec(false, true)).lineage,
            "a member's lineage read takes the branch"
        );
        assert!(
            !labelled(&rec(true, true)).lineage,
            "an owner's lineage read does not"
        );
        assert!(!labelled(&rec(false, false)).lineage);
        assert!(!labelled(&rec(true, false)).lineage);
    }

    #[test]
    fn the_owner_read_rule_serves_only_a_plain_lineage_read() {
        let rec = |v: Value| -> CallerRecord { serde_json::from_value(v).unwrap() };
        assert!(owner_lineage_served(&rec(
            json!({ "identity": ["member:a"], "owner": true, "lineage": true })
        )));
        assert!(!owner_lineage_served(&rec(
            json!({ "identity": ["member:a"], "owner": true, "lineage": true, "ownerReadsRestricted": true })
        )));
        assert!(!owner_lineage_served(&rec(
            json!({ "identity": ["member:a"], "owner": true, "lineage": true, "audienceKindMembers": ["room"] })
        )));
        assert!(!owner_lineage_served(&rec(
            json!({ "identity": ["member:a"], "owner": true })
        )));
    }

    #[test]
    fn an_unknown_mode_or_field_is_refused_as_invalid() {
        assert!(derive_json(&ctx(None, json!({ "mode": "nope" }))).is_err());
        assert!(derive_json(&ctx(None, json!({ "mode": "floor_policy", "extra": 1 }))).is_err());
    }
}
