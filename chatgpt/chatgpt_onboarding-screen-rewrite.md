---
title: "Onboarding screen rewrite"
type: note
created: 2025-11-23
updated: 2025-11-23
source: chatgpt-export
conversation_id: 69233be9-a40c-8332-8759-01a7109a84a9
message_count: 2
tags: [chatgpt, import]
---
# Onboarding screen rewrite

> Conversation ID: 69233be9-a40c-8332-8759-01a7109a84a9
> Created: 2025-11-23T16:53:24Z
> Updated: 2025-11-23T16:54:12Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000cf98720cbc99109fa2005e45', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 90720, 'width': 708}
This is so much text for a simple binary selection. Please help improve and set rules for our onboarding so we keep all pages clean and concise

---

## Assistant

Mr. White, here’s a cleaner version of this screen plus a set of onboarding rules to keep every page tight.

## What to change on this screen (rewrite)
**Current issues**
- 3 different headings say basically the same thing (“Basics / Let’s dial in basics / Keep it simple…”).
- Two separate explanations for why you need sex-at-birth.
- The choice is binary but the text feels like a policy page.

**Proposed layout + copy**
**Header:** `Basics` *(or remove if you already show step label)*  
**Step label:** `Step 2 of 11` *(keep)*

**Question:** `Sex at birth`  
**Helper (one line max):** `Used only for health benchmarks.`  
**Options:** `Male` / `Female`

**Info icon / tooltip (optional, for trust):**  
`We use this to compare your results to the right reference group—not for marketing.`

That’s it. One headline, one helper, one optional tooltip. No second paragraph.

### If you want it even shorter
**Question:** `Sex at birth`  
**Helper:** `For benchmarks.`  
Tooltip stays the same if needed.

---

## Onboarding copy rules (to keep every page concise)

### 1) One purpose per screen
If a screen asks for a choice, don’t also explain the whole product. Any “why onboarding exists” copy belongs on a single intro screen.

### 2) Single title hierarchy
Max **one** of each:
- **Screen title** (optional)
- **Question title** (required)
- **Helper text** (optional)

If the screen title doesn’t add meaning beyond the question, delete it.

### 3) Helper text is a single sentence
- **≤ 70 characters** (hard cap).
- No em-dashes stacking extra clauses.
- If you can’t say it in one line, it’s a tooltip or separate “Learn more.”

### 4) No duplicate rationale
Say “why we ask” **once**.
- Prefer a **tooltip** for sensitive/defensive explanations.
- The main screen should stay task-focused.

### 5) Use progressive disclosure
Default view = minimal.  
Extra context only when:
- Legal/privacy sensitivity
- Non-obvious question
- High drop-off step

Mechanisms: info icon, “Why we ask,” expandable bottom sheet.

### 6) Match text weight to decision weight
Binary, low-effort input → low-effort copy.  
If selection takes 1 second, reading should take 1 second.

### 7) Avoid filler and vibes
Cut phrases that don’t change behavior:
- “Let’s dial in…”
- “Keep it simple…”
- “These power your Body Score…”

Keep only what helps the user answer correctly.

### 8) Consistent patterns across steps
Users learn the rhythm. Pick a template and reuse it:
- **Question**
- **1-line helper**
- **Choices**
- **Optional tooltip**

### 9) Sensitive fields checklist
For items like sex-at-birth, weight, ethnicity, pregnancy, mental health:
- Neutral question wording
- Short helper stating functional need
- Tooltip with privacy assurance
- Never show marketing language on same screen

### 10) Copy QA gate
Before shipping a step, it must pass:
- **Can the user answer without reading helper?** If yes, helper probably removable.
- **Is any line repeated elsewhere in onboarding?** If yes, delete here.
- **Does any sentence exceed one line on small devices?** If yes, shorten or move to tooltip.

---

If you want, paste a few more onboarding screens and I’ll rewrite them to the same standard and flag where the rules are being violated.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_about-section-rewrite]]
- [[chatgpt/chatgpt_bar-manager-resume-rewrite]]
- [[chatgpt/chatgpt_closed-loops-brand-rewrite]]
- [[chatgpt/chatgpt_empathetic-message-rewrite]]
- [[chatgpt/chatgpt_generate-image-or-rewrite]]
