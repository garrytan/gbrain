---
conversation_id: 686ee2bb-67a4-8007-aeea-a7d166eb692b
created: 2025-07-09
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Share Progress Flow Design
type: note
updated: 2025-07-09
---

# Share Progress Flow Design

**Related:** [[design_ux]]

> Conversation ID: 686ee2bb-67a4-8007-aeea-a7d166eb692b
> Created: 2025-07-09T21:44:27Z
> Updated: 2025-07-09T21:44:36Z
> Messages: 2

---

## User

I'm going to use Google Stitch to generate some UI designs for us. So what I want now is, you know everything about our Lock Your Body app. I want to build a feature that's a share button. They click, and it's going to generate a shareable asset for Instagram. And I'd like this to be a 4-5 image for Instagram. And I would like it to basically take their progress photo. It'll have their photo with the black background, kind of like it shows in the app. But it'll have their photo, which we have already AI cropped and resized and background removed. And we'll take their photo, and we'll then overlay on the bottom their user's name, their height, their FFMI, their weight, their current body fat percentage, and their biological sex. And we basically want to have a flow where they—we want the flow to be intuitive and world-class UX. But basically the flow is that they would go into an entry in their log and be like, okay, I want to share this. Like, this was me today, or this was me five years ago or something. And it would basically share, and it would generate that 4-5 image of them with their name and their stats on it. And it could even include their step count for the day, because we have that, and their lean body mass. And then we want that all in a super clean, modern, futuristic, high-end aesthetic. We're going for linear.app for inspiration for design. We're going for color-agnostic companies like Apple and Equinox. We use, like, heavy black and white. We're dark mode first, so we're looking for things that are primarily white and black. And so we want to generate that image. That's a shareable asset. Once we have that image, you can click and export it to do all the social sharing. So, like, share it to Instagram and share it to TikTok as a photo and do all the, like, deep-link shortcuts where you can open it as an image. And then part of that flow is that we also want that you could select two images, and it would do, like, the same thing, but it would split. And so you could see a side-by-side comparison in that 4-5 image. And this side-by-side comparison would be, like, would have the two images, and it would show the stats on one, be like, oh, this is him at 30 years old and 20% body fat and 212 pounds. And here's him at 34 years old at 8% body fat and 160 pounds. You know what I mean? And then you'd have the center metrics that would be, like, their name and their gender and the things that haven't changed. But here you see the FFMI on each and the step count on each and all that. And then part of that flow is we want to have a little, an option for you to toggle which metrics you turn on and off. Like, maybe you don't even want to display your name, or maybe you don't want to display your sex, maybe you don't want to display your FFMI, or you don't want to put your weight, you just want to put your body fat percentage. So we want users to be able to turn that all on and off. And then another thing would be, maybe you want to do a transformation post where you show, here I am at the beginning of the cut and the end of the cut. Maybe we want to display a label somewhere that's a little more prominent that shows the time span. So it's like, oh, here's my change over 12 weeks, or here's my change over 2 years. So we just want to say, like, 2 years in the center. So it indicates the difference between the first photo and the second photo. And then finally we want to be able to have you not just do a single photo with 2 different progress photos on it. We want to be able to have you export multiple progress photos into a carousel post on Instagram. So then it would show one photo with all the stats for the first, and then one photo with all the stats for the second. And you'd be able to show a carousel post of, like, before and after, basically. And for now we'd probably cap that at 2 photos, but eventually we can support as many photos as Instagram carousel support. Because I think that would be a fun experience for people to just be able to see carousel posts and start swiping through them and slowly see a body transform. I think it would be pretty cool. You know what? So maybe we just do that out the gate. Maybe we allow that up to 20 posts or something like that, and then it would just export all 20. And so they need to be able to see a preview, then, of what's going to be exported. And they need to be able to swipe through, if it's multiple photos, on that preview. And then finally, they need to be able to hit the button to open up the social app and do the posting with that image. So we need that whole flow built out as an iOS app using SwiftUI. But leaning into everything I said, in terms of copywriting, we follow Y Combinator principles. We also follow Y Combinator principles for UX design and everything. And then copywriting, like Apple, is obviously the gold standard. So give me a well-written prompt that I can use to give to our AI agent for design to generate some designs.

---

## Assistant

Mr. White, here’s a single prompt you can feed into your AI design agent (e.g. Google Stitch) to generate a world-class SwiftUI “Share Progress” flow for Lock Your Body:

---
**Prompt:**  
Design a “Share Progress” feature for the Lock Your Body iOS app in SwiftUI. The flow must let users pick one or up to 20 AI-cropped, background-removed progress photos and export them as a dark-mode-first, black-and-white carousel post for Instagram/TikTok. Aesthetic should be minimal, futuristic, high-end—think Linear.app + Apple + Equinox.

**Key screens & interactions:**  
1. **Entry list → Share action**: User taps a log entry, then “Share.”  
2. **Photo picker & preview**: Grid of past progress photos; tap to select up to 20. Preview full-screen carousel.  
3. **Metrics overlay toggle**: On/off switches for each metric: Name, Biological Sex, Height, Weight, Body Fat %, FFMI, Lean Body Mass, Step Count, Time Span label.  
4. **Side-by-side mode**: When selecting exactly 2 photos, automatically offer a split-screen layout with shared info centered (Name, Sex) and per-photo stats on each side, plus a prominent “# weeks/months/years” label.  
5. **Export & deep-link**: Final screen shows preview carousel with an “Export” button. Tapping opens iOS share sheet with deep-link support for Instagram/TikTok.  

**Style & copy:**  
- Dark background, white typography, ultra-thin lines, generous spacing.  
- Use concise, user-first labels (“Select Photos,” “Show Name,” “Export to Instagram”).  
- Follow YC-style directness and Apple-level clarity.  

Deliver high-fidelity SwiftUI mockups of every step—picker, overlay toggles, preview carousel, and share sheet.  
---


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_onboarding-flow-design]]
- [[chatgpt/chatgpt_3d-muffin-head-design]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_ai-design-review-tools]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
