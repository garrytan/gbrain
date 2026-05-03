---
id: google-tools-mcp
name: Google Tools MCP
version: 1.0.0
description: Unified Google Workspace access via MCP — Gmail, Calendar, Drive, Docs, Sheets, Forms, and Slides. 153 tools, single OAuth, one-command install. Replaces credential-gateway + email-to-brain + calendar-to-brain.
category: infra
requires: []
secrets: []
health_checks:
  - type: command
    argv: ["npx", "-y", "google-tools-mcp", "--help"]
    label: "google-tools-mcp available"
  - type: any_of
    label: "Google OAuth credentials configured"
    checks:
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "GOOGLE_CLIENT_ID (env var)"
      - type: command
        argv: ["sh", "-c", "test -f \"/c/Users/2supe/.config/google-tools-mcp/credentials.json\" || test -f \"/c/Users/2supe/.config/google-tools-mcp/.env\""]
        label: "google-tools-mcp credentials file"
setup_time: 5 min
cost_estimate: "$0 (Google APIs free tier)"
---

# Google Tools MCP: All of Google Workspace in One MCP Server

One MCP server. One OAuth login. 153 tools across Gmail, Calendar, Drive, Docs,
Sheets, Forms, and Slides. Read AND write. No custom collector scripts, no cron
jobs, no credential gateway.

This recipe replaces `credential-gateway`, `email-to-brain`, and
`calendar-to-brain`. If you have those set up, see "Migrating from Split Recipes"
below.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely. Verify after each step.

**What this replaces:**
- `credential-gateway` — google-tools-mcp handles its own OAuth. No ClawVisor
  dependency, no manual token management, no competing auth paths.
- `email-to-brain` — instead of a custom Node.js collector that paginates Gmail
  and produces digests, call `list_messages` / `get_message` / `list_threads`
  directly via MCP tools.
- `calendar-to-brain` — instead of a custom sync script, call `get_events` /
  `list_calendars` directly via MCP tools.

**What this does NOT replace:**
- `meeting-sync` (Circleback) — unaffected, continues independently.
- `x-to-brain` (Twitter) — unaffected.
- `voice-to-brain` (Twilio) — unaffected.

**The core pattern is preserved:** MCP tools ARE the deterministic data layer.
They handle pagination, auth, and API calls reliably. Your judgment role (entity
detection, brain enrichment, classification) is unchanged.

## What You Get

| Service | Key Tools |
|---------|-----------|
| Gmail | `list_messages`, `get_message`, `send_message`, `reply_message`, `create_draft`, `list_threads`, `get_thread`, `list_labels`, `create_filter` |
| Calendar | `get_events`, `list_calendars`, `manage_event`, `get_busy`, `get_free`, `move_event` |
| Drive | `listDriveFiles`, `searchDocuments`, `getFileInfo`, `downloadFile`, `readFile`, `uploadFile`, `createFolder`, `moveFile` |
| Docs | `readDocument`, `appendText`, `modifyText`, `insertTable`, `appendMarkdown`, `replaceDocumentWithMarkdown`, `addComment` |
| Sheets | `readSpreadsheet`, `writeSpreadsheet`, `appendRows`, `createSpreadsheet`, `formatCells`, `insertChart` |
| Forms | `create_form`, `get_form`, `batch_update_form`, `list_form_responses` |
| Slides | `createPresentation`, `getPresentation`, `createSlidesTextBox`, `updateSpeakerNotes` |
| Utility | `help`, `troubleshoot`, `feedback` |

**Total: 153 tools.** All available the moment the server starts.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for npx)

## Setup Flow

### Step 1: Run the Setup Wizard

The setup wizard automates the entire Google Cloud configuration. Run:

```bash
npx -y google-tools-mcp setup
```

The wizard will:

1. **Open the Google Cloud Console APIs page** in your browser. Enable these APIs
   when prompted (click "Enable" on each):
   - Gmail API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Calendar API
   - Google Forms API

2. **Open the OAuth Consent Screen configuration.** Configure:
   - User type: **External** (or Internal for Google Workspace)
   - App name: anything (e.g., "GBrain")
   - User support email: your email
   - Developer contact: your email
   - Scopes: the wizard tells you which to add
   - **Test users: add your own email address** (CRITICAL — without this, Google
     blocks the auth flow with "Access denied")

3. **Open the Credentials page.** Create credentials:
   - Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
   - Application type: **Desktop app**
   - Name: anything (e.g., "GBrain")
   - Copy the **Client ID** and **Client Secret** when shown

4. **Prompt you to paste** the Client ID and Client Secret. The wizard saves them
   to `~/.config/google-tools-mcp/credentials.json`.

5. **Run the OAuth flow.** Opens your browser to Google's consent screen. Sign in,
   grant access. The token is saved to `~/.config/google-tools-mcp/token.json`.

**STOP and verify:**
```bash
npx -y google-tools-mcp auth
```
Should show "Already authenticated" or complete the auth flow successfully.

**If the wizard fails or you prefer manual setup, see Step 1B below.**

### Step 1B: Manual Setup (Fallback)

Only use this if the wizard didn't work.

Tell the user:
"I need Google OAuth2 credentials. Here's exactly how:

1. Go to https://console.cloud.google.com/apis/credentials
   (create a Google Cloud project if you don't have one — it's free)
2. Click **'+ CREATE CREDENTIALS'** > **'OAuth client ID'**
3. If prompted, configure the OAuth consent screen:
   - User type: **External**
   - App name: 'GBrain'
   - Test users: **add your own email address**
4. Application type: **Desktop app**, name: 'GBrain'
5. Copy **Client ID** and **Client Secret**
6. Enable these APIs (click Enable on each):
   - https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - https://console.cloud.google.com/apis/library/drive.googleapis.com
   - https://console.cloud.google.com/apis/library/docs.googleapis.com
   - https://console.cloud.google.com/apis/library/sheets.googleapis.com
   - https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - https://console.cloud.google.com/apis/library/forms.googleapis.com"

Save credentials via ONE of:
- **Option A** (recommended): Download `credentials.json` from Google Cloud Console
  → save to `~/.config/google-tools-mcp/credentials.json`
- **Option B**: Create `~/.config/google-tools-mcp/.env` with:
  ```
  GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
  GOOGLE_CLIENT_SECRET=your-client-secret
  ```
- **Option C**: Set environment variables directly

Then authenticate:
```bash
npx -y google-tools-mcp auth
```

### Step 2: Add to Claude Code

**User-scope (available in all projects — recommended):**
```bash
claude mcp add -s user google -- npx -y google-tools-mcp
```

**Project-scope (current project only):**
```bash
claude mcp add google -- npx -y google-tools-mcp
```

**With env vars (if not using credentials.json):**
```bash
claude mcp add -s user google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y google-tools-mcp
```

**STOP and verify:** Restart Claude Code. The MCP server should connect.
If it doesn't, check `npx -y google-tools-mcp --help` runs without error.

### Step 3: Verify Each Google Service

Test that each service is accessible. Ask the agent to run these checks:

**Gmail:**
```
Call the list_messages tool with maxResults: 3
```
Expected: Returns 3 recent email subjects and senders.

**Calendar:**
```
Call the get_events tool with maxResults: 3
```
Expected: Returns upcoming calendar events with times and attendees.

**Drive:**
```
Call the listDriveFiles tool with pageSize: 3
```
Expected: Returns recent Drive files with names and types.

**Docs (if you have any Google Docs):**
```
Call the searchDocuments tool with query: "" and pageSize: 3
```
Expected: Returns Google Docs file names.

**If any service fails:**
1. Check that the API is enabled in Google Cloud Console
2. Re-authenticate: `npx -y google-tools-mcp auth`
3. Run the troubleshoot tool: `Call the troubleshoot tool`
   (shows auth status, API connectivity, config, environment info)

### Step 4: Multi-Account Support (Optional)

If you use multiple Google accounts (work + personal):

```bash
# Work account
claude mcp add -s user google-work \
  -e GOOGLE_MCP_PROFILE=work \
  -- npx -y google-tools-mcp

# Personal account
claude mcp add -s user google-personal \
  -e GOOGLE_MCP_PROFILE=personal \
  -- npx -y google-tools-mcp
```

Each profile stores tokens separately in `~/.config/google-tools-mcp/<profile>/`.
Authenticate each profile:
```bash
GOOGLE_MCP_PROFILE=work npx -y google-tools-mcp auth
GOOGLE_MCP_PROFILE=personal npx -y google-tools-mcp auth
```

### Step 5: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/google-tools-mcp
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"1.0.0","status":"ok"}' >> ~/.gbrain/integrations/google-tools-mcp/heartbeat.jsonl
```

Tell the user: "Google Tools MCP is set up. You now have full read/write access
to Gmail, Calendar, Drive, Docs, Sheets, Forms, and Slides. No cron jobs needed —
all data is pulled on demand."

## Using Google Tools for Brain Enrichment

### Email Enrichment (Replaces email-to-brain)

Instead of a cron-based collector script, pull and process emails on demand:

1. **Pull recent messages:**
   - `list_messages` with query `is:inbox newer_than:1d` to get today's inbox
   - `get_message` for full content of each message
   - `list_threads` to see conversation context

2. **Triage and filter:**
   - Skip noise: noreply@, notifications@, calendar-notification@
   - Flag signatures: DocuSign, Dropbox Sign, HelloSign, PandaDoc
   - Prioritize: real messages from real people

3. **Entity detection and brain enrichment** (your judgment — unchanged):
   - Detect people and companies mentioned
   - `gbrain search "sender name"` — check for existing page
   - Update brain pages with timeline entries:
     `- YYYY-MM-DD | Email from {sender}: {subject} [Source: Gmail, {date}]`
   - Create pages for notable new contacts

4. **Gmail write capabilities (NEW):**
   - `send_message` — send emails with full brain context
   - `reply_message` — reply to threads
   - `create_draft` — draft for user review before sending
   - `forward_message` — forward with context

5. **Sync:** `gbrain sync --no-pull --no-embed && gbrain embed --stale`

### Calendar Enrichment (Replaces calendar-to-brain)

1. **Pull events:**
   - `get_events` — today's and upcoming events
   - `list_calendars` — all connected calendars
   - `get_busy` / `get_free` — availability windows

2. **Meeting prep** (your judgment — unchanged):
   - For each attendee: `gbrain search "attendee name"` → load context
   - Brief the user on who they're meeting, last interaction, open threads
   - Flag first-time meetings (no brain page = cold contact)

3. **Post-meeting enrichment:**
   - Update attendee pages with timeline entries
   - `manage_event` — create follow-up events
   - `move_event` — reschedule

4. **Calendar write capabilities (NEW):**
   - `manage_event` — create, update, delete events
   - `move_event` — reschedule between calendars

### Drive, Docs, Sheets (NEW — Not Previously Possible)

- **Before meetings:** `searchDocuments` for shared docs, `readDocument` for content
- **Spreadsheet data:** `readSpreadsheet` for tracking sheets, OKRs, pipeline data
- **File management:** `listDriveFiles`, `moveFile`, `uploadFile`, `downloadFile`
- **Read any file:** `readFile` handles PDFs, Word docs (.docx), spreadsheets
- **Document editing:** `appendMarkdown`, `modifyText`, `replaceDocumentWithMarkdown`

## Migrating from Split Recipes

If you previously set up `credential-gateway`, `email-to-brain`, and/or
`calendar-to-brain`:

1. **Set up google-tools-mcp** following Steps 1-5 above
2. **Remove old cron jobs:**
   ```bash
   crontab -l | grep -v email-collector | grep -v calendar-sync | crontab -
   ```
3. **Old collector data is preserved** — JSON files and digests remain in their
   directories. Brain pages are unchanged.
4. **ClawVisor is now optional** for Google services. Still needed if you use it
   for iMessage or other non-Google integrations.

## Troubleshooting

**"google-tools-mcp: command not found":**
- Ensure Node.js 18+ is installed: `node --version`
- Try: `npx -y google-tools-mcp --help`

**Auth fails or token expired:**
- Re-run: `npx -y google-tools-mcp auth`
- If consent screen is in "Testing" mode, tokens expire weekly — re-auth when needed

**"insufficient permissions":**
- Ensure all 6 Google APIs are enabled in Cloud Console
- Re-authenticate to pick up new scopes: `npx -y google-tools-mcp auth`

**Multiple accounts not working:**
- Verify each profile has a unique `GOOGLE_MCP_PROFILE` value
- Check token files: `ls ~/.config/google-tools-mcp/<profile>/`

**Something else:**
- Call the `troubleshoot` tool — it runs diagnostics (auth status, API connectivity,
  config, recent logs, environment info) and suggests fixes
- Call the `feedback` tool — files a bug report with auto-collected diagnostics

## Links

- [google-tools-mcp on GitHub](https://github.com/karthikcsq/google-tools-mcp)
- [google-tools-mcp on npm](https://www.npmjs.com/package/google-tools-mcp)
- [Issue #126](https://github.com/garrytan/gbrain/issues/126)

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Google APIs | $0 (within free quota) |
| google-tools-mcp | $0 (MIT open source) |
| **Total** | **$0** |
