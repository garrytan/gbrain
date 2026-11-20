//! The fact row move of `src/core/generations/fence-evidence.ts` (`moveKeptRows`, #8819): the
//! kept rows a fence row's number claims move to fresh numbers above the page.
//!
//! Member: moveKeptFactRows (`engine-sql/generation-fence-evidence.ts`). It adds no keys.

use super::{FactRecord, invalid, page_rows, read_fact, write_fact};
use crate::Store;
use crate::dream::int4;
use crate::error::Result;
use crate::links::no_nul;
use std::collections::BTreeSet;

impl Store {
    /// `moveKeptFactRows(sourceId, slug, ids, claimed)`: the rows of `ids` in `source_id` whose
    /// row number is one of `claimed` take the numbers `top + 1`, `top + 2`, ... in (row number,
    /// id) order, where `top` is the largest row number of page `slug` and of `claimed` (at least
    /// 0). A row of another page moves too, as the statement does not name the page for it.
    pub fn move_kept_fact_rows(
        &self,
        source_id: &str,
        slug: &str,
        ids: &[f64],
        claimed: &[f64],
    ) -> Result<()> {
        const OP: &str = "moveKeptFactRows";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let mut wanted = BTreeSet::new();
        for id in ids {
            let id = super::bigint(OP, "ids", *id)?;
            if let Ok(id) = u64::try_from(id) {
                wanted.insert(id);
            }
        }
        let claimed: BTreeSet<i32> = claimed
            .iter()
            .map(|n| int4(OP, "claimed", *n))
            .collect::<Result<_>>()?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let page_top = page_rows(tx, source_id, slug)?
                .iter()
                .filter_map(|r| r.row_num)
                .max()
                .unwrap_or(0);
            let top = page_top.max(claimed.last().copied().unwrap_or(0));
            let mut moving: Vec<FactRecord> = Vec::new();
            for id in &wanted {
                if let Some(row) = read_fact(tx, *id)?
                    && row.source_id == source_id
                    && row.row_num.is_some_and(|n| claimed.contains(&n))
                {
                    moving.push(row);
                }
            }
            moving.sort_by_key(|r| (r.row_num, r.id));
            for (i, old) in moving.iter().enumerate() {
                let next = i32::try_from(i + 1)
                    .ok()
                    .and_then(|i| top.checked_add(i))
                    .ok_or_else(|| invalid(format!("{OP}: integer out of range (row_num)")))?;
                let mut new = old.clone();
                new.row_num = Some(next);
                write_fact(tx, trust, Some(old), &new)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{InsertFactsArgs, NewFactInput};
    use super::*;
    use crate::test_support::store;

    fn page(store: &Store, slug: &str, rows: &[(&str, f64)]) -> Vec<u64> {
        let rows = rows
            .iter()
            .map(|(fact, row_num)| NewFactInput {
                fact: Some((*fact).into()),
                source: Some("test".into()),
                valid_from: Some("2026-01-01T00:00:00.000Z".into()),
                entity_slug: Some(slug.into()),
                row_num: Some(*row_num),
                source_markdown_slug: Some(slug.into()),
                ..NewFactInput::default()
            })
            .collect();
        let out = store
            .insert_facts(&InsertFactsArgs {
                rows,
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        serde_json::from_value(out["ids"].clone()).unwrap()
    }

    fn row_num(store: &Store, id: u64) -> Option<i32> {
        read_fact(&*store.read().unwrap(), id)
            .unwrap()
            .unwrap()
            .row_num
    }

    #[test]
    fn claimed_rows_move_above_the_page_and_the_claims_in_order() {
        let store = store();
        let a = page(&store, "people/a", &[("r1", 1.0), ("r2", 2.0), ("r3", 3.0)]);
        // r3 holds no claimed number; r1 and r2 do. A claim of 7 lifts the top above the page.
        store
            .move_kept_fact_rows(
                "default",
                "people/a",
                &[a[1] as f64, a[0] as f64, a[2] as f64, 999.0],
                &[2.0, 1.0, 7.0],
            )
            .unwrap();
        assert_eq!(row_num(&store, a[0]), Some(8));
        assert_eq!(row_num(&store, a[1]), Some(9));
        assert_eq!(row_num(&store, a[2]), Some(3));
        assert_eq!(
            store
                .move_kept_fact_rows("default", "people/a", &[], &[1.5])
                .unwrap_err()
                .code,
            crate::error::INVALID_ARGUMENT
        );
    }
}
