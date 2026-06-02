
Alright Mr. White, let’s lock this in so you can hand it straight to your AI coding agent.

I’ll do two things:

1. **Write the exact copy for the updated Body Score screen** (with the email CTA etc.).  
2. **Give you a single, ready-to-paste prompt** that fully specs the onboarding flow and how to modify existing screens.

---

## 1) Copy for the updated Body Score screen

You can drop this into Figma / code as-is. Use variables like `{{body_score}}`, `{{score_band_label}}`, etc.

**Screen: Body Score Reveal**

- **Main title / number area:**

> **Your Body Score**  
> **{{body_score}} / 100**

- **Subtitle / vibe line (based on band):**

Examples by band:

- Score 80–89:  
  > “Dialing it in.”
- Score 70–79:  
  > “Solid base. Room to tighten up.”
- Score 60–69:  
  > “Good starting point. Big upside.”
- Score <60:  
  > “You’re earlier in the journey, but the upside is huge.”

So in code:

> **{{score_band_tagline}}**

- **Bullets (3) explaining their status, using ranges / percentiles:**

Example template:

> • You’re leaner than about **{{lean_percentile}}%** of people your age and sex.  
> • Your muscle level (FFMI) is **{{ffmi_status}}** for your height.  
> • Getting to around **{{target_bf_range}}%** body fat would put you in **“{{target_label}}”** territory for your frame.

Where:
- `{{lean_percentile}}` = e.g. 60  
- `{{ffmi_status}}` = “decent”, “above average”, “elite”, etc.  
- `{{target_bf_range}}` = “8–10”  
- `{{target_label}}` = “model-lean”, “movie-lean”, etc.

- **Primary CTA (to trial / account):**

> **Button (primary):** `Build my Body HUD`

Subtext under the button (small):

> Start a free 3-day trial. Annual plan. Cancel anytime.

- **Secondary CTA (email capture, no account):**

Below primary button:

> **Text + field or smaller button:**  
> `Email me my full body report`

If it opens a sheet, that sheet copy:

> **Title:**  
> Email your report  
>   
> **Body:**  
> We’ll send you your Body Score, what it means, and a link to build your HUD later.  
>   
> **Field:** Email address  
> **Button:** `Send my report`

- **Tertiary CTA (share):**

> `Share my score`

When tapped, generate a shareable card like:

> **Body Score: {{body_score}} / 100**  
> “{{score_band_tagline}}”  
> “Leaner than {{lean_percentile}}% of people your age.”  
> [LogYourBody logo + link]

That’s the core copy.

---

## 2) Full onboarding spec as a prompt for your AI coding agent

Here’s the prompt you asked for, in one block so you can paste it directly:

```text
You are updating the onboarding flow for the LogYourBody iOS app.

Goal:
- Implement a fast, low-friction onboarding that calculates and reveals a “Body Score” BEFORE account creation or paywall.
- After showing the Body Score, drive users into:
  - (A) account creation + annual-only subscription with a 3-day trial, and
  - (B) optional email capture for users who don’t want to register yet.
- Remove any “current goal” questions from pre-score onboarding (e.g. “Are you trying to lose weight / gain muscle / recomp?”). We may add goal-based segmentation later inside the app, but NOT in the pre-score quiz.

Important constraints:
- If an onboarding screen already exists in the current codebase, REUSE it and update the copy / logic as described below.
- Only create new screens where needed.
- Remove or skip any existing pre-score questions that are not strictly necessary to compute Body Score (e.g., fitness goals, training frequency, etc.).
- The Body Score should be based on: sex, age (or birth year), height, weight, and body fat % (either exact, from Apple Health, or estimated via a visual picker).
- Name and email should be collected ONLY at or after account creation, NOT before the initial score reveal.
- Billing model: annual-only subscription, with a 3-day free trial, using the existing paywall implementation if present (just update the copy accordingly).

Implement the following flow:

===================================================
1. Hook screen – “Get your Body Score”
===================================================

If we already have an initial “welcome” screen, update it to the following structure. If not, create this as the first onboarding screen.

- Title:
  "Get your Body Score"

- Subtitle:
  "See how good you look on paper – based on muscle, leanness, and aesthetics."

- Bullet points (3):
  - "Estimate your Body Score in 60 seconds"
  - "See how you compare to people like you"
  - "Get a live HUD for your physique"

- Primary button:
  "Get my Body Score"
  -> Goes to the Sex & Birth Year screen.

- Secondary text/button:
  "Already have an account? Log in"
  -> Goes to existing login flow.

===================================================
2. Basic info – Sex & Birth Year
===================================================

Check if we already have screens for sex and birth year. If so, adapt them; if not, create a single combined screen.

- Title:
  "Let’s start with the basics"

- Fields:
  - Sex at birth (segmented control or similar): 
    Options: "Male", "Female", "Other"
  - Year of birth (picker or numeric text input)

- Helper text:
  "We use this to interpret your body metrics correctly."

- Button:
  "Continue"
  -> Goes to Height screen.

===================================================
3. Height
===================================================

If a height screen already exists, reuse it and just adjust copy; otherwise create it.

- Title:
  "How tall are you?"

- Field:
  - Height selector with unit toggle ("cm" / "ft+in")

- Helper:
  "We use this to calculate your muscle index (FFMI)."

- Button:
  "Continue"
  -> Goes to Apple Health connect screen.

===================================================
4. Apple Health connect (optional but strongly suggested)
===================================================

If we already have an Apple HealthKit permission / connect screen, reuse it and align the copy; otherwise create it.

- Title:
  "Connect to Apple Health?"

- Subtitle:
  "We’ll auto-fill your weight, body fat %, and more. You stay in control of what we see."

- Buttons:
  - Primary: "Connect Apple Health"
    -> Initiates HealthKit permission flow.
  - Secondary: "Not now"
    -> Skips straight to manual weight screen (Step 5).

After a successful HealthKit connection:
- Try to read: latest height, weight, body fat %, birth date (to confirm age), and any other relevant body metrics.
- Present a confirmation screen summarizing what we found:

  Title:
  "Here’s what we found"

  Body:
  - "Height: [value]"
  - "Latest weight: [value]"
  - "Body fat: [value]" (if available)

  Buttons:
  - "Looks right" -> Accepts these as defaults and continues.
  - "Edit" -> Allows user to correct any of these values manually.

After confirmation, skip any redundant manual screens (e.g., if we already have weight and BF%, we do not need to ask those again). Go directly to the Body Fat Known/Unknown logic if needed, or to calculation if everything is present.

===================================================
5. Manual weight (only if not available from Apple Health)
===================================================

Only show this screen if we do NOT have a valid current weight from Apple Health.

- Title:
  "What do you weigh right now?"

- Field:
  - Weight input with unit toggle (kg / lb)

- Helper:
  "A rough number is fine. You can refine this later."

- Button:
  "Continue"
  -> Goes to Body Fat Known/Unknown screen.

===================================================
6. Body Fat % – known vs unknown
===================================================

If we already have body fat questions, reuse them but enforce this structure.

Screen A: Ask if they know it

- Title:
  "Do you know your body fat %?"

- Options (buttons):
  - "Yes, I know it"
  - "No, not really"

- Logic:
  - If "Yes" -> show Body Fat numeric input screen.
  - If "No" -> show Body Fat visual picker screen.

Screen B: Body Fat numeric input (if Yes)

- Title:
  "Enter your body fat %"

- Field:
  - Numeric input, e.g. "Body fat %"

- Helper:
  "If you have a DEXA scan, use that number. Otherwise use your best estimate."

- Button:
  "Continue"
  -> Goes to calculation/loading screen.

Screen C: Body Fat visual picker (if No)

- Title:
  "Which of these looks most like you?"

- UI:
  - Grid or horizontal picker of 6–8 silhouettes or reference physiques for the user’s sex.
  - Each option should be labeled with a range, for example:
    - "Very lean (6–9%)"
    - "Lean (10–13%)"
    - "Fit (14–17%)"
    - "Average (18–22%)"
    - "Soft (23–27%)"
    - "Over 28%"

- Logic:
  - Selecting an option maps internally to an approximate body fat % (e.g., the midpoint of the range).
  - Store this estimated BF% for the Body Score calculation.

- Button:
  "Continue"
  -> Goes to calculation/loading screen.

===================================================
7. (REMOVE) Pre-score “Current Goal” questions
===================================================

IMPORTANT:
- If there is currently any onboarding screen BEFORE the Body Score reveal that asks things like:
  - "What is your current goal?"
  - "Lose fat / Build muscle / Recomp / Maintain"
- REMOVE those screens from the pre-score flow.
- The Body Score should NOT depend on the user’s stated goal.
- We may reintroduce goal selection later INSIDE the logged-in experience (e.g., in settings or as part of goal setup), but NOT before the first score.

===================================================
8. Body Score calculation loading screen
===================================================

Create or adapt a small loading/transition screen between the last input and the score reveal.

- Title:
  "Calculating your Body Score…"

- Subtext:
  Cycle through 2–3 fun status messages while we compute:
  - "Analyzing leanness…"
  - "Estimating muscularity (FFMI)…"
  - "Checking aesthetics vs ideal…"

- This screen should only show briefly while computation is done, then automatically navigate to the Body Score reveal screen.

===================================================
9. Body Score reveal screen (core dopamine hit)
===================================================

This MUST NOT require an account or payment. Show the user their score immediately.

Structure:

- Title:
  "Your Body Score"

- Main number:
  "[[body_score]] / 100"
  (large, centered or left-aligned hero number)

- Subtitle (band-based tagline), e.g.:
  - Score 80–89: "Dialing it in."
  - Score 70–79: "Solid base. Room to tighten up."
  - Score 60–69: "Good starting point. Big upside."
  - Score <60: "You’re earlier in the journey, but the upside is huge."

- Three explanatory bullet points, using variables:
  - "You’re leaner than about [[lean_percentile]]% of people your age and sex."
  - "Your muscle level (FFMI) is [[ffmi_status]] for your height."
  - "Getting to around [[target_bf_range]]% body fat would put you in “[[target_label]]” territory for your frame."

- Primary button:
  Label: "Build my Body HUD"
  Behavior:
  - Navigates to account creation (Sign up / Log in).
  - This is the path that will lead into the paywall and free trial.

- Secondary CTA (email capture, no account yet):

  Option 1 – Inline small button:
  - Label: "Email me my full body report"
  - On tap: open a sheet/modal:

    Title:
    "Email your report"

    Body:
    "We’ll send you your Body Score, what it means, and a link to build your HUD later."

    Field:
    - Email address

    Button:
    - "Send my report"
      -> Call backend endpoint to send email and store this email & score for future re-engagement.

  After email is submitted, dismiss the sheet and keep the user on the score screen (they can still choose to build the HUD).

- Tertiary CTA:
  Label: "Share my score"
  - On tap: open the existing share sheet or a new one that exports an image/card like:
    - "Body Score [[body_score]] / 100"
    - "[[score_band_tagline]]"
    - "Leaner than [[lean_percentile]]% of people your age."
    - Include LogYourBody logo + link.

===================================================
10. Account creation (after score)
===================================================

When the user taps "Build my Body HUD" from the score screen:

If we already have a signup screen, reuse it but ensure the copy and fields follow this structure.

- Title:
  "Save your Body Score"

- Subtitle:
  "Create an account to save your score and build your live body HUD."

- Benefits (bullets):
  - "Track your score over time"
  - "Get a daily HUD and projections"
  - "Sync with DEXA scans and progress photos"

- Buttons:
  - "Continue with Apple"
  - "Continue with Google"
  - "Use email"

If using email:

- Fields:
  - Email
  - Password
  - OPTIONAL: Name (we want this here, not earlier in the flow)

Do NOT ask for name before this point. If name is present in the current DB model, make it optional or ask it here.

After account creation, proceed to the subscription paywall.

===================================================
11. Subscription paywall (annual-only, 3-day trial)
===================================================

After successful account creation, show a paywall.

If an existing paywall view already exists, reuse it but update the copy.

- Title:
  "Unlock your Body HUD"

- Subtitle:
  "Start your free 3-day trial. Annual plan. Cancel anytime."

- Features list (3–5 items max):
  - "Live Body Score updated with every weigh-in and scan"
  - "30-day projections (deficit, surplus, or maintenance)"
  - "Aesthetic metrics (FFMI, body fat %, waist ratio)"
  - "Progress photos and DEXA integration"
  - "Optional wall display mode for a full-screen HUD"

- Pricing:
  - Single plan: annual-only (e.g. "$59.99/year" or whatever is configured)
  - Show per-month equivalent if desired ("That’s less than $X/month").

- Primary button:
  "Start free 3-day trial"
  - Starts the annual subscription with a 3-day free trial using existing IAP/subscription logic.

If the existing design allows, there can be a subtle "X" or "Not now" to continue into a very limited free experience. For MVP, if business decision is HARD paywall, you can omit that secondary path and require the trial to proceed.

After the user starts the trial, navigate them to the main dashboard (Body HUD).

===================================================
12. Notes on removing / reusing existing onboarding logic
===================================================

- If the current onboarding includes:
  - Detailed goal questions (lose fat / gain muscle / recomp), 
  - Workout frequency,
  - Dietary preferences, etc.
  Those should NOT block the user from seeing their first Body Score. Remove them or move them to later post-onboarding flows.

- Keep only what’s needed for the Body Score in the pre-score onboarding:
  - Sex
  - Birth year or age
  - Height
  - Weight (from HealthKit or manual)
  - Body Fat % (from HealthKit, self-report, or visual estimation)

- Name and email should NOT be requested until the account creation step AFTER the Body Score reveal.

- After this update, the intended experience is:
  1) User downloads app.
  2) Taps "Get my Body Score".
  3) Answers 3–6 quick questions (or connects Apple Health).
  4) Sees Body Score with no account and no paywall.
  5) From that emotional high, they’re invited to:
     - Start a 3-day annual trial and build their HUD, and/or
     - Get their report emailed, and/or
     - Share their score.

Please:
- Refactor or add screens as needed to match this flow.
- Ensure navigation between screens follows the order defined here.
- Remove any obsolete onboarding screens that are no longer part of the pre-score flow.
- Keep all analytics / event tracking hooks, but update event names if needed to reflect the new steps (e.g., "onboarding_score_revealed", "onboarding_email_report_requested", "onboarding_trial_started").
```

If you want to refine this further, next step we could define the exact JSON event names / properties to track in onboarding, but this should be enough to get your coding agent to rebuild the flow in a sane way.


And then just a side note on like as as as to include in that prompt is um I do want I do want it to be like um we're using the iOS 26 SDK and I want to make sure that we use when we lean on system components or SwiftUI components as much as possible so that we automatically inherit the liquid class design that comes with iOS 26 and all of the components feel as native as possible. I want to minimize custom components and then I want to ensure that the whole onboarding is refactored as well to use atomic design so that there's a consistent look and feel across the entire onboarding and that we minimize code duplication.


Got it, Mr. White — totally makes sense to bake those implementation constraints right into the prompt.

Here’s an updated **single prompt** you can hand to your AI coding agent, with all the onboarding spec **plus** your iOS 26 / SwiftUI / atomic design requirements.

You can just copy-paste this:

```text
You are updating the onboarding flow for the LogYourBody iOS app.

High-level goals:
- Implement a fast, low-friction onboarding that calculates and reveals a “Body Score” BEFORE account creation or paywall.
- After showing the Body Score, drive users into:
  - (A) account creation + annual-only subscription with a 3-day trial, and
  - (B) optional email capture for users who don’t want to register yet.
- Refactor onboarding to use modern iOS 26 SDK and SwiftUI, leaning heavily on native system components to inherit the “liquid class” design language and feel as native as possible.
- Implement onboarding using an atomic design approach (atoms, molecules, organisms, templates, pages) to ensure:
  - Consistent look-and-feel across all onboarding screens.
  - Minimal code duplication.
  - Reusable building blocks for future onboarding changes.

Platform / implementation constraints:
- Use SwiftUI as the primary UI framework for the onboarding.
- Prefer system components and standard SwiftUI views (NavigationStack, Form, List, Section, Button, TextField, Picker, Toggle, etc.) rather than custom, heavily-styled components.
- Only create custom components when the system components fundamentally cannot express the desired UX; otherwise, compose system components into atomic design units.
- Refactor existing onboarding code into atomic design layers:
  - Atoms: labels, text styles, buttons, input fields, basic cards, icon+text rows.
  - Molecules: small combinations of atoms (e.g., a labeled input row with validation, a metric card).
  - Organisms: full screen sections (e.g., a complete “Body Score reveal section”, an Apple Health connect section).
  - Templates/pages: full onboarding screens composed from these organisms.
- Eliminate duplicated layouts / logic across onboarding screens by pulling common patterns into reusable SwiftUI views.

Now, implement or refactor the onboarding to follow this flow and copy:

===================================================
1. Hook screen – “Get your Body Score”
===================================================

If we already have an initial “welcome” screen, update it to the following structure. If not, create this as the first onboarding screen.

UI/UX:
- Use SwiftUI with native layout (e.g., VStack within a NavigationStack).
- Use standard Text and Button components with our atomic styles.

Content:
- Title:
  "Get your Body Score"

- Subtitle:
  "See how good you look on paper – based on muscle, leanness, and aesthetics."

- Bullet points (3), e.g. using a VStack of HStack(icon + text) molecules:
  - "Estimate your Body Score in 60 seconds"
  - "See how you compare to people like you"
  - "Get a live HUD for your physique"

- Primary button:
  Label: "Get my Body Score"
  Action: Goes to the Sex & Birth Year screen.

- Secondary text/button:
  "Already have an account? Log in"
  Action: Goes to existing login flow.

===================================================
2. Basic info – Sex & Birth Year
===================================================

Check if we already have screens for sex and birth year. If so, adapt them; if not, create a single combined screen using SwiftUI Forms/Sections for a native feel.

- Title:
  "Let’s start with the basics"

- Fields:
  - Sex at birth:
    - Use a Picker or segmented control-style Picker in SwiftUI.
    - Options: "Male", "Female", "Other"
  - Year of birth:
    - Use a Picker, DatePicker constrained to year, or a numeric TextField with appropriate keyboard.

- Helper text (small Text):
  "We use this to interpret your body metrics correctly."

- Button:
  "Continue"
  -> Goes to Height screen.

===================================================
3. Height
===================================================

If a height screen already exists, reuse it and just adjust copy; otherwise create it.

- Title:
  "How tall are you?"

- Field:
  - Height selector with unit toggle ("cm" / "ft+in")
  - Implement as reusable molecule (e.g. a HeightInputRow with unit toggle).

- Helper:
  "We use this to calculate your muscle index (FFMI)."

- Button:
  "Continue"
  -> Goes to Apple Health connect screen.

===================================================
4. Apple Health connect (optional but strongly suggested)
===================================================

If we already have an Apple HealthKit permission / connect screen, reuse it and align the copy; otherwise create it.

- Title:
  "Connect to Apple Health?"

- Subtitle:
  "We’ll auto-fill your weight, body fat %, and more. You stay in control of what we see."

- Buttons:
  - Primary: "Connect Apple Health"
    -> Initiates HealthKit permission flow.
  - Secondary: "Not now"
    -> Skips straight to manual weight screen (Step 5).

After a successful HealthKit connection:
- Try to read: latest height, weight, body fat %, birth date (to confirm age), and any other relevant body metrics.
- Present a confirmation screen summarizing what we found, using a native list/card:

  Title:
  "Here’s what we found"

  Body:
  - "Height: [value]"
  - "Latest weight: [value]"
  - "Body fat: [value]" (if available)

  Buttons:
  - "Looks right" -> Accepts these as defaults and continues.
  - "Edit" -> Allows user to correct any of these values manually (reuse the height/weight/BF input atoms/molecules).

After confirmation, skip any redundant manual screens (e.g., if we already have weight and BF%, we do not need to ask those again). Go directly to the Body Fat Known/Unknown logic if needed, or to calculation if everything is present.

===================================================
5. Manual weight (only if not available from Apple Health)
===================================================

Only show this screen if we do NOT have a valid current weight from Apple Health.

- Title:
  "What do you weigh right now?"

- Field:
  - Weight input with unit toggle (kg / lb).
  - Use a reusable WeightInputRow molecule.

- Helper:
  "A rough number is fine. You can refine this later."

- Button:
  "Continue"
  -> Goes to Body Fat Known/Unknown screen.

===================================================
6. Body Fat % – known vs unknown
===================================================

If we already have body fat questions, reuse them but enforce this structure. Use SwiftUI’s native layout (e.g., VStack + Buttons) and create reusable molecules for option buttons.

Screen A: Ask if they know it

- Title:
  "Do you know your body fat %?"

- Options (buttons):
  - "Yes, I know it"
  - "No, not really"

- Logic:
  - If "Yes" -> show Body Fat numeric input screen.
  - If "No" -> show Body Fat visual picker screen.

Screen B: Body Fat numeric input (if Yes)

- Title:
  "Enter your body fat %"

- Field:
  - Numeric input, e.g. "Body fat %"

- Helper:
  "If you have a DEXA scan, use that number. Otherwise use your best estimate."

- Button:
  "Continue"
  -> Goes to calculation/loading screen.

Screen C: Body Fat visual picker (if No)

- Title:
  "Which of these looks most like you?"

- UI:
  - Grid or horizontal scroll of 6–8 silhouettes or reference physiques for the user’s sex.
  - Each option labeled with a range, for example:
    - "Very lean (6–9%)"
    - "Lean (10–13%)"
    - "Fit (14–17%)"
    - "Average (18–22%)"
    - "Soft (23–27%)"
    - "Over 28%"

- Logic:
  - Selecting an option maps internally to an approximate body fat % (e.g., the midpoint of the range).
  - Store this estimated BF% for the Body Score calculation.

- Button:
  "Continue"
  -> Goes to calculation/loading screen.

===================================================
7. (REMOVE) Pre-score “Current Goal” questions
===================================================

IMPORTANT:
- If there is currently any onboarding screen BEFORE the Body Score reveal that asks things like:
  - "What is your current goal?"
  - "Lose fat / Build muscle / Recomp / Maintain"
- REMOVE those screens from the pre-score flow.
- The Body Score should NOT depend on the user’s stated goal.
- We may reintroduce goal selection later INSIDE the logged-in experience (e.g., in settings or as part of goal setup), but NOT before the first score.

===================================================
8. Body Score calculation loading screen
===================================================

Create or adapt a small loading/transition screen between the last input and the score reveal.

- Title:
  "Calculating your Body Score…"

- Subtext:
  Cycle through 2–3 fun status messages while we compute:
  - "Analyzing leanness…"
  - "Estimating muscularity (FFMI)…"
  - "Checking aesthetics vs ideal…"

- This screen should only show briefly while computation is done, then automatically navigate to the Body Score reveal screen.

Implement as a simple SwiftUI view with a ProgressView and cycling Text, using atomic design (e.g., a generic LoadingScreen organism).

===================================================
9. Body Score reveal screen (core dopamine hit)
===================================================

This MUST NOT require an account or payment. Show the user their score immediately.

Structure (as native SwiftUI):

- Title Text:
  "Your Body Score"

- Main number:
  "[[body_score]] / 100"
  - Large, using a Typography atom for headline / display.

- Subtitle (band-based tagline), e.g.:
  - 80–89: "Dialing it in."
  - 70–79: "Solid base. Room to tighten up."
  - 60–69: "Good starting point. Big upside."
  - <60: "You’re earlier in the journey, but the upside is huge."

- Three explanatory bullet points:
  - "You’re leaner than about [[lean_percentile]]% of people your age and sex."
  - "Your muscle level (FFMI) is [[ffmi_status]] for your height."
  - "Getting to around [[target_bf_range]]% body fat would put you in “[[target_label]]” territory for your frame."

- Primary button (atom styled consistently across app):
  Label: "Build my Body HUD"
  Behavior:
  - Navigates to account creation (Sign up / Log in) screen.

- Secondary CTA (email capture, no account yet):
  - Small button or tappable text:
    Label: "Email me my full body report"
    On tap: present a sheet/modal (SwiftUI .sheet) with:

    Title:
    "Email your report"

    Body text:
    "We’ll send you your Body Score, what it means, and a link to build your HUD later."

    Field:
    - Email address TextField.

    Button:
    - "Send my report"
      -> Calls backend to:
         - Store email and associated score.
         - Trigger email sending with score + explanation + link back to app.

    After success, dismiss sheet and keep user on the score screen.

- Tertiary CTA:
  Label: "Share my score"
  - On tap: use the native iOS share sheet to share an image or text card:
    - "Body Score [[body_score]] / 100"
    - "[[score_band_tagline]]"
    - "Leaner than [[lean_percentile]]% of people your age."
    - Plus LogYourBody link.

===================================================
10. Account creation (after score)
===================================================

When the user taps "Build my Body HUD" from the score screen:

If we already have a signup screen, reuse it but ensure the copy and fields follow this structure and that it uses SwiftUI and atomic design components.

- Title:
  "Save your Body Score"

- Subtitle:
  "Create an account to save your score and build your live body HUD."

- Benefit bullets:
  - "Track your score over time"
  - "Get a daily HUD and projections"
  - "Sync with DEXA scans and progress photos"

- Auth options:
  - Button: "Continue with Apple"
  - Button: "Continue with Google"
  - Button: "Use email"

For email signup:

- Fields:
  - Email TextField
  - Password SecureField
  - OPTIONAL TextField: Name (we want this here, not earlier in the flow; make optional if needed)

After successful account creation, proceed to the subscription paywall.

===================================================
11. Subscription paywall (annual-only, 3-day trial)
===================================================

After successful account creation, show a paywall.

If an existing paywall view already exists, reuse it but update the copy and ensure it uses SwiftUI and atomic components.

- Title:
  "Unlock your Body HUD"

- Subtitle:
  "Start your free 3-day trial. Annual plan. Cancel anytime."

- Features list (3–5 items max):
  - "Live Body Score updated with every weigh-in and scan"
  - "30-day projections (deficit, surplus, or maintenance)"
  - "Aesthetic metrics (FFMI, body fat %, waist ratio)"
  - "Progress photos and DEXA integration"
  - "Optional wall display mode for a full-screen HUD"

- Pricing:
  - Single plan: annual-only (e.g., "$59.99/year" or configured value)
  - Optionally show equivalent per-month cost for context.

- Primary button:
  "Start free 3-day trial"
  - Starts the annual subscription with a 3-day free trial using existing IAP/subscription logic.

If business logic dictates a hard paywall: omit free/limited-path buttons, and require starting the trial to proceed.

After the user starts the trial, navigate them to the main dashboard (Body HUD) screen.

===================================================
12. Notes on refactoring & atomic design
===================================================

- Audit the existing onboarding SwiftUI views:
  - Identify duplicated button styles, text styles, and layout patterns.
  - Extract them into atomic components:
    - Atoms: PrimaryButton, SecondaryButton, BodyText, CaptionText, SectionHeader, InputField, MetricLabel, etc.
    - Molecules: LabeledInputRow, UnitToggleRow (e.g. kg/lb), BulletListItem, ConfirmMetricsCard.
    - Organisms: OnboardingFormScreen, BodyScoreRevealSection, HealthConnectSection, PaywallSection.
- Replace ad-hoc styling with consistent atomic components (e.g., a single PrimaryButton style reused everywhere).
- Ensure typography, spacing, and corner radius match iOS 26 “liquid class” guidelines as much as possible by:
  - Using system fonts (SF) with standard weights/sizes.
  - Using system colors / dynamic colors for dark/light mode.
  - Using system controls (Buttons, TextFields, Pickers) and customizing lightly via modifiers, not full custom drawing.
- Remove or refactor any UIKit-based or legacy code paths in onboarding; onboarding should be purely SwiftUI for maintainability and consistency.

===================================================
13. Notes on removing / reusing existing onboarding logic
===================================================

- If the current onboarding includes:
  - Detailed goal questions (lose fat / build muscle / recomp),
  - Workout frequency,
  - Dietary preferences, etc.
  Those should NOT block the user from seeing their first Body Score. Remove them or move them to later post-onboarding flows.

- Keep only what’s needed for the Body Score in the pre-score onboarding:
  - Sex
  - Birth year or age
  - Height
  - Weight (from HealthKit or manual)
  - Body Fat % (from HealthKit, self-report, or visual estimation)

- Name and email should NOT be requested until the account creation step AFTER the Body Score reveal.

Final intended experience:
1) User downloads app.
2) Taps "Get my Body Score".
3) Answers 3–6 quick questions (or connects Apple Health).
4) Sees Body Score with no account and no paywall.
5) From that emotional high, they’re invited to:
   - Start a 3-day annual trial and build their HUD ("Build my Body HUD"),
   - Get their report emailed ("Email me my full body report"),
   - Share their score ("Share my score").

Please:
- Refactor or add SwiftUI screens as needed to match this flow.
- Use atomic design principles to avoid duplication and maintain a consistent visual language.
- Ensure navigation between screens follows the order defined here.
- Preserve or adapt analytics events (e.g., "onboarding_score_revealed", "onboarding_email_report_requested", "onboarding_trial_started") to track this flow.
```

If you want, I can also write a quick outline of what the **BodyScoreCalculator** API / struct should look like (inputs/outputs) so your agent has a clean separation between UI and scoring logic.


Liquid glass not liquid class.


Gotcha, Mr. White — **“liquid glass”**, not “liquid class.”  

To align with that:

Anywhere in the prompt I wrote:

> inherit the “liquid class” design language

mentally / literally replace with:

> inherit the **“liquid glass”** design language

If you want a clean snippet for the agent, here’s the only part that really needs to change:

```text
Platform / implementation constraints:
- Use SwiftUI as the primary UI framework for the onboarding.
- Prefer system components and standard SwiftUI views (NavigationStack, Form, List, Section, Button, TextField, Picker, Toggle, etc.) rather than custom, heavily-styled components.
- Only create custom components when the system components fundamentally cannot express the desired UX; otherwise, compose system components into atomic design units.
- Refactor existing onboarding code into atomic design layers:
  - Atoms: labels, text styles, buttons, input fields, basic cards, icon+text rows.
  - Molecules: small combinations of atoms (e.g., a labeled input row with validation, a metric card).
  - Organisms: full screen sections (e.g., a complete “Body Score reveal section”, an Apple Health connect section).
  - Templates/pages: full onboarding screens composed from these organisms.
- Eliminate duplicated layouts / logic across onboarding screens by pulling common patterns into reusable SwiftUI views.
- Ensure typography, spacing, and corner radius match iOS 26 “liquid glass” design as much as possible by:
  - Using system fonts (SF) with standard weights/sizes.
  - Using system colors / dynamic colors for dark/light mode.
  - Using system controls (Buttons, TextFields, Pickers) and customizing lightly via modifiers, not full custom drawing.
```

You can keep the rest of the big prompt exactly as-is.


Give me the whole prompt again now
