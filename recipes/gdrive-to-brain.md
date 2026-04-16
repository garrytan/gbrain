---
id: gdrive-to-brain
name: Google Drive-to-Brain
version: 0.12.0
description: Sync Google Docs, Sheets, and Slides into kbrain. Meeting notes, GTM docs, and standup notes become searchable brain pages.
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option A — recommended, handles OAuth for you)
    where: https://clawvisor.com — create an agent, activate Google Drive service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option A)
    where: https://clawvisor.com — agent settings, copy the agent token
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option B — direct API, you manage tokens)
    where: https://console.cloud.google.com/apis/credentials — create OAuth 2.0 Client ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option B)
    where: https://console.cloud.google.com/apis/credentials — same page as client ID
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
setup_time: 20 min
cost_estimate: "$0 (Google Drive API is free within quota)"
---

# Google Drive-to-Brain: Docs, Sheets, and Slides as Searchable Memory

Hundreds of pages of meeting notes, GTM docs, and standup notes live in Google Drive.
This recipe makes all of it queryable: "What did we tell client A about pricing?" and
"Which prospects mentioned home care?" become instant searches, not hours of scrolling.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**The core pattern: code for data, LLMs for judgment.**
File collection is deterministic — code fetches, converts, and writes files.
You (the agent) do enrichment: detect entities, update people/company brain pages,
cross-link related documents.

**One brain page per Google Doc.** This is intentional. A Docs search will find
the right document; the brain page gives you context without opening Drive.
For massive docs (100+ pages), the agent can later split by heading.

**Do not try to call Google APIs yourself.** Use the sync script. It handles
pagination, token refresh, idempotency (skip unchanged files), and all three
file types with appropriate export formats.

## Architecture

```
Google Drive (Docs, Sheets, Slides)
  ↓ (credential-gateway: ClawVisor or direct OAuth)
scripts/gdrive-sync.mjs (deterministic)
  ↓ Outputs:
  ├── {brain-dir}/gdocs/{date}-{slug}.md      (Docs as plain text)
  ├── {brain-dir}/gsheets/{date}-{slug}.md    (Sheets as markdown tables)
  └── {brain-dir}/gslides/{date}-{slug}.md    (Slides as section-per-slide)
  ↓
Agent reads new/changed files
  ↓ Judgment calls:
  ├── Entity detection (clients, prospects, people mentioned)
  ├── Cross-links (→ people/, companies/ brain pages)
  └── Timeline entries on related brain pages
```

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the sync script)
3. **Google Drive access** via one of:
   - **Option A: ClawVisor** (recommended — handles OAuth and token refresh)
   - **Option B: Google OAuth2 directly** (no extra service, you manage tokens)

## Setup Flow

### Step 1: Configure Auth

This recipe uses the same credential gateway as email-to-brain and calendar-to-brain.
If you already have ClawVisor set up, **activate the Google Drive service** in the
same agent — skip ahead to Step 2.

#### Option A: ClawVisor (recommended)

Tell the user:
"I need your ClawVisor URL and agent token.
1. Go to https://clawvisor.com
2. Open your existing agent (or create one)
3. Activate the **Google Drive** service (also enable Documents, Sheets, Slides)
4. Update the standing task purpose to include Drive access:
   'Full Google Workspace access: Gmail, Calendar, Drive, Docs, Sheets, Slides.
   Read files, export content, list folders, search across all connected accounts.'
   CRITICAL: Be EXPANSIVE. Narrow purposes block legitimate requests.
5. Copy the gateway URL and agent token"

Validate:
```bash
curl -sf "$CLAWVISOR_URL/health" && echo "PASS: ClawVisor reachable" || echo "FAIL"
```

**STOP until ClawVisor validates.**

#### Option B: Google OAuth2 Setup

Tell the user:
"I need Google OAuth2 credentials with Drive access.

1. Go to https://console.cloud.google.com/apis/credentials
   (use existing project if you have one from email/calendar setup)
2. Click **'+ CREATE CREDENTIALS'** > **'OAuth client ID'**
3. Configure OAuth consent screen if needed:
   - User type: **External** (or Internal for Google Workspace orgs)
   - App name: 'GBrain' (anything works)
   - Scopes to add:
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/documents.readonly`
     - `https://www.googleapis.com/auth/spreadsheets.readonly`
     - `https://www.googleapis.com/auth/presentations.readonly`
   - Test users: add your own email
4. Create the OAuth client ID:
   - Application type: **Desktop app**
5. Enable APIs (all four required):
   - Drive: https://console.cloud.google.com/apis/library/drive.googleapis.com
   - Docs: https://console.cloud.google.com/apis/library/docs.googleapis.com
   - Sheets: https://console.cloud.google.com/apis/library/sheets.googleapis.com
   - Slides: https://console.cloud.google.com/apis/library/slides.googleapis.com
6. Copy the Client ID and Client Secret"

Validate:
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "PASS: Google OAuth credentials set" \
  || echo "FAIL: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"
```

Run the OAuth flow on first use:
```bash
node scripts/gdrive-sync.mjs --dry-run
# The script detects missing tokens and opens the OAuth flow interactively.
# Complete the browser flow, paste the code, tokens saved to ~/.gbrain/google-tokens.json
```

**STOP until tokens are stored at `~/.gbrain/google-tokens.json`.**

### Step 2: Build the Allowlist

The sync script requires an explicit allowlist — it will not sync your entire Drive.
This is intentional: syncing everything creates noise, not signal.

Ask the user:
"Which documents are the most valuable? Common options:
1. **Specific files** — key meeting notes, GTM docs, client call notes
2. **Specific folders** — e.g., 'Client Meetings', 'GTM Strategy', 'Standup Notes'

Get the ID from the Drive URL:
- File: `https://docs.google.com/document/d/**FILE_ID**/edit`
- Folder: `https://drive.google.com/drive/folders/**FOLDER_ID**`"

Add files and folders to the allowlist:
```bash
# Add specific files
node scripts/gdrive-sync.mjs --add-file FILE_ID_1
node scripts/gdrive-sync.mjs --add-file FILE_ID_2

# Add a folder (all Docs/Sheets/Slides inside it)
node scripts/gdrive-sync.mjs --add-folder FOLDER_ID

# Review the allowlist
node scripts/gdrive-sync.mjs --list-config
```

Allowlist is saved to `~/.gbrain/gdrive-config.json`. Edit it directly to bulk-add IDs.

To remove an entry:
```bash
node scripts/gdrive-sync.mjs --remove-file FILE_ID
node scripts/gdrive-sync.mjs --remove-folder FOLDER_ID
```

### Step 3: Run First Sync

```bash
# Dry run — preview what would sync without writing anything
node scripts/gdrive-sync.mjs --dry-run

# First sync
node scripts/gdrive-sync.mjs --brain-dir ~/Documents/kbrain
```

To add a one-off file or folder without saving it to the allowlist:
```bash
node scripts/gdrive-sync.mjs --file FILE_ID --brain-dir ~/Documents/kbrain
node scripts/gdrive-sync.mjs --folder FOLDER_ID --days 90 --brain-dir ~/Documents/kbrain
```

Verify output:
```bash
ls ~/Documents/kbrain/gdocs/ | head -10
head -30 ~/Documents/kbrain/gdocs/$(ls ~/Documents/kbrain/gdocs/ | head -1)
```

Check that:
- Frontmatter has correct title, date, source_url
- Content is readable (not base64 or HTML tags)
- Drive link in source_url opens the correct document

### Step 4: Import into GBrain

```bash
gbrain sync --repo ~/Documents/kbrain
```

Or embed in two passes (faster for large syncs):
```bash
gbrain import ~/Documents/kbrain/gdocs/ --no-embed
gbrain import ~/Documents/kbrain/gsheets/ --no-embed
gbrain import ~/Documents/kbrain/gslides/ --no-embed
gbrain embed --stale
```

Verify search works:
```bash
gbrain search "client meeting" --limit 3
gbrain search "pricing discussion" --limit 3
```

### Step 5: Entity Enrichment

This is YOUR job (the agent). For each synced file:

1. **Detect entities**: client names, prospect companies, people mentioned
2. **Check the brain**: `gbrain search "company name"` — do they have a page?
3. **Add cross-links**: update the brain page to mention the doc:
   `- YYYY-MM-DD | Google Doc: [Title](source_url) [Source: Google Drive]`
4. **Update people pages**: if a meeting doc mentions attendees, add timeline entries
5. **Sync changes**: `gbrain sync --no-pull --no-embed`

### Step 6: Expand the Allowlist Over Time

As you identify more valuable files, add them:
```bash
node scripts/gdrive-sync.mjs --add-file NEW_FILE_ID
node scripts/gdrive-sync.mjs  # re-run to pick up new entries
```

Or edit `~/.gbrain/gdrive-config.json` directly to bulk-add IDs:
```json
{
  "files": ["FILE_ID_1", "FILE_ID_2", "FILE_ID_3"],
  "folders": ["FOLDER_ID_1"]
}
```

### Step 7: Set Up Weekly Sync

Keep the brain current with a weekly cron:
```bash
# Every Sunday at 9 AM — re-sync allowlist (idempotent, skips unchanged files)
0 9 * * 0 cd /path/to/kbrain && node scripts/gdrive-sync.mjs \
  && gbrain sync --repo ~/Documents/kbrain
```

### Step 8: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/gdrive-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.12.0","status":"ok","details":{"type":"CLAWVISOR_OR_DIRECT"}}' >> ~/.gbrain/integrations/gdrive-to-brain/heartbeat.jsonl
```

Tell the user: "Google Drive is synced. Your Docs, Sheets, and Slides are now
searchable from the brain. Weekly sync keeps it current."

## Implementation Guide

### Content Export Strategy

| File Type     | Export Format       | Reason                                          |
|---------------|--------------------|-------------------------------------------------|
| Google Docs   | Plain text         | Meeting notes are content-first; formatting is noise |
| Google Sheets | CSV → MD table     | Structured data maps cleanly to markdown tables |
| Google Slides | Slides API → text  | No clean export; Slides API gives per-slide text |

**Docs as plain text:** The Drive export endpoint supports `text/plain` for Docs.
It strips formatting but preserves all text. For meeting notes and standup notes
where content matters more than formatting, this is ideal.

**Sheets per-tab:** Large spreadsheets often have multiple sheets. The Sheets API
metadata endpoint returns sheet names. The sync script creates one `## SheetName`
section per sheet. This keeps structured data organized and searchable.

**Slides per-slide:** The Slides API returns presentation structure with text shapes
per slide. Each slide becomes a `## Slide N` section. If slides have titles, those
become the section headers.

### Idempotency via modifiedTime

```
state = load_state()  // ~/.gbrain/gdrive-state.json

for file in drive_files:
  if state[file.id] == file.modifiedTime:
    skip  // unchanged since last sync
  content = export(file)
  write_brain_page(file, content)
  state[file.id] = file.modifiedTime

save_state(state)
```

This avoids re-downloading unchanged files on every run. For 1,000 Docs, this
means only the ~10 that changed last week get fetched. State file is keyed by
Drive file ID (stable) with value = `modifiedTime` ISO string.

### Output Directory Layout

```
{brain-dir}/
  gdocs/
    2026-04-10-q1-board-meeting-notes.md
    2026-04-08-kaigo-acme-intro-call.md
    ...
  gsheets/
    2026-04-12-pipeline-tracker.md
    ...
  gslides/
    2026-04-05-kaigo-investor-deck.md
    ...
```

Autopilot picks up from all three directories on its next run.

### What the Agent Should Test After Setup

1. **Allowlist enforcement:** Run without any files in config. Verify the script
   exits with a clear error instead of syncing all of Drive.
2. **Add/remove:** `--add-file ID` then `--list-config`. Verify the ID appears.
   `--remove-file ID` then `--list-config`. Verify it's gone.
3. **Idempotency:** Run sync twice. Second run should report 0 synced, N skipped.
4. **Sheets tables:** Open a sheet brain page. Verify markdown table renders
   with correct column alignment and no HTML artifacts.
5. **Slides extraction:** Open a slides brain page. Verify `## Slide N` sections
   with readable text content.
6. **Drive link:** Click the `source_url` link in a brain page. Verify it opens
   the correct document in Google Drive.
7. **Search:** `gbrain search "client name"` should return the synced doc.
8. **Token refresh:** After 1 hour, run sync again (Option B only). Verify it
   auto-refreshes the token without prompting.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ClawVisor (free tier) | $0 |
| Google Drive API | $0 (free quota: 1B reads/day) |
| Google Docs API | $0 (free quota: 300 read req/min) |
| Google Sheets API | $0 (free quota: 300 read req/min) |
| Google Slides API | $0 (free quota: 300 read req/min) |
| **Total** | **$0** |

## Troubleshooting

**`Drive list failed (403)`:**
- Drive API may not be enabled. Enable it:
  https://console.cloud.google.com/apis/library/drive.googleapis.com
- Or the OAuth consent screen lacks the drive.readonly scope.
  Re-run the OAuth flow after adding the scope.

**`Doc export failed (403)` for some files:**
- File may be in a shared drive you don't have export permission on.
- Or the file is a shortcut pointing to a file in another account.
- Check `file.webViewLink` — does it open in your browser?

**Slides content empty:**
- Some slides only have images (no text shapes). The script can't OCR images.
- This is expected — the brain page still exists with the Drive link.

**Sheets export missing tabs:**
- The CSV export from Drive only returns the first tab. The Sheets API
  metadata call (`/spreadsheets/FILEID?fields=sheets.properties`) gets all
  tab names. If this fails, the script falls back to the first tab only.
  Check that the Sheets API is enabled.

**Token refresh loop:**
- If the script keeps refreshing tokens, the refresh token may be revoked.
- Re-run the OAuth flow: `rm ~/.gbrain/google-tokens.json` then `node scripts/gdrive-sync.mjs --dry-run`

---

*Part of the [GBrain Skillpack](../docs/GBRAIN_SKILLPACK.md). See also: [Email-to-Brain](email-to-brain.md), [Calendar-to-Brain](calendar-to-brain.md), [Credential Gateway](credential-gateway.md)*
