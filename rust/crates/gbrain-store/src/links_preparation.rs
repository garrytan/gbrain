//! The alias read link preparation made through `executeRaw` (`src/core/engine-sql/links-preparation.ts`):
//! the alias slugs a link may follow.
//!
//! Member: readLiveSlugAliases.

use crate::Store;
use crate::aliases::read_slug_alias;
use crate::error::Result;
use crate::pages::read_page;
use serde_json::{Value, json};

impl Store {
    /// `readLiveSlugAliases(sourceId, targets)`: for each distinct target that is the `alias_slug`
    /// of a `slug_aliases` row in the source, `{ alias_slug, canonical_slug }` when no page of the
    /// source that is not soft-deleted sits at the alias slug and one does at the canonical slug.
    /// Live here means not soft-deleted: a quarantined page counts, as the SQL's test does. The
    /// rows follow the targets' byte order.
    pub fn read_live_slug_aliases(
        &self,
        source_id: &str,
        targets: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut distinct: Vec<&String> = targets.iter().collect();
        distinct.sort();
        distinct.dedup();
        let mut out = Vec::new();
        for alias in distinct {
            let Some(row) = read_slug_alias(&*read, source_id, alias)? else {
                continue;
            };
            let live = |slug: &str| -> Result<bool> {
                Ok(read_page(&*read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
            };
            if !live(alias)? && live(&row.canonical_slug)? {
                out.push(json!({"alias_slug": alias, "canonical_slug": row.canonical_slug}));
            }
        }
        Ok(out)
    }
}
