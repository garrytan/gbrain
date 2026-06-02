
Here’s a consolidated backlog for you, Mr. White, merged from **all** the stuff we’ve talked about, plus the new screenshot notes — and sorted by priority for MVP.

I’ll use rough buckets:

- **P0 = Blocker for MVP / trust**
- **P1 = Core MVP polish / must-feel-solid**
- **P2 = Nice-to-have for launch / early v1.x**
- **P3+ = Later / growth & monetization**

---

## P0 – Blockers for MVP

### 1. Account lifecycle & onboarding state

- Fix **new-account onboarding not showing**:
  - Onboarding completion must be keyed to **userId**, not device.
  - New user (or different user) on same device must see onboarding again.
- Fix **“delete account” / log-out** behavior:
  - Delete/log-out must:
    - Clear all per-user local data (metrics, cached HealthKit imports, flags).
    - Stop HealthKit observers/queries for that user.
- **Paywall order**:
  - Flow should be:  
    **Onboarding → body score → account creation → paywall → app**,  
    not paywall-before-onboarding.

### 2. HealthKit isolation & data integrity

- Make sure HealthKit imports are strictly **per user**:
  - No cross-account bleed (what you saw when deleting/recreating).
  - On log-in, only show data linked to that user’s account.
- Mirror HealthKit samples with proper source info (HKDevice / sourceRevision) in your raw table/model (we already specced this earlier).

### 3. Chart correctness & axis behavior

- Fix **Y-axis scaling and labels**:
  - Dynamic min/max and sensible tick spacing per metric & time range.
  - No cramped/overlapping values or weird intervals.
- Make sure time range changes (`1W / 1M / 3M / 6M / 1Y / All`) correctly recompute:
  - Visible data,
  - Axis range,
  - Smoothing/trend.

### 4. Entry editing & deletion (data trust)

- Implement **swipe actions** on entries (what you described):
  - Swipe → **Delete**.
  - Swipe → **Edit**.
- Semantics:
  - **Manual entries**: full edit & delete allowed.
  - **HealthKit entries**: treat as **read-only from source**:
    - Offer:
      - **Hide/Ignore in Log Your Body** (we simply stop using it in our calculations & UI).
      - **Override** → create a manual entry at that timestamp; our app uses manual entry instead of that HealthKit sample.
- Rule for **same-day manual + HealthKit**:
  - For calculations and charts, **manual overrides HealthKit** for that metric/timestamp.
  - In the list UI, show both or show only the “effective” value (your choice), but logic underneath must be clear.

---

## P1 – Core MVP polish (should ship with v1)

### 5. Metric history list UX (screenshot screen)

- **Monthly grouping**:
  - Group entries under month/year headers (“June 2020”, “July 2020”…).
- **Fast month navigation**:
  - Some kind of month scrubber / index:
    - e.g., drag on right edge to jump month-by-month (overlay shows “Nov 2023 → Oct 2023 → …”).
- **Source icons** (from screenshot feedback):
  - Left of “Apple Health”, show:
    - Apple Health icon for HealthKit entries.
    - Your app icon for manual entries.
    - BodySpec logo later for BodySpec-imported DEXA.
- **Design tweaks for the row**:
  - Consider:
    - Slightly smaller “Apple Health” sublabel to de-emphasize source relative to date/value.
    - Tighten vertical spacing a bit so long lists feel less “heavy”.
    - Light hairline divider between rows or slightly different card elevation/inner shadow so the list doesn’t read as one dark block.
    - Right-align the % and weight with consistent padding so numbers line up perfectly.

### 6. Navigation on chart screen

- Replace top-left **X** with a standard **back chevron**.
- Chart screens should behave as **pushed pages**:
  - Enable iOS-standard **edge swipe from left** to go back.
- Keep **swipe-down** behavior only for “Add entry” modal/sheet, not the main chart screen.

### 7. Home screen layout & visual identity

- **Body Score hero**:
  - Make Body Score the big hero card at top of home.
  - Tapping it goes to body score breakdown.
- **Primary accent color**:
  - Promote that nice chart blue to the **primary accent**:
    - Body Score hero,
    - Important buttons,
    - Key highlights.
- Ensure pinned metrics stack cleanly under the Body Score hero.

### 8. Basic profile editing

- In Settings → Profile:
  - Confirm user can view & edit:
    - Name
    - Email
    - Gender
    - Height
    - Birthdate
  - All of these should stay in sync with whatever you used in onboarding / scoring.

### 9. Apple Sign-In via Clerk

- Finish Sign in with Apple setup:
  - Fix Apple/Clerk config (service ID, redirect URIs, etc.).
  - Handle and surface errors gracefully if Apple sign-in fails.
- Test:
  - New user sign-up with Apple.
  - Existing user log-in with Apple.
  - Onboarding & paywall still follow the correct order.

---

## P2 – Strong v1.x / high-value features

### 10. Metric engine upgrades (Macrofactor-style behavior)

- **Time ranges** (if not already wired):  
  Use `1W / 1M / 3M / 6M / 1Y / All` consistently for all metrics.
- **Average + delta over range**:
  - For each metric card & full-screen chart:
    - Show **average value** over the selected range.
    - Show **net change** (delta) from start → end of that range.
  - Apply this to:
    - Scale weight,
    - Body fat (aligned),
    - Steps,
    - FFMI, etc.
- **Trend overlay**:
  - Weight:
    - Raw noisy scale weights + smoother “trend weight” line.
  - Body fat:
    - Raw body fat readings + smoothed “aligned BF trend”.
  - Make the chart component support multiple named series with a small legend.

### 11. DEXA presence detection + DEXA intercept

- Logic to detect **“user has no DEXA”** but is actively using body-fat features.
- For paying, engaged users (post-trial, N+ body-comp interactions):
  - Show **one-time full-screen intercept** on the body-fat screen:
    - “We use DEXA as your gold-standard baseline…”
    - Options:
      - “I already have a DEXA” → take them to log/import screen.
      - “Book a DEXA scan” → your BodySpec booking screen.
      - “Not now” → don’t nag again, just keep a small inline CTA.

### 12. DEXA booking screen (BodySpec affiliate v1)

- Dedicated DEXA Booking screen:
  - Explains why DEXA matters and how it improves their data.
  - Primary CTA: **“Book with BodySpec”** using your ambassador URL in Safari/SFSafariViewController.
- Events for:
  - DEXA booking screen viewed,
  - CTA tapped / external opened.
- Entry points:
  - From body-fat full-screen view (CTA).
  - From Settings → “DEXA Scans”.

### 13. Data model for BodySpec connection (scaffolding)

- Add basic `ExternalProviderConnection` model for future:
  - provider = `bodySpec`
  - status, externalUserId, token fields (even if empty now).
- Add “Connect BodySpec (coming soon)” stub in Settings and maybe body-fat screen.

---

## P3 – Deeper comp engine & monetization

### 14. Full aligned BF architecture (if not completely implemented yet)

(You already have a big spec for this, but put it in the backlog list explicitly.)

- Raw HealthKit mirror + canonical devices.
- `BodyCompMeasurement` abstraction with `bfRaw`, `bfAligned`, `method`, `deviceId`, etc.
- Per-user, per-device calibration:
  - DEXA as anchor,
  - Simple offset + time-based decay.
- A single “Aligned BF%” series that metric cards and charts use by default.

*(You may already be mid-implementation here; the priority is high for your core differentiator, but not as blocking as basic onboarding/auth bugs.)*

### 15. GLP-1 usage capture (lightweight v1)

- **Onboarding / settings question:**
  - “Are you currently using GLP-1 medication?” → `Yes/No`.
- Basic GLP-1 logging:
  - Separate metric for “GLP-1 dosage”.
  - User can log:
    - Medication name,
    - Date & dosage.
  - Metric card + chart: see dosage over time.

### 16. GLP-1 / weight overlay (v2 of GLP-1 feature)

- In full-screen charts:
  - Ability to overlay GLP-1 dosage line with weight (and/or body fat).
  - Let user visually see how changes in dosage relate to weight trend.

---

## P4 – Later optimizations / nice extras

### 17. Advanced month scrubbing UX

- If basic month index works well, later you can:
  - Add haptic feedback when changing months.
  - Add tiny preview of chart/summary when scrubbing.

### 18. More source-aware editing rules

- Later you can get fancy with:
  - Conflict resolution rules when there are multiple HealthKit sources.
  - Per-source visibility toggles: “hide this entire scale for this user”.

### 19. Deeper BodySpec API integration

- Proper OAuth/API flows.
- Automatic import of DEXA scans → `BodyCompMeasurement` with method `dexa`.
- Auto-recalibration after new scans.

---

If you want, next step I can turn this list into a Kanban-style board layout (P0/P1/P2 columns with concrete tickets) or into a literal bullet list you can paste into Linear/Jira with titles + one-line descriptions.


Every metric as a dedicated widget.

A single summary and quick log widget

Align app logo accent color and app accent color


Got you, Mr. White. I’ll fold those three into the backlog and re-summarize everything in priority order so you’ve got one clean planning list.

---

## P0 – Blockers for MVP

1. **Account lifecycle & onboarding**
   - Onboarding per user (not per device), fix new-account not seeing onboarding.
   - Paywall after onboarding.
   - Proper delete / log-out flows that clear local state.

2. **HealthKit isolation**
   - No cross-account bleed.
   - Per-user HealthKit caches; stop observers on log-out/delete.

3. **Chart correctness**
   - Dynamic y-axis ranges and ticks per metric & time range.
   - Time-range switching (`1W/1M/3M/6M/1Y/All`) recomputes correctly.

4. **Entry editing & deletion**
   - Swipe actions: delete + edit.
   - Manual entries: editable.
   - HealthKit entries: cannot edit source; allow “hide/ignore” or “override with manual”.
   - Rule: manual overrides HealthKit for same timestamp/day.

---

## P1 – Core MVP polish

5. **Metric history list UX**
   - Group entries by month/year with headers.
   - Fast month jump (index/scrubber).
   - Source icons on each row (Apple Health, app/manual, future BodySpec).
   - Light visual tweaks so rows read clearly.

6. **Chart screen navigation**
   - Replace “X” with back chevron.
   - Edge swipe to go back.
   - Swipe-down reserved for add-entry sheet only.

7. **Home screen layout**
   - Body Score hero at top.
   - Pinned metric cards underneath.

8. **Accent & logo color alignment**
   - Use the same blue as:
     - Primary app accent (charts, buttons, Body Score).
     - App icon accent where possible.
   - Make the visual system feel unified.

9. **Profile editing basics**
   - Editable: name, email, gender, height, birthdate.

10. **Sign in with Apple via Clerk**
    - Fix Apple/Clerk config.
    - Good error handling.
    - Test sign-up and log-in flows.

---

## P2 – Strong v1.x features

11. **Metric engine: averages & deltas**
    - For each metric + selected range:
      - Show average.
      - Show net change (delta).
    - Apply to weight, aligned BF, steps, FFMI, etc.

12. **Trend overlays**
    - Weight: raw vs trend line.
    - Body fat: raw vs aligned BF trend.
    - Chart supports multiple named series + legend.

13. **DEXA presence detection + intercept**
    - Detect “no DEXA but engaged in BF tracking.”
    - One-time intercept on BF screen:
      - “I already have a DEXA” → log/import.
      - “Book a DEXA” → booking screen.
      - “Not now” → don’t nag again (maybe small inline CTA only).

14. **DEXA booking screen (BodySpec affiliate v1)**
    - Explains why DEXA matters.
    - CTA opens BodySpec ambassador URL (Safari/SFSafariVC).
    - Analytics on views/clicks.
    - Entry points: BF screen + Settings → DEXA.

15. **BodySpec connection scaffolding**
    - `ExternalProviderConnection` model (provider `bodySpec`, status, externalUserId, token fields).
    - “Connect BodySpec (coming soon)” UI stubs.

---

## P3 – Deeper product & revenue features

16. **Aligned body-fat architecture (if not finished)**
    - Raw HK mirror + canonical devices.
    - `BodyCompMeasurement` with `bfRaw/bfAligned/method/deviceId`.
    - Per-user per-device calibration (DEXA anchor, offset + decay).
    - Unified “Aligned BF%” series powering cards/charts.

17. **GLP-1 basics**
    - Ask if user is on GLP-1 (onboarding/settings).
    - GLP-1 dosage metric:
      - Log med name + date + dose.
      - Metric card + chart for dosage over time.

18. **GLP-1 overlays**
    - Chart overlay: GLP-1 dosage vs weight (and later BF) to visualize relationship.

19. **Per-metric dedicated widgets (iOS Home/Lock)**
    - Individual widgets for:
      - Weight,
      - Body fat (aligned),
      - Steps,
      - FFMI,
      - GLP-1, etc.
    - Each shows last value + mini chart.

20. **Summary + quick-log widget**
    - One composite widget showing:
      - Body Score + a couple of key metrics.
      - Quick actions: “Log weight”, “Log BF”, “Log GLP-1”, etc.

21. **Advanced month-scrubbing polish**
    - Haptics and nicer overlay while scrubbing months.
    - Optional tiny month summaries while scrubbing.

22. **Full BodySpec API integration**
    - OAuth/token flow.
    - Auto-import scans into `BodyCompMeasurement` (method `dexa`).
    - Auto-recalibration after new scans.

---

If you want, I can next turn P0 + P1 into literal ticket titles/descriptions you can drop into Linear/Jira (one line each) so your devs can just start pulling cards.


Also, moving to test flight instead of testing on local devices, and then locking in Fastlane first locally, I guess, and then also on CI, and making sure that that is going so we can automate as much of the push to test flight as possible so that our iteration loops can be closed. We want to eventually be at a point where we're iterating as quickly as possible, where we make a feature update, and then just push and have it go through the whole CI and push out to test flight as fast as possible. And then we want to be launching as quickly as we can, and then pushing to iterate. So we haven't launched in the App Store yet, so we want to basically launch in the App Store and then just be iterating and basically pushing, I mean ideally we want to be pushing at least once a day a new version out.


Perfect, this is exactly the kind of thing that should live in the planning list, Mr. White.  
Here’s the **updated, consolidated backlog**, now including **TestFlight / Fastlane / CI** and still sorted by priority for MVP.

---

## P0 – Blockers for MVP / ability to ship

### A. Shipping pipeline & distribution

1. **Fastlane basic setup (local)**
   - Create lanes for:
     - `beta`: build, run tests, upload to TestFlight.
     - `release`: build, run tests, upload to App Store (for later).
   - Configure signing / provisioning so these lanes work on your machine.

2. **CI integration for beta builds**
   - Hook Fastlane into CI (GitHub Actions / whatever you’re using):
     - On push to main (or a `release/*` branch), run:
       - Tests,
       - `fastlane beta` to push a new build to TestFlight when green.
   - Store API keys / secrets in CI securely.

3. **Move testing to TestFlight**
   - Create internal testing group(s) in App Store Connect.
   - Use TestFlight builds as the default way you and your team test, not local adhoc builds.
   - Make sure crash + analytics tooling is active on these builds.

4. **Prepare for first App Store launch**
   - App Store Connect metadata:
     - Name, subtitle, description, keywords, screenshots, privacy, etc.
   - Verify Fastlane `release` lane can be used when you’re ready.
   - Define basic versioning scheme (e.g. `major.minor.patch`) so daily-ish releases don’t turn into chaos.

> Goal: after this, you can make a change → push → CI → TestFlight with no manual Xcode ceremony.

---

### B. Core app correctness & trust

5. **Account lifecycle & onboarding**
   - Onboarding is per **user**, not device.
   - New/different account must see onboarding again.
   - Paywall comes **after** onboarding/body-score flow.
   - Delete/log-out clears per-user local data & flags.

6. **HealthKit isolation**
   - HealthKit imports and caches are **strictly per user**.
   - No bleed when:
     - Deleting an account,
     - Logging out and back in as someone else.
   - Stop HK observers/queries when user logs out or account is deleted.

7. **Chart correctness (axes & ranges)**
   - Proper dynamic y-axis min/max and tick spacing per metric & time range.
   - Time range switching (`1W / 1M / 3M / 6M / 1Y / All`) recomputes:
     - Visible data,
     - Axis,
     - Smoothing.

8. **Entry editing & deletion**
   - Swipe actions on rows:
     - Delete,
     - Edit.
   - Manual entries:
     - Editable + deletable.
   - HealthKit entries:
     - Treat as read-only:
       - Allow “hide/ignore in Log Your Body”.
       - Allow “override with manual entry” (we use our manual instead of that HK value).
   - Rule: **manual overrides HealthKit** for same day/timestamp when both exist.

---

## P1 – Core MVP polish / must-feel-solid

9. **Metric history list UX (the screen in your screenshot)**
   - Group entries by **month/year** with section headers.
   - Add **fast month navigation**:
     - Side index or scrubber so you can quickly jump to “July 2020” etc.
   - **Source icons**:
     - Apple Health icon for HK entries.
     - App icon for manual entries.
     - Reserve slot for BodySpec logo later.
   - Light design polish:
     - Slightly smaller source label,
     - Clean alignment of % and weight,
     - Optional subtle separators so rows don’t blur together.

10. **Chart screen navigation & gestures**
    - Replace top-left **X** with a **back chevron**.
    - Enable iOS-standard **edge swipe** to go back.
    - Keep **swipe-down** only for the add-entry sheet.

11. **Home screen layout & identity**
    - Put **Body Score hero** at the top of Home.
    - Pinned metric cards under it.
    - Make sure layout feels like: “Body Score is the main identity metric of the app.”

12. **Accent & logo color alignment**
    - Promote the chart blue to:
      - Primary accent color in the app,
      - Matched accent in app icon where possible.
    - Use it consistently on:
      - Body Score hero,
      - Primary buttons,
      - Key highlights.

13. **Profile editing basics**
    - In Settings → Profile:
      - Ensure you can edit:
        - Name
        - Email
        - Gender
        - Height
        - Birthdate
      - Keep consistent with onboarding.

14. **Sign in with Apple via Clerk**
    - Fix Apple/Clerk config so Apple sign-up/sign-in works.
    - Good error messaging on failures.
    - Verify onboarding/paywall flow still correct for Apple users.

---

## P2 – Strong v1.x / “wow” features

15. **Metric engine: averages & deltas**
    - For each metric + selected range:
      - Show **average value** over the range.
      - Show **net change** (delta) from start → end.
    - Weight, aligned BF, steps, FFMI, etc.

16. **Trend overlays in charts**
    - Weight:
      - Raw weights + smoothed “trend weight” line.
    - Body fat:
      - Raw readings + smoothed “aligned BF trend”.
    - Chart supports multiple named series with a small legend.

17. **DEXA presence detection + intercept**
    - Detect “no DEXA but actively using BF features”.
    - For paying, engaged users:
      - One-time intercept on BF screen with:
        - “I already have a DEXA” → log/import.
        - “Book a DEXA scan” → DEXA booking screen.
        - “Not now” → don’t nag again (only subtle inline CTA after that).

18. **DEXA booking screen (BodySpec affiliate v1)**
    - Explains why DEXA matters for aligned BF.
    - Primary CTA opens BodySpec ambassador URL (Safari/SFSafariVC).
    - Track views + clicks.
    - Entry points:
      - BF chart,
      - Settings → “DEXA Scans”.

19. **BodySpec connection scaffolding**
    - `ExternalProviderConnection` model (provider `bodySpec`, status, externalUserId, token fields).
    - “Connect BodySpec (coming soon)” stubs in Settings/BF screen.

20. **Per-metric widgets (first pass)**
    - OS widgets for key metrics:
      - Weight,
      - Body fat (aligned),
      - Steps,
      - FFMI.
    - Each: last value + tiny sparkline.

21. **Summary + quick-log widget**
    - One widget showing:
      - Body Score + a couple key metrics.
      - Quick actions: “Log weight”, “Log BF”, etc.

---

## P3 – Deeper product / comp engine / GLP-1

22. **Aligned BF architecture (if not fully finished)**
    - Raw HK mirror + canonical device records.
    - `BodyCompMeasurement` abstraction (`bfRaw`, `bfAligned`, `method`, `deviceId`, etc.).
    - Per-user, per-device calibration with DEXA anchor (offset + decay).
    - Single “Aligned BF%” series used by cards/widgets/charts.

23. **GLP-1 basics**
    - Ask in onboarding/settings: “Are you using GLP-1 medication?”
    - GLP-1 dosage metric:
      - Log med name, date, dosage.
      - Metric card + chart for dosage.

24. **GLP-1 overlays**
    - Overlay GLP-1 dosage line with:
      - Weight,
      - Later, body fat.
    - Let user see dosage/weight relationships visually.

25. **Advanced month-scrubbing polish**
    - Haptics on month transitions,
    - Optional mini-month summaries while scrubbing.

26. **Full BodySpec API integration**
    - OAuth/token flow.
    - Auto-import DEXA scans → `BodyCompMeasurement` (method `dexa`).
    - Auto-recalibration after new scans.

---

This list should be pretty much plug-and-play for sprint planning.  
If you want, I can turn just **P0 + P1 + the Fastlane/TestFlight items** into a table of “Ticket title / Description / Priority” you can paste straight into Linear or Jira.
