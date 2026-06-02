
Got it, Mr. White — **LogYourBody**, not Dr. Body.  

Anywhere I referred to “Dr. Body” in the specs / prompts, treat that as **LogYourBody** (app name, copy, and labels).  

If you want, I can quickly regenerate any of those prompts with the name swapped so you can paste them straight into your agent/docs without edits.


{'asset_pointer': 'sediment://file_000000009770722fb14104d196160c7f', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 118446, 'width': 708}
Okay now

Add

Remove the quick action button from the settings menu

We need an edit feature for the data entries in the full screen chart mode and they should open a pop up like attachment 


Got it, Mr. White. I’ll fold both of those into something you can hand straight to your coding agent.

---

### New items to add to the backlog

1. **Remove quick action button from Settings screen.**  
2. **Add edit flow for data entries in full-screen chart mode (bottom sheet popup like the screenshot).**

---

### Prompt for coding agent – quick action removal + edit popup

Use this in place of the previous “no editing yet” instruction.

---

**Task: Update LogYourBody full-screen metric screens**

#### 1. Remove quick action button from Settings

- On the Settings screen, remove the “quick action” button (the extra action in the header).
- Settings should only show the standard navigation (back, title) and regular rows/sections; no additional floating or header quick-action button.

---

#### 2. Implement edit flow for metric entries from the full-screen chart

We already have a full-screen metric chart (e.g., Scale Weight) with a list of individual entries grouped by month under the chart.

**New behavior:**

- Each entry row in that list must be **tappable**.
- Tapping a row opens a **bottom sheet / popup** similar to the attached design.

**Bottom sheet design & behavior (per the screenshot):**

- **Presentation**
  - Modal sheet that slides up from the bottom.
  - Top bar:
    - Left: `X` to close (no changes saved).
    - Center: date + metric name, e.g., `9/28/2025` on first line, `Scale Weight` on second.
    - Right: trash icon button to delete this entry.
  - A small drag handle / grabber at the top of the sheet (like in the screenshot).

- **Integration banner**
  - If the entry’s data came from an integration (e.g., Health):
    - Show a banner at the top of the sheet with:
      - Integration icon on the left (use the same generic integration/heart icon we use in the list).
      - Text along the lines of:  
        **“Weight data for this day was populated from your Health integration. Manually entering data here will override the synced data.”**
    - Adjust wording slightly for other metrics if needed (e.g., “Body fat data”).
  - If the entry is purely manual, **don’t show** the banner.

- **Form fields**
  - Show editable fields for the metric values for that date:
    - For scale weight entries:
      - `Weight` input with unit label (e.g., `lbs`).
      - `Body Fat` input with `%` (if we’re storing BF% on the same entry).
    - For other metrics, show the appropriate single input (e.g., FFMI, steps, etc.) with unit where applicable.
  - Inputs should:
    - Be pre-filled with the entry’s current values.
    - Use a numeric keypad.
    - Validate basic constraints (no negative values, etc.).

- **Actions**
  - **Save** button at the bottom:
    - Saves changes to the entry and dismisses the sheet.
    - If the entry was originally from an integration, saving should:
      - Mark it as manually overridden.
      - Use the edited values as the source of truth for that date in LogYourBody.
  - **Delete** (trash icon in the top right):
    - Prompt for confirmation.
    - On confirm, delete the entry and dismiss the sheet.
    - Make sure the chart + list update immediately to reflect the deletion.

- **State handling**
  - If the user closes with `X`, discard any unsaved changes.
  - When the sheet is open, underlying chart/list should be dimmed and non-interactive.

---

That should give your devs exactly what they need to:  
- strip the quick action from Settings, and  
- wire up the new edit popup for entries in the full-screen chart view.


We also want to track these metrics as they are core to aesthetics 

{
  "male": {
    "aesthetic": {
      "shoulder_to_waist_ratio": {
        "ideal": 1.6,
        "range": [1.5, 1.7],
        "unit": "ratio"
      },
      "waist_to_chest_ratio": {
        "ideal": 0.77,
        "range": [0.72, 0.82],
        "unit": "ratio"
      },
      "waist_to_hip_ratio": {
        "ideal": 0.8,
        "range": [0.78, 0.9],
        "unit": "ratio"
      },
      "waist_to_height_ratio": {
        "ideal": 0.45,
        "range": [0.43, 0.48],
        "unit": "ratio"
      },
      "body_fat_percentage": {
        "ideal": 12.0,
        "range": [10.0, 18.0],
        "unit": "percent"
      }
    }
  },
  "female": {
    "aesthetic": {
      "waist_to_hip_ratio": {
        "ideal": 0.7,
        "range": [0.65, 0.75],
        "unit": "ratio"
      },
      "waist_to_height_ratio": {
        "ideal": 0.44,
        "range": [0.42, 0.47],
        "unit": "ratio"
      },
      "body_fat_percentage": {
        "ideal": 22.0,
        "range": [18.0, 28.0],
        "unit": "percent"
      }
    }
  }
}


Nice, this is exactly the kind of thing that will make LogYourBody feel different, Mr. White.

Here’s a tight spec you can hand to your coding agent to wire these in.

---

### Goal

Add **derived aesthetic metrics** to LogYourBody for men and women, based on circumferences + height, using the config you provided.

We want to:
- Track these metrics over time (just like weight/BF/FFMI).
- Show how close the user is to the **ideal** and **acceptable range** for their sex.

---

### 1. Config (use this JSON in-app)

Use this (or equivalent) as a static config object:

```json
{
  "male": {
    "aesthetic": {
      "shoulder_to_waist_ratio": {
        "ideal": 1.6,
        "range": [1.5, 1.7],
        "unit": "ratio"
      },
      "waist_to_chest_ratio": {
        "ideal": 0.77,
        "range": [0.72, 0.82],
        "unit": "ratio"
      },
      "waist_to_hip_ratio": {
        "ideal": 0.8,
        "range": [0.78, 0.9],
        "unit": "ratio"
      },
      "waist_to_height_ratio": {
        "ideal": 0.45,
        "range": [0.43, 0.48],
        "unit": "ratio"
      },
      "body_fat_percentage": {
        "ideal": 12.0,
        "range": [10.0, 18.0],
        "unit": "percent"
      }
    }
  },
  "female": {
    "aesthetic": {
      "waist_to_hip_ratio": {
        "ideal": 0.7,
        "range": [0.65, 0.75],
        "unit": "ratio"
      },
      "waist_to_height_ratio": {
        "ideal": 0.44,
        "range": [0.42, 0.47],
        "unit": "ratio"
      },
      "body_fat_percentage": {
        "ideal": 22.0,
        "range": [18.0, 28.0],
        "unit": "percent"
      }
    }
  }
}
```

Use `user.sex` (`male` / `female`) to pick the right config.

---

### 2. Measurements we need to store

To compute these ratios, we need raw circumferences + height logged:

- **Shoulder circumference**
- **Chest circumference**
- **Waist circumference**
- **Hip circumference**
- **Height** (already stored; reuse)

Each should be loggable as a **time-series metric** (date + value + unit, cm or inches).

You don’t need fancy UI yet—simple numeric inputs with date are fine. They can be logged less often (weekly / monthly) but stored the same way as weight.

---

### 3. Derived aesthetic metrics (new metric types)

From those raw inputs, compute and store/display **derived metrics**:

For **male**:
- `shoulder_to_waist_ratio = shoulder / waist`
- `waist_to_chest_ratio = waist / chest`
- `waist_to_hip_ratio = waist / hip`
- `waist_to_height_ratio = waist / height` (convert to consistent units first)
- `body_fat_percentage` = we already track this; just


So we should display metrics as in range or out of range and indicate how close or far they are


Exactly, Mr. White – this is where these ratios become *useful* instead of just nerd stats.

Let’s define **simple rules + a UI pattern** you can implement everywhere.

---

## 1. Logic per metric

Given config:

- `ideal`
- `range = [min, max]`
- `unit` (ratio / percent)
- user value `v`

### A. In-range vs out-of-range

```ts
const inRange = v >= min && v <= max;
```

### B. Direction vs ideal

```ts
const deltaToIdeal = v - ideal;          // signed
const distanceToIdeal = Math.abs(deltaToIdeal);  // absolute
const direction =
  deltaToIdeal > 0 ? "above" :
  deltaToIdeal < 0 ? "below" :
  "at";
```

### C. How far from the *acceptable range*

Distance to the **nearest edge** of the range:

```ts
let distanceToRange = 0;
if (v < min) distanceToRange = min - v;
else if (v > max) distanceToRange = v - max;
```

Normalize that so we can get a **0–100% “closeness to range” score**:

```ts
const rangeWidth = max - min || 1; // guard
const normalized = Math.min(distanceToRange / rangeWidth, 1); // 0 = at edge, 1+ = far
const closenessToRange = Math.round((1 - normalized) * 100);  // 100 = inside or touching range
```

Inside the range, `distanceToRange = 0` → `closenessToRange = 100`.

You can also get **position inside the range** (for copy like “low end / high end of ideal”):

```ts
const positionInRange = inRange ? (v - min) / rangeWidth : null; // 0..1
```

---

## 2. UI pattern per aesthetic metric

For each metric card (e.g., “Shoulder-to-Waist Ratio”):

**Top line:**
- Value + unit  
  - `1.58`  
  - Small label: `Shoulder / Waist`

**Status pill (color coded):**

- If `inRange`:
  - Text:  
    - Primary: **“In ideal range”**
    - Secondary (based on `positionInRange`):
      - `< 0.33` → “Leaning narrower than ideal”
      - `0.33–0.66` → “Very close to ideal”
      - `> 0.66` → “Leaning broader than ideal”
- If `!inRange`:
  - Determine direction vs ideal:
    - `direction === "above"` → “Above ideal”
    - `direction === "below"` → “Below ideal”
  - Secondary text using `distanceToRange`:
    - Example:  
      - `“0.08 above ideal range”` for ratios  
      - `“4% above ideal range”` for percents

**Progress bar:**

- Horizontal bar from `min` to `max` with tick at `ideal`.
- Marker for user value (clamped slightly beyond ends so out-of-range is still visible).
- Optionally tint the bar:
  - Green when `inRange`
  - Amber/Red when `!inRange`

---

## 3. Example copy behavior

**Male shoulder-to-waist:**

- Config: `ideal: 1.6`, `range: [1.5, 1.7]`
- User value: `1.72`

- `inRange = false` (above `1.7`)
- `distanceToRange = 1.72 - 1.7 = 0.02`

Display:

- Value: `1.72`
- Status pill: **“Above ideal”**
- Subtext: `“0.02 above ideal range”`
- Bar: ideal zone 1.5–1.7, ideal tick at 1.6, marker slightly to the right.

**Male waist-to-height:**

- Range `[0.43, 0.48]`, ideal `0.45`
- User: `0.46` → in range, slightly high.

- `inRange = true`
- `positionInRange ≈ (0.46 - 0.43) / 0.05 = 0.6`

Display:

- Status: **“In ideal range”**
- Subtext: `“Slightly above ideal”` (because position ~0.6)

---

## 4. Dev-ready snippet for your agent

You can paste this:

> For each aesthetic metric (shoulder_to_waist_ratio, waist_to_chest_ratio, waist_to_hip_ratio, waist_to_height_ratio, body_fat_percentage), use our sex-specific config (`ideal`, `range[min,max]`, `unit`) and the user’s current value `v` to compute:
> 
> - `inRange: boolean` → `v >= min && v <= max`
> - `deltaToIdeal: number` → `v - ideal`
> - `distanceToIdeal: number` → `abs(deltaToIdeal)`
> - `direction: "below" | "at" | "above"`  
> - `distanceToRange: number` →  
>   - `0` if `inRange`  
>   - `min - v` if `v < min`  
>   - `v - max` if `v > max`
> - `closenessToRange: 0–100` →  
>   - `rangeWidth = max - min`  
>   - `normalized = min(distanceToRange / rangeWidth, 1)`  
>   - `closenessToRange = round((1 - normalized) * 100)`
> 
> **UI rules:**
> - Show the metric value + unit.
> - If `inRange`:
>   - Status pill: “In ideal range”.
>   - Subtext based on where they sit inside the range (low / middle / high) using `positionInRange = (v - min) / rangeWidth`.
> - If not in range:
>   - Status pill: “Above ideal” or “Below ideal” based on `direction`.
>   - Subtext like: `“0.08 above ideal range”` (or `“4% above ideal range”` for BF%).
> - Render a horizontal bar from `min` to `max` with:
>   - tick at `ideal`
>   - marker for the user value
>   - color: green if `inRange`, amber/red if not.
> 
> This component should be reusable for all aesthetic metrics, driven entirely by config + current value.

If you want, next we can wire this into the **Body Score** so those “in range / out of range” metrics feed into the single 0–100 score.


Now breakout ALL features and improvements discussed and rank by most important for an mvp


Here’s everything we’ve talked about, Mr. White, broken out and roughly ordered for an MVP.

---

## Tier 0 – Critical for MVP (do these first)

1. **Fix onboarding state**
   - Persist “onboarding complete” so the flow does *not* run on every app open.

2. **Chart performance**
   - Make time-range switching (1W / 1M / 3M / 6M / 1Y / All) fast and smooth (caching + off-main-thread work).

3. **Clean up primary actions**
   - Remove dual primary buttons on key screens.
   - Prefer a single clear primary action per screen.
   - Keep **system controls** instead of custom dupes.

4. **Settings clean-up**
   - Remove the **quick action button** from the Settings screen.
   - Basic Settings sections:  
     - Account & Profile  
     - Goals  
     - Data & Integrations  
     - Notifications  
     - Appearance & Behavior  

5. **Health integration presets (core)**
   - Read latest Health data for:
     - Height  
     - Weight  
     - Body fat %
   - Use these as **presets** in onboarding/settings and clearly label:
     - “Preset from Apple Health. Adjust if needed.”
   - Height stays editable and becomes LogYourBody’s source of truth once edited.

6. **Full-screen metric chart + entry list**
   - For each metric (weight, BF%, FFMI, etc.):
     - Full-screen chart at top (current design).
     - Under it: scrollable list of individual entries grouped by **month** with headers (e.g., “September 2025”).
     - Each row shows value + unit, date, and a **source icon**:
       - Manual vs generic “integration” icon.

7. **Edit & delete entries from full-screen chart**
   - Tapping a row opens a **bottom sheet** like your screenshot:
     - Date + metric name header; close `X`; delete (trash) button.
     - Banner if data came from an integration:
       - Message: “Data for this day was populated from your Health integration. Manually entering data here will override the synced data.”
     - Editable numeric fields (weight, BF%, etc.) with numeric keypad.
     - Save → updates entry & chart; Delete → removes entry after confirmation.

8. **Basic goals system**
   - One active goal per metric.
   - Types:
     - **Daily goal:** steps.
     - **Overall goal:** weight, BF%, FFMI.
   - Each metric detail screen shows:
     - Current value.
     - Goal line (e.g., “Goal today: 8,000 steps”, “Goal: 180 lbs”).

9. **Goal presets & defaults**
   - **Weight goal:**
     - Determine current weight (LogYourBody latest, else HealthKit).
     - Offer presets:
       - `-5 lbs`, `-10 lbs`, `-20 lbs` from current weight (chips).
   - **BF% goal:**
     - Default to **8% for male**, **18% for female**.
     - Show current BF% (from app or Health) with source note.
   - All goals always allow manual override.

10. **Minimal “Goals” overview screen**
    - List core metrics with:
      - Current value
      - Goal
      - Simple progress indicator (bar or %).

---

## Tier 1 – High-leverage differentiators (strong v1.1 stuff)

11. **Body Score (0–100)**
    - Based on smoothed FFMI + BF%:
      - 100 = **FFMI 22 @ 8% BF** (male anchor).
      - Weighted combo (e.g., 60% FFMI, 40% BF%).
    - Large display on main screen with short breakdown:
      - “Muscle (FFMI): x / 1.0”
      - “Leanness (BF%): y / 1.0”.
    - Uses 7-day averages to avoid noise.

12. **Body Score share card (viral loop)**
    - One-tap share that generates an image:
      - Big Body Score number.
      - Optional FFMI/BF% line.
      - LogYourBody branding.
    - Trigger a “Share?” prompt on major milestones (e.g., 70 / 80 / 90).

13. **Aesthetic circumferences input**
    - Log time-series for:
      - Shoulders, chest, waist, hips, plus height reuse.
    - Simple numeric forms; logged less often (weekly/monthly).

14. **Aesthetic ratios computation**
    - For males: shoulder/waist, waist/chest, waist/hip, waist/height, BF%.
    - For females: waist/hip, waist/height, BF%.
    - Use your config (`ideal`, `range`, `unit`) to compute:
      - in-range vs out-of-range,
      - distance to ideal,
      - closeness to range (0–100).

15. **Aesthetic metric UI**
    - For each ratio:
      - Value + unit.
      - Status pill: “In ideal range” / “Above ideal” / “Below ideal”.
      - Subtext: e.g., “0.08 above ideal range” or “4% above ideal range”.
      - Horizontal bar from min→max with ideal tick and user marker.

16. **Integration status indicator**
    - In Data & Integrations:
      - Show connected status and last sync time for Health (and future integrations).
      - Basic feedback if sync is stale or disabled.

17. **Logging quality-of-life**
    - App-icon quick actions: “Log weight”, “Log BF”, etc.
    - Show last few values as one-tap options when logging.
    - Auto units based on region with override in settings.

18. **Basic personalization**
    - Default start screen setting:
      - Last metric / Body Score / Goals.
    - Default chart time-range preference per user.

---

## Tier 2 – Later / advanced features

19. **Smarter insights (no adherence)**
    - Weekly summary card (weight change, avg weight, simple trend arrow).
    - “Goal zone” shading on charts (for BF%, weight, Body Score).
    - Lightweight milestone badges (e.g., -5 lbs, first time in BF% range).

20. **Context features (deferred)**
    - Notes and tags on entries (“travel”, “sick”, “high carb”, etc.).
    - Events overlay on charts (vacation, deload, etc.).

21. **Coach / power-user tools**
    - Read-only coach view / sharing.
    - Metric export (CSV/JSON).

22. **Conflict resolution logic (deeper)**
    - Beyond the simple “manual overrides integration” rule:
      - Smarter merging of Health vs manual when both exist for the same date.
    - You’ve explicitly said: **hold this until we think it through carefully.**

23. **Richer dashboard**
    - At-a-glance home with cards for key metrics, trends, and quick actions.

---

If you want, next step I can turn the **Tier 0 list** into a super-tight project plan with suggested implementation order and which pieces can be worked on in parallel (e.g., one dev on metrics/entries + edit sheet, another on goals + Health presets).


Yes


Alright Mr. White, here’s a tight MVP plan built off that list, with order + what can run in parallel.

---

## Phase 1 – Core stability & UX basics

**Goal:** App opens cleanly, feels responsive, and UI isn’t confusing.

### 1. Onboarding state (P0)
**Why first:** A busted first-run flow poisons everything else.

- **Tasks**
  - Add `hasCompletedOnboarding` (and version field if needed).
  - On launch, route:
    - `!hasCompletedOnboarding` → onboarding.
    - `hasCompletedOnboarding` → main screen.
  - Make sure app updates don’t re-trigger onboarding.

- **Done when**
  - You can force-close/reopen and land directly on main screen every time after completing onboarding.

---

### 2. Chart performance (P0)
**Why now:** Charts are the core of the product.

- **Tasks**
  - Profile time-range switches (1W/1M/3M/6M/1Y/All).
  - Add data caching / precomputed downsampled series per range.
  - Move heavy transforms off main thread.
  - Cap point count per range (e.g., decimation for long histories).

- **Done when**
  - Range switch is effectively instant and jank-free on a midrange iPhone.

---

### 3. Action hierarchy + Settings cleanup (P0)

You want a sane, non-confusing shell before deeper features.

#### 3a. Remove dual primary actions
- **Tasks**
  - For each main screen, choose a single primary action.
  - Demote or move secondaries into menus/toolbar.
  - Replace custom controls with system equivalents where you have duplicates.

#### 3b. Settings clean + remove quick action
- **Tasks**
  - Remove the “quick action button” from Settings.
  - Restructure Settings into:
    - Account & Profile
    - Goals
    - Data & Integrations
    - Notifications
    - Appearance & Behavior
- **Done when**
  - No screen has competing primary CTAs.
  - Settings looks boringly predictable (in a good way).

> **Parallelization:**  
> - Dev A: onboarding + settings + primary actions  
> - Dev B: chart performance  

---

## Phase 2 – Metric history & editing

**Goal:** Full-screen charts feel like a serious tracking tool.

### 4. Full-screen metric chart + entry list (P0)

- **Tasks**
  - Under each metric chart (weight, BF%, FFMI, etc.), add:
    - Scrollable list of entries.
    - Group by month with headers (“September 2025”, etc.).
    - Each row: value + unit, date, source icon (manual vs integration).
  - Make this one reusable component driven by `metricType`.

- **Done when**
  - You can scroll history for any metric, clearly see month headers and source icons.

### 5. Edit/delete entry via bottom sheet (P0)

- **Tasks**
  - Make each row tappable.
  - On tap, open bottom sheet like the screenshot:
    - Header with date + metric name, close `X`, delete icon.
    - Integration banner if from Health (“…populated from your Health integration…”).
    - Editable fields (weight, BF%, etc.) with numeric keypad.
    - Save → updates entry + chart; Delete → confirmation + remove.
    - Manual edits override integration values for that date.

- **Done when**
  - You can correct or delete any recorded value from the chart screen and see the chart/list reflect it instantly.

> **Parallelization:**  
> - Dev A: build list + grouping + source icons.  
> - Dev B: build bottom sheet component and wire edit/delete flows.

---

## Phase 3 – Health presets & goals

**Goal:** App feels smart out of the box and goal-driven, not manual-only.

### 6. HealthKit presets (height, weight, BF%) (P0)

- **Tasks**
  - On first load of height:
    - Pull latest from HealthKit → pre-fill.
    - Show note: “Preset from Apple Health. Adjust if needed.”
  - In goal flows, pull latest weight/BF%:
    - Display current value + source (“from Apple Health” / “logged in LogYourBody”).
  - Never overwrite a user-edited field silently (their manual value wins inside LogYourBody).

- **Done when**
  - On a device with Health data, height/weight/BF% fields come in pre-filled with HK values + source note, and can be edited.

---

### 7. Basic goal system (P0)

#### 7a. Goal model + logic
- **Tasks**
  - Unified goal object:
    - `metricType` (steps, weight, body_fat_percentage, ffmi)
    - `goalKind`: `daily` | `overall`
    - `targetValue` (and later range if needed)
    - `unit`, `deadlineDate?`, `active`
  - Enforce one active goal per metric.
  - For steps (daily):
    - Per-day evaluation: `todaySteps >= targetValue`.
  - For weight/BF%/FFMI (overall):
    - Store baseline at time of goal creation.
    - Basic progress function current→target (cut vs bulk, etc.).

#### 7b. Goals UI in metric screens
- **Tasks**
  - On each metric screen:
    - Show current value.
    - Show goal line underneath:
      - Steps: `Goal today: 8,000 steps`
      - Weight: `Goal: 180 lbs`
      - BF%: `Goal: 10%`
      - FFMI: `Goal: 21.0`
    - Small “Edit goal” affordance to open editor.

---

### 8. Goal presets & defaults (P0)

- **Weight goal:**
  - Get “current weight” (LogYourBody latest, else HealthKit).
  - Preset chips:
    - `-5 lbs`
    - `-10 lbs`
    - `-20 lbs`
  - Selecting a chip sets `targetValue = currentWeight - X`. User may still edit.

- **BF% goal:**
  - Default targets:
    - Male → 8%
    - Female → 18%
  - Show current BF% with source note.
  - Allow manual override.

- **Done when**
  - Creating/editing weight/BF% goals feels like “tap a sensible preset and tweak,” not typing from scratch.

---

### 9. Minimal “Goals” overview screen (P0)

- **Tasks**
  - List all metrics that have goals:
    - Metric name
    - Current value
    - Goal
    - Simple progress bar or %.
  - Tap → jump into that metric’s goal editor.

- **Done when**
  - There is a single screen where you can see all active goals and how close you are.

> **Parallelization:**  
> - Dev A: HealthKit preset wiring.  
> - Dev B: goal model + backend logic.  
> - Dev C (or same as B sequentially): goals UI in metric screens + overview screen + presets.

---

## Suggested implementation order (short list)

1. Onboarding flag + Settings cleanup + single primary actions.  
2. Chart performance improvements.  
3. Full-screen entry list + edit/delete bottom sheet.  
4. HealthKit presets for height/weight/BF%.  
5. Goal model + per-metric goal UI.  
6. Weight/BF% presets + Goals overview screen.

Once those are in and stable, you’re in a legit MVP state where everything feels coherent; then we layer in Body Score + aesthetic ratios as the differentiator pass.


## See Also
- [[chatgpt/chatgpt_metric-entries-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part2]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_accident-liability-and-insurance-part2]]
