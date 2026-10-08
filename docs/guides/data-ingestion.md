# How to get data in

One command, local or hosted, synchronous receipt:

```bash
gbrain capture "the thought I want to remember"
gbrain capture --file ./notes/today.md
echo "from a pipe" | gbrain capture --stdin
SLUG=$(gbrain capture "..." --quiet)
```

Page writes return durable receipts. Replacements require the revision you read or explicit `force`; keep the request UUID when retrying. Accepted work can remain queued while its owner is unavailable, and uncertain publication has an explicit recovery state. Embedding completion is separate from canonical commitment. A source without a configured repository can hold DB-only pages, which need a database backup alongside withdrawal and receipt records. See [concurrent writes](concurrent-writes.md) and the [persistence boundary](../architecture/system-of-record.md#page-write-persistence-boundary). Default slug `inbox/YYYY-MM-DD-<hash8>` so captures cluster in a predictable triage location. On thin-client installs the verb routes through MCP to the server.

**Say to your agent:** *"Remember this: ..."* — *"Save this thought to my brain"* — *"Capture this."* And to fill an empty brain from your existing life: *"Fill my brain"* (the cold-start skill walks your email, calendar, contacts, and archives one consented step at a time).

**Ambient memory writeback (opt-in, personal brains).** Stop having to say "remember this": once enabled, your agents save durable facts you state in passing — preferences, decisions, commitments — with provenance, and transient facts (a cold, a trip) expire when saved with an explicit TTL. Off by default; on a personal brain gbrain asks you once at init/upgrade; company brains are never nudged. **Say to your agent:** *"Turn on ambient memory writeback"* — your agent runs `gbrain config set memory.auto_writeback salient` and `gbrain bootstrap harness --yes`. Full mechanics, privacy posture, and per-harness limitations: [`docs/guides/ambient-writeback.md`](ambient-writeback.md).

**Credentials you save stay in the brain, but retrieval withholds them.** What
you capture or `remember` is stored as written. When a search, query or memory
read returns text containing a credential-shaped value (an API key, a password
assignment, a URL with a password, a private key), the value comes back as
`<REDACTED:pattern>`. A credential you ask the brain to remember is withheld
from remote recall by design: every MCP caller, including stdio MCP, and a
thin-client install count as remote. On the brain host, `gbrain recall` shows
remembered facts as written. Full page reads (`get_page`) are not redacted;
they follow page visibility. Details and the full list of what stays raw:
[secret scan refusals and redaction](write-refusals.md#secret-scan-refusals-and-redaction).

For webhook ingestion (Zapier / IFTTT / Apple Shortcuts):

```bash
curl -X POST https://your-brain/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  -d "# a thought from a Shortcut"
```

For mobile capture, the inbox folder source picks up anything dropped into
`~/.gbrain/inbox/` from iOS Shortcuts / AirDrop / Drafts / Finder.

Your Gmail, calendar, and contacts sync natively. `gbrain google setup` walks
bring-your-own OAuth end to end (your own free Google Cloud client — you own
the app and the tokens, which live only in a local credential vault), registers
a `--kind google` source, runs a bounded first sync, and ends with the
open-loop engine's killer output:

```bash
gbrain google setup       # connect Gmail/Calendar/Contacts → first sync → first digest
gbrain waiting            # who is waiting on you, what you promised, with receipts
gbrain google calendars   # every calendar the account can read; pass an id to
                          #   `sources add … --calendar-id <id>` to sync a secondary one
gbrain loops mute sender <email>     # stop opening loops for a sender (or `thread <id>`)
gbrain loops unmute sender <email>   # undo it — exact and forward-only
```

**Say to your agent:** *"Who is waiting on me?"* / *"open loops"* (routes to the google-loops skill, which also covers muting a sender — your agent runs `gbrain loops mute sender <email>`, and `gbrain loops unmute sender <email>` to undo it) — *"list the calendars my google account can read"* (your agent runs `gbrain google calendars`).

Setup + troubleshooting: [`docs/guides/google-connect.md`](google-connect.md).
How the open-loop engine decides who's waiting: [`docs/guides/open-loops.md`](open-loops.md).

Your other agents' histories import in one command. `gbrain transcripts ingest`
parses agent session logs (Claude Code, Codex, OpenClaw, Hermes, Grok Build) and extracted
consumer chat exports (ChatGPT / Claude.ai `conversations.json`) into readable
conversation pages with provenance back to the exact session file. Pattern-based redaction runs over message bodies, titles, speakers, and session
metadata before anything is written — vendor key prefixes, JWTs, cloud/API key
shapes, `Bearer` and `Authorization: Basic` headers, database and `http(s)`
URLs carrying a password, private keys (also when an excerpt cut off the
`BEGIN` or `END` line), high-entropy `KEY=`/`TOKEN=`/`password=`
assignments (quoted values may contain punctuation), and typed passwords
after a credential label (see [Credential redaction](#credential-redaction)) become `<REDACTED:…>` placeholders (preview with
`--dry-run`; no pattern set is complete, so if a secret still lands see
["If a secret reached the brain"](../../SECURITY.md#if-a-secret-reached-the-brain):
rotate it, then `gbrain delete <slug> --purge`). Embedding is off by default
for bulk backfills, and re-runs are free — unchanged sessions skip on content hash:

```bash
gbrain transcripts ingest                    # discover importable session logs
gbrain transcripts ingest --all              # import everything discovered
gbrain transcripts ingest ~/Downloads/conversations.json  # consumer export (unzip first)
gbrain transcripts ingest --max-bytes 4gb <store>          # oversized store; omit to keep per-format caps
gbrain transcripts status                    # found vs imported, per harness
```

**Say to your agent:** *"Import my conversations from my chatgpt export at ~/Downloads/conversations.json"* — *"Archive my session transcripts"* — and later, *"When did I first discuss agent memory?"* (the archive answers origin questions with dated quotes).

Codex sessions imported before gbrain read codex 0.153+ rollouts lost their
user turns (#5163): the pages hold the assistant side only, and `--since last`
never re-reads them. `gbrain transcripts recover codex` lists those sessions,
re-reads the rollouts still on disk (`~/.codex/sessions` and the archived
store, or the rollouts you name) and says which it can restore and which it
cannot because the rollout is gone. `--apply` re-imports the recoverable ones
in place; a rerun finds nothing to do. It extracts no facts and leaves the
watermark alone; for facts from a restored session, run
`gbrain transcripts ingest <rollout> --facts --max-cost-usd <n>`.

**Say to your agent:** *"Restore the codex sessions that lost my side of the conversation"* (your agent runs the preview, shows you the counts, and applies after you agree).

### Credential redaction

Transcript pages also redact a password typed after a credential label,
even when it is short and low-entropy (`labeled_credential`). Two label
forms are recognized, with bare, quoted or backticked values:

- a single label, `password`, `passwd`, `passcode`, `passphrase` or `pwd`
  (also behind a prefix such as `DB_` and as a JSON key), followed by `:`,
  `=` or the full-width `：` — `password: hunter2`, `**Password:** …`,
  `{"password": "…"}`;
- a pair label, `login`, `log-in`, `credentials`, `creds`, `user/pass` or
  `username/password`, followed by `:`, `=`, `：`, ` - ` or nothing, then
  `user / pass` or `user:pass` — `login alice / hunter2`,
  `creds: alice:hunter2`. Only the password half is redacted. A pair whose
  password starts the next line is redacted too;
- a command-line flag with its value after a space, `--password hunter2`,
  `--pass "two words"` (`--password-file` and other suffixed flags are not
  labels);
- an environment name with more after the label, `PASSWORD_DB=…`,
  `FOO_PASSWORD_BAR=…`, unless the suffix names a setting (`_FILE`, `_PATH`,
  `_MIN_LENGTH`, `_HINT`, `_POLICY` and similar);
- a single label that ends its line, with the value alone on the next line
  (`password:` then `hunter2`);
- Markdown table cells: every cell under a column headed `Password`, `pwd`,
  `DB password` and the like, and the value in a `| password | … |` row,
  including rows without outer pipes, escaped `\|` pipes and tables with
  several credential columns.

To keep prose and code intact, a value is never redacted when it is a
placeholder (`<…>`, `${…}`, `$VAR`), a mask (`****`), a URL, a path, a
function call, a dotted reference (`req.body.password`), a code identifier
(`hashedPassword`), or one of the stoplisted words (`n/a`, `none`, `string`,
`required`, `changed`, `reset`, `flow`, `email`, `await` and similar; the
list is `LABELED_STOPLIST` in `src/core/secret-scan-labeled.ts`). A pair's
password must also be 4+ characters with a letter and a digit or symbol, so
`login: Google/GitHub SSO` and `credentials: docs/auth.md` stay. Known
misses: an unquoted multi-word passphrase, a label with no delimiter
(`the password is …`), a short flag joined to its value (`mysql -phunter2`),
and a meeting link's `?pwd=` passcode. A redacted
value of 8+ characters that is not a stoplisted word is also scrubbed where
the session repeats it bare.

Pages imported before this detector (or a later widening of it) shipped are
not rewritten automatically, so run the audit again after upgrading. `gbrain transcripts audit-secrets --json` (read-only; all
sources, or one with `--source-id`) lists the conversation pages that still
carry a credential: slug, source, hit count per pattern and line numbers,
never the text. The doctor check `transcript_secret_exposure` reads the
audit's cached summary (it never scans pages itself) and says when no audit
has run or what the last one found and how long ago. Review, edit and
removal are separate steps: `gbrain get <slug>`, then `gbrain put <slug> <
edited.md` to remove the credential, or `gbrain delete <slug> --purge` after
asking the user. Rotate any real credential that reached a page (see
["If a secret reached the brain"](../../SECURITY.md#if-a-secret-reached-the-brain)),
then re-run the audit.

**Say to your agent:** *"Check my imported transcripts for passwords"* (your agent runs the audit, lists the pages by slug and asks before changing any).

Or connect the account and skip the manual export entirely. `gbrain connectors`
syncs your ChatGPT and Claude conversation history live, using your own browser
session cookie — incrementally (a durable per-provider watermark, plus a
trailing-window gap-heal), through the same redaction + idempotency pipeline, and
optionally on a schedule. Credentials stay on your machine (`~/.gbrain/connectors/*.json`,
0600) and are sent only to the provider's own host:

```bash
gbrain connectors auth chatgpt --cookie -    # paste the Cookie header (stdin keeps it out of argv)
gbrain connectors sync chatgpt --dry-run     # preview, then --limit 5, then --full
gbrain config set connectors.chatgpt.auto_sync true   # opt-in daily auto-sync (+ gbrain autopilot --install)
```

**Say to your agent:** *"Connect my chatgpt account and pull my whole history into the brain"* — *"Connect my claude account"* — *"Keep my conversations synced automatically."* Your agent walks you through the cookie capture, runs the dry-run → sample → full sequence, and sets up the schedule if you opt in.

Full contract, automation lanes, and the Cloudflare caveat: [docs/guides/chat-connectors.md](chat-connectors.md).

(Not to be confused with the **inbound** "Connectors" above — those add gbrain
as an MCP connector *inside* ChatGPT/Claude/Perplexity so those assistants can
search your brain. `gbrain connectors` goes the other way: it pulls your
conversation history *from* those accounts *into* the brain.)

Third-party skillpacks can ship custom ingestion sources (Granola, Linear,
voice, OCR) against the versioned `IngestionSource` contract at
`gbrain/ingestion`. See [`docs/skillpack-anatomy.md`](../skillpack-anatomy.md).
