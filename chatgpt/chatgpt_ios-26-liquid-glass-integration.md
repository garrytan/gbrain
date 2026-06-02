---
title: "iOS 26 Liquid Glass Integration"
type: guide
created: 2025-07-10
updated: 2025-07-10
source: chatgpt-export
conversation_id: 686f23ab-5830-8007-ac3e-c9a93fd4def2
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# iOS 26 Liquid Glass Integration

> Conversation ID: 686f23ab-5830-8007-ac3e-c9a93fd4def2
> Created: 2025-07-10T02:21:31Z
> Updated: 2025-07-10T02:21:56Z
> Messages: 2

---

## User

{'asset_pointer': 'file-service://file-2HHDUmZ1tQ7LqmpZNC37Zn', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 96692, 'width': 708}
{'asset_pointer': 'file-service://file-HFmmRnfxyJWXBW2KyBNo7m', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 109932, 'width': 708}
{'asset_pointer': 'file-service://file-TmG4fQZXmgcgKe3z8MSf7s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 99040, 'width': 708}
{'asset_pointer': 'file-service://file-6gQjVdkS8VDV8MVSjCoX4L', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 109715, 'width': 708}
{'asset_pointer': 'file-service://file-5XF3eomiatxYeYYGWzzrY5', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 87631, 'width': 708}
{'asset_pointer': 'file-service://file-578gXJWDqSGrB5WPjwBAyn', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 96781, 'width': 708}
{'asset_pointer': 'file-service://file-LZDNTNAzQVYSDGfqituBDA', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 103326, 'width': 708}
{'asset_pointer': 'file-service://file-5dG17xtejVdiDY17m97d9U', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 114065, 'width': 708}
{'asset_pointer': 'file-service://file-AL87UVpAepAZn8QAYxAMVH', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 100324, 'width': 708}
{'asset_pointer': 'file-service://file-S8cLZwfuP2SxBe1QbYc4z8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 79049, 'width': 708}
This is our first attempt at adding iOS 26 Liquid Glass. This is our first attempt at adding iOS 26 Liquid Glass. Yeah, so we just did our first pass of adding Liquid Glass to our onboarding process. And, as you can see, it doesn't really look that great. We do have fallback in place on the elements that have so far been changed to revert back to our original elements in situations where the user is not on iOS 26 and therefore the new SwiftUI elements aren't available. But I would love for you to take a look at the Liquid Glass spec. Everything you know about Liquid Glass. Obviously you're going to have to search the internet for this because it's brand new and we're only on the developer beta 3 of iOS 26. And so I need you to look at everything available on it. Look at accessibility. Look at some of the complaints so far and how those have been changed between betas 1, 2, and 3 to improve accessibility. I know that earlier versions were super translucent and they've since gone a bit, pulled back a little bit, being a little bit more opaque. But we don't want to be defining anything ourselves. We want to lean on the SwiftUI kit as much as possible and what is pre-built for us and everything and not be too explicit so that as things get updated we automatically adopt those changes. We don't want to be too opinionated in how it's coded. We want the flexibility that as the updates come in and stuff we benefit from the improvements in the design and accessibility. And so what I need is for you to look at all of the screenshots that I've attached here and look at everything that Apple is doing with Liquid Glass and the native Apple apps and everything and anyone who's really innovating in the Liquid Glass design so far which obviously there's very limited stuff out there right now but we'll try and find what we can. And then look at how can we adopt that stuff to these screenshots, these onboarding steps in our app. How can we improve what we've already done or maybe what we've already done sucks and we need to remove it completely. But we want to build out these onboarding screens in a really slick Liquid Glass UI that takes full advantage of it but does it in a way that is complementing our design, enhancing our design, enhancing usability and not just hindering accessibility and hindering usability for the sake of design.

---

## Assistant

iturn0image0turn0image2turn0image11turn0image6

Here’s a polished, concise breakdown, Mr. White:

---

## 🔍 What Apple Built With Liquid Glass

- **Material-based design** leveraging translucency, depth, light refraction/reflection, and curved layers—derived from visionOS—available via SwiftUI/UIKit/AppKit for developers citeturn0search0turn0search13turn0search29.  
- Intended for responsive, dynamic UI: floating modals, frosted buttons and navbars, contextual emphasis, cross-platform consistency citeturn0search13turn0search29.  
- Accessibility baked in: supports contrast modes, transparency reduction, motion reduction, respects WCAG/EU-ICT standards citeturn0search3turn0search13turn0search29.

---

## 🧭 Current Challenges

- **Beta feedback:** Beta 1 was too transparent—notifications and Control Center unreadable citeturn0news19turn0news20turn0news21turn0search5turn0search2turn0search10.  
- **Beta 2 tweaks:** Darker blur, high-contrast mode added, improved readability citeturn0news19turn0news20turn0search2turn0search10.  
- **Beta 3 over-correction:** More opaque/frosted; lost aesthetic for some; diverts too close to pre‑26 look citeturn0news19turn0news20turn0news21turn0search5turn0search7turn0search10turn0search14.  
- **Community reaction:** Divided. Some say it’s now accessible; others say it’s lost its magic and needs user configurable opacity citeturn0news19turn0search5turn0search2turn0search11turn0search12turn0search14turn0search16.

---

## ✅ Recommendations for Your Onboarding

1. **Use Apple's built-in SwiftUI `.liquidGlass` material** where appropriate.  
   - Don’t custom paint. Stick to what Apple provides so future updates roll in automatically.

2. **Prioritize readability in key screens** (e.g., "Stay on track", "Import Photos"):  
   ```swift
   .background(Material.thick) // or .ultraThinMaterial with opacity fallback
   ```
   - Use fallback via `if #available(iOS 26, *)` with `.ultraThinMaterial` or `.thickMaterial`.

3. **Avoid layering multiple translucent elements.**  
   - One glass layer per screen section. Background wallpaper behind may cause noise.

4. **Enable accessibility adaptive behavior**:  
   - Don’t override system transparency. Let users with “Reduce Transparency” get solid backgrounds automatically.

5. **Add context-sensitive solid backgrounds for critical text/buttons**  
   - E.g., notifications, navigation bars — use `.thickMaterial` or even `.regular` for contrast.

6. **Test across beta devices & settings**:  
   - On iOS 26 Beta 3, test Control Center–style onboarding sections. Ensure fallbacks align with Beta 3 frosted look.

---

## 🖼 Example Onboarding Application

| Screen | Change |
|-------|--------|
| Welcome & Profile setup | Use `.ultraThinMaterial` glass panel with subtle shadow. One layer only. |
| Stay-on-track reminders | `.thickMaterial` behind text + high contrast button. |
| Photo import | Solid panel or thin material; if wallpaper busy, fallback to opaque. |
| Permissions (notifications, Apple Health) | Semi-transparent glass with blurred dark tint behind icons/text to ensure legibility. |

---

## 🎯 Summary

- **Lean on Apple-provided Liquid Glass materials.**
- Use more opacity for readability—stick to `.thickMaterial` or let the system adapt.  
- Avoid stacking translucency.  
- Let accessibility features do the heavy lifting on contrast.  
- Test thoroughly and let future betas guide refinements.

---

By adopting this approach, your onboarding will stay modern, responsive, aligned with Apple’s vision, and most importantly, accessible and maintainable. Let Liquid Glass enhance, not hinder, your user experience.

Would you like SwiftUI snippet examples implementing this?
