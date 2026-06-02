---
title: "Error 401 Troubleshooting"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1b2dd8-b924-83e8-8b1f-4c40f950f4e6
message_count: 2
tags: [chatgpt, import, code]
---
# Error 401 Troubleshooting

> Conversation ID: 6a1b2dd8-b924-83e8-8b1f-4c40f950f4e6
> Created: 2026-05-30T18:35:06Z
> Updated: 2026-05-30T18:35:15Z
> Messages: 2

---

## User

 Hermes  (background #2) ────────────────────────────────────────────────────────────────────────

     Error: Error code: 401 - {'error': {'message': 'User not found.', 'code': 401}}

---

## Assistant

That error is almost always coming from the OpenRouter side, not Hermes itself.

`401 - User not found` usually means one of these:

1. **Bad API key**
   - API key copied incorrectly
   - Extra space/newline in `.env`
   - Old/revoked key

2. **Wrong provider endpoint**
   - Hermes is pointing at OpenRouter but using a key from another provider
   - Example: OpenAI key sent to OpenRouter endpoint

3. **OpenRouter account issue**
   - Key belongs to an account that was deleted
   - Organization/user mismatch
   - Newly created account not fully provisioned yet

4. **Incorrect base URL**
   - Should typically be:
   ```
   https://openrouter.ai/api/v1
   ```
   not:
   ```
   https://openrouter.ai
   ```
   and not:
   ```
   https://api.openai.com/v1
   ```

5. **Himalaya / Gmail unrelated**
   - If this error appears while Hermes is starting, it is probably failing during LLM initialization before Gmail is even involved.

Quick test:

```bash
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

If OpenRouter returns model data, the key is valid.

If it returns:

```json
{
  "error": {
    "message": "User not found"
  }
}
```

the key/account is the problem.

Check:

```bash
echo $OPENROUTER_API_KEY
```

and verify the key matches the one shown in:

urlOpenRouter Keys Pagehttps://openrouter.ai/settings/keys

Also tell me:

- Are you running Hermes locally?
- Hermes version?
- Using OpenRouter, OpenAI, Anthropic, or Kimi as the primary provider?
- The exact provider section from your config (redact keys).

That will narrow it down quickly.
