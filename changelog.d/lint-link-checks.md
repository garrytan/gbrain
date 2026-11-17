**`gbrain lint` now finds dead and ambiguous links between your pages, and can print JSON and fail a CI run; an uploaded file is never overwritten by a different file with the same name.**

### Added
- `gbrain lint <dir>` reports `dead-link` (a link to a page that does not exist) and `ambiguous-link` (a bare `[[name]]` that matches more than one page, which the graph leaves unlinked), each with its file and line. A link counts as live when any resolution the link extractor tries finds a page, so a link the graph links is never reported. Links in code, attachments, web addresses, frontmatter fields and `[[source:slug]]` links into another source are out of scope, and pages skipped with `--exclude` still count as targets. `--no-links` turns the checks off; the scheduled cycle's lint phase does not run them.
- `gbrain lint --json` prints the whole report as one JSON document on stdout (progress stays on stderr), with every issue's rule, line and message and the run's counts.
- `gbrain lint --strict` exits 1 when any issue is left after the run, for CI.
- An attached file is never overwritten. When `gbrain files upload`, `gbrain files upload-raw` or the `file_upload` tool gets a different file under a name a page already uses, the first file keeps its bytes and its record, and the new one is stored beside it with the start of its content hash in front of the name (`notes/x/1a2b3c4d5e6f-contract.pdf`); `file_upload` says so in `kept_original`. The same bytes again are still a no-op, and a record whose bytes are gone from storage is still repaired in place.

### Changed
- For contributors: the product's names (command, MCP server name, home folder, environment-variable prefix) now live in one module, `src/core/brand.ts`. The home folder and the MCP server name already read from it; nothing a user sees changes. A future rename keeps reading an existing install's `GBRAIN_*` variables.

<!-- behavior-change: lint_link_checks_json_strict -->
<!-- behavior-change: file_originals_kept_beside -->
