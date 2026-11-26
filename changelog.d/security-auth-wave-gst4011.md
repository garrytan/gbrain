**Four opt-in and hardening changes for sign-in and secrets: a short OAuth refresh grace window with stolen-token revocation, opt-in redaction of sign-in codes in synced Gmail, an opt-in secret screen on remote page writes, and pinned-question reads for the brain owner's own MCP credential.**

<!-- behavior-change: oauth_refresh_reuse_grace_9364 -->
<!-- behavior-change: gmail_redact_credentials_9389 -->
<!-- behavior-change: secrets_on_write_10148 -->
<!-- behavior-change: questions_owner_remote_10380 -->

### Changed
- OAuth refresh (`gbrain serve --http`): for 60 seconds after a refresh token is rotated, the same client sending that token again gets the pair that already replaced it, so two tabs, parallel clients or a retry after a lost answer keep their sign-in. Any other reuse of an old refresh token (after 60 seconds, from another client, or a token older than the one just replaced) now revokes every token of that sign-in, as a stolen token would. Other sign-ins of the same client are untouched. Schema migration v338 adds the sign-in family column and the rotation table.
- The brain owner's own MCP credential (`access.owner_member`) can now call `questions_list` and `questions_status` on brains where private pages are hidden from MCP. It sees only pins whose question page it can read under its source grant and reader rules, and answer sentences from stale or unreadable evidence are left out; a credential that reads only some take holders gets every answer sentence withheld. Pinning, refreshing and unpinning stay on the brain host; every other remote caller is still refused.

### Added
- `gbrain config set google.gmail.redact_credentials true` replaces labelled one-time codes, magic sign-in and password-reset links, credential-shaped strings and labelled temporary passwords in synced Gmail bodies with placeholders such as `[redacted:otp]` before they reach pages, chunks, search or versions. Off by default.
- `gbrain config set secrets.on_write block` (or `redact`) screens page text written by remote MCP callers, chunked uploads and `remember` included, with the same detector the push guard uses. `block` refuses with `secret_in_write` and writes nothing; `redact` saves the page with `<REDACTED:pattern>` in place of each value. Refusals and receipts name only the kind of secret, never its value. Off by default; local CLI writes, sync and imports are not screened.

### Known limits
- The refresh grace window does not help a client that waits longer than 60 seconds before retrying a refresh whose answer it never received; that client still has to reconnect.
- Gmail redaction does not touch message subjects (a code in the subject stays in the page title), pages synced before it was turned on until their thread syncs again, or older page versions.
- Under `secrets.on_write redact`, a chunked upload that holds a secret is refused rather than rewritten, because its body is bound to the hash declared when the upload began.
