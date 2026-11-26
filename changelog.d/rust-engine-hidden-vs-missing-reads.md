**Tests now pin that a remote read never shows another page in place of a page the caller may not see.**

### Fixed
- Privacy tests: on PGLite, Postgres and the Rust engine, a remote read of a name that holds a page the caller may not see, where that name also points to another page from an earlier rename, answers "not found" and never opens the other page. The release behavior does not change. Known limit: a remote caller that already knows the name was renamed can tell that a page it may not see now holds the name; it learns nothing of that page's content.
