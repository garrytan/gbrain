---
conversation_id: 6923409f-2d0c-8333-b21b-34298c5f8b4b
created: 2025-11-23
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Fastlane match dev setup
type: note
updated: 2025-11-23
---

# Fastlane match dev setup

> Conversation ID: 6923409f-2d0c-8333-b21b-34298c5f8b4b
> Created: 2025-11-23T17:13:04Z
> Updated: 2025-11-23T17:14:22Z
> Messages: 2

---

## User

fastlane match dev credentials

---

## Assistant

Here’s a concise guide for using entity["software", "fastlane match", 0] for “development” credentials — i.e., the *development* type of certificate + provisioning profile — in an iOS project.  
If you meant a different context (e.g., *adhoc*, *appstore*, enterprise), let me know and I can adjust.

---

### What it does  
- `match` centralizes your iOS/macOS code-signing identities (certificates + private keys + provisioning profiles) and syncs them for the team. citeturn0search0turn0search7turn0search4  
- For development builds, running:  
```bash
fastlane match development
```  
will **generate** (if needed) and **install** the development certificate + profile, and store them in the configured remote store (Git, S3, GCS). citeturn0search0turn0search8  
- On CI / other machines you may run:  
```bash
fastlane match development --readonly
```  
so you don’t create new certs, just pull existing ones. citeturn0search1turn0search0

---

### Setup Summary (for “dev credentials”)  
1. Choose a storage backend (private Git repo, S3 bucket, GCS bucket). citeturn0search0turn0search4  
2. Run:  
   ```bash
   fastlane match init
   ```  
   Choose storage, set up `Matchfile`. citeturn0search0  
3. Configure environment variables (or in `Matchfile`) such as:  
   - `MATCH_PASSWORD` — the passphrase to decrypt the encrypted store. citeturn0search8  
   - `MATCH_USERNAME` — the Apple Developer account email used to create/manage certs. citeturn0search8  
   - (If using Git storage with basic auth) `MATCH_GIT_BASIC_AUTHORIZATION`. citeturn0search4turn0search5  
4. In your `Fastfile`, add a lane for development signing:  
   ```ruby
   lane :development do
     match(type: "development", app_identifier: "com.mycompany.myapp")
     gym(scheme: "MyApp-Dev", export_method: "development")
   end
   ```  
   citeturn0search8turn0search0  
5. On a new machine or CI:  
   ```bash
   fastlane match development --readonly
   ```  
   This will pull/install the existing cert/profile. citeturn0search1turn0search0  

---

### Important Notes / Best Practices  
- Ensure your Apple Developer account has 2-factor authentication (2FA). citeturn0search2  
- Keep your `MATCH_PASSWORD` safe — if lost you may need to regenerate certificates/profiles. citeturn0search9  
- For CI builds you often want the `--readonly` mode so no one “accidentally” creates/revokes certificates. citeturn0search1turn0search0  
- If you already have many certificates/profiles, consider revoking them and starting fresh when switching to `match`. citeturn0search7  

---

If you like, Mr. White, I can **walk you through** setting this up for your exact project (with the repo, env-vars, Fastfile changes), or help you troubleshoot any specific error you’re seeing.
