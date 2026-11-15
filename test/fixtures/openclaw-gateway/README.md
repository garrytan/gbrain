# OpenClaw Gateway fixtures

Recorded on 2026-11-15 from OpenClaw 2026.11.3 running `openclaw gateway --dev --auth token` on loopback with no
model credentials and no channels, through `openclaw gateway call <method> --json --params <json>` (the documented
CLI for Gateway RPCs). Paths were rewritten to `/home/alice-example`; session ids are the random ids the dev Gateway
minted. Rows and messages are trimmed to the fields the archive reader reads.

| File | Call |
| --- | --- |
| sessions-list-page1.json, sessions-list-page2.json | `sessions.list {limit:2}`, then `{limit:2, offset:2}` |
| chat-history-scratch-alpha-page1/2.json | `chat.history {sessionKey, limit:2}`, then `offset:2` (pages walk backward; each page is oldest first) |
| chat-history-archived.json | `chat.history` on a session archived with `sessions.patch {archived:true}` |
| chat-history-scratch-3.json | `chat.history` after `sessions.reset` (reset in place: earlier messages are gone from the page) |
| chat-history-group-shaped-key.json | a session created with a group-shaped key: `kind` says group, `chatType` stays `direct` |
| error-auth.json, error-unreachable.json, error-credentials-required.json | wrong token, closed port, no credential |

Doc-shaped (not recorded, marked `_note`): sessions-list-group-docshape.json, chat-history-group-docshape.json and
chat-history-legacy-row.json. A channel-created group row needs a real messaging account, which the recording run never
connected.

2026.10.9 shape (synthetic, built from a 2026-11-15 probe of a 2026.10.9 dev Gateway): sessions-list-1009.json,
chat-history-1009-main.json and chat-history-1009-probe-a.json. On 10.9 a session an operator created with
sessions.create has no chatType (classification custom), and history rows carry __openclaw.transcriptPosition.
