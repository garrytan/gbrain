---
title: "Onboarding improvements guide"
type: note
created: 2025-11-22
updated: 2025-11-22
source: chatgpt-export
conversation_id: 69213cde-b070-8331-9634-34c61ddec15f
message_count: 4
tags: [chatgpt, import, long-form]
---
# Onboarding improvements guide

> Conversation ID: 69213cde-b070-8331-9634-34c61ddec15f
> Created: 2025-11-22T04:32:42Z
> Updated: 2025-11-22T04:58:08Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_000000009da0722fb58c55a3c18be991', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 130784, 'width': 708}
{'asset_pointer': 'sediment://file_00000000ef38722f869f8dc077d57c0c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 109371, 'width': 708}
{'asset_pointer': 'sediment://file_00000000c5d0722f9c9a71a6f6f33fc4', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 106280, 'width': 708}
How to improve on boarding screens?

---

## Assistant

Mr. White, here are high-impact improvements, screen by screen, plus a few global fixes.

**Global onboarding**
- **Set expectations up front.** “Step 1 of 9” feels long. Add a short line like “~60 sec, 9 quick questions” and show remaining time, not just steps.
- **Progress bar clarity.** Make the bar thicker or add labeled milestones (Basics → Body comp → Goals → Summary) so it feels purposeful, not endless.
- **One primary action.** Keep only one bright CTA per screen. Secondary actions should look clearly secondary (text link or subtle button).
- **Persistent back + save state.** Back arrow already exists; ensure it never loses inputs.
- **Accessibility.** Increase contrast for gray helper text, enlarge tap targets on pickers/segmented controls, support Dynamic Type.

---

## Step 1 (Welcome / value pitch)
What’s good: clear headline, benefit bullets, preview option.

Improvements:
- **Tighten copy to one core promise.**  
  Current: “Build a dialed-in body… Body Score in under a minute.”  
  Better: one sharp line + subline. Example:  
  **“Get your Body Score in 60 seconds.”**  
  “See muscle, body fat, and FFMI vs peers.”
- **Explain “Body Score Early Access.”** People don’t know what that means. Either remove the pill or add a tiny explainer (“Beta feature”) and why it matters.
- **Reduce text block density.** The rounded card is wordy. Convert to 2–3 short bullets max (you already have bullets—cut the paragraph above them).
- **Primary CTA wording.** “See my score” is fine, but make it more action-oriented: **“Start my 60-sec check”**.
- **Secondary CTA.** “I already have an account” can be a text link below the button to reduce visual competition.

---

## Step 2 (Biological sex + birth year)
Improvements:
- **Rename for plainness.** “Biological Sex” can feel clinical. Consider **“Sex at birth”** with a short “for accurate benchmarks.”
- **Selection affordance.** The male/female cards are huge; good for taps. But the radio on the right is subtle. Make the whole card highlight stronger on select.
- **Birth year picker legibility.** The selected year is faint; increase contrast/size of the selected row so it’s instantly obvious.
- **Optionality / trust.** Add a subtle “why we ask” inline for sex and birth year (tooltip icon). People want to know it’s for norms, not marketing.
- **Skip if allowed.** If either is optional, say so and provide “Prefer not to say” to reduce drop-off.

---

## Step 3 (Height)
Improvements:
- **Default to locale.** If user device locale is US, default to FT/IN; otherwise CM. You can still allow toggling.
- **Picker UX.** Dual wheel is okay, but add a **single combined readout** above it: “6 ft 4 in (193 cm)” so they confirm instantly.
- **Less “Why we ask” real estate.** The big card pushes the CTA down. Collapse it into a small link (“Why we ask”) that expands.
- **Make “What’s FFMI?” contextual.** Good to include, but it’s early. Put FFMI explanation later when you actually show the score, or hide behind tooltip.
- **CTA placement.** Keep “Continue” fully visible without scrolling; currently it is, but if “Why we ask” expands it might not be.

---

### Extra friction reducers
- **Auto-advance on easy fields.** After selecting sex or height, consider auto-scrolling to next section or enabling “Continue” with a subtle nudge.
- **End-of-onboarding preview.** Later in the flow, show a mini “score preview” so users feel payoff before step 9.

If you want, paste the remaining steps and I’ll do the same pass on them.

---

## User

{'asset_pointer': 'sediment://file_00000000ff8c7230b5816764a6f20427', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 124215, 'width': 708}
{'asset_pointer': 'sediment://file_0000000088807230a9c3f37f872d9661', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 103003, 'width': 708}
{'asset_pointer': 'sediment://file_00000000523c72309edf2cd531c30bec', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 124051, 'width': 708}
{'asset_pointer': 'sediment://file_000000000b8c723095c12d2583367f5a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 137153, 'width': 708}

---

## Assistant

Mr. White, quick surgical fixes for each screen + the bigger flow issue they reveal.

## “Pull from Apple Health?” (Step 4/9)
- **State mismatch.** Screen says “Pull from Apple Health?” but the card already shows “Apple Health connected” + green synced status. That’s confusing.  
  - If connected: rename to **“Apple Health is connected”** and make primary CTA **“Continue”**.  
  - If not connected: remove “connected” status UI until after authorization.
- **Permission copy is too detailed for onboarding.** “Read & write with your permission” x2 is cognitive noise. Collapse to one line:  
  **“We’ll read height, weight, and body fat from Apple Health.”**  
  Add “You control permissions in Settings.”
- **Two competing paths.** You have a big “Connect Apple Health” button AND a big “Enter manually instead” card. Make manual a clear secondary text link under the main button.
- **Bottom note unclear.** “Only stored locally unless you opt in to sync.” sounds like you might upload data. Say plainly:  
  **“Stored on your device. We don’t sell or share health data.”**

## “Health data synced” review (Step 5/8)
- **Good idea, but add provenance confidence.** For each metric show timestamp/source quality:  
  “Weight: 162 lb (last logged 12 days ago)” so users know if it’s stale.
- **Inline edit affordance.** Add an “Edit” icon per row. Don’t force the user into a different flow to fix one value.
- **Button labels.**  
  - Primary: **“Continue”** (not “Looks good”) to keep the momentum.  
  - Secondary: “Enter manually” is fine, but smaller.
- **Trust reinforcement belongs here, not the prior screen.** Keep the privacy line, but shorten: “We read only what you allow.”

## Weight input (manual)
- **Make it feel fast.** Replace the big “Why we ask” card with a small collapsible link. It pushes CTA down and repeats earlier info.
- **Improve numeric entry.**  
  - Autofocus field with numeric keypad.  
  - Show unit inside the field (“lb”) so there’s zero ambiguity.  
  - Allow quick +/- steppers for small edits.
- **Default units by locale and previous choice.** You already toggle; just remember their last setting.
- **Valid range copy doesn’t help users.** It’s dev-facing. Remove or hide unless they go out of range.

## “Your Body Score” results (Step 6/8)
- **Score presentation is demotivating.** “1/100” + “Huge upside” reads like a dunk. Reframe as a baseline, not a grade.  
  Example:  
  **“Starting point: 1/100”**  
  “We’ll raise this as you log training + nutrition.”
- **Explain what drives the score.** One line under the number:  
  “Based on FFMI, body fat %, and progress trends.”
- **Give immediate next action.** After payoff, users need a path. Add a strong CTA like:  
  **“See my 4-week plan”** or **“Start coaching”**.  
  “Save my progress” is vague and doesn’t say what happens next.
- **Tiles need context.**  
  - FFMI 16.9 “Developing” → add a tiny comparator: “Median for your height/age: X–Y.”  
  - Lean %ile 53 → specify the group: “vs men your age/height.”
- **Target body fat range is risky without personalization.** 8–12% is lean and not appropriate for everyone. If it’s generic, label clearly:  
  **“Optional lean target (advanced)”**  
  Or tailor based on goals/starting BF.
- **Visual hierarchy.** The huge blue card dominates; supporting metrics feel secondary but important. Reduce card height slightly and bring tiles up.

## Cross-flow issue
Your step counts don’t match: earlier screens show **9 steps**, but later it’s **8**. That nukes trust. Pick one count, and don’t change it mid-flow.

If you want a single north-star change: **make the Apple Health path feel like one tap → confirm → score → next plan**, with no duplicated permission/review UI and no giant “why we ask” blocks interrupting momentum.


**Topic:** [[chatgpt-clusters/code_review]]
