---
title: "SIRP login issue fix"
type: guide
created: 2025-11-23
updated: 2025-11-23
source: chatgpt-export
conversation_id: 69234069-af20-8326-bd08-855df424057b
message_count: 4
tags: [chatgpt, import, code]
---
# SIRP login issue fix

> Conversation ID: 69234069-af20-8326-bd08-855df424057b
> Created: 2025-11-23T17:12:11Z
> Updated: 2025-11-23T17:31:51Z
> Messages: 4

---

## User

Starting SIRP Apple ID login
Received SIRP signin init response: {"iteration"=>20101, "salt"=>"LTXq1Vtrko/xI8gKG2w7fw==", "protocol"=>"s2k", "b"=>"Rnql1yR0SpG3YEtYk1gN5a3TEvyiAajTkTSgmdg2iBRpaq7FBuGFaJ2HozxDUKmPjC80pwSPyg6HNiVNhvXCr6obI9YIigGOLauGL98y7SZFZVWdzb3+GwNF38I43xgMZ6QoswxQHGT8tbdBPgaOXXbvQlPOqm5Oj8uGbiDT7G6Y8Ejnhs6ekk65gLRjzAe6bi6x7YPNXGsUJbY1scpP9ZgXvS0eY+nOCcbPAPSxR8ikeig6IY46DErnd8YYd6cux1O58mnYhan96E0gU1D1kGOhFUKJq50R+MzoNzzHWXudlu8FyswSM1VC3l5DcIDg4uhBuYAC360lF2MJTZ9uhA==", "c"=>"d-643-7bf6b6d6-c88f-11f0-b4cb-ad929cf9879c:NC"}
The login credentials for 't@timwhite.co' seem to be wrong
Do you want to re-enter your password? (y/n)

---

## Assistant

Mr. White, that prompt is almost certainly **not** telling you your password is wrong. It’s the client’s SRP/SIRP flow failing because Apple changed the IDMS SRP endpoints/fields, which makes older fastlane/spaceship/fastlane-sirp clients misread the response and throw `-20101`. Apple’s current flow uses `/auth/signin/complete` with extra SRP fields (`m1`, `c`, `m2`), so older implementations break. citeturn4view0turn3search9  

**What to do right now:**  
- Answer **`n`** to avoid repeated retries (people are getting accounts locked by looping this). citeturn3search1  

**Fix options (pick the one that matches your setup):**

1. **Update your tooling first.**  
   If this is fastlane/spaceship/fastlane-sirp, upgrade to the newest fastlane (and gems) and retry. Apple SRP changes regularly, and updating has been the main fix. citeturn0search4turn3search4  

2. **Prefer App Store Connect API key instead of Apple ID SRP.**  
   Wherever possible (deliver/pilot/upload_to_testflight, etc.), switch to `app_store_connect_api_key` / JWT auth. It avoids SRP + 2FA entirely and is now the recommended path. citeturn3search14  

3. **If you must use Apple ID with 2FA (common on CI):**  
   - Run locally: `fastlane spaceauth -u t@timwhite.co`  
   - Copy the session it prints and set it on CI as `FASTLANE_SESSION`.  
   This is the supported workaround when username/password SRP is flaky. citeturn0search17turn3search7turn3search18  

4. **If the failure happens during Transporter uploads:**  
   Generate an **app-specific password** on appleid.apple.com and set `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD`. Apple requires this when 2FA is on. citeturn0search8turn0search12  

5. **Clear bad cached creds/env vars.**  
   - `unset FASTLANE_SESSION` and/or `unset FASTLANE_PASSWORD` if set. A stale value can force the “wrong password” loop. citeturn3search2turn3search19  
   - If you ever stored old fastlane creds in Keychain, delete the “fastlane” entries and retry. citeturn3search15  
   - If you pass the password via env var/script, make sure shell quoting isn’t mangling special characters. citeturn3search10  

If you tell me what tool/command you’re running (fastlane lane name, AltStore-like signer, custom script, etc.), I can map you to the exact best fix—but the safest immediate move is **stop retrying**, update, and switch to API key or a `FASTLANE_SESSION` flow.

---

## User

-----------------------------
[09:31:07]: --- Step: update_fastlane ---
[09:31:07]: -----------------------------
[09:31:07]: Looking for updates for fastlane...
[09:31:07]: It seems that your Gem directory is not writable by your current user.
[09:31:07]: fastlane would need sudo rights to update itself, however, running 'sudo fastlane' is not recommended.
[09:31:07]: If you still want to use this action, please read the documentation on how to set this up:
[09:31:07]: https://docs.fastlane.tools/actions/update_fastlane/

---

## Assistant

Mr. White, that error just means fastlane can’t self-update because it was installed into a system Ruby/gem path you don’t own. Don’t use `sudo fastlane`. Use one of these clean fixes:

**Best practice (project-local fastlane via Bundler):**
1. In your project folder:
   ```bash
   bundle init   # if you don't already have a Gemfile
   ```
2. Edit `Gemfile` and add:
   ```ruby
   gem "fastlane"
   ```
3. Install and run fastlane through bundler:
   ```bash
   bundle install
   bundle exec fastlane your_lane
   ```
4. Remove/ignore `update_fastlane` in the lane — updating happens via `bundle update fastlane`.

**If you want global fastlane without sudo:**

**Option A — User install gems:**
```bash
gem install fastlane --user-install
```
Then ensure your PATH includes user gems (add to `~/.zshrc` or `~/.bashrc`):
```bash
export PATH="$HOME/.gem/ruby/$(ruby -e 'print RUBY_VERSION')/bin:$PATH"
```
Restart shell and:
```bash
fastlane --version
```

**Option B — Homebrew (macOS):**
```bash
brew install fastlane
brew upgrade fastlane   # to update later
```

**Option C — Fix Ruby via rbenv/asdf (keeps gems writable):**
```bash
brew install rbenv
rbenv install 3.2.2    # or latest stable
rbenv global 3.2.2
gem install fastlane
```

**What I’d do in your case:**  
Use **Bundler** if this is for a repo/CI (most reliable), otherwise **brew install fastlane** for a painless global setup.

Once fastlane is updated, retry your login, and if SRP still acts up, switch to API key or `FASTLANE_SESSION` like I mentioned earlier.
