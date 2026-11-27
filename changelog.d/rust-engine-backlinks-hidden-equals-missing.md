**Backlinks answer the same for a page you cannot read and a page that does not exist.**

### Fixed
- `get_backlinks` now looks for the target page only among the pages the caller may read. For a remote caller, a page it cannot read gets the same answer as a page that does not exist, with or without a `type` filter. A page the caller cannot read also no longer hides a readable page with the same name in another source the caller may read. Trusted local callers get the same answers as before.
