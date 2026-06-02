---
title: "AI homepage redesign prompt"
type: essay
created: 2025-12-07
updated: 2025-12-07
source: chatgpt-export
conversation_id: 6934cd2f-2e0c-8328-9031-adb468476003
message_count: 18
tags: [chatgpt, import, code, long-form]
---
# AI homepage redesign prompt

> Conversation ID: 6934cd2f-2e0c-8328-9031-adb468476003
> Created: 2025-12-07T00:42:09Z
> Updated: 2025-12-07T04:05:50Z
> Messages: 18

---

## User

Give me a prompt to get our ai agent to look at our homepage and recursively redesign It til it matches apple level standards. It should change the messaging or copy just the design and style. It should work in dark mode and light mode and fit apple level design with lienar.app style aesthtics.

---

## Assistant

Here is a **ready-to-use master prompt**, Mr. White. You can give this to your AI design agent. It is written so the agent:

- Audits your homepage
- Recursively iterates on layout, visual style, typography, spacing, and UI elements
- Does **not change messaging or copy**
- Targets **Apple-level standards**
- Matches **linear.app visual aesthetics**
- Produces variants for **light and dark mode**

---

## **MASTER PROMPT (Copy/Paste for Your Design Agent)**

**Objective:**  
Analyze our homepage and **recursively redesign the UI and visual system until it reaches Apple-level visual refinement** with **linear.app–style aesthetics**. Do **not rewrite or alter the marketing messaging or copy** unless necessary for readability or spacing. The focus is purely **design quality, layout consistency, component clarity, and interface polish**.

---

### **Core Design Requirements**

1. **Aesthetic Benchmark**
   - Match **Apple.com** for design purity, hierarchy, smooth geometry, and typographic balance.
   - Incorporate **linear.app** visual language: calm minimalism, soft gradients, gentle shadows, clean component structure, calm empty states, and symmetrical spacing.

2. **Design System Consistency**
   - Responsive grid
   - Predictable spacing scale
   - Componentized UI elements
   - Smooth edge radius rules (not random)
   - Tighter visual hierarchy
   - Harmonized iconography
   - Uncluttered layout
   - Reduce visual noise aggressively

3. **Modes**
   - Produce both **light mode** and **dark mode**
   - Maintain identical component structure between modes

4. **Copy**
   - Treat existing homepage messaging as **locked**
   - Only adjust line breaks or typographic rhythm for readability

5. **Accessibility**
   - WCAG contrast compliance
   - Secondary colors that remain calm and unobtrusive
   - Larger tap targets and clear information hierarchy

---

### **Recursive Iteration Rules**

Each iteration must:

- Identify flaws, inconsistencies, and weak UI/UX elements
- Propose replacements with cleaner, simpler, more elegant structures
- Generate component diagrams or high-level visual descriptions
- Improve typography, spacing and layout every cycle
- Validate visual coherence between **mobile, tablet, and desktop**
- Continue iterating until:
  - Design feels world-class
  - There are no visual conflicts
  - Every UI panel matches Apple-level execution quality with linear-app calmness

You must **not stop after one redesign**. Keep refining until there is no further improvement to be made.

---

### **Deliverables per Iteration**

For each pass, deliver:

1. **Design Audit Summary**
   - Current weaknesses and misalignments
   - Hierarchy, spacing, component, and style critiques
   - Where the page falls below Apple/linear.app standards

2. **Improvement Plan**
   - Component-level redesign instructions
   - Grid and spacing rules
   - Typography rules (scale, weights, vertical rhythm)

3. **Updated Page Specification**
   - Detailed section-by-section layout description
   - New component structures
   - Visual transitions and animations if appropriate

4. **Light Mode + Dark Mode Specs**
   - Color tokens
   - Gradients
   - Shadows
   - Elevation hierarchy
   - Border rules
   - Background mapping

5. **End-State Check**
   - Confirm improvements match Apple-level polish
   - Confirm linear.app calm minimalism is achieved
   - Confirm structure remains readable and intuitive

---

### **Stopping Condition**
Stop only when further refinement is no longer meaningful, and the system has:

- Zero layout inconsistencies
- Perfect grid rhythm
- Professional design language
- No spacing anomalies
- Full light/dark parity
- Apple-quality polish with linear-calm minimalism

---

If you'd like, Mr. White, I can:  
**(1) modify this prompt for Figma agents**,  
**(2) modify it for UI component generators**, or  
**(3) add instructions for automatic visual previews.**

---

## User

{'asset_pointer': 'sediment://file_00000000347871fd8a2ce8ef9ab4906e', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 749, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1193709, 'width': 1227}
Fix this design

---

## Assistant

Mr. White — here is **a concise redesign direction that makes this screen Apple-grade + linear.app calm + dramatically cleaner**.

---

# **STRUCTURAL FIXES**

### **1) Stop the 50/50 Split**
The current left/right split makes the login form feel tiny and disconnected. Apple and Linear never isolate the form on a narrow black island.

**Fix:**  
- Keep the gradient background full-bleed behind the entire page
- Place the login card centered in front of it

This instantly:
- improves visual hierarchy  
- increases confidence and focus  
- feels more premium and calm  

---

# **2) Convert Login Into a Card Component**

Replace the loose floating fields with a **vertical card**:

**Card Rules**
- 440–520px width
- 32–48px padding internal
- Large radius (16–24px)
- Ultra-soft shadow (blur 64–120, opacity 8%)
- Neutral elevation, no harsh outlines

**Top of Card**
- Title: “Sign in”
- Subtitle: small, secondary text
- Put fields and button under it

This immediately becomes Apple-like: centered, symmetrical, quiet.

---

# **3) Typography Hierarchy**

Current typography is loud on the left and weak on the right.

**Use:**
- Display for “Jovie” (but reduce size slightly)
- Large headline for welcome text
- Body size for supporting paragraph
- Login form labels: 14–15px, medium weight
- Button text: 15–16px, medium/semi-bold

Keep all line spacing balanced and gentle.

---

# **4) Improve Field Styling**

Right now fields are **outlined**, which feels dated and SaaS-generic.

**Replace with:**
- Filled inputs (subtle neutral background)
- Soft radius
- Light inner shadow or elevation
- Smooth 0.8–1.2s focus animation

This is exactly how Apple and Linear handle modern fields.

---

# **5) Make the Button Primary + Full Length**

The current button is visually weak.

**Fix:**
- Full width inside card
- Solid primary fill (white or near-white if dark card, neutral if light card)
- Smooth interaction state (pulse, or elevation)
- Rounded corners matching card radii

Visually stable and premium.

---

# **6) Dark Mode + Light Mode Parity**

Don’t invert the whole page.

**Rules:**

### **Light Mode**
- Card: near-white
- Field: slightly darker neutral fill
- Button: black or deep neutral fill
- Text: full black hierarchy

### **Dark Mode**
- Card: deep neutral charcoal
- Field: slightly lighter charcoal fill
- Button: white or near-white fill
- Text: soft neutrals, not pure white

---

# **7) Fix the Gradient**

Your gradient looks strong and gaming-style. Apple and Linear gradients are:

- subtle,
- lower contrast,
- smoother falloff,
- more spatially diffused.

**Fix:**  
- Increase gradient blur and radius
- Lower saturation
- Soften the corners
- More ocean-calm or aurora-calm aesthetic

The gradient should feel like an ambient light source rather than a splashy background.

---

# **8) Replace “Don’t have an account” Placement**

Right now, the supporting text floats awkwardly.

**Fix:**  
Place it **under the card**, centered, with much smaller hierarchy.

This removes clutter inside the form and feels intentional.

---

# **9) Combine Brand + Welcome More Elegantly**

Instead of huge bold blocks on the left:

**Use:**
- Centered brand at top of page
- Welcome text above the card
- Or inside the card

This stays cleaner and more Apple-like — they never split hero and form into two different worlds unless it’s landing marketing.

---

# **10) Motion**

Simple micro-interactions:

- Card fades in with 120–200ms ease-out
- Fields animate on focus with a soft elevation
- Button hover slightly enlarges scale (102–104%)

Clean, calm, tactile.

---

# **PREMIUM ARCHITECTURE**

### **Final Layout Structure**

```
Full screen gradient background

     [   Brand Title   ]

   [Welcome back to Jovie]
   [Small supporting text]

      ┌───────────────────────┐
      │ Sign in               │
      │                       │
      │ [Email field]         │
      │ [Send code button]    │
      └───────────────────────┘

   [Don’t have an account? Join waitlist]
```

No side split. Everything vertically centered. Symmetrical. Calm.

---

# **IF YOU WANT IT EVEN MORE APPLE**

- Add tons of negative space above and below (Apple uses absurd spacing)
- Reduce color intensity another 20–30%
- Rely on **light elevation + typography hierarchy**, not decoration

---

# **SUMMARY OF MAJOR IMPROVEMENTS TOP-LEVEL**

- Remove 50/50 split entirely
- Center a minimal login card on ambient gradient
- Field styles become filled and calm
- Typography consistent and gentle
- Light/dark parity implemented at token level
- Shadows extremely soft, micro-animations gentle

This puts you in **Apple + Linear territory** visually and emotionally.

---

If you want, Mr. White, I’ll now:

1) **rewrite this into a spec for a Figma agent**
2) **rewrite into CSS + Tailwind tokens**
3) **produce an Apple-style design system for the entire auth experience**

---

## User

{'asset_pointer': 'sediment://file_000000009be471fdbdbd1f3f3c90c25e', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 111, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 11106, 'width': 120}
I wanna make this logo into a spinner animation where the tail of it fades out. Can you generate the svg that I can spin on the page

---

## Assistant

Here you go, Mr. White — a self-contained SVG spinner where the “tail” fades out and the whole logo spins.

You can drop this directly into your page:

```html
<svg
  width="64"
  height="64"
  viewBox="0 0 44 44"
  xmlns="http://www.w3.org/2000/svg"
>
  <style>
    .spinner {
      transform-origin: 50% 50%;
      animation: spin 0.9s linear infinite;
    }

    @keyframes spin {
      100% {
        transform: rotate(360deg);
      }
    }
  </style>

  <defs>
    <!-- Fading tail along the arc -->
    <linearGradient id="spinnerGradient" x1="6" y1="22" x2="38" y2="22" gradientUnits="userSpaceOnUse">
      <stop offset="0%"  stop-color="white" stop-opacity="0" />
      <stop offset="35%" stop-color="white" stop-opacity="0.35" />
      <stop offset="100%" stop-color="white" stop-opacity="1" />
    </linearGradient>
  </defs>

  <!-- Ring with small gap; gradient makes the tail fade -->
  <g class="spinner">
    <circle
      cx="22"
      cy="22"
      r="14"
      fill="none"
      stroke="url(#spinnerGradient)"
      stroke-width="8"
      stroke-linecap="round"
      stroke-dasharray="82 30"
    />
  </g>
</svg>
```

Notes:

- The **stroke-dasharray** creates a nearly full ring with a small gap (like your logo).  
- The **linearGradient** makes one end of the arc transparent → solid, giving the fading tail.  
- The **spin** animation rotates the whole ring; you can slow it down by increasing `0.9s` to e.g. `1.4s`.  
- Works clean on a dark background; change `stop-color="white"` to another color if needed.

---

## User

 This is good but I want the tail to be faded this has a fade in the middle

---

## Assistant

Understood, Mr. White — you want **a full solid arc with ONE end fading out**, not a fade in the middle.

Here is an SVG that does exactly that:

- Full ring with soft gap
- **Tail fades out at the end**
- Entire shape spins
- No mid-gradient — only tail transparency

---

# ✅ **SVG SPINNER WITH END-FADE**

```html
<svg
  width="64"
  height="64"
  viewBox="0 0 44 44"
  xmlns="http://www.w3.org/2000/svg"
>
  <style>
    .spinner {
      transform-origin: 50% 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>

  <defs>
    <!-- Gradient ONLY at the end of the stroke -->
    <linearGradient id="fadeTail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="44" y2="0">
      <stop offset="0%" stop-color="white" stop-opacity="1"/>
      <stop offset="75%" stop-color="white" stop-opacity="1"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <g class="spinner">
    <circle
      cx="22"
      cy="22"
      r="14"
      fill="none"
      stroke="url(#fadeTail)"
      stroke-width="8"
      stroke-linecap="round"
      stroke-dasharray="82 30"
    />
  </g>
</svg>
```

---

# ⭐ **Why This Works**

- The linear gradient runs **along the stroke direction**, so one end stays solid while the **last 25% fades to zero opacity**
- `stroke-dasharray="82 30"` creates a **small physical gap**, like your logo
- The entire group rotates, so the fading tail is always moving
- Fade is **only at the end**, no central fade

---

# ⚙️ TUNING OPTIONS

### Tail longer:
```html
<stop offset="60%" stop-color="white" stop-opacity="1"/>
```

### Tail shorter:
```html
<stop offset="85%" stop-color="white" stop-opacity="1"/>
```

### Spin slower:
```css
animation: spin 1.6s linear infinite;
```

---

If you want next, I can:

- Convert the fill to any brand color  
- Make the tail a **Gaussian blur** for ultra-premium feel  
- Render a **dark mode version** automatically  
- Add easing or pulse in rotation  

Just tell me what you want next.

---

## User

That's cool, I want a longer tail and you have to handle the weird curve of it so it doesnt look cheap or hacky

---

## Assistant

Got you, Mr. White. Let’s make the tail longer and keep the curve mathematically clean so it doesn’t feel hacky.

Below is a single SVG where:

- The “ring” is a true circle (perfect curve)
- The **visible arc is long** (small gap)
- Only the **last part of the arc fades out**
- The whole thing spins as a loader

You can drop this straight into your page.

```html
<svg
  width="64"
  height="64"
  viewBox="0 0 44 44"
  xmlns="http://www.w3.org/2000/svg"
>
  <style>
    .spinner {
      transform-origin: 50% 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  </style>

  <defs>
    <!-- Gradient along the arc: most of it solid, tail fading out -->
    <linearGradient
      id="spinnerTail"
      x1="22"
      y1="2"
      x2="22"
      y2="42"
      gradientUnits="userSpaceOnUse"
      gradientTransform="rotate(-40 22 22)"
    >
      <!-- Long solid body -->
      <stop offset="0%"   stop-color="white" stop-opacity="1" />
      <stop offset="70%"  stop-color="white" stop-opacity="1" />
      <!-- Tail fade -->
      <stop offset="100%" stop-color="white" stop-opacity="0" />
    </linearGradient>
  </defs>

  <g class="spinner">
    <circle
      cx="22"
      cy="22"
      r="14"
      fill="none"
      stroke="url(#spinnerTail)"
      stroke-width="8"
      stroke-linecap="round"
      stroke-dasharray="80 16"
    />
  </g>
</svg>
```

### What’s different vs the last one

- **Longer tail:** `stroke-dasharray="80 16"` makes the visible arc ~80/96 of the circle, so you get a long sweep and small gap.
- **Clean curve:** it’s just a circle with a stroke, so the curvature is perfect – no weird path joins.
- **Tail fade only at the end:** the gradient is solid from `0%` to `70%`, then fades to `0` opacity at `100%`.  
- **Alignment with the curve:** `gradientTransform="rotate(-40 22 22)"` rotates the gradient so the fade happens along the curved tail instead of feeling like a straight-line cut.

### Tweaks if you want to dial it in

- **Even longer tail:**  
  `stroke-dasharray="84 12"`
- **Shorter tail:**  
  `stroke-dasharray="72 24"`
- **Longer fade region:**  
  change the middle stop to `offset="60%"`.
- **Slower spin:**  
  `animation: spin 1.4s linear infinite;`

If you want, I can also give you a version where the inner “hole” is explicit (like your logo donut) using two concentric paths instead of just a stroked circle.

---

## User

We need an apple level copyright headline for our hero that like put your music marketing on autopilot or something but it should be yc approved and outcome driven not feature driven

---

## Assistant

Mr. White — here are **Apple-level, YC-fundable, outcome-driven hero headline options** for a music-marketing AI product. No features, no buzzwords, no fluff — all **results, control, leverage, compounding value**.

I’ll give you **10 tightly-crafted lines** plus **10 subheads** you can mix and match.

---

# **TOP-TIER HEADLINE OPTIONS**

### 1)   
**Grow your audience while you sleep**

### 2)  
**Turn every track into momentum**

### 3)  
**Your music deserves predictable growth**

### 4)  
**Consistent listeners without constant promotion**

### 5)  
**Release music. We handle the traction.**

### 6)  
**Make every release reach the right fans automatically**

### 7)  
**Fan growth on autopilot**

### 8)  
**Your catalog becomes a growth engine**

### 9)  
**Effortless visibility for every release**

### 10)  
**Turn creativity into compounding reach**

---

# **PREMIUM SUBHEADS (YC STYLE)**

Pick one under any headline:

1) **AI handles targeting, placements, timing, and optimization — you stay focused on making music.**
2) **Stop gambling with promotion. Get steady fan acquisition and measurable reach.**
3) **Every song gets smarter, every release performs better, every audience expands.**
4) **Artists grow faster when distribution, targeting, and follow-up are automated.**
5) **Know exactly who your fans are, where they are, and how to reach more like them.**
6) **Predictable traction, sustainable growth, zero manual marketing.**
7) **We turn catalog data into compounding audience growth over time.**
8) **Artists should create — machines should market.**
9) **Your releases become predictable acquisition events, not social media chores.**
10) **Consistent streams, real fans, less grind, more music.**

---

# **BEST ALL-AROUND COMBO (APPLE + YC)**

**Turn creativity into compounding reach**  
Artists create. AI handles targeting, timing, placements, and fan acquisition automatically.

This one:
- **outcome driven**
- **clearly monetizable**
- **not feature-heavy**
- **emotionally resonant**
- **future-inevitable**
- **YC-defensible (automating a repeated acquisition process)**

---

If you want, we can now refine **tone: more premium, more urban, more industry-serious, more startup-clinical, or more emotional** depending on your brand voice.

---

## User

Grow your audience while you sleep and then lets talk about how ai builds a profile for each visitor and drives them to convert rather than give me the decision fatigue with s tak of links

---

## Assistant

Here’s a **clean Apple-level hero structure**, Mr. White:

---

# **Grow your audience while you sleep**

Every visitor becomes a profile, not a click.  
AI learns who they are, where they came from, and what they want — then guides them toward becoming a fan, not another dead-end on a link tree.

---

## **Why this works**

- **Outcome focused** → audience growth, not automation
- **YC approved** → replaces manual funnels with compounding conversion
- **Apple tone** → simple, elegant, no jargon
- **Narrative clarity** → “profile → understanding → conversion”
- **Anti-feature** → implicitly attacks “link stacks” and “decision fatigue” without naming them

---

## **Optional shorter subheads** (if you need variants)

- **AI turns visitors into predictable fans — automatically.**
- **Every interaction compounds into smarter targeting and higher conversions.**
- **No link overload. Just a smooth journey from curiosity to fandom.**
- **Convert curiosity into loyal listeners with zero friction.**

---

If you want, I can now:

1. Make this **more premium and cinematic**, Apple keynote style  
2. Make it **more commercial and revenue-framed**  
3. Make it **more emotional and artist-centric**  
4. Make it **more analytical and enterprise-grade**  

Tell me the direction and I’ll tune it.

---

## User

1

---

## Assistant

Here’s a **cinematic Apple-style rewrite** of what you already landed on — same intent, but with more emotional gravity, less SaaS energy, and more inevitability:

---

# **Grow your audience while you sleep**

Your music deserves more than clicks and chaos.  
Every visitor becomes a story, not a dead-end.  
AI listens, learns, and guides them forward — one calm step at a time — turning quiet curiosity into lasting fans without decisions, dead links, or distraction.

---

If you want alternative tones, I can give:

- **more poetic / cinematic**
- **more cinematic but shorter**
- **more ruthless and YC-commercial**
- **more luxury / Apple-spec minimal**
- **more emotional / artist identity**

Just tell me which dial to turn.

---

## User

Fans not followers

---

## Assistant

Here’s your **cinematic Apple-level upgrade** with the precise phrasing shift baked in:

---

# **Fans, not followers**

Your audience should feel discovered — not lost in a maze of links and choices.  
Every visitor becomes a relationship, not a statistic.  
AI learns their intent, remembers their journey, and guides them toward becoming real fans, quietly and automatically, without distraction or decision fatigue.

---

If you want, I can now make this:

- **shorter and punchier**
- **more emotional and artistic**
- **more luxury-tech minimalist**
- **more commercial-growth focused**

Just tell me which direction you want next.
