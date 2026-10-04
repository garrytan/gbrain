---
name: publish
description: Share brain pages as beautiful password-protected HTML with zero LLM calls
triggers:
  - "share this page"
  - "publish page"
  - "create shareable link"
tools:
  - get_page
  - search
mutating: false
---

# Publish Skill

Share brain pages as beautiful, self-contained HTML documents. Optionally
password-protected with client-side AES-256-GCM encryption. No server needed.

This is a **code + skill pair**: the deterministic code (`gbrain publish`) does
the stripping, encrypting, and HTML generation. This skill tells you when and
how to use it. See [Thin Harness, Fat Skills](https://x.com/garrytan/status/2042925773300908103)
for the architecture philosophy.

## Contract

- Published HTML is fully self-contained: no external dependencies, no server needed.
- All private metadata (frontmatter, source citations, confirmation numbers, brain cross-links, timeline) is stripped before publishing.
- Password protection uses AES-256-GCM with PBKDF2 key derivation; plaintext never appears in the encrypted HTML file.
- Default is always encrypted unless the user explicitly requests "open", "no password", or "public".
- External URLs (`https://...`) are preserved; only internal brain paths are stripped.

## When to Publish

- User asks to share a brain page, create a shareable link, or says "give me a page"
- User wants to send a deal memo, person briefing, or research to someone external
- User asks to publish a data room analysis or trip plan
- Any time brain content needs to leave the brain without exposing the whole system

## Default: ALWAYS ENCRYPT

Brain content is private. Default to password-protected unless the user explicitly
says "open", "no password", or "public".

If no password is specified, auto-generate one. Share the password via a different
channel than the URL.

## Quick Reference

```bash
# Basic publish (outputs local HTML file)
gbrain publish brain/companies/acme.md

# Password protected (auto-generate password)
gbrain publish brain/companies/acme.md --password

# Password protected (specific password)
gbrain publish brain/companies/acme.md --password "secret123"

# Custom title
gbrain publish brain/companies/acme.md --password --title "Acme -- Deal Analysis"

# Custom output path
gbrain publish brain/companies/acme.md --out /tmp/acme-share.html
```

## What Gets Stripped

The publish command automatically removes all private/internal data:

| Stripped | Example | Why |
|---------|---------|-----|
| YAML frontmatter | `title:`, `type:`, `tags:` | Internal metadata |
| `[Source: ...]` citations | All formats | Provenance is internal |
| Confirmation numbers | `ABC123DEF` -> "on file" | PII/booking data |
| Brain cross-links | `[Jane](../people/jane.md)` -> `Jane` | Internal paths |
| Timeline section | Everything below `---` / `## Timeline` | Raw evidence log |
| "See also" lines | Internal references | Brain navigation |

**Preserved:** external URLs (`https://...`), all other content.

## Sharing Workflows

### Option A: Local file (simplest)

```bash
gbrain publish brain/people/jane-doe.md --password --out ~/Desktop/jane-briefing.html
```

Share the HTML file via email, Slack, Airdrop. Share the password separately.

### Option B: Upload to cloud storage

```bash
# Publish locally first
gbrain publish brain/companies/acme.md --password "secret" --out /tmp/acme.html

# Upload to Supabase Storage
gbrain files upload /tmp/acme.html --page shares/acme

# Get a signed URL (1-hour expiry)
gbrain files signed-url shares/acme/acme.html
```

Share the signed URL + password. URL expires in 1 hour. Re-generate as needed.

### Option C: Static hosting (Render, Netlify, S3)

Upload the HTML file to any static hosting service. The file is self-contained,
no server logic needed. Password-protected files work entirely client-side via
Web Crypto API.

### Option D: GitHub Pages / Gist

```bash
gbrain publish brain/trips/japan-2026.md --out trip.html
# Upload to a GitHub Gist or Pages repo
```

## Password Protection Details

- **Algorithm:** AES-256-GCM
- **Key derivation:** PBKDF2 with 100K iterations, SHA-256
- **Salt:** Random 16 bytes per encryption
- **IV:** Random 12 bytes per encryption
- **Decryption:** Client-side via Web Crypto API (SubtleCrypto)
- **No server auth needed** -- the HTML file is self-contained
- **"Remember on this device"** -- saves password in localStorage

When encrypted, the published HTML contains ONLY ciphertext. The plaintext is
not present anywhere in the file.

## Updating a Published Page

Re-run the publish command with the same output path:
```bash
gbrain publish brain/companies/acme.md --password "same-password" --out shares/acme.html
```

Same file, same URL (if hosted), updated content.

## Revoking Access

Delete the file. If using signed URLs, the URL expires automatically (1 hour).
If using static hosting, remove the file from the host.

## Anti-Patterns

- **Publishing without encryption.** Brain content is private. Default to password-protected unless the user explicitly says "open", "no password", or "public".
- **Sharing password and URL in the same channel.** Always share the password via a different channel than the URL for security.
- **Assuming the user wants raw markdown.** The publish command produces beautiful HTML. Don't copy-paste markdown when `gbrain publish` exists.
- **Including internal metadata.** Never manually share content that contains frontmatter, source citations, or timeline sections. Let the publish command strip it.

## Output Format

```
PUBLISHED: [page title]
========================

File: [output path]
Encrypted: [yes (AES-256-GCM) / no]
Password: [auto-generated password / user-provided / none]
Size: [file size]

Share the file via: [email / Slack / Airdrop / cloud upload]
Share the password via: [a different channel]
```

## Tools Used

- `gbrain publish` -- deterministic HTML generation (no LLM calls)
- `gbrain files upload` -- upload to cloud storage (optional)
- `gbrain files signed-url` -- generate access links (optional)
