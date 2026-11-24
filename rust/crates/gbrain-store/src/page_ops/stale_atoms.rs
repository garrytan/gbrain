//! The read of `gbrain repair stale-atoms` (src/core/engine-sql/stale-atom-reads.ts): `listStaleAtoms`.
//!
//! A live, non-imported atom of the sources with a `source_slug` is stale when its origin page is gone (no page row
//! holds the origin slug, or that row is soft-deleted) or when the origin's content hash moved past the atom's hash and
//! a completed extraction of the origin's current content exists: for a managed atom the failure-free `managed-atoms`
//! checkpoint of the origin at its hash, with a live atom of that origin at the new hash; for an unmanaged one a live
//! unmanaged atom of that origin at the new hash. The origin slug is the atom's `source_slug` while any page row holds
//! it, else the slug a `rename` alias moved it to (`atomOriginSlugSql`). Rows come back origin-gone first, then by id.

use super::fm_text;
use crate::Store;
use crate::aliases::read_slug_alias;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages};
use crate::persistence::list_op_checkpoint_records_in;
use crate::sources::read_source;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

const MANAGED_ATOMS_OP: &str = "managed-atoms";

fn fm_nonempty(page: &PageRecord, key: &str) -> Option<String> {
    fm_text(&page.frontmatter, key).filter(|v| !v.is_empty())
}

/// `regexp_replace(COALESCE(source_hash, ''), '^pending:', '')`.
fn stripped_hash(page: &PageRecord) -> String {
    let raw = fm_text(&page.frontmatter, "source_hash").unwrap_or_default();
    raw.strip_prefix("pending:")
        .map(str::to_string)
        .unwrap_or(raw)
}

/// `substring(hash from 1 for 16)`.
fn prefix16(hash: &str) -> String {
    hash.chars().take(16).collect()
}

/// `ck0->>key` of a checkpoint's first completed-keys record.
fn ck_text(record: &Value, key: &str) -> Option<String> {
    match record.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

impl Store {
    /// `listStaleAtoms(sourceIds, atomId)`.
    pub fn list_stale_atoms(
        &self,
        source_ids: &[String],
        atom_id: Option<i64>,
    ) -> Result<Vec<Value>> {
        for source in source_ids {
            no_nul("listStaleAtoms", &[("sourceIds", source)])?;
        }
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let by_slug: HashMap<(&str, &str), &PageRecord> = pages
            .iter()
            .map(|p| ((p.source_id.as_str(), p.slug.as_str()), p))
            .collect();
        let checkpoints = list_op_checkpoint_records_in(&*read, MANAGED_ATOMS_OP)?;
        let mut incarnations: HashMap<String, Option<String>> = HashMap::new();
        let mut out: Vec<(u8, u64, Value)> = Vec::new();
        let live_atoms: Vec<&PageRecord> = pages
            .iter()
            .filter(|p| p.page_type == "atom" && p.deleted_at_us.is_none())
            .collect();
        for a in &live_atoms {
            if !sources.contains(a.source_id.as_str())
                || fm_nonempty(a, "imported_from").is_some()
                || atom_id.is_some_and(|id| i64::try_from(a.id).is_ok_and(|own| own != id))
            {
                continue;
            }
            let Some(origin_slug) = fm_nonempty(a, "source_slug") else {
                continue;
            };
            let live_slug = if by_slug.contains_key(&(a.source_id.as_str(), origin_slug.as_str())) {
                origin_slug.clone()
            } else {
                read_slug_alias(&*read, &a.source_id, &origin_slug)?
                    .filter(|alias| alias.notes.as_deref() == Some("rename"))
                    .map(|alias| alias.canonical_slug)
                    .unwrap_or_else(|| origin_slug.clone())
            };
            let origin = by_slug
                .get(&(a.source_id.as_str(), live_slug.as_str()))
                .copied();
            let managed = fm_text(&a.frontmatter, "managed_extraction").as_deref() == Some("true");
            let atom_hash = stripped_hash(a);
            let origin_hash = origin.and_then(|o| o.content_hash.clone());
            let class = match origin {
                None => "origin_gone",
                Some(o) if o.deleted_at_us.is_some() => "origin_gone",
                Some(_) => match &origin_hash {
                    Some(h) if atom_hash != prefix16(h) => "origin_changed",
                    _ => continue,
                },
            };
            let slugs = [origin_slug.as_str(), live_slug.as_str()];
            let completion = match (class, origin, &origin_hash) {
                ("origin_changed", Some(o), Some(h)) => {
                    let new_hash = prefix16(h);
                    let atom_at_new = |m: Option<bool>, stripped: bool| {
                        live_atoms.iter().filter(move |r| {
                            r.source_id == a.source_id
                                && fm_text(&r.frontmatter, "source_slug")
                                    .is_some_and(|s| slugs.contains(&s.as_str()))
                                && m.is_none_or(|unmanaged| {
                                    unmanaged
                                        == (fm_text(&r.frontmatter, "managed_extraction")
                                            .as_deref()
                                            != Some("true"))
                                })
                                && if stripped {
                                    stripped_hash(r) == new_hash
                                } else {
                                    fm_text(&r.frontmatter, "source_hash").as_deref()
                                        == Some(new_hash.as_str())
                                }
                        })
                    };
                    if managed {
                        let incarnation = match incarnations.get(&o.source_id) {
                            Some(i) => i.clone(),
                            None => {
                                let i = read_source(&*read, &o.source_id)?.map(|s| s.incarnation);
                                incarnations.insert(o.source_id.clone(), i.clone());
                                i
                            }
                        };
                        let replaced = atom_at_new(None, true).next().is_some();
                        let mut found: Vec<String> = Vec::new();
                        if replaced {
                            for row in checkpoints.as_array().into_iter().flatten() {
                                let Some(ck) = row["completed_keys"].get(0) else {
                                    continue;
                                };
                                if ck_text(ck, "sourceId").as_deref() == Some(o.source_id.as_str())
                                    && ck_text(ck, "incarnation") == incarnation
                                    && ck_text(ck, "kind").as_deref() == Some("page")
                                    && ck_text(ck, "pageId").as_deref()
                                        == Some(o.id.to_string().as_str())
                                    && ck_text(ck, "contentHash").as_deref() == Some(h.as_str())
                                    && ck_text(ck, "failure").is_none()
                                    && let Some(fp) = row["fingerprint"].as_str()
                                {
                                    found.push(fp.to_string());
                                }
                            }
                        }
                        found.sort_by(|x, y| x.as_bytes().cmp(y.as_bytes()));
                        found.into_iter().next()
                    } else {
                        atom_at_new(Some(true), false)
                            .map(|e| e.id)
                            .min()
                            .map(|id| format!("unmanaged:{id}"))
                    }
                }
                _ => None,
            };
            if class == "origin_changed" && completion.is_none() {
                continue;
            }
            let gone = class == "origin_gone";
            out.push((
                if gone { 1 } else { 2 },
                a.id,
                json!({
                    "id": a.id,
                    "source_id": a.source_id,
                    "incarnation": read_source(&*read, &a.source_id)?.map(|s| s.incarnation),
                    "slug": a.slug,
                    "revision": a.knowledge_revision,
                    "class": class,
                    "managed": managed,
                    "origin_slug": origin_slug,
                    "origin_page_id": origin.map(|o| o.id),
                    "origin_hash": if gone { None } else { origin_hash.clone() },
                    "evidence": if gone { None } else { completion },
                    "chars": a.compiled_truth.chars().count(),
                }),
            ));
        }
        out.sort_by_key(|(rank, id, _)| (*rank, *id));
        Ok(out.into_iter().map(|(_, _, row)| row).collect())
    }
}
