---
title: "Building a 3D Demo UI"
type: note
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
conversation_id: 69962f16-9674-832b-a1de-e8f138af76d6
message_count: 2
tags: [chatgpt, import]
---
# Building a 3D Demo UI

> Conversation ID: 69962f16-9674-832b-a1de-e8f138af76d6
> Created: 2026-02-18T21:30:05Z
> Updated: 2026-02-18T21:32:31Z
> Messages: 2

---

## User

explain to me here how they built this screenshot demo. its not a screenshot it appears to be real components. is this the actual dashboard fform their app jsut embeded or did they build a simplied version with mock data in a new component? how did they then make it look 3d? just modified css? how would i build this for Jovie?

---

## Assistant

Mr. White — you’re reading it right: that “screenshot” on Linear’s homepage is almost certainly *live UI*, not a flat image.

### Is it their real app embedded, or a simplified mock?
Usually companies do **one of these two**:

1) **Real app shell + “demo mode” data**
- They reuse the actual components (Issue row, sidebar, status pill, etc.).
- They swap the backend for **mocked/local data** (static JSON, MSW, a tiny in-memory store), and often disable risky areas (auth, billing, settings).
- This is consistent with Linear explicitly having a demo environment where changes are local and reset on refresh. citeturn0search15

2) **A purpose-built “marketing demo app”**
- Looks identical, but is a separate mini-app that only implements the handful of interactions shown on the page.
- Still uses real components (copied or imported from the design system), but *not* the full product runtime.

**My bet for Linear’s homepage:** they’re reusing **real components** (or design-system equivalents) in a **demo mode**, because it’s the fastest way to get “it feels real” polish without maintaining a fake UI forever.

### How they make it look 3D
Almost always **CSS 3D transforms + lighting**:
- A parent wrapper sets `perspective`
- The “window” tilts with `rotateX/rotateY`
- Child layers can use `translateZ` with `transform-style: preserve-3d`
- Depth is sold with **multi-layer shadows**, subtle **border highlights**, and often a **gradient “sheen”** overlay.

References for the underlying mechanics: CSS perspective/3D transform behavior is exactly what these explain. citeturn0search25turn0search22

There’s typically also a tiny bit of JS to map mouse position → tilt (or to animate between keyframes), but the “3D” itself is CSS.

---

## How I’d build this for Jovie (practical approach)
### 1) Build a “Demo App” route
Create `/demo` (or an embedded component) that renders:
- Sidebar + top bar + a couple key screens
- A **scripted dataset** (JSON fixtures)
- A **scripted interaction layer** (e.g., clicking a row changes the right panel, typing shows a toast, etc.)

Implementation options:
- **Best dev velocity:** your real UI + **mock API** (MSW) + feature flag `DEMO_MODE=true`
- **Best containment:** a separate “marketing-demo” package that imports your shared UI components

### 2) Embed it on the marketing page
- Render the demo inside a fixed “device/window” container.
- Lock the layout so it never jumps (fixed heights, skeleton states, preload fonts).

### 3) Add the 3D “hero” treatment
- Wrap the demo in a `HeroTilt` container that:
  - applies perspective
  - tilts based on mouse/gyro (small angles, like 2–6 degrees)
  - adds layered shadows + a subtle specular highlight

### 4) Keep it cheap to maintain
Rules that keep this from becoming a second product:
- Only 2–3 core interactions
- No real auth
- No real networking (or only mocked)
- Data fixtures live next to the demo and are versioned

---

If you tell me what Jovie is (product type) and what **2–3 interactions** you want to “feel real” (e.g., create task, move status, open detail panel), I’ll outline the exact demo screens + the mock dataset structure to match.
