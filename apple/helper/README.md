# GBrain Helper (macOS)

A small macOS program that reads the Messages database on your own Mac and answers gbrain over `127.0.0.1`. It never writes to the database, never sends a message and never shows a macOS dialog while it answers a request.

This folder is Swift source only. On Linux and Windows nothing in gbrain's install, upgrade, doctor or test suite builds or loads it. A later `gbrain apple-setup` builds it on your Mac; until then, `.github/workflows/apple-helper.yml` builds and tests it on a macOS runner.

## Build and test on a Mac

```bash
cd apple/helper
swift build
swift test
```

The helper runs on macOS 13 or newer. Building it needs the Xcode Command Line Tools (`xcode-select --install`), and `swift test` needs Swift 6 (Xcode 16 or its Command Line Tools, macOS 14.5 or newer) because the tests use Swift Testing.

## Layout

- `Sources/HelperCore/`: the Messages reader, the HTTP server, tokens, config and source modules.
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

Without a cursor a thread page holds the newest messages, oldest first. With `since_rowid` it holds the messages after that row, in row order; `meta.next_since_rowid` is the cursor for the next page.

## Safety

- Listens on `127.0.0.1` only. It refuses a peer that isn't loopback, a `Host` header other than `127.0.0.1:<port>` and any request with an `Origin` header, and it sends no CORS headers, so a web page can't reach it through DNS rebinding.
- Opens the database read-only (`mode=ro` and `query_only`).
- The config stores a SHA-256 verifier and the scopes for each token, never the token itself. A presented token is checked against every verifier in constant time.
- Requests are limited to 8 KB, 4 at a time, with a 10-second read timeout.
- The log, `~/Library/Logs/gbrain-apple-helper.log`, records route, status, duration, row count and request id only.
- A source module checks its permission without prompting. A missing grant returns a problem response, never a dialog. iMessage needs Full Disk Access, which macOS never asks for with a dialog.
- A listener for allowlisted peers on the Mac's tailnet address (100.64.0.0/10 on a `utun` interface, never loopback or the Mac's own addresses) is built and tested, but no config field turns it on yet.

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

## Commands

```text
gbrain-apple-helper init --port <n> [--enable imessage] [--db <path>]
gbrain-apple-helper token add --name <name> --verifier <sha256 hex> [--scope read:imessage]
gbrain-apple-helper token remove --name <name>
gbrain-apple-helper validate-config
gbrain-apple-helper check [--db <path>]
gbrain-apple-helper serve
gbrain-apple-helper --version
```

Every command takes `--config <path>`. `token add` takes the token's SHA-256, never the token. A running `serve` picks up `token add` and `token remove` on its next request, and refuses every token while the config can't be read. `check` prints counts only.

## Errors

Errors are RFC 9457 problem responses (`application/problem+json`) with `code`, `detail`, `retryable`, `fix` when there is one, and `request_id`. Each `type` links to its entry here.

### bad_param

A query parameter is missing or out of range. The detail names it. A repeated parameter keeps its first value. A request that isn't valid HTTP gets this code too.

### unauthorized

No bearer token, or one the helper doesn't know.

### insufficient_scope

The token is valid but lacks the route's scope, such as `read:imessage`.

### source_disabled

The source is off in the helper's config. Set `sources.<source>.enabled` to `true` in the config, then restart `serve`. The response's `fix` names `gbrain apple enable <source>`, a gbrain command that a later release adds.

### forbidden_source

The caller's address isn't allowed on this listener. The loopback listener accepts only this Mac.

### forbidden_host

The `Host` header isn't `127.0.0.1:<port>`. Names such as `localhost` are refused on purpose.

### forbidden_origin

The request carried an `Origin` header, so it came from a web page.

### not_found

No route, or no chat matching the selector. The handle you asked for is never echoed back.

### method_not_allowed

Only `GET` is supported.

### too_large

The request was over 8 KB.

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
