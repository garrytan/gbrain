//! The pages a federation exposes (`readFederationExposedPages`, `src/core/engine-sql/federation-exposure.ts`): the
//! live pages of a source that name no readers and carry no folder rule, written (now or in an archived version) by a
//! remote credential, for the `sources federate` and `sources add` warning (src/core/access/federation-exposure.ts).

use std::collections::BTreeMap;

use serde::Serialize;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::{names_no_readers_or_rules, privacy_allows};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, versions_of};

/// One row: the slug, the smallest member bound to a credential that wrote it (null when none is), and how many slugs
/// qualify in all (`count(*) OVER ()`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FederationExposedRow {
    pub slug: String,
    pub member: Option<String>,
    pub total: u64,
}

fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut prefix = keys::text(keys::PAGE, &[source_id]);
    prefix.push(0);
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |_, v| {
        match serde_json::from_slice::<PageRecord>(v) {
            Ok(page) if page.source_id == source_id => out.push(page),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

impl Store {
    /// `readFederationExposedPages(sourceId, hidePrivate)`: the first five qualifying slugs in byte order. A page
    /// qualifies when it is live, names no readers, carries no folder rule, passes `privacyPartSql` (with
    /// `hide_private`; `honor_aliases` is the rendering's alias setting), and its live revision or an archived version
    /// was written by a `legacy_token` or `oauth_client` principal. The member is the client's `member_id` (the store
    /// keeps no access tokens, so a token writer binds no member).
    pub fn read_federation_exposed_pages(
        &self,
        source_id: &str,
        hide_private: bool,
        honor_aliases: bool,
    ) -> Result<Vec<FederationExposedRow>> {
        let read = self.read()?;
        let mut by_slug: BTreeMap<String, Option<String>> = BTreeMap::new();
        for page in source_pages(&*read, source_id)? {
            if page.deleted_at_us.is_some() || !names_no_readers_or_rules(&*read, &page)? {
                continue;
            }
            if hide_private && !privacy_allows(&*read, &page, honor_aliases)? {
                continue;
            }
            let mut writers = vec![(
                page.revision_receipt.principal_kind.clone(),
                page.revision_receipt.principal_id.clone(),
            )];
            for version in versions_of(&*read, page.id)? {
                writers.push((
                    version.receipt.written.principal_kind.clone(),
                    version.receipt.written.principal_id.clone(),
                ));
            }
            for (kind, pid) in writers {
                let member = match kind.as_deref() {
                    Some("oauth_client") => match pid.as_deref() {
                        Some(id) => self.read_oauth_client(id)?.and_then(|row| {
                            row.get("member_id")
                                .and_then(|m| m.as_str())
                                .map(str::to_string)
                        }),
                        None => None,
                    },
                    Some("legacy_token") => None,
                    _ => continue,
                };
                let entry = by_slug.entry(page.slug.clone()).or_insert(None);
                if let Some(member) = member
                    && entry.as_ref().is_none_or(|current| member < *current)
                {
                    *entry = Some(member);
                }
            }
        }
        let total = by_slug.len() as u64;
        Ok(by_slug
            .into_iter()
            .take(5)
            .map(|(slug, member)| FederationExposedRow {
                slug,
                member,
                total,
            })
            .collect())
    }
}
