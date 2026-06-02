---
title: "Agent mode prompt"
type: essay
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
topic: coding-ai
message_count: 10
tags: [chatgpt, knowledge, coding-ai]
---
# Agent mode prompt

> **Source:** ChatGPT conversation
> **Date:** 2025-11-12T19:35:27Z
> **Messages:** 10
> **Topic:** coding-ai

## Question

I want chatgpt agent mode to go through actors access breakdowns.

It should search by "paying roles only" and "all breakdowns fit for me"

Then it should click on each role in yellow (which means its fit for me) and click the title to open it and submit me,

It needs to select my headshot (the second photo i have, unless it specifically talks about needing someone who is fit, has abs or is muscular ins which case it should pick the first photo where im showing off my physique).

Then it should check to include my reel and check to include my size card if relevant and finally click to submit. Then it should go back and do the same for all the other roles in search results.

When it gets to 10 roles, it should checkout the cart and pay (which will be free since i ahem a premium account) and checkout to finalize and submit all the submissions.

Then it should search again and filter out roles already submitted to.

It should do this for all roles that im fit for and keep going without us

## Answer

Mr. White — here’s a ready-to-paste agent prompt you can drop into the sidebar while you’re on the Actors Access Breakdown search page:

```
SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

OBJECTIVE
Submit the user to every “fit for me” paying role on Actors Access, choosing the correct media, batching checkouts in groups of 10, and repeating until there are zero new results left.

GLOBAL SETTINGS
- Human pacing: brief randomized waits (200–800ms) between actions; 1.5–3s after page transitions.
- Avoid changing any profile settings. Use current logged-in session.
- Track state in memory:
  • submitted_titles = set()
  • cart_count = 0
  • total_submitted = 0
  • failures = []
- Prefer stable UI labels over colors. Only use “yellow” as a fallback visual cue.

FILTERS (apply first, then re-apply whenever you loop)
1) Set filter to show **Paying roles only** (or “Paid” = Yes).
2) Set filter to **All breakdowns fit for me** (a.k.a. “Fit for Me”, “Matches My Profile”, or results with the “fit” badge / yellow highlight).
3) If available, enable **Hide submitted** or an equivalent exclusion for roles already submitted to.

KEYWORDS FOR MEDIA SELECTION
- Physique-positive keywords (case-insensitive): ["fit","athletic","muscular","muscle","abs","six-pack","ripped","toned","physique","fitness","shirtless","swimmer body","model-type","bodybuilder","lean build","in-shape"]
- Size/measurements relevance keywords: ["size","sizes","measurements","wardrobe","suit","inseam","waist","chest","height","weight","build","jacket","shoe"]

MEDIA POLICY
- Headshot:
  • Default: select the **second photo**.
  • If the breakdown text contains any physique-positive keyword, select the **first photo** (physique-forward).
- Always check/include the **reel** (demo reel) if a toggle/checkbox exists or if a reel picker is offered.
- Include **size card** if any size/measurement/wardrobe keyword is present in the role or notes. Otherwise, leave size card off.

WORKFLOW
A) Ensure you are on the Breakdown search/results view with filters visible. Apply FILTERS above, then run the search.

B) Iterate over paginated results:
   1) Identify roles that are marked "fit" for the user (badge/label indicating “Fit for Me”). If that signal is unreliable, use yellow-highlighted roles as a fallback.
   2) For each fit role not already in submitted_titles:
      - Open the role by clicking the **title**.
      - If there is any visible status like “Submitted” or “Already Submitted,” add the title to submitted_titles and go back.
      - Otherwise, proceed to submit:
         i) Click the **Submit / Apply** button.
        ii) On the submission form:
            -

*(Answer truncated — 6148 chars total)*

## Question

on projects with multiple roles available choose the ones that best fits me
im a male that looks 28-30, im white, 6'4", ripped and muscular, and i tend to be good at stoic performances or intimate scenes, bad boy roles or hot guy roles etc.

## Answer

Mr. White — got it. Here’s the upgraded, drop-in agent prompt with your fit profile and multi-role selection logic baked in:

```
SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

OBJECTIVE
Submit the user to every “fit for me” paying role on Actors Access, choosing the best-fit role(s) per project using the Fit Profile + Fit Score below, batching checkout in groups of 10, and repeating until there are zero new results left.

FIT PROFILE (for matching decisions)
- Gender: male
- Apparent age: 28–30 (target ranges 25–35; allow 23–37 if otherwise ideal)
- Ethnicity: white / Caucasian (include “Any/All ethnicities”)
- Height: 6'4" (very tall)
- Build: ripped, muscular, athletic
- Strengths: stoic/intense/brooding, intimate scenes, “bad boy”, “hot guy”/romantic lead
- Weaker fit: broad slapstick/comedic nerd/quirky goofball

GLOBAL SETTINGS
- Human pacing: brief randomized waits (200–800ms) between actions; 1.5–3s after page transitions.
- Avoid changing any profile settings. Use current logged-in session.
- Track state in memory:
  • submitted_titles = set()
  • cart_count = 0
  • total_submitted = 0
  • failures = []
- Prefer stable UI labels over colors; use “yellow” highlight only as a fallback visual cue.

FILTERS (apply first, then re-apply whenever you loop)
1) Enable **Paying roles only** (Paid = Yes).
2) Enable **All breakdowns fit for me** (Fit/Matches My Profile, or “fit” badge).
3) If available, enable **Hide submitted** (or equivalent).

MEDIA POLICY
- Headshot:
  • Default: select the **second photo**.
  • If role text contains physique-positive language (e.g., fit, athletic, muscular, abs, six-pack, ripped, toned, physique, shirtless, swimmer body, model-type, bodybuilder, lean, in-shape), choose the **first photo** (physique-forward).
- Always include **reel** if a toggle or picker exists.
- Include **size card** when the role mentions measurements/wardrobe/size (size, sizes, measurements, wardrobe, suit, inseam, waist, chest, height, weight, build, jacket, shoe). Otherwise omit.

FIT SCORE (use to pick roles within multi-role projects and to skip poor matches)
Start each role at 0 and add/subtract:
+10 if explicitly “Male”; +5 if “Any gender”.
+8 if age range squarely spans 27–33; +6 if 25–35; +5 if 21–35; +3 if 23–37; 0 if 18–25 or 35–40 but other signals are strong; **skip** if <18 or >45 unless text says “looks 28–30”.
+6 if ethnicity is “White/Caucasian”; +4 if “Any/All ethnicities”; **skip** if requires a different specific ethnicity.
+6 if “athletic/muscular/ripped/fit/toned/physique”; +3 if “tall” or 6'2"+; +2 if “athletic or average”; −3 if “heavyset” or “soft body” is specified.
+5 if vibe keywor

*(Answer truncated — 7636 chars total)*

## Question

Never apply to more than one role per project.
Skip roles that pay less than 20/hr (if day rate, assume 8 hr day to calculate). 

## Answer

Mr. White — here’s the tightened, drop-in agent prompt with your new constraints (one role per project; pay floor $20/hr using 8-hr day assumption):

```
SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

OBJECTIVE
Submit the user to every “fit for me” paying role on Actors Access, enforcing the Pay Gate and selecting at most one best-fit role per project, batching checkout in groups of 10, and repeating until zero new results remain.

FIT PROFILE
- Male; looks 28–30 (primary band 25–35; allow 23–37 if ideal)
- White/Caucasian; height 6'4"; build: ripped/muscular/athletic
- Strengths: stoic/intense/brooding, intimate scenes, “bad boy”, “hot guy”/romantic lead
- Weaker fit: slapstick/quirky goofball

GLOBAL SETTINGS
- Human pacing: 200–800 ms between actions; 1.5–3 s after page transitions.
- Use current logged-in session only.
- State:
  • submitted_titles = set()
  • cart_count = 0
  • total_submitted = 0
  • failures = []
  • skipped = []  // keep brief reason (e.g., pay < $20/hr)
- Prefer stable UI labels over color; use yellow “fit” highlight only as fallback.

FILTERS (apply on each loop)
1) **Paying roles only** (Paid = Yes).
2) **All breakdowns fit for me** (Fit/Matches My Profile, “fit” badge).
3) Enable **Hide submitted** (or equivalent) if available.

MEDIA POLICY
- Headshot: default = **second photo**; if physique-forward keywords appear (fit/athletic/muscular/abs/six-pack/ripped/toned/physique/shirtless/swimmer body/model-type/bodybuilder/lean/in-shape) use **first photo**.
- Always include **reel** when a toggle/picker exists.
- Include **size card** only if text mentions size/measurements/wardrobe (size/sizes/measurements/wardrobe/suit/inseam/waist/chest/height/weight/build/jacket/shoe).

PAY GATE (hard requirement; skip if not met)
- Extract pay text; normalize ranges using the **lower bound**.
- If hourly: require **≥ $20/hr**.
- If day rate: compute hourly_est = day_rate/8; require **≥ $20/hr**.
- If week rate: use hourly_est = week_rate/40; require **≥ $20/hr**.
- If “SAG-AFTRA scale/union scale”: treat as pass (≥ $20/hr).
- If only “flat/stipend/TBD/negotiable/deferred/copy-credit-meal” with no convertible hours → **skip**.
- Currency assumed USD; if non-USD or ambiguous with no floor → **skip**.
- On skip, add {project, role, reason} to **skipped**, then return to results.

FIT SCORE (for choosing the single role within a project)
Start at 0:
+10 Male; +5 Any gender
+8 age range covers 27–33; +6 for 25–35; +5 for 21–35; +3 for 23–37; skip if <18 or >45 unless text says “looks 28–30”
+6 White/Caucasian; +4 Any/All ethnicities; skip if a different specific ethnicity is required
+6 athletic/muscular/ri

*(Answer truncated — 6804 chars total)*

## Question

Yes and also note Projects with a red check to the left have already been submitted on so they can be ignored


## Answer

Mr. White — here’s your tightened, drop-in agent prompt with the new rules (skip red-check projects; background only if ≥ $40/hr):

```
SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

OBJECTIVE
Submit the user to every “fit for me” paying role on Actors Access, enforcing the Pay Gate and “one role per project,” batching checkout in groups of 10, and repeating until zero new results remain.

FIT PROFILE
- Male; looks 28–30 (primary band 25–35; allow 23–37 if ideal)
- White/Caucasian; 6'4"; ripped/muscular/athletic
- Strengths: stoic/intense/brooding, intimate scenes, “bad boy,” “hot guy”/romantic lead
- Weaker fit: slapstick/quirky goofball

GLOBAL SETTINGS
- Human pacing: 200–800 ms between actions; 1.5–3 s after page transitions.
- Use current logged-in session only.
- State:
  • submitted_titles = set()
  • cart_count = 0
  • total_submitted = 0
  • failures = []
  • skipped = []  // {project, role, reason}
- Prefer stable UI labels over color cues; use highlight colors only as fallback.

FILTERS (apply each loop)
1) **Paying roles only** (Paid = Yes).
2) **All breakdowns fit for me** (Fit/Matches My Profile or “fit” badge).
3) Enable **Hide submitted** (or equivalent) if available.

ALREADY-SUBMITTED UI MARKERS (skip immediately)
- Projects with a **red check icon to the left** → treat as already submitted; ignore without opening.
- Any explicit “Submitted/Already Submitted” status on a project/role.

MEDIA POLICY
- Headshot: default = **second photo**; if role text contains physique-forward terms (fit, athletic, muscular, abs, six-pack, ripped, toned, physique, shirtless, swimmer body, model-type, bodybuilder, lean, in-shape) use **first photo**.
- Always include **reel** when a toggle/picker exists.
- Include **size card** only if size/measurement/wardrobe terms appear (size, sizes, measurements, wardrobe, suit, inseam, waist, chest, height, weight, build, jacket, shoe).

PAY GATE (hard requirement; skip if not met)
- Parse pay text; normalize using the **lower bound** of any range.
- Hourly: require **≥ $20/hr**.
- Day: hourly_est = day_rate/8; require **≥ $20/hr**.
- Week: hourly_est = week_rate/40; require **≥ $20/hr**.
- “SAG/union scale”: treat as pass (≥ $20/hr).
- Flat/stipend/TBD/negotiable/deferred/copy-credit-meal with no convertible hours → **skip**.
- Non-USD or ambiguous with no floor → **skip**.

BACKGROUND RATE EXCEPTION (stricter floor)
- For Background/Extra/Photo Double/Stand-In roles, require **≥ $40/hr equivalent** using the same conversions above.
- If < $40/hr equivalent → **skip** (reason: “background < $40/hr”).

FIT SCORE (for choosing the single role within a project)
Start 0:
+10 Male

*(Answer truncated — 7073 chars total)*

## Question

Add my instagram url to the 4th section on each submission where it lets you write a note

## Answer

Mr. White — here’s your updated, drop-in agent prompt with the Instagram note added (it targets the “Section 4” notes field when present):

```
SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

CONFIG
instagram_url = "https://instagram.com/<your_handle_here>"  // <-- SET THIS BEFORE RUN

OBJECTIVE
Submit the user to every “fit for me” paying role on Actors Access, enforcing the Pay Gate, “one role per project,” and the background-rate floor, batching checkout in groups of 10, and repeating until zero new results remain.

FIT PROFILE
- Male; looks 28–30 (primary band 25–35; allow 23–37 if ideal)
- White/Caucasian; 6'4"; ripped/muscular/athletic
- Strengths: stoic/intense/brooding, intimate scenes, “bad boy,” “hot guy”/romantic lead
- Weaker fit: slapstick/quirky goofball

GLOBAL SETTINGS
- Human pacing: 200–800 ms between actions; 1.5–3 s after page transitions.
- Use current logged-in session only.
- State:
  • submitted_titles = set()
  • cart_count = 0
  • total_submitted = 0
  • failures = []
  • skipped = []  // {project, role, reason}
- Prefer stable UI labels over color cues; use highlight colors only as fallback.

FILTERS (apply each loop)
1) **Paying roles only** (Paid = Yes).
2) **All breakdowns fit for me** (Fit/Matches My Profile or “fit” badge).
3) Enable **Hide submitted** (or equivalent) if available.

ALREADY-SUBMITTED UI MARKERS (skip immediately)
- Projects with a **red check icon to the left** → treat as already submitted; ignore without opening.
- Any explicit “Submitted/Already Submitted” status on a project/role.

MEDIA POLICY
- Headshot: default = **second photo**; if role text contains physique-forward terms (fit, athletic, muscular, abs, six-pack, ripped, toned, physique, shirtless, swimmer body, model-type, bodybuilder, lean, in-shape) use **first photo**.
- Always include **reel** when a toggle/picker exists.
- Include **size card** only if size/measurement/wardrobe terms appear (size, sizes, measurements, wardrobe, suit, inseam, waist, chest, height, weight, build, jacket, shoe).

PAY GATE (hard requirement; skip if not met)
- Parse pay text; normalize using the **lower bound** of any range.
- Hourly: require **≥ $20/hr**.
- Day: hourly_est = day_rate/8; require **≥ $20/hr**.
- Week: hourly_est = week_rate/40; require **≥ $20/hr**.
- “SAG/union scale”: treat as pass (≥ $20/hr).
- Flat/stipend/TBD/negotiable/deferred/copy-credit-meal with no convertible hours → **skip**.
- Non-USD or ambiguous with no floor → **skip**.

BACKGROUND RATE EXCEPTION (stricter floor)
- For Background/Extra/Photo Double/Stand-In roles, require **≥ $40/hr equivalent** (same conversions).
- If < $40/hr equivalent → *

*(Answer truncated — 7519 chars total)*
