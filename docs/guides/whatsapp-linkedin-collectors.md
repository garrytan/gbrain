# WhatsApp & LinkedIn Collectors (Whitelist-Gated Personal CRM)

Both collectors follow a strict **explicit-whitelist-only** privacy contract:

1. **Zero bulk ingestion:** No contact pages or transcripts are written until a person is explicitly added to the local whitelist (`~/.gbrain/collectors/*-whitelist.json`, mode `0600`).
2. **Private provenance:** Every ingested source page carries `visibility: private`, `immutable: true`, and `source_kind: whatsapp` or `source_kind: linkedin`, with untrusted text passed through `neutralizeOutsideText`.
3. **Never overwrite living dossiers:** If `people/<slug>` already exists, sync preserves its body intact and appends a dated timeline entry (`addTimelineEntry`) plus a typed `documented_by` link (`addLink`).

## WhatsApp Desktop (macOS)

Reads macOS WhatsApp Desktop's `ChatStorage.sqlite` in strictly read-only mode via `bun:sqlite`.

```bash
# Preview active 1:1 chats without writing anything
gbrain whatsapp list --search "Helen"

# Whitelist a specific contact (or import an existing whitelist JSON)
gbrain whatsapp whitelist add 14155550101@s.whatsapp.net --name "Helen Moore" --slug helen-moore --category network
gbrain whatsapp whitelist import /path/to/whatsapp-whitelist.json

# Dry-run, then sync whitelisted contacts into a source
gbrain whatsapp sync --source kai-brain --dry-run
gbrain whatsapp sync --source kai-brain --owner "Kai"
```

## LinkedIn Data Export

Parses LinkedIn's official **Get a copy of your data** archive (`Connections.csv` with 3-line preamble skipping, `messages.csv`, `Shares.csv`, `Profile.csv`).

```bash
# Unpack archive into ~/.gbrain/collectors/linkedin-export/ (local, outside Git)
gbrain linkedin import-export ~/Downloads/Basic_LinkedInDataExport.zip

# Search connections and DM threads
gbrain linkedin list --with-dms --limit 25
gbrain linkedin list --search "Floodgate"

# Whitelist specific contacts and sync
gbrain linkedin whitelist add in:janedoe --name "Jane Doe" --slug jane-doe
gbrain linkedin sync --source kai-brain --dry-run
gbrain linkedin sync --source kai-brain

# Import your own published posts verbatim into originals/linkedin-posts (requires Shares.csv)
gbrain linkedin import-posts --source kai-brain
```
