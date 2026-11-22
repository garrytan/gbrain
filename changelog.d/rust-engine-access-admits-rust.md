**On the Rust engine, `gbrain access who-can-read` names the same members as PGLite and Postgres.**

### Fixed
- On a brain with the Rust engine, `gbrain access who-can-read` (and the reports that use it) now works out, for each member, whether that member's access rules let them read a page: the page's `readable_by` list and groups, the folder rules the member meets, folders still being restamped, and pages that only the owner reads (an iMessage source). Before, it stopped with a typed refusal as soon as a page had readers, a folder rule or an owner-only source.
- The Rust engine still refuses this check for a caller whose access record it cannot match exactly, rather than guess: a call made outside a caller record, or one whose record uses the short access check of a brain with no member restrictions. `gbrain access who-can-read` itself always runs inside a restricted record, so it is not affected.
- One part of the same test case still stops on the Rust engine: removing a source with `gbrain sources remove`, which reads the source's owned-folder state with raw SQL. It is unrelated to who-can-read.
