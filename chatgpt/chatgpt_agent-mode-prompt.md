---
title: "Agent mode prompt"
type: essay
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
conversation_id: 6914e094-7e68-8331-b03c-80369ec02e71
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Agent mode prompt

> Conversation ID: 6914e094-7e68-8331-b03c-80369ec02e71
> Created: 2025-11-12T19:35:27Z
> Updated: 2025-11-12T21:18:10Z
> Messages: 10

---

## User

I want chatgpt agent mode to go through actors access breakdowns.

It should search by "paying roles only" and "all breakdowns fit for me"

Then it should click on each role in yellow (which means its fit for me) and click the title to open it and submit me,

It needs to select my headshot (the second photo i have, unless it specifically talks about needing someone who is fit, has abs or is muscular ins which case it should pick the first photo where im showing off my physique).

Then it should check to include my reel and check to include my size card if relevant and finally click to submit. Then it should go back and do the same for all the other roles in search results.

When it gets to 10 roles, it should checkout the cart and pay (which will be free since i ahem a premium account) and checkout to finalize and submit all the submissions.

Then it should search again and filter out roles already submitted to.

It should do this for all roles that im fit for and keep going without use interruption until there 0 results left.

I need you to write this out into a perfect prompt that chatgpt can be given to accomplish this.
I will enter the prompt in the chatgpt sidebar in the open ai atlas browser while im on the breakdowns page of actors access.

---

## Assistant

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
            - Read the role description and notes.
            - Choose headshot per MEDIA POLICY.
            - Include reel.
            - Include size card only if relevant per keywords.
            - Do NOT edit resume text or profile attributes unless required fields are blank; if a required field is missing, fill truthfully using existing profile values only.
       iii) Add the submission to the **cart** (or click the site’s equivalent “Add to Cart / Proceed”).
        iv) Increment cart_count += 1; add the role title to submitted_titles.
         v) Return to results list at the same scroll position.

   3) When cart_count reaches **10**:
      - Open the **Cart/Checkout**.
      - Verify the total due is **$0.00** (premium account submission).
      - If total due > $0.00 → Safety Stop (see below).
      - Complete checkout (Finalize/Place Order/Submit All).
      - Wait for confirmation.
      - Set total_submitted += cart_count; set cart_count = 0.
      - Return to Breakdown search.
      - Re-apply FILTERS (ensure “Hide submitted” or equivalent is ON).
      - Continue the loop on the next results.

C) After processing all pages:
   - If new fit roles still appear after re-running the filtered search, repeat Section B.
   - Stop when a fresh search with filters returns **0** fit roles.

PAGINATION & DEDUPE
- Visit each results page in order.
- Maintain submitted_titles to avoid re-opening the same title.
- If a role opens in a modal, submit from modal and close to return; if it opens in a new tab, close the tab after adding to cart.
- If the site resorts or refreshes the list after a submission, re-apply filters and continue from the last unprocessed role.

SAFETY STOPS (immediately halt actions and report)
1) Checkout total is not $0.00.
2) The site requests multi-factor auth or credential re-entry.
3) The UI changes such that submit/checkout controls are ambiguous or missing.
4) Any error repeats 3 times on the same step.

ERROR HANDLING
- If a submission step fails (element not found, timeout, etc.):
  • Retry up to 2 additional times with small delays.
  • On persistent failure, record: {title, step, brief error} to failures, navigate back to results, continue.
- If media selection fails to show the photo grid:
  • Use default media pre-selected by the site (but still include the reel if the control is available).
- If cart is temporarily unreachable:
  • Refresh once, try again. If still unreachable, continue collecting until 10 are queued or end of pass, then try cart again.

END-OF-RUN CHECKOUT
- If cart_count > 0 at the end (fewer than 10 on the last batch), perform the same free checkout step, confirm success, and add to total_submitted.

FINAL OUTPUT (to chat)
Provide a concise summary:
- “Submitted X roles total in Y checkout batches.”
- List titles submitted (up to 30; if more, summarize count and provide the first 30).
- Note any failures with short reasons.
- Confirm that no fit, paying roles remain.
```

Tip: paste it as the agent’s system/instructions message. Once it runs, you should see it quietly cycle through results, batch-submit in tens, and finish with a short summary.

---

## User

on projects with multiple roles available choose the ones that best fits me
im a male that looks 28-30, im white, 6'4", ripped and muscular, and i tend to be good at stoic performances or intimate scenes, bad boy roles or hot guy roles etc.

---

## Assistant

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
+5 if vibe keywords appear: stoic, intense, brooding, strong silent, alpha, antihero, bad boy, heartthrob, romantic lead, model, hunk, rugged, soldier, cop, firefighter, security, bouncer, athlete, trainer.
−4 if text leans “nerdy, dorky, goofy, slapstick, bumbling”; do not auto-skip if other signals are excellent—just lower priority.
+4 if role type is Lead/Series Regular/Principal; +3 Supporting/Guest Star/Co-Star/Day Player; −4 Background/Extra/Photo Double/Stand-In unless unusually well-paid and otherwise perfect.
+ up to 4 for higher guaranteed pay versus peers in same project.
Tie-breakers (in order): Role type > better vibe match > stronger physique/height match > tighter age match > higher pay > earlier deadline.

PROJECTS WITH MULTIPLE ROLES
- Compute Fit Score for each role in the project.
- **Submit to all roles with Fit Score ≥ 15** that do not conflict (e.g., mutually exclusive role IDs or same character variants). If many exceed 15, submit to the **top 1–2 highest-scoring** principal roles to avoid spamming near-duplicates.
- **Never** submit to roles that the profile clearly cannot meet (wrong gender, explicitly different ethnicity, minors).
- Prefer principal/supporting over background when both are available.

OPTIONAL NOTE / COVER MESSAGE (only if a freeform note field is offered)
- Keep it to 1–2 short sentences, no fluff. Template:
  “28–30 look, 6'4", athletic/muscular. Strong with stoic, intense or ‘bad-boy’ roles; comfortable in intimate scenes. Reel attached.”
- Do not claim unavailable skills or credentials. Do not edit resume beyond site defaults.

WORKFLOW
A) Ensure you are on the Breakdown search/results view with filters visible. Apply FILTERS, then run the search.

B) Iterate over paginated results:
   1) Identify roles marked “fit” (badge/label). If unreliable, use yellow highlight as fallback.
   2) For each project, open it and evaluate every available role using the FIT SCORE and multi-role rules above.
   3) For each selected role not in submitted_titles:
      - Open the role by clicking the **title**.
      - If status shows “Submitted/Already Submitted,” add title to submitted_titles and go back.
      - Otherwise:
         i) Click **Submit/Apply**.
        ii) On the submission form: choose media per MEDIA POLICY; include reel; include size card if relevant; add optional note only if a note field is offered.
       iii) Add to **cart** (or equivalent).
        iv) cart_count += 1; add the role title to submitted_titles.
         v) Return to the project list/results and continue.
   4) When cart_count reaches **10**:
      - Open **Cart/Checkout**.
      - Verify total due is **$0.00** (premium submission).
      - If > $0.00 → Safety Stop.
      - Complete checkout (Finalize/Place Order/Submit All).
      - Confirm success; total_submitted += cart_count; set cart_count = 0.
      - Return to search; re-apply FILTERS; continue.

C) After all pages:
   - If a fresh filtered search still returns new fit roles, repeat Section B.
   - Stop when a filtered search returns **0** fit roles.

PAGINATION & DEDUPE
- Visit each results page in order.
- Maintain submitted_titles to avoid re-opening the same title.
- If a role opens in a modal, submit from modal and close; if in a new tab, close after adding to cart.
- If the site refreshes/sorts the list after a submission, re-apply filters and continue where you left off.

SAFETY STOPS (immediately halt actions and report)
1) Checkout total is not $0.00.
2) Site requests MFA or credential re-entry.
3) UI changes make submit/checkout ambiguous or missing.
4) Any error repeats 3 times on the same step.

ERROR HANDLING
- On failure (element not found/timeout):
  • Retry up to 2 times with small delays.
  • On persistent failure, record {title, step, brief error} to failures, go back, continue queue.
- If media picker fails to load, use the site’s default headshot but still include the reel if possible.
- If cart is unreachable, refresh once and retry; if still blocked, continue collecting until 10 or end of pass, then retry checkout.

END-OF-RUN CHECKOUT
- If cart_count > 0 at the end, perform the same free checkout, confirm success, and add to total_submitted.

FINAL OUTPUT (to chat)
Provide a concise summary:
- “Submitted X roles total in Y checkout batches.”
- List titles submitted (up to 30; if more, show first 30 + ‘…’ with total).
- Note any failures with short reasons.
- Confirm that no fit, paying roles remain after re-search.
```

If you want me to tweak age or vibe priorities further (e.g., emphasize “romantic lead” over “enforcer”), say the word and I’ll adjust the scoring weights.

---

## User

Never apply to more than one role per project.
Skip roles that pay less than 20/hr (if day rate, assume 8 hr day to calculate). 

---

## Assistant

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
+6 athletic/muscular/ripped/fit/toned/physique; +3 mentions tall/6'2"+; −3 heavyset/soft body
+5 vibe matches: stoic/intense/brooding/strong silent/alpha/antihero/bad boy/heartthrob/romantic lead/model/hunk/rugged/soldier/cop/firefighter/security/bouncer/athlete/trainer
−4 nerdy/goofy/slapstick (don’t auto-skip if other signals are strong)
+4 Lead/Series Regular/Principal; +3 Supporting/Guest/Co-Star/Day Player; −4 Background/Extra/Photo Double/Stand-In unless unusually well paid
Tie-breakers: Role type > better vibe match > physique/height > age match > higher pay > earlier deadline

MULTI-ROLE PROJECTS (NEVER more than one submission per project)
- Evaluate PAY GATE for each role first; **discard** roles failing the Pay Gate.
- Compute FIT SCORE on the survivors.
- Select **the single highest-scoring** principal/lead role. If only background/day-player remain, select the highest-scoring among them only if they passed the Pay Gate.
- Submit to **one** role maximum for that project. Do not submit to additional roles in the same project.

OPTIONAL NOTE (only if a freeform note field is present; keep 1–2 sentences)
“28–30 look, 6'4", athletic/muscular. Strong with stoic, intense or ‘bad-boy’ roles; comfortable in intimate scenes. Reel attached.”

WORKFLOW
A) On the Breakdown search/results view: apply FILTERS, run search.

B) Iterate result pages:
   1) Identify “fit” roles (badge/label or yellow highlight fallback).
   2) Open project; extract all roles; apply PAY GATE; score remaining roles; choose a single role per MULTI-ROLE rules.
   3) For the chosen role:
      - Open the **title**.
      - If status shows “Submitted/Already Submitted,” add to submitted_titles and return.
      - Otherwise:
         i) Click **Submit/Apply**.
        ii) Choose media per MEDIA POLICY; include reel; include size card if relevant; add optional note if field exists.
       iii) **Add to cart**.
        iv) cart_count += 1; add role title to submitted_titles.
         v) Return to results and continue.

C) When cart_count reaches **10**:
   - Open **Cart/Checkout** → verify total due **$0.00** (premium).
   - If total > $0 → Safety Stop.
   - Complete checkout; confirm success.
   - total_submitted += cart_count; cart_count = 0.
   - Re-apply FILTERS; continue.

D) After final page:
   - If a fresh filtered search yields new fit roles, repeat B.
   - Stop when a fresh filtered search returns **0** fit roles.

PAGINATION & DEDUPE
- Process pages in order; keep submitted_titles to avoid repeats.
- If role opens as modal, submit then close; if new tab, close tab after adding to cart.
- If the site refreshes/sorts after submission, re-apply FILTERS and resume from last unprocessed item.

SAFETY STOPS (halt and report)
1) Checkout total not $0.00.
2) MFA/credential re-entry requested.
3) Submit/checkout controls missing/ambiguous due to UI change.
4) Same step fails 3×.

ERROR HANDLING
- On failure (element not found/timeout): retry up to 2× with small delays; then record {title/project, step, brief error} in failures and continue.
- If media picker fails: use default headshot; still include reel if possible.
- If cart unreachable: refresh once; if still blocked, continue collecting until 10 or end-of-pass, then retry checkout.

END-OF-RUN CHECKOUT
- If cart_count > 0, checkout the remaining (expect $0.00), confirm success, add to total_submitted.

FINAL OUTPUT (to chat)
- “Submitted X roles total in Y checkout batches.”
- List submitted titles (up to 30; else first 30 + “…”, with total).
- List skipped items by brief reason (e.g., “<$20/hr”, “flat/TBD”, “ethnicity mismatch”).
- List any failures with brief reasons.
- Confirm no remaining fit, paying roles after re-search.
```

Want me to also auto-skip background/extra unless the hourly-equivalent is ≥ $40? I can fold that in.

---

## User

Yes and also note Projects with a red check to the left have already been submitted on so they can be ignored


---

## Assistant

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
+10 Male; +5 Any gender
+8 age spans 27–33; +6 for 25–35; +5 for 21–35; +3 for 23–37; skip if <18 or >45 unless “looks 28–30”
+6 White/Caucasian; +4 Any/All ethnicities; skip if a different specific ethnicity is required
+6 athletic/muscular/ripped/fit/toned/physique; +3 mentions tall/6'2"+; −3 heavyset/soft body
+5 vibe: stoic/intense/brooding/strong-silent/alpha/antihero/bad boy/heartthrob/romantic lead/model/hunk/rugged/soldier/cop/firefighter/security/bouncer/athlete/trainer
−4 nerdy/goofy/slapstick (don’t auto-skip if other signals are excellent)
+4 Lead/Series Regular/Principal; +3 Supporting/Guest/Co-Star/Day Player; −4 Background/Extra/Photo Double/Stand-In (still allowed if it passed the $40/hr gate)
Tie-breakers: Role type > vibe match > physique/height > age match > higher pay > earlier deadline

MULTI-ROLE PROJECTS (NEVER more than one submission per project)
- Ignore the project entirely if it shows the **red check** icon.
- For others: apply PAY GATE (+ Background Exception) to all roles; discard failures.
- Compute FIT SCORE on survivors; **select one highest-scoring principal/lead** role. If only background/day-player remain, pick the highest-scoring only if it passed the **$40/hr** gate.
- Submit to **one** role maximum for that project.

OPTIONAL NOTE (only if a note field exists; 1–2 short sentences)
“28–30 look, 6'4", athletic/muscular. Strong with stoic, intense or ‘bad-boy’ roles; comfortable in intimate scenes. Reel attached.”

WORKFLOW
A) On Breakdown search/results: apply FILTERS; run search.

B) Iterate result pages:
   1) Skip any project row with a **red check icon**.
   2) For the rest, identify “fit” roles (badge/label or yellow highlight fallback).
   3) Open project; extract roles; apply PAY GATE and BACKGROUND EXCEPTION; score survivors; choose the single role per rules above.
   4) For the chosen role:
      - Open the **title**.
      - If “Submitted/Already Submitted,” record skip reason and return.
      - Else:
         i) Click **Submit/Apply**.
        ii) Select media per MEDIA POLICY; include reel; include size card if relevant; add note if field exists.
       iii) **Add to cart**.
        iv) cart_count += 1; add role title to submitted_titles.
         v) Return to results; continue.

C) When cart_count reaches **10**:
   - Open **Cart/Checkout**; verify total due is **$0.00** (premium).
   - If > $0.00 → Safety Stop.
   - Complete checkout; confirm success.
   - total_submitted += cart_count; cart_count = 0.
   - Re-apply FILTERS; continue.

D) After final page:
   - If a fresh filtered search yields new fit roles, repeat B.
   - Stop when a fresh filtered search returns **0** fit roles.

PAGINATION & DEDUPE
- Process pages in order; track submitted_titles to avoid repeats.
- If a role opens as modal, submit then close; if new tab, close after adding to cart.
- If list refreshes/sorts after submission, re-apply FILTERS and resume.

SAFETY STOPS (halt and report)
1) Checkout total not $0.00.
2) MFA/credential re-entry requested.
3) Submit/checkout controls missing/ambiguous due to UI change.
4) Same step fails 3×.

ERROR HANDLING
- On failure (element not found/timeout): retry up to 2×; then record {project/role, step, brief error} in failures and continue.
- If media picker fails: use default headshot; still include reel if possible.
- If cart unreachable: refresh once; if still blocked, continue collecting until 10 or end-of-pass, then retry checkout.

END-OF-RUN CHECKOUT
- If cart_count > 0, checkout remaining (expect $0.00), confirm success, add to total_submitted.

FINAL OUTPUT (to chat)
- “Submitted X roles total in Y checkout batches.”
- List submitted titles (up to 30; else first 30 + “…”, with total).
- List skipped items with brief reason (e.g., “red check,” “<$20/hr,” “background <$40/hr,” “ethnicity mismatch,” “TBD/flat”).
- List any failures with brief reasons.
- Confirm no remaining fit, paying roles after re-search.
```

Want me to also bump the pay floor for day players (non-background) to, say, $30/hr? I can add a tier without changing the rest.

---

## User

Add my instagram url to the 4th section on each submission where it lets you write a note

---

## Assistant

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
- If < $40/hr equivalent → **skip** (reason: “background < $40/hr”).

FIT SCORE (for choosing the single role within a project)
Start 0:
+10 Male; +5 Any gender
+8 age spans 27–33; +6 for 25–35; +5 for 21–35; +3 for 23–37; skip if <18 or >45 unless “looks 28–30”
+6 White/Caucasian; +4 Any/All ethnicities; skip if a different specific ethnicity is required
+6 athletic/muscular/ripped/fit/toned/physique; +3 mentions tall/6'2"+; −3 heavyset/soft body
+5 vibe: stoic/intense/brooding/strong-silent/alpha/antihero/bad boy/heartthrob/romantic lead/model/hunk/rugged/soldier/cop/firefighter/security/bouncer/athlete/trainer
−4 nerdy/goofy/slapstick (don’t auto-skip if other signals are excellent)
+4 Lead/Series Regular/Principal; +3 Supporting/Guest/Co-Star/Day Player; −4 Background/Extra/Photo Double/Stand-In (still allowed if it passed the $40/hr gate)
Tie-breakers: Role type > vibe match > physique/height > age match > higher pay > earlier deadline

MULTI-ROLE PROJECTS (NEVER more than one submission per project)
- Ignore the project entirely if it shows the **red check** icon.
- For others: apply PAY GATE (+ Background Exception) to all roles; discard failures.
- Compute FIT SCORE on survivors; **select exactly one highest-scoring principal/lead** role. If only background/day-player remain, pick the highest-scoring only if it passed the **$40/hr** gate.
- Submit to **one** role maximum for that project.

NOTE FIELD (Section 4)
- If the submission form has a “Section 4” or similar **freeform note/cover note** textarea, enter a concise note:
  “28–30 look, 6'4", athletic/muscular. Strong with stoic, intense or ‘bad-boy’ roles; comfortable in intimate scenes. Reel attached. IG: {instagram_url}”
- If the note field exists but is not labeled as “Section 4,” still place the same note in the available note textarea.
- If no note field is present, proceed without adding a note.

WORKFLOW
A) On Breakdown search/results: apply FILTERS; run search.

B) Iterate result pages:
   1) Skip any project row with a **red check icon**.
   2) For the rest, identify “fit” roles (badge/label or yellow highlight fallback).
   3) Open project; extract roles; apply PAY GATE and BACKGROUND EXCEPTION; score survivors; choose the single role per rules above.
   4) For the chosen role:
      - Open the **title**.
      - If “Submitted/Already Submitted,” record skip reason and return.
      - Else:
         i) Click **Submit/Apply**.
        ii) Select media per MEDIA POLICY; include reel; include size card if relevant.
       iii) In the **note field (Section 4)**, add the note with **IG: {instagram_url}**.
        iv) **Add to cart**.
         v) cart_count += 1; add role title to submitted_titles.
        vi) Return to results; continue.

C) When cart_count reaches **10**:
   - Open **Cart/Checkout**; verify total due is **$0.00** (premium).
   - If > $0.00 → Safety Stop.
   - Complete checkout; confirm success.
   - total_submitted += cart_count; cart_count = 0.
   - Re-apply FILTERS; continue.

D) After final page:
   - If a fresh filtered search yields new fit roles, repeat B.
   - Stop when a fresh filtered search returns **0** fit roles.

PAGINATION & DEDUPE
- Process pages in order; track submitted_titles to avoid repeats.
- If a role opens as modal, submit then close; if new tab, close tab after adding to cart.
- If list refreshes/sorts after submission, re-apply FILTERS and resume.

SAFETY STOPS (halt and report)
1) Checkout total not $0.00.
2) MFA/credential re-entry requested.
3) Submit/checkout controls missing/ambiguous due to UI change.
4) Same step fails 3×.

ERROR HANDLING
- On failure (element not found/timeout): retry up to 2×; then record {project/role, step, brief error} in failures and continue.
- If media picker fails: use default headshot; still include reel if possible.
- If cart unreachable: refresh once; if still blocked, continue collecting until 10 or end-of-pass, then retry checkout.

END-OF-RUN CHECKOUT
- If cart_count > 0, checkout remaining (expect $0.00), confirm success, add to total_submitted.

FINAL OUTPUT (to chat)
- “Submitted X roles total in Y checkout batches.”
- List submitted titles (up to 30; else first 30 + “…”, with total).
- List skipped items with brief reason (e.g., “red check,” “<$20/hr,” “background <$40/hr,” “ethnicity mismatch,” “TBD/flat”).
- List any failures with brief reasons.
- Confirm no remaining fit, paying roles after re-search.
```

Replace the placeholder in CONFIG with your actual Instagram URL before you paste this into the sidebar.


## See Also
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part3]]
- [[chatgpt/chatgpt_ai-prompt-for-dark-mode]]
- [[chatgpt/chatgpt_improving-agent-prompt]]
