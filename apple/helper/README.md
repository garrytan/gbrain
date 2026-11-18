# GBrain Helper (macOS)

A small macOS program that reads the Messages database on your own Mac and answers gbrain over `127.0.0.1`. It never writes to the database and never shows a macOS dialog while it answers a request. When the owner turns sending on, it also sends one-to-one iMessages for the owner's own agent over Tailscale (see [Sending](#sending)); it never sends on its own.

This folder is Swift source only. On Linux and Windows nothing in gbrain's install, upgrade, doctor or test suite builds or loads it. A later `gbrain apple-setup` builds it on your Mac; until then, `.github/workflows/apple-helper.yml` builds and tests it on a macOS runner.

## Build and test on a Mac

```bash
cd apple/helper
swift build
swift test
```

The helper runs on macOS 13 or newer. Building it needs the Xcode Command Line Tools (`xcode-select --install`), and `swift test` needs Swift 6 (Xcode 16 or its Command Line Tools, macOS 14.5 or newer) because the tests use Swift Testing.

## Layout

- `Sources/HelperCore/`: the Messages reader, the HTTP server, tokens, config, source modules and the send door (`Send*.swift`, `MessagesApp.swift`, `DeliveryLedger.swift`).
- `Sources/gbrain-apple-helper/`: the command-line program.
- `Bundle/`: `Info.plist`, the background agent's property list and the entitlements for `GBrain Helper.app`.
- `scripts/signing-probe.sh`: CI probe that asks whether a self-signed certificate made on the machine signs the app with no dialog, or first needs a one-time Always Trust step. Its answer goes to the job summary.
- `Tests/HelperCoreTests/`: tests against a synthetic Messages database.

## Routes

| Route | Token scope | Returns |
| --- | --- | --- |
| `GET /health` | none | `ok` and `version`, nothing else |
| `GET /v1/sources` | any token | each source: on or off, the permission it needs, its state, scope and routes; no messages |
| `GET /v1/imessage/threads` | `read:imessage` | recent threads; `limit` (1 to 200, default 30), `include_last_message` (default true) |
| `GET /v1/imessage/thread` | `read:imessage` | one thread's messages; one of `thread_id`, `chat_rowid` or `chat_guid`, plus `limit` (1 to 500, default 50), `since_rowid`, `since_iso`, `include_reactions` (default false) |
| `POST /v1/imessage/send` | a send key (`GBrain-Sign`), never a token | sends one iMessage; tailnet listener only, see [Sending](#sending) |
| `POST /v1/admin/send` | none; this Mac only | the `send-setup`, `send-key` and `send-limits` commands use it; widening asks for Touch ID |

Without a cursor a thread page holds the newest messages, oldest first. With `since_rowid` it holds the messages after that row, in row order; `meta.next_since_rowid` is the cursor for the next page.

## Safety

- Listens on `127.0.0.1` only. It refuses a peer that isn't loopback, a `Host` header other than `127.0.0.1:<port>` and any request with an `Origin` header, and it sends no CORS headers, so a web page can't reach it through DNS rebinding.
- Opens the database read-only (`mode=ro` and `query_only`).
- The config stores a SHA-256 verifier and the scopes for each token, never the token itself. A presented token is checked against every verifier in constant time.
- Requests are limited to 8 KB (a send's body to 32 KB), 4 at a time, with a 10-second read timeout.
- The log, `~/Library/Logs/gbrain-apple-helper.log`, records route, status, duration, row count and request id only.
- A source module checks its permission without prompting. A missing grant returns a problem response, never a dialog. iMessage needs Full Disk Access, which macOS never asks for with a dialog.
- The tailnet listener (`listen.tailnet` in the config) answers only the send route, only to the peers it lists (Tailscale IPv4 addresses, never loopback or the Mac's own addresses). It binds the Mac's Tailscale IPv4 address on a `utun` interface, retries the bind while Tailscale comes up after a reboot, and runs apart from the loopback listener, so one never takes the other down. IPv4 only.

## Config

`~/Library/Application Support/GBrain Helper/config.json`, in a 0700 folder, mode 0600:

```json
{
  "port": 8792,
  "sources": { "imessage": { "enabled": true } },
  "tokens": [{ "name": "gbrain", "scopes": ["read:imessage"], "verifier": "<sha256 of the token, hex>" }]
}
```

`db_path` overrides the Messages database path (default `~/Library/Messages/chat.db`). Sources are off unless turned on.

Two optional blocks turn on sending:

```json
{
  "listen": { "tailnet": { "allowed_peers": ["100.64.0.10"], "host": "100.64.0.20" } },
  "send": { "enabled": true }
}
```

`listen.tailnet.allowed_peers` lists the Tailscale IPv4 addresses that may send; `host` is optional and defaults to this Mac's Tailscale address. `send.enabled` is the kill switch: the helper reads it on every send, so `false` stops the next send with no restart. It can only stop sending: once the helper sees it off, turning sending on again needs the owner's Touch ID (below), and a send already waiting in line is refused too.

## Commands

```text
gbrain-apple-helper init --port <n> [--enable imessage] [--db <path>]
gbrain-apple-helper token add --name <name> --verifier <sha256 hex> [--scope read:imessage]
gbrain-apple-helper token remove --name <name>
gbrain-apple-helper validate-config
gbrain-apple-helper check [--db <path>]
gbrain-apple-helper serve
gbrain-apple-helper send-setup [--off]
gbrain-apple-helper send-key add --name <name> --public-key-file <path or ->
gbrain-apple-helper send-key remove --name <name>
gbrain-apple-helper send-limits set <limit>=<n>...
gbrain-apple-helper send-audit show --redacted [--since <n>d]
gbrain-apple-helper --version
```

Every command takes `--config <path>`. `token add` takes the token's SHA-256, never the token. A running `serve` picks up `token add` and `token remove` on its next request, and refuses every token while the config can't be read. `check` prints counts only.

## Sending

Sending is off until the owner turns it on at the Mac. The owner's agent then sends a one-to-one iMessage, as the owner, from the owner's own Messages app. Day one has no SMS, group chats, pictures or replies inside a thread, and it accepts only sends the owner asked for (`requested_by` must be `owner`; the agent is what enforces that, and the limits below cap the damage if it is ever tricked).

### Turning it on, once, at the Mac

1. Add the agent computer's address to `listen.tailnet.allowed_peers` and restart the helper.
2. `gbrain-apple-helper send-setup`. The running helper opens Messages hidden and asks macOS for permission to control it from its own process, so macOS records the grant for GBrain Helper. macOS shows "“GBrain Helper” wants access to control “Messages”…": click Allow. It then asks to show notifications, and asks for Touch ID or the login password to turn sending on.
3. On the agent's computer, make an Ed25519 key pair (`generateSendKeyPair` in `src/core/apple/send-sign.ts`) and keep the private key there. At the Mac, `gbrain-apple-helper send-key add --name <name> --public-key-file -` with the public key on stdin asks for Touch ID once.
4. Full Disk Access (System Settings > Privacy & Security > Full Disk Access) must be on: the helper reads the Messages database to confirm each send.

With nobody logged in at the Mac, the Touch ID steps fail with `owner_presence_unavailable`. Removing a key, lowering a limit and `send-setup --off` need no prompt.

### Request

`POST /v1/imessage/send` on the tailnet listener, with `Content-Length` and a JSON body of string fields only:

```json
{ "to": "+15550100100", "text": "Running 10 minutes late", "requested_by": "owner", "owner_instruction": "<the owner's words that asked for it>" }
```

- `to`: one E.164 phone number or one email address. Spaces, dashes, dots and brackets in a number are dropped; an email is lower-cased.
- `text`: 1 to 4,000 UTF-16 code units and at most 2,000 characters (grapheme clusters), not blank. `checkSendText` in `send-sign.ts` applies the same rule.
- `owner_instruction`: required, up to 1,000 characters, kept in the send log only.
- Unknown fields, duplicate keys, non-string values, chunked bodies and `Expect: 100-continue` are refused.

Headers:

- `Idempotency-Key`: 8 to 128 characters of `A-Z a-z 0-9 . _ -`. Derive it from the owner's message, so an agent restart reuses it.
- `Authorization: GBrain-Sign key=<name>, ts=<unix seconds>, nonce=<32 lowercase hex>, sig=<base64url>`, where `sig` is the Ed25519 signature of these lines joined by `\n`: `GBRAIN-SIGN-V1`, `POST`, `/v1/imessage/send`, `ts`, `nonce`, the `Idempotency-Key`, and the lowercase hex SHA-256 of the exact body bytes. `signSendRequest` in `src/core/apple/send-sign.ts` builds it; `Tests/HelperCoreTests/Fixtures/send-sign-vectors.json` holds vectors both sides test against. A timestamp more than 60 seconds off, or a nonce seen in the last 10 minutes, is refused.

### What happens

One send runs at a time. The helper checks the idempotency key and the limits, writes a `pending` line to the send log, opens Messages hidden if it isn't running, checks its permission and that iMessage is signed in, and hands the text and recipient to Messages as Apple Event data, never as script source, with a 20-second timeout. It then reads the Messages database for the new outgoing message and waits up to 30 seconds for Messages to mark it sent. Allow at least 75 seconds for the response.

| Answer | Status | `side_effects` | What it means | Retry |
| --- | --- | --- | --- | --- |
| `sent` | 200 | `sent` | Messages marked it sent (`is_sent` set, no error); `guid` and `rowid` name it | never needed; the same key replays |
| `unknown` | 202 | `possible` | Messages took it but didn't confirm in time, or the Apple Event timed out after dispatch | same key only: it re-checks the database and replays |
| `failed_after_submit` | 502 | `none` | Messages took it and reported an error; nothing was delivered | the same key replays this answer |
| any other problem | 4xx, 5xx | `none` | refused before anything reached Messages | per its `retryable`; the same key may be retried |

Every answer carries `outcome`, `code`, `retryable`, `side_effects` and `replayed`. A retry with the same key and the same body (all four fields, compared after normalising the recipient and the text) returns the first answer with `replayed: true` for 7 days and never sends again. A pending send the helper died during is checked against the Messages database when it starts.

### Limits

5 a minute, 30 an hour and 60 a day in total, 10 an hour to one recipient, and 3 a day to people the owner has never texted one-to-one before. They live with the send keys in the keychain, survive a restart (the windows are rebuilt from the send log), and `send-limits set` raises one only with Touch ID: `max_per_minute`, `max_per_hour`, `max_per_day`, `max_per_recipient_per_hour`, `max_first_contact_per_day`. Each send, failed or sent, shows a notification banner on the Mac naming the recipient, never the text.

### Send keys and the keychain

The Mac stores only public keys, with the on switch and the limits, in one keychain item (service `io.gbrain.apple-helper`, account `send-keys`). The helper reads that exact item and refuses it (`send_keys_tampered`) when its access list lets any program other than GBrain Helper read or change it. Reinstall the helper with the same signing identity, or macOS stops letting it read the item (`send_keys_unreadable`).

What this does not stop: a program running as the owner that builds a look-alike item trusted only by the helper before the helper makes its own. The banner on every send and the limits are the backstop. Another local program can also take the tailnet port while the helper is down (KeepAlive restarts it within about 10 seconds); it learns no secret it can replay, but it would see one recipient and text.

### The send log

`~/Library/Application Support/GBrain Helper/send-audit/YYYY-MM.jsonl`, mode 0600, one line per attempt and one per outcome: time, key name, the caller's address, idempotency key, recipient, the exact text, `requested_by`, `owner_instruction`, outcome and the Messages guid or error. No setting turns it off. A new file starts each month; after 90 days a line keeps only its time, outcome, code and a short hash of the recipient. A torn last line is moved to `torn-<time>.jsonl` instead of stopping the helper. `gbrain-apple-helper send-audit show --redacted` prints the redacted form; read that, not the raw file. The log never leaves the Mac.

### Outside terms

Apple's terms for iMessage forbid spam and bulk messaging, and SMS, when it comes, falls under carriers' rules for automated texts. The limits above sit well inside both.

## Errors

Errors are RFC 9457 problem responses (`application/problem+json`) with `code`, `detail`, `retryable`, `fix` when there is one, and `request_id`. Each `type` links to its entry here.

### bad_param

A query parameter is missing or out of range. The detail names it. A repeated parameter keeps its first value. A request that isn't valid HTTP gets this code too.

### unauthorized

No bearer token, or one the helper doesn't know.

### insufficient_scope

The token is valid but lacks the route's scope, such as `read:imessage`.

### source_disabled

The source is off in the helper's config. Set `sources.<source>.enabled` to `true` in the config, then restart `serve` (`launchctl kickstart -k gui/<uid>/io.gbrain.apple-helper`).

### forbidden_source

The caller's address isn't allowed on this listener. The loopback listener accepts only this Mac.

### forbidden_host

The `Host` header isn't `127.0.0.1:<port>`. Names such as `localhost` are refused on purpose.

### forbidden_origin

The request carried an `Origin` header, so it came from a web page.

### not_found

No route, or no chat matching the selector. The handle you asked for is never echoed back.

### method_not_allowed

Read routes take `GET`; the send and admin routes take `POST`.

### too_large

The request was over 8 KB, or a send's body over 32 KB.

### overloaded

Four requests were already running. Retry after the `Retry-After` seconds.

### no_access

The helper has no Full Disk Access. Turn on GBrain Helper in System Settings > Privacy & Security > Full Disk Access.

### db_missing

There is no Messages database at the configured path.

### db_busy

The database stayed locked for 2 seconds. Retry after the `Retry-After` seconds.

### schema_mismatch

macOS changed the Messages database layout. Rebuild the helper from a newer gbrain.

### internal

An unexpected error. The request id is in the helper's log.

### idempotency_key_required

A send had no valid `Idempotency-Key` header. Nothing was sent.

### idempotency_conflict

The key was used for a different body in the last 7 days. This message was not sent; `side_effects` says what happened to the first message under that key, so `sent` or `possible` means don't resend it under a new key.

### send_in_progress

A send with this key is still running. Retry with the same key after `Retry-After`.

### audit_unavailable

The send log couldn't be written, so nothing was sent.

### automation_denied

macOS hasn't let GBrain Helper control Messages. Run `gbrain-apple-helper send-setup` at the Mac and click Allow, or turn it on under System Settings > Privacy & Security > Automation > GBrain Helper > Messages.

### messages_signed_out

No iMessage account is turned on in Messages. Sign in at the Mac.

### messages_unavailable

Messages didn't open or answer, usually because nobody is logged in at the Mac. Retryable.

### recipient_not_imessage

Messages couldn't find the recipient on iMessage before sending. Nothing was sent.

### failed_after_submit

Messages took the text, then reported an error and didn't deliver it. The detail carries the error number.

### send_failed

Messages refused the Apple Event before sending anything. The detail carries the error number.

### send_rate_limited

A limit is reached. Retry after `Retry-After`; the detail names the limit.

### requester_not_supported

`requested_by` wasn't `owner`. Sends for anyone else's asks aren't supported yet.

### send_disabled

Sending is off: `send.enabled` is `false` in the config, or sending was never turned on with `send-setup`.

### signature_invalid

The `GBrain-Sign` header is missing or malformed, or the signature doesn't match the body, path and key.

### timestamp_skew

The signed time is more than 60 seconds from the Mac's clock. `server_time` carries the Mac's clock. Sign again.

### nonce_replayed

The nonce was used in the last 10 minutes. Sign again with a fresh nonce and the same `Idempotency-Key`.

### unknown_send_key

No send key has that name. Add its public half at the Mac with `send-key add`.

### send_keys_unreadable

macOS wouldn't let the helper read its keychain item, usually after a re-sign with a new identity. Reinstall with the original signing identity, then run `send-setup`.

### send_keys_tampered

The keychain item can be read or changed by programs other than GBrain Helper, or there is more than one. Delete it in Keychain Access, then run `send-setup` and add the keys again.

### owner_presence_unavailable

A change that widens sending needs Touch ID or the login password, and nobody confirmed it at the Mac.

## Testing on macOS 27

CI builds and tests the helper on a macOS 26 runner (`.github/workflows/apple-helper.yml`), and it isn't a required check yet. Macs that run it may be on macOS 27, so the first owner-asked send on the Mac is the proof that sending works there.
