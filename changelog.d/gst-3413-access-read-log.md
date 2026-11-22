**A brain shared with members now keeps a log of who read what, and `gbrain access log` and `gbrain access who-read` show it.**

### Added
- Reads made by a member or a group audience are logged in a new `access_read_log` table (migration v331): when, which member or audience, the operation, the transport, the result code and the ids of the pages the read surfaced. Page text and query terms are never stored.
- `gbrain access log [--member <id>] [--since 7d]` lists those reads, and `gbrain access who-read <slug>` lists the members and audiences whose reads returned a page.
- Owner reads, and every read on a brain with no members, write nothing and cost nothing extra. The log is written after the response, in batches, and a failed write never fails the read. Rows are kept for a year, at most a million.
- Page ids come from search, query, recall, `get_page` and `fetch`; other reads are logged without page ids. Search and recall note their ids before the response is trimmed, so a row can name a page the reader did not receive. A call refused before it reaches the operation, and a read at an attested source scope, write no row.
