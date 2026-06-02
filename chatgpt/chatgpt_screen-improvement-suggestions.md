---
title: "Screen improvement suggestions"
type: note
created: 2025-11-22
updated: 2025-11-22
source: chatgpt-export
conversation_id: 692248a8-54c4-8333-b159-a65da513b118
message_count: 2
tags: [chatgpt, import]
---
# Screen improvement suggestions

> Conversation ID: 692248a8-54c4-8333-b159-a65da513b118
> Created: 2025-11-22T23:35:11Z
> Updated: 2025-11-22T23:35:48Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000adf071f58abc308570e72903', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 118269, 'width': 708}
How should we improve on this design?

---

## Assistant

Mr. White, here are concrete ways to improve this screen, focusing on hierarchy, clarity, and usability:

**1) Clarify the main purpose**
- Right now “Body Score 87” is dominant, but *what to do next* isn’t. Add a clear primary action tied to the score (e.g., “View plan to reach 90” / “See drivers of score”). Make it one obvious CTA instead of two low-priority buttons at the bottom.

**2) Make the score more interpretable**
- The semicircle gauge looks nice but doesn’t say much. Add:
  - labeled ranges on the arc (e.g., Poor / OK / Good / Excellent)  
  - a visible min/max (0–100) or a benchmark line (“top 10% for your age”)  
- The text “Dialing it in” is vague. Replace with a specific status: “Great” / “Maintaining” / “Improving” plus the key reason.

**3) Fix confusing copy**
- “On pace for 87 in 30 days” when the current score is 87 reads like no change. If trend is flat, say “Stable over 30 days.” If projecting improvement, show the projected value and delta: “On pace for 90 (+3) in 30d.”

**4) Improve sub-metric cards (FFMI / Body fat / Weight)**
- These three are important but visually secondary *and* low-context. Add tiny trend indicators (↑↓ with last 30d delta).
- “Developing” is subjective. Use a concrete bracket: “FFMI 17.8 (avg)” or “(developing) → what it means” via info tooltip.
- Align units consistently (e.g., put “lbs” on same line/size as the number or small superscript).

**5) Tighten visual hierarchy**
- Reduce the arc thickness or glow slightly; it competes with the number.
- Increase contrast of secondary text (“Dialing it in”, “On pace…”) for readability in dark mode.
- The top “Welcome back / name / Add age” area is cluttered. Collapse to one line: avatar + name + small “Add age” prompt inline.

**6) Steps card needs context**
- “1,770/10,000” is clear, but add timeframe (“today”) and maybe a tiny progress ring rather than a long bar.
- “8,230 to goal” repeats the same info. Replace with something additive: “Estimated finish: 7:45pm” or “+320 vs yesterday.”

**7) Spacing and alignment polish**
- The bottom CTAs feel cramped against the tab bar. Add more bottom padding or move CTAs into the main card as a sticky section above nav.
- Ensure left edges of all cards and labels align perfectly; small misalignments in dark UI are noticeable.

**8) Accessibility**
- Check text sizes against WCAG for dark themes; some gray labels look borderline.
- Don’t rely on color alone for trend (add arrows/labels).
- Support Dynamic Type / larger fonts without breaking the arc layout.

**9) Surface what drives the score**
- Users will ask “why 87?” Add one small “Top contributors” row under the score (e.g., “Low BF helps • Steps below target hurts • Weight stable”). Tapping opens detail.

**10) Consistency in terminology**
- “Body Score” vs “FFMI / Body Fat / Weight” mixes an abstract score with raw metrics. Add a short descriptor under Body Score: “Composite of BF%, FFMI, activity, weight trend.”

If you want, I can sketch a revised layout in words or rough wireframe structure.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_screen-improvement-suggestions-2]]
- [[chatgpt/chatgpt_ci-improvement-suggestions]]
- [[chatgpt/chatgpt_deck-improvement-suggestions]]
- [[chatgpt/chatgpt_design-improvement-suggestions-2]]
- [[chatgpt/chatgpt_design-improvement-suggestions-3]]
