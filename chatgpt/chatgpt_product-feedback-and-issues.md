---
title: "Product Feedback and Issues"
type: essay
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00d97c-ebe0-83e8-8f5c-64564c6033a7
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# Product Feedback and Issues

> Conversation ID: 6a00d97c-ebe0-83e8-8f5c-64564c6033a7
> Created: 2026-05-10T19:16:14Z
> Updated: 2026-05-10T19:58:15Z
> Messages: 7

---

## User

{'asset_pointer': 'sediment://file_000000005c2c71f5b5f0088286cfc75a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 206, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 39966, 'width': 642}

I'm going to go through right now and give you everything that I see that is wrong with the products, okay? It's gonna be a giant mess. First up, I'm on the home page. Header's looking pretty slick. I know that we probably shipped- I don't know if the home page I'm looking at on production is up-to-date or not but the Blanco y Negro and RecPlay logos in the logo bar are not real logos, they're just text. Those should be cleaned up. If we can't find proper logos for them, they should be removed. If we can find proper logos, they should be formatted to match and all these logos should be optimized for the display and then just make sure that we're appropriately that the logo bar looks world-class at every breakpoint. Then we go down a new kind of operating system built for music artists. This feels a little disjointed, again don't know if there's a more updated version of this, but It then goes, you know, it's meet Jovi for short eyebrows like nowhere near the text. Um. Um. See, in dating, I never once have had that problem. Period. In fundraising, it felt like that was every investor Sorry, that was me talking to a text message. Okay, a new kind of operative system for artists is beautiful. Then we go into this section where it's like a release plan, Joby can run. I actually like that. But it doesn't feel, it feels a little disjointed. Like a new kind of operative system built for music artists so I wanna see the operating system, right? So I feel like this section would be more appropriate. I don't know, the section needs work and I probably need to be basically iterating on it. So that's something I should be involved with. One workspace for every release. Beautiful screenshot, looks good, looks clean. One problem with it: It has generic data. It's using real artists and real songs but it has generic data. It's actually using my songs but it has generic data. Don't Look Down is a fucking test song. It's not a real song or a release that made that up All of the other releases it looks like are real but we're using fake data so we should pull the actual album art for those especially the ones where it's collaboration with someone else like Gilken Miller and Tim White and Sober so first of all I think Tom Fall is also on that so you need to properly credit it that that's something that's gonna really piss people off if you don't properly credit stuff. Yeah so that seed data just needs to be aligned. And then I would say for the seed data thing like we're using me as the main artist for all of our seed data right now and we have my Spotify so there's no reason that this should happen we should have test coverage or something. All of this should just be pulled from Spotify which our system automatically does so we need to stop making up stuff for seed data. Yes it doesn't matter if it's like you can make up data like the status of it and things I don't really care I don't even care if release dates are right and sh\*t. You want to make things more useful in the screenshots to show off the interface like you need a future release okay pick one of our releases and pretend it's coming out in the future that's fine but they have to have the actual song name and the actual artists otherwise this becomes problematic. Another thing I would just say is it's not a problem here but if there's two screenshots do you make sure that we vary them as much as possible so like for example the audio player is currently playing at a minute and 18 seconds into a three minute and 25 second song if you show a screenshot later on this landing page where the audio player is visible just don't have it be at exactly one minute and 18 seconds because it's obvious it's the same screenshot you know what I mean things should feel real in that regard. Oh, okay, I see the go live in 60 seconds so actually if you move go live in 60 seconds up to below a new kind of operating system built for music artists it'll actually make that section, the release plan Joey can run section feel more intentional and it would probably solve my problem so I don't even need to be involved at that point. Artist profiles built to convert is f-cking great it looks amazing my only beef with it would just be readability at different breakpoints so the cards are very tall I love that on a ultra wide monitor they're probably a little bit too tall on a normal retina MacBook Pro. um and uh um and yeah so so yeah so that's basically fine um okay then i go to this spec wall answers for every launch objection like jesus fucking christ we we have that on our public fucking website right now like how in the hell did that get through our system like that's not customer facing copy that's like actual sociopathic fucking like we're trying to manipulate you copy and it's dangerous so one i need fucking guardrails to make sure that that never fucking happens and then two this should be like customer facing copy you know like Jesus I can't believe you used the word objection publicly that's insane then in the copy under it the release details that usually become another tool already built into the system okay none of this copy sucks it all has to be rewritten this whole spec wall needs work they're all using the same exact animation okay the whole thing needs work I would I would immediately flag it off in production until it's until it's been dealt with then there's a simple pricing thing and it doesn't even align with what the fucking real pricing is so pricing should be free is available right now pro is is pro they should be able to sign up for so I I'd remove the request access buttons and I had to let them sign up for it and then go through the waitlist chat onboarding flow and then just waitlist them. Put the intended plan and then just for now gate those plans. And then for now I would just waitlist everybody that we haven't manually signed on but I wouldn't publicly show them to get waitlisted. I would allow them to sign in. Sign up and then throw them through a waitlist flow. And I would not write the word waitlist on here that's fuckin dumb. If you're ever gonna write something coming soon would be what to write but no I would just argue that these plans exist today and they all need to be rewritten as well. And then the footer just generally needs more generous power. So I'm adding and the cookie banner is broken, I can't accept all. And if you do accept all that should toggle marketing and analytics on and also we should default marketing and analytics on. And I can't click save preferences so, that jank all needs to be resolved in the new one. High primary. All right let's go to the sign-in page
{"error":"Clerk proxy error"} 

Okay, on the sign-in page, generally looking pretty slick. One question I would have is: How does she look on an ultra-wide monitor? I'm already signed in on this one. Pink-dyed needle window. Jov@jov.ie. Go there, and I'll just do a quick scroll on ultra-wide. Mostly looking pretty good. Don't see any issues on the homepage on ultra-wide. Okay, so no additional issues on ultra-wide on the homepage. We actually did fix the ultra-wide sign-in page. Okay, great! So, boom! That's fine!

All right, now let's dive into the onboarding. When I sign in, actually I shouldn't dive into the app. I should dive into the onboarding. Okay, so one: sign up with Apple right now, invalid client is what I get. I would just turn off Apple in production via the Clark dashboard that takes two seconds to fix that problem, and then we should just disable Apple sign-in. I would also consider disabling email sign up and just making it Google or Apple only, but immediately turn off Apple. In fact, let me just do that as I'm talking to you. Turn off Apple in production until we get those credentials, and we should open up an issue to deal with those credentials. SSO, Apple, enable for sign up, sign in. Okay, done.

If I refresh, yep, okay, so that's done, and then configure email. One thing that seems broken is when you go to the sign-up page, it's saying "Welcome back, no account, sign up," like it's showing it if it's a sign-in page. If I go to the sign-in page, it says the same shit. The sign-up page has sign-in page copy as the problem, and the modal says "Create your account," which is fine. The modal also, the back button on the modal is jank, like when it is for the registration modal, and the "Create your account" text is way too big. There's a lot of jankiness on the modal, so this auth shit is really problematic. If you click the sign-in button, it doesn't take you to the sign-in page; it just sits there. That's broken entirely, so that all needs to be fixed. That's high priority.

If I try and see, I can't even sign up for this fucking product right now because of all this shit. Alright, so if I want to sign up, I have to go. This is always an annoying thing: testing this is always a bitch.

Alright, so let me also. In the app, as soon as I type hello and I hit send, I got a rate limiting message on the first message. Chat's not sending at all. This chat input is just broken. If I do a slash command, there's layout shift, so the input is unnecessarily layout shifting. It should already be handling that correctly. Type in: okay, T key is still switching me to light mode. Get rid of that keyboard shortcut.

Let me mention I mentioned tower swift, and it does do a smart chip, but then it gets jank. I'll show you what that looks like. Where am I talking to? Too many tabs. I actually don't even know where the fuck I was talking to you. Alright, well, I guess I'm talking to you right now.

Oh my God, I'm having a day right now. I somehow injured my fucking pinky. Okay, so you got a screenshot of that, Cenk. Oh my God, the same square focus ring situation is kinda happening all over the app. I think that's just a focus visible thing. I just got unnecessarily logged out for some reason. I don't know what that's about, and now I'm getting a click proxy error. I'm getting this JSON error in my browser. 

Alright, so right there, that's a whole bunch of shit that just is preventing anyone from properly signing up for this thing and even getting onto the waitlist. I think that's enough shit that all of that should be addressed right now. Can you sort that into kind of a list of items to tackle and the best way to tackle them and prioritize them? Also, can you think through every one of those problems and give me guarding rules and testing rules to catch it? I'm really confused. I thought we had rules in place to catch things like:
- focus rings that are not set to focus visible and stuff
- the fact that you can't even type into the Chat
- the fact that the signup page doesn't work
There should be a test in our fucking system that checks that any call to action button on the homepage to sign up takes you to the signup page or triggers the signup mode. I would even say, for now, just send them to the signup page, like the sign in modal isn't necessarily used. The reason for the sign in modal was when we were going to do a chat interface in the hero section and make it kind of feel like you're already in the app. I do think that that makes sense, but it's got to work. Who partied it? We don't currently have a chat interface in our homepage right now, so that has to be hardened and there has to be testing to catch this shit.
I'm confused why this is not just covered in Golden Path, like signing up for the fucking app is basic. Golden Path should cover that you can. Testing coverage should make sure that the home page looks great at every breakpoint. Any call-to-action button or sign-in button properly sends you to either a call it's sign up modal or a sign-in modal or sign-up page or a sign-in page. In any of those four situations:
- sign up or sign in modal or page
You should have a link to take you to the respective opposite version, so if you're on a sign up modal or sign up page, you get a link to a sign in modal or sign in page. The copies should be correct on either mode. They should be refactored to use the same components. The design should translate. If the font looks right on the sign up page, there's no reason the font should then be oversized on the sign up modal. The modal should be properly tested for:
- clicking out of it to close it
- making sure that the back button still works
- making sure that all the links work
All that shit should be thoroughly tested and hardened. It should be, honestly, the auth system should be the most tested thing in the whole fucking app, because if that doesn't work, you can't use that. Really, testing our test coverage should be like:
- public profiles are the most tested thing
- the home page is the most tested thing
- the next thing should be waitlist and onboarding
- the next thing should be the dashboard and chat
- and then from there we move down
The stuff that a user tests/touches the most should be the most tested set. It should just feel solid, and there's so much junk. I'm having a fucking hard-ass time, because I would have thought this is obvious shit.

So I guess what I might ask here is, can you build me a plan that's going to go hard on all this shit and do some research and figure out what we're missing and what kind of world-class things we can do to catch on to this shit and prevent it from continuing to happen? Because it feels like I've been fixing the same bugs for six months. 

---

## Assistant

Mr. White, the pattern is clear: production is shipping without a hard-enforced “public surface + signup + onboarding + chat” release gate.

I checked the GitHub repos I could access. The current `JovieApplication` `package.json` only exposes `dev`, `build`, `start`, and `lint`; it does not define unit, integration, E2E, accessibility, visual regression, or smoke-test scripts. Its dependencies also do not show Playwright/Cypress/Vitest/Jest/Axe-style test tooling. fileciteturn3file0 The older Nuxt repo looks similar: build/dev/generate/preview/postinstall, with no test script surface. fileciteturn4file0 If this is the production app/repo, the answer to “why didn’t our tests catch this?” is simple: the actual release-critical test harness does not appear to exist in the executable project surface.

## P0 — stop bleeding immediately

### 1. Signup/auth is broken or misleading

**Observed issues**
- Apple signup returned invalid client.
- Signup page uses sign-in copy: “Welcome back / no account / sign up.”
- Signup modal says “Create your account,” but typography/layout is janky.
- Modal back button is janky.
- Sign-in button/link inside auth flow does not navigate correctly.
- Clerk proxy error / JSON browser error.
- User can get logged out unexpectedly.
- Homepage CTAs do not reliably send users into a working signup path.

**Best fix**
- Stop using auth modals for now unless the modal is fully hardened. Route all public CTAs to `/sign-up`.
- Keep `/sign-in` and `/sign-up` as first-class pages.
- Disable Apple in Clerk production until credentials are valid. You already did this manually; now add a config guard so it cannot silently appear when broken.
- Refactor auth UI into one shared `AuthShell` component with `mode="sign-in" | "sign-up"`.
- Make page and modal use the exact same content model, typography scale, links, and provider list.
- Fix Clerk proxy/env config before touching design polish.

**Guardrails/tests**
- Playwright: every public CTA with `data-testid="cta-sign-up"` must navigate to `/sign-up` or open a signup modal with `role="dialog"` and `data-auth-mode="sign-up"`.
- Playwright: `/sign-up` must contain signup copy, signup form/providers, and a working link to `/sign-in`.
- Playwright: `/sign-in` must contain sign-in copy, sign-in form/providers, and a working link to `/sign-up`.
- Playwright: auth modal close behavior works by Escape, backdrop click, visible close button, and browser back.
- Config test: social providers shown in UI must match enabled provider config. If Apple credentials are missing, Apple cannot render.
- Smoke test: production-like environment must complete the first unauthenticated CTA → signup page → auth attempt → onboarding/waitlist handoff path.

---

### 2. Chat input is broken

**Observed issues**
- First message gets rate-limited.
- Chat message does not send.
- Slash command causes layout shift.
- Entity chip/smart chip for “Taylor Swift” becomes janky.
- Input focus ring shows square/incorrect outline.
- `T` key still toggles light mode.
- User can type but core chat path fails.

**Best fix**
- Treat chat as a P0 product path, equal to signup.
- Remove the `T` theme shortcut completely in production.
- Fix the rate-limit policy so a new session/new authenticated user/new anonymous onboarding user can send the first message.
- Separate text input state from chip rendering state so entity detection cannot corrupt the input.
- Reserve vertical space for slash-command UI so it does not cause layout shift.
- Add a single canonical `ChatInput` component and ban raw input implementations for chat.

**Guardrails/tests**
- Playwright: type “hello,” press Enter, assert the message appears in transcript and no rate-limit toast appears.
- Playwright: type `/`, assert command menu appears without moving the input container beyond an allowed pixel threshold.
- Playwright: type “Taylor Swift,” assert chip appears, input remains editable, send still works.
- Playwright: pressing `T` while input is focused inserts/types normally or does nothing; it must never toggle theme.
- Unit test: first-message rate-limit function returns allowed for a fresh valid user/session.
- Visual regression: chat input focused, chip state, slash menu state, error state, loading state.

---

### 3. Cookie banner is broken

**Observed issues**
- “Accept all” cannot be clicked.
- “Save preferences” cannot be clicked.
- Accept all should toggle analytics and marketing on per intended product behavior.
- Preference UI does not persist correctly.

**Best fix**
- Move cookie state into one consent controller.
- Ensure button hit areas are above overlays and not blocked by z-index/pointer-events.
- Store preferences once, then emit analytics/marketing consent changes.
- Confirm legal/privacy requirements before defaulting analytics/marketing on in California-facing production. From QA’s perspective, the test should assert the configured policy exactly.

**Guardrails/tests**
- Playwright: click Accept All → analytics true, marketing true, banner hidden, persisted after reload.
- Playwright: open preferences → toggle values → Save Preferences → values persist after reload.
- Playwright: keyboard-only operation works.
- E2E: banner buttons are clickable at mobile, laptop, desktop, and ultrawide widths.
- Runtime check: if consent UI renders, primary buttons must have nonzero bounding boxes and receive click events.

---

### 4. Public homepage contains internal/unsafe copy

**Observed issues**
- “Answers for every launch objection” is public-facing.
- “Objection” is internal sales/manipulation language and reads badly to customers.
- Spec wall copy feels unreviewed.
- Animations are repetitive.
- This section should be flagged off until rewritten.

**Best fix**
- Feature-flag or remove the spec wall from production immediately.
- Rebuild it with customer-facing language.
- Put marketing copy in a reviewed content file/CMS object rather than scattered component text.
- Add a public-copy lint rule.

**Guardrails/tests**
- Copy lint bans terms on public pages: `objection`, `manipulate`, `waitlist` when not explicitly approved, `test song`, `fake data`, `lorem`, internal notes, placeholder names.
- Snapshot test for public landing copy.
- Review gate: public copy changes require approval from a named reviewer before production deploy.
- Visual regression for every marketing section at major breakpoints.

---

## P1 — fix the homepage quality bar

### 5. Logo bar has fake/text logos

**Observed issues**
- Blanco y Negro and RecPlay are text, not real logos.
- Logo bar needs world-class formatting across breakpoints.

**Best fix**
- Replace with real SVG/PNG marks only.
- Remove any logo that cannot be sourced cleanly.
- Normalize logo height, optical weight, grayscale/contrast, and spacing.
- Add responsive wrapping rules.

**Guardrails/tests**
- Asset lint: logo bar cannot render plain text fallback for partner/customer logos.
- Visual regression: logo bar at 375, 768, 1024, 1440, 1728, and ultrawide.
- Image test: all logo assets must have real dimensions, alt text, and optimized formats.

---

### 6. Hero/section order feels disjointed

**Observed issue**
- “A new kind of operating system built for music artists” is strong, but the next section does not immediately show the operating system.
- “Go live in 60 seconds” likely belongs directly under the OS headline.
- “Release plan Jovie can run” works better after that context.

**Best fix**
- Reorder:
  1. Hero: operating system for artists.
  2. “Go live in 60 seconds.”
  3. Release plan Jovie can run.
  4. One workspace for every release.
  5. Artist profiles built to convert.

**Guardrails/tests**
- Visual regression for each section.
- Content snapshot for section ordering.
- Landing-page review checklist: headline → proof/product visual → benefit → CTA.

---

### 7. Product screenshots use fake/generic seed data

**Observed issues**
- Real artists/songs mixed with fake/generic data.
- “Don’t Look Down” is a test song.
- Releases need actual album art.
- Collaborators must be credited correctly.
- If Tom Fall is on a release, he must be credited.
- Screenshots using your Spotify-linked catalog should not invent song names or artist credits.
- Multiple screenshots should vary details like audio player timestamp.

**Best fix**
- Stop hand-authoring seed metadata for real artists.
- Pull canonical title, artists, album art, duration, and Spotify IDs from Spotify.
- Allow fake status/date/stage only after canonical music metadata is correct.
- Create fixture records from Spotify import and snapshot them.
- Add a screenshot fixture builder that varies nonessential UI state.

**Guardrails/tests**
- Seed-data invariant: if a release has a Spotify ID, title/artists/artwork must come from Spotify-derived canonical data.
- Test fails if release title contains known placeholders like “Don’t Look Down.”
- Test fails if a real release has missing collaborator credits.
- Screenshot fixture test: repeated screenshots cannot reuse identical audio timestamp when the player is visible in multiple sections.
- Public screenshot review checklist: no fake real-person data, no miscredited artists, no placeholder assets.

---

### 8. Pricing is misaligned with actual product behavior

**Observed issues**
- Pricing does not match real pricing.
- “Request access” should be removed.
- Free and Pro should exist as real intended plans.
- Users should sign up, enter onboarding/waitlist flow, and have intended plan stored.
- Public page should avoid saying “waitlist”; “coming soon” is acceptable only if absolutely needed.

**Best fix**
- Create one source of truth: `plans.ts` or equivalent.
- Marketing pricing, checkout/onboarding, gating, and dashboard plan labels all read from the same source.
- Let users select a plan, sign up, store intended plan, then gate internally.
- Avoid public waitlist framing.

**Guardrails/tests**
- Contract test: marketing pricing cards match plan source of truth.
- E2E: click Free → signup → onboarding stores `intendedPlan=free`.
- E2E: click Pro → signup → onboarding stores `intendedPlan=pro`.
- Copy lint: public pricing cannot say “waitlist” unless explicitly allowlisted.
- Runtime assertion: every displayed plan has an internal plan ID and gating rule.

---

## P2 — polish and consistency

### 9. Focus rings are wrong across app

**Observed issue**
- Square focus-visible/focus ring behavior appears across app.

**Best fix**
- All interactive components use design-system focus styles.
- Use `focus-visible` behavior for keyboard focus.
- Mouse click should not show heavy keyboard-style ring.
- Ban ad hoc focus classes outside the component library.

The `MainApp.tsx` I could access includes raw focus ring classes such as `focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500` on textarea UI rather than a centralized focus-visible component style, which supports the broader guardrail need. fileciteturn21file0

**Guardrails/tests**
- ESLint rule or custom static check: raw `focus:ring`, `focus:outline`, `outline-*`, or `ring-*` on interactive elements must use approved component utilities.
- Playwright keyboard test: Tab through homepage, auth, modal, chat, pricing, cookie banner.
- Visual regression: focused button/input/modal states.
- Axe accessibility test on public pages and app shell.

---

### 10. Breakpoint quality is uneven

**Observed issues**
- Artist profile cards look great but may be too tall on normal Retina MacBook Pro.
- Homepage looked good on ultrawide in your check.
- Need breakpoint assurance, not manual spot checks.

**Best fix**
- Define canonical viewport matrix:
  - 375 mobile
  - 390 mobile
  - 768 tablet
  - 1024 laptop
  - 1280 desktop
  - 1440 desktop
  - 1728 MacBook scaled
  - 2560 ultrawide
- Add screenshot tests for homepage, auth, onboarding, chat, dashboard, public profile.

**Guardrails/tests**
- Playwright visual snapshots for each viewport.
- Layout assertions: no horizontal scroll, no clipped CTAs, no hidden primary buttons, no overlapping modals.
- Lighthouse/Playwright smoke for public homepage and profile.

---

### 11. Footer lacks generous padding

**Best fix**
- Increase vertical rhythm and footer spacing.
- Ensure footer feels intentional on mobile, desktop, and ultrawide.

**Guardrails/tests**
- Visual regression only.
- Design review checklist item: footer spacing and final viewport composition.

---

## P0 issue list to create

1. **P0: Public signup CTAs must route to working signup page**
2. **P0: Fix Clerk proxy/runtime auth errors in production**
3. **P0: Disable Apple provider unless production credentials are valid**
4. **P0: Refactor signin/signup page + modal into shared AuthShell**
5. **P0: Auth flow E2E coverage for page and modal modes**
6. **P0: Chat input first-message send path broken**
7. **P0: Remove production `T` theme keyboard shortcut**
8. **P0: Fix entity chip and slash-command layout shift in ChatInput**
9. **P0: Cookie banner Accept All and Save Preferences broken**
10. **P0: Remove/flag internal “launch objection” spec-wall copy from production**
11. **P0: Add production smoke tests for homepage → signup → onboarding/waitlist → chat**

## P1 issue list to create

12. **P1: Replace/remove fake logo-bar text logos**
13. **P1: Reorder homepage sections around “Go live in 60 seconds”**
14. **P1: Replace fake release seed data with Spotify-derived canonical fixtures**
15. **P1: Add seed-data invariant tests for real artists/releases**
16. **P1: Create pricing source of truth and sync marketing/onboarding/gating**
17. **P1: Add copy lint for public marketing pages**
18. **P1: Add visual regression matrix for homepage/auth/onboarding/chat**
19. **P1: Add accessibility/focus-visible test suite**
20. **P1: Add design-system enforcement for buttons, inputs, modals, auth UI**

## P2 issue list to create

21. **P2: Improve spec-wall animations and customer-facing content**
22. **P2: Tune artist-profile card height across laptop breakpoints**
23. **P2: Improve footer spacing**
24. **P2: Vary screenshot fixture details across landing page sections**

## Testing architecture I would install

### 1. Release-critical Playwright suite

Run on every PR and before every deploy.

Required specs:
- `homepage.spec.ts`
  - homepage loads
  - no console errors
  - all CTAs resolve
  - logo bar has image assets only
  - pricing buttons resolve to intended auth/onboarding path
- `auth.spec.ts`
  - sign-up page copy correct
  - sign-in page copy correct
  - signup ↔ signin links work
  - modal open/close/backdrop/Escape/back button work if modal remains supported
  - provider buttons match config
- `onboarding.spec.ts`
  - plan selection survives signup
  - waitlist/internal gating works without public “waitlist” copy
- `chat.spec.ts`
  - can type first message
  - can send first message
  - no immediate rate limit
  - slash command does not shift layout
  - smart chip does not break input
  - `T` shortcut does not toggle theme
- `cookies.spec.ts`
  - accept all works
  - save preferences works
  - persisted preferences reload correctly
- `a11y.spec.ts`
  - axe scan on homepage, auth, onboarding, chat, public profile
  - keyboard tab path works

### 2. Visual regression suite

Use Playwright screenshots, Percy, or Chromatic. Minimum pages:
- homepage
- sign-up page
- sign-in page
- auth modal
- onboarding
- waitlist/gated state
- chat empty state
- chat active state
- chat slash command
- chat smart chip
- dashboard
- public artist profile
- cookie banner

Minimum viewports:
- 375
- 390
- 768
- 1024
- 1280
- 1440
- 1728
- 2560

### 3. Static guardrails

Add custom checks that fail CI for:
- public copy banned terms
- placeholder/test song names in production fixtures
- raw buttons/inputs/modals outside approved components
- raw focus styles outside approved focus-visible utility
- provider buttons rendered without matching provider config
- pricing cards not backed by plan source of truth
- public page CTAs without `data-testid`
- public CTA missing destination/mode metadata

### 4. Seed-data contract tests

For real music data:
- every release with external ID must use canonical title
- every release must have canonical artist credits
- every release must have canonical artwork
- fake dates/status allowed only in explicitly named demo fields
- fake titles/artists/artwork banned
- placeholder values banned in public screenshots

### 5. Production smoke monitoring

After every deploy:
- synthetic visit to homepage
- click primary CTA
- reach signup
- verify auth provider list
- verify cookie banner buttons work
- verify chat input accepts text in authenticated or test session
- alert Slack/Sentry if any public P0 path fails

## CI/release gate

A PR cannot merge unless:
- typecheck passes
- lint passes
- unit tests pass
- Playwright P0 suite passes
- accessibility smoke passes
- copy lint passes
- seed-data contract passes
- visual regression approved for touched surfaces

A deploy cannot promote unless:
- production-like smoke passes
- Clerk provider config check passes
- pricing source-of-truth check passes
- no public copy lint violations
- no broken CTA/link checks
- no console errors on homepage/auth/onboarding/chat

## Definition of done for this cleanup

This cleanup is done when a fresh user can:

1. Visit homepage.
2. See only real logos and customer-facing copy.
3. Click any signup CTA.
4. Land on correct signup page or hardened signup modal.
5. Switch between signup and signin.
6. Authenticate through an enabled provider.
7. Enter onboarding.
8. Have selected plan preserved.
9. Reach gated/waitlist state without public jank.
10. Open chat.
11. Type and send the first message.
12. Use slash commands without layout shift.
13. Mention an artist and see a stable smart chip.
14. Use cookie preferences.
15. Navigate the whole flow by keyboard with correct focus-visible styling.
16. Pass the same flow on mobile, laptop, desktop, and ultrawide.

The immediate missing piece is an enforced executable test surface. The repo package files I could inspect do not show the testing stack needed to catch these failures before production.

---

## User

jovieinc/jovie the actual repo. We ground this in the actual repo. There's extensive testing on it already, and a whole system of checks and stuff. PRs already have to pass through a bunch of gates. 

---

## User

jovieinc/jovie is the code repo. There's extensive testing in place in the actual repo, so you obviously didn't look at the right repo, it seems. Make no assumptions if you've not actually analyzed the repo. Compile this whole thing together with knowledge of the repo if you can, and then no additional assumptions. Give me the whole thing, everything included, as a handoff prompt I can get to Clonk code, which will have knowledge of the repo. Have it investigate all of this and harden all of this and build tests. 

---

## User

Also instructed to use G-Brain and to make sure all of this knowledge exists in G-Brain. Instructed to use ROOTFLOW for spinning up agent teams to handle this in parallel as quickly as possible, and to make sure it uses G-STACK so that everything is validated as it ships. It ships all of this in relevant order and quickly and fully autonomously. 

---

## Assistant

Mr. White, you’re right. My previous read was pointed at the wrong repo.

I inspected `JovieInc/Jovie`. The repo already has a serious testing and gate system: root scripts include `test`, `test:ci`, `test:e2e`, `test:web:e2e`, `test:web:smoke`, `test:guard`, `test:flaky`, `next:proxy-guard`, `tailwind:check`, `pre-push`, and Playwright/Vitest dependencies. fileciteturn26file0 The web app has even more: Golden Path, smoke, synthetic, visual regression, screenshots, Axe, Lighthouse for public/dashboard/onboarding/admin/chat, public route QA, exhaustive public surface QA, overnight QA, mutation hotspots, and performance budget checks. fileciteturn27file0

The right diagnosis is: the system exists, and several of the failures are slipping through because the assertions are too shallow, too scoped, or preserving bad states.

## What the current repo is actually doing well

There are real launch gates. `docs/launch/LAUNCH_GATES.md` says launch-candidate PRs require `PR Ready`, `Golden Path (PR)`, dashboard Lighthouse, and onboarding Lighthouse; those gates activate for auth signup/signin entrypoints, onboarding, dashboard shell/releases, billing/checkout, golden-path specs/helpers, and launch-gate config. fileciteturn36file0

There is synthetic production monitoring. The workflow runs against `https://jov.ie`, uses Doppler production secrets, executes `synthetic-golden-path.spec.ts` plus public profile smoke, parses results, fails the job if tests fail or skip, and sends Slack alerts. fileciteturn52file0

There is public surface QA. `public-surface-qa.ts` builds the production app locally, seeds data, runs public route QA, public exhaustive Playwright tests on desktop/mobile, Axe audit, performance budgets, and public Lighthouse. fileciteturn42file0

The homepage spec is already extensive: it checks hero copy, CTA hrefs, header CTA hrefs, product sections, image quality, pricing card layout, mobile drawer CTAs, overflow across common viewports, and console errors. fileciteturn47file0

## The gaps that explain your observed bugs

### 1. The homepage tests are currently blessing the bad copy

The public copy source contains:

`specWall.headline: 'Answers for every launch objection'`

and the body copy you flagged. fileciteturn46file0

The homepage E2E test explicitly asserts that this exact heading is visible. fileciteturn47file0 That turns bad customer-facing copy into a passing requirement.

**Fix:** replace or flag off the section, then add a public-copy guard that fails on internal-facing words in public marketing surfaces: `objection`, `request access` where signup is intended, `waitlist` outside approved contexts, `test song`, `fake data`, placeholder copy, and internal implementation language.

---

### 2. CTA tests check `href`, then stop too early

Homepage tests assert CTAs point to `/signup`, including hero, header, artist profiles, mobile drawer, and final CTA. fileciteturn47file0 That catches broken links, but it does not prove the user lands on a working signup experience.

**Fix:** every public signup/pricing CTA test should click through and assert:

1. URL is `/signup` or `/signup?plan=...`.
2. `#auth-form` renders.
3. Correct signup-specific copy renders.
4. At least one enabled, configured auth method renders.
5. No Clerk proxy error, JSON error, or invalid-client page appears.
6. Opposite-mode link routes to `/signin`.
7. Plan intent is persisted when `?plan=` is present.

---

### 3. Synthetic Golden Path has a signup coverage escape hatch

The production synthetic test clicks the homepage primary CTA and reaches `/signup`. Then it looks for email signup. If email signup is unavailable, it only asserts that an Apple or Google OAuth button is visible, logs a warning, and does not complete onboarding/profile creation. The warning text says onboarding/profile creation is not exercised while production email signup is unavailable. fileciteturn53file0

That means a visible Apple button can satisfy the synthetic path even if clicking Apple produces `invalid_client`.

**Fix:** synthetic signup must fail unless one complete signup path works. “OAuth visible” is insufficient. Either:

- use a production-safe test email signup path, or
- click the rendered OAuth provider and assert it starts a valid provider flow without `invalid_client`, then stop at a safe expected boundary.

Synthetic warnings on signup coverage should be treated as failures for launch readiness.

---

### 4. Auth tests check render health more than exact product behavior

`auth.spec.ts` verifies signin/signup render Clerk UI, legal links show, and signin/signup navigation preserves `redirect_url`. It accepts broad Clerk UI selectors like email input, Continue, Google, Sign up, or Sign in. fileciteturn50file0

`smoke-auth.spec.ts` checks signin/signup pages load without 5xx and that the body has content. fileciteturn39file0

`smoke-prod-auth.spec.ts` verifies production sign-in with seeded credentials and dashboard/tab navigation. It does not create a new production signup. fileciteturn51file0

The auth README also says Clerk Dashboard configuration is the source of truth for enabled auth methods and providers. fileciteturn49file0 That makes provider-config drift a real risk unless production/staging tests click or validate the rendered provider list.

**Fix:** add an auth contract spec:

- `/signup` must contain signup copy, not signin copy.
- `/signin` must contain signin copy, not signup/request-access copy.
- Signup page must expose link to signin.
- Signin page must expose link to signup.
- Every rendered social provider must be allowed by a testable provider config.
- Apple must be hidden when Apple credentials are missing.
- Clicking Apple/Google in staging/production smoke must never produce `invalid_client` or Clerk proxy JSON errors.

---

### 5. Chat Golden Path covers one happy command, not the broken states you hit

`golden-path-app.spec.ts` has a chat test that signs in, opens `/app/chat`, fills `preview profile`, clicks send, and asserts an assistant message appears containing “profile.” fileciteturn31file0

That is useful, but it does not cover:

- fresh first message being rate-limited,
- normal “hello” send path,
- slash command layout shift,
- smart chip/entity state for “Taylor Swift,”
- input focus ring behavior,
- global `T` theme shortcut interfering with chat.

The ChatInput unit tests cover focused send, attachment menu, and quick actions. fileciteturn59file0 The actual global `T` shortcut exists in `CoreProviders.tsx`; it toggles theme on `/app`, `/onboarding`, `/signin`, `/signup`, and `/waitlist`, unless the event target is detected as a form element. fileciteturn61file0

**Fix:** create `chat-composer-contract.spec.ts`:

- fresh signed-in user sends `hello`; no first-message rate-limit.
- `T` pressed in chat does not toggle theme.
- `/` opens the picker with composer surface height/position within a strict delta.
- “Taylor Swift” entity/chip path keeps the input editable and sendable.
- focus-visible state screenshots compare against expected rounded composer focus.

Also remove or dev-gate the global `T` shortcut. It has too much production blast radius.

---

### 6. Cookie banner tests are unit-state tests, not browser clickability tests

The code path does set analytics and marketing true on Accept All. fileciteturn64file0 Cookie unit tests confirm Accept All stores `marketing: true`, Reject stores `marketing: false`, and saved modal preferences load. fileciteturn68file0

That still misses the actual bug you saw: buttons can exist and unit-test correctly while being unclickable in a real viewport because of overlay, z-index, pointer-events, safe-area layout, or responsive expansion.

Public exhaustive QA includes optional `cookie-banner` interactions in the public surface manifest. fileciteturn44file0 The exhaustive spec runs declared interactions and checks no critical errors/overflow. fileciteturn43file0 Optional interaction means this can pass without proving Accept All and Save Preferences work on the homepage in desktop/mobile.

**Fix:** make cookie consent a required browser-level contract for `home`, `legal-cookies`, and marketing pages:

- force `jv_cc_required=1`;
- click Accept All on desktop and mobile;
- assert banner hides and localStorage/cookie reflect analytics+marketing true;
- reopen preferences;
- toggle analytics/marketing;
- click Save Preferences;
- assert saved state persists after reload.

---

### 7. Pricing behavior is controlled by env and defaults only Free active

`marketingPricingPlans.ts` defaults `NEXT_PUBLIC_MARKETING_ACTIVE_PLANS` to `free`. Pro and Team use `waitlistCtaLabel: 'Request Access'` unless marked active. All plan hrefs still route to `/signup?plan=${planId}`. fileciteturn71file0

The signup page captures `?plan=` and stores plan intent. It currently renders “Request Access” and sends successful signup to `APP_ROUTES.WAITLIST`. fileciteturn72file0

**Fix:** align public pricing with the intended product behavior:

- mark Pro active if users should be able to select it;
- replace public “Request Access” with signup/trial language where appropriate;
- preserve internal gating after signup;
- add test coverage that Free and Pro CTAs click through, preserve plan intent, and reach onboarding/waitlist gating without public “waitlist/request access” framing.

## P0 changes I would make to the existing system

| Area | Existing file(s) | Current gap | Required change |
|---|---|---|---|
| Bad public copy | `apps/web/data/homepageLaunchCopy.ts`, `homepage.spec.ts` | Test asserts “launch objection” | Rewrite/flag section; add public-copy guard |
| CTA/signup | `homepage.spec.ts`, `auth.spec.ts`, `synthetic-golden-path.spec.ts` | Href/render checks stop before working signup | Click every CTA through to working auth shell |
| OAuth | Auth README, `smoke-prod-auth.spec.ts` | Provider visibility can pass while provider is invalid | Provider canary: rendered providers must start valid auth flow |
| Synthetic | `synthetic-golden-path.spec.ts` | Warning permits incomplete signup coverage | Treat signup coverage warnings as failures |
| Chat | `golden-path-app.spec.ts`, `ChatInput.test.tsx`, `CoreProviders.tsx` | Happy command only; no slash/chip/T/rate-limit coverage | Add chat composer contract spec; remove/dev-gate `T` |
| Cookie | `CookieBannerSection.tsx`, `CookieModal.tsx`, cookie unit tests, public manifest | Unit state passes while browser clickability can fail | Required browser click tests at desktop/mobile |
| Pricing | `marketingPricingPlans.ts`, signup page | Active plan/env mismatch creates Request Access flow | One plan-intent contract from pricing → signup → gating |

## The gate adjustment

Add one new required lane: **P0 Conversion Contract**.

It should run on merge queue, main, launch-candidate PRs, and any PR touching:

- `apps/web/app/(home)/`
- `apps/web/components/features/home/`
- `apps/web/data/homepageLaunchCopy.ts`
- `apps/web/data/marketingPricingPlans.ts`
- `apps/web/app/(auth)/`
- `apps/web/components/features/auth/`
- `apps/web/components/jovie/`
- `apps/web/components/chat/`
- `apps/web/components/organisms/Cookie*`
- `apps/web/lib/cookies/`
- `apps/web/components/providers/CoreProviders.tsx`

The lane should include:

- homepage CTA click-through contract;
- auth copy/provider contract;
- cookie consent browser contract;
- chat composer contract;
- pricing plan-intent contract;
- public-copy guard;
- seed/screenshot media contract.

## Bottom line

The repo has the right foundation. The failures came from contract gaps:

- tests proving presence instead of completion;
- optional interactions where the product needs hard requirements;
- synthetic warnings where launch readiness needs failure;
- exact assertions preserving bad copy;
- missing production-provider canaries;
- missing real-browser clickability checks;
- missing chat composer edge-state coverage.

I did not run the suite; this is based on repo inspection. The immediate highest-leverage fix is to turn the specific bugs you found into hard P0 regression contracts inside the existing Playwright/QA/gate system rather than adding another broad test layer.

---

## Assistant

Mr. White, corrected. I verified `JovieInc/Jovie` and it has extensive testing in place. The root and `apps/web` package scripts include Playwright, Vitest, smoke, golden-path, a11y, visual, public QA, Lighthouse, guard, and profiling lanes. fileciteturn27file0 fileciteturn28file0 Existing coverage includes golden-path app/chat flows, smoke auth, signup funnel smoke, chat composer surface tests, auth route tests, public exhaustive QA, and homepage specs. fileciteturn31file0 fileciteturn34file0 fileciteturn35file0 fileciteturn36file0 fileciteturn37file0 fileciteturn42file0 One concrete repo finding: `apps/web/data/homepageLaunchCopy.ts` currently contains the public spec-wall headline “Answers for every launch objection,” and `homepage.spec.ts` currently asserts that exact heading, so at least one problem is encoded as passing behavior. fileciteturn44file0 fileciteturn45file0

Paste this into Clonk Code:

```text
You are working in the real Jovie repo: JovieInc/Jovie.

Do not assume anything. Start by inspecting the actual repo, current branch, tests, CI gates, G-Brain knowledge, G-STACK validation conventions, ROOTFLOW conventions, routes, components, feature flags, Statsig/config, Clerk config integration, and deployment pipeline.

Primary objective:
Investigate and harden the current production product issues described below. Fix the issues, add/repair tests and guardrails so they cannot regress, record all durable product/test knowledge in G-Brain, use ROOTFLOW to parallelize agent teams, and use G-STACK validation before shipping each relevant batch. Work fully autonomously unless blocked by credentials, destructive production changes, or a genuinely ambiguous business decision.

Founder QA context:
The product was manually tested on production/current web surface. The reported failures are blocking confidence in the signup funnel, homepage, onboarding, chat, consent, and launch-readiness quality bar. Some issues may already have partial coverage in tests. Your job is to investigate why existing coverage did not catch them, update the product, and harden the relevant lanes.

Mandatory operating instructions:
1. Use G-Brain first.
   - Read existing G-Brain knowledge for Jovie web, launch gates, public surface QA, homepage, auth, onboarding, waitlist, pricing, chat, cookies/consent, Clerk, seed data, screenshots, public profiles, G-STACK, and ROOTFLOW.
   - Do not duplicate stale knowledge. Update or supersede it.
   - Add a durable G-Brain entry for this incident/QA pass with:
     - issue summary
     - root causes found
     - files/components touched
     - test gaps found
     - new guardrails added
     - validation commands run
     - remaining risks or follow-ups
2. Use ROOTFLOW.
   - Spin up parallel agent teams for:
     A. Homepage/marketing/copy/logo/pricing/seed-screenshot surface
     B. Auth/signup/signin/Clerk/modal/onboarding handoff
     C. Chat composer/rate-limit/smart chips/keyboard shortcuts/focus rings
     D. Cookies/consent/legal-behavior alignment
     E. Testing/guardrails/CI/G-STACK/release gates
     F. G-Brain documentation and coverage audit
   - Run these in parallel where possible, but serialize shipping/merge order by risk:
     P0 signup/auth/chat/cookie/internal-copy removal first
     P1 homepage data/pricing/logo/focus/seed-data hardening second
     P2 polish/animation/footer/card-height/visual refinements third
3. Use G-STACK for validation.
   - Discover the exact existing G-STACK commands and validation sequence in the repo.
   - Use existing scripts and conventions before inventing new ones.
   - Do not skip validation because a lane is slow. If a lane is flaky or currently skips coverage, investigate and fix the lane or document the precise reason with a mitigation.
   - Validate each shipped batch with the relevant subset, then run the full required stack before final.
4. No assumptions.
   - Verify actual current behavior locally/staging/prod-equivalent.
   - Verify what existing tests cover and what they only appear to cover.
   - Update tests that currently assert bad behavior.
   - Add failing regression tests before or alongside fixes where feasible.
   - Prefer durable source-of-truth changes over one-off patches.
5. Ship autonomously.
   - Make the changes.
   - Open/prepare PRs or commits in relevant order.
   - Record all findings in G-Brain.
   - Produce a final handoff report with exact tests run and results.

Known repo signals to verify:
- Root package has extensive scripts for build, lint, typecheck, test, E2E, smoke, guard, profile, flaky, pre-push, web-specific lanes, etc.
- apps/web has extensive Playwright/Vitest/Axe/Lighthouse/public QA/screenshot/visual/golden-path scripts.
- Existing likely relevant files/tests include:
  - apps/web/package.json
  - package.json
  - apps/web/data/homepageLaunchCopy.ts
  - apps/web/tests/e2e/homepage.spec.ts
  - apps/web/tests/e2e/auth.spec.ts
  - apps/web/tests/e2e/smoke-auth.spec.ts
  - apps/web/tests/e2e/signup-funnel.smoke.spec.ts
  - apps/web/tests/e2e/golden-path-app.spec.ts
  - apps/web/tests/e2e/chat-composer.spec.ts
  - apps/web/tests/e2e/public-exhaustive.spec.ts
  - apps/web/scripts/public-surface-qa.ts
  - apps/web/tests/e2e/axe-audit.spec.ts
  - apps/web/tests/e2e/visual-regression.spec.ts
  - any G-STACK, G-Brain, ROOTFLOW, launch-gate, and CI workflow files
- Important: homepageLaunchCopy currently contains “Answers for every launch objection,” and homepage.spec appears to assert that exact public heading. That must become a regression-prevention case, not a passing assertion.

P0 issues to investigate and fix:

1. Signup/auth is broken or misleading.
Observed:
- Apple signup returned invalid client.
- Apple was manually disabled in Clerk production during QA. Add code/config/test guardrails so broken Apple credentials cannot render in production again.
- Signup page shows sign-in copy: “Welcome back / no account / sign up.”
- Signin and signup pages appear to show the same copy.
- Signup modal says “Create your account,” but modal typography/layout is janky.
- Modal back button is janky.
- Clicking sign-in from the auth flow/modal does not navigate correctly.
- Clerk proxy error / JSON error occurred.
- User was unexpectedly logged out.
- Homepage CTA buttons must reliably route to signup or open a correct signup modal.
- For now, prefer sending public CTAs to the signup page unless the homepage hero chat/modal experience is fully hardened.

Required fixes:
- Audit signin/signup routes, route constants, Clerk components, modal auth components, CTA components, middleware/proxy, env/config, and any feature flags.
- Refactor signin/signup page and modal to shared source-of-truth components where appropriate.
- Ensure signin mode has signin copy and signup mode has signup copy.
- Ensure every signup view links to signin and every signin view links to signup.
- Ensure redirect_url/plan/handle params survive all auth mode transitions.
- Ensure provider buttons render only when configured and valid.
- Ensure Apple cannot appear in production unless credentials/config are valid.
- Investigate whether email signup should remain enabled or be hidden. Only change this if current product/config direction supports it. Record decision in G-Brain.
- Fix Clerk proxy error root cause.
- Fix unexpected logout root cause if reproducible.

Required tests/guards:
- E2E: all homepage public signup CTAs route to /signup or open a correct signup modal.
- E2E: /signup has signup-specific copy, signup UI, legal links, provider list, and signin link.
- E2E: /signin has signin-specific copy, signin UI, provider list, and signup link.
- E2E: redirect_url/plan/handle survive signin/signup link transitions.
- E2E: auth modal close/backdrop/Escape/browser-back works if modal remains supported.
- E2E: modal typography/layout matches page design system enough to prevent oversized text regression.
- Config/unit/static guard: social providers rendered in UI must match enabled/valid provider config.
- Guard: broken Apple config fails validation or hides Apple.
- Public CTA crawl: every link/button intended for signup/signin has correct destination and accessible label.
- Update existing auth/smoke/signup tests if they currently only assert “page loads” and miss incorrect copy/provider/modal behavior.

2. Chat input is broken.
Observed:
- Typing “hello” and pressing send produced a rate-limiting message on the first message.
- Chat did not send at all.
- Slash command caused layout shift.
- `T` key still toggles light mode. Remove that production shortcut.
- Mentioning “Taylor Swift” creates a smart chip but the chip/input becomes janky.
- Square focus ring/focus-visible issue appears across app, including the chat input screenshot.
- Chat is a core product path and must be a P0 test lane.

Required fixes:
- Audit ChatInput, composer surface, slash menu, smart/entity chip parsing, keyboard shortcut/theme handling, rate-limit logic, message send API, auth/session assumptions, and UI focus styles.
- Fix first-message rate-limit behavior. A fresh valid user/session must be able to send the first message.
- Ensure chat send works for plain natural-language text, not only deterministic commands.
- Remove or gate the `T` theme shortcut so it never fires while typing and does not exist as a production footgun.
- Stabilize smart chip rendering for “Taylor Swift” and other artist mentions.
- Stabilize slash command menu layout. Reserve space or otherwise prevent unintended layout shift.
- Centralize focus-visible styling for chat input and surrounding controls.

Required tests/guards:
- E2E: signed-in user can go to /app/chat, type “hello,” send it, and see the user message appear without immediate rate-limit error.
- E2E: first message from fresh/new test user is allowed.
- E2E: rate-limit test covers actual limit behavior separately.
- E2E: typing `/` opens slash command menu and layout shift stays below a strict threshold.
- E2E: typing “Taylor Swift” produces a stable smart chip and the input remains editable/sending works.
- E2E: pressing `T` while chat input is focused does not toggle theme.
- E2E/unit: theme shortcut is removed or only works in explicit non-input debug contexts, never production typing.
- Visual regression: empty, typing, slash menu, entity chip, focus, error, loading states.
- Update existing chat-composer/golden-path tests so they catch this exact failure, not only surface-mode transitions or deterministic “preview profile.”

3. Cookie/consent banner is broken.
Observed:
- Accept All cannot be clicked.
- Save Preferences cannot be clicked.
- Accept All should enable analytics and marketing according to intended product behavior.
- Current cookie banner jank must be fixed in the new one.
- Founder stated marketing/analytics should default on; verify current legal/product policy and existing consent implementation before changing defaults. Implement according to the product’s source of truth and document decision in G-Brain.

Required fixes:
- Audit cookie banner component, consent state, local storage/cookies, z-index/pointer-events, overlays, preferences modal, analytics/marketing integration.
- Fix clickability and persistence.
- Ensure preferences UI is keyboard accessible.
- Ensure consent changes actually toggle downstream analytics/marketing behavior.

Required tests/guards:
- E2E: Accept All button is clickable across desktop/mobile and enables expected categories.
- E2E: Save Preferences button is clickable and persists selected categories after reload.
- E2E: banner does not block unrelated CTAs after dismissal.
- E2E: keyboard-only consent flow works.
- Static/runtime guard: consent buttons must have nonzero bounding boxes and receive pointer events.
- Add coverage to public-surface QA if missing.

4. Public homepage contains internal/manipulative copy.
Observed:
- Spec wall says “Answers for every launch objection.”
- “Objection” is internal sales language and should not be public-facing.
- Supporting copy “The release details that usually become another tool...” is weak.
- Whole spec wall needs work.
- Cards appear to use repetitive/same animation.
- This section should be removed/flagged off in production until rewritten.

Required fixes:
- Immediately remove, hide, or rewrite spec wall copy so no internal “objection” framing appears publicly.
- Rewrite this section with customer-facing copy.
- Evaluate whether spec wall remains, is replaced, or is feature-flagged until quality bar is met.
- Update homepageLaunchCopy and all tests that currently assert bad copy.
- Add public copy guardrails.

Required tests/guards:
- Test must fail if public pages contain banned/internal terms such as “objection” in this context.
- Update homepage.spec so it asserts the new customer-facing heading or absence of the section.
- Add copy lint/static guard for public marketing copy:
  - objection
  - waitlist, unless specifically allowlisted
  - test song
  - fake data
  - lorem/placeholder
  - internal-only notes
  - manipulation/sales-internal wording
- Public-surface QA should include public copy scanning.

P1 issues to investigate and fix:

5. Logo bar has fake/text logos.
Observed:
- Blanco y Negro and RecPlay in the logo bar are text, not real logos.
- If proper logos cannot be sourced, remove them.
- If proper logos are found, format to match, optimize, and ensure the logo bar looks world-class at every breakpoint.

Required fixes:
- Audit logo bar data/assets.
- Replace text placeholders with real assets or remove entries.
- Normalize optical sizing, contrast, grayscale/color treatment, spacing, wrapping, and alt text.
- Ensure images are optimized.

Required tests/guards:
- Static guard: logo bar cannot render plain text fallback for partner/customer logos.
- E2E/visual: logo bar across mobile/tablet/laptop/desktop/ultrawide.
- Asset guard: logo entries require asset, dimensions, alt, and approved format.

6. Homepage flow feels disjointed.
Observed:
- “A new kind of operating system built for music artists” is strong.
- The next section should show the operating system immediately.
- “Go live in 60 seconds” likely belongs directly below the OS headline.
- Moving “Go live in 60 seconds” up may make “A release plan Jovie can run” feel intentional.
- Founder does not need to be involved if this reorder solves the disjointed feel.

Required fixes:
- Audit current section order and visual flow.
- Reorder sections so product narrative is coherent:
  - operating system statement
  - go live in 60 seconds / workspace proof
  - release plan Jovie can run
  - one workspace for every release
  - artist profiles built to convert
  - pricing/FAQ/final CTA
- Keep this grounded in actual current components; do not blindly apply this order if the repo already evolved. Verify.

Required tests/guards:
- Homepage spec asserts intended section order.
- Visual regression across breakpoint matrix.
- Public-surface QA catches broken anchors/scroll/CTA behavior after reorder.

7. Product screenshots/seed data use fake or generic data.
Observed:
- Screenshot uses real artists and real songs mixed with generic/fake data.
- “Don’t Look Down” is a fake test song and should not appear as a real Tim White release.
- Actual album art should be pulled for real releases.
- Collaborator credits must be correct, especially collaborations like Gilkicker/Gilken Miller, Tim White, Sober, and possibly Tom Fall.
- Since Jovie has Tim White Spotify data, seed/screenshots should use canonical Spotify-derived metadata.
- Fake status, date, and future release state are acceptable for product storytelling.
- Fake song names, fake artists, fake credits, and fake artwork are not acceptable for real artists.
- If two screenshots show the audio player, timestamps should vary so screenshots do not look duplicated.

Required fixes:
- Audit screenshot generation, product screenshot scenarios, seed data, Spotify import/canonical metadata utilities, release fixtures, and homepage screenshot references.
- Replace fake real-artist data with canonical Spotify-derived title, artists, credits, artwork, duration, and identifiers where possible.
- Preserve demo usefulness by allowing fake statuses/dates/stages only in explicit demo fields.
- Ensure collaborator credits are correct.
- Remove “Don’t Look Down” or mark it as test-only in non-public test fixtures.
- Vary screenshot UI state such as audio player timestamp across screenshots.

Required tests/guards:
- Fixture/contract test: any release with Spotify ID must use canonical title/artists/artwork.
- Public screenshot seed test fails on known placeholder/test song names.
- Public screenshot seed test fails when real artist releases are missing collaborator credits.
- Screenshot generation test fails if repeated screenshots use identical visible audio player timestamp without intentional reason.
- G-Brain entry documents canonical demo data policy: fake status/date okay; fake canonical music metadata not okay.

8. Artist profile cards/readability.
Observed:
- Artist profiles built to convert looks great.
- Cards may be too tall on normal Retina MacBook Pro.
- Need readability across breakpoints.

Required fixes:
- Audit artist profile section card heights, viewport behavior, content readability.
- Tune height/spacing/responsive behavior.

Required tests/guards:
- Visual regression at 390, 768, 1024, 1280, 1440, 1512/1728, 2560.
- Assertion: no clipped content, no unusable CTAs, no excessive viewport domination on laptop.

9. Pricing is misaligned with actual intended product behavior.
Observed:
- Pricing does not align with real pricing.
- Free is available now.
- Pro should be sign-up-able.
- Remove “Request access” buttons.
- Let users sign up and enter waitlist/chat onboarding flow.
- Store intended plan.
- Gate plans internally for now.
- Waitlist everyone not manually signed on, but do not publicly show “waitlist.”
- Avoid writing “waitlist” publicly. If needed, use “coming soon,” but preferred framing is that plans exist and signup works.
- Pricing copy/plans need rewrite.

Required fixes:
- Audit plan source of truth, marketing pricing, onboarding, billing/Stripe, waitlist/gating, plan param handling, and signup funnel.
- Create or enforce one source of truth for plans.
- Make pricing cards route to signup with intended plan preserved.
- Store intended plan through auth/onboarding.
- Gate internally without public waitlist language.
- Remove request-access CTAs unless required for enterprise only and approved by existing product direction.

Required tests/guards:
- Contract test: marketing pricing cards match plan source of truth.
- E2E: Free CTA → signup with plan preserved → onboarding/gated flow stores intended plan.
- E2E: Pro CTA → signup with plan preserved → onboarding/gated flow stores intended plan.
- Public copy guard: no “waitlist” on public pricing unless allowlisted.
- Regression test: “Request access” does not appear on Free/Pro if product direction says direct signup.
- Billing/signup funnel tests updated accordingly.

10. Focus rings / focus-visible issues across app.
Observed:
- Square focus ring situation happens all over the app.
- Likely focus-visible/design-system issue.

Required fixes:
- Audit design-system focus styles, Tailwind utilities, shared Button/Input/Textarea/Dialog components, auth modal, chat input, homepage CTAs, cookie banner.
- Replace raw/ad hoc focus styles with approved focus-visible utilities.
- Mouse click should not create ugly keyboard focus ring.
- Keyboard navigation must remain accessible and visible.

Required tests/guards:
- Static guard/lint: raw focus/ring/outline classes on interactive elements require approved utility/component.
- E2E keyboard tab tests for homepage, auth, modal, cookie banner, onboarding, chat, dashboard.
- Visual regression for focused controls.
- Axe coverage remains green.

11. Homepage/footer polish.
Observed:
- Footer needs more generous padding.
- Homepage ultrawide looked okay in manual check.
- Need systematic breakpoint assurance.

Required fixes:
- Improve footer spacing.
- Confirm all homepage sections hold up across major viewports, including ultrawide.

Required tests/guards:
- Visual regression/page screenshots at:
  - 375
  - 390
  - 768
  - 1024
  - 1280
  - 1440
  - 1512/1728 MacBook-ish
  - 2560 ultrawide
- Assertions: no horizontal scroll, no clipped CTAs, no broken image quality, no overlapping sections.

Testing/coverage audit requirements:

Investigate why existing tests did not catch these issues. Specifically inspect:
- Whether relevant tests are skipped in E2E_FAST_ITERATION or CI.
- Whether tests assert “page loaded” but not correct content/mode/copy.
- Whether tests use auth bypass/mocks that hide Clerk/provider/proxy problems.
- Whether tests codify bad copy, as homepage.spec appears to do for “Answers for every launch objection.”
- Whether chat tests use deterministic commands that bypass first-message natural-language/rate-limit behavior.
- Whether public exhaustive QA has declared interactions for all relevant CTAs/modals/buttons.
- Whether visual regression snapshots include the affected breakpoints/states.
- Whether a11y/focus-visible tests actually inspect visual focus style and keyboard behavior.
- Whether test selectors are stable and comprehensive enough.

Add or update tests in the existing framework. Prefer augmenting current specs over creating duplicate disconnected specs.

Minimum new/updated test coverage:
A. Homepage CTA crawler:
   - every signup/signin CTA on homepage/header/mobile drawer/pricing/final CTA routes correctly
   - no broken modal/page transitions
   - plan/redirect params preserved
B. Auth correctness:
   - signup page copy and mode
   - signin page copy and mode
   - signup ↔ signin links
   - modal behavior if modal remains
   - provider config guard including Apple
C. Chat P0:
   - first plain “hello” sends successfully
   - no first-message rate-limit
   - slash menu layout shift below threshold
   - Taylor Swift chip stable
   - T key does not toggle theme while typing
D. Cookie banner:
   - accept all clickable/persists/enables expected categories
   - save preferences clickable/persists
   - keyboard accessible
E. Public copy:
   - ban internal terms on public pages
   - no “objection” public heading
   - no public “waitlist” unless allowlisted
F. Seed/screenshot fixtures:
   - real Spotify metadata correctness
   - no fake song names for real artists
   - collaborator credits present
   - screenshot state variation
G. Focus-visible:
   - keyboard tab path
   - approved focus style
   - no ugly square rings from mouse focus
H. Visual/breakpoints:
   - homepage/logo/artist profiles/auth modal/chat/cookie/pricing at required viewport matrix

Suggested validation sequence to discover and adapt to repo:
- pnpm install or repo bootstrap as documented
- pnpm run typecheck / web typecheck
- pnpm run lint / web lint
- relevant unit tests
- relevant Playwright targeted specs
- public surface QA
- a11y axe
- visual regression where affected
- golden-path app/auth/signup/chat
- smoke lanes
- G-STACK full validation required by repo
Use exact repo commands after inspection. Do not invent command names if actual G-STACK defines them differently.

Expected shipping order:

Batch 1 — P0 safety unblock:
- Remove/replace public “objection” copy or flag section off.
- Fix signup/signin CTA routing and copy.
- Fix/guard Apple provider rendering.
- Fix Clerk proxy/auth breakage if reproducible.
- Fix chat first-send/rate-limit.
- Remove `T` production shortcut.
- Fix cookie banner clickability.
- Add P0 regression tests.
- Run targeted G-STACK validation.
- Update G-Brain.

Batch 2 — P1 product surface correctness:
- Logo bar real assets/remove placeholders.
- Pricing source-of-truth and CTA behavior.
- Seed/screenshot canonical metadata.
- Focus-visible design-system hardening.
- Homepage section order.
- Add contract/static/visual tests.
- Run relevant G-STACK validation.
- Update G-Brain.

Batch 3 — P2 polish and broad hardening:
- Artist profile card sizing/readability.
- Footer spacing.
- Spec wall animation/content polish if retained.
- Broader breakpoint/visual QA.
- Full public-surface QA and launch-gate validation.
- Update G-Brain.

Final deliverables:
1. Summary of what was fixed.
2. Root-cause analysis for why existing tests missed each issue.
3. List of tests added/updated with file paths.
4. List of guardrails added/updated with file paths.
5. G-Brain entries created/updated.
6. ROOTFLOW agents used and what each delivered.
7. G-STACK validation commands run and pass/fail results.
8. Remaining risks, only if truly unresolved.
9. PR/commit list in shipped order.

Quality bar:
A fresh user must be able to:
- visit homepage
- see only real/logically approved logo assets and customer-facing copy
- click any signup CTA
- land on correct signup page or a hardened signup modal
- switch between signup and signin
- see only valid configured auth providers
- authenticate or enter the intended auth/onboarding test lane
- preserve selected plan/handle/redirect intent
- enter onboarding/gated flow without public waitlist jank
- open chat
- type and send the first plain message
- use slash commands without layout shift
- mention Taylor Swift and keep a stable chip/input
- use cookie consent buttons
- keyboard-navigate with correct focus-visible styling
- pass the same core flow on mobile, laptop, desktop, and ultrawide

Do not stop at fixing visible symptoms. Harden the system so these classes of bugs are caught by CI/G-STACK/public QA/golden path before production.
```
