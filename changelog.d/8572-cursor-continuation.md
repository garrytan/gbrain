**Multi-selector page reads resume a stale cursor instead of restarting at an unrelated fallback range.**

### Fixed
- Keep a same-page, same-view cursor's saved byte position and window budget after an edit when lower-priority selectors accompany it. Clamp to the new end after a shrink, and issue continuation cursors for the current revision. A cursor alone still reports `revision_changed`; foreign-page and wrong-view cursors still fall back as before.
- Print the selector note on stderr for partial `gbrain get` output, including the warning that a window beside `include_content` is not whole-page content. Stdout remains the window only.
- Addresses items 2–3 of #8572; whole-page write policy and the other follow-ups are unchanged.

<!-- behavior-change: get_page_cursor_resume_8572 -->
