---
id: contacts-to-brain
name: Contacts-to-Brain
version: 0.1.0
description: Google Contacts become canonical people/ pages, enriching brain entities with ground-truth name/email/phone/org data.
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option A — recommended, handles OAuth for you)
    where: https://clawvisor.com — create an agent, activate Google Contacts service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option A)
    where: https://clawvisor.com — agent settings, copy the agent token
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option B — direct API access, you manage tokens)
    where: https://console.cloud.google.com/apis/credentials — create OAuth 2.0 Client ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option B)
    where: https://console.cloud.google.com/apis/credentials — same page as client ID
health_checks:
  - type: any_of
    label: "Auth provider"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/ready"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
setup_time: 15 min
cost_estimate: "$0 (both options are free)"
---

# Contacts-to-Brain: Your Address Book Becomes Ground Truth

Calendar attendees and email senders are the bulk of `people/<slug>` brain pages.
Your Google Contacts is the ground-truth directory — canonical name, email, phone,
organization — for those same entities. Syncing it closes the "who is this person"
loop automatically and feeds enrichment.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this matters:** email-to-brain and calendar-to-brain create people pages
from whatever name string the API returned — sometimes an email prefix, sometimes
a nickname. Contacts carries the authoritative record. After this recipe runs,
"j.smith@acme-example.com" and "Jon S" resolve to the same person page with the
right display name, phone, and company.

**The output is staging files, not direct writes:** the deterministic collector
dumps contact records to `brain/contacts/.staging/`; YOU (the agent) merge them
into `people/<slug>` pages using judgment — the Notability Gate in
`skills/_brain-filing-rules.md` applies. Not every contact deserves a page.

**Do not skip steps. Verify after each step.**

## Architecture

```
Google Contacts (People API, paginated)
  ↓ (ClawVisor credential gateway: list_contacts / get_contact / search_contacts)
Contacts Sync Script (deterministic Node.js)
  ↓ Outputs:
  ├── brain/contacts/.raw/contacts-{date}.json      (raw API responses, provenance)
  └── brain/contacts/.staging/{slug}.md             (one markdown record per contact)
  ↓
Agent reads staging files
  ↓ Judgment calls (Notability Gate):
  ├── Merge into existing people/<slug> pages (name/email/phone/org enrichment)
  ├── Create new pages ONLY for notable contacts not already in brain
  └── Skip the rest (staging is not the brain)
```

## Opinionated Defaults

**Staging record format** (one file per contact, deterministic):
```markdown
# Alice Example

- **Emails:** alice@acme-example.com, alice@gmail.com
- **Phone:** +1 555 0100
- **Organization:** Acme Example — VP Engineering
- **Source:** Google Contacts (resourceName people/c123, synced 2026-07-21)
```

**Enrichment, not duplication:** if `people/alice-example.md` already exists,
append missing fields to it with a `[Source: Google Contacts]` citation. Do NOT
create a second page. Slug-match by normalized name, then by email against
existing page content.

**Notability Gate (from `skills/_brain-filing-rules.md`):** a contact with no
brain presence gets a new page only if they appear elsewhere in the brain
(calendar attendee, email correspondent) or the user confirms they matter.
When in doubt, DON'T create — a junk page degrades search quality.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the sync script)
3. **Google Contacts access** via ONE of:
   - **Option A: ClawVisor** (recommended, handles OAuth for you, no token management)
   - **Option B: Google OAuth2 directly** (you manage tokens, no extra service needed)

## Setup Flow

### Step 1: Choose and Configure Contacts Access

Ask the user: "How do you want to connect to Google Contacts?

**Option A: ClawVisor (recommended)**
ClawVisor handles OAuth, token refresh, and encryption. If you already use
ClawVisor for email-to-brain or calendar-to-brain, this uses the same setup —
just activate the Google Contacts service on your existing agent.

**Option B: Google OAuth2 directly**
Connect to the Google People API directly. No extra service needed, but you
manage OAuth tokens yourself."

#### Option A: ClawVisor Setup

Tell the user:
"I need your ClawVisor URL and agent token.
1. Go to https://clawvisor.com
2. Create an agent (or use existing)
3. Activate the **Google Contacts** service
4. Create a standing task with purpose: 'Full contacts access for people
   enrichment: list contacts, read contact details, search contacts across
   all connected Google accounts.'
   IMPORTANT: Be EXPANSIVE in the task purpose. Narrow purposes block requests.
5. Copy the gateway URL and agent token"

Validate:
```bash
curl -sf "$CLAWVISOR_URL/ready" && echo "PASS: ClawVisor reachable" || echo "FAIL"
```

**STOP until ClawVisor validates.**

#### Option B: Google OAuth2 Setup

Same flow as `recipes/credential-gateway.md` Option B, with the contacts scope:

1. https://console.cloud.google.com/apis/credentials — create an OAuth client ID
   (Desktop app), consent screen scope: `https://www.googleapis.com/auth/contacts.readonly`
2. Enable the People API: https://console.cloud.google.com/apis/library/people.googleapis.com
3. Run the OAuth flow; store tokens in `~/.gbrain/google-tokens.json` (auto-refresh on expiry)

Validate:
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "PASS: Google OAuth credentials set" \
  || echo "FAIL: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"
```

**STOP until OAuth flow completes and tokens are stored.**

### Step 2: Set Up the Contacts Sync Script

```bash
mkdir -p contacts-sync
cd contacts-sync
npm init -y
```

The sync script needs these capabilities:

1. **Paginated retrieval** — `list_contacts` (People API `people.connections.list`)
   returns pages of up to 100; follow `nextPageToken` until exhausted. Request
   fields: names, emailAddresses, phoneNumbers, organizations, metadata.
2. **Deterministic staging output** — one markdown file per contact at
   `brain/contacts/.staging/{slug}.md`, slug from normalized display name
   (fall back to email prefix). Same contact = same file on every run (idempotent).
3. **Raw JSON preservation** — save raw API responses to
   `brain/contacts/.raw/contacts-{date}.json` for provenance.
4. **Skip empty records** — contacts with no name AND no email are noise; drop them.

### Step 3: Run the Full Sync

```bash
node contacts-sync.mjs
```

Verify:
```bash
ls brain/contacts/.staging/ | head -10
```

Should show one file per contact, e.g. `alice-example.md`, `charlie-example.md`.

### Step 4: Enrich People Pages (Agent Judgment)

This is YOUR job (the agent). For each staging record:

1. **Check brain**: `gbrain search "contact name"` — do they have a
   `people/<slug>` page? Also search by email address.
2. **Existing page** → merge the ground-truth fields (canonical name, emails,
   phone, organization) into the page, each with a
   `[Source: Google Contacts]` citation. Fix a wrong/partial display name.
3. **No page** → apply the Notability Gate: create a page only if the contact
   already appears in the brain (calendar, email) or is clearly relevant.
   Otherwise skip.
4. **Back-link** per the Iron Law in `skills/_brain-filing-rules.md`: an
   organization with a brain page gets a link from the person's page and back.

After enrichment, import and embed:
```bash
gbrain sync --no-pull --no-embed && gbrain embed --stale
```

Verify:
```bash
gbrain search "alice-example" --limit 3
```

Should return the enriched people page with contact details.

### Step 5: Set Up Weekly Sync

Contacts change slowly; once a week is plenty:
```bash
# Cron: every Sunday at 9 AM
0 9 * * 0 cd /path/to/contacts-sync && node contacts-sync.mjs
```

After each sync, re-run the Step 4 enrichment pass over CHANGED staging files
only (compare mtime or diff against git), then:
```bash
gbrain sync --no-pull --no-embed && gbrain embed --stale
```

### Step 6: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/contacts-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.1.0","status":"ok","details":{"contacts":"CONTACT_COUNT"}}' >> ~/.gbrain/integrations/contacts-to-brain/heartbeat.jsonl
```

Tell the user: "Contacts-to-brain is set up. [N] contacts staged; [M] people
pages enriched with ground-truth contact data. Weekly sync keeps it current."

## Implementation Guide

### Pagination

```
list_all_contacts():
  contacts = []
  token = null
  do:
    page = list_contacts({ pageSize: 100, pageToken: token,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,metadata' })
    contacts += page.connections
    token = page.nextPageToken
  while token
  return contacts
```

### Slug Normalization

```
slugify(contact):
  name = contact.names?[0]?.displayName
  if not name:
    name = contact.emailAddresses?[0]?.value.split('@')[0]
  return name.toLowerCase().normalize('NFD')
             .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
```

Collision (two contacts, same slug): suffix with the email domain
(`alice-example-acme-example`) rather than overwrite.

### What the Agent Should Test After Setup

1. **Idempotency:** run the sync twice. `git status` on `brain/contacts/.staging/`
   shows no changes on the second run.
2. **Pagination:** with 250+ contacts, verify the staging count matches the
   Google Contacts count (not capped at 100).
3. **Notability Gate:** verify a one-off contact with no brain presence did NOT
   get a `people/` page.
4. **Enrichment merge:** verify an existing people page gained contact fields
   without losing its prior content, each with a `[Source: Google Contacts]`
   citation.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ClawVisor (free tier) | $0 |
| Google People API | $0 (within free quota) |
| **Total** | **$0** |

## Troubleshooting

**No contacts returned:**
- Check ClawVisor has the Google Contacts service activated
- Check the standing task purpose is expansive enough
- Option B: verify the People API is enabled and the token carries
  `contacts.readonly`

**Duplicate people pages after enrichment:**
- The agent matched by name but the brain page slug differs — search by email
  address too before creating, then merge and delete the duplicate

**Contacts with no name:**
- The sync script falls back to the email prefix; records with neither name
  nor email are dropped as noise
