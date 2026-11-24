---
important: security
---
**The secret scanner now hides the whole password in a database or https URL when the password contains a raw @.**

<!-- behavior-change: secret_scan_url_raw_at_gst3639 -->

### Fixed
- A password containing a raw, unencoded `@` inside a database URL (postgres, mysql, mongodb, redis, amqp, mssql) or an https URL in page text is now redacted whole. The scanner ended the password at its first `@`, while URL parsers and database drivers split at the last one before the host, so the rest of the password stayed visible after the redaction marker in the text gbrain redacts with it, such as search output and rendered transcripts. An `@` in the path or query still does not count as part of the password.
- A finding for such a URL now covers the whole password, so its fingerprint changes. An entry in `.gbrain-scan-allow` pinned to the old fingerprint no longer matches; add the new fingerprint the scanner reports.
