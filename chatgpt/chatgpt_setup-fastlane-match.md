---
title: "Setup Fastlane match"
type: note
created: 2025-07-23
updated: 2025-07-23
source: chatgpt-export
conversation_id: 6880345b-eb5c-8327-a969-ccc98e7de13d
message_count: 2
tags: [chatgpt, import, code]
---
# Setup Fastlane match

> Conversation ID: 6880345b-eb5c-8327-a969-ccc98e7de13d
> Created: 2025-07-23T01:01:16Z
> Updated: 2025-07-23T02:05:02Z
> Messages: 2

---

## User

et up fastlane match to handle our git repo for certificates is https://github.com/itstimwhite/certificates.git
our project is https://github.com/itstimwhite/LogYourBody
were using github actions for ci
our apple id is t@timwhite.co
please set up fastlane match correctly to talk to the app store so we can upload and distrubte our app to testflight and the app store

---

## Assistant

Mr. White,

Below is a patch that configures Fastlane **match** to use your private certificates repository and cleans up the GitHub Actions workflows to rely on match instead of manually importing certificates and provisioning profiles.  The patch also corrects the hard‑coded bundle identifier in the Fastlane lane and switches the default branch from `master` to `main`.  Please review the patch and let me know if you’d like me to apply it.

### What this patch does
- **Matchfile** – points `git_url` to your certificates repo (`https://github.com/itstimwhite/certificates.git`), sets `type` to `appstore` and defaults the `username` to your Apple ID (still overridable via the `APPLE_ID_EMAIL` environment variable).
- **Fastfile** – in the `setup_provisioning` lane, uses `ENV["APP_IDENTIFIER"] || "com.logyourbody.app"` for the app identifier and defaults `MATCH_GIT_BRANCH` to `main`.
- **GitHub workflows** (`ios-rapid-loop.yml` and `ios-release-loop.yml`) – removes the `apple-actions/import-codesign-certs` step and configures match.  Match‑specific environment variables are passed (`MATCH_GIT_URL`, `MATCH_GIT_BRANCH`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD`, `APP_IDENTIFIER`, `APPLE_ID_EMAIL`, etc.) so that provisioning is handled via the certificates repo.

You can download the patch file here: {{file:file-ESEJ7syTAWXjgA9chTmdLk}}.

### After applying the patch
1. **Add GitHub Secrets**:  
   - `MATCH_GIT_BASIC_AUTHORIZATION` – base64‑encoded `username:personal_access_token` for an account with write access to the certificates repo【851069966787138†L850-L935】.  
   - `MATCH_PASSWORD` – any passphrase of your choice; it encrypts the certificates in the repo【391460321507521†L250-L352】.  
   - `APPLE_ID_EMAIL` – `t@timwhite.co`.  
   - `APP_IDENTIFIER` – `com.logyourbody.app`.  
   - `MATCH_GIT_BRANCH` (optional) – set to `main` if your certificates repo uses a different branch name.  
   - Keep existing `ASC_API_KEY_JSON`/App Store Connect API secrets.

2. **Generate initial certificates**: run on your machine or via CI:
   ```sh
   cd apps/ios
   bundle install
   bundle exec fastlane setup_distribution
   ```
   This will prompt you for the Apple ID password (or use an app‑specific password) and push the encrypted certificates and provisioning profiles into the `certificates` repo.

3. **Remove old secrets**: Once match is working, you can remove `IOS_P12_BASE64`, `IOS_P12_PASSWORD`, and `IOS_PROVISIONING_PROFILE_BASE64` from the repository’s secrets.  The workflows will now fetch signing assets from the certificates repo.

4. **Push and run**: Commit the patch to your `dev` branch.  The next run of the workflows will use match to handle code signing and upload to TestFlight or the App Store accordingly.

Let me know if you want me to apply this patch or assist further.
