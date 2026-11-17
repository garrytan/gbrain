**`gbrain lint` now finds dead and ambiguous links between your pages, and can print JSON and fail a CI run.**

### Added
- `gbrain lint <dir>` reports `dead-link` (a link to a page that does not exist) and `ambiguous-link` (a bare `[[name]]` that matches more than one page, which the graph leaves unlinked), each with its file and line. A link counts as live when any resolution the link extractor tries finds a page, so a link the graph links is never reported. Links in code, attachments, web addresses, frontmatter fields and `[[source:slug]]` links into another source are out of scope, and pages skipped with `--exclude` still count as targets. `--no-links` turns the checks off; the scheduled cycle's lint phase does not run them.
- `gbrain lint --json` prints the whole report as one JSON document on stdout (progress stays on stderr), with every issue's rule, line and message and the run's counts.
- `gbrain lint --strict` exits 1 when any issue is left after the run, for CI.

<!-- behavior-change: lint_link_checks_json_strict -->
