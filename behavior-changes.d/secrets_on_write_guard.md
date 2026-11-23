---
kind: add
---
New opt-in guard: gbrain config set secrets.on_write refuse (or GBRAIN_SECRETS_ON_WRITE=refuse) refuses remote MCP page writes whose text looks like a credential (Slack webhooks and tokens, Sentry DSNs and auth tokens, GitHub tokens, Google API keys, AWS access keys, private keys, JWTs, credentialed database URIs, password assignments) with secret_in_write, naming only the pattern type. commit_page_upload scans the assembled upload, so a secret split across upload parts is caught, and the refused upload is aborted with no page written. Off by default; local CLI writes, sync and imports are not scanned.
