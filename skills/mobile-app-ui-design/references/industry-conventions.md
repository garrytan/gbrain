# Industry Conventions & Emotional Design Reference

## Industry-Specific Design Languages

Different app categories have established visual conventions that users expect. Understanding these helps you decide when to follow conventions (for familiarity) and when to break them (to stand out).

### AI / Tech Products
- Soft gradients and moving elements
- Depth and dimensionality with glowing elements
- Smooth animations communicating intelligence
- Dark or light themes with ethereal accent colors

### Crypto / Web3
- Futuristic aesthetic: neon colors, bold typography
- Dark mode backgrounds with geometric shapes
- High-contrast, cutting-edge visual language
- Key lesson from Phantom: **polish builds trust** — treat visual details, motion, and transitions as core product features, not fluff

### Finance / Banking
- Blue-dominant palettes (trust, stability, reliability)
- Generous white space, clean layouts, conservative typography
- Design must feel safe and professional
- Key lesson from Revolut: tactile interactions (draggable charts, 3D card flips) turn basic features into premium experiences

### Health / Wellness
- Bright, approachable colors to reduce anxiety
- Friendly illustrations and warm micro-interactions
- Non-intimidating onboarding flows
- Key lesson from Ahead (Apple Design Award): guide users kindly, build the "peak" as a personalized insight moment

### Sleep / Meditation
- Purple and deep blue tones (calming associations)
- Minimal UI, soft transitions
- Ambient, low-contrast interfaces

### Education / Learning
- Bright, playful color palettes
- Character-driven experiences with personality
- Key lesson from Duolingo: character animations and emotional feedback loops doubled DAUs from 14.2M to 34M+ in 2 years

### Fitness
- Energetic colors, bold typography
- Progress-focused with visual momentum indicators
- Adapt UI complexity to user stage (new → returning → power user)

### Productivity
- Clean, minimal, information-dense but organized
- Strong grid systems and consistent spacing
- Quick-action patterns and keyboard shortcuts

### E-commerce / Food
- High-quality product photography
- Prominent CTAs and frictionless checkout flows
- Trust signals: reviews, ratings, delivery estimates

---

## Emotional Design Principles

### The Peak-End Rule (from Nobel Prize-winning research by Daniel Kahneman)
The brain doesn't remember an experience as a whole — it compresses it into two moments:
1. **The Peak**: the most intense/emotional moment
2. **The End**: the final impression before leaving

Disney parks use this — 70% of visitors return not because the whole day was flawless, but because the moments they remember were.

### Applying Peak-End to Mobile Apps

**Mapping your journey:**
1. Lay out every step in your core flow (use FigJam, sticky notes, whatever)
2. Ask: Where is the user slowed down? Where might stress peak? Where's the quiet in between?
3. Treat this map as a living document

**Designing the peak:**
- Pick ONE spot to create a "holy dang" moment
- After completing a core task, hitting a milestone, or investing significant effort
- Can be: a badge, a sparkle animation, surprise copy, a personalized brief that builds in front of them
- Micro-animations and supporting tags showing unique value to the user's specific action

**Designing the ending:**
- Never let the app just "fall off" without closure
- Celebrate what was done (check mark, summary card)
- Encourage what comes next
- Reaffirm progress ("You showed up today. That's huge.")
- Gentle nudge to return

**Reducing negative peaks:**
- Look at wait screens, error states, long forms
- Use uplifting microcopy
- Add helpful tools before users even ask
- Use delays as opportunities (loading animations, tips) instead of dead space

**Testing and iterating:**
- Try timing changes, emojis vs icons, animations vs static feedback
- Watch where people drop off and where they linger longer than expected

### Emotional Feedback Loops
When users take actions, don't just give functional feedback — give emotional feedback:
- Correct answer → encouragement, cheer, character reaction (not just a green check)
- Mistake → gentle correction with personality (not just a red X)
- Milestone → celebration that feels proportional to the achievement
- Progress → momentum visualization (streaks, levels, completion bars with motion)

### Three Strategic Principles (from Spotify's playbook)

**1. The Trojan Horse — Hide complex tech in familiar interfaces**
- Wrap sophisticated features in UI patterns users already know
- Users don't want to interact with algorithms — they want experiences that feel natural
- Ask: "What's the simplest, most familiar way users can interact with this feature?"

**2. The Vanity Mirror — Make sharing about identity, not the app**
- Create personal insights so meaningful that sharing feels like self-expression
- Don't celebrate what users did in your app — celebrate who they are
- "You're a night owl who does their best work after 9 PM" > "You completed 25 tasks"

**3. The Comfort Trap — Consistency as a competitive moat**
- Every interaction should follow the same logic and feel like it belongs to the same family
- Predictable patterns become second nature → switching costs increase
- Design consistency isn't about aesthetics — it's about creating habits that competitors can't replicate

---

## Design Process for Client/Product Work

### Phase 1: Discovery & Inspiration
1. Understand the product fundamentally: what problem, who's it for, what's different
2. Gather UI inspiration (Mobbin, Dribbble, Behance, Twitter, real apps)
3. Organize into mood boards by "vibe" — separate categories for different directions
4. Present 3-5 distinct directions to stakeholders

### Phase 2: UI Direction (Visual Only)
1. Create 3-5 mockup screens exploring different visual executions
2. Mix and match: client picks button style from A, typography from B, cards from C
3. Finalize one unified visual direction before touching UX

### Phase 3: UX Structure
1. Brain dump ALL features, then refine to MVP (3-5 core screens)
2. Map screen flows as labeled boxes with arrows
3. Create wireframes (grayscale, structural, no visual design)
4. Iterate with stakeholder feedback

### Phase 4: Combine UI + UX
1. Apply the finalized visual direction to approved wireframes
2. Check in early — there should be no major surprises
3. Polish: pixel-perfect alignment, all states designed (error, empty, loading, success)

### Key Separation
- **UI lens**: How do colors work together? What emotions do they evoke? What's the spacing, typography, visual hierarchy?
- **UX lens**: Where's the search bar? Are tap targets big enough? How many steps to complete a core task? Can anything be eliminated?

Never mix these lenses during research — gather UI and UX inspiration separately.
