**A fact saved without an event date no longer shows up in `recall --since` as a recent event.**

<!-- behavior-change: facts_unknown_event_date_10288 -->

### Fixed
- `gbrain remember` without `--valid-from`, `extract_facts` without a date, and a `## Facts` row with an empty date cell (and no page date) now store the event date as unknown instead of the time the fact was saved. Recall returns such a fact with `valid_from: null`, and its save time stays in `created_at`.
- An event-time window (`recall --since`, the `since` parameter of the recall tool and search's fact pool) only matches facts with a known event date. General recall and entity recall still return undated facts, ordered by when they were saved.
- `recall --today` and `--since-last-run` still show undated facts saved in their window, locally and on a thin client. The recall tool's new optional `include_undated` parameter widens a `since` window the same way; an older server ignores it with a warning.
- Trajectories and same-metric supersession treat an undated claim as dated at its save time.
- A fact with a stated date, a page date, or a conversation timestamp keeps that date, as before.
- Schema migration v338 lets `facts.valid_from` be empty. Nothing is rewritten on upgrade: facts saved before it keep the save time they were stamped with.

### Known limits
- A Rust-engine brain still stamps the save time on an undated fact until its store format can hold an empty event date.

Reported by @Kkkkkuro; #10297 by @Kkkkkuro was a first fix.
