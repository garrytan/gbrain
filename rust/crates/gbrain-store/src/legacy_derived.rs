//! `countLegacyDerivedPages(sourceId)` (`src/core/facts/derivation-inputs.ts`): the live atom and dream pages of a source
//! that no `derivation_inputs` row explains. The rows are `generations/derivation_inputs.rs`'s (`h 0x0A` and `h 0x0B`).

use crate::generations::has_inputs;
use crate::{Result, Store};

impl Store {
    /// `countLegacyDerivedPages(sourceId)`: the live atom and dream pages of the source (`type = 'atom'` or
    /// `frontmatter->>'dream_generated' = 'true'`) that no recorded edge explains (no `derivation_inputs` row derives
    /// them).
    pub fn count_legacy_derived_pages(&self, source_id: &str) -> Result<i64> {
        let read = self.read()?;
        let mut n = 0;
        for page in crate::pages::all_pages(&*read)? {
            if page.source_id != source_id || page.deleted_at_us.is_some() {
                continue;
            }
            let dream = page
                .frontmatter
                .get("dream_generated")
                .and_then(crate::cli_reads::entities::arrow_text)
                .as_deref()
                == Some("true");
            if (page.page_type == "atom" || dream)
                && !has_inputs(&*read, "pages", &page.id.to_string())?
            {
                n += 1;
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use crate::generations::{DerivationInputsArgs, derived_closure, inputs_of, lineage_reaches};
    use crate::test_support::store;
    use serde_json::json;
    use std::collections::BTreeSet;

    fn pair(table: &str, id: &str) -> (String, String) {
        (table.to_string(), id.to_string())
    }

    /// The upward walk (`lineage_reaches`) and the downward one (`derived_closure`) are transitive and end on a cycle.
    #[test]
    fn the_lineage_walks_are_transitive_and_survive_a_cycle() {
        let s = store();
        let edge = |d: (&str, &str), i: (&str, &str)| {
            let args: DerivationInputsArgs = serde_json::from_value(json!({
                "derived": { "table": d.0, "id": d.1 }, "inputs": [{ "table": i.0, "id": i.1 }],
            }))
            .unwrap();
            s.record_derivation_inputs(&args).unwrap();
        };
        edge(("pages", "3"), ("pages", "2"));
        edge(("pages", "2"), ("facts", "1"));
        edge(("facts", "1"), ("pages", "3"));
        let read = s.read().unwrap();
        assert_eq!(
            inputs_of(&*read, "pages", "3").unwrap(),
            vec![pair("pages", "2")]
        );
        let mut up = BTreeSet::new();
        let reached = lineage_reaches(&*read, "pages", "3", &mut |t, id| {
            up.insert(pair(t, id));
            Ok(false)
        })
        .unwrap();
        assert!(!reached);
        let all: BTreeSet<_> = [pair("facts", "1"), pair("pages", "2"), pair("pages", "3")]
            .into_iter()
            .collect();
        assert_eq!(up, all);
        assert_eq!(derived_closure(&*read, &[pair("facts", "1")]).unwrap(), all);
    }
}
