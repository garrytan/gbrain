//! The relink writes of `facts` rows (src/core/engine-sql/fact-relink-writes.ts): the guarded
//! `UPDATE facts` statements `gbrain facts relink` ran through `executeRaw`.
//!
//! Members: placeRelinkedFact (facts/relink-publish.ts, the coordinator mutation `relink_facts`)
//! and linkConversationFact (facts/conversation-relink.ts, `gbrain facts relink --conversation`),
//! and the read that picks the conversation relink's pages (listConversationRelinkPages).
//!
//! Each member reads the one row by id, applies the statement's `WHERE` to it, and writes the
//! changed row through [`write_fact`], so the trust stamp and the unique indexes run as the
//! `UPDATE` would. A row the `WHERE` does not match is left alone and the member returns false (the
//! statement's empty `RETURNING`). The withdrawal and purge guards of the `UPDATE` are not modeled
//! (\"Not modeled\" in rust/docs/store/facts.md): their ledgers have no Rust writer.

use super::relink::Memos;
use super::{
    AUDIT_ROW_SOURCES, FactRecord, count_arg, fact_by_number, purge::unbacked, source_rows,
    write_fact,
};
use crate::Store;
use crate::dream::int4;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use std::collections::BTreeMap;

/// `placeRelinkedFact(sourceId, placement)`: the placement. `link` moves the row onto `slug`'s
/// fence at `rowNum`; `retire` expires it as a duplicate on `slug`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelinkPlacement {
    pub fact_id: f64,
    pub action: String,
    pub slug: String,
    pub context: String,
    #[serde(default)]
    pub row_num: Option<f64>,
}

/// `linkConversationFact(sourceId, link)`: the planned link. A non-empty `from` is the unbacked
/// name key the row moves off; otherwise the row has no entity.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationFactLink {
    pub fact_id: f64,
    pub page_slug: String,
    pub fact: String,
    pub entity_slug: String,
    pub context: String,
    #[serde(default)]
    pub from: Option<String>,
}

/// `listConversationRelinkPages(sourceId, q)`: the planner's page pick. `rearmedReasons` is
/// `REARMED_REASONS` of facts/conversation-memo.ts, passed by the TypeScript member so the two
/// cannot drift.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRelinkPagesQuery {
    pub limit: f64,
    pub unbacked: bool,
    pub skip_tried: bool,
    #[serde(default)]
    pub rearmed_reasons: Vec<String>,
}

/// `derivedConversationRow`: `source LIKE 'cli:extract-conversation-facts%' AND source <>
/// ALL(AUDIT_ROW_SOURCES)`.
fn derived_conversation_row(row: &FactRecord) -> bool {
    row.conversation_slot() && !AUDIT_ROW_SOURCES.contains(&row.source.as_str())
}

/// `ENTITY_LINKABLE_SQL`: `attributed_to IS NULL OR attributed_to = 'user'`.
fn entity_linkable(row: &FactRecord) -> bool {
    row.attributed_to.as_deref().is_none_or(|a| a == "user")
}

/// `entity_slug IS NULL AND row_num IS NULL AND source_markdown_slug IS NULL AND expired_at IS
/// NULL`: the row has no place yet.
fn unplaced(row: &FactRecord) -> bool {
    row.entity_slug.is_none()
        && row.row_num.is_none()
        && row.source_markdown_slug.is_none()
        && row.expired_at_us.is_none()
}

impl Store {
    /// `placeRelinkedFact(sourceId, placement)`: `UPDATE facts SET entity_slug = slug,
    /// source_markdown_slug = slug, row_num = rowNum, context` (`link`), or `SET entity_slug =
    /// slug, expired_at = now(), context` (`retire`), `WHERE source_id AND id` and the row has no
    /// place yet. True when the row changed. A fence position another row holds refuses as the
    /// unique index does (`23505`).
    pub fn place_relinked_fact(
        &self,
        source_id: &str,
        placement: &RelinkPlacement,
    ) -> Result<bool> {
        const OP: &str = "placeRelinkedFact";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("slug", placement.slug.as_str()),
                ("context", placement.context.as_str()),
            ],
        )?;
        let row_num = match (placement.action.as_str(), placement.row_num) {
            ("link", Some(n)) => Some(int4(OP, "rowNum", n)?),
            ("link", None) => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP}: a link placement needs rowNum"),
                ));
            }
            ("retire", _) => None,
            (other, _) => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP}: unknown action {other:?} (link or retire)"),
                ));
            }
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = fact_by_number(&*tx, OP, "factId", placement.fact_id)? else {
                return Ok(false);
            };
            if old.source_id != source_id || !unplaced(&old) {
                return Ok(false);
            }
            let mut new = old.clone();
            new.entity_slug = Some(placement.slug.clone());
            new.context = Some(placement.context.clone());
            match row_num {
                Some(n) => {
                    new.source_markdown_slug = Some(placement.slug.clone());
                    new.row_num = Some(n);
                }
                None => new.expired_at_us = Some(now),
            }
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `linkConversationFact(sourceId, link)`: `UPDATE facts f SET entity_slug, context WHERE
    /// source_id AND id AND source_markdown_slug = pageSlug AND fact` and the row is still as
    /// planned: live with no entity, or (with `from`) live on the unbacked name key `from`; user
    /// or unattributed; a conversation extractor's derived row; and the target page is live. True
    /// when the row changed.
    pub fn link_conversation_fact(
        &self,
        source_id: &str,
        link: &ConversationFactLink,
    ) -> Result<bool> {
        const OP: &str = "linkConversationFact";
        let from = link.from.as_deref().filter(|f| !f.is_empty());
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("pageSlug", link.page_slug.as_str()),
                ("fact", link.fact.as_str()),
                ("entitySlug", link.entity_slug.as_str()),
                ("context", link.context.as_str()),
                ("from", from.unwrap_or("")),
            ],
        )?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = fact_by_number(&*tx, OP, "factId", link.fact_id)? else {
                return Ok(false);
            };
            let planned = old.source_id == source_id
                && old.source_markdown_slug.as_deref() == Some(link.page_slug.as_str())
                && old.fact == link.fact
                && old.active(now)
                && match from {
                    Some(from) => old.entity_slug.as_deref() == Some(from) && unbacked(&*tx, &old)?,
                    None => old.entity_slug.is_none(),
                }
                && entity_linkable(&old)
                && derived_conversation_row(&old)
                && read_page(&*tx, source_id, &link.entity_slug)?
                    .is_some_and(|p| p.deleted_at_us.is_none());
            if !planned {
                return Ok(false);
            }
            let mut new = old.clone();
            new.entity_slug = Some(link.entity_slug.clone());
            new.context = Some(link.context.clone());
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `listConversationRelinkPages(sourceId, q)`: `SELECT source_markdown_slug FROM facts f WHERE
    /// source_id AND source_markdown_slug IS NOT NULL AND` the row is live and has no entity (or,
    /// with `unbacked`, sits on an unbacked name key) `AND` user or unattributed `AND` a
    /// conversation extractor's derived row, `AND NOT` tried (`skipTried`, `conversationTriedSql`),
    /// `GROUP BY` page `ORDER BY COUNT(*) DESC, slug COLLATE "C" LIMIT limit`.
    pub fn list_conversation_relink_pages(
        &self,
        source_id: &str,
        q: &ConversationRelinkPagesQuery,
    ) -> Result<Vec<String>> {
        const OP: &str = "listConversationRelinkPages";
        let texts: Vec<(&str, &str)> = std::iter::once(("sourceId", source_id))
            .chain(
                q.rearmed_reasons
                    .iter()
                    .map(|r| ("rearmedReasons", r.as_str())),
            )
            .collect();
        no_nul(OP, &texts)?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut memos = q.skip_tried.then(|| Memos::new(&*read, &q.rearmed_reasons));
        let mut pages: BTreeMap<String, u64> = BTreeMap::new();
        for row in source_rows(&*read, source_id)? {
            let Some(slug) = row.source_markdown_slug.as_deref() else {
                continue;
            };
            let keyed = if q.unbacked {
                unbacked(&*read, &row)?
            } else {
                row.entity_slug.is_none()
            };
            if !(keyed
                && row.active(now)
                && entity_linkable(&row)
                && derived_conversation_row(&row))
            {
                continue;
            }
            if let Some(m) = memos.as_mut()
                && m.tried(&row)?
            {
                continue;
            }
            *pages.entry(slug.to_string()).or_default() += 1;
        }
        let mut pages: Vec<(String, u64)> = pages.into_iter().collect();
        pages.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        pages.truncate(limit);
        Ok(pages.into_iter().map(|(slug, _)| slug).collect())
    }
}
