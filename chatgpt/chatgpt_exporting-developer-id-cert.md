---
title: "Exporting Developer ID Cert"
type: note
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69ff7bd0-3560-83e8-9a1d-47bfdefe16b6
message_count: 4
tags: [chatgpt, import, code]
---
# Exporting Developer ID Cert

> Conversation ID: 69ff7bd0-3560-83e8-9a1d-47bfdefe16b6
> Created: 2026-05-09T18:24:23Z
> Updated: 2026-05-09T18:26:48Z
> Messages: 4

---

## User

What to do now

You’ve already got the CSR (/tmp/attachments/CertificateSigningRequest.certSigningRequest) — that means the private key is in this Mac’s Keychain, exactly where we need it. Two clicks left to get the cert:

developer.apple.com → Account → Certificates, Identifiers & Profiles → Certificates → ”+“
Direct link: https://developer.apple.com/account/resources/certificates/add

Pick “Developer ID Application” under the Production section. Continue.

Profile Type: G2 Sub-CA (Xcode 11.4.1 or later) — pick this, not “Previous Sub-CA”.
Click Choose File, upload /tmp/attachments/CertificateSigningRequest.certSigningRequest.
Continue → Download. Save the .cer (it’ll be named something like developerID_application.cer).
Double-click the downloaded .cer to install into your login keychain. Keychain Access opens; the cert will pair with your private key automatically.

In Keychain Access → login → My Certificates, you’ll now see “Developer ID Application: Jovie Inc. (G24T327LXT)” with a ▶ private key under it.

Right-click → Export “Developer ID Application…” → File Format Personal Information Exchange (.p12) → Save → set a password (this time it WILL prompt) → save somewhere like ~/Downloads/jovie-cert.p12.

Run on your Mac: Help me through the rest of this process. 

---

## Assistant

You are currently on the correct page: urlApple Developer Certificateshttps://developer.apple.com/account/resources/certificates/add

Do this exactly:

1. Under “Software,” select:
   “Developer ID Application”

2. Click “Continue”

3. On the next screen:
   - Leave:
     “G2 Sub-CA (Xcode 11.4.1 or later)”
   - Upload:
     `/tmp/attachments/CertificateSigningRequest.certSigningRequest`

4. Click:
   - Continue
   - Download

5. Open the downloaded `.cer` file.
   It should automatically install into:
   - Keychain Access
   - login keychain

6. Verify it paired correctly:
   - Open urlKeychain Access Support Pagehttps://support.apple.com/guide/keychain-access/welcome/mac
   - Left sidebar:
     `login`
   - Category:
     `My Certificates`

You should now see something like:

- “Developer ID Application: Jovie Inc. (G24T327LXT)”
- With a dropdown arrow showing a private key underneath

That private key pairing is critical.

7. Export the `.p12`
   - Right click the certificate
   - Export “Developer ID Application…”
   - Format:
     `Personal Information Exchange (.p12)`
   - Save as:
     `jovie-cert.p12`

8. It will ask for:
   - a password for the `.p12`
   - your Mac password

Use a strong password and save it somewhere safe.

9. Then run:

```bash
base64 < ~/Downloads/jovie-cert.p12 | pbcopy
```

That copies the certificate to clipboard for GitHub Actions / Electron signing secrets.

Then generate an app-specific password:

urlApple ID App-Specific Passwordshttps://appleid.apple.com/account/manage

- Sign-In and Security
- App-Specific Passwords
- Generate password
- Label:
  `Jovie Electron`

After that, you’ll have:
- `.p12`
- `.p12 password`
- Apple app-specific password

Which are the final pieces needed for Electron/macOS notarization.

---

## User

fill it for me

---

## Assistant

Mr. White, I’ve already selected “Developer ID Application” and chosen “G2 Sub-CA (Xcode 11.4.1 or later)” on the Apple Developer certificate creation page: urlApple Developer Certificates Addhttps://developer.apple.com/account/resources/certificates/add

I can’t upload the CSR file for you from here. Please click “Choose File,” select  
`/tmp/attachments/CertificateSigningRequest.certSigningRequest`, and tell me once it’s uploaded so I can continue with the “Continue → Download” steps.


## See Also
- [[chatgpt/chatgpt_exporting-sonarcloud-issues]]
- [[chatgpt/chatgpt_exporting-toast-employee-data]]
- [[chatgpt/chatgpt_20-vs-30-developer]]
- [[chatgpt/chatgpt_apple-developer-assistance]]
- [[chatgpt/chatgpt_apple-developer-overview]]
