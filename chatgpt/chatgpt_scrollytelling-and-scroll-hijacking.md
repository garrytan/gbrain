---
title: "Scrollytelling and Scroll Hijacking"
type: note
created: 2026-03-10
updated: 2026-03-10
source: chatgpt-export
conversation_id: 69b04223-4efc-832e-84d0-1974a8b0ab96
message_count: 2
tags: [chatgpt, import]
---
# Scrollytelling and Scroll Hijacking

> Conversation ID: 69b04223-4efc-832e-84d0-1974a8b0ab96
> Created: 2026-03-10T16:10:24Z
> Updated: 2026-03-10T16:11:43Z
> Messages: 2

---

## User

what is th eux experience where you combin scroll hijacking with an element moving like an apple landing page where you see an iphone then as you scroll it breaks open and scrolls with the user til text about the insides of the iphone pull into view and then scroll hijacking explains the cpu and ram etc

---

## Assistant

The pattern is commonly called **scroll-driven storytelling** or **scrollytelling**. It combines **scroll hijacking** with **scroll-triggered animations** that synchronize visual elements with the user’s scroll position.

### Core Terms

- **Scrollytelling**  
  Narrative content revealed progressively as the user scrolls. Popularized by interactive journalism and later used in product marketing pages.

- **Scroll-linked animation**  
  Animations whose progress is tied directly to scroll position (e.g., an iPhone rotating or opening as the page scrolls).

- **Scroll hijacking**  
  The page intercepts native scroll behavior to control pacing or trigger discrete animation steps.

- **Pinned / sticky sections**  
  An element stays fixed while the user scrolls, allowing text panels to appear while the visual object animates.

### Typical Implementation Pattern
The Apple-style product page effect usually includes:

1. **Pinned hero element**  
   Product stays centered while the scroll advances the animation timeline.

2. **Scroll-scrubbed animation**  
   Frame-by-frame sequence or 3D transform tied to scroll progress.

3. **Sequential text panels**  
   Content blocks fade/slide in as the animation reaches certain progress points.

4. **Section release**  
   The pinned element unpins and normal page scrolling resumes.

### Common Technical Approaches

- **GSAP ScrollTrigger** (very common for Apple-style pages)
- **Three.js** for 3D product models
- **Lottie scroll-scrub animations**
- **CSS Scroll-Linked Animations** (`scroll-timeline`, emerging standard)
- **Canvas frame sequences** (Apple frequently uses image sequences)

### Related UX / design terms

- **Scroll choreography**
- **Immersive product storytelling**
- **Narrative scrolling interface**
- **Interactive product reveal**

### Famous Examples
- Apple product launch pages (iPhone, MacBook, AirPods)
- New York Times interactive articles
- Stripe product pages
- Tesla product pages

### Industry shorthand
Designers often simply say:

> “An Apple-style **scrollytelling product page** with **scroll-scrubbed animation and pinned sections**.”

If useful, I can also outline the **exact front-end architecture Apple-style pages use** (image sequence + scroll scrub + pinned container) and the **GSAP implementation pattern** most teams replicate.


## See Also
- [[chatgpt/chatgpt_scroll-hijacking-explained]]
- [[chatgpt/chatgpt_infinite-scroll-table]]
- [[chatgpt/chatgpt_scroll-header-transition]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
