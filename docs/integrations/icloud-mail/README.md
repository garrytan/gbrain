# Read-only iCloud Mail sync for self-hosted GBrain

**Say to your agent:** *"Run the read-only iCloud Mail example in a disposable GBrain."*

This integration example targets self-hosted servers, including Linux. The reproducible fixture feeds fictional Inbox and Sent messages through a read-only IMAP reader into unmodified GBrain. It uses OpenSSL, Bun 1.4.4, a loopback TLS fixture and a disposable PGLite brain. The fixture runs without Mail.app or Apple credentials. Live Apple interoperability remains unverified for this sample. [Synthetic results](fixture-results.json)

## Reproduce

Run from this directory. Use Bun 1.4.4 and Python 3.12 or later with OpenSSL available on PATH. The example checks out [the tested upstream commit](https://github.com/garrytan/gbrain/commit/c347693ce37c80c47b13cb1151dbc360953d5079) into a new temporary directory.

```sh
(
  set -eu
  scratch="$(mktemp -d)"
  trap 'rm -rf -- "$scratch"' EXIT
  upstream="$scratch/upstream"
  git clone https://github.com/garrytan/gbrain.git "$upstream"
  git -C "$upstream" checkout --detach c347693ce37c80c47b13cb1151dbc360953d5079
  (cd "$upstream" && bun install --frozen-lockfile --ignore-scripts)
  PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_imap_capture
  PYTHONDONTWRITEBYTECODE=1 python3 verify_native.py \
    --bun "$(command -v bun)" --checkout "$upstream"
)
```

After dependency installation the tests use loopback only. The native test creates and removes its own scratch directory. It sets a temporary `GBRAIN_HOME`, explicitly passes a PGLite database path in that directory and checks the resulting configuration before importing any mail. It clears inherited provider and GBrain settings from the child environment and disables Bun's dotenv loading. Test certificates and scratch databases stay outside the sample directory.

The runner uses the ordinary GBrain CLI to register a non-federated Markdown source, sync it, and check scoped search and Waiting. Only the Markdown projection enters the source directory. The capture ledger sits outside it. Projection escapes GBrain control syntax in email headers and bodies using the [outside-content rules](https://github.com/garrytan/gbrain/blob/c347693ce37c80c47b13cb1151dbc360953d5079/src/core/outside-content.ts).

## What the checks establish

| Case | Expected result |
|---|---|
| TLS and wire commands | A trusted test certificate with the correct address connects. Both an unknown CA and a mismatched hostname fail before login. The allowed commands are CAPABILITY, LOGIN, EXAMINE, UID SEARCH, UID FETCH with BODY.PEEK, and LOGOUT. The unselected folder is untouched. |
| Folder and message identity | Matching UIDs in the two folders are separate observations. A duplicate byte-identical Message-ID does not create a second page. An incorrectly returned UID stops the batch. |
| Unsupported mail | The ledger records the mailbox, UIDVALIDITY, UID and a reason for each unsupported item. Held items stay out of the index and later valid mail still syncs. A repeat retains the holds without recreating them. |
| Recovery | Reopened processes resume the ledger. A fetch failure in the later folder rolls back the earlier folder. A changed UIDVALIDITY or regressed UIDNEXT stops without advancing the ledger. Omission never removes the archived page. Accepted ledger rows can be projected again while the provider is unavailable. |
| GBrain Inbox and Sent | The initial page appears in its exact source. The reply revises the same page ID and slug, and scoped keyword search finds it once. The archived page is private and external untrusted. |
| Outside text | Fictional mail that mentions GBrain control notation remains searchable text. The escaped notation survives GBrain sync, and the ledger retains the original mail text. |
| GBrain unchanged run | Zero page imports, deletions, chunks and embeddings. Page ID, content hash, revisions and committed request watermark match the previous run. GBrain still updates its source freshness timestamp. |
| Follow-ups | `waiting --source icloud-fixture --json` reports `no_google_sources: true`. Native follow-up changes are outside this import path. |

Plain-directory sync counts a successfully imported update in its `added` field and leaves `modified` at zero. Page ID and revision readback distinguish an update from a duplicate. The broader unqualified trusted CLI can see the private page, while the explicit `default` source returns zero hits. The fixture checks local routing and stored privacy markers. [Plain-directory sync implementation](https://github.com/garrytan/gbrain/blob/c347693ce37c80c47b13cb1151dbc360953d5079/src/commands/sync/plain-directory.ts) · [Source and grant rules](https://github.com/garrytan/gbrain/blob/c347693ce37c80c47b13cb1151dbc360953d5079/docs/guides/multi-source-brains.md)

## Boundary of the sample

- The production endpoint is fixed to Apple's documented IMAP service. The fixture injects a loopback endpoint and certificate only through the Python API. An app-specific password enables access, and immutability comes from the commands the client issues. The code has no SMTP client and exposes no mail tools to MCP.
- The capture proof accepts one account, ASCII mailbox names, messages up to 256 KiB and plain-text bodies with a usable Message-ID. It checks at most 25 messages and 4,096 candidate UID positions per folder per batch. It attaches replies to already known parents and keeps existing page keys. Verified items outside the supported scope enter the hold ledger with a reason and no archived message content. Provider errors, inconsistent fetch responses, and cursor discontinuities stop the batch. Capture reports the current hold count. Hold recovery, localized mailbox discovery, attachment import, and older thread reconstruction remain outside the sample.
- A server deployment would need an explicit initial scope and credential policy. Verify the user's Sent mailbox, including any RFC 6154 special-use response, before admitting it. The standalone capture command reads the password from the environment and pins the configured login and folders in the local ledger. The fixture proves that a different configured login is rejected before reaching the server. The Apple IMAP service does not supply an independently verified account identifier in this proof.
- Network capture commits the SQLite ledger only after both mailbox snapshots succeed. Projection is a separate repeatable step. Keep the output directory dedicated to the collector. Run projection and GBrain sync sequentially. A large production archive and concurrent native sync during projection are outside the sample. No live credential entry or ingest schedule is part of the reproduction.

[Apple IMAP settings](https://support.apple.com/en-us/102525) · [App-specific passwords](https://support.apple.com/en-us/102654) · [Implicit TLS and server identity](https://www.rfc-editor.org/rfc/rfc8314.html#section-3.2) · [IMAP UIDs, EXAMINE and BODY.PEEK](https://www.rfc-editor.org/rfc/rfc9051.html) · [IMAP Sent mailboxes](https://www.rfc-editor.org/rfc/rfc6154.html#section-2) · [Email reply identity](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4)
