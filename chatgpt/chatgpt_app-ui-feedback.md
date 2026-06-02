---
title: "App UI Feedback"
type: essay
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00f079-30b0-83e8-9253-4d242d20fedd
message_count: 3
tags: [chatgpt, import, long-form]
---
# App UI Feedback

> Conversation ID: 6a00f079-30b0-83e8-9253-4d242d20fedd
> Created: 2026-05-10T20:54:17Z
> Updated: 2026-05-10T20:55:53Z
> Messages: 3

---

## User

Okay, I'm gonna do another round of looking at the app and finding issues. So, continue with Google last used the method for the login on the alt screen. It says last used. The continue with Google button overlaps the word last used for some reason that doesn't have proper spacing. That needs to be fixed, but also we need to protect against layout shifts. So when last used appears or disappears, it can't change the placement of the buttons. I will go ahead and sign in with Google right now. Okay, signing in with Google, couldn't confirm your plan. Billing actions may be unavailable. Appears immediately in the bottom right corner. So I'm not sure what that's about. On the tasks page, I'm still seeing what looks like not a totally up-to-date tasks design. The overdue badges get clipped. It doesn't look like this has imported the cleaned up tasks design from the V1 shell. Upload Spotify canvases a task here. When I click in to the, to start typing, the text area has a focus ring. It does not have rounded corners, so that's one. All the focus rings should have rounded corners if they show up. And then two is that it, I don't wanna see a focus ring here. I want this to feel like Notion or something, you know what I mean? So there shouldn't be focus rings over the text areas. Focus rings generally break... the feel of the app. So there should not be focus rings on everything and there seems to be focus rings on every single input. On the ops screen, deploy success appears on the MRR card. It has nothing to do with the MRR. So that just generally needs to be cleaned up. I feel like this entire screen is very inefficiently using space. All these cards and stuff just out all over the place. Shipping velocity is all the way down the bottom, which like, sure, but it seems like you could probably organize all of this better. The Kanban doesn't really feel like they're cards. That's the one place where carding does make sense. So I'd have all of those be cards. I'd try and use wider rectangular cards that are less tall, and I would mash up the design of it a little bit so that it all fits better. Like, it seems like each card, like the titles are, the top of the card is two column, so the titles are all on two lines of text, even if they're four words. You know, you should be able to fit at least five or six words. Most of the titles should fit on one line and then spread the data out below it. There are view tags and the info buttons and stuff. I feel like they could be down on the bottom of the cards and you could split that up better. Just generally, like, think about... And this should be a principle that's extracted, right? So when you're designing a card, think about the information. The most important information is probably going to be the title. So you need to be able to read the title easily. That means that there should be nothing that gets in the way of the title. The title has the biggest piece of real estate. The title doesn't get truncated or word wrapped unless it's a very, very long title. Like the native design of that should be that you can, you know, an issue title that's five or six words should fit fine on one line. You know, then you've got these statuses here, queued, blocked, done. I don't know that I necessarily need to know the status if it's on a fucking Kanban board. If it's on a Kanban board, that means that everything in that column is queued or blocked or done. Do you know what I'm saying? Also, why is the Kanban board a column next to a column and a column? If you have a Kanban board, that should be full width. So the Kanban board should be full width, and then you should reorganize everything else. Now, the Kanban board doesn't necessarily have to be on the ops screen. It could be. I feel like the ops screen probably is where the Kanban board lives and a lot of this other stuff, but I feel like the shipping velocity maybe, or I don't know about that, but like runway and operator, a lot of this data feels like, like, okay, it's just the overview page has useful information, right? Then the works, then there's scoreboard and workspace on the overview page. Those both kind of, like, cross each other's lines, right? Like, that should all be one page. Then a lot of that data repeats on the ops screen. So the ops screen should just be one full-width thing that looks good on an LG screen, but looks even better on an ultra-wide monitor. I should have a full-width Kanban. Up top, I should have full-width cards for metrics that I care about. Uh, I should be able to see kind of growth here. Give me one little control panel card where I can flip on and off the waitlist. Um, I can flip on and off, um, yeah, I should be able to flip on and off the waitlist, and I should see just, like, the YC metrics and everything. Like, ground-up redesign this dashboard to be a world-class interface that makes sense and is actionable. Um, and like the deployment center and everything, just everything about this needs to be rethought. The default alive status is a massive card. Um, I don't know, the whole thing is just a mess. Um, the people screen, you've got waitlists, creators, users, releases. I mean, I guess it's okay, but generally, I think all of that needs to be refactored to be more performant and share the components from the newer, um, tables that we've been building. Um, it just feels like a mess. Um, the growth screen feels redundant. Like, growth... People and overview all kind of share similar things that don't need to exist in all these places. And I'd even say that, like, yeah, we need to get more organized here. The investors page is kind of a mess. Like, it has multiple filtering happening and stuff. It just seems crazy. I don't even know what ShareStudio is. Yeah, it just seems like all the admin pages have gotten out of control. On the settings pages, for some reason, all the section headings are, like, really big. I don't know what that's about. That should generally be cleaned up. And I would do a general pass of this just to make sure that everything is, like, properly refactored. You know, the bands in town button seems much bigger than the other buttons on the touring page. The copy link button is not filled-shaped. It's square with rounded corners. So it just seems like the traffic quality filtering thing has a disclosure that just has, like, repeated text on it and stuff. Like, it's not needed. That should just be a toggle. It just seems like all of these pages kind of need to be, like, rethought and conformed because there are stylings all over the place. People intake defaults on the admin settings, like, auto-accepting all these settings. First of all, that whole people intake defaults should just probably be a little control card. The growth defaults could probably be merged into it. All of that growth shit could just be a little control card that lives on the ops screen, probably. I don't think it needs to live here. The dev toolbar toggle, honestly, should probably even live in that card too. It probably doesn't even need to be on the settings screen. The search button in the top right does not need to exist because you have a search.
Button in the side bar that does exactly the same thing

---

## Assistant

I’ll consolidate this into an implementation-ready pass, separating immediate bugs from the broader admin IA/design refactor so the work can be executed cleanly.

---

## Assistant

Mr. White, captured as an implementation-ready QA/design brief.

# Admin app QA/design pass

## Primary objective

Clean up the admin app so it feels like one coherent, high-density, production-grade interface rather than a collection of individually styled pages. This should include fixing immediate visual bugs, removing duplicated admin surfaces, and extracting reusable layout/component principles.

---

# P0 / P1 issues

## 1. Login / auth screen

### Issue: “Last used” label overlaps Continue with Google

On the alt login screen, the **Continue with Google** button overlaps the **“Last used”** label.

### Required fix

The login method row should reserve layout space for optional metadata like **Last used** so the button placement never changes when that label appears or disappears.

### Acceptance criteria

- “Last used” never overlaps the Google button.
- Showing or hiding “Last used” does not shift the placement of any auth buttons.
- Auth buttons remain vertically aligned across all login methods.
- Optional labels use a reserved slot or absolute positioning within a stable container.

---

## 2. Post-Google-login billing toast

### Issue: Incorrect billing warning appears immediately

After signing in with Google, this toast appears immediately in the bottom-right:

> “Couldn’t confirm your plan. Billing actions may be unavailable.”

This appears unrelated to the user’s immediate action and creates confusion.

### Required fix

Audit the billing-plan confirmation flow after login.

### Acceptance criteria

- Billing warning only appears when the user enters a billing-relevant surface or attempts a billing action.
- Login success should not trigger billing-related warnings by default.
- If plan status truly cannot be confirmed, surface it in a quieter, contextual place instead of an immediate toast.
- Toast copy should explain the consequence only when the user is trying to do something billing-related.

---

# Tasks page

## 3. Tasks page appears stale

### Issue

The current tasks page does not appear to have imported the cleaned-up task design from the V1 shell.

Specific problems:

- Overdue badges are clipped.
- Task layout feels outdated.
- Task details/editing UI does not match the newer design language.

### Required fix

Bring the tasks page into alignment with the cleaned-up V1 shell task design.

### Acceptance criteria

- Overdue badges are fully visible.
- Task cards/rows use the current task styling system.
- Spacing, typography, badges, and interaction states match the newer shell.
- No clipping on common viewport sizes.

---

## 4. Textarea focus ring styling

### Issue

When clicking into a task textarea, the focus ring appears with sharp/square corners and feels visually heavy.

### Required fix

Remove visible focus rings from content-style textareas during normal mouse interaction. The editing experience should feel closer to Notion: quiet, inline, and low-friction.

### Accessibility note

Keyboard focus can still have a subtle `:focus-visible` treatment, but it should match the element’s border radius.

### Acceptance criteria

- Textareas do not show loud default focus rings on click.
- Any visible focus state uses rounded corners matching the textarea.
- Use `:focus-visible`, not broad `:focus`, for keyboard accessibility.
- Inputs throughout the app should avoid heavy focus rings unless the interaction truly needs them.

---

# Global interaction principle

## 5. Focus rings are currently overused

### Issue

Focus rings appear on nearly every input and break the feel of the app.

### Required principle

Focus states should be intentional, subtle, and shape-aware.

### Implementation rule

- Use `:focus-visible` for keyboard navigation.
- Avoid visible focus rings on mouse-clicked text fields, textareas, and inline editors.
- Any focus ring must respect border radius.
- Do not use browser-default sharp focus outlines in polished product surfaces.

---

# Ops screen redesign

## 6. Ops screen needs a ground-up layout rethink

### Issue

The ops screen is inefficient, visually scattered, and redundant with other admin pages.

Current problems:

- “Deploy success” appears on the MRR card, which is contextually wrong.
- Cards are large and inefficient.
- Shipping velocity is buried low on the page.
- Default alive status is a massive card.
- Deployment center feels disconnected.
- Kanban does not feel like a true card-based Kanban.
- The page does not take advantage of large or ultra-wide screens.
- Overview, growth, people, and ops appear to repeat similar data.

### Required direction

Redesign the ops screen as the main full-width operational dashboard.

It should be optimized for:

- LG/wide desktop displays.
- Ultra-wide monitors.
- Fast scanning.
- Actionability.
- Dense but readable information.

---

## 7. Ops dashboard proposed structure

### Top section: full-width metrics row

Include high-signal metrics only.

Likely candidates:

- MRR
- Growth
- Waitlist volume
- Active users / creators
- Runway
- Shipping velocity
- YC-style core metrics
- Deployment health / latest deploy status

Avoid giant cards for low-information states.

---

## 8. Control panel card

Create one compact **control panel** card for operational toggles.

Should likely include:

- Waitlist on/off
- People intake defaults
- Growth defaults
- Dev toolbar toggle
- Other small admin toggles currently scattered across settings/growth/admin screens

### Acceptance criteria

- Operational toggles live in one obvious place.
- Toggles are compact and scannable.
- Settings page no longer carries operational controls that belong on ops.

---

## 9. Kanban should be full-width

### Issue

The Kanban is currently constrained and arranged like just another grid section.

### Required fix

Make the Kanban board a full-width section.

### Acceptance criteria

- Kanban columns span the available width.
- Cards look like actual cards.
- Column layout works especially well on wide and ultra-wide screens.
- Queued / Blocked / Done status badges are removed from cards when the card is already inside the corresponding column.

---

## 10. Kanban card design principle

### Issue

Current cards waste title space. Titles wrap onto two lines even when they are only four or five words.

### Required principle

The title is usually the most important piece of information on a card. It should get the most protected real estate.

### Card design rules

- A five- or six-word issue title should usually fit on one line.
- Do not place badges, icons, buttons, or status indicators in a way that competes with the title.
- Metadata should move below the title.
- Tags, info buttons, view buttons, and secondary controls should live near the bottom of the card.
- Cards should be wider, less tall, and more rectangular.
- Title wrapping should only happen for genuinely long titles.

---

## 11. Remove redundant status labels in Kanban cards

### Issue

Cards inside a Kanban column still show statuses like:

- Queued
- Blocked
- Done

This repeats the information already provided by the column.

### Required fix

Remove status badges from cards when the card is inside a status-specific Kanban column.

### Acceptance criteria

- Column communicates the status.
- Card focuses on title, owner, metadata, priority, dates, and actions.
- No redundant status labels inside Kanban columns.

---

# Admin information architecture

## 12. Overview, ops, growth, and people overlap too much

### Issue

The following pages share overlapping data and concepts:

- Overview
- Ops
- Growth
- People
- Scoreboard
- Workspace

This creates redundancy and makes the app feel disorganized.

### Required fix

Rationalize the admin IA.

### Suggested direction

- **Ops** becomes the primary operational command center.
- **People** focuses on people records, waitlist, creators, users, and releases.
- **Growth** should only exist if it has a distinct workflow. Otherwise, merge its controls and metrics into Ops or People.
- **Overview / Scoreboard / Workspace** should be consolidated so they do not cross each other’s purpose.

---

# People screen

## 13. People tables need refactor

### Issue

The People screen has useful sections:

- Waitlists
- Creators
- Users
- Releases

But the page feels messy and likely does not share the newer table components.

### Required fix

Refactor People to use the newer shared table system.

### Acceptance criteria

- Tables share the same component primitives as newer admin tables.
- Filtering, search, pagination, empty states, loading states, and row actions are consistent.
- Page is more performant.
- Waitlists, creators, users, and releases feel like one designed system.

---

# Growth screen

## 14. Growth screen feels redundant

### Issue

Growth overlaps with People and Overview.

### Required fix

Audit whether Growth deserves its own page.

### Acceptance criteria

- Growth-specific data appears only where it is actionable.
- Duplicated metrics are removed.
- Growth defaults and related toggles are likely moved into the Ops control panel.
- Growth page is either given a clear unique purpose or consolidated.

---

# Investors page

## 15. Investors page is messy

### Issue

The Investors page has multiple filtering systems and feels overly complicated.

### Required fix

Simplify the page around one clear table/filtering model.

### Acceptance criteria

- One primary filtering pattern.
- No duplicate or competing filters.
- Clear table layout.
- Consistent actions.
- Remove or clarify unclear concepts like “ShareStudio” if they are not necessary.

---

# Settings pages

## 16. Settings headings are too large

### Issue

Section headings on settings pages are oversized and visually heavy.

### Required fix

Normalize settings typography.

### Acceptance criteria

- Section headings use the shared admin heading scale.
- Settings pages feel lighter and more compact.
- Headings do not dominate the page.

---

## 17. Settings contains operational controls that should move

### Issue

Settings includes controls that feel operational rather than configurational, including:

- People intake defaults
- Growth defaults
- Dev toolbar toggle

### Required fix

Move operational controls into a compact control card, likely on the Ops screen.

### Acceptance criteria

- Settings is reserved for persistent configuration.
- Ops contains day-to-day operational controls.
- People intake defaults and growth defaults are merged if they are conceptually related.
- Dev toolbar toggle lives with other operational/admin controls.

---

# Touring page

## 18. Bandsintown button sizing inconsistency

### Issue

The Bandsintown button appears much larger than other buttons on the Touring page.

### Required fix

Normalize button sizing.

### Acceptance criteria

- Bandsintown button uses the same button sizing scale as neighboring actions.
- No one-off button dimensions unless intentionally justified.

---

## 19. Copy link button shape inconsistency

### Issue

The Copy Link button is square with rounded corners instead of pill-shaped / filled-shaped like related buttons.

### Required fix

Use the shared button component and shape rules.

### Acceptance criteria

- Copy Link button matches the appropriate shared button variant.
- Shape, padding, height, radius, and typography match adjacent actions.

---

## 20. Traffic quality filtering disclosure is overbuilt

### Issue

The traffic quality filtering control uses a disclosure with repeated text. It feels unnecessary.

### Required fix

Replace this with a simple toggle.

### Acceptance criteria

- No repeated explanatory text.
- Control is compact.
- Toggle clearly communicates on/off state.
- Supporting explanation appears only if genuinely needed.

---

# Header / navigation

## 21. Duplicate search button

### Issue

The top-right search button is redundant because the sidebar already has a search button that does the same thing.

### Required fix

Remove the duplicate top-right search button or give it a distinct purpose.

### Acceptance criteria

- Only one primary search entry point exists unless the two are meaningfully different.
- Header actions are reduced to necessary controls.

---

# Design system cleanup

## 22. Admin pages have inconsistent styling

### Issue

Across admin pages, buttons, cards, filters, headings, toggles, tables, focus states, and disclosures appear to use inconsistent styling.

### Required fix

Run a general design-system conformity pass.

### Components to standardize

- Buttons
- Cards
- Tables
- Badges
- Filters
- Toggles
- Disclosures
- Textareas
- Inputs
- Focus states
- Section headings
- Admin metric cards
- Kanban cards

---

# Extracted principles

## Layout stability

Optional metadata should never cause core controls to move.

Examples:

- “Last used” on login methods
- Badges on task cards
- Status indicators on dashboard cards

Reserve space or position metadata within a stable layout.

---

## Card hierarchy

Card design should protect the most important information.

For task/issue cards:

1. Title gets the clearest, widest real estate.
2. Metadata appears below the title.
3. Tags and secondary actions live lower in the card.
4. Status is omitted when context already communicates it.
5. Cards should be compact, wide, and scannable.

---

## Density with clarity

Admin pages should use space efficiently, especially on large screens.

Rules:

- Avoid huge cards for low-information content.
- Prefer compact metric rows.
- Use full-width sections where horizontal space adds value.
- Design for widescreen and ultra-wide screens.
- Keep action controls close to the data they affect.

---

## Reduce duplicated surfaces

The admin app should avoid multiple pages showing the same data with slightly different styling.

Pages should have distinct jobs:

- Ops: operational command center.
- People: people/user/waitlist records.
- Settings: persistent configuration.
- Growth: only if it has a unique workflow.
- Overview: only if it provides a distinct executive summary.

---

## Focus states

Focus states should support usability without making the app feel like a form builder.

Rules:

- Use `:focus-visible`.
- Avoid loud focus rings on mouse-clicked text inputs.
- Match border radius.
- Keep inline editing quiet.
- Prioritize Notion-like interaction for text-heavy admin areas.

---

# Suggested ticket title

**Admin app QA/design refactor: login layout stability, task polish, ops dashboard redesign, and admin surface consolidation**

# Suggested priority

**High**

The login overlap and billing toast are direct bugs. The ops/admin redesign is larger, but the current inconsistency affects product quality across the whole internal app.


## See Also
- [[chatgpt/chatgpt_ai-feedback-prompt]]
- [[chatgpt/chatgpt_application-revision-feedback]]
- [[chatgpt/chatgpt_buyer-feedback-visibility]]
- [[chatgpt/chatgpt_design-feedback-improvement]]
- [[chatgpt/chatgpt_feedback-message-integration]]
