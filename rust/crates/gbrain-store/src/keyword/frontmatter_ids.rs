//! `filterPageIdsByFrontmatter(ids, where)`: the page ids of a finished search whose frontmatter
//! holds the `where` filter (`keepFrontmatterMatches`, src/core/search/frontmatter-where.ts). The
//! SQL engines read `SELECT p.id FROM pages p WHERE p.id = ANY($1::bigint[])` plus one
//! containment clause per key; this answers the same ids from the page records, with the rule the
//! keyword and vector `where` filters use ([`frontmatter_holds`]).

use std::collections::BTreeSet;

use serde_json::Value;

use super::filters::frontmatter_holds;
use crate::Store;
use crate::error::Result;
use crate::pages::read_page_by_id;

impl Store {
    /// The ids, ascending and each once, whose page holds every `where` entry. Every page row
    /// counts, a soft-deleted one included, since the SQL reads `pages` with no other predicate;
    /// an id with no page drops.
    pub fn filter_page_ids_by_frontmatter(
        &self,
        ids: &[u64],
        where_fields: &[(String, Vec<Value>)],
    ) -> Result<Vec<u64>> {
        let read = self.read()?;
        let mut kept = BTreeSet::new();
        for &id in ids {
            if let Some(page) = read_page_by_id(&*read, id)?
                && where_fields
                    .iter()
                    .all(|(key, values)| frontmatter_holds(&page.frontmatter, key, values))
            {
                kept.insert(id);
            }
        }
        Ok(kept.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions, read_page};
    use crate::test_support::store;
    use serde_json::json;

    fn page(s: &Store, slug: &str, frontmatter: Value) -> u64 {
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
        )
        .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        s.put_page(slug, &input, &opts).unwrap();
        read_page(&*s.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    /// `frontmatterWhereSql` on page ids: every key holds, a key's forms OR together, a list field
    /// holds a value it contains, a soft-deleted page still counts, and an unknown id drops.
    #[test]
    fn keeps_the_ids_whose_page_frontmatter_holds_every_key() {
        let s = store();
        let active = page(&s, "a-active", json!({"status": "active", "cycle": 2024}));
        let listed = page(&s, "b-listed", json!({"status": ["review", "active"]}));
        let archived = page(
            &s,
            "c-archived",
            json!({"status": "archived", "cycle": 2024}),
        );
        let gone = page(&s, "d-gone", json!({"status": "active"}));
        s.soft_delete_page("d-gone", Some("default")).unwrap();
        let ids = [gone, archived, listed, active, 9_999];
        let keep = |w: Value| {
            let w: Vec<(String, Vec<Value>)> = serde_json::from_value(w).unwrap();
            s.filter_page_ids_by_frontmatter(&ids, &w).unwrap()
        };
        let mut expect_active = vec![active, listed, gone];
        expect_active.sort();
        assert_eq!(keep(json!([["status", ["active"]]])), expect_active);
        // `--where cycle=2024` sends the string and its numeric reading.
        let mut cycle = vec![active, archived];
        cycle.sort();
        assert_eq!(keep(json!([["cycle", ["2024", 2024]]])), cycle);
        assert_eq!(
            keep(json!([["status", ["active"]], ["cycle", ["2024", 2024]]])),
            vec![active]
        );
        assert!(keep(json!([["status", ["missing"]]])).is_empty());
    }
}
