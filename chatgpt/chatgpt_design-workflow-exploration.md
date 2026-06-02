---
conversation_id: 69eba59c-22b4-83e8-9521-ee6afce686f9
created: 2026-04-24
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Design Workflow Exploration
type: guide
updated: 2026-04-24
---

# Design Workflow Exploration

> Conversation ID: 69eba59c-22b4-83e8-9521-ee6afce686f9
> Created: 2026-04-24T17:17:17Z
> Updated: 2026-04-24T18:42:08Z
> Messages: 6

---

## User

the image capability is in chat gpt 5.5 and image 2 are so freaking good that it make me want to polish our UI with them.

but its a lot to wrap my head around.
what i want is a worflow i can paste into claude code and have it run each component of ours throgh claude code and geenrate liek 4 or 5 options with image 2 from open ai or gpt 5.5 and then i pick what i like and we iterate from there but i need to also see them in scren context. and i got hot realor whatever. but whats the ebst way to do this maye claude code should inspect and spit out a spec of what the screen needs and then i copy and paste into chat gpt iterate there til i like teh screenshot then go back? or design shotgun in gstack? or send it to figma? idk. but i want the data to mostly stay the same but see wildly different layotus in case inthing inspires me or a non obvious layout pops better. and i want to explore evovling the design system not jsut variants of what we have.

also wanna keep cost down and we have chat gpt max plan and claude code max plan plus apis.

---

## Assistant

I’ll treat this as a product/design workflow problem: get divergent visual ideas cheaply, preserve real data/context, then hand off only the winning direction to code.

---

## Assistant

Mr. White, the best path is **code-native design exploration**, with Claude Code orchestrating and OpenAI generating visual directions.

Use this loop:

**Claude Code → screenshot/spec → GPT Image variants → local comparison board → pick winner → Claude Code implements → screenshot QA → update design system.**

Start at the **screen level**, then derive component changes. Component-by-component redesign loses screen context, and the thing you care about is whether the whole screen feels better with the same real data.

OpenAI’s current image docs support exactly this split: use the **Image API** for one-shot generation/edit batches, and use the **Responses API** when you want multi-turn image iteration with images kept in context. `gpt-image-2` is listed as the latest GPT Image model, and the docs specifically call out multi-turn image generation/editing through Responses. citeturn139994view2turn139994view0

## Recommended workflow

### 1. Claude Code inspects the app and writes a design brief

For each important screen, have Claude Code extract:

- Current screenshot
- Route/component tree
- Data shown on screen
- Required actions
- Empty/loading/error states
- Current design tokens
- What must stay invariant
- What can change aggressively

The OpenAI prompting guide says UI mockups work best when described like real shipped products, focusing on layout, hierarchy, spacing, and real interface elements. Use that pattern. citeturn789211view1

### 2. Generate 4–6 radically different image directions

Use `gpt-image-2` through the API for batches. Do **one “safe polish” option** and **4 genuinely different layouts**.

Example lanes:

1. **Premium dense dashboard** — compact, founder/operator command center.
2. **Consumer-clean** — more whitespace, friendlier, simpler hierarchy.
3. **Editorial/product-led** — stronger visual storytelling and sections.
4. **Command palette / OS-like** — navigation and actions feel like a tool.
5. **Wildcard** — unusual layout, asymmetric, something that might reveal a better idea.

For divergent exploration, generate from the **brief + data contract**, rather than editing the current screenshot too literally. For convergence, use the selected image and current screenshot as references and iterate with smaller changes.

### 3. Show everything in screen context

Generate a local gallery:

```
current screen | option A | option B | option C | option D | option E
```

Then after you pick one:

```
current screen | chosen image | coded prototype screenshot | diff notes
```

Use Playwright for screenshots. Playwright supports page, full-page, buffer, and element screenshots, which is enough to capture current screens and coded variants automatically. citeturn426392search0

### 4. Claude Code builds only the selected direction

Claude Code should first create a **prototype route**, not edit production directly:

```
/_design-lab/account/variant-a
/_design-lab/dashboard/variant-c
/_design-lab/onboarding/variant-b
```

Then screenshot the prototype beside the image. Once it is close, promote the changes into the real route/component.

### 5. Update the design system after several wins

After 3–5 selected designs, extract the recurring decisions into:

- `DESIGN.md`
- token changes
- component variants
- spacing rules
- typography hierarchy
- surface/card/list/table patterns

This avoids creating one-off pretty screens that do not cohere.

## Where each tool fits

**Claude Code:** Repo inspection, screen brief generation, Playwright screenshots, local gallery, implementation, tests. Claude Code supports skills/custom workflows, MCP integrations, hooks, and codebase-aware automation, so it is the right control plane. citeturn161023view1turn161023view0turn161023view4

**ChatGPT / GPT-5.5:** Taste loop. Use it manually when you want to upload screenshots and say, “Make this feel 10x more premium, preserve the data, give me visual directions.” This is best for judgment and creative narrowing.

**OpenAI API / `gpt-image-2`:** Batch generation. Use it when you want 5 variants per screen with consistent prompts and low friction.

**gstack:** Fastest way to try the concept. Its `/design-shotgun` flow already describes generating 4–6 GPT Image mockup variants, opening a browser comparison board, collecting feedback, and iterating; `/design-html` then turns the approved mockup into production-style HTML/CSS. Use it as a starting point, then customize the prompts and invariants for your app. citeturn884558view0

**Figma:** Bring it in after you pick a direction or when the team needs design-system review. Figma’s MCP server can expose variables, components, layout data, screenshots, and Code Connect mappings to AI agents, and it can write structured Figma-native frames/components/auto-layout back to the canvas. Figma’s own docs also state MCP is a bridge, not a one-click perfect-code tool. citeturn599017view0turn599017view1turn599017view2turn599017view3

## Cost control

Use this budget ladder:

- **Round 1:** `gpt-image-2`, `quality: low`, 4–6 options per screen.
- **Round 2:** `quality: medium`, 2–3 shortlisted options.
- **Final:** `quality: high`, only for the one you love.
- **Implementation:** no image calls; Claude Code codes from the chosen image + brief.

OpenAI’s guide lists example `gpt-image-2` output costs for common 1024/1536 sizes at about **$0.005–$0.006 low**, **$0.041–$0.053 medium**, and **$0.165–$0.211 high**, before input-token costs. It also says final cost includes text input, image input for edits, and image output. citeturn139994view1

Rough output-only cost:

- 5 low variants ≈ **$0.03 / screen**
- 5 medium variants ≈ **$0.20–$0.27 / screen**
- 1 high finalist ≈ **$0.17–$0.21**

Your ChatGPT subscription and API usage are billed separately, so use ChatGPT Max for manual creative iteration and use API calls only for repeatable batch runs. OpenAI’s help docs state API usage is separate from ChatGPT subscriptions and billed independently. citeturn988796search4turn988796search1

## Paste this into Claude Code

```md
Build a code-native AI design exploration workflow for this repo.

Goal:
Create a repeatable design lab that captures current screens, writes screen-level design briefs, generates 4–6 radically different visual directions using OpenAI gpt-image-2, displays them beside the current screenshot, lets me pick a direction, and then prototypes the selected direction in code before touching production.

Important:
- Do not modify production UI until I approve a variant.
- Preserve actual app data semantics, copy meaning, core actions, and business logic.
- Explore layout, hierarchy, density, navigation, visual system, typography, surfaces, cards, tables, lists, empty states, and interaction affordances.
- The goal is not tiny variants of the current UI. Generate genuinely different layout/system directions.
- Keep cost down: default image quality to low for broad exploration, medium for shortlist, high only for final.
- If OPENAI_API_KEY is missing, create briefs/prompts/gallery scaffolding and stop before generation.

Step 1 — Inspect:
Identify the framework, routing, component library, styling system, design tokens, Storybook setup if any, local dev command, and test/screenshot tooling. Summarize findings before writing files.

Step 2 — Create design-lab structure:
Create:
- .design-lab/screens.json
- .design-lab/briefs/
- .design-lab/prompts/
- .design-lab/variants/
- .design-lab/gallery/
- scripts/design-lab/

Step 3 — Screen inventory:
Find the top user-facing screens/routes/components worth exploring. For each, record:
- screen id
- route or Storybook story
- key components
- real data displayed
- required user actions
- empty/loading/error states
- current design-system dependencies
- screenshot command

Step 4 — Screenshot capture:
Add a Playwright-based script that captures:
- current screen screenshot
- full-page screenshot when useful
- mobile/tablet/desktop when applicable
Save to:
.design-lab/screenshots/{screenId}/current.png

Step 5 — Brief generation:
For each screen, write:
.design-lab/briefs/{screenId}.md

Each brief must include:
- product job of the screen
- user intent
- data invariants
- action invariants
- copy/text invariants
- what may change
- what should be explored aggressively
- current UI critique
- design-system opportunities
- five visual direction lanes:
  1. premium dense command center
  2. clean consumer app
  3. editorial/product-led
  4. OS-like tool interface
  5. wildcard non-obvious layout

Step 6 — Prompt generation:
For each screen, create:
.design-lab/prompts/{screenId}.json

Each prompt should request a realistic shipped product UI mockup, not concept art.
Each prompt must preserve the same data/action contract.
Each prompt must ask for one complete screen in context.
Each prompt must avoid generic SaaS slop, random gradients, fake stock imagery, unreadable text, and decorative clutter.

Step 7 — OpenAI generation:
Create a script:
npm run design:generate -- --screen {screenId} --count 5 --quality low

Use OpenAI gpt-image-2.
Save images to:
.design-lab/variants/{screenId}/{variantId}.png

Also save metadata:
.design-lab/variants/{screenId}/{variantId}.json
with prompt, quality, model, timestamp, and cost estimate when available.

Step 8 — Gallery:
Create a local HTML gallery at:
.design-lab/gallery/index.html

It should show:
- current screenshot
- all generated image options
- labels and direction names
- prompt summaries
- a feedback box area per variant
- instructions for me to say which one I pick

Step 9 — Prototype selected direction:
Add a command:
npm run design:prototype -- --screen {screenId} --variant {variantId}

This should create a prototype route or Storybook story, depending on the project structure.
The prototype must use existing real components where possible.
Do not invent backend data.
Do not add new dependencies unless justified.
Keep the variant isolated from production routes.

Step 10 — QA comparison:
After prototyping, capture:
- current screenshot
- chosen AI image
- coded prototype screenshot

Show them side by side in the gallery and write:
.design-lab/reports/{screenId}-{variantId}.md

Report:
- what matches
- what diverges
- what needs manual taste judgment
- what design tokens/components should change if this direction wins

Step 11 — Design system extraction:
After approved variants, update or create DESIGN.md with:
- chosen visual principles
- spacing scale
- type hierarchy
- surface/card/list/table rules
- icon/image rules
- interaction states
- anti-patterns to avoid
- examples from selected variants

Begin by inspecting the repo and proposing the first 5 screens to explore. Then ask me to approve the screen list before generating images.
```

## Practical default

Use **gstack `/design-shotgun` first on one high-value screen** to see how close it gets. Then build the repo-specific design lab above if you like the workflow and want tighter control over data invariants, component mapping, cost, and design-system evolution.

---

## User

ok give me a prompt for it to start with me manually pasting the prompts into chatgpt for cheaper generation to start. and start on the releases page only

---

## Assistant

Mr. White, use this as a Claude Code starter prompt: it prepares the releases-page brief, screenshots, and paste-ready ChatGPT image prompts, then stops.

---

## Assistant

Mr. White, paste this into **Claude Code**:

```md
Create a manual AI design exploration workflow for the Releases page only.

Important constraints:
- Do not call OpenAI APIs.
- Do not generate images from code.
- Do not modify production UI yet.
- The workflow should help me manually paste prompts into ChatGPT, generate images there, save them back into the repo, compare them against the current Releases page, and later implement only the variant I approve.
- Start with the Releases page only.
- Preserve the same data, product meaning, release statuses, labels, actions, and business logic.
- Explore wildly different layouts and visual systems, not minor restyles.
- Keep everything isolated in `.design-lab/`.

Goal:
Inspect the Releases page, capture its current screen context, produce a strong design brief, and generate 5 copy-paste-ready ChatGPT image prompts for radically different UI directions.

Step 1 — Find the Releases page:
Locate the route, page component, relevant child components, data source/mock data, styling files, design tokens, and any Storybook stories related to the Releases page.

Look for likely names such as:
- releases
- release
- launches
- changelog
- deploys
- versions
- announcements

Summarize what you find before writing files.

Step 2 — Capture current screen:
Set up or use existing local dev tooling to capture the Releases page screenshot.

Prefer Playwright if available. If not available, add the lightest reasonable screenshot script.

Save:
`.design-lab/releases/current.png`

Also create:
`.design-lab/releases/current-notes.md`

Include:
- route URL
- viewport used
- component tree
- visible data
- primary actions
- secondary actions
- empty/loading/error states if discoverable
- current layout summary
- current visual design summary
- obvious UX/design weaknesses
- design-system dependencies

Step 3 — Create a screen contract:
Create:
`.design-lab/releases/screen-contract.md`

This should define what must stay the same across all generated designs:

- Actual page purpose
- Required data fields
- Release names/titles
- Dates/timestamps
- Statuses
- Actions/buttons
- Navigation items
- Filters/search/sorting if present
- Any copy that should remain recognizable
- Business logic that must not change

Also define what may change aggressively:

- Layout
- Density
- Navigation treatment
- Card/table/list structure
- Typography
- Visual hierarchy
- Spacing
- Color usage
- Surfaces
- Empty state presentation
- Interaction affordances
- Design system direction

Step 4 — Create 5 manual ChatGPT image prompts:
Create these files:

`.design-lab/releases/prompts/01-premium-command-center.md`
`.design-lab/releases/prompts/02-clean-consumer-app.md`
`.design-lab/releases/prompts/03-editorial-product-led.md`
`.design-lab/releases/prompts/04-os-like-tool-interface.md`
`.design-lab/releases/prompts/05-wildcard-non-obvious.md`

Each prompt should be ready for me to paste into ChatGPT with the screenshot attached.

Each prompt must:
- Tell ChatGPT to use the uploaded screenshot as current screen context.
- Preserve the same data model and page purpose.
- Ask for one complete redesigned Releases page screen.
- Request a realistic shipped product UI, not concept art.
- Ask for clear readable interface text.
- Ask for a meaningfully different layout.
- Avoid random decorative gradients, generic SaaS templates, fake stock imagery, illegible text, and purely cosmetic restyling.
- Mention that the output should be a single high-fidelity UI mockup screenshot.
- Include specific guidance for that visual direction.
- Include an explicit “do not change the underlying product semantics” instruction.

Step 5 — Create one master prompt:
Create:
`.design-lab/releases/prompts/00-master-chatgpt-prompt.md`

This should be a reusable prompt I can paste into ChatGPT first, along with the current screenshot, to explain the overall task. It should ask ChatGPT to generate one design direction at a time when I paste a specific direction prompt.

Step 6 — Create gallery scaffold:
Create:
`.design-lab/releases/gallery/index.html`

The gallery should show:
- Current screenshot
- Placeholder slots for 5 generated images
- Direction names
- Prompt file names
- Notes area for feedback
- Instructions telling me to save generated images as:

`.design-lab/releases/variants/01-premium-command-center.png`
`.design-lab/releases/variants/02-clean-consumer-app.png`
`.design-lab/releases/variants/03-editorial-product-led.png`
`.design-lab/releases/variants/04-os-like-tool-interface.png`
`.design-lab/releases/variants/05-wildcard-non-obvious.png`

Step 7 — Add comparison helper:
Create a script or simple local page command that refreshes the gallery after I manually save generated images.

If package scripts are appropriate, add:

`npm run design:releases`

This should open or serve the Releases design gallery locally.

Step 8 — Prepare implementation handoff:
Create:
`.design-lab/releases/implementation-handoff-template.md`

This should be a prompt I can give you later after I pick a variant.

It should say:
- which variant I picked
- where the image file lives
- what I liked
- what I disliked
- what to preserve
- what to implement first
- that production UI should still not be changed until a prototype route/story is created

Step 9 — Do not implement any redesign yet:
Stop after creating the design-lab materials, screenshots, prompts, gallery, and handoff template.

At the end, tell me:
1. The Releases page route you found.
2. The files you created.
3. The exact order I should paste prompts into ChatGPT.
4. Where I should save the generated images.
5. How to open the local comparison gallery.
```

Then use the prompts Claude Code creates in this order:

1. Upload `.design-lab/releases/current.png` to ChatGPT.
2. Paste `.design-lab/releases/prompts/00-master-chatgpt-prompt.md`.
3. Paste one direction prompt at a time.
4. Save each generated image into `.design-lab/releases/variants/`.
5. Open the gallery and compare them against the current screen.

For the first ChatGPT run, use the **wildcard** prompt earlier than usual if you want non-obvious ideas fast:

```text
Use the uploaded Releases page screenshot as context.

Redesign this screen as a high-fidelity shipped product UI mockup. Preserve the same product purpose, data semantics, release information, statuses, actions, and page meaning. Do not invent a different product. Do not remove important functionality.

I want a wildly different layout direction that could evolve the design system, not a cosmetic restyle. Explore a non-obvious structure for a Releases page while keeping the same underlying data and user jobs.

Prioritize:
- Stronger visual hierarchy
- Better release scanning
- Clearer status/action affordances
- A more distinctive product feel
- A layout that could inspire a broader design-system evolution
- Realistic interface details
- Readable UI text
- Screen-level composition, not isolated components

Avoid:
- Generic SaaS dashboard clichés
- Random gradients
- Decorative clutter
- Fake stock imagery
- Illegible text
- Changing the actual product semantics
- Merely polishing the current layout

Output one complete redesigned Releases page screen in context.


**Topic:** [[chatgpt-clusters/design_ux]]
