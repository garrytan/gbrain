---
id: contacts-to-brain
name: Contacts-to-Brain
version: 0.1.0
description: Google Contacts become canonical people/ pages, enriching brain entities with ground-truth name, email, phone, and organization data.
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option A, recommended, handles OAuth for you)
    where: https://clawvisor.com, create an agent, activate Google Contacts service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option A)
    where: https://clawvisor.com, agent settings, copy the agent token
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option B, direct API access, you manage tokens)
    where: https://console.cloud.google.com/apis/credentials, create OAuth 2.0 Client ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option B)
    where: https://console.cloud.google.com/apis/credentials, same page as client ID
health_checks:
  - type: any_of
    label: "Auth provider"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
setup_time: 15 min
cost_estimate: "$0 (both options are free)"
---

# Contacts-to-Brain: Your Address Book Becomes the Identity Layer

Calendar attendees and email senders are the bulk of `people/<slug>` pages. Your
contacts are the ground-truth directory for those entities: real names, every
email address a person uses, phone numbers, and current organization. This recipe
turns that directory into brain pages, and produces an email-to-slug map the agent
uses to decide which pages are the same person.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this matters:** Contacts are low-volume and high-value. A few hundred
records resolve thousands of ambiguous references. Without them, `email-to-brain`
sees `a.example@acme-example.com` and `alice@acme-example.com` as two strangers,
and `calendar-to-brain` files "A. Example" separately from "Alice Example." You
get three thin pages for one person and search quality degrades on every one.

**Run this recipe BEFORE backfilling email or calendar** if you have the choice.
The alias map it produces is what keeps the other two from fragmenting. If email
or calendar is already ingested, that is fine, Step 5 reconciles what exists.

**The alias map is an agent-read artifact, not a wired-up index.** Nothing in
gbrain reads `aliases.json` automatically today. It exists so that YOU (the agent)
can resolve identities in Step 5 and in later enrichment passes. Do not assume any
other recipe consumes it.

**Do not skip steps. Verify after each step.**

## Architecture

```
Google Contacts (People API: connections.list + otherContacts.list)
  ↓ (ClawVisor credential gateway, paginated + syncToken)
Contacts Collector (deterministic Node.js, no LLM calls)
  ↓ Outputs (gitignored, see Step 0):
  ├── sources/contacts/{slug}.md              (one file per saved contact)
  ├── sources/contacts/aliases.json           (email/phone -> {slug, source})
  ├── sources/contacts/.raw/*.json            (raw API responses)
  ├── sources/contacts/.state/<account>.json  (per-account syncToken + slug pins)
  └── sources/contacts/index.md               (counts, org rollup, deletions)
  ↓
Agent reads staging + alias map directly from disk (NOT via gbrain search)
  ↓ Judgment calls, in this order:
  ├── 5a. Alias reconciliation (fold duplicate pages onto one slug)
  ├── 5b. Notability Gate (which contacts deserve a people/ page at all)
  └── 5c. Merge into people/<slug> (never clobber narrative prose)
  ↓
Only people/ pages enter the brain. Staging is never imported.
```

The split matters. Names, addresses, phone formatting, slug derivation, and the
alias map are mechanical, so code generates them. Whether a contact is worth a
page, and how a contact record reconciles with a page a human wrote, needs
judgment. See
[deterministic-collectors.md](../docs/guides/deterministic-collectors.md).

`sources/` is the sanctioned home for raw data that feeds multiple brain pages, and
[_brain-filing-rules.md](../skills/_brain-filing-rules.md) names contact sync
explicitly as that case. Do not invent a new top-level directory for it.

## Opinionated Defaults

**Two contact surfaces, two endpoints, two different contracts.** These are not
interchangeable, and conflating them is the most common way to break this recipe:

| | `people.connections.list` | `otherContacts.list` |
|---|---|---|
| What it is | Contacts you deliberately saved | Auto-collected from Gmail traffic |
| OAuth scope | `.../auth/contacts.readonly` | `.../auth/contacts.other.readonly` |
| Field parameter | `personFields` (required) | `readMask` (required) |
| Allowed fields | the full person field set | under the default `READ_SOURCE_TYPE_CONTACT`: only `emailAddresses, metadata, names, phoneNumbers, photos` (adding `READ_SOURCE_TYPE_PROFILE` to `sources[]` widens it) |
| pageSize | 1 to 1000, default 100 | 1 to 1000, default 100 |
| Default here | Ingest as staging pages | Alias map only, zero pages |

Other contacts are everyone you ever emailed. Ingesting them as pages floods the
brain with one-off recipients. But they are excellent alias material, so harvest
their email addresses into `aliases.json` and create no pages from them.

**Field selection, per endpoint.** This recipe leaves `sources[]` at its default
(`READ_SOURCE_TYPE_CONTACT`), under which sending the connections field set to
`otherContacts` is a hard 400:

```
connections.list   personFields = names,emailAddresses,phoneNumbers,organizations,
                                  addresses,biographies,urls,metadata,memberships
otherContacts.list readMask     = names,emailAddresses,phoneNumbers,metadata
```

**Staging is never imported into the brain.** The collector writes to
`sources/contacts/`, which is gitignored (Step 0). Only `people/<slug>.md` pages
that pass the Notability Gate enter the brain. This is deliberate: importing
staging first would make every contact a searchable, embedded page before the gate
ever runs, which defeats the gate.

**Slug derivation is deterministic and pinned.** Lowercase the display name, strip
accents, non-alphanumerics become single hyphens, trim. `Alice Example` becomes
`alice-example`. The first slug assigned to a SAVED contact's `resourceName` is
recorded in `.state/<account>.json` and never changes, even if a later contact
collides on display name; the newcomer gets the org appended
(`alice-example-acme`). Without pinning, adding a second "Alice Example" in week 3
renames the incumbent, orphans its `people/` page, and invalidates every alias
pointing at the old slug.

**Only saved contacts own pins.** Auto-collected contacts resolve against the pin
registry but never write to it, because they live in a different resourceName
namespace and cannot return an organization to disambiguate a collision with.
Unresolved auto-contacts are marked for Step 5a rather than guessing a slug.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the collector)
3. **Google Contacts access** via ONE of:
   - **Option A: ClawVisor** (recommended, handles OAuth for you)
   - **Option B: Google OAuth2 directly** (you manage tokens)

If you already set up `email-to-brain` or `calendar-to-brain`, you have the
gateway. Add the Contacts services to the same agent.

## Setup Flow

### Step 0: Keep the Address Book Out of Git

Do this FIRST, before the collector ever runs. `sources/contacts/` will hold the
user's entire address book plus verbatim API responses in `.raw/`. The brain repo
is a git repo that gets pushed.

Resolve `BRAIN_DIR` first and prove it is the brain repo. An unset variable makes
`cd "$BRAIN_DIR"` a silent no-op that leaves you in the agent's cwd, so every
subsequent step writes the address book into the wrong tree:

```bash
BRAIN_DIR="${BRAIN_DIR:-$(gbrain config get sync.repo_path 2>/dev/null)}"
[ -n "$BRAIN_DIR" ] && [ -d "$BRAIN_DIR/.git" ] \
  || { echo "FAIL: BRAIN_DIR unset or not a git repo"; exit 1; }
export BRAIN_DIR
cd "$BRAIN_DIR"
```

Then add the ignore rule. The newline guard matters: appending to a `.gitignore`
whose last line has no trailing newline concatenates onto it and produces a rule
that matches nothing.

```bash
[ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ] && printf '\n' >> .gitignore
grep -qxF 'sources/contacts/' .gitignore || printf 'sources/contacts/\n' >> .gitignore
git add .gitignore
git diff --cached --quiet || git commit -m "chore: ignore contacts staging (PII)"
mkdir -p sources/contacts/.raw sources/contacts/.state
chmod 700 sources/contacts
```

Now ASSERT it worked, before the collector ever writes a contact:

```bash
git check-ignore -q sources/contacts \
  && echo "PASS: contacts staging is gitignored" \
  || { echo "FAIL: sources/contacts is NOT ignored, stop here"; exit 1; }
```

Tell the user plainly: "Your contacts will be written to `sources/contacts/` on
this machine only. I have gitignored it so it never reaches the remote. The brain
will hold `people/` pages for notable contacts, not the raw address book."

**If the user wants staging searchable anyway**, they must pass
`gbrain import --include-gitignored`, because `collectSyncableFiles` enumerates via
`git ls-files --cached --others --exclude-standard` and silently returns zero files
for an ignored directory. Say the tradeoff out loud first: the entire address book
becomes brain pages, and un-ignoring it commits PII to git history permanently.
Default is no.

**STOP until `.gitignore` is committed.**

### Step 1: Configure Contacts Access

Ask the user: "How do you want to connect to Google Contacts?"

#### Option A: ClawVisor Setup

Tell the user:
"1. Go to https://clawvisor.com
2. Use your existing agent, or create one
3. Activate the **Google Contacts** service
4. Add to the standing task purpose: 'List and read all contacts including
   organization and multiple email addresses per contact, AND list other contacts
   (auto-collected addresses), for brain identity enrichment.'
   IMPORTANT: Be EXPANSIVE in the task purpose. Narrow purposes block requests.
   Mention other contacts explicitly, it is a separate permission surface.
5. Copy the gateway URL and agent token"

Validate:
```bash
curl -sf "$CLAWVISOR_URL/health" && echo "PASS: ClawVisor reachable" || echo "FAIL"
```

**STOP until ClawVisor validates.**

#### Option B: Google OAuth2 Setup

Same flow as [calendar-to-brain](calendar-to-brain.md) Step 1 Option B, with these
differences:

- **Two scopes are required, not one.** `contacts.readonly` alone does NOT cover
  other contacts, so alias harvesting 403s:
  - `https://www.googleapis.com/auth/contacts.readonly`
  - `https://www.googleapis.com/auth/contacts.other.readonly`
- Enable the People API at
  https://console.cloud.google.com/apis/library/people.googleapis.com

The collector runs the OAuth flow and stores tokens at
`~/.gbrain/google-tokens.json`, refreshing on expiry, same as the sibling recipes.

Validate:
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "PASS: Google OAuth credentials set" \
  || echo "FAIL: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"
```

Note the frontmatter health check is `env_exists`, which only proves the variable is
present. It cannot detect a revoked refresh token, a People API that was never
enabled, or a missing `contacts.other.readonly` grant. A green health check is not
a working sync. Step 4 is the real check.

**STOP until the OAuth flow completes and tokens are stored.**

### Step 2: Identify Contact Accounts

Ask the user: "Which Google accounts hold contacts worth syncing? Work and personal
usually both have some. If one is a shared or role account, say so, its contacts
are often org-wide noise rather than personal relationships."

For each account note the email address and a label (Work, Personal).

**Every account gets its own state file.** `.state/<account>.json` holds that
account's `syncToken`, its request parameters, and its slug pins. A single shared
state file would send one account's token to another account's `connections.list`,
which is permanently invalid, and each run would clobber the previous account's
pins.

### Step 3: Set Up the Collector

```bash
mkdir -p "$BRAIN_DIR/../contacts-sync" && cd "$BRAIN_DIR/../contacts-sync" && npm init -y
```

The collector takes `--brain-dir` and writes every artifact under
`$BRAIN_DIR/sources/contacts/`. Do NOT use paths relative to the collector's own
cwd; the collector lives outside the brain repo, and relative paths silently
produce a second, orphaned tree that nothing reads.

The collector needs these capabilities:

1. **Paginated retrieval.** `connections.list` accepts `pageSize` 1 to 1000
   (default 100) and returns `nextPageToken`. Loop until the token is absent.
2. **Other-contacts harvest.** A SEPARATE `otherContacts.list` call, using
   `readMask` (not `personFields`) limited to the allowed field set. Feeds the alias
   map only; emits zero staging pages.
3. **Incremental sync, per account.** Pass `requestSyncToken=true` on the full run,
   persist `nextSyncToken` to `.state/<account>.json`, and send it as `syncToken` on
   later runs. Handle expiry (see Implementation Guide).
4. **Deterministic slug + alias extraction**, with slugs pinned per `resourceName`
   and the alias map merged, never rebuilt (see below).
5. **Staging markdown generation.** One file per saved contact, stable field order
   and sorted arrays so an unchanged contact produces a byte-identical file.
6. **Deletion handling.** A sync response marks removed contacts with
   `metadata.deleted`. Record them in `index.md`, skip the file write, and never
   delete a brain page.
7. **Raw JSON preservation** to `.raw/` for provenance.

The index is `index.md` lowercase, deliberately. `SYNC_SKIP_FILES` in
`src/core/sync.ts` matches `index.md` case-sensitively, so lowercase is treated as a
metafile and never becomes a brain page. `INDEX.md` would be synced.

### Step 4: Run the Initial Collection

```bash
node contacts-collector.mjs --brain-dir "$BRAIN_DIR" --account you@example.com --full
```

Tell the user: "Pulling contacts. A few hundred records takes under a minute."

Verify all five collector outputs, with explicit numbers:

```bash
cd "$BRAIN_DIR/sources/contacts"
echo "contacts:   $(ls -1 *.md 2>/dev/null | grep -v '^index.md$' | wc -l)"
echo "aliases:    $(jq 'length' aliases.json)"
echo "from other: $(jq '[.[] | select(.source == "otherContacts")] | length' aliases.json)"
echo "raw files:  $(ls -1 .raw/ | wc -l)"
echo "syncToken:  $(jq -r '.syncToken // "MISSING"' ".state/you@example.com.json")"
test -s index.md && echo "index:      ok" || echo "index:      MISSING"
```

Pass conditions: contacts > 0, raw files > 0, syncToken not `MISSING`, `index` ok,
and **`from other` > 0**. That last one is the real test of other-contacts harvesting.
Do NOT compare total alias count against contact count: the alias map is keyed on
phone numbers as well as emails, so any contact with one email and one phone already
yields two keys whether or not harvesting works at all.

### Step 5: Reconcile and Enrich (do NOT import staging)

This is YOUR job (the agent). Read the staging files and `aliases.json` directly
from disk. There is no import step. Staging is gitignored and deliberately stays out
of the brain.

The order below is load-bearing. Reconcile identities FIRST, then decide who gets a
page, then merge. Any other order creates duplicate pages you have to merge by hand.

**5a. Reconcile duplicates.** Start with the adjudication queue: every entry with
`resolved: false` is an auto-collected address the collector could not tie to a
saved contact, so it is your call whether it is a new person, an alias of an
existing page, or noise. Then, for each entry in `aliases.json`, search the brain for
the email and the display name. When two pages describe one person (a calendar page
under `a-example` and an email page under `alice-example`), pick the canonical slug
from the alias map, merge the narrative, and leave a redirect stub at the loser slug.

**5b. Apply the Notability Gate.** Per
[_brain-filing-rules.md](../skills/_brain-filing-rules.md), not every contact
deserves a page. A contact qualifies when at least one holds:

- They already appear in the brain (calendar attendee, email correspondent)
- They carry an organization you have other pages about
- The user interacts with them recurrently

A phone number saved once for a plumber is a directory entry, not a brain entity. It
stays in the alias map and gets no page. When in doubt, do not create.

**5c. Merge into `people/<slug>.md`.** For contacts that pass, fill the frontmatter
fields the contact record actually knows, and leave the rest alone:

```yaml
---
title: Alice Example
type: person
email: alice@acme-example.com
company: Acme Example
location: Austin, TX
---
```

Then append provenance to the timeline:
```
- **YYYY-MM-DD** | Google Contacts -- Contact record synced: Acme Example, Austin TX [Source: Google Contacts, YYYY-MM-DD]
```

**Never overwrite `## State`, `## What They Believe`, or any prose section from a
contact record.** The contact knows the person's employer. It does not know what the
user thinks of them. Structured fields merge; narrative is append-only.

**Back-link the company, when the company page already exists.**
`_brain-filing-rules.md` makes back-linking an Iron Law: a mention of an entity that
has a page must be reciprocated from that page. So when `company` resolves to an
existing `companies/<slug>.md`, append the mandated back-link there in the documented
format. Do NOT create a company page that does not already exist; the Notability Gate
applies to companies too.

### Step 6: Commit and Sync the Pages

Commit the pages, then sync. To be clear about why: `gbrain sync` does NOT require a
commit to see your edits. `collectSyncableFiles` enumerates with `git ls-files
--cached --others --exclude-standard`, which is tracked PLUS untracked-not-ignored,
so uncommitted work IS indexed (`src/commands/import.ts` says so in-line, and
`test/sync.test.ts` pins it). Commit anyway, for history and so a later
`--respect-gitignore` or clone does not lose the enrichment.

Include `companies/` in the commit: Step 5c may have written back-links there, and
staging only `people/` would leave them behind.

```bash
cd "$BRAIN_DIR"
git add people/ companies/
git diff --cached --quiet || git commit -m "enrich: contact records from Google Contacts"
gbrain sync --no-pull --no-embed && gbrain embed --stale
```

Verify with a contact you know is notable, not a generic word:
```bash
gbrain search "Alice Example" --limit 3
```

Searching a generic term like "contact" matches unrelated pages in any existing
brain and reads as PASS even when nothing was written.

### Step 7: Set Up the Sync Schedule

Contacts change slowly, so a few times a week is plenty. But the schedule is
constrained by the API, not by taste: **sync tokens expire 7 days after the full
sync.** A once-weekly cron sits exactly on that boundary, so the token is at or
past expiry on essentially every run, every run takes the full-sync fallback, and
"incremental" becomes a fiction that also pays the full-sync quota each time.

Schedule comfortably inside the window:

```bash
# Cron: Sunday and Wednesday at 9 AM, one invocation per account. Two runs a
# week keeps every token well inside its 7-day life.
0 9 * * 0,3 cd /path/to/contacts-sync && node contacts-collector.mjs --brain-dir /path/to/brain --account you@example.com
```

The scheduled run refreshes staging only. Re-run Step 5 IN FULL (5a, 5b, then 5c)
and then Step 6 when the agent next has context. Do not shortcut to 5c: the scheduled run
also surfaces brand-new contacts, and those need reconciliation and the Notability
Gate before 5c can decide anything. For unchanged contacts 5a and 5b are cheap
no-ops. Structured-field drift on existing pages is not urgent; new contacts never
getting a page is.

### Step 8: Log Setup Completion

Compute the real values, do not write the placeholder names:

```bash
cd "$BRAIN_DIR/sources/contacts"
CONTACTS=$(ls -1 *.md 2>/dev/null | grep -v '^index.md$' | wc -l | tr -d ' ')
ALIASES=$(jq 'length' aliases.json)
ACCOUNTS=$(ls -1 .state/*.json | wc -l | tr -d ' ')
mkdir -p ~/.gbrain/integrations/contacts-to-brain
jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   --argjson accounts "$ACCOUNTS" --argjson contacts "$CONTACTS" --argjson aliases "$ALIASES" \
   '{ts:$ts,event:"setup_complete",source_version:"0.1.0",status:"ok",
     details:{accounts:$accounts,contacts:$contacts,aliases:$aliases}}' \
   >> ~/.gbrain/integrations/contacts-to-brain/heartbeat.jsonl
tail -1 ~/.gbrain/integrations/contacts-to-brain/heartbeat.jsonl | jq .details
```

Tell the user: "Contacts-to-brain is set up. [N] contacts staged and [M] aliases
mapped, so calendar attendees and email senders now resolve to one page per person
instead of one per address. The raw address book stays local and gitignored."

## Implementation Guide

### The Alias Map: Merge, Never Rebuild

```
build_alias_map(brain_dir, account, contacts, other_contacts):
  path = f'{brain_dir}/sources/contacts/aliases.json'
  map  = load_json(path) or {}          // LOAD FIRST. Incremental runs pass only
                                        // CHANGED contacts; starting from {}
                                        // deletes every prior mapping.
  // Sort before iterating: the API does not guarantee order, and on a first run
  // (empty map) whoever is seen first wins a shared address. Sorting makes that
  // winner the lowest resourceName instead of an API accident.
  for c in sorted(contacts, key=resourceName):
    if c.metadata.deleted or not display_name(c): continue
                                        // BOTH halves. A live-but-nameless
                                        // record (email-only contacts are
                                        // common) would otherwise pin an empty
                                        // slug permanently and write aliases
                                        // pointing at slug ''.
    slug = pinned_slug(account, c.resourceName, c)
    for e in c.emailAddresses:
      put_alias(map, normalize_email(e.value), slug, 'connections')
    for p in c.phoneNumbers:
      put_alias(map, normalize_phone(p.value), slug, 'connections')

  for o in sorted(other_contacts, key=resourceName):   // aliases only, never pages
    if o.metadata.deleted or not display_name(o):
      record_deletion(index_md, o.resourceName) if o.metadata.deleted else None
      continue                          // otherContacts.list also accepts a
                                        // syncToken and returns removals with
                                        // metadata.deleted, and metadata IS in
                                        // its allowed readMask. Same guard.
    // Auto-collected contacts RESOLVE against the pin registry but never CLAIM
    // a pin. Two reasons: their resourceName lives in a different namespace
    // from saved contacts, so pinning one would burn the bare slug on an id
    // that disappears the moment the user saves the contact for real; and
    // pinned_slug disambiguates collisions using the organization, which
    // otherContacts is not permitted to return at all.
    slug = lookup_pin_by_email(account, o) or lookup_pin_by_name(account, o)
    if slug:                            // matched a saved contact's pin
      for e in o.emailAddresses:
        put_alias(map, normalize_email(e.value), slug, 'otherContacts')
    else:
      for e in o.emailAddresses:        // unresolved: Step 5a adjudicates
        put_alias_unresolved(map, normalize_email(e.value), derive_slug(o))

  write_json_sorted(path, map)          // SORT KEYS. Unsorted output churns in
                                        // git on every run.

put_alias_unresolved(map, key, derived_slug):
  // Same never-overwrite-an-incumbent rule as put_alias. Keeps source as
  // 'otherContacts' so the Step 4 gate and test 5 can still count these, and
  // adds resolved:false so Step 5a has an explicit adjudication queue.
  if map.get(key) is None:
    map[key] = {slug: derived_slug, source: 'otherContacts', resolved: false}

put_alias(map, key, slug, source):
  existing = map.get(key)
  if existing is None:            map[key] = {slug: slug, source: source}
  elif existing.source == 'otherContacts' and source == 'connections':
                                  map[key] = {slug: slug, source: source}  // upgrade
  elif existing.slug != slug:     log_shared_address(key, existing.slug, slug)
                                  // KEEP the incumbent. Do not overwrite.
```

Two properties this buys. First, a scheduled incremental run cannot wipe the map.
Second, a shared address (`info@acme-example.com`, a household landline) resolves
the same way on every subsequent run, and on a first run (or a wiped map) the
winner is the lowest `resourceName` rather than whichever record the API happened
to return first. A flat last-write-wins map has neither property, and since the
People API does not guarantee array order between calls, identity resolution would
drift run to run. Note this is stickiness plus a deterministic tie-break, not
semantic correctness: a genuinely shared address has no right answer in code, so
log it and let the agent adjudicate in Step 5a.

```
normalize_email(e): lowercase, trim
                    strip +tag ONLY for gmail.com / googlemail.com and Google
                    Workspace domains (see below)
normalize_phone(p): normalize to E.164 (leading '+', country code, subscriber
                    number). Prefer the API's canonicalForm when present; else
                    prefix the account's default region for numbers written
                    without a country code. Do NOT "keep the last 10 digits":
                    that collapses distinct international numbers onto one key
                    (+44 20 7946 0958 and +1 207 946 0958 both end in
                    2079460958), which sticks the wrong person to a phone
                    alias and poisons reconciliation.
```

**The `+tag` strip is provider-specific, not universal.** Gmail and Google Workspace
treat `alice+ops@` and `alice@` as one mailbox. Many other providers treat them as
two distinct mailboxes, so folding them merges two real people into one page. Gate
the strip on the domain. When the domain is unknown, do not strip.

### Expired syncToken: Match the Reason, Not the Status

```
fetch_changes(account, state):
  try:
    return people_api.connections_list(
      syncToken=state.syncToken, requestSyncToken=true,
      personFields=state.personFields, pageSize=state.pageSize)
  except HttpError as e:
    if expired_sync_token(e):
      log('sync token expired, falling back to full sync')
      return people_api.connections_list(requestSyncToken=true,
        personFields=state.personFields, pageSize=state.pageSize)
    raise

expired_sync_token(e):
  // Match on the REASON, not the status code. The API reference documents this
  // condition as an error carrying a google.rpc.ErrorInfo whose reason is
  // EXPIRED_SYNC_TOKEN, and does NOT pin an HTTP status to it. Google's own
  // contacts guide sample keys on 410; field reports also show 400. Matching
  // the reason is correct under either.
  return any(d.reason == 'EXPIRED_SYNC_TOKEN' for d in error_details(e))
```

Do not key on a bare status code in either direction. The reference specifies only
the reason, so a collector hard-coded to one number can silently stop updating if
the other is returned: the branch never fires, the collector re-raises, the sync cron
dies, the stale token stays in state, and the Step 8 heartbeat keeps reporting
`ok`. Matching on bare 400 has the additional problem of swallowing genuine
`INVALID_ARGUMENT` bugs. Match the reason and you are correct regardless.

**The real parameter constraint on incremental sync** is consistency, not sort
order: every other parameter must match the call that issued the token. Change
`personFields` or `pageSize` between runs and the token is rejected. Persist the
parameters alongside the token in `.state/<account>.json` and reuse them verbatim.

### Stable Output, or Every Sync Is a Diff

```
write_contact_file(contact, dir):
  fields = ordered_dict()                    // FIXED key order, always
  fields['title']    = display_name(contact)
  fields['type']     = 'person'
  fields['emails']   = sorted(emails)        // sort, don't trust API order
  fields['phones']   = sorted(phones)
  fields['company']  = primary_org(contact)  // first with no endDate
  atomic_write(f'{dir}/{slug}.md', render(fields))   // temp + rename
```

The People API does not guarantee array order between calls. Sort every list, fix
the key order, and sort the alias map's keys. Otherwise an unchanged contact
rewrites its file every week, and the idempotency check below can never pass.

### Organization Selection

```
primary_org(contact):
  orgs = contact.organizations or []
  current = [o for o in orgs if not o.endDate]
  return (current[0] if current else orgs[0] if orgs else None)?.name
```

Contacts accumulate past employers. Taking `organizations[0]` blindly files someone
at a company they left years ago, which then contradicts whatever the brain learned
from recent email.

### Deleted Contacts: Skip the Write, Keep the Page

```
for c in changed_contacts:
  if c.metadata.deleted or not display_name(c):
    record_deletion(index_md, c.resourceName)
    continue                    // MUST continue. Deleted resources come back
                                // as a person with metadata.deleted = true and
                                // generally without field data, so derive_slug
                                // can return '' and the write lands on
                                // '<dir>/.md' or collides with a live file.
                                // Guard on the flag AND an empty display name.
  write_contact_file(c, dir)
```

Record removals in `index.md` and stop refreshing their structured fields. Do NOT
delete `people/<slug>.md`. The user removing a phone number from their address book
says nothing about whether the brain should forget the person, and the page usually
holds history the contact record never had.

### What the Agent Should Test After Setup

Each test below has to be able to FAIL. Several obvious formulations cannot.

1. **Idempotency, full mode.** Snapshot checksums of every `*.md` and
   `aliases.json`, then run twice with `--full` and no contact changes. Assert every
   checksum is identical between runs. It must be `--full`: the default incremental
   run returns no changed contacts and rewrites nothing, so it passes even when
   output ordering is unstable. Exclude `.state/`, which stores a fresh token every
   run.
2. **Alias key collapse.** Add a `@gmail.com` contact with two addresses differing
   only by case and a `+tag`. Assert `aliases.json` contains exactly ONE key, the
   fully normalized form, and that neither the mixed-case nor the `+tag` literal
   appears as a key. Asserting "both map to one slug" is not a test: both addresses
   belong to the same contact, so a collector doing no normalization at all passes.
3. **`+tag` survives off-Gmail.** Add a contact at a non-Google domain with a `+tag`
   address. Assert the `+tag` form is its own key.
4. **Expired-token branch.** Add a `--simulate-expired-token` flag (or stub the HTTP
   client) that raises 400 with `ErrorInfo.reason = EXPIRED_SYNC_TOKEN`. Assert the
   collector logs the fallback and completes a full sync. Do NOT try to trigger this
   by corrupting the stored token: a malformed token returns 400
   `INVALID_ARGUMENT`, a different condition, and "fixing" the test by widening the
   handler to all 400s masks real bugs.
5. **Other-contacts containment.** Pick an address you have emailed but never saved.
   Assert it is a key in `aliases.json` with `source: "otherContacts"`, and that no
   `sources/contacts/<slug>.md` exists for it.
6. **Alias map survives an incremental run.** Note the alias count, change ONE
   contact, run without `--full`, and assert the count did not drop. This catches
   the rebuild-from-empty bug directly.
7. **Deletion containment.** Delete a synced contact, re-run, then assert
   `people/<slug>.md` still exists with its prose intact, the removal is listed in
   `index.md`, and no `sources/contacts/.md` file was created.
8. **Merge safety.** Add `## Notes` prose to a `people/<slug>.md`, then change that
   contact's organization in Google Contacts, re-sync, and redo Step 5c. Assert the
   frontmatter `company` updated AND the `## Notes` prose is byte-identical. Both
   halves matter: without the org change, nothing exercises the merge path.
9. **Slug pinning.** Add a second contact whose display name collides with an
   existing one. Assert the incumbent's slug is unchanged and the newcomer gets the
   org-suffixed slug.
10. **PII containment.** Assert `git check-ignore sources/contacts` succeeds and
    `git ls-files sources/contacts` returns nothing.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ClawVisor (free tier) | $0 |
| Google People API | $0 (within free quota) |
| Embeddings (only `people/` pages that pass the gate) | ~$0 |
| **Total** | **$0** |

The first page of a full sync carries extra quota cost and can 429 when exceeded.
Relevant because test 4 deliberately triggers a full-sync fallback.

## Troubleshooting

**No contacts returned:**
- `personFields` is REQUIRED on `connections.list`. Omitting it is an error, not a
  default field set. (`otherContacts.list` uses `readMask` instead, also required.)
- Check the Contacts service is activated on the ClawVisor agent, and that the
  standing task purpose covers reading contacts.
- Confirm the account actually has saved contacts. A work account may keep them in
  the org directory instead, which this endpoint does not read.

**Other contacts 403, or `from other` is 0:**
Option B needs BOTH `contacts.readonly` and `contacts.other.readonly`. The second is
a separate grant; adding the first alone leaves harvesting broken while the rest of
the sync looks healthy. Re-run the OAuth flow after adding it.

**`otherContacts.list` returns 400:**
You are almost certainly sending `personFields`, or a `readMask` containing fields
that endpoint does not allow. Its `READ_SOURCE_TYPE_CONTACT` mask permits only
`emailAddresses, metadata, names, phoneNumbers, photos`.

**Alias count dropped after a scheduled run:**
`build_alias_map` is rebuilding from empty instead of loading and merging. The
incremental run only receives changed contacts. See "Merge, Never Rebuild."

**Sync reports ok but nothing changes in the brain:**
Most likely the collector wrote to a path relative to its own cwd instead of
`--brain-dir`, so the files you expect were never created where the brain looks.
Note this is NOT a missing-commit problem: `gbrain sync` indexes uncommitted
working-tree files too (`git ls-files --cached --others --exclude-standard`), so an
uncommitted `people/` edit is still picked up. Check the path first. Then confirm
you are not looking at a page the Notability Gate correctly declined to create.

**Every sync re-embeds everything:**
Output is not stable. Check that all arrays are sorted, frontmatter key order is
fixed, and `aliases.json` keys are sorted.

**Contact shows a stale employer:**
`primary_org` is taking `organizations[0]` instead of preferring the entry with no
`endDate`.

**Two different people resolved to one page:**
Three causes, in order of likelihood: a `+tag` was stripped on a non-Google domain;
an auto-collected contact's `derive_slug` result was written as a RESOLVED alias
(or allowed to claim a pin) instead of being marked `resolved: false` for Step 5a;
or a shared address was overwritten instead of logged. Check the shared-address log first.
