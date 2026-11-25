//! The meetings connector's page lookup: the statement of `readMeetingPage` in
//! `src/core/engine-sql/meeting-pages.ts`.
//!
//! `readMeetingPage(sourceId, meetingId)`: the live page of the source whose frontmatter `meeting_id`
//! text is `meetingId`, the lowest id first, as `{ slug, source_path }`; null when none. Like the
//! statement, it applies no read policy: the connector reads its own source.
//!
//! `listAttendanceMatches(sourceId, slugs, name)`: the statement of `src/core/engine-sql/attendance-pages.ts`, the
//! attendance lookup of frontmatter link extraction. At most two slugs of live `person` pages of the source whose slug
//! is one of `slugs`, whose title is `name` under Postgres `lower()`, or whose frontmatter `aliases` array holds a
//! string equal to `name` under `lower()` (`pg_lower`, PGLite's table). The SQL has no order; this returns the lowest
//! two page ids, and the caller only asks whether exactly one page matched.

use serde_json::{Value, json};

use crate::Store;
use crate::cli_reads::pg_text::{fm_text, pg_lower};
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::all_pages;

impl Store {
    pub fn read_meeting_page(&self, source_id: &str, meeting_id: &str) -> Result<Value> {
        no_nul(
            "readMeetingPage",
            &[("sourceId", source_id), ("meetingId", meeting_id)],
        )?;
        let read = self.read()?;
        let found = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && fm_text(&p.frontmatter, "meeting_id").as_deref() == Some(meeting_id)
            })
            .min_by_key(|p| p.id);
        Ok(found.map_or(
            Value::Null,
            |p| json!({ "slug": p.slug, "source_path": p.source_path }),
        ))
    }

    pub fn list_attendance_matches(
        &self,
        source_id: &str,
        slugs: &[String],
        name: &str,
    ) -> Result<Vec<String>> {
        let op = "listAttendanceMatches";
        no_nul(op, &[("sourceId", source_id), ("name", name)])?;
        for slug in slugs {
            no_nul(op, &[("slugs", slug)])?;
        }
        let wanted = pg_lower(name);
        let read = self.read()?;
        let mut found: Vec<_> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && p.page_type == "person"
                    && (slugs.contains(&p.slug)
                        || pg_lower(&p.title) == wanted
                        || p.frontmatter.get("aliases").is_some_and(|aliases| {
                            aliases.as_array().is_some_and(|list| {
                                list.iter()
                                    .any(|a| alias_text(a).is_some_and(|t| pg_lower(&t) == wanted))
                            })
                        }))
            })
            .collect();
        found.sort_by_key(|p| p.id);
        Ok(found.into_iter().take(2).map(|p| p.slug).collect())
    }
}

/// `jsonb_array_elements_text`: a string element as itself, JSON null as SQL NULL (it matches nothing), any other
/// element as its jsonb text.
fn alias_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(crate::cli_reads::pg_text::jsonb_text(other)),
    }
}
