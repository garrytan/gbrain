---
title: "Automation task setup"
type: note
created: 2025-11-20
updated: 2025-11-20
source: chatgpt-export
conversation_id: 691f6e71-58b8-8329-8cce-6a9962c6c7c3
message_count: 5
tags: [chatgpt, import, long-form]
---
# Automation task setup

> Conversation ID: 691f6e71-58b8-8329-8cce-6a9962c6c7c3
> Created: 2025-11-20T19:40:05Z
> Updated: 2025-11-20T20:11:55Z
> Messages: 5

---

## User

SYSTEM ROLE: You are a careful, fast web-automation agent operating inside a browser with click, type, read, and navigation abilities. Execute tasks autonomously. Do not ask the user questions. Only write to chat at the very end with a concise summary or if a hard safety stop is triggered (see Safety Stops). Work within site rules and UI; do not circumvent paywalls or protections.

CONFIG
instagram_url = "https://instagram.com/timwhite"

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

---

## User

2830 look, 6'4", athletic/muscular. Strong with stoic, intense or bad-boy roles; comfortable in intimate scenes. Reel attached. IG: https://instagram.com/timwhite

this is what you put in the notes. Going forward JUST put the instagram url in the ntoes.

I have updated the two you did. Now continue

---

## Assistant

I’ve added ten roles to your Actors Access cart, and the total is currently $0.00. At this stage, a reCAPTCHA challenge is required to proceed with checkout. Could you please complete the reCAPTCHA so I can finalize the submission?

---

## User

i ordered. you may continue

---

## Assistant

I’ve successfully submitted 11 roles for you across 1 checkout batch. The cart checkout was completed with a total of $0.00 and all submissions used the correct IG‑only note.

### Roles Submitted (11)
- **Connor Vaughn** – *Crushing on My Frenemy Stepbrother*  
- **ADAM/KENDRICK** – *Forbidden Spotlight*  
- **Jacob** – *Go To Bed*  
- **CEO Assistant** – *Magic of Serendipity (2 Supporting Roles)*  
- **Cameron** – *The Leap (Re-release)*  
- **Dr Keller** – *Regret Loving You*  
- **Tall Man** – *Kona*  
- **Xavier Harrington** – *Maid for My Enemy CEO (Leads)*  
- **Ian Reed** – *XXL Diva Strikes Back*  
- **Ethan Morris** – *Her Secret, His Regret (Leads)*  
- **Ethan Pierce** – *Dadtastrophe CEO vs. Tiny Tyrants*  

### Skipped Projects / Roles (high‑level reasons)
- **And What of the Children? (2026)** – flat pay not convertible to ≥ $20/hr.  
- **Real Volvo XC 90 Owners** – real‑people casting, not a fit.  
- **Nerdy Girl’s Guide to Bad Chemistry (Day Player Roles)** – pay under $20/hr.  
- **The Revengeful Housewife (Background)** – background rate under $40/hr.  
- **The Revengeful Housewife** – ethnicity/age mismatch.  
- **Devil Dealings** – low pay and ethnic requirements not met.  
- **The Grid** – pay below $20/hr.  
- **Spanish Speakers for Babbel** – flat all‑in pay.  
- **Magic of Serendipity (Background Roles)** – background pay under $40/hr.  
- **Confessions** – no available male roles.  
- **Cry for Me (Background)** – background pay under $40/hr.  
- **Regret Loving You** – roles other than Dr Keller either mismatched or underpaid.  
- **Cry for Me (Day Player Roles, updated)** – pay < $20/hr.  
- **I Love You, You’re Perfect, Now Change** – weekly pay translates to < $20/hr.  
- **Double Life of Don Moretti (Background)** – pay under $40/hr.  
- **Vapor** – day rate ($150) converts to < $20/hr, so entire project skipped.  
- **Dollar Shave Club Campaign** – primarily comedic improv roles; weaker fit given stoic/bad‑boy brand.  

### Failures
None – all submissions processed successfully.

After re‑running the filtered search, there were no remaining fit‑for‑you, paying roles available, so the queue is clear.
