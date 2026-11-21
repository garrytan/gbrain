**On a Rust brain, one large page with a withdrawn claim no longer blanks the leads of the other pages shown with it.**

### Fixed
- On a Rust brain, the lead of a large (segmented) page that has a withdrawal on record is shown blank, because the Rust engine cannot yet strike a single claim out of a lead. This blank lead is visible: snippets, synopses, entity-card summaries and think anchors for that page show empty text. Before this fix, the same failure also blanked the lead of every other page read in the same call, inline pages included. Now only the affected page's lead is blank, and the other pages keep their leads. PGLite and Postgres brains do not change.
