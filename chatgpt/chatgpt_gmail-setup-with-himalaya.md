---
title: "Gmail Setup with Himalaya"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1a8937-e9e8-83e8-883f-1eeb9bc5d242
message_count: 4
tags: [chatgpt, import, code]
---
# Gmail Setup with Himalaya

> Conversation ID: 6a1a8937-e9e8-83e8-883f-1eeb9bc5d242
> Created: 2026-05-30T06:52:40Z
> Updated: 2026-05-30T06:54:21Z
> Messages: 4

---

## User

himalya

---

## Assistant

For Gmail with urlHimalaya GitHubhttps://github.com/pimalaya/himalaya, the simplest path is usually an **App Password**, not a passkey. citeturn0search0turn0search7

### Gmail setup
1. Enable **2-Step Verification** on your Google account.
2. Go to Google's App Passwords page:
   urlGoogle App Passwordshttps://myaccount.google.com/apppasswords
3. Generate a new app password (16-character code).
4. Use:
   - Email: your Gmail address
   - Password: the generated app password
   - IMAP: `imap.gmail.com:993`
   - SMTP: `smtp.gmail.com:465`

Himalaya's Gmail examples explicitly use an App Password for password-based auth. citeturn0search7turn0search17

### Alternative: OAuth
Himalaya also supports OAuth2, which is more secure but requires creating Google Cloud OAuth credentials and configuring client IDs/secrets. citeturn0search7

For Hermes, unless you're managing many accounts or need enterprise-grade auth flows, I would use a Gmail App Password first. It's faster to get running and works well with IMAP/SMTP clients like Himalaya. citeturn0search2turn0search7

---

## User

explain what verson is currently avail. this descibe 2. is 2 stable?

---

## Assistant

Current state:

| Version | Status | Notes |
|----------|---------|---------|
| entity["software","Himalaya","v1.2.0"] | Stable release | Latest official release as of Feb 19, 2026 citeturn0search1 |
| entity["software","Himalaya","v2"] | Development / unreleased | README on `master` documents v2, but it explicitly says v2 is "not yet released" citeturn0search1 |

The confusing part is that the GitHub default branch is already showing the future v2 documentation. The maintainers are developing v2 on `master`, but the latest packaged release is still v1.2.0. citeturn0search1

For Hermes:

- If you install via Homebrew:
  ```bash
  brew install himalaya
  ```
  you get v1.2.0 stable. citeturn0search1

- If you install from Git:
  ```bash
  cargo install --locked --git https://github.com/pimalaya/himalaya.git
  ```
  you get the current v2 development code from master. citeturn0search1

Should you use v2?

For Hermes internal ops: probably yes.

Reasons:
- Active development is happening on v2.
- Major architecture cleanup.
- Better multi-backend support.
- Better config system.
- The README and migration docs are focused on v2 now. citeturn0search1

Caveats:
- Breaking changes from v1.
- Docs may change.
- Some bugs are still being worked out before the official release.

I would run:
```bash
cargo install --locked --git https://github.com/pimalaya/himalaya.git
```

for a Hermes workstation, and treat it as a rolling dev dependency.

To check what you currently have installed:
```bash
himalaya --version
```

If you paste the output, I can tell you whether you're on stable v1 or the unreleased v2 branch.
