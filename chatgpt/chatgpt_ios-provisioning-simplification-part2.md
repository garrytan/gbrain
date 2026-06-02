
Mr. White, here’s a quick spot-check of the latest CI revision.

### 1&nbsp;— Coverage & security gaps  
| Item | Status | Fix |
|------|--------|-----|
| **Swift static-analysis** | Still excluded from the CodeQL matrix – only JS/TS, Python, Ruby are scanned fileciteturn25file0L28-L33 | Add a `- language: swift` entry (build-mode `autobuild`) so Xcode code is covered and the `runs-on: macos-*` branch is exercised. |
| **Secrets in ASC key** | You still write the full App Store Connect JSON to disk in several jobs. Anyone with artifact access could read it. | Switch to GitHub’s OIDC-based App Store Connect authentication (now in public beta) or at least write the key to `$RUNNER_TEMP` and shred it in a `post` step. |
| **Artifact storage quota** | Every failure uploads **xcresult**, **coverage.json**, etc. with 7- or 30-day retention. Public repos get 2 GB free artifact storage. Heavy iOS suites can blow that up fast. | Keep successes but set `retention-days: 2` (or delete on success) and compress *.xcresult* to `.zip` ~75 % smaller. |

### 2 — Redundant work on macOS runners  
`ios-confidence-loop.yml` still re-creates placeholder *.xcconfig* files, installs Homebrew and Bundler **in every job** fileciteturn25file10L37-L44 / fileciteturn25file11L70-L76. That means:

* 4–5 extra minutes per job
* multiple downloads of the same Homebrew bottles

**Quick win**

* Put the _config-file creation_ & _brew/bundle install_ into the `setup-ios-build` composite that you already call in *Rapid*/*PR Verify*.  
* In the other iOS jobs just `uses: ./.github/actions/setup-ios-build` and skip the manual blocks.

### 3 — GitHub Actions cost & limits for a **public** repo

| Resource | Limit on Free plan | Your current usage |
|----------|-------------------|--------------------|
| **Minutes** | Unlimited for public repos (Linux + Windows + macOS) | OK – no cost risk. |
| **Concurrent jobs** | 60 Linux / 60 macOS / 5 self-hosted per repo | Peak dev push kicks off **lint + build + tests (3 macOS)**; confidence loop adds 5 more. You’re well under 60. |
| **Artifact storage** | 2 GB total, 90-day retention | Potential risk (see §1). |
| **Cache storage** | 10 GB total | Current macOS caches (DerivedData, vendor/bundle) are fine; just monitor. |

So you won’t get a surprise bill, but you *can* hit the storage cap and start seeing cache evictions / failed uploads.

### 4 — Speed tweaks (optional)

* **Reuse the build**: In *Confidence* jobs, restore the derived data/artifacts cached by *Rapid* to avoid a full rebuild.  
* **Playwright / browser cache** (web-confidence) – make sure `~/.cache/ms-playwright` is cached; I didn’t see it in the file.  
* **macOS queue**: keep `concurrency.cancel-in-progress: true` (already present) to avoid piling up outdated runs on busy days.

### 5 — Quality of life

* Bump the coverage threshold back to ≥ 60 % once tests stabilise (it’s currently 70 in the file – good).  
* Add a status badge for `main-orchestrator.yml` in your README so failures surface immediately.  
* Rename long workflow files to shorter verbs (`ios-release.yml`, etc.) – saves characters in `gh run list`.

---

**Bottom line**:  
The architecture is solid – three loops, branch-based promotion, and auto-merge all look good. Tighten up CodeQL (add Swift), factor out that duplicate iOS setup, and shorten artifact retention; you’ll stay on the free tier with headroom to spare.


Mr. White, here’s a quick punch-list after eyeballing the latest workflows.  Overall the three-loop layout is solid and should stay free on a public repo, but a few gaps remain.

| Area | What’s good | What still needs love |
|------|-------------|-----------------------|
| **CodeQL / security** | Scheduled + PR scanning wired up. | Swift isn’t in the `languages` matrix, so none of your iOS code is analysed — just add `'swift'` to the list【31:0†file-H9Wk…†L27-L34】. |
| **iOS PR workflow** | You introduced a reusable composite action (`mdevp/ios-build@v1`) – nice. | Two *different* files named **`ios-pr-verify.yml`** exist (one uses the composite, one has the old inline steps)【34:0†file-GMg…†L12-L22】【34:4†file-N8g…†L13-L20】.  Pick one and delete/rename the other or you’ll pay for double macOS minutes. |
| **Artifact retention / storage** | Most artifacts trimmed to 7 days. | SBOM upload in **`ios-release-loop.yml`** still keeps artifacts for 90 days (free, but clutters UI). Drop to 14 days if you really need history. |
| **Caching / speed** | `actions/cache` for Swift PM and `npm` is in place; Xcode index disabled; concurrency groups cancel stale runs. | Playwright browsers are re-downloaded every run【37:4†file-KaD7Z…†L31-L36】. Cache `~/.cache/ms-playwright` ~1 GB and you’ll shave ~20–30 s. |
| **Permissions** | Defaults to read-only; jobs that need write elevate just `contents: write`. | Double-check that any job which merely uploads artifacts (not pushing tags) can stay read-only. |
| **Minutes & concurrency** | Public repos get unlimited minutes; macOS runners limited to 20 concurrent.  Your `concurrency:` keys guard this. | If iOS workflows ever fan-out (matrix, nightly), add `concurrency.group: ${{ github.workflow }}` + `cancel-in-progress: true` everywhere to avoid queue pile-ups. |
| **Codecs / auto-merge bots** | Dependabot auto-merge job looks fine; uses `pull_request_target`. | To let Codecs (or other OpenAI bots) open PRs and have CI auto-merge: 1) give them the `contents: write` and `pull-requests: write` scopes on *only* that workflow, 2) add a label-based guard (`if: contains(github.event.pull_request.labels.*.name, 'automerge')`). |

### Zero-cost guard-rails

1. **Always set a hard timeout on macOS jobs** – you already use `timeout-minutes`, keep it ≤ 30 min.
2. **Use `brew bundle --file=...`** instead of individual `brew install` lines; caches are restored automatically by Homebrew on GitHub Actions.
3. **Matrix-fanout?** If you later add device-test splits (iPhone 15, iPad, etc.), wrap them in a manual `strategy: matrix` only on preview/nightly to keep dev pushes cheap.

### TL;DR

You’re 90 % there.  Add Swift to CodeQL, prune the legacy **ios-pr-verify** file, cache Playwright, and tighten a couple artefact/permission knobs.  After that you’ll have a lean, free-tier-compliant pipeline with minimal maintenance overhead.

Let me know if you want the exact YAML snippets for any of the above.


check this now. and also make sure there's nothing to prevent TestFlight from working like keys that are masked out but needed for TestFlight etc


Mr. White, here’s a tight review of the latest CI rev — with an eye on anything that could still break TestFlight and a couple of final polish items.

---

### 1  TestFlight prerequisites look solid

| Concern | Status | Notes |
|---------|--------|-------|
| **P12 + provisioning profile imported?** | ✅ | `import-codesign-certs@v5` pulls the P12; the profile is decoded, UUID-installed and validated in *every* TestFlight-bound job (rapid, confidence, release loops).【46:1†L51-L60】 |
| **API-key handed to Fastlane?** | ✅ but rename two vars | You already write `APP_STORE_CONNECT_API_KEY_PATH` to `$GITHUB_ENV` – that’s the only var Fastlane needs when the JSON file (or temp file) contains `key_id` and `issuer_id`. The extra lines that export<br>`APP_STORE_CONNECT_API_KEY_ID` / `_ISSUER_ID` use the *wrong* Fastlane names (they’re missing `_KEY_`). They’re harmless but noisy – drop or rename to `APP_STORE_CONNECT_API_KEY_KEY_ID` / `_ISSUER_ID` if you want them picked up.【46:1†L57-L64】 |
| **Secrets accidentally masked out?** | ✅ | The secret *values* are never echoed. Only the non-secret path and a couple of IDs go to `$GITHUB_ENV`; the script uses `::add-mask::` for anything that could leak from the profile. |
| **Code-signing during the actual upload?** | ✅ | The lanes (`upload_testflight`, `build_release`) run after cert/profile import and they inherit the key-path env var from the previous step.【46:13†L68-L74】 |

Bottom line: nothing here should prevent TestFlight uploads.

---

### 2  Small gaps worth fixing

| Area | Why it matters | Quick fix |
|------|---------------|-----------|
| **Swift missing in CodeQL matrix** | Your iOS code is never scanned for vulns. | Add a matrix entry: <br>`- language: swift`<br>`  build-mode: manual` (if you want to keep the fast build-less scan) in `codeql-analysis.yml` just after the JS/Python/Ruby rows.【45:0†L25-L33】 |
| **Playwright cache (web-confidence)** | Each run re-downloads browsers – a 2–3 min hit. | Add:<br>`- uses: microsoft/playwright-github-action@v1`<br>`  with: cache: true` before tests. |
| **Duplicate `ios-pr-verify.yml`** | Looks resolved – only one copy remains. 👍 |
| **Mask the key-ID / issuer-ID** | They’re not strictly secret, but Apple treats them as credentials. | Add `::add-mask::${var}` right after you echo them to `$GITHUB_ENV`. |
| **Artifact bloat** | Test bundles & SBOMs keep 14–30 days. OK for now, but watch the repo’s 2 GB artifact quota. |

---

### 3  Speed / quota check for a *free* public repo

* **Minutes** – Public repos still get unlimited runners, including macOS.  
* **Concurrency** – Jobs run one-at-a-time per workflow unless you raise the limit; `concurrency:` blocks duplicate runs so you’re safe.  
* **Storage** – Artifacts + logs share a 2 GB cap. The iOS `.xcresult` bundles are the big ones; the nightly confidence loop uploads three of them. Consider zipping and trimming to 14 days like you did for SBOMs.

---

### 4  Recommended tiny edits

```yaml
# codeql-analysis.yml

**Related:** [[coding_mobile]]
strategy:
  matrix:
    include:
      - language: javascript-typescript
        build-mode: none
      - language: python
        build-mode: none
      - language: ruby
        build-mode: none
      - language: swift          # NEW
        build-mode: none         # or manual
```

```bash
# ios-rapid-loop.yml – mask IDs
echo "::add-mask::$(echo '${{ secrets.ASC_API_KEY_JSON }}' | jq -r '.key_id')"
echo "::add-mask::$(echo '${{ secrets.ASC_API_KEY_JSON }}' | jq -r '.issuer_id')"
```

Everything else looks production-ready. Ship it. 🚀


Give me a concise list of changes to make


**CodeQL workflow tweaks**

1. **Add Swift to the matrix**

```yaml
- language: swift
  build-mode: none        # or manual if autobuild fails
```

2. **Remove the unused C++ block** (the entire commented-out C-CPP section plus its conditional build step).

3. **Simplify `runs-on` logic** (after adding Swift):

```yaml
runs-on: ${{ matrix.language == 'swift' && 'macos-latest' || 'ubuntu-latest' }}
```
 already matches—just confirm it stays.

4. **Trim the C++ manual-build step** if you drop C++ (step starting with `- if: matrix.language == 'c-cpp'`).

These four changes complete Swift coverage and clean out dead C++ scaffolding without impacting other languages.


hows this for cihow we doing now


**CI checklist — what’s still left**

| Area | Fix | Why it matters |
|------|-----|----------------|
| **Static analysis** | ▸ Add Swift to CodeQL matrix<br>`- language: swift  build-mode: none`<br>▸ Delete the now-dead C++ manual-build step | iOS code still isn’t scanned, and the C++ block is orphaned. |
| **Fastlane API-key vars** | Rename the issuer var everywhere:<br>`APP_STORE_CONNECT_API_ISSUER_ID` ( no “_KEY_” ) | Fastlane looks for `…_ISSUER_ID`, so uploads will fail on TestFlight/App Store. |
| **Confidence-loop build** | Replace the inline *Create Config Files* block with the `setup-ios-build` composite (already used in other jobs) | Removes 20 duplicated lines and one extra minute per nightly run. |
| **Playwright cache (web confidence loop)** | Cache `~/.cache/ms-playwright` keyed on `package-lock.json` | Saves ~30 s and keeps artifacts < 500 MB (free tier limit). |
| **Artifacts** | Set `retention-days: 14` on SBOM & iOS build uploads (now 30) | Avoid creeping past GitHub’s 2 GB free storage cap. |

Everything else — signing cert import, provisioning-profile install, ASC key file, secrets masking, concurrency limits — looks good. Fix the two env-var names and add Swift to CodeQL and you’re green for zero-cost TestFlight uploads.


are we taking full advantage of fastlane? Are we doing anything that causes code duplication that we can avoid? Anything else?


### Fastlane-specific opportunities

| Current pattern | Faster / cleaner with Fastlane | Why it helps |
|-----------------|--------------------------------|-------------|
| **Manual `xcodebuild` blocks** for build & test (Rapid, Confidence, Release) | Call lanes that wrap **`gym`** (archive/export) and **`scan`** (unit/UI tests). One lane can accept parameters (`scheme`, `configuration`, `export_method`) so every workflow re-uses it. | • Removes ~40 lines per job<br>• Gets automatic log collating & JUnit output<br>• One place to tweak build flags. |
| **Shell script** installs provisioning profile + parses UUID | Switch to **`match`** (or `app-store-connect-api` + `build_app` if you prefer 💯 API-key flow). | • Zero custom PlistBuddy logic<br>• Cert/profile rotation handled for you. |
| **`plistbuddy` version bump** & timestamp math in each job | Use **`increment_build_number`** and **`increment_version_number`** actions in the shared lane. | Less brittle; build numbers stay in Xcode project so local builds match CI. |
| **Custom `jq` + temp-file** for ASC API key | Fastlane accepts a single env var:<br>`APP_STORE_CONNECT_API_KEY_PATH`.  Delete the extra `…_KEY_ID / …_ISSUER_ID` exports. | Fewer secrets in env; one source of truth. |
| **Separate `bundler install` blocks** in every job | Add a tiny **composite action** (`setup-ruby-fastlane`) that: `gem install bundler && bundle install` and caches `vendor/bundle`. | Cuts ~10 lines × 5 workflows and guarantees gem version parity. |

---

### Code-duplication still lurking

| Duplicate chunk | Where it repeats | Consolidation idea |
|-----------------|-----------------|--------------------|
| Placeholder `.xcconfig` creation | `ios-rapid-loop`, `confidence build`, `performance`, `release build`, etc. | Move into the **`setup-ios-build`** composite action (you already use it in PR/Rapid). Pass a flag `create-config: true` to toggle. |
| Manual provisioning-profile validation _every_ deploy job | Alpha, Beta, Release workflows | One **`validate_profile`** lane in Fastfile or a dedicated composite GitHub Action invoked by each job. |
| Ruby/Bundler install | Alpha, Release, TestFlight, Precheck | Let the shared ruby-setup composite handle it; cache key re-used. |
| `brew install swiftlint / xcbeautify` fallback logic | Confidence (lint, build), PR verify | Include both tools in a **homebrew-cache** composite or pre-add to runner via `setup-ios-build` option; rely on cache to avoid installs. |

---

### Extra polish & speed

1. **Cache Playwright browsers** (web confidence loop):  
   ```yaml
   - uses: actions/cache@v4
     with:
       path: ~/.cache/ms-playwright
       key: ${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}
   ```
   Saves ~30 s per run.

2. **Add Swift to CodeQL matrix** – your iOS code still isn’t scanned.

3. **Drop commented C++ block** in `codeql-analysis.yml` to keep the file lean.

4. **Artifact retention**: bring SBOM and iOS build uploads down to **14 days** to stay well under the 2 GB free cap.

5. **Concurrency guards**: keep `concurrency.cancel-in-progress: true` in every macOS job to avoid eating the 5-runner ceiling.

Implementing the Fastlane lanes + shared composites removes ~150 duplicated lines across the workflows and gives you one canonical place (the **Fastfile**) to tweak build flags, signing, versioning, and upload behavior.


check the updated version


### High-impact cleanup

| What to change | Why | Where |
|---|---|---|
| **Kill the orphaned C++ build step** in CodeQL | you no longer scan C++; the block just builds iOS twice | `codeql-analysis.yml` L55-77fileciteturn50file3L55-L77 |
| **Fix Fastlane ASC env names** – use `APP_STORE_CONNECT_API_KEY_ID` **and** `APP_STORE_CONNECT_API_ISSUER_ID` (no “_KEY_” prefix on the second var) | Fastlane ignores `…_KEY_ISSUER_ID`, so TestFlight auth falls back to 2-FA | `ios-rapid-loop.yml` L57-59fileciteturn50file10L57-L59 |
| **Remove duplicate “Create Config Files” blocks** from the Confidence loop (`build` job) – the composite already did this | same placeholder files are written **three** times per run | `ios-confidence-loop.yml` L41-49 & L59-69fileciteturn50file11L41-L49 fileciteturn50file13L58-L69 |
| **Drop manual `xcodebuild build-for-testing`** in Confidence loop and call the Fastlane `build` lane once | you’re building the app twice (Fastlane and xcodebuild) | manual build lines L61-69 in same filefileciteturn50file11L61-L69 |
| **Consolidate placeholder-config creation into `setup-ios-build`** by adding a `create-config-files: true` flag everywhere and deleting the inline Bash in Rapid/Confidence/Release loops | removes ~80 repeated lines, one source of truth | e.g. Rapid loop lines 66-77fileciteturn50file10L66-L77 |

### Nice-to-haves

1. **Playwright cache still missing** – add a cache for `~/.cache/ms-playwright` to shave ~30 s per web confidence run.  
2. **Fastlane lanes for test/snapshot/sanitizer**: wrap UI, snapshot, and sanitizer runs in lanes (`scan`, `snapshot`, `test_sanitizers`) so each job is a single `bundle exec fastlane …` call.  
3. **Provision-profile install** appears verbatim in Rapid, Confidence and Release. Move it to a reusable composite or let `fastlane match` handle profiles entirely.

These tweaks eliminate dead code, cut a few minutes off nightly runs, and make Fastlane the single place to change build/signing logic—while keeping TestFlight uploads working.


Check new


Check new


**CI status after the latest push**

✅ **Fixed**

- Swift added to CodeQL matrix and composite bootstrap used in every iOS job.  
- Placeholder-config creation is now delegated to `setup-ios-build` (duplication cut).  
- C++ scaffold removed.

---

### Still worth tightening

| Area | What to change | Why |
|------|----------------|-----|
| **Fastlane ASC env vars** | In *deploy-alpha* (Rapid) you export<br>`APP_STORE_CONNECT_API_KEY_ISSUER_ID` → rename to **`APP_STORE_CONNECT_API_ISSUER_ID`** (no “KEY_” prefix). Same in any other step that sets the issuer. | Fastlane ignores the wrong name, falling back to 2-FA. |
| **Provision-profile shell block** | The 70-line `Download Provisioning Profile` script appears in Rapid, Release (build-release), and Release (deploy-testflight/*.app-store*). Move it into a composite action or let `fastlane match appstore` handle cert+profile. | Removes ~200 lines and yearly renewal becomes one command. |
| **Confidence loop: double build** | `build` job runs `fastlane build …` **and** later jobs restore `build` cache → fine. But *test-sanitizers / snapshot / performance* still call raw `xcodebuild` with their own flags. Wrap these in dedicated Fastlane lanes (`sanitizers`, `snapshots`, `perf`) to share log parsing and retry logic. | Consistent output & easier flag tweaks. |
| **Playwright cache** (web confidence) | `~/.cache/ms-playwright` still redownloads each run. Add an `actions/cache` step keyed on `package-lock.json`. | Saves 20-30 s per run, keeps artifacts smaller. |
| **ASC key handling** | In Rapid you set both `…KEY_ID`/`…ISSUER_ID` **and** write a temp `.p8`. In Confidence/Release you only set the JSON file path. Standardise on **“write JSON to tmp – set PATH”** (Fastlane picks up `KEY_ID/ISSUER_ID` from the file). | One pattern, fewer secrets in env. |
| **Artifact retention** | Large xcresult uploads in confidence loop still keep **7 days**; SBOM 14 days. If you bump up nightly test volume, drop to 3 days or zip results to stay below the free 2 GB storage cap. |
| **Mac concurrency guard** | All mac jobs have `cancel-in-progress`, good. If nightly fan-out ever exceeds 5 runners, set `max-parallel: 3` on the sanitizer/snapshot/perf matrix to avoid the public-repo limit. |

No blockers left for TestFlight or App Store; fix the ASC issuer-ID env name and you’re functionally done. Everything else is polish to cut minutes and future maintenance.


### Quick hits on the **new** CI rev

| ✅  Looks good | ⚠️  Still to tighten |
|---|---|
| **Swift now in CodeQL** — static analysis finally covers iOS. | **Issuer-ID env var** has the wrong name in *Rapid* / *Release* loops.<br>`APP_STORE_CONNECT_API_KEY_ISSUER_ID` → **`APP_STORE_CONNECT_API_ISSUER_ID`** (drop “KEY_”). |
| Orphaned C++ step gone. | *Release Loop* still re-creates `.xcconfig` files by hand; just call `setup-ios-build` (`create-config-files:true`) like other jobs to kill 20 lines. |
| Confidence build now uses the Fastlane `build` lane — nice. | **Provision-profile install + validation** block duplicated in Rapid, Confidence, Release. Wrap it in a small composite (`install-profile`) or lean fully on `fastlane match` to DRY it out. |
| Placeholder-config creation removed from most jobs. | Add a **Playwright cache** to `web-confidence` (`~/.cache/ms-playwright`) — saves ~30 s and keeps artifacts <500 MB. |
| CodeQL step conditionally calls `setup-ios-build` only for Swift — clean. | *Confidence* heavy jobs (sanitizer / snapshot / perf) still copy the `.xcconfig` placeholders; set `create-config-files:false` because build artifacts already contain them. |

#### Tiny polish

1. **Bundler install** logic exists in three different workflows; fold into a `setup-ruby-fastlane` composite.
2. **SBOM artifact**: retention is 14 days ✅, but nightly test bundles are still 7 days × many MB — watch the 2 GB artifact cap.

Fix the issuer-ID env var and swap the manual config/profile chunks for the composite and you’ll have a DRY, fast, zero-cost pipeline.


**What’s still left to tighten**

| Fix | Why | Where to change |
|-----|-----|----------------|
| **Rename the issuer-ID env var**<br>`APP_STORE_CONNECT_API_KEY_ISSUER_ID` → **`APP_STORE_CONNECT_API_ISSUER_ID`** | Fastlane only recognises `…_ISSUER_ID`; the current name is ignored, so uploads fall back to 2-FA | Rapid loop – Setup ASC key step【turn52file4†L120-L126】 and anywhere else you export it |
| **Stop re-pasting the 70-line provisioning-profile script** – move it into a small composite (e.g. `.github/actions/install-profile`) or, better, just call `fastlane match appstore` | Same block lives in Rapid, Release-build and Release-deploy jobs; one edit per year instead of three | Example duplicate: Release loop build job【turn52file5†L42-L90】 |
| **Cache Playwright browsers** in the web confidence loop | Saves ~30 s and keeps artifacts under the 2 GB free tier cap | Add an `actions/cache` step for `~/.cache/ms-playwright` in `web-confidence-loop.yml` |
| **Remove the now-dead “Create config files” inline Bash** in Release loop (you already generate them via `setup-ios-build` elsewhere) | Cuts ~15 lines & one redundant disk write | Release loop build job【turn52file5†L102-L112】 |
| **Wrap sanitizer / snapshot / perf runs in Fastlane lanes** instead of raw `bundle exec fastlane test …` blocks | Consistent log parsing & a single place to adjust flags | Confidence loop jobs `test-sanitizers`, `snapshot-tests`, `performance-tests`【turn52file2†L138-L190】【turn52file2†L211-L257】【turn52file2†L278-L326】 |
| **Artifact retention** – xcresults in confidence loop keep 3 days (good) but SBOM upload still 3 days; nightlies + perf runs might push you over 2 GB. Monitor `Actions → Storage` and drop to 2 days if needed. | stay in free storage quota | `security-scan.yml` SBOM step |

Everything else—Swift now scanned by CodeQL, composite bootstrap reused, concurrency guards in place—looks solid. Fix the issuer-ID name and you should have fully hands-off TestFlight/App Store uploads with no duplicated signing code and zero-cost GitHub Actions.


**Last-mile tweaks**

| Area | Action | File / line |
|------|--------|-------------|
| **Fastlane ASC vars** | Change `APP_STORE_CONNECT_API_KEY_ISSUER_ID` → **`APP_STORE_CONNECT_API_ISSUER_ID`** (no “KEY_”). | `ios-rapid-loop.yml` L120-126 fileciteturn53file4L120-L126 |
| **Provision-profile shell block**  (≈70 lines, repeated 3×) | Move into a tiny composite action or call `fastlane match appstore` instead. | Rapid `deploy-alpha`, Release `build-release`, Release `deploy-testflight` fileciteturn53file4 fileciteturn53file5 |
| **Inline “Create config files”** | Already handled by `setup-ios-build`; delete this duplicate block. | `ios-release-loop.yml` L108-116 fileciteturn53file5L108-L116 |
| **Playwright browser cache** | Add an `actions/cache` step for `~/.cache/ms-playwright` in `web-confidence-loop.yml`. | (still missing) |
| **PR Verify build** | Optional: wrap the raw `xcodebuild` commands in a Fastlane lane (`pr_verify`) for consistent logs & retries. | `ios-pr-verify.yml` L30-64 fileciteturn53file3L30-L64 |
| **Artifact storage** | SBOM + xcresult retention = 3 days — good. Monitor Action storage; lower if >1 GB. | — |

Fix the issuer-ID env name and you’ll unblock Fastlane’s API-key auth. The remaining refactors just cut copy-pasta and a few minutes of runtime; functionality is otherwise solid.


**Topic:** [[chatgpt-clusters/coding_mobile]]
