---
important: security
---
**Imported conversations no longer keep three kinds of secret that the last cookie and `.netrc` fix still let through.** `gbrain transcripts ingest` now also redacts a `.netrc` password when the entry is written over several lines (`machine`, `login` and `password` each on its own line), a curl cookie passed with `-b` on its own line of a command split with trailing backslashes (what Chrome's "Copy as cURL" produces), and a quoted cookie value inside escaped JSON (`sid=\"…\"`). Before this change all three were copied into the searchable page as plain text. Cookie names, curl's other arguments and ordinary prose near these shapes stay as they were.

What to do: conversations imported earlier keep what they stored. `gbrain doctor` asks for a fresh audit; run `gbrain transcripts audit-secrets --json` to list affected pages (slugs and hit counts, never values). The `sources push` gate and the compiled-context scan are unchanged.

### Itemized changes

- `src/core/secret-scan-labeled.ts`: a `password` line inside a multi-line `.netrc` stanza (opened by a `machine` or `default` line, kept open by `login`, `account` and `password` lines) is redacted. The line must be only `password <value>`, so prose such as "machine learning" followed by "password managers are useful" stays.
- `src/core/secret-scan-cookie.ts`: a `-b` on a line that continues a curl command (each earlier line ends in `\`) counts as curl's cookie argument; a cookie value quoted with escaped quotes (`\"`, or `\\\"` one level deeper) is read. A `-b` after a continued line that is not curl (`git checkout -b`) stays.
- `src/core/secret-scan.ts`: the transcript-lane scan carries the `.netrc` stanza and the curl continuation from line to line.
- `src/core/transcripts/secret-audit.ts`: `TRANSCRIPT_SECRET_AUDIT_VERSION` 6 → 7, because the audit now finds these shapes on stored pages.
- Tests: `test/transcripts-secret-cookie-header.test.ts`, `test/transcripts-secret-corpus.test.ts`.
- Docs: `docs/guides/data-ingestion.md#credential-redaction` and the key-files entries.
