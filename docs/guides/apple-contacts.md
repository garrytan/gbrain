# Apple Contacts from a Mac

The `apple-contacts` source kind brings the address book on your Mac into your brain: one private contact page per
contact under `contacts/apple/`. It reads through GBrain Helper, the small app on your Mac that already serves
[iMessage](apple-setup.md), over the network: the helper answers `GET /v1/contacts/changes` with a read:contacts
token, and gbrain pulls the changes every 15 minutes.

What it does on day one:

- **Contact pages.** Each contact gets a page with its name, emails, phones (with labels such as "mobile"), company,
  job title and Contacts groups (as tags). A contact with no email and no phone gets no page.
- **Exact links to your people pages.** When a contact's email or phone equals the email or phone on exactly one
  person page in your brain, the contact page is linked to that person (an identity link, the same kind
  `gbrain dedupe confirm` makes). Names never match: two people called Alice stay two people.
- **Facts on that person page.** The matched `people/` page gets rows in its `## Facts` section, one each for the
  company, the job title and every group name (`Company: …`, `Job title: …`, `Contacts group: …`), with the
  source `apple-contacts:<id>`. Phones, emails, the nickname and the contact id stay on the owner-only contact page and
  never reach a `people/` page. Nothing outside the Facts section changes: not your text, not the frontmatter, not
  the page's trust tier. Only this source updates or retires its own rows; a claim you saved yourself with the same
  text is left alone, and the source does not add a copy of it.
- **Questions it cannot settle go to you.** A contact whose email or phone belongs to two or more people is not linked;
  `gbrain sync status --source <id>` lists it under identity reviews until you decide.
- **`whois` by phone.** `gbrain whois "+1 555 555 0100"` finds the person whose `phone` or `phones` holds that
  number in any format.

What it does not do: it never writes to Contacts, never copies phones or emails onto people pages, and never extracts
facts from contact cards.

## Privacy

- **Owner-only.** The source is registered with `owner_only: true`: only you read its pages (the CLI on the brain's
  machine, and agents whose credentials are bound to you as the owner). See
  [owner-only sources](access-designations.md#owner-only-sources-owner_only).
- **Private and database-only.** Every contact page is `visibility: private` and lives only in the database, even on a
  brain with a Git repository: no contact page is written to a checkout, committed or pushed.
- **The token stays in one file.** The read:contacts token is read only from the 0600 JSON file the source names
  (`{"accessToken": "..."}`), never from the environment, a flag or a URL, and never printed or logged.

## Register and sync

```bash
gbrain sources add contacts-mac --kind apple-contacts \
  --helper-host <the helper's address> --token-file /path/to/contacts-token.json
gbrain sync --source contacts-mac
```

GBrain Helper answers the Contacts route only on its own Mac (`127.0.0.1`) and on its Tailscale address, for the
peers it lists. Point `--helper-host` at one of those, directly or through `--proxy`, so the token and the contacts
travel only inside the Mac or inside Tailscale's encrypted tunnel, never in plain text across a local network.

Options: `--helper-port <port>` (default 8792), `--proxy socks5h://<host>:<port>` (the proxy resolves the helper's
host name; no credentials in the URL), `--contacts-dir <dir>` (default `contacts/apple`), `--sync-interval-min <n>`
(default 15), `--no-federated` (keep contact pages out of unqualified reads), `--record auto|git|database` and `--dir
<checkout>` (where the source's records live; contact pages are private, so they stay in the database either way).
`--token-env` is refused for this kind.

The first run reads the whole address book; later runs read only what changed since the saved cursor. Phone numbers
written without a country code are read as `identity.phone_country_code` (default `1`):
`gbrain config set identity.phone_country_code 44`. `--reset-checkpoint` is refused for this source; use
`gbrain sync --source <id> --full` to read every contact again.

## How changes and deletions are applied

- A changed contact rewrites its page; an unchanged one writes nothing.
- A contact deleted in Contacts soft-deletes its page, which `gbrain restore <slug> --source-id <id>` can bring back during the purge
  window. Its identity link is removed and its rows on the person page are retired (struck in the Facts section; a
  retirement is not a `forget`, so the rows come back when the contact does). A lost match or a group left retires
  the same way; a changed company or job title replaces its row.
- A full re-read (the first run, `gbrain sync --source <id> --full`, or the helper forgetting the cursor) deletes a page
  for a missing contact only when the helper says the snapshot was complete.
- **Delete floor.** A full re-read that holds no contact with an email or phone, would delete every contact, or would
  delete more than 20% of the source's contacts, writes nothing and stops with `apple_contacts_delete_floor`. An incremental pull applies its changes but keeps the
  deletions it was sent pending until the end of the run; if they are more than 20% of the source's contacts, or all
  of them, none is applied, they stay pending (`gbrain sync status --source <id>` shows them under `held_deletes`) and the
  run ends with the same error. A contact edited down to no email and no phone counts as a deletion. A contact that comes back cancels its pending deletion. No row on a person page is
  retired by a held run, or by a full re-read that did not end complete.

## Errors

### apple_contacts_not_allowed

GBrain Helper is running but macOS has not allowed it to read Contacts. On the Mac, click OK on "GBrain Helper would
like to access your contacts", or switch GBrain Helper on in System Settings > Privacy & Security > Contacts. Then run
`gbrain sync --source <id>`.

### apple_contacts_unauthorized

The helper refused the token (401, or 403 `insufficient_scope`). Put a token the helper issued with the
read:contacts scope in the source's token file, `chmod 600` it, and sync again.

### apple_contacts_token_file

The token file is missing, is a symlink or not a regular file, is readable or writable by group or others, or does not
hold `{"accessToken": "..."}`. Fix the file (owned by the user that runs gbrain, `chmod 600`) and sync again.

### apple_contacts_unreachable

The helper answered 503, timed out or could not be reached, after retries at 1, 4 and 15 seconds. The saved cursor is
unchanged, so the next pull continues from it. Check that the Mac is awake, GBrain Helper is running and any proxy is
up.

### apple_contacts_helper_error

The helper answered with a status gbrain does not expect, or kept returning snapshot pages. Nothing more was written.
Check that GBrain Helper and the GBrain CLI are both up to date; if it repeats, report it with `gbrain doctor --json`.

### apple_contacts_delete_floor

The run would have deleted more than 20% of the source's contacts, or all of them. No contact was deleted: a full
re-read wrote nothing, and an incremental pull kept the deletions pending. Check Contacts on the Mac and that the
helper can read it, then sync again; contacts that come back cancel their deletions. If the deletions are real, run
the sync once with `GBRAIN_ALLOW_MASS_RECONCILE=1`; deleting every contact never passes.

### apple_contacts_disabled

GBrain Helper has its Contacts source turned off. On the Mac, set `sources.contacts.enabled` to `true` in the helper's
`config.json` (the running helper picks it up on its next request), then sync again.

### apple_contacts_config

The source has no helper host, or its proxy is not `socks5h://host:port` (credentials in the URL are refused). Re-add
the source with the right `--helper-host` and `--proxy`.
