**A team brain can refuse page writes that carry a credential, uploads in parts included.**

<!-- behavior-change: secrets_on_write_guard -->

### Added
- `secrets.on_write` (DB plane, default off; `gbrain config set secrets.on_write refuse`, or `GBRAIN_SECRETS_ON_WRITE=refuse`): remote MCP page writes (`put_page`, `put_pages`, `edit_page`, `append_page`, `capture`, `add_timeline_entry`, `takes_*`) whose text looks like a Slack webhook or token, Sentry DSN or auth token, GitHub token, Google API key, AWS access key, private key block, JWT, credentialed database URI or a real password assignment are refused before they are journaled (`secret_in_write`, `reason` names the pattern type, never the value). `commit_page_upload` scans the assembled upload, so a secret split across two `upload_page_part` calls is found; the refused upload is aborted and no page is written. Environment variable names, placeholders and code references pass. Local CLI writes, sync and imports are not scanned.
