---
title: "Issue Extraction and Recommendations"
type: essay
created: 2026-03-01
updated: 2026-03-01
source: chatgpt-export
conversation_id: 69a4c61c-a2ec-832a-8d55-39b8d7ed9805
message_count: 2
tags: [chatgpt, import, long-form]
---
# Issue Extraction and Recommendations

> Conversation ID: 69a4c61c-a2ec-832a-8d55-39b8d7ed9805
> Created: 2026-03-01T23:07:51Z
> Updated: 2026-03-01T23:08:16Z
> Messages: 2

---

## User

I'm gonna give you a list of issues. I need them just extracted, okay? So, one, the smart link demo on the homepage, I don't see any album art. We should grab that. You can, that song is probably available, so you can search it and grab the album art. The actual, like, links don't show up at all, contrast issues, but beyond that, they just don't look like our actual page, so look at the actual smart link page and then get that to match. Automatic links, instant notifications is cool, but that section doesn't talk at all about instant notifications, so that should probably be spun out into its own section. Automatic links, it should say smart links, because I don't know what, like, that's a specific thing, and it doesn't mean the same thing if you don't say it. The demo in the background of that, too, you have like two demos. You have the Spotify connected, new release detected, all of that. And then you have in front of it the actual smart link. I'd rather see like a table that just shows all the releases in there. So maybe our like desktop demo that we have up top should move down there and then have the smart link call out overlaid on top of that. And then... For the One Profile adapts to every fan, you can move that phone mock-up above the copy and then tighten that up into the header, so the top of the phone is right below the input, and then we can move those logos down into a logo bar somewhere else on the page and go for a proper logo bar. Your One Profile adapts to every fan is great copy. Your sub-copy kind of dilutes, like opinionated by design should be its own callout. That's a completely different feature that should only be talking about the adaptive routing and stuff and then handling all the optimization and stuff. So explain that there. And then what I would love to see is like one of those scrolling tricks where like instead of seeing one phone, I see a carousel of phones and each phone has a different mode on it, and it matches our actual notifications mode, our tip mode, our tour mode, and our contacts mode. And I wanna see each of those separately in a carousel. And then as I scroll, I want it to shift, like rotate through the carousel through like three of the core features. And then once it goes through that, it keeps scrolling. And then you have to tighten up the pills and stuff because they're not matching accessibility standards. And then in that footer, that footer copy could be tightened. It doesn't really make any sense. And then why do the call to actions have different Text on them, they should all be the same, so in that footer CTA. The header is fine, but the footer CTA needs to change, and then all of the border radius on buttons should be identical. It looks now like the ones you have in the primary CTA and the floating CTA don't match the one in the header. Everything should be the same. It feels cheap as shit if you don't do that. And then generally, we need some tighter spacing. And then this carousel at the bottom is cool, but like, it's not showing anything valid, so I would feature flag that off for right now. And then we'll revisit turning it back on once we've seeded like 10 profiles. And then in the footer, completely remove that dark mode toggle, we don't need that bullshit. And then clean up that footer to be more design token usage and cleaner. The visual hierarchy does not exist at all on the text and the fonts. They all need to be cleaned up, and that needs to be super minimal and non-distracting. And then it needs to be, I want that floating CTA to land somewhere where it looks designed. So, you know, if it, if you basically, I don't know, you just have to move it so it's not overlapping any content, and there's no, like right now because you have that divider on the footer, it sits weirdly on that divider. It needs to feel like it's a designed position when it finishes. I'd also tighten up the copy underneath it. I don't even know if we need that copy. That can, like that, your profile is live at whatever, can maybe just go away and is not needed at all. And then I generally think there's still room to tighten up the design on that floating claim banner. And then there's still some large gaps spacing wise that need to be addressed. And overall, I think some things could be finessed, like the free forever, no credit card could probably be smaller font. A lot of the fonts look like they could be tightened up and stuff. You know, we should pull actual design tokens. Then if I'm on a login page, that primary CTA or primary login method should be a primary color. Right now, they're both gray. I would make the primary CTA a primary color. On sign up, this sub copy doesn't need to be there at all. The only thing I would maybe put there is a CTA if we pass along a username param, then maybe we should display that param just to be like, you know, blank is still available, claim it now, or create your account to claim it now. And then tighten up the rest of this. It still looks kind of wonky with the disclaimer font and the already have an account placement. It's just weird. The whole thing needs to be tightened up. The logo across all these auth pages is way too big and should be much smaller and consistent sizing with what we have on loading screens. And then, signing you in, there's this weird spinner that does not match placement at all of anything else, doesn't match our logo. It should just be the normal logo that we use on the, like, loader screen. It's creating layout shift. It's flickering. It's ugly as fuck. And then when you get to an actual page, the install banner that we have right now for Jovi install for the PWA looks great. Maybe tighten up the button a little bit, but otherwise it looks great. We should adopt that same exact styling for toasts as well because it looks much cleaner and it's got much more depth and hierarchy to it. It does look like the PWA installation is actually working now. I'm curious if there's any way you can hide the system bar or style the system bar on Windows. It looks whack. On our header inside of our app shell table, or like all the tables, we have like the breadcrumbs and stuff. There should be a border-b underneath that header. It does not currently exist. Needs to. When I load any kind of release on the sidebar, the track list has a weird loader on it. Again, we need to kill all these weird specialized loaders that have flicker and stuff on them, which means generally we should just do an overhaul and audit for skeleton loaders across the board, because these should all be skeleton loaders. For some reason, when I open a sidebar on Windows, it's flickering the whole sidebar, then it loads content, then it loads track list after that. Like there's a whole waterfall sequence. That needs to be addressed that it loads faster and that there’s no layout shift on that when I hover those items. I have a nice hover states when I go to any links on the sidebar, the links are already have a hover state background even when they’re not being covered so that should not be the case unless it’s covered the refresh button. It has a weird styling to it. It doesn’t match the plus next to it. they should be identical and I would maybe make that plus button like a button with a drop-down toggle Chevron thing to the right of it that creates a drop-down menu and then put the refresh there to hide it. I don’t know why it says distribution and then DSP links over on it that’s redundant as fuck for some reason label names get truncated even when there’s plenty of space that needs to be addressed the canvas drop-down venue doesn’t seem to be matching styling of other things you have the duration count Spotify logo thing that looks like it’s supposed to be some kind of a play bar, but doesn’t seem to functionally do anything figure out what the fuck’s going on there I would for the lyric action buttons underneath it do the same thing with a Chevron button where it’s like a copy lyrics and then that feels like a little Chevron and then put the rest of the shit under there to clean it up. Also, all of our drop downs seem to be not properly rendering designed tokens. They have like weird background colors and seem to be a little contrast that all needs to be audited I would feature flag off the interface theme toggle for now and just not let people even go to light mode. The touring page should still be freestyle to have a connect button, not just like inputs and stuff the contact sidebar for contacts in the settings. Page doesn’t seem to be utilizing the same layout and functionality as other side bars so that needs to be addressed. There’s some weird flickering on the Music links page with another weird spinner. The ad pixel page seems to have cards within cards that whole screen needs to be factored properly utilize the design across the setting pages. It seems like there’s inconsistencies in the headers like audience has no padding above the header or no top margin and then other pages do that all needs to be consistent. Admin settings should be moved to an admin category that exists in the settings page and that’s where there should be toggles for the waitlist settings and campaign targeting settings and throttling an anti-spam settings can all be moved there as well and taken out of the campaigns page. When I hit the creators page I full frame flashing this is on PWN Windows begin on the weightless page. I have a card within a card. We should just audit across all the pages for card within a card styling dashboard is registering MRR for users you are paying, but using coupons it should correctly reflect with the actual revenue to the company is not what the plans are so that calculation needs to be net revenue not a gross calculation off of the subscriptions again I still don’t have a copy button for session ID from chats should be included in the drop-down menu under each thread item and that needs to also be in the header so instead of a copy button that I have… Drop down with a thread and a copy session ID and then on the audience page maybe maybe move the metrics for the funnel into a side bar and right next to the right drawer side bar icon put like an analytics button and that could just open in a sidebar. That would be you know if the right drawers open for a contact and you click that it would change the right Jar to be analytics and then vice versa and then that should be styled to match all the right drawers and then do a vertical design showing a vertical funnel with your top funnel all the way down to your bottom and clean that up the profile progress indicator could be smaller that match design and should probably be wider gray or something. Some of this stuff is probably already in flight so I would check open PR‘s and check Linear issues and then I would go and combine this into a general plan batch issues and create issues and make a plan and then present that to me and I will open it in Clough code and then also on some of the settings with the disconnect and the end sessions buttons. They’re just text and not buttons they should be properly formatted Apple Music. I have a sync a disconnect Spotify I just have a Sync music links on the settings. Also should include other DSP’s below it in a separate section for the non-primary disabuse, which would be Apple Music and Spotify and then again in the release this page the Spotify and Apple Music badges are different than the ones in the settings like the Spotify one doesn’t have… Drop-down it just says a refresh button and then when you refresh it, the refreshing loader is flickering like crazy and doesn’t match our theme again there’s a Loud shift when I open a release and I see the loading up the analytics and then I just did a refresh and I got a crazy failure toast that is not user-friendly and anyway and it’s design and so we need to address both the actual issue and the design of that toast and the other handling so it’s not spitting this long string to public to users. None of that should be visible to users and then I also need to include any open Sencherey issue or any open Linear issue issue that was created by Sencherey needs to be addressed and prioritized. I need all of this stuff put together into a giant list and then we’ll open up Linear issues and we’ll put them all as priority in a codex to them.

---

## Assistant

### Extracted Issues List

1. Smart link demo on homepage missing album art.
2. Smart link demo links not visible (contrast issues and incorrect styling vs. actual smart link page).
3. Smart link demo does not match real smart link page design.
4. “Automatic links, instant notifications” section does not explain instant notifications.
5. “Automatic links” should be renamed to “Smart links.”
6. Background demo shows two demos (Spotify connection + smart link) and should be simplified to a releases table.
7. Move desktop demo lower and overlay smart link callout on top.
8. “One Profile adapts to every fan” phone mockup should move above copy and tighten layout.
9. Move logos into a proper logo bar elsewhere on page.
10. “Opinionated by design” should be its own callout focused on adaptive routing and optimization.
11. Replace single phone with scrolling carousel of phones (notifications, tips, tour, contacts modes).
12. Carousel should rotate through core features on scroll.
13. Pills do not meet accessibility standards.
14. Footer copy needs tightening and clarification.
15. Footer CTA text inconsistent with other CTAs.
16. All CTA text should be identical.
17. Button border radius inconsistent across primary, floating, and header CTAs.
18. Spacing across page needs tightening.
19. Bottom carousel should be feature-flagged off until seeded with ~10 profiles.
20. Remove dark mode toggle from footer.
21. Clean up footer with proper design token usage.
22. No clear visual hierarchy in typography; fonts need cleanup and minimalism.
23. Floating CTA overlaps divider awkwardly; needs designed resting position.
24. Floating CTA supporting copy may be unnecessary.
25. Floating claim banner design needs refinement.
26. Large spacing gaps throughout site.
27. “Free forever, no credit card” font too large.
28. Fonts generally need tightening and consistent design token usage.
29. Login page primary CTA should use primary color (currently gray).
30. Sign-up subcopy unnecessary.
31. If username param exists, display availability CTA.
32. Auth page disclaimer and “already have an account” placement misaligned.
33. Auth page logo too large; should match loading screen sizing.
34. “Signing you in” spinner mismatched, causes layout shift and flicker.
35. Replace spinner with standard logo loader.
36. PWA install banner styling good; adopt same styling for toasts.
37. Investigate styling or hiding Windows system bar in PWA.
38. Missing border-bottom under header in app shell tables.
39. Release sidebar track list uses inconsistent loader.
40. Replace specialized loaders with consistent skeleton loaders.
41. Sidebar flicker and waterfall loading on Windows.
42. Sidebar links show hover background when not hovered.
43. Refresh button styling inconsistent with plus button.
44. Consider dropdown + chevron on plus button and move refresh inside.
45. “Distribution” and “DSP links” labeling redundant.
46. Label names truncate despite sufficient space.
47. Canvas dropdown styling inconsistent.
48. Duration/Spotify logo element resembles play bar but non-functional.
49. Lyrics action buttons should consolidate under chevron dropdown.
50. Dropdowns not properly using design tokens; background/contrast inconsistent.
51. Feature-flag off interface theme toggle (disable light mode).
52. Touring page should have connect button, not just inputs.
53. Contact sidebar layout inconsistent with other sidebars.
54. Music links page flickering spinner.
55. Ad pixel page has card-within-card design issue.
56. Settings page header padding/margin inconsistent (e.g., Audience).
57. Move admin settings to dedicated admin category in settings.
58. Move waitlist, campaign targeting, throttling, anti-spam toggles into admin.
59. Creators page full-frame flashing on Windows.
60. Waitlist page card-within-card issue.
61. Audit all pages for card-within-card styling.
62. Dashboard MRR calculation incorrect (should reflect net revenue after coupons).
63. Missing copy session ID button in chats.
64. Session ID copy should be in dropdown under thread and in header.
65. Audience funnel metrics should move to sidebar with analytics toggle.
66. Analytics sidebar should match other right drawer styling.
67. Funnel should be vertical visual design.
68. Profile progress indicator too large; adjust styling.
69. Review open PRs and Linear issues.
70. Combine into general plan and batch issues.
71. Settings “disconnect” and “end sessions” should be buttons, not text.
72. Apple Music has sync + disconnect; Spotify only has sync (inconsistent).
73. Music links settings should include non-primary DSP section.
74. Release page Spotify/Apple badges inconsistent with settings.
75. Refresh loader flickers and mismatches theme.
76. Layout shift when opening release analytics.
77. Refresh causes failure toast with raw error string exposed to users.
78. Improve error handling and toast design.
79. Audit and prioritize any open Sentry issues.
80. Audit and prioritize any open Linear issues created by Sentry.
81. Consolidate all into prioritized plan for Linear and Codex execution.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
