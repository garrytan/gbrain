---
title: "UX redesign prompt"
type: note
created: 2025-08-21
updated: 2025-08-21
source: chatgpt-export
conversation_id: 68a6db06-e1d8-832e-af3d-2afd683af143
message_count: 4
tags: [chatgpt, import]
---
# UX redesign prompt

> Conversation ID: 68a6db06-e1d8-832e-af3d-2afd683af143
> Created: 2025-08-21T08:38:36Z
> Updated: 2025-08-21T08:39:44Z
> Messages: 4

---

## User

{'asset_pointer': 'file-service://file-Eo3q9Lqv5P9GpGX9aMnyPW', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 116579, 'width': 708}
Give me a prompt to overhaul this screen into world-class UX with Apple-level polish and magic and Y Combinator best practices. For the mobile part of it, and then obviously it'll still work well on desktop.

---

## Assistant

Here’s a strong AI prompt you can use to overhaul this screen into Apple-level polish, Y Combinator best practices, and with mobile-first UX that also looks great on desktop:

---

**Prompt:**

> Audit and completely redesign this onboarding screen for Jovie. The goal is Apple-level polish, magical UX, and YC best practices to maximize conversions. Keep it mobile-first, but responsive and beautiful on desktop as well. Apply these principles:
> 
> 1. **Clarity & Emotion:** Rewrite copy to be short, inspiring, and confidence-building. Avoid jargon. Make the CTA crystal clear. Example: “Claim your name. Share your art with the world.”
> 2. **Visual Hierarchy:** Use large, bold typography with plenty of white space. Subtle gradients, glassmorphism, or motion to add delight. Make the handle input feel premium and tactile.
> 3. **Feedback & Magic:** Add instant validation (green check, red error) when typing a handle. Pre-fill suggestions (“@yourname”). Show real-time preview of what the profile link will look like below the input.
> 4. **CTA Button:** The “Create Profile” button should feel alive — smooth hover/press animations, subtle pulse or glow when the input is valid. Always above-the-fold on mobile.
> 5. **Microcopy & Trust:** Add subtle reassurance below the button: “Takes 30 seconds. No credit card needed.” Show that claiming a handle is free and fast.
> 6. **Apple-Level Transitions:** Smooth fade-ins, micro-animations on text and input fields. On mobile, use one-hand-friendly placement and large tap targets. Optimize for thumb reach.
> 7. **Background & Brand:** Use Jovie’s brand colors with depth (dark gradient grid is good, but make it more premium with motion or subtle parallax). Keep it minimal yet memorable.
> 8. **Social Proof (optional):** Consider a carousel or tiny line like: “Join artists like [big name artist] already on Jovie.” Not cluttered, but builds trust.
> 9. **Accessibility & Performance:** Contrast ratios must pass WCAG AA. Sub-100ms interactions. Works seamlessly offline-first and loads instantly.
> 10. **Delight Factor:** Add small whimsical touches — e.g., confetti or a quick shine animation across the button once the handle is successfully claimed.
> 
> Deliver a responsive Figma-quality design spec with refined copy, polished UI, and annotated micro-interactions for both mobile and desktop views. Keep everything concise, premium, and designed to convert.

---

Do you want me to also **rewrite the copy** for you (headline, subhead, button, reassurance text) in that Apple-style tone, so you can just drop it straight into the redesign?

---

## User

I'm going to have it coded directly so we don't need a Figma or anything.

---

## Assistant

Perfect — then here’s a **direct-to-build version** of the prompt with world-class copy, layout, and interactions ready to hand to AI/devs.  

---

**Prompt:**  

> Overhaul this onboarding screen into an Apple-level polished, mobile-first experience that also works beautifully on desktop. Use best practices for conversion (YC style). Implement directly in code.  
> 
> ### Copy  
> - **Headline:** “Claim your name.”  
> - **Subhead:** “Launch your artist profile in seconds.”  
> - **Input placeholder:** “@yourname”  
> - **CTA button:** “Claim Profile”  
> - **Microcopy under CTA:** “It’s free and takes 30 seconds.”  
> 
> ### UX / UI  
> 1. **Layout:**  
>    - Mobile-first, centered vertically, plenty of whitespace.  
>    - Large, bold typography.  
>    - Input and button stacked with generous padding.  
> 
> 2. **Handle input:**  
>    - Rounded pill-style, premium feel.  
>    - Real-time validation (green check or red error).  
>    - Show live preview under input: `preview.jov.ie/@handle`.  
> 
> 3. **CTA button:**  
>    - Rounded, high-contrast, gradient background (brand color).  
>    - Disabled until valid input.  
>    - Smooth hover/press animation, subtle pulse when enabled.  
> 
> 4. **Micro-animations:**  
>    - Headline fades in with slight upward motion.  
>    - Input field glows softly on focus.  
>    - Confetti or subtle sparkle animation fires once handle is claimed.  
> 
> 5. **Background:**  
>    - Gradient grid or soft motion background.  
>    - Dark mode by default.  
>    - Minimal, premium look — no clutter.  
> 
> 6. **Accessibility / Performance:**  
>    - Contrast ratio WCAG AA+.  
>    - Tap targets large enough for thumb reach.  
>    - Instant load (<100ms).  
> 
> ### Deliverable  
> A responsive implementation (mobile + desktop) that feels premium, magical, and converts. Avoid clutter. Every detail should feel as smooth as an Apple onboarding screen.  

---

Do you want me to also **write out the full HTML/Tailwind structure** for this so you can literally drop it into your Next.js project and iterate from there?
