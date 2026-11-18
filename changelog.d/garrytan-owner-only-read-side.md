**Rows made from owner-only (iMessage) data stay hidden from other callers in the less common setups too.**

**Who must act:** nobody, unless a non-owner Postgres login on a brain that holds owner-only data should keep reading derived rows: give it complete reads of the lineage tables (see docs/ENGINES.md, "Privileges on `owner_only_marks`"). Until then it reads them as owner-only.

### Fixed
- A take or timeline row whose own recorded inputs reach owner-only data is hidden from other callers on every read (`takes_list`, `takes_search`, `takes_scorecard`, `takes_calibration`, `get_timeline`, write attribution), not only when its page is owner-only. Rows written before this change are covered, and they stay hidden after their origin is deleted.
- A meeting in an owner-only source no longer adds timeline rows to attendee pages in other sources when `link_resolution.cross_source` is on.
- A read that cannot learn the brain's schema version treats every row as owner-only once the brain has held owner-only data, also after its last owner-only source is removed.
- A non-owner database login whose reads row-level security narrows no longer reads a row derived from owner-only data as open because it cannot see the origin: it reads every derived row, synthesized concept and question as owner-only (migration v323).
- A policy on `owner_only_marks` counts only in the shape doctor prints (`USING (true)`, `WITH CHECK (true)`, no restrictive policy); any other policy is treated like none, so doctor names the login and its reads stay closed.
