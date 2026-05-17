# HTTP Write Caller Guide

Rules for any agent or web driver calling gbrain's HTTP write endpoints.
Optimized for callers with short socket timeouts (Genspark, ChatGPT browsing, Claude crawler).

## Endpoint reference (write paths)

| Method | Path | Use when |
|--------|------|----------|
| `PUT /page` | JSON body, no URL limit | Default write path for all content |
| `PUT /page?async=1` | Returns 202 immediately | Content > 2000 chars, or caller timeout < 30s |
| `GET /job?id=<job_id>` | Poll async job status | After submitting with async=1 |
| `GET /page?slug=<slug>` | Read back + verify | Confirm write landed, check content_hash |

---

## Timeout settings

```
PUT /page (sync)    → set timeout ≥ 30s
PUT /page?async=1   → 10s is fine (returns 202 instantly)
GET /job?id=...     → 5s is fine
GET /page?slug=...  → 5s is fine
All other endpoints → 10s is fine
```

---

## Preferred write flow (content > 2000 chars)

```
1. PUT /page?async=1
   body: { slug, content, idempotency_key: "<slug>-<sha8>" }
   → 202 { job_id, slug, content_hash, status: "pending" }

2. sleep 3s

3. GET /job?id=<job_id>
   → { status: "pending"|"running"|"completed"|"failed", ... }
   if pending/running: sleep 2s, retry (max 10 polls = ~25s total)
   if completed: done ✓
   if failed: log error, retry the PUT once

4. Verify (optional but recommended):
   GET /page?slug=<slug>
   check response.page.content_hash === the hash from step 1
```

---

## Preferred write flow (content ≤ 2000 chars)

```
1. PUT /page  (sync, timeout 30s)
   body: { slug, content, idempotency_key: "<slug>-<sha8>" }
   → 200 { ok: true, slug, content_hash, status: "imported"|"skipped" }

2. On timeout (not an explicit error):
   GET /page?slug=<slug>
   → 200 { page: { content_hash } } → compare hash → done if match
   → 500 → page never wrote, safe to retry PUT
```

---

## Idempotency key

Always include `idempotency_key` on PUT /page. Within a 5-minute window, the
server returns the cached first response for the same key, so retry-on-timeout
is safe even without the async flow.

```json
{ "slug": "wiki/foo", "content": "...", "idempotency_key": "wiki-foo-a3f2c8" }
```

Good key format: `<slug-hash8>` where hash8 is the first 8 hex chars of SHA-256
of the content. This makes the key unique per (slug, content) pair and changes
on edits, so a corrected re-write is never suppressed.

---

## content_hash

Every PUT /page response now includes `content_hash` (SHA-256 hex of the full
markdown including frontmatter). Use it as a write fingerprint:

- Store it alongside the job_id on async submits
- Compare it in `GET /page` responses to confirm the right version landed
- If hashes match → your write is live
- If hashes differ → a concurrent write overwrote yours (or you read a stale version)

---

## Page size limits

| Size | Risk | Recommendation |
|------|------|----------------|
| ≤ 2000 chars | Safe sync | PUT /page (sync) |
| 2000–4000 chars | Timeout risk | PUT /page?async=1 |
| > 4000 chars | Always timeout | Split into sub-pages + index page |

For structured content with multiple sections (phases, steps, chapters):
- Write each section as a separate slug (leaf pages first)
- Verify each leaf before writing the index page
- Index page links to leaf slugs

---

## Leaf-first write order

```
WRONG:  write index → write leaves (leaves fail → index has dead links)
RIGHT:  write leaves → verify all → write index
```

---

## Batch writes: sleep between requests

Add 300–500ms sleep between consecutive PUT /page calls. The server has an
embedding queue and back-to-back writes increase per-request latency.

```python
for page in pages:
    put_page(page)
    time.sleep(0.5)  # give the embed queue breathing room
```

---

## timeout ≠ failure

A socket timeout on PUT /page (sync) means the write status is **unknown**,
not failed. Always verify before deciding to retry:

```
PUT timeout
  → wait 5s
  → GET /page?slug=X
    → 200 + content_hash matches → write succeeded, continue
    → 200 + content_hash differs → a different version is live; decide whether to overwrite
    → 404 / 500              → write never landed, safe to retry
```

Never retry blindly after a timeout. `add_link` and `add_timeline_entry` are
not idempotent — duplicate calls create duplicate entries.

---

## Error codes quick reference

| code | meaning | action |
|------|---------|--------|
| `not_found` | page/job doesn't exist | 404 — create or wait |
| `too_large` | content > 50k chars | split into smaller pages |
| `missing_param` | required field absent | fix the request |
| `invalid_json` | malformed body | check encoding |
| `otp_required` | auth missing | include `otp` param |
| `warming_up` | server cold-starting | retry in 10s |
| `internal_error` | server error | retry once; escalate if repeated |
