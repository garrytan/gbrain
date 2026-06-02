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

**Related:** [[coding_troubleshoot]]

> Conversation ID: 6a00d97c-ebe0-83e8-8f5c-64564c6033a7
> Created: 2026-05-10T19:16:14Z
> Updated: 2026-05-10T19:58:15Z
> Messages: 7


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


jovieinc/jovie the actual repo. We ground this in the actual repo. There's extensive testing on it already, and a whole system of checks and stuff. PRs already have to pass through a bunch of gates. 


jovieinc/jovie is the code repo. There's extensive testing in place in the actual repo, so you obviously didn't look at the right repo, it seems. Make no assumptions if you've not actually analyzed the repo. Compile this whole thing together with knowledge of the repo if you can, and then no additional assumptions. Give me the whole thing, everything included, as a handoff prompt I can get to Clonk code, which will have knowledge of the repo. Have it investigate all of this and harden all of this and build tests. 


Also instructed to use G-Brain and to make sure all of this knowledge exists in G-Brain. Instructed to use ROOTFLOW for spinning up agent teams to handle this in parallel as quickly as possible, and to make sure it uses G-STACK so that everything is validated as it ships. It ships all of this in relevant order and quickly and fully autonomously. 


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_product-feedback-and-issues-part2]]
- [[chatgpt/chatgpt_statism-for-product-analytics-part1]]
- [[chatgpt/chatgpt_ai-feedback-prompt]]
- [[chatgpt/chatgpt_app-ui-feedback]]
- [[chatgpt/chatgpt_application-revision-feedback]]
