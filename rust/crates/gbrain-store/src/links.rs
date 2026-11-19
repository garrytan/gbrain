//! Links: the `links` table of the PGLite engine, with the graph reads that walk it.
//!
//! A link record lives under the page it leaves (`L from id`). Three index keys point back at
//! it: `l to id -> from` for backlinks, `O origin id -> from` for the links a page authored, and
//! `U from to link_type source origin -> id` for the table's
//! `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`.
//! Every write keeps the four keys together in one transaction. Deleting a page removes the
//! links that leave or reach it and clears `origin_page_id` on the links it authored
//! (`ON DELETE CASCADE` / `ON DELETE SET NULL`); see `remove_page_links`.
//!
//! Reads follow `src/core/engine-sql/links.ts`: soft-deleted endpoints and origins hide an edge,
//! slugs match exactly (no lowercasing), and a source scope is `sourceIds` (when not empty), else
//! `sourceId`, else every source. The page policy (`excludePrivate`) and the temporal edge policy
//! apply to every read (`link_read`); `getLinks` / `getBacklinks` also serve the temporal
//! annotation columns and the keyset page. The keyset page of the path walks is refused with
//! `invalid_argument`; the TypeScript shell must not send it to this engine.
//!
//! `traverse_paths_detailed` orders rows by `(depth, from_slug, to_slug, from_source_id,
//! to_source_id, link_type, link id)`, as the SQL does (`link_type COLLATE "C"`: `str` compares
//! bytes).

use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, PAGE_NOT_FOUND, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, clean, double_option, next_id, read_page};
use crate::sources::{DEFAULT_SOURCE, all_sources};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use crate::facts::PrivacyPolicy;

mod link_read;
use link_read::EdgeRules;
pub use link_read::{During, EdgeTemporal, FromType, Keep, LinkPage, RelationshipKeep};

const NEXT_LINK_ID: &str = "next_link_id";
/// `TRAVERSE_WALK_ROW_CAP`: a walk keeps at most this many visited pages.
pub const TRAVERSE_WALK_ROW_CAP: usize = 20_000;
/// `TRAVERSE_PATH_ROW_CAP`: `traverse_paths_detailed` returns at most this many edges.
pub const TRAVERSE_PATH_ROW_CAP: usize = 5_000;

/// What is stored for a link.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LinkRecord {
    pub id: u64,
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub context: String,
    #[serde(default)]
    pub link_source: Option<String>,
    #[serde(default)]
    pub link_kind: Option<String>,
    #[serde(default)]
    pub origin_page_id: Option<u64>,
    #[serde(default)]
    pub origin_field: Option<String>,
    #[serde(default)]
    pub resolution_type: Option<String>,
    pub created_at_us: i64,
    /// `links.assertion_tense`: `past` when the origin page states the link in the past tense
    /// (link_temporal.rs); absent reads as `present`.
    #[serde(default)]
    pub assertion_tense: Option<String>,
}

impl LinkRecord {
    pub(crate) fn unique_key(&self) -> Vec<u8> {
        keys::link_unique(
            self.from_page_id,
            self.to_page_id,
            &self.link_type,
            self.link_source.as_deref(),
            self.origin_page_id,
        )
    }
}

/// The options of `addLink(from, to, context?, linkType?, linkSource?, originSlug?,
/// originField?, opts?)`, flattened into one object.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AddLinkOptions {
    pub context: Option<String>,
    pub link_type: Option<String>,
    pub link_source: Option<String>,
    pub origin_slug: Option<String>,
    pub origin_field: Option<String>,
    pub from_source_id: Option<String>,
    pub to_source_id: Option<String>,
    pub origin_source_id: Option<String>,
}

/// One `LinkBatchInput` of `addLinksBatch`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct LinkBatchInput {
    pub from_slug: Option<String>,
    pub to_slug: Option<String>,
    pub link_type: Option<String>,
    pub context: Option<String>,
    pub link_source: Option<String>,
    pub origin_slug: Option<String>,
    pub origin_field: Option<String>,
    pub from_source_id: Option<String>,
    pub to_source_id: Option<String>,
    pub origin_source_id: Option<String>,
    pub link_kind: Option<String>,
    pub resolution_type: Option<String>,
}

/// `removeLink(from, to, linkType?, linkSource?, opts?)`. `linkType` and `linkSource` have three
/// states: absent (no filter), `null` and a value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoveLinkOptions {
    #[serde(deserialize_with = "double_option")]
    pub link_type: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub link_source: Option<Option<String>>,
    pub from_source_id: Option<String>,
    pub to_source_id: Option<String>,
}

/// `LinkReadScope` of `getLinks` / `getBacklinks`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub temporal: Option<EdgeTemporal>,
    pub page: Option<LinkPage>,
}

/// `TraverseGraphOpts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraverseGraphOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub frontier_cap: Option<i64>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub temporal: Option<EdgeTemporal>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    #[default]
    Out,
    Both,
}

/// The options of `traversePaths` / `traversePathsDetailed`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PathOptions {
    pub depth: Option<i64>,
    pub link_type: Option<String>,
    pub direction: Option<Direction>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub temporal: Option<EdgeTemporal>,
    pub page: Option<Value>,
}

/// Postgres refuses text that holds a NUL byte (`22021`).
pub(crate) fn no_nul(op: &str, parts: &[(&str, &str)]) -> Result<()> {
    for (name, text) in parts {
        if text.contains('\0') {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{op}: {name} must not contain a NUL byte"),
            ));
        }
    }
    Ok(())
}

/// The keyset page of the path walks, which this engine does not serve.
fn refuse_page(op: &str, page: &Option<Value>) -> Result<()> {
    if page.as_ref().is_some_and(|v| !v.is_null()) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: the page option is not supported by the rust engine"),
        ));
    }
    Ok(())
}

/// `link_source` CHECK: NULL, or `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and at most 64 characters.
fn valid_link_source(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !text.contains("--")
        && !text.ends_with('-')
}

fn check_violation(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"links\" violates check constraint \"{constraint}\""),
    )
}

pub(crate) fn unique_violation() -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        "duplicate key value violates unique constraint \"links_from_to_type_source_origin_unique\"",
    )
}

/// The table's CHECK constraints.
fn check_link(record: &LinkRecord) -> Result<()> {
    if record
        .link_source
        .as_deref()
        .is_some_and(|s| !valid_link_source(s))
    {
        return Err(check_violation("links_link_source_check"));
    }
    if record
        .link_kind
        .as_deref()
        .is_some_and(|k| k != "plain" && k != "typed_ner")
    {
        return Err(check_violation("links_link_kind_check"));
    }
    if record
        .resolution_type
        .as_deref()
        .is_some_and(|r| r != "qualified" && r != "unqualified")
    {
        return Err(check_violation("links_resolution_type_check"));
    }
    Ok(())
}

pub(crate) fn put_link(tx: &mut dyn KvWrite, record: &LinkRecord) -> Result<()> {
    let from = record.from_page_id.to_be_bytes();
    put_json(tx, &keys::link(record.from_page_id, record.id), record)?;
    tx.put(&keys::link_to(record.to_page_id, record.id), &from)?;
    tx.put(&record.unique_key(), &record.id.to_be_bytes())?;
    if let Some(origin) = record.origin_page_id {
        tx.put(&keys::link_origin(origin, record.id), &from)?;
    }
    Ok(())
}

pub(crate) fn delete_link(tx: &mut dyn KvWrite, record: &LinkRecord) -> Result<()> {
    tx.delete(&keys::link(record.from_page_id, record.id))?;
    tx.delete(&keys::link_to(record.to_page_id, record.id))?;
    tx.delete(&record.unique_key())?;
    if let Some(origin) = record.origin_page_id {
        tx.delete(&keys::link_origin(origin, record.id))?;
    }
    Ok(())
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(
        crate::error::STORE_CORRUPT,
        format!("bad {what} index entry"),
    )
}

fn read_link(read: &dyn KvRead, from: u64, id: u64) -> Result<Option<LinkRecord>> {
    get_json(read, &keys::link(from, id))
}

/// The link that holds a unique key, if any.
fn link_at(read: &dyn KvRead, from: u64, unique: &[u8]) -> Result<Option<LinkRecord>> {
    match read.get(unique)? {
        Some(bytes) => {
            let id = keys::be8(&bytes).ok_or_else(|| corrupt("link unique"))?;
            read_link(read, from, id)
        }
        None => Ok(None),
    }
}

/// The links that leave `page_id`, in id order.
pub(crate) fn out_links(read: &dyn KvRead, page_id: u64) -> Result<Vec<LinkRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &keys::link_prefix(page_id), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// Reads the links named by an index whose keys end in `link_id` and whose values are the
/// `from_page_id`, in id order.
fn indexed_links(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<LinkRecord>> {
    let mut refs = Vec::new();
    let mut bad = false;
    scan_prefix(read, prefix, false, &mut |k, v| {
        match (keys::be8(&k[k.len().saturating_sub(8)..]), keys::be8(v)) {
            (Some(id), Some(from)) if k.len() >= prefix.len() + 8 => refs.push((from, id)),
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt("link"));
    }
    let mut out = Vec::with_capacity(refs.len());
    for (from, id) in refs {
        out.push(read_link(read, from, id)?.ok_or_else(|| corrupt("link"))?);
    }
    Ok(out)
}

/// The links that arrive at `page_id`, in id order.
pub(crate) fn in_links(read: &dyn KvRead, page_id: u64) -> Result<Vec<LinkRecord>> {
    indexed_links(read, &keys::link_to_prefix(page_id))
}

/// `ON DELETE CASCADE` for `from_page_id` / `to_page_id` and `ON DELETE SET NULL` for
/// `origin_page_id`. Clearing an origin that makes a link equal to another link fails with
/// `constraint_violation`, as Postgres does (`23505`), and the delete rolls back.
pub(crate) fn remove_page_links(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    for record in out_links(&*tx, page_id)? {
        delete_link(tx, &record)?;
    }
    for record in in_links(&*tx, page_id)? {
        delete_link(tx, &record)?;
    }
    for record in indexed_links(&*tx, &keys::link_origin_prefix(page_id))? {
        delete_link(tx, &record)?;
        let cleared = LinkRecord {
            origin_page_id: None,
            ..record
        };
        if tx.get(&cleared.unique_key())?.is_some() {
            return Err(unique_violation());
        }
        put_link(tx, &cleared)?;
    }
    Ok(())
}

/// The page fields the graph reads need.
#[derive(Debug, Deserialize)]
struct PageHead {
    source_id: String,
    slug: String,
    #[serde(rename = "type")]
    page_type: String,
    title: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// A read's page cache, keyed by page id.
struct Heads<'a> {
    read: &'a dyn KvRead,
    cache: HashMap<u64, Option<Rc<PageHead>>>,
}

impl<'a> Heads<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            cache: HashMap::new(),
        }
    }

    fn get(&mut self, id: u64) -> Result<Option<Rc<PageHead>>> {
        if let Some(head) = self.cache.get(&id) {
            return Ok(head.clone());
        }
        let head = match self.read.get(&keys::page_id(id))? {
            Some(key) => get_json::<PageHead>(self.read, &key)?.map(Rc::new),
            None => None,
        };
        self.cache.insert(id, head.clone());
        Ok(head)
    }

    /// The page when it is live and inside `scope`.
    fn live(&mut self, id: u64, scope: &Scope) -> Result<Option<Rc<PageHead>>> {
        Ok(self
            .get(id)?
            .filter(|h| h.deleted_at_us.is_none() && scope.contains(&h.source_id)))
    }

    /// `liveOriginFilter`: no origin, or a live origin inside `scope`.
    fn origin_ok(&mut self, link: &LinkRecord, scope: &Scope) -> Result<bool> {
        match link.origin_page_id {
            None => Ok(true),
            Some(origin) => Ok(self.live(origin, scope)?.is_some()),
        }
    }
}

/// A source scope: `sourceIds` when not empty, else a truthy `sourceId`, else every source.
enum Scope {
    All,
    One(String),
    Many(HashSet<String>),
}

impl Scope {
    fn new(source_id: &Option<String>, source_ids: &Option<Vec<String>>) -> Self {
        if let Some(ids) = source_ids.as_ref().filter(|ids| !ids.is_empty()) {
            return Scope::Many(ids.iter().cloned().collect());
        }
        match source_id.as_ref().filter(|id| !id.is_empty()) {
            Some(id) => Scope::One(id.clone()),
            None => Scope::All,
        }
    }

    fn contains(&self, source: &str) -> bool {
        match self {
            Scope::All => true,
            Scope::One(id) => id == source,
            Scope::Many(ids) => ids.contains(source),
        }
    }

    /// The pages named `slug` inside the scope, live or not, in `(source)` order.
    fn pages(&self, read: &dyn KvRead, slug: &str) -> Result<Vec<PageRecord>> {
        let sources: Vec<String> = match self {
            Scope::All => all_sources(read)?.into_iter().map(|s| s.id).collect(),
            Scope::One(id) => vec![id.clone()],
            Scope::Many(ids) => {
                let mut ids: Vec<String> = ids.iter().cloned().collect();
                ids.sort();
                ids
            }
        };
        let mut out = Vec::new();
        for source in sources {
            if let Some(page) = read_page(read, &source, slug)? {
                out.push(page);
            }
        }
        Ok(out)
    }
}

fn link_row(heads: &mut Heads, link: &LinkRecord, from: &PageHead, to: &PageHead) -> Result<Value> {
    let origin = match link.origin_page_id {
        Some(id) => heads.get(id)?,
        None => None,
    };
    Ok(json!({
        "from_slug": from.slug,
        "from_source_id": from.source_id,
        "to_slug": to.slug,
        "to_source_id": to.source_id,
        "link_type": link.link_type,
        "context": link.context,
        "link_source": link.link_source,
        "origin_slug": origin.as_ref().map(|o| o.slug.clone()),
        "origin_source_id": origin.as_ref().map(|o| o.source_id.clone()),
        "origin_field": link.origin_field,
    }))
}

/// One BFS walk (`bfsWalkCtes`): `(page id, depth)` in visit order, uncapped by the row cap.
#[allow(clippy::too_many_arguments)]
fn bfs_walk(
    read: &dyn KvRead,
    heads: &mut Heads,
    rules: &mut EdgeRules,
    slug: &str,
    scope: &Scope,
    max_layer: i64,
    direction: Direction,
    link_type: Option<&str>,
    layer_cap: Option<i64>,
) -> Result<Vec<(u64, i64)>> {
    let mut seed: Vec<(String, u64)> = Vec::new();
    for page in scope.pages(read, slug)? {
        if page.deleted_at_us.is_none() && rules.page_ok(page.id)? {
            seed.push((page.slug, page.id));
        }
    }
    seed.sort();
    let mut frontier: Vec<u64> = seed.into_iter().map(|(_, id)| id).collect();
    let mut visited: HashSet<u64> = frontier.iter().copied().collect();
    let mut walk: Vec<(u64, i64)> = frontier.iter().map(|id| (*id, 0)).collect();
    let mut depth = 0i64;
    while !frontier.is_empty() && depth < max_layer {
        let budget = (TRAVERSE_WALK_ROW_CAP + 1).saturating_sub(visited.len());
        let limit = match layer_cap {
            Some(cap) if cap > 0 => budget.min(cap as usize),
            _ => budget,
        };
        let mut next: BTreeSet<(String, u64)> = BTreeSet::new();
        for id in &frontier {
            let mut step = Vec::new();
            if direction != Direction::In {
                for link in out_links(read, *id)? {
                    step.push((link.to_page_id, link));
                }
            }
            if direction != Direction::Out {
                for link in in_links(read, *id)? {
                    step.push((link.from_page_id, link));
                }
            }
            for (other, link) in step {
                if visited.contains(&other) || link_type.is_some_and(|t| t != link.link_type) {
                    continue;
                }
                let Some(head) = heads.live(other, scope)? else {
                    continue;
                };
                if heads.origin_ok(&link, scope)?
                    && rules.page_ok(other)?
                    && rules.origin_ok(&link)?
                    && rules.walk_ok(&link)?
                {
                    next.insert((head.slug.clone(), other));
                }
            }
        }
        let layer: Vec<u64> = next.into_iter().take(limit).map(|(_, id)| id).collect();
        if layer.is_empty() {
            break;
        }
        depth += 1;
        visited.extend(layer.iter().copied());
        walk.extend(layer.iter().map(|id| (*id, depth)));
        frontier = layer;
    }
    Ok(walk)
}

struct PathRow {
    depth: i64,
    from: Rc<PageHead>,
    to: Rc<PageHead>,
    from_id: u64,
    to_id: u64,
    link: LinkRecord,
}

impl PathRow {
    fn sort_key(&self) -> (i64, &str, &str, &str, &str, &str, u64) {
        (
            self.depth,
            &self.from.slug,
            &self.to.slug,
            &self.from.source_id,
            &self.to.source_id,
            &self.link.link_type,
            self.link.id,
        )
    }
}

impl Store {
    /// `addLink`: inserts the link or, when an equal one exists, replaces its `context` and
    /// `origin_field`. `page_not_found` names the missing endpoint (`from` first). A missing
    /// origin page stores no origin. `constraint_violation` for a bad `link_source`.
    pub fn add_link(&self, from: &str, to: &str, options: &AddLinkOptions) -> Result<()> {
        let from_source = options.from_source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        let to_source = options.to_source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        let origin_source = options
            .origin_source_id
            .as_deref()
            .unwrap_or(DEFAULT_SOURCE);
        let link_type = options.link_type.as_deref().unwrap_or("");
        let link_source = options.link_source.as_deref().unwrap_or("markdown");
        no_nul(
            "addLink",
            &[
                ("from", from),
                ("to", to),
                ("fromSourceId", from_source),
                ("toSourceId", to_source),
                ("originSourceId", origin_source),
                ("linkType", link_type),
                ("linkSource", link_source),
                ("originSlug", options.origin_slug.as_deref().unwrap_or("")),
                ("originField", options.origin_field.as_deref().unwrap_or("")),
            ],
        )?;
        self.write(|tx| {
            let from_page = read_page(&*tx, from_source, from)?;
            let to_page = read_page(&*tx, to_source, to)?;
            let Some(from_page) = from_page else {
                return Err(missing("addLink", "from", from, from_source));
            };
            let Some(to_page) = to_page else {
                return Err(missing("addLink", "to", to, to_source));
            };
            let origin = match options.origin_slug.as_deref() {
                Some(slug) => read_page(&*tx, origin_source, slug)?.map(|p| p.id),
                None => None,
            };
            let mut record = LinkRecord {
                id: 0,
                from_page_id: from_page.id,
                to_page_id: to_page.id,
                link_type: link_type.to_string(),
                context: clean(options.context.as_deref().unwrap_or("")),
                link_source: Some(link_source.to_string()),
                link_kind: None,
                origin_page_id: origin,
                origin_field: options.origin_field.clone(),
                resolution_type: None,
                created_at_us: self.env.now_micros(),
                assertion_tense: None,
            };
            check_link(&record)?;
            if let Some(mut existing) = link_at(&*tx, from_page.id, &record.unique_key())? {
                existing.context = record.context;
                existing.origin_field = record.origin_field;
                return put_json(
                    tx,
                    &keys::link(existing.from_page_id, existing.id),
                    &existing,
                );
            }
            record.id = next_id(tx, NEXT_LINK_ID)?;
            put_link(tx, &record)
        })
    }

    /// `addLinksBatch`: rows whose endpoints do not resolve are skipped; rows equal to a stored
    /// link (or to an earlier row) change nothing. Returns the number of links inserted. One bad
    /// row fails the whole batch.
    pub fn add_links_batch(&self, links: &[LinkBatchInput]) -> Result<u64> {
        let text = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        for link in links {
            no_nul(
                "addLinksBatch",
                &[
                    ("from_slug", link.from_slug.as_deref().unwrap_or("")),
                    ("to_slug", link.to_slug.as_deref().unwrap_or("")),
                    ("link_type", link.link_type.as_deref().unwrap_or("")),
                    ("link_source", link.link_source.as_deref().unwrap_or("")),
                    ("origin_slug", link.origin_slug.as_deref().unwrap_or("")),
                    ("origin_field", link.origin_field.as_deref().unwrap_or("")),
                    (
                        "from_source_id",
                        link.from_source_id.as_deref().unwrap_or(""),
                    ),
                    ("to_source_id", link.to_source_id.as_deref().unwrap_or("")),
                    (
                        "origin_source_id",
                        link.origin_source_id.as_deref().unwrap_or(""),
                    ),
                    ("link_kind", link.link_kind.as_deref().unwrap_or("")),
                    (
                        "resolution_type",
                        link.resolution_type.as_deref().unwrap_or(""),
                    ),
                ],
            )?;
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut inserted = 0u64;
            for link in links {
                let source = |v: &Option<String>| text(v).unwrap_or_else(|| DEFAULT_SOURCE.into());
                let (Some(from), Some(to)) = (&link.from_slug, &link.to_slug) else {
                    continue;
                };
                let Some(from_page) = read_page(&*tx, &source(&link.from_source_id), from)? else {
                    continue;
                };
                let Some(to_page) = read_page(&*tx, &source(&link.to_source_id), to)? else {
                    continue;
                };
                let origin = match text(&link.origin_slug) {
                    Some(slug) => {
                        read_page(&*tx, &source(&link.origin_source_id), &slug)?.map(|p| p.id)
                    }
                    None => None,
                };
                let mut record = LinkRecord {
                    id: 0,
                    from_page_id: from_page.id,
                    to_page_id: to_page.id,
                    link_type: link.link_type.clone().unwrap_or_default(),
                    context: clean(link.context.as_deref().unwrap_or("")),
                    link_source: Some(text(&link.link_source).unwrap_or_else(|| "markdown".into())),
                    link_kind: link.link_kind.clone(),
                    origin_page_id: origin,
                    origin_field: text(&link.origin_field),
                    resolution_type: link.resolution_type.clone(),
                    created_at_us: now,
                    assertion_tense: None,
                };
                check_link(&record)?;
                if tx.get(&record.unique_key())?.is_some() {
                    continue;
                }
                record.id = next_id(tx, NEXT_LINK_ID)?;
                put_link(tx, &record)?;
                inserted += 1;
            }
            Ok(inserted)
        })
    }

    /// `removeLink`: deletes the links from `from` to `to` that pass the filters and returns how
    /// many it deleted. A `null` link type matches nothing; a `null` link source matches links
    /// with no source (`IS NOT DISTINCT FROM`).
    pub fn remove_link(&self, from: &str, to: &str, options: &RemoveLinkOptions) -> Result<u64> {
        let from_source = options.from_source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        let to_source = options.to_source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        no_nul(
            "removeLink",
            &[
                ("from", from),
                ("to", to),
                ("fromSourceId", from_source),
                ("toSourceId", to_source),
            ],
        )?;
        self.write(|tx| {
            let (Some(from_page), Some(to_page)) = (
                read_page(&*tx, from_source, from)?,
                read_page(&*tx, to_source, to)?,
            ) else {
                return Ok(0);
            };
            let mut removed = 0u64;
            for link in out_links(&*tx, from_page.id)? {
                let type_ok = match &options.link_type {
                    None => true,
                    Some(None) => false,
                    Some(Some(t)) => *t == link.link_type,
                };
                let source_ok = match &options.link_source {
                    None => true,
                    Some(wanted) => *wanted == link.link_source,
                };
                if link.to_page_id == to_page.id && type_ok && source_ok {
                    delete_link(tx, &link)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }

    /// `getLinks(slug, opts)`: the links that leave the page, in link id order.
    pub fn get_links(&self, slug: &str, scope: &LinkScope) -> Result<Vec<Value>> {
        self.link_rows("getLinks", slug, scope, true)
    }

    /// `getBacklinks(slug, opts)`: the links that reach the page, in link id order.
    pub fn get_backlinks(&self, slug: &str, scope: &LinkScope) -> Result<Vec<Value>> {
        self.link_rows("getBacklinks", slug, scope, false)
    }

    fn link_rows(
        &self,
        op: &str,
        slug: &str,
        options: &LinkScope,
        outgoing: bool,
    ) -> Result<Vec<Value>> {
        no_nul(op, &[("slug", slug)])?;
        if let Some(page) = &options.page {
            page.check()?;
        }
        let read = self.read()?;
        let mut rules = EdgeRules::new(
            &*read,
            options.exclude_private.as_ref(),
            None,
            self.env.now_micros(),
        )?;
        // `linkPageSql`'s pinned rule: a paged read inside a grant with a sourceId keeps that
        // source's queried page only.
        let pinned = options
            .page
            .as_ref()
            .filter(|_| {
                options
                    .source_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.is_empty())
            })
            .and(options.source_id.as_deref());
        let scope = Scope::new(&options.source_id, &options.source_ids);
        // A scalar sourceId scopes only the queried page; sourceIds scope every page of the edge.
        let (near_scope, far_scope) = match &scope {
            Scope::Many(_) => (&scope, &scope),
            _ => (&scope, &Scope::All),
        };
        let mut heads = Heads::new(&*read);
        let mut rows: Vec<(u64, Value)> = Vec::new();
        for page in near_scope.pages(&*read, slug)? {
            if page.deleted_at_us.is_some() || pinned.is_some_and(|s| s != page.source_id) {
                continue;
            }
            let Some(near) = heads.get(page.id)? else {
                continue;
            };
            let links = if outgoing {
                out_links(&*read, page.id)?
            } else {
                in_links(&*read, page.id)?
            };
            for link in links {
                let other = if outgoing {
                    link.to_page_id
                } else {
                    link.from_page_id
                };
                let Some(far) = heads.live(other, far_scope)? else {
                    continue;
                };
                if !heads.origin_ok(&link, far_scope)? || !rules.link_private_ok(&link)? {
                    continue;
                }
                let from = if outgoing { &near } else { &far };
                if let Some(page) = &options.page {
                    if !page.bounds_ok(&link)
                        || !page.source_type_ok(&from.page_type, &from.source_id)
                    {
                        continue;
                    }
                    if let Some(rel) = &page.relationship
                        && rules.matches(&link, &rel.policy)? != (rel.keep == Keep::Match)
                    {
                        continue;
                    }
                }
                let mut row = if outgoing {
                    link_row(&mut heads, &link, &near, &far)?
                } else {
                    link_row(&mut heads, &link, &far, &near)?
                };
                if let Value::Object(fields) = &mut row {
                    if let Some(page) = &options.page {
                        fields.insert("context".into(), json!(page.context(&link.context)));
                    }
                    if options.temporal.is_some() {
                        rules.temporal_columns(&link, fields)?;
                    }
                    if options.page.is_some() {
                        fields.insert("link_id".into(), json!(link.id));
                    }
                }
                rows.push((link.id, row));
            }
        }
        rows.sort_by_key(|(id, _)| *id);
        if let Some(limit) = options.page.as_ref().and_then(|p| p.limit) {
            rows.truncate(limit as usize);
        }
        if options.page.as_ref().is_some_and(|p| p.count == Some(true)) {
            return Ok(vec![json!({"link_total": rows.len()})]);
        }
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }

    /// `traverseGraph(slug, depth = 5, opts)`: the pages reachable along outgoing links, each at
    /// its shortest distance, with its distinct outgoing `{to_slug, link_type}` pairs.
    pub fn traverse_graph(
        &self,
        slug: &str,
        depth: Option<i64>,
        options: &TraverseGraphOptions,
    ) -> Result<Vec<Value>> {
        no_nul("traverseGraph", &[("slug", slug)])?;
        let read = self.read()?;
        let scope = Scope::new(&options.source_id, &options.source_ids);
        let mut heads = Heads::new(&*read);
        let mut rules = EdgeRules::new(
            &*read,
            options.exclude_private.as_ref(),
            options.temporal.as_ref(),
            self.env.now_micros(),
        )?;
        let walk = bfs_walk(
            &*read,
            &mut heads,
            &mut rules,
            slug,
            &scope,
            depth.unwrap_or(5),
            Direction::Out,
            None,
            options.frontier_cap,
        )?;
        let mut nodes = Vec::new();
        for (id, node_depth) in walk.into_iter().take(TRAVERSE_WALK_ROW_CAP) {
            let Some(head) = heads.get(id)? else {
                continue;
            };
            let mut pairs: BTreeSet<(String, String)> = BTreeSet::new();
            for link in out_links(&*read, id)? {
                let Some(to) = heads.live(link.to_page_id, &scope)? else {
                    continue;
                };
                if heads.origin_ok(&link, &scope)?
                    && rules.page_ok(link.to_page_id)?
                    && rules.origin_ok(&link)?
                    && rules.walk_ok(&link)?
                {
                    pairs.insert((to.slug.clone(), link.link_type.clone()));
                }
            }
            nodes.push((node_depth, head, pairs));
        }
        nodes.sort_by(|a, b| {
            (a.0, &a.1.slug, &a.1.source_id).cmp(&(b.0, &b.1.slug, &b.1.source_id))
        });
        Ok(nodes
            .into_iter()
            .map(|(node_depth, head, pairs)| {
                let links: Vec<Value> = pairs
                    .into_iter()
                    .map(|(to_slug, link_type)| json!({"to_slug": to_slug, "link_type": link_type}))
                    .collect();
                json!({
                    "slug": head.slug,
                    "source_id": head.source_id,
                    "title": head.title,
                    "type": head.page_type,
                    "depth": node_depth,
                    "links": links,
                })
            })
            .collect())
    }

    /// `traversePaths(slug, opts)`: the edges of `traverse_paths_detailed` without the flag.
    pub fn traverse_paths(&self, slug: &str, options: &PathOptions) -> Result<Vec<Value>> {
        let detailed = self.traverse_paths_detailed(slug, options)?;
        Ok(match detailed.get("paths") {
            Some(Value::Array(paths)) => paths.clone(),
            _ => Vec::new(),
        })
    }

    /// `traversePathsDetailed(slug, opts)`: each qualifying edge once, at one past the depth of
    /// its shallower visited endpoint on the walked side. `{paths, truncated}`.
    pub fn traverse_paths_detailed(&self, slug: &str, options: &PathOptions) -> Result<Value> {
        refuse_page("traversePathsDetailed", &options.page)?;
        no_nul(
            "traversePathsDetailed",
            &[
                ("slug", slug),
                ("linkType", options.link_type.as_deref().unwrap_or("")),
            ],
        )?;
        let read = self.read()?;
        let scope = Scope::new(&options.source_id, &options.source_ids);
        let depth = options.depth.unwrap_or(5);
        let direction = options.direction.unwrap_or_default();
        let link_type = options.link_type.as_deref();
        let mut heads = Heads::new(&*read);
        let mut rules = EdgeRules::new(
            &*read,
            options.exclude_private.as_ref(),
            options.temporal.as_ref(),
            self.env.now_micros(),
        )?;
        let walk = bfs_walk(
            &*read,
            &mut heads,
            &mut rules,
            slug,
            &scope,
            depth.saturating_sub(1),
            direction,
            link_type,
            None,
        )?;
        let walk_truncated = walk.len() > TRAVERSE_WALK_ROW_CAP;
        let nodes: Vec<(u64, i64)> = walk.into_iter().take(TRAVERSE_WALK_ROW_CAP).collect();
        let node_depth: HashMap<u64, i64> = nodes.iter().copied().collect();
        let type_ok = |link: &LinkRecord| link_type.is_none_or(|t| t == link.link_type);

        // (edge depth before the +1, link) candidates.
        let mut candidates: Vec<(i64, LinkRecord)> = Vec::new();
        for (id, d) in &nodes {
            if direction != Direction::In {
                for link in out_links(&*read, *id)? {
                    let keep = match direction {
                        Direction::Both => node_depth.get(&link.to_page_id).is_none_or(|t| d <= t),
                        _ => true,
                    };
                    if keep {
                        candidates.push((*d, link));
                    }
                }
            }
            if direction != Direction::Out {
                for link in in_links(&*read, *id)? {
                    let keep = match direction {
                        Direction::Both => node_depth.get(&link.from_page_id).is_none_or(|f| d < f),
                        _ => true,
                    };
                    if keep {
                        candidates.push((*d, link));
                    }
                }
            }
        }
        let mut rows: Vec<PathRow> = Vec::new();
        for (d, link) in candidates {
            if d >= depth || !type_ok(&link) {
                continue;
            }
            // The walked endpoint is a visited (live, in-scope) page; both are checked anyway,
            // which is what the 'both' arm does and changes nothing for 'in' and 'out'.
            let Some(from) = heads.live(link.from_page_id, &scope)? else {
                continue;
            };
            let Some(to) = heads.live(link.to_page_id, &scope)? else {
                continue;
            };
            if !heads.origin_ok(&link, &scope)?
                || !rules.link_private_ok(&link)?
                || !rules.walk_ok(&link)?
            {
                continue;
            }
            rows.push(PathRow {
                depth: d + 1,
                from,
                to,
                from_id: link.from_page_id,
                to_id: link.to_page_id,
                link,
            });
        }
        rows.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
        let truncated = rows.len() > TRAVERSE_PATH_ROW_CAP || (!rows.is_empty() && walk_truncated);
        rows.truncate(TRAVERSE_PATH_ROW_CAP);
        let mut seen: HashSet<(u64, u64, String, i64)> = HashSet::new();
        let mut paths = Vec::new();
        for row in rows {
            if !seen.insert((
                row.from_id,
                row.to_id,
                row.link.link_type.clone(),
                row.depth,
            )) {
                continue;
            }
            paths.push(json!({
                "from_slug": row.from.slug,
                "from_source_id": row.from.source_id,
                "to_slug": row.to.slug,
                "to_source_id": row.to.source_id,
                "link_type": row.link.link_type,
                "context": row.link.context,
                "depth": row.depth,
            }));
        }
        Ok(json!({"paths": paths, "truncated": truncated}))
    }
}

/// `PageMissingError`.
pub(crate) fn missing(op: &str, endpoint: &str, slug: &str, source: &str) -> StoreError {
    StoreError::new(
        PAGE_NOT_FOUND,
        format!("{op} failed: {endpoint} page \"{slug}\" (source={source}) not found"),
    )
}
