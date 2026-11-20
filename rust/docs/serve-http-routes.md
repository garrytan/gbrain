# serve-http on a Rust brain: the route table

The rules in [rust/README.md](../README.md) ("The brain store") apply. The calls that differ are listed by owner in
[serve-http-route-gaps.md](serve-http-route-gaps.md).

## How the table is made

One read-only probe builds the real `buildServeHttpApp` once on PGLite and once on Rust (`openRustBrain`), with no paid
keys, and calls every route once on each. The seed is the same on both arms: three notes, `people/alice-example`, a
legacy token (read, write, admin) and two OAuth clients registered with `registerScopedClient`. A recording proxy on the
engine logs each `executeRaw`, `executeRawDirect` and `withReservedConnection` call with its caller frame, and each
typed `engine_capability_missing` refusal.

- Bodies are compared after a shape pass: times, UUIDs, tokens, ports and temporary paths become placeholders.
- Raw sites are traced on PGLite, because Rust stops at the first refusal.
- Each MCP tool is called with arguments sampled from its input schema, so "equal" for a tool that fails on both arms
  means an equal error, not an equal success.
- The probe changes nothing in the repository. It is not a test, and CI does not run it.

## Result at 8e72de1bb6 (218 calls per arm)

| Class | Calls | Meaning |
| --- | --- | --- |
| equal | 154 | same status and same shaped body, no refusal |
| differ | 36 | the bodies differ and no refusal was recorded |
| refused | 23 | Rust refused by name at a raw site or an unserved member |
| 5xx | 4 | Rust answered 500 or 503 where PGLite answered below 500 |
| equal\* | 1 | same body, but a refusal was caught and swallowed on the way |

The run before (1bc04e66a8) had 138 equal, 42 differ, 25 refused, 12 5xx and 1 equal\*. The /ingest, register-client,
grants, recover-client, api-keys, member-links and jobs/watch rows are equal now.

## Routes not called

- POST /admin/api/sign-out-everywhere and POST /admin/api/revoke-client: they would end the probe's own session.
- Confidential-client /token (authorization_code, refresh_token) and confidential /revoke.
- POST /register with dynamic client registration on, and POST /admin/api/oauth-requests/:id deny.
- POST /webhooks/github with a valid signature, and the static assets under /admin.
