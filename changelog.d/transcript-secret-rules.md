---
important: security
---
**Imported conversations no longer keep cookie values, `.netrc` passwords or a password sent as its own message after a `password:` line.** `gbrain transcripts ingest` copied these into the searchable page verbatim, because no detector knew a cookie value or a label in one message whose value came in the next. The transcript importer now redacts them. On pages imported earlier, `gbrain transcripts audit-secrets` finds the cookie values and `.netrc` passwords (doctor asks for a fresh audit), but not a password sent as its own message: a stored page no longer marks where one message ends. The `sources push` gate and the compiled-context scan are unchanged.

<!-- behavior-change: transcript_secret_rules_gst2768 -->

### Itemized changes

- `src/core/secret-scan-cookie.ts` (new): the `cookie_header` rule. Values after `Cookie:` / `Set-Cookie:` headers and after curl's `-b`/`--cookie` are redacted; cookie names, `Set-Cookie` attributes, prose, placeholders and values under 8 characters stay.
- `src/core/secret-scan-labeled.ts`: transcript-only `.netrc` `password` form, and a key or token label ending its line (`here is my API key:`) whose one-token value (12+ characters, a letter and a digit, not a file name or version) is alone on the next line.
- `src/core/secret-scan.ts`: new `ScanOpts.transcriptRules` and `ScanOpts.leadingDangling`, both off by default; `TRANSCRIPT_LANE_SCAN_OPTS` and `trailingDanglingLabel` for the transcript lane.
- `src/core/transcripts/render.ts`: `redactSession` uses the transcript-lane options and carries a label left dangling at the end of a message into the first non-blank line of the next message only.
- `src/core/transcripts/secret-audit.ts`: `audit-secrets` uses the same options; `TRANSCRIPT_SECRET_AUDIT_VERSION` 5 → 6, so `transcript_secret_exposure` asks for a fresh audit. `src/core/transcripts.ts` (the recent-transcripts read) uses the same options.
- Tests: `test/transcripts-secret-cookie-header.test.ts`, `test/transcripts-secret-cross-message.test.ts`, `test/transcripts-secret-corpus.test.ts` and `test/secret-scan-push-gate-unchanged.test.ts` (a golden proving the shared scanner's other option sets are byte-identical), over the synthetic corpus `test/fixtures/transcripts/synthetic-credentials.ts`.
- Docs: `docs/guides/data-ingestion.md#credential-redaction` and the key-files entries.
