//! The belief ledger's page lifetimes: `belief_page_lifetimes` (src/core/belief/schema.ts,
//! src/core/belief/lifetimes.ts, engine-sql/belief-ledger.ts).
//!
//! Keys, all under `t 0x0a`:
//! - `t 0x0a 0x00 page_lifetime` -> [`LifetimeRecord`].
//! - `t 0x0a 0x01 source_incarnation \0 slug` -> the open lifetime there: the partial unique
//!   index `belief_page_lifetimes_open` (`WHERE ended_at IS NULL`).
//! - `t 0x0a 0x02 page_id (4 bytes, big-endian, sign bit flipped) \0 page_lifetime` -> empty: an
//!   open lifetime with a page id hint, for the moved-lifetime read.
//!
//! UUIDs are kept as Postgres prints them: lowercase and hyphenated. `started_at` and `ended_at`
//! are the store clock at the write (`clock_timestamp()`). The table has no foreign key: a source
//! delete keeps its lifetimes.

use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};

pub(crate) const LIFETIMES: u8 = 0x0a;
pub(crate) const RECORD: u8 = 0x00;
const OPEN: u8 = 0x01;
const BY_PAGE: u8 = 0x02;

/// What is stored for one lifetime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LifetimeRecord {
    pub source_id: String,
    pub source_incarnation: String,
    pub slug: String,
    pub page_id: Option<i32>,
    pub started_at_us: i64,
    pub ended_at_us: Option<i64>,
}

/// One orphaned lifetime (`listOrphanLifetimes`): `reason` is `no_page` or `no_lifetime`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OrphanLifetime {
    pub slug: String,
    pub page_lifetime: String,
    pub reason: String,
}

/// `listOrphanLifetimes`: a sample of orphaned lifetimes and the count of all of them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OrphanLifetimes {
    pub total: usize,
    pub rows: Vec<OrphanLifetime>,
}

/// One open lifetime, as `readOpenBeliefLifetimes` answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenLifetime {
    pub page_lifetime: String,
    pub source_incarnation: String,
    pub slug: String,
    pub page_id: Option<i32>,
}

/// One moved lifetime, as `readMovedBeliefLifetimes` answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MovedLifetime {
    pub page_id: i32,
    pub source_incarnation: String,
    pub page_lifetime: String,
}

/// One `{incarnation, slug}` pair of `readOpenBeliefLifetimes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifetimePair {
    pub incarnation: Option<String>,
    pub slug: Option<String>,
}

/// `mintBeliefLifetime`'s argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LifetimeMint {
    pub lifetime: Option<String>,
    pub source_id: Option<String>,
    pub incarnation: Option<String>,
    pub slug: Option<String>,
    pub page_id: Option<i32>,
}

/// A UUID as Postgres prints it, from any spelling the `uuid` input takes here: hyphenated
/// (8-4-4-4-12) or 32 hex digits, either case.
pub(crate) fn canonical_uuid(text: &str) -> Result<String> {
    let bad = || StoreError::invalid(format!("invalid input syntax for type uuid: \"{text}\""));
    let b = text.as_bytes();
    let hyphenated = b.len() == 36 && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-');
    let digits = if hyphenated {
        text.replace('-', "")
    } else {
        text.to_string()
    };
    if digits.len() != 32 || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad());
    }
    let d = digits.to_ascii_lowercase();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &d[0..8],
        &d[8..12],
        &d[12..16],
        &d[16..20],
        &d[20..32]
    ))
}

/// `text::uuid` of a nullable value.
pub(crate) fn cast_uuid(text: &Option<String>) -> Result<Option<String>> {
    text.as_deref().map(canonical_uuid).transpose()
}

pub(crate) fn record_key(lifetime: &str) -> Vec<u8> {
    let mut key = vec![keys::TRUST, LIFETIMES, RECORD];
    key.extend_from_slice(lifetime.as_bytes());
    key
}

fn open_key(incarnation: &str, slug: &str) -> Vec<u8> {
    let mut key = vec![keys::TRUST, LIFETIMES, OPEN];
    key.extend_from_slice(incarnation.as_bytes());
    key.push(0);
    key.extend_from_slice(slug.as_bytes());
    key
}

fn page_prefix(page_id: i32) -> Vec<u8> {
    let mut key = vec![keys::TRUST, LIFETIMES, BY_PAGE];
    key.extend_from_slice(&((page_id as u32) ^ 0x8000_0000).to_be_bytes());
    key.push(0);
    key
}

fn page_key(page_id: i32, lifetime: &str) -> Vec<u8> {
    let mut key = page_prefix(page_id);
    key.extend_from_slice(lifetime.as_bytes());
    key
}

fn not_null(column: &str) -> StoreError {
    crate::takes::not_null("belief_page_lifetimes", column)
}

fn unique_violation(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("duplicate key value violates unique constraint \"{constraint}\""),
    )
}

/// Adds or removes the open-lifetime keys of `rec`.
fn set_open_keys(
    tx: &mut dyn KvWrite,
    lifetime: &str,
    rec: &LifetimeRecord,
    open: bool,
) -> Result<()> {
    let open_at = open_key(&rec.source_incarnation, &rec.slug);
    let by_page = rec.page_id.map(|p| page_key(p, lifetime));
    if open {
        tx.put(&open_at, lifetime.as_bytes())?;
        if let Some(k) = by_page {
            tx.put(&k, &[])?;
        }
    } else {
        tx.delete(&open_at)?;
        if let Some(k) = by_page {
            tx.delete(&k)?;
        }
    }
    Ok(())
}

fn open_lifetime_at(read: &dyn KvRead, incarnation: &str, slug: &str) -> Result<Option<String>> {
    Ok(read
        .get(&open_key(incarnation, slug))?
        .map(|v| String::from_utf8_lossy(&v).into_owned()))
}

impl Store {
    /// `readOpenBeliefLifetimes`: the open lifetime at each pair that has one, once per pair (a
    /// pair given twice answers twice, as the `unnest` join does).
    pub fn read_open_belief_lifetimes(&self, pairs: &[LifetimePair]) -> Result<Vec<OpenLifetime>> {
        let cast = pairs
            .iter()
            .map(|p| Ok((cast_uuid(&p.incarnation)?, p.slug.clone())))
            .collect::<Result<Vec<_>>>()?;
        let read = self.read()?;
        let mut out = Vec::new();
        for (incarnation, slug) in cast {
            let (Some(incarnation), Some(slug)) = (incarnation, slug) else {
                continue;
            };
            let Some(lifetime) = open_lifetime_at(&*read, &incarnation, &slug)? else {
                continue;
            };
            if let Some(rec) = get_json::<LifetimeRecord>(&*read, &record_key(&lifetime))? {
                out.push(OpenLifetime {
                    page_lifetime: lifetime,
                    source_incarnation: rec.source_incarnation,
                    slug: rec.slug,
                    page_id: rec.page_id,
                });
            }
        }
        Ok(out)
    }

    /// `endBeliefLifetime`: ends the lifetime if it is still open.
    pub fn end_belief_lifetime(&self, lifetime: &str) -> Result<()> {
        let lifetime = canonical_uuid(lifetime)?;
        self.write(|tx| {
            let key = record_key(&lifetime);
            let Some(mut rec) = get_json::<LifetimeRecord>(tx, &key)? else {
                return Ok(());
            };
            if rec.ended_at_us.is_some() {
                return Ok(());
            }
            set_open_keys(tx, &lifetime, &rec, false)?;
            rec.ended_at_us = Some(self.env.now_micros());
            put_json(tx, &key, &rec)
        })
    }

    /// `mintBeliefLifetime`: opens `lifetime` at the pair, or answers the lifetime already open
    /// there. A lifetime id already used elsewhere fails on the primary key.
    pub fn mint_belief_lifetime(&self, mint: &LifetimeMint) -> Result<String> {
        let lifetime = cast_uuid(&mint.lifetime)?;
        let incarnation = cast_uuid(&mint.incarnation)?;
        self.write(|tx| {
            let lifetime = lifetime.clone().ok_or_else(|| not_null("page_lifetime"))?;
            let rec = LifetimeRecord {
                source_id: mint
                    .source_id
                    .clone()
                    .ok_or_else(|| not_null("source_id"))?,
                source_incarnation: incarnation
                    .clone()
                    .ok_or_else(|| not_null("source_incarnation"))?,
                slug: mint.slug.clone().ok_or_else(|| not_null("slug"))?,
                page_id: mint.page_id,
                started_at_us: self.env.now_micros(),
                ended_at_us: None,
            };
            if let Some(open) = open_lifetime_at(tx, &rec.source_incarnation, &rec.slug)? {
                return Ok(open);
            }
            if tx.get(&record_key(&lifetime))?.is_some() {
                return Err(unique_violation("belief_page_lifetimes_pkey"));
            }
            put_json(tx, &record_key(&lifetime), &rec)?;
            set_open_keys(tx, &lifetime, &rec, true)?;
            Ok(lifetime)
        })
    }

    /// `renameBeliefLifetime`: moves the lifetime (open or ended) to `slug`, with `page_id` as its
    /// hint. An open lifetime moved onto a pair with another open lifetime fails on the index.
    pub fn rename_belief_lifetime(
        &self,
        lifetime: &str,
        slug: &str,
        page_id: Option<i32>,
    ) -> Result<()> {
        let lifetime = canonical_uuid(lifetime)?;
        self.write(|tx| {
            let key = record_key(&lifetime);
            let Some(mut rec) = get_json::<LifetimeRecord>(tx, &key)? else {
                return Ok(());
            };
            let open = rec.ended_at_us.is_none();
            if open {
                let held = open_lifetime_at(tx, &rec.source_incarnation, slug)?;
                if held.is_some_and(|h| h != lifetime) {
                    return Err(unique_violation("belief_page_lifetimes_open"));
                }
                set_open_keys(tx, &lifetime, &rec, false)?;
            }
            rec.slug = slug.to_string();
            rec.page_id = page_id;
            if open {
                set_open_keys(tx, &lifetime, &rec, true)?;
            }
            put_json(tx, &key, &rec)
        })
    }

    /// `readMovedBeliefLifetimes`: the open lifetime of each listed page id whose page (deleted or
    /// not, any source) still has the lifetime's slug.
    pub fn read_moved_belief_lifetimes(&self, page_ids: &[i32]) -> Result<Vec<MovedLifetime>> {
        let mut ids = page_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        let read = self.read()?;
        let mut out = Vec::new();
        for page_id in ids {
            let prefix = page_prefix(page_id);
            let mut lifetimes = Vec::new();
            scan_prefix(&*read, &prefix, false, &mut |k, _| {
                lifetimes.push(String::from_utf8_lossy(&k[prefix.len()..]).into_owned());
                true
            })?;
            let page = match u64::try_from(page_id) {
                Ok(id) => crate::pages::read_page_by_id(&*read, id)?,
                Err(_) => None,
            };
            let Some(page) = page else { continue };
            for lifetime in lifetimes {
                let Some(rec) = get_json::<LifetimeRecord>(&*read, &record_key(&lifetime))? else {
                    continue;
                };
                if rec.slug == page.slug {
                    out.push(MovedLifetime {
                        page_id,
                        source_incarnation: rec.source_incarnation,
                        page_lifetime: lifetime,
                    });
                }
            }
        }
        Ok(out)
    }

    /// `listOrphanLifetimes(sourceId, limit, deep)`: the open lifetimes of the source's current
    /// incarnation whose slug has no page row (a soft-deleted page is a row; reason `no_page`) and,
    /// when `deep`, the lifetimes the source's events (any incarnation) name that no lifetime record
    /// holds (reason `no_lifetime`, one row per slug and lifetime). Ordered by slug then lifetime
    /// bytes, at most `max(1, limit)` of them, with the count of all of them.
    pub fn list_orphan_belief_lifetimes(
        &self,
        source_id: &str,
        limit: usize,
        deep: bool,
    ) -> Result<OrphanLifetimes> {
        let read = self.read()?;
        let incarnation = crate::sources::read_source(&*read, source_id)?.map(|s| s.incarnation);
        let prefix = vec![keys::TRUST, LIFETIMES, RECORD];
        let mut known = std::collections::BTreeSet::new();
        let mut open = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            let lifetime = String::from_utf8_lossy(&k[prefix.len()..]).into_owned();
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(rec) => {
                    if rec.source_id == source_id
                        && rec.ended_at_us.is_none()
                        && incarnation.as_deref() == Some(rec.source_incarnation.as_str())
                    {
                        open.push((rec.slug, lifetime.clone()));
                    }
                    known.insert(lifetime);
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut orphans = std::collections::BTreeSet::new();
        for (slug, lifetime) in open {
            if crate::pages::read_page(&*read, source_id, &slug)?.is_none() {
                orphans.insert((slug, lifetime, "no_page"));
            }
        }
        if deep {
            let events = super::belief_events::part_key(
                &[
                    keys::TRUST,
                    super::belief_events::EVENTS,
                    super::belief_events::EVENT,
                ],
                &[source_id],
                None,
            );
            let mut failure = None;
            scan_prefix(&*read, &events, false, &mut |_, v| {
                match serde_json::from_slice::<super::belief_events::EventRecord>(v) {
                    Ok(e) if e.source_id == source_id => {
                        if let Some(lifetime) = e.page_lifetime
                            && !known.contains(&lifetime)
                        {
                            orphans.insert((e.slug, lifetime, "no_lifetime"));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            })?;
            if let Some(e) = failure {
                return Err(e);
            }
        }
        let total = orphans.len();
        let rows = orphans
            .into_iter()
            .take(limit.max(1))
            .map(|(slug, page_lifetime, reason)| OrphanLifetime {
                slug,
                page_lifetime,
                reason: reason.to_string(),
            })
            .collect();
        Ok(OrphanLifetimes { total, rows })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    const INC: &str = "11111111-1111-1111-1111-111111111111";
    const L1: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const L2: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    fn mint(store: &Store, lifetime: &str, slug: &str, page: i32) -> Result<String> {
        store.mint_belief_lifetime(&LifetimeMint {
            lifetime: Some(lifetime.into()),
            source_id: Some("default".into()),
            incarnation: Some(INC.to_uppercase()),
            slug: Some(slug.into()),
            page_id: Some(page),
        })
    }

    fn open(store: &Store, slug: &str) -> Vec<OpenLifetime> {
        let pair = LifetimePair {
            incarnation: Some(INC.into()),
            slug: Some(slug.into()),
        };
        store
            .read_open_belief_lifetimes(&[pair.clone(), pair])
            .unwrap()
    }

    #[test]
    fn a_lifetime_mints_once_per_open_pair_renames_and_ends() {
        let store = store();
        assert_eq!(mint(&store, &L1.to_uppercase(), "a", 1).unwrap(), L1);
        assert_eq!(mint(&store, L2, "a", 2).unwrap(), L1);
        assert_eq!(open(&store, "a").len(), 2);
        assert_eq!(open(&store, "a")[0].source_incarnation, INC);
        assert_eq!(
            mint(&store, L1, "b", 1).unwrap_err().code,
            CONSTRAINT_VIOLATION
        );
        assert_eq!(mint(&store, L2, "b", 2).unwrap(), L2);
        let err = store.rename_belief_lifetime(L2, "a", Some(2)).unwrap_err();
        assert!(err.message.contains("belief_page_lifetimes_open"));
        store.rename_belief_lifetime(L2, "c", Some(3)).unwrap();
        assert!(open(&store, "b").is_empty());
        assert_eq!(open(&store, "c")[0].page_id, Some(3));
        store.end_belief_lifetime(L1).unwrap();
        assert!(open(&store, "a").is_empty());
        // An ended lifetime renames onto an open pair: the unique index covers open ones only.
        store.rename_belief_lifetime(L1, "c", Some(9)).unwrap();
        assert_eq!(open(&store, "c")[0].page_lifetime, L2);
        let read = store.read().unwrap();
        let ended = get_json::<LifetimeRecord>(&*read, &record_key(L1))
            .unwrap()
            .unwrap();
        assert!(ended.ended_at_us.is_some_and(|t| t >= ended.started_at_us));
        assert!(store.end_belief_lifetime("x").is_err());
    }

    #[test]
    fn a_moved_lifetime_is_read_by_page_id_while_the_page_keeps_its_slug() {
        let store = store();
        let input = serde_json::from_value(
            serde_json::json!({"type": "note", "title": "t", "compiled_truth": "x"}),
        )
        .unwrap();
        let opts = serde_json::from_value(serde_json::json!({"sourceId": "default"})).unwrap();
        store.put_page("people/a", &input, &opts).unwrap();
        let page = crate::pages::read_page(&*store.read().unwrap(), "default", "people/a")
            .unwrap()
            .unwrap()
            .id as i32;
        mint(&store, L1, "people/a", page).unwrap();
        mint(&store, L2, "people/b", page).unwrap();
        let moved = store
            .read_moved_belief_lifetimes(&[page, page, -1, 999])
            .unwrap();
        assert_eq!(
            moved,
            vec![MovedLifetime {
                page_id: page,
                source_incarnation: INC.into(),
                page_lifetime: L1.into()
            }]
        );
        store.end_belief_lifetime(L1).unwrap();
        assert!(
            store
                .read_moved_belief_lifetimes(&[page])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn orphaned_lifetimes_are_the_open_ones_with_no_page_sampled_by_bytes() {
        let store = store();
        let inc = crate::sources::read_source(&*store.read().unwrap(), "default")
            .unwrap()
            .unwrap()
            .incarnation;
        let mint_at = |lifetime: &str, slug: &str| {
            store
                .mint_belief_lifetime(&LifetimeMint {
                    lifetime: Some(lifetime.into()),
                    source_id: Some("default".into()),
                    incarnation: Some(inc.clone()),
                    slug: Some(slug.into()),
                    page_id: Some(1),
                })
                .unwrap()
        };
        mint_at(L1, "b-gone");
        mint_at(L2, "a-gone");
        mint_at("cccccccc-cccc-cccc-cccc-cccccccccccc", "ended");
        store
            .end_belief_lifetime("cccccccc-cccc-cccc-cccc-cccccccccccc")
            .unwrap();
        // An open lifetime of an old incarnation is not the source's: it is never an orphan here.
        mint(&store, "dddddddd-dddd-dddd-dddd-dddddddddddd", "old", 1).unwrap();
        let all = store
            .list_orphan_belief_lifetimes("default", 20, false)
            .unwrap();
        assert_eq!(all.total, 2);
        assert_eq!(
            all.rows
                .iter()
                .map(|r| (r.slug.as_str(), r.reason.as_str()))
                .collect::<Vec<_>>(),
            vec![("a-gone", "no_page"), ("b-gone", "no_page")]
        );
        let capped = store
            .list_orphan_belief_lifetimes("default", 0, true)
            .unwrap();
        assert_eq!((capped.total, capped.rows.len()), (2, 1));
        assert_eq!(
            store
                .list_orphan_belief_lifetimes("ghost", 20, true)
                .unwrap()
                .total,
            0
        );
    }
}
