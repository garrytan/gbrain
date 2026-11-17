//! Timeline reads by date and event projections. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: getTimelineForDate, getSince, getOnThisDay, getLastSeen, upsertEventProjection.
//!
//! Keys: every record of this family starts with `keys::TIMELINE_QUERIES` (`u`). The bytes after
//! the tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

use crate::Result;
use crate::kv::KvWrite;

/// `ON DELETE CASCADE` of `timeline_entries.event_page_id`: deletes every timeline entry, on any
/// page, whose `event_page_id` is the page being hard deleted. `pages::remove_page` calls it.
/// Empty until this family stores event projections.
pub(crate) fn remove_event_projections(_tx: &mut dyn KvWrite, _event_page_id: u64) -> Result<()> {
    Ok(())
}
