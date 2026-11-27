---
important: security
---
**A credential that loses admin scope or owner binding stops getting wake-ups about other people's jobs, a revoked refresh token can no longer be replayed, and the opt-in secret screen closes five gaps.**

### Fixed
- Job wake-ups check at delivery that the watch still belongs to the brain owner and that its credential still holds admin scope. A watch whose credential was rescoped below admin, or whose member is no longer the owner, ends with `job_not_visible` instead of reporting another submitter's job. (GST-4023)
- Revoking a refresh token that was already rotated also ends its 60-second grace replay. A replay then gets `invalid_grant` and signs that client out instead of handing back a fresh token pair.
- `secrets.on_write` screens remote page text with NUL bytes removed, the way it is stored. A token split by NUL bytes is refused under `block` and redacted under `redact`.
- `household_mark` and the rewrites behind `household_add --about_role` screen only what the caller sent: the note, the request id, and a new record before any subject changes. Token-shaped text already stored on the page is no longer refused or rewritten.
- Opt-in Gmail redaction now covers mixed-case and lowercase codes after an explicit label such as "verification code". A short code match no longer leaves the rest of a labelled password in the stored body.
- `put_pages` refusals never repeat a slug that holds a secret. The entry index names the page instead.
