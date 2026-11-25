//! Jobs: the facts backstop effect's two extraction reads (`src/core/engine-sql/facts-backstop.ts`):
//! whether a page still has a facts extraction waiting to run (`hasPendingFactsExtraction`), and
//! whether one finished for it (`hasCompletedFactsExtraction`). Both match `data->>'page_id'` as
//! PostgreSQL's `->>` reads it (a JSON number is its text, so `5` matches `"5"`). See
//! rust/docs/store/jobs.md ("Facts extraction reads").

use super::*;
use crate::persistence::all_effects;

/// `data->>'page_id' = page_id`.
fn names_page(data: &Value, page_id: &str) -> bool {
    data.get("page_id").and_then(jsonb_field_text).as_deref() == Some(page_id)
}

impl Store {
    /// `hasPendingFactsExtraction(pageId, jobStates)`: a `facts-backstop` effect of the page in
    /// `queued` or `running`, or a `facts-absorb` job of the page whose status is one of `job_states`.
    pub fn has_pending_facts_extraction(
        &self,
        page_id: &str,
        job_states: &[String],
    ) -> Result<bool> {
        let read = self.read()?;
        let effect = all_effects(&*read)?.into_iter().any(|e| {
            e.kind == "facts-backstop"
                && (e.state == "queued" || e.state == "running")
                && names_page(&e.data, page_id)
        });
        if effect {
            return Ok(true);
        }
        let states: BTreeSet<&str> = job_states.iter().map(String::as_str).collect();
        for status in states {
            if rows_with_status(&*read, status)?
                .iter()
                .any(|j| j.name == "facts-absorb" && names_page(&j.data, page_id))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `hasCompletedFactsExtraction(pageId)`: a `completed` `facts-absorb` job of the page whose
    /// `result->>'skipped'` is NULL (no result, no `skipped` key, or a JSON null there).
    pub fn has_completed_facts_extraction(&self, page_id: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(rows_with_status(&*read, "completed")?.iter().any(|j| {
            j.name == "facts-absorb"
                && names_page(&j.data, page_id)
                && j.result
                    .as_ref()
                    .and_then(|r| r.get("skipped"))
                    .and_then(jsonb_field_text)
                    .is_none()
        }))
    }
}
