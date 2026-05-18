# Meeting & Call Webhooks

### 14b. Circleback -- Meeting Ingestion via Webhooks

[Circleback](https://circleback.ai) records meetings, generates transcripts with
speaker diarization, and fires webhooks on completion.

**Webhook setup:**

1. In Circleback dashboard -> Automations -> add webhook
2. URL: `{your_agent_gateway}/hooks/circleback-meetings`
3. Circleback provides a signing secret for HMAC-SHA256 signature verification
4. Store the signing secret in your webhook transform for verification

**Webhook payload:** Meeting JSON with id, name, attendees, notes, action items, full
transcript, calendar event context.

**Signature verification:** Header `X-Circleback-Signature` contains `sha256=<hex>`.
Verify with `HMAC-SHA256(body, signing_secret)`. Reject unverified webhooks.

**OAuth for API access:** Circleback uses dynamic client registration (OAuth 2.0).
Access tokens expire in ~24h, auto-refresh via refresh token. Store credentials in
agent memory.

**Flow:** Webhook fires -> transform validates signature + normalizes -> agent wakes ->
pulls full transcript via API -> creates brain meeting page -> propagates to entity
pages -> commits to brain repo -> `gbrain sync`.

### 14c. Quo (OpenPhone) -- SMS and Call Integration

[Quo](https://openphone.com) (formerly OpenPhone) provides business phone numbers with
SMS, calls, voicemail, and AI transcripts.

**Webhook setup:**

1. In Quo dashboard -> Integrations -> Webhooks
2. Register webhooks for: `message.received`, `call.completed`, `call.summary.completed`, `call.transcript.completed`
3. Point all to: `{your_agent_gateway}/hooks/quo-events`
4. Store registered webhook IDs in agent memory

**How inbound texts work:**

- Webhook fires with sender phone, message text, conversation context
- Agent looks up sender in brain by phone number
- Surfaces to user's messaging platform with sender identity + brain context
- Drafts reply for approval (never auto-replies without explicit permission)

**How inbound calls work:**

- `call.completed` fires -> if duration > 30s, fetch transcript + AI summary via API
- Ingest to brain (meeting-style page at `meetings/`)
- Update relevant people and company pages

**API auth:** Bare API key in `Authorization` header (no Bearer prefix).

**Key endpoints:** `POST /v1/messages` (send SMS), `GET /v1/messages` (list),
`GET /v1/call-transcripts/{id}`, `GET /v1/conversations`.

---

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md). See also: [Getting Data In](README.md)*
