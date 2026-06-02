
Here’s an updated, drop-in prompt you can give to your coding agent, with your metric cards / Macrofactor-style behavior baked in.

You can paste this as-is and tweak project names if needed.

---

**PROMPT TO GIVE CHATGPT (CODE MODEL):**

You are an expert iOS / HealthKit / Core Data / backend-integrated engineer.  
You are helping me update an ALREADY-BUILT MVP iOS app and backend before launch.

---

### 0. Product & design context

Product: **Log Your Body**  
Audience: models, actors, pro bodybuilders – aesthetics first.

Philosophy:

- We only track metrics that are **useful for aesthetics / body comp**.
- No noise metrics that induce anxiety (e.g. sleep scores, gimmicky timers).
- Core focus: **body fat, weight, FFMI, steps, girths, photos**, etc.
- Many users will have **multiple body fat sources**:
  - DEXA
  - Consumer BIA scales (Renpho, Withings, etc., often via Apple Health)
  - Calipers
  - Possibly more, over time

Key concept:

> Each method/device has a **bias** but tends to be **consistent within a person**.  
> We want to compute a **per-user, per-device calibration** and eventually **device-level priors** to produce a single, smooth **aligned body fat series** (DEXA-like).

---

### 1. Codebase context

We have:

- A monorepo with:
  - **iOS app** (primary focus for you)
  - Next.js app (secondary)
- A **sync manager** that syncs to our server.
- A data model and quite a bit of app functionality already in place. MVP is not launched yet.

Important UI architecture:

- We have **metric cards** that look very similar to Apple Health’s:
  - A stack of pinned metrics.
  - Each card shows:
    - Metric name,
    - Current value,
    - A small chart,
    - Date of last datapoint.
- We also have a **full-screen chart view** that uses the same core chart logic.
- We’re using an **atomic design** approach: the metric card and full-screen chart are built on **shared, reusable components**.  
  Different metrics (weight, FFMI, steps, etc.) all use the same core components with configuration.

We want to **extend** these metric + chart components to support:

- The more complex **aligned body fat** concept.
- Macrofactor-style **range stats** and **trend overlay**.
- A **better time range selector**.

We do **not** want to fork or hard-code special-case UI in a way that breaks the existing architecture.

---

### 2. Your meta-job

1. Inspect the repo and iOS code:
   - Find:
     - HealthKit integration.
     - Current body fat / weight / metric models.
     - How metric cards + full-screen charts are configured.
     - Sync manager models for these metrics.
2. Briefly summarize the current approach so we know what we’re starting from.
3. Propose a **migration plan** to the new model (data + UI).
4. Implement:
   - Data model changes (local + sync DTOs).
   - HealthKit ingestion changes.
   - Calibration logic for aligned body fat.
   - Metric card & chart upgrades (range stats, trend overlays, time ranges).
5. Add tests/evals and document how we’ll verify everything works.

---

### 3. Target data model (iOS side)

Adapt this to whatever persistence we currently use (Core Data / Realm / etc.). Don’t introduce a radically different storage approach; fit into the existing architecture.

#### 3.1 Raw HealthKit samples (immutable mirror)

For body fat and weight from HealthKit, we want an append-only mirror:

Fields (conceptual):

- `id` (local UUID)
- `userId`
- `hkUUID`
- `quantityType` (bodyFatPercentage, bodyMass, etc.)
- `value`
- `unit`
- `startDate`, `endDate`
- `sourceBundleId`
- `sourceName`
- Device info (from HKDevice):
  - `deviceManufacturer`
  - `deviceModel`
  - `deviceHardwareVersion`
  - `deviceFirmwareVersion`
  - `deviceSoftwareVersion`
  - `deviceLocalIdentifier`
  - `deviceUDI`
- `metadata` (optional JSON/Blob)

Tasks:

- Ensure we read **HKDevice** and **sourceRevision** when importing HealthKit samples.
- Ensure we store these fields (or equivalent) without destructive updates.

#### 3.2 Canonical devices

We want to group devices (e.g. “Renpho Smart Scale”, “Withings Body+”) and attach them to users.

**Device entity** (conceptual):

- `deviceId` (internal ID)
- `manufacturer` (normalized)
- `model` (normalized)
- Optional: `hardwareVersion`, `firmwareVersion`, `softwareVersion`
- `sourceBundleId` (app writing into HealthKit, e.g. com.renpho.app)
- `inferredMethod` (enum: `biaScale`, `dexaScanner`, `caliper`, `other`)
- `confidence` (how confident that mapping/method is)

**UserDevice**:

- `userId`
- `deviceId`
- `firstSeenAt`
- `lastSeenAt`
- `nickname` (for UI, e.g. “Bathroom scale”)

Tasks:

- Implement/extend a mapping layer from raw HealthKit samples → canonical `Device`.
- Link each device to `UserDevice` for the current user.

#### 3.3 Unified body composition measurement

This is the main abstraction the app uses for charts, calibrations, and metric cards.

**BodyCompMeasurement** (conceptual):

- `id`
- `userId`
- `timestamp`
- `sourceType` (enum: `healthKit`, `manual`, `apiPartner`)
- `deviceId` (nullable)
- `method` (enum: `dexa`, `biaScale`, `caliper`, `visualEstimate`, `other`)
- `bfRaw` (body fat %, as reported)
- `weightRaw` (if present)
- `bfAligned` (DEXA-aligned estimate; nullable)
- `alignmentVersion` (int)
- `contextFlags` (optional; fasted, AM, postWorkout, etc.)

Tasks:

- Introduce/refine this model.
- Ensure:
  - HealthKit scale entries → `method = biaScale`.
  - Manual DEXA entries → `method = dexa`.
  - Calipers → `method = caliper`, etc.
- Connect this to the existing sync manager (send both raw + aligned fields as needed).

---

### 4. Calibration logic (per-user, per-device)

#### 4.1 Anchor method

Define an **anchor** for each user:

Priority (for now):

- `dexa` > `proCaliper` > `researchBia` > `consumerBia` > `other`

Implementation:

- Add a helper that examines a user’s BodyCompMeasurements and chooses an anchor method (usually DEXA when present).

#### 4.2 Per-user, per-device calibration

For each `(user, device)`:

- Gather time-near pairs:
  - Anchor method (DEXA) reading.
  - Scale (`biaScale`) reading from that device.
- Compute a **simple offset**:
  - `offset = mean(bfAnchor - bfScaleRaw)`.

Use this to compute aligned values:

- `bfAligned = bfRaw + weightFactor * offset`.

Where:

- `weightFactor` = 1 when last anchor is recent, decaying toward 0 as the anchor gets older (e.g. linear decay to 0 over 90 days).

If no anchor exists:

- Either:
  - `bfAligned = nil`, or
  - `bfAligned = bfRaw` but mark as uncalibrated.

Define a `UserDeviceCalibration` structure:

- `userId`
- `deviceId`
- `anchorMethod`
- `calibrationType` (e.g. `simpleOffset`)
- `params` (JSON: `{ "offset": 2.6 }`)
- `lastAnchorAt`
- `numAnchorPairs`
- `validUntil`

Tasks:

- Implement a calibration engine that:
  - Computes/updates `UserDeviceCalibration` based on BodyCompMeasurements.
  - Updates `bfAligned` + `alignmentVersion` for relevant measurements.
- Make it batch/idempotent and schedule it intelligently (e.g., re-run when new DEXA or overlapping readings arrive).

We’re not doing ML yet – just offset + decay.

---

### 5. Metric cards & full-screen charts

We already have a **metric card component** and a **full-screen chart component** used across metrics (weight, FFMI, steps, etc.).  
We want to:

- Keep them **generic and configurable**.
- Add:
  - **Macrofactor-style average + delta** for any metric.
  - **Raw vs trend overlay** (e.g. for weight and aligned body fat).
  - **Improved time ranges**.

#### 5.1 Time ranges

For **all metrics**, we want a unified time range selector with:

- `1W`, `1M`, `3M`, `6M`, `1Y`, `All`

We do **NOT** want a “day/hour” view (like Apple Health), since intra-day BF/weight is meaningless for our use.

Tasks:

- Modify the chart/metric card controls so:
  - The minimum range is 1 week.
  - The range options are exactly `1 week`, `1 month`, `3 months`, `6 months`, `1 year`, `all`.
- Ensure all metrics (weight, BF, steps, FFMI, etc.) share this same range selector (driven by a common abstraction).

#### 5.2 Macrofactor-style stats: average & delta per range

For each metric card and full-screen chart:

- When a user selects a time range, compute:

  1. **Average value** over the range.
  2. **Net change (delta)** from the beginning to the end of the range.

Examples:

- Weight:
  - “Avg: 185.3 lb”
  - “Change: −1.7 lb”
- Steps:
  - “Avg: 9,200 steps”
  - “Change: +800 steps” (vs the first week/day in window).
- FFMI:
  - “Avg: 23.4”
  - “Change: +0.3”

We want this behavior available to **all metrics** that use the shared metric card pattern.

Tasks:

- Extend the metric card model / view model so each metric configuration can:
  - Specify which underlying time series to aggregate.
  - Compute `average` and `delta` for the current range.
- Update the UI:
  - Ensure each metric card (and full-screen chart, if applicable) surfaces:
    - Average for current range.
    - Delta for current range (sign aware; show +/−).
- Make sure this is wired generically (e.g. via a `MetricDefinition` or similar) so we don’t hard-code per-metric logic everywhere.

#### 5.3 Raw vs trend overlay (weight, aligned BF, etc.)

We want Macrofactor-style **trend lines**:

- For **weight**:
  - Chart shows:
    - Raw daily weight points/line (noisy).
    - Overlayed **weight trend line** (e.g. 7-day moving average or exponential smoothing).
  - Legend/labels clearly differentiate:
    - “Scale weight”
    - “Trend weight”

- For **aligned body fat**:
  - Chart can show:
    - Raw BF% readings (by method).
    - A smoothed “aligned BF% trend” line (e.g. 7-day rolling or low-pass filter).
  - For advanced views, allow toggles:
    - Show/hide raw vs aligned vs method filters.

Tasks:

- Extend the chart component to support **multiple named series**:
  - `primarySeries` (raw),
  - `trendSeries` (smoothed/derived),
  - Optionally multiple method series for body fat (DEXA vs scale vs caliper).
- Add legend or on-chart labels to distinguish the series.
- Implement reusable **trend calculators**:
  - Utility functions for:
    - Weighted moving average,
    - 7-day rolling median,
    - Or equivalent smoothing – pick one consistent, simple method and document it.
- Integrate into metric definitions:
  - Weight metric definition should specify:
    - Underlying raw series (body weight).
    - Derived trend series.
  - Aligned body fat metric definition should specify:
    - Raw BF series.
    - Aligned BF trend series.

We want the chart overlay pattern to be generic enough that we can reuse it for other metrics later.

#### 5.4 Metric card for body fat (aligned BF)

Body fat is more complex, but we still want to fit it into the **same metric card component**.

Behavior:

- The metric card for body fat should, by default, display:

  - The **current aligned body fat %** (if available) as the main number.
  - Optionally a confidence indicator or note like “DEXA-anchored” (short).
  - The date of the last relevant measurement.

- The small chart on the card:
  - Uses the aligned BF series for the current range.
  - Smoothing consistent with other metrics.

- When tapping the card (full-screen chart):
  - Show:
    - Aligned BF trend line.
    - Optionally toggles/filters:
      - Anchor-only (DEXA only).
      - Scale-only (raw).
      - Method filters.
  - Hover/tap on a point should be able to display:
    - Raw BF%,
    - Aligned BF% (if different),
    - Method & device info.

Tasks:

- Extend the metric definition for body fat so it plugs into the same metric card/chart system as weight/steps.
- Avoid copy-pasted special-casing; use configuration and data model hooks (aligned vs raw series, method filters, etc.).

---

### 6. Sync manager / backend

We already have a sync manager. You need to:

1. Inspect how body comp and metric data are currently serialized & sent to the backend.
2. Update or propose DTOs that can represent:

   - `BodyCompMeasurement`:
     - `id`, `timestamp`, `method`, `deviceId` (or device descriptor),
     - `bfRaw`, `weightRaw`,
     - `bfAligned`, `alignmentVersion`.
   - Device info, if needed.
   - Any additional fields required for server-side analytics (raw vs aligned).

3. Decide strategy:
   - At minimum: **always sync raw data**.
   - Optionally: also sync aligned values so backend/web can reuse them.
4. Keep changes consistent with the existing sync architectures and patterns.

Document what you changed and why.

---

### 7. Testing & evaluation

#### 7.1 Unit tests

Add unit tests to cover:

1. **Device normalization:**
   - Given a set of fake HealthKit samples with various HKDevice/sourceBundle combinations, verify:
     - Proper `Device` creation/lookup.
     - Correct `inferredMethod`.

2. **Measurement creation:**
   - HealthKit → BodyCompMeasurement mapping:
     - Scale sample → method = `biaScale`, device attached, correct bfRaw/weightRaw.
     - Manual DEXA → method = `dexa`.

3. **Calibration:**
   - Scenario: user with DEXA 12.1% + scale 9.5% same day:
     - Calibration computes positive offset.
     - Subsequent scale readings get aligned values ~2.6 pts higher (modulo decay).
   - Staleness / decay logic:
     - When last anchor is old, `weightFactor` shrinks to 0 and aligned ~ raw.

4. **Metric aggregation (average + delta):**
   - For a synthetic series (e.g. weight over 1M), verify that:
     - Average over the range is correct.
     - Delta is end − start and properly signed.

5. **Trend calculations:**
   - For synthetic noisy data, confirm:
     - Trend series is smoother and in the right direction.
     - No off-by-one/time-window bugs.

#### 7.2 Integration / UI behavior checks

At minimum, define and partially automate a test plan that covers:

- Users with:
  - DEXA 1–2×/month + daily scale.
  - Only scale.
  - DEXA for some period, then only scale.
- For each:
  - Metric cards show:
    - Proper current value.
    - Range-based average & delta depending on selected range.
  - Charts:
    - Show raw series + trend overlay (weight, aligned BF).
    - Respond correctly when switching time ranges (`1W`, `1M`, `3M`, `6M`, `1Y`, `All`).
    - Do not show nonsensical day/hour data.
  - Body fat charts:
    - Avoid wild jumps when mixing DEXA + scale (alignment works).
    - Method filters & legends behave properly.

If we already have snapshot/UI tests, integrate this behavior where practical.

---

### 8. How to proceed

When you respond:

1. **First**, inspect the existing structures:
   - Metric card / chart components.
   - Metric models and data sources.
   - HealthKit ingestion and body-comp-related persistence.
   - Sync manager DTOs.
2. **Summarize** the current approach and highlight any constraints/risks.
3. **Propose** a concrete mapping from current → target for:
   - Data models.
   - Calibration layer.
   - Metric card / chart configurations.
   - Time range selection.
4. Once that’s clear, **implement**:
   - Data model changes and migrations (if needed).
   - Calibration engine logic.
   - Metric card & chart enhancements (average/delta, trend overlay, time ranges).
   - Sync model updates.
   - Tests and small demo scenarios in code.

Always adapt to the existing architecture and naming conventions rather than inventing a brand-new style.

Use this entire prompt as the product spec and requirements document for updating Log Your Body’s iOS app to support aligned body fat, per-device calibration, and Macrofactor-style metric behavior.


So the next thing I want to do is I want to design a feature. If a user hasn't gotten a DEXA scan before, we'd like them to get a DEXA scan. And so I want them to be able to book a scan. And I'd like... And so eventually, the way I would love to do it is that we do this in-house and have our own DEXA scans or something. But for now, we'll use partners to do the DEXA scans. And in order to do that, the company that I know of that is the most established kind of startup that I've seen kind of doing this is called BodySpec. Now, BodySpec has an API and stuff for importing their scans and stuff, which is great because we'll use that. But just for right now, what I would like to do is... And they even have MCP and everything. But just for now, what I'd like to do is I would like to have it so that there's a flow where people can book a DEXA scan through BodySpec. And so... So... Eventually, I want to reach out to them and get a partnership. But just for right now, they just have an ambassador program that you can sign up for and you get 50% of the fee. And so I would just like to use their ambassador program and then just link to it and then just have it be a situation where we get those... We get commission for everything we send over there. And we just build the flow. So if they don't have a DEXA, we have a thing that's like book a DEXA. And we put that in the app somewhere. And so I'm trying to kind of plan out the future. And I don't... What I don't want to do is like distract from our app and our flow and get them converting and using our app and be like on the onboarding or something. Be like, oh, you don't have a DEXA? Go get one. And all of a sudden, now they're becoming a BodySpec customer and they're not becoming a customer of ours. Right? I just want it to be like, you know, when they go in, you know, maybe it's like buried in the settings menu or something. Or maybe it's like part of the flow when they go to log something and choose DEXA as a method. I don't know. So that's what I'm trying to kind of figure out in the first iteration of this. And then the second thing would be building out the flow for them to actually connect their BodySpec account. You know, I want to figure out how we do that. And what that flow kind of looks like.

Here's the program they have
Online Sale: 50% USD	
Payout Details
Default Payout	50% of order sale amount
Note that bonus payout increases will be paid in the form of a monthly performance bonus
Bonus Tiers
Pay a fixed bonus based on action count for each month
Tier	Action Range	Bonus Rate
1
10+
$100
Payout Restrictions
Condition	Payout
Customer Status is existing
none
Limits
Condition	Period
$100 payout per order
N/A
Schedule
Action Locking	Actions are locked 27 day(s) after end of the month they are tracked
Payout Scheduling	Approved transactions are paid 20 day(s) after end of the month they lock
Qualified Referrals
Credit Policy	Last Click
Referral Window	Allow referrals from clicks within 30 day(s)
General Terms	
Currency	Financial transactions covered by this Template Terms will be processed in the USD currency. Currency exchanges will occur when you or your partner(s) have set a different default currency in account settings.
Change Notification Period	The Template Terms can be changed or cancelled with 1 day(s) notification to the media partner.
Stand Down Policy	Advertiser enforces a stand down policy providing partners a better opportunity to maintain their status as the conversion "winner". The full policy is available at Stand-Down Policy.
Reversal Policy	Reversal of performance advertising actions are decided by the Advertiser governed by a max reversal percentage of 100%
Media Partner Tracking Pixel	Advertiser does NOT allow media partner to fire their tracking pixel when the consumer action is completed.
Coupon Site Restrictions	
Commission Payment Terms

Eligibility for Commissions
Commissions will only be paid to the Affiliate for valid referrals that comply with all terms outlined in this agreement.

Restrictions on Promotion
The Affiliate agrees that no commissions will be payable if tracking links, vanity coupons, or promotional codes are found on coupon sites or any unauthorized platforms.

Right to Withhold Commissions
BodySpec reserves the right to withhold any commissions due to the Affiliate if the terms stated in this section are breached.
Paid Search Terms Restrictions	
Paid Search Advertising Restrictions for Affiliates
As an affiliate of BodySpec, you agree to adhere to the following terms regarding paid search advertising:

Restricted Keywords: Affiliates are prohibited from bidding on the following keywords and any variations, misspellings, or combinations thereof, including but not limited to:
"BodySpec"
"DEXA"
"DXA"
Any other keywords that include the words "BodySpec," either as standalone terms or in combination with other words.

Negative Keywords: Affiliates must include "BodySpec," and related terms as negative keywords in any paid search campaigns they run. This ensures that ads related to these terms do not appear.

Use of BodySpec's Trademarks: Affiliates are prohibited from using any of BodySpec's trademarks or variations thereof in a way that suggests an official partnership or endorsement beyond the approved affiliate relationship.

Monitoring and Enforcement: BodySpec reserves the right to monitor affiliate activities to ensure compliance with these terms. Non-compliance may result in suspension or termination of the affiliate relationship.

Penalties for Violation: Any affiliate found in violation of these terms may face penalties, including forfeiture of commissions, termination of the affiliate agreement, and potential legal action.


By participating in BodySpec's affiliate program, you agree to comply with these paid search advertising restrictions.
MPA (found at Impact Master Program Agreement ) does not apply if the parties have a separate agreement in place governing this Partner Contract.


Got it, Mr. White. I’ll give you a **single, ready-to-paste prompt** for your code agent that:

- Designs **where** and **how** DEXA booking appears (without hijacking onboarding).
- Uses **BodySpec ambassador links** in v1.
- Sets up the **future “Connect BodySpec account” flow** and data model hooks.
- Respects that you already have metric cards, full-screen charts, and an aligned-body-fat model.

Here it is:

---

**PROMPT FOR CHATGPT (CODE / “CODECS” MODEL):**

You are an expert iOS engineer (Swift/SwiftUI/UIKit as needed), HealthKit integrator, and product-minded architect.

You are working on **Log Your Body**, an aesthetics-first body comp app for models, actors, and serious lifters.

We already have:

- A monorepo with an **iOS app** (primary focus for this prompt) and a Next.js app.
- A **sync manager** that syncs data to our backend.
- A data model for body composition, including:
  - `BodyCompMeasurement` (conceptual):
    - `id`, `userId`, `timestamp`
    - `sourceType` (`healthKit`, `manual`, `apiPartner`)
    - `deviceId`
    - `method` (`dexa`, `biaScale`, `caliper`, `visualEstimate`, `other`)
    - `bfRaw`, `weightRaw`
    - `bfAligned`, `alignmentVersion`
    - `contextFlags`
  - Calibration logic that uses **DEXA** as an anchor, aligns BIA scales, etc.
- **Metric cards** and **full-screen chart** components:
  - Shared components used by weight, FFMI, steps, etc.
  - Think “Apple Health-style cards”: pinned metrics, small inline chart, last value + date.
  - Full-screen chart uses the same core chart logic (atomic design).

We do **not** want to break this existing architecture. We want to extend it.

---

## High-level feature: DEXA booking + BodySpec integration

We want to design and implement a feature that:

1. **Encourages users who’ve never had a DEXA** to go get one.
2. Uses **BodySpec** as the initial provider via their **ambassador/affiliate program**:
   - They provide referral links; we get ~50% commission per order.
   - Standard affiliate constraints: no coupon-site abuse, no paid search bidding on their trademarks, last-click 30-day window, etc.
3. **Does not derail our own onboarding** or convert users into “BodySpec-first” instead of “Log Your Body-first”.
4. Sets up the architecture for a **v2 “Connect your BodySpec account”** flow using their API (we don’t need to fully implement the API integration yet, but we want scaffolding in place).

BodySpec provides:

- Online booking and DEXA services across multiple US cities. citeturn0search3turn0search11  
- An API for pulling scan data / JSON results, oriented around AI integrations and external apps (in early access). citeturn0search0turn0search5  
- An ambassador/creator program with referral links / commissions. citeturn0search1turn0search4  

Assume we have:

- An **ambassador referral URL** string (configurable, likely from remote config or .plist/env).

---

## Your meta-job

1. Inspect the existing iOS app:
   - Find:
     - Metric card + chart implementation.
     - Body comp / DEXA data models.
     - Sync manager.
     - Navigation/routing (how we push new screens / webviews).
2. Summarize the current state for:
   - How body fat and DEXA are represented.
   - How metric cards are configured and parameterized.
   - Where Settings / Integrations live, if any.
3. Propose a concrete plan to:
   - Add a **DEXA booking flow** using BodySpec referral links.
   - Add non-intrusive **entry points** for this flow (good UX, doesn’t hijack onboarding).
   - Set up a **future “Connect BodySpec account” integration**, including data model and UI scaffolding.
4. Implement:
   - New screens/view models and navigation.
   - Analytics hooks.
   - Any minimal backend/sync changes needed for tracking DEXA bookings and future BodySpec connections.
5. Add tests and document how to verify behavior.

---

## Phase 1: “Book a DEXA” flow (affiliate / ambassador link)

### Goals

- If a user has **no DEXA measurements** yet, we want a smart way to encourage them to get one.
- Use **BodySpec ambassador link** to book scans, earning commissions.
- Do *not* hijack onboarding or send them away from our app too early.

### UX constraints

- Do **not** aggressively push DEXA booking in onboarding in a way that stops the user from actually getting value from our app.
- The DEXA booking entry points should:
  - Be discoverable.
  - Make sense contextually.
  - Be a “power move” for users who clearly care about more precise data.

### Entry points (v1)

Implement the following entry points:

1. **Body Fat metric card / full-screen view:**
   - If user has **no DEXA** in their BodyCompMeasurements:
     - On the body-fat metric card or the full-screen chart, show a **subtle CTA**:
       - Example: A small pill/button: “Get a DEXA baseline” or “Book your first DEXA”.
     - Tapping this opens the **DEXA Booking screen** (described below).

2. **DEXA method selection when logging:**
   - In the flow where user logs body fat and chooses a method:
     - If they select “DEXA” but we detect they have **no linked DEXA provider / scan history**:
       - Show a small modal or inline info:
         - “No DEXA scans yet. You can still log manually, or book a scan with our partner.”
         - Provide two options:
           - “Log manually”
           - “Book a DEXA scan” → goes to DEXA Booking screen.

3. **Settings / Integrations:**
   - In Settings (or an Integrations/Services area), add:
     - “DEXA Scans” section with:
       - “Book a DEXA scan (BodySpec)”
       - “Connect BodySpec account” (disabled or stubbed for v1; see Phase 2).

### DEXA Booking screen (v1 behavior)

Create a dedicated screen, something like:

- Title: “Book a DEXA Scan”
- Content:
  - Brief explanation:
    - Why DEXA is valuable (accuracy, body fat vs. smart scales, etc.).
    - How it ties into our aligned body fat calibration (we anchor your devices).
  - Short note that we partner with BodySpec to deliver scans; they operate the scanning and booking.
  - Optional: link or button to “Learn more about DEXA” (could open an in-app webview to BodySpec’s DEXA info page). citeturn0search11turn0search17  

Primary CTA:

- Button: “Book with BodySpec”
  - This opens:
    - Preferably `SFSafariViewController` with the ambassador **referral URL**, OR
    - System browser (Safari) if that better respects affiliate tracking.
  - We must preserve the referral parameters exactly; do not alter UTM / tracking query parameters.

Analytics:

- Log events like:
  - `dexa_booking_viewed`
  - `dexa_booking_cta_tapped`
  - `dexa_booking_external_opened` (with context: entry point, user has/no DEXA, etc.)

Do **not** attempt to show BodySpec’s booking UI in a custom HTML shell that interferes with their tracking. Use their official URL in a browser/webview.

### Affiliate constraints

We are using in-app links and not doing paid search, coupons, etc., so we are within the usual constraints, but:

- Do not:
  - Inject BodySpec coupons into 3rd-party coupon platforms.
  - Use “BodySpec” or “DEXA” as paid search keywords (this is more a marketing policy; you can just note in internal documentation).
- Make sure we:
  - Store the ambassador referral URL in config so it’s easy to rotate/update if they change terms.

---

## Phase 2: “Connect BodySpec account” (future, but design now)

We’re not fully building the API integration right now, but we want to:

- Design the flow.
- Add data model scaffolding.
- Add UI hooks.

BodySpec provides an API that exposes scan data (e.g., JSON with body fat %, lean mass, etc.). citeturn0search0turn0search5  

### Conceptual data model additions

Add a model for **external provider connections**, at least:

- `ExternalProviderConnection`:
  - `id`
  - `userId`
  - `provider` (enum/string: `bodySpec`)
  - `status` (`connected`, `revoked`, `error`, `pending`)
  - `createdAt`, `updatedAt`
  - `accessToken` / `refreshToken` / `expiresAt` (secure storage; may initially be null if we haven’t implemented OAuth yet)
  - `externalUserId` (if BodySpec exposes one)

We may not fill in the tokens until we actually build OAuth/API, but we want the structure ready.

Also:

- Plan a way to associate imported BodySpec scans with `BodyCompMeasurement` entries:
  - Likely via `sourceType = apiPartner`, `method = dexa`, and a reference to `externalScanId`.

### UX flow (stubbed now, real later)

#### Settings / Integrations

In Settings:

- Under “DEXA Scans”:
  - “Connect BodySpec account”
    - For v1:
      - Tapping shows an info screen:
        - Explains that direct BodySpec connection is “Coming soon”.
        - Optional: “Join waitlist” (e.g., send an event or collect email).
      - Or, if you want to go further:
        - Let the user tap “Continue” and open BodySpec’s generic sign-in or AI-integration page in a webview (for now), but don’t claim that we’ll auto-import yet.

We want you to design the flow as if we will eventually:

- Launch an OAuth or API token exchange.
- Store tokens securely.
- Perform periodic background sync:
  - Fetch new scans from BodySpec’s API.
  - Convert them into `BodyCompMeasurement` entries (method = `dexa`, `sourceType = apiPartner`).
  - Trigger recalibration for that user.

You don’t have to implement all network calls right now, but:

- Add TODOs / protocols / interfaces that make it straightforward to plug in BodySpec’s API later.

#### DEXA metric / body comp screens

In the body-fat full-screen view, create a secondary CTA:

- If user **has not connected** BodySpec:
  - Show a small “Connect BodySpec” button (or text link).
  - For now, reuse the “coming soon” stub.

We want the UI architecture to support a future state where:

- If `ExternalProviderConnection(provider: bodySpec).status == connected`:
  - We can show last sync time, number of scans imported, etc.
  - BodySpec DEXA scans show up automatically in the aligned BF chart.

---

## Integration with existing metric cards & charts

We already use **metric cards** and **full-screen charts** for metrics like weight, FFMI, steps, etc.

You must:

- **Extend, not fork**, the existing components.

Specifically:

1. **Body fat metric card**:
   - If no DEXA data:
     - Surface the “Get DEXA baseline” CTA (subtle).
   - If DEXA data exists:
     - Show aligned BF as usual (no change to card structure, just new configuration).

2. **Full-screen body fat chart**:
   - The chart is already set up to handle aligned vs raw BF.  
   - You just add:
     - DEXA booking CTA (if no DEXA).
     - “Connect BodySpec” entry (link to Settings or inline stub).

3. **Time range selector**:
   - We’re using:
     - `1W`, `1M`, `3M`, `6M`, `1Y`, `All` across metrics.
   - Ensure the DEXA CTAs and BodySpec actions respect this (e.g., statistics should reflect the selected range; the DEXA suggestion logic can be independent of range).

---

## Sync / backend changes

For v1 we mainly need to:

- Track that a user **clicked through** to BodySpec via our app.

At minimum:

- Add events or simple API calls from the app to our backend when:
  - User views DEXA booking screen.
  - User taps the “Book with BodySpec” CTA.
- Optionally:
  - Record the **entry point**: from metric card, from logging flow, from settings.

We do *not* have to track actual commission conversions yet (Impact/affiliate system will handle that), but a simple logging layer on our side is useful.

For the future BodySpec connection:

- Ensure there is a backend model and endpoints compatible with your `ExternalProviderConnection` structure, or at least design the client code so we can hook into these endpoints easily.

---

## Testing & evaluation

Add tests or at least a robust test plan for:

1. **DEXA presence detection:**
   - Given different sets of BodyCompMeasurements (none DEXA, some DEXA, imported vs manual), confirm:
     - The app correctly decides when to show:
       - “Get a DEXA baseline” CTA.
       - “Connect BodySpec” stub.
       - Neither, if user is already a DEXA-heavy user.

2. **Navigation & flows:**
   - Tapping CTAs opens the right screens.
   - “Book with BodySpec” opens the referral URL correctly.
   - No crash or weird back behavior.

3. **Analytics events:**
   - Correct events fired with correct parameters when:
     - DEXA booking screen is shown.
     - User taps “Book with BodySpec”.
     - User opens DEXA/BodySpec options from different entry points.

4. **Architecture sanity:**
   - Metric card and full-screen chart components remain generic; body fat just configures them.
   - DEXA booking and BodySpec connection flows are injected via configuration/feature flags rather than hard-coded special-casing all over the app.

---

## How I want you to proceed

1. Inspect the repo and current iOS implementation:
   - Metric cards + chart system.
   - Body comp models.
   - Settings/Integrations.
   - Sync manager.
2. Summarize the current state and call out any constraints you find.
3. Propose concrete UI/architecture changes to implement the **three main pieces**:
   - DEXA presence detection.
   - DEXA booking flow (BodySpec affiliate).
   - BodySpec connection scaffolding.
4. Implement the changes:
   - New screens / view models.
   - Navigation.
   - Analytics calls.
   - Minimal backend sync additions (if needed).
5. Add tests and example usage.

Use this prompt as the **product + tech spec** for adding the initial BodySpec DEXA booking integration and future account-connect scaffolding into the Log Your Body iOS app.

---

If you need any clarification, assume the goal is: *maximize in-app value first*, and make DEXA booking + BodySpec connection feel like a **power feature** for users who are already engaged, not a distraction from our core experience.


Like, based on our flow, we kind of like walk them through an onboarding where it's like they get the body score. So the onboarding basically is like, hey, get your body score. Like, find out how hot you are compared to, like, the average, right? And then, like, walks you through a bunch of questions, then gives you your body score based on, like, your genetic potential. How hot could you be and how hot are you, basically, right? And then you create an account and you sign up, and then, boom, you get hit with the paywall of, like, do you want to pay, you know, $69 for access for a year with a three-day free trial? And then when they do that, then they get access to the app. I'm thinking that maybe it's like a thing where, I don't know, I want your advice and then your opinion about, like, the YC advice would be on this, what would the Sam Ullman advice be on that stuff. I'm thinking maybe it's like once they're in a paid cycle on the app, they've been using the app for X number of days or it's like X number of logins after the pay period starts, like, not in the trial period where they can still cancel. We prompt them with, you know, like, a full-page intercept kind of thing that's like, like, hey, the best way to get data is to book a DEXA. We recommend doing this monthly, but at minimum twice a year. Have you had a DEXA? Do you want to upload that data now or connect to that account now? If not, do you want to book one? Thank you.
