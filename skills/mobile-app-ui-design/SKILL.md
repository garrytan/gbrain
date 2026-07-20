---
name: mobile-app-ui-design
description: Design high-quality mobile app UI/UX screens, flows, and components. Use this skill whenever the user asks to design a mobile app screen, create app mockups, build mobile UI components, improve an existing mobile app design, create onboarding flows, design mobile navigation, or requests any mobile-first interface work. Also trigger when the user mentions app design, mobile UI, mobile UX, screen design, app mockups, wireframes, or wants to build React Native / Flutter / SwiftUI style interfaces as visual prototypes. Even if the user just says "design an app" or "make this screen look better", use this skill.
---

# Mobile App UI/UX Design Skill

This skill guides the creation of professional, polished mobile app interfaces that follow proven design principles used by top-tier apps like Airbnb, Duolingo, Spotify, Revolut, and Phantom.

## Core Philosophy

Great mobile UI isn't about flashiness — it's about intentionality. Every pixel, every spacing value, every color choice should serve the user. The goal is to create interfaces that feel smooth, personal, and alive — not just functional.

Before designing anything, understand three things:
1. **What is the user trying to accomplish?** (reduce friction to that goal)
2. **How should this make the user feel?** (trust, delight, confidence, calm)
3. **What's the one thing they should notice first?** (visual hierarchy)

## Design Process

Follow this sequence for any mobile screen:

### Step 1: Understand the Context
- What type of app? (fitness, finance, social, productivity, health, crypto, etc.)
- Who is the user? (new, returning, power user — adapt the experience)
- What's the primary action on this screen?
- What industry design conventions apply? (See `references/industry-conventions.md`)

### Step 2: Structure First (UX Lens)
- Map the user flow: what screen comes before and after?
- Identify the MVP elements — only what's essential for this screen
- Place primary actions in the **thumb zone** (bottom 1/3 of screen)
- Follow the **F-pattern** reading order for content layout
- Reduce interaction cost: expose content directly instead of hiding behind taps
- Turn empty states into opportunities with guidance, illustration, and a CTA
- Choose the right input method: sliders/scroll wheels for one-time setup, text fields for repeated/precise entry

### Step 3: Apply Visual Design (UI Lens)
Follow these rules in order:

#### Typography
- Use **one font family** (two max, with clear hierarchy purpose)
- Maximum **4 font sizes** and **2 font weights**
- Use monospace variants for large numbers (prices, stats, metrics)
- Keep text containers under 600px wide for readability
- Create hierarchy with size, weight, and opacity — not just bold everything

#### Color System (60/30/10 Rule)
- **60%** — neutral base (white, light gray, or dark background)
- **30%** — complementary color (black text, dark elements)
- **10%** — brand/accent color (CTAs, key indicators, icons)
- Use **opacity variations** of the neutral color for text hierarchy: 100% for headings, 80% for body, 60-70% for secondary text
- Use the accent color at 5% opacity for secondary buttons and subtle card highlights
- Match shadow colors to the background (tint shadows, never pure gray/black on colored backgrounds)
- Save strong colors (like red) for meaningful moments — overuse kills hierarchy

#### Spacing (8-Point Grid System)
- All spacing values must be divisible by **8 or 4** (8, 12, 16, 24, 32, 48, 64, 80, 96)
- Use **relationship-based spacing**: related elements closer together, unrelated further apart
- Multiplier rule: if related text elements are 16px apart, the gap to the next group should be 2× (32px)
- Section vertical padding: at least 80-96px (160px for major sections on larger screens)
- Card internal padding: 24-32px baseline
- Larger text = larger spacing needed

#### Shadows
- Always use **soft shadows** — never harsh/distinct
- Match shadow color to the background with a tinted hue
- Use subtle white inner shadows on buttons to add dimension
- Add faded drop shadows for depth without heaviness

#### Visual Cues & Imagery
- Use icons, emojis, illustrations, and images to make information digestible
- User avatars/photos > initials > generic icons (for representing people)
- Color-coded categories with soft solid backgrounds + clean isolated images
- Keep visual style consistent across the entire app — no random stock photo mix
- Use AI-generated or curated visuals with matching color palettes

### Step 4: Design for Emotion (Peak-End Rule)
The user will remember two moments: the **peak** (most intense) and the **end** (last impression).

- **Identify your peak moment**: completing a core task, hitting a milestone, finding what they want
- **Design the peak**: micro-animations, celebratory feedback, sparkles, badges, encouraging copy
- **Design the ending**: summary card, progress affirmation, gentle nudge to return
- Add **emotional feedback loops**: success states should feel rewarding (bounce, glow, sparkle)
- Celebrate small wins — success states don't need to be huge, but they should feel intentional
- Use motion and animation as trust signals, especially in high-stakes domains (finance, crypto, health)

### Step 5: Polish & Details
- Add subtle glow effects behind key elements (blur + opacity)
- Use tiny white inner shadows on primary buttons
- Add 5% opacity primary-color borders on secondary elements
- Consider micro-animations for state changes
- Ensure all tap targets are at least 44×44pt
- Check contrast ratios for accessibility
- Design error states, empty states, loading states, and success states

## Smart Patterns to Apply

### Personalization by User Stage
- **New users**: simple welcome, guided setup, minimal options
- **Returning users**: personalized content, routine-focused, progress indicators
- **Power users**: advanced stats, optimization tools, dense information

### Smarter Search
Never show a blank search screen. Include:
- Recent searches
- Popular/trending items
- Personalized recommendations

### Order/Status Tracking
- Open with a confident status message
- Humanize with photos, names, quick-action buttons
- Use visual timelines instead of text-based date lists

### Category Screens
- Use color-coded cards with soft backgrounds and clean isolated images
- Ensure visual consistency across all category items
- Create rhythm in the layout for effortless scanning

### Selection Over Manual Input
- Offer tappable selections for common options (job titles, preferences, etc.)
- Include icons/emojis alongside options for personality
- Provide an "Other" option with manual input as fallback

## Anti-Patterns to Avoid
- Overusing flashy gradients and blur effects (unless you can truly pull it off)
- More than 4 font sizes or 3 font weights
- Random spacing values (use the 8-point grid!)
- Hiding key content behind banners or extra taps
- Placing CTAs outside the thumb zone
- Generic empty states with no guidance
- Using sliders for frequent/precise data entry
- Making all information the same visual weight (no hierarchy)
- Emphasizing labels over values (e.g., making "Sales" bigger than "591")
- Pure gray/black shadows on colored backgrounds

## Implementation Notes

When building these designs as React artifacts or HTML:
- Use Tailwind CSS utility classes for spacing, colors, and typography
- Import Lucide React for clean, consistent iconography
- Use Recharts for any data visualization
- Apply CSS transitions for micro-interactions and state changes
- Use CSS variables for the color system
- Mobile-first: design for 375px width (iPhone SE) as baseline
- Use `rounded-2xl` or `rounded-3xl` for modern card aesthetics
- Apply `backdrop-blur` for glassmorphism effects where appropriate

For deeper guidance on industry-specific conventions and emotional design patterns, read `references/industry-conventions.md`.


## Contract

This skill guarantees:

- Covers its source domain per the skill description: Design high-quality mobile app UI/UX screens, flows, and components. Use this skill whenever the user asks to design a mobile app screen, create app mockups, build mobile UI components, improve an existing mobile app design, create onboarding flows, design mob
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.
