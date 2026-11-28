---
kind: add
---
New opt-in setting secrets.on_write (off, redact or block; default off) on the host config. When on, page text written by remote MCP callers (put_page, put_pages, edit_page, append_page, capture, add_timeline_entry, takes writes, remember and chunked uploads, checked on the assembled body) is screened with the push guard's secret detector. block refuses with secret_in_write and writes nothing; redact saves the page with <REDACTED:pattern> in place of each value (a chunked upload holding a secret is refused). Refusals and receipts name only the kind of secret, never the value. Local CLI writes, sync and imports are not screened.
