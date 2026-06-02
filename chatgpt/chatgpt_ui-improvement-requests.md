---
title: "UI Improvement Requests"
type: essay
created: 2026-02-26
updated: 2026-02-26
source: chatgpt-export
conversation_id: 699fba7e-2628-8332-ae82-d94576c497cb
message_count: 4
tags: [chatgpt, import, long-form]
---
# UI Improvement Requests

> Conversation ID: 699fba7e-2628-8332-ae82-d94576c497cb
> Created: 2026-02-26T03:19:13Z
> Updated: 2026-02-26T03:33:30Z
> Messages: 4

---

## User

I'm gonna list out some issues. I just want them back in bullet points. Find out why it is that the cookie banner is still displaying for me when I'm in California and I'm not in Europe. If it's not illegally mandated that it be visible, I don't wanna see it. It should be using the Versal Edge configuration to determine my geolocation, figure out what country I'm in, and no one in the United States should be seeing this banner. Make it go away, please. Make sure that people in countries that legally require it see it, but I don't wanna see it. I don't wanna see it in California. on the login page, don't have an account, create an account. And then I also see don't have an account, sign up. So I don't know why I see two of those. I should only see one. It should make sure it's the right one. I see the, you used Google last time hit. Now that we've moved down to two platforms, that's irrelevant. Just get rid of the resorting and all of the functionality of resorting methods on login page and signup page. Should just have Google and continue with email and remove all this extra crap. Sign up with Google or email in seconds and make it unmistakably yours. Kill that. I don't need that. Go back to just having the get your account and then also on the signup page, I again now have already have an account, sign in twice. I do need the terms is good, but that bottom extra sign in does not need to exist. And then on the signin page, never mind on that one. Okay, so then I go and I sign up. And I see a loader with a white Joby logo. I would love if that could be like more of a gray or something or a little bit more faded or something. Maybe have like a little 3D effect on it or something. Just look cooler. And that loading text underneath it on that loader that just says loading dot dot dot. I'd love that to be a little bit cleaner. All sidebars looking a lot better. Go to the releases page. Releases badges are a little bit better. They're now rounded. I think they should be rounded less, more subtle corners, and much, much smaller icons. I would also move the popularity score to the right side so that it goes smart link popularity score year. I'd also put the artist name underneath the track title, and that is important, especially with DJs, because a lot of these songs are going to be collabs, and so we need to see those. I'd also open an issue for the future where if you click on an artist name that's not your artist, or actually, if you click on an artist name in general, it would open up a filter for artist and just filter it for that artist, and that would also require us to add an artist filter, which we don't currently have. So I would do that. Let's feature flag the display menu off entirely. There's really no need for it at this time. Let's make sure that search always shifts the input to the search box no matter what page we're on. On the audience page on local, at the least, I'm seeing a crash. It's not loading at all. Cannot read properties of undefined reading ID. So let's fix that. And also the sidebar icon on audience is large. Those sidebars need to be consistent across the board. Admin overview has overscroll still. I don't know if there's a fix for that out, but also admin dashboard chart is black on black. Needs to be fixed. Waitlist. There's a bunch of waitlist settings. I'm thinking it might make sense for settings for us to add admin settings as a section under artist settings in the settings page. And then we could move, have a waitlist page and move those settings to proper settings cards in the waitlist so that that's not cluttering up the waitlist because those settings don't need to be as accessible. Let's make sure for the waitlist that we kill feature flags related to the waitlist so that it's only controlled by the waitlist gate setting in the admin. And let's make sure that if I manually accept a waitlist user, even if they're over the daily limit, that they still get accepted. Let's make sure that the settings are actually saving for waitlist gate and auto-accept, which currently doesn't seem like they are. The settings should autosave when I change them. And we should have test coverage for those that catches that kind of problem. Let's make sure that that's all good. We should also generally just do an audit for the whole waitlist to make sure that there's no problems with it. That should be a separate issue, a thorough audit for it because we're about to go live with it and that can't be broken. On the creators table, I think we already have an issue for migrating that to the new search thing, so I'll ignore that. But I will say that the creators table has like a border that makes it look like the table is not using the same component as everything else. I'm also seeing oversized sidebar icon for all the admin pages. Again, this list should be checked against existing open issues so I don't duplicate. Activity feed is like boxed within a box. Fix that. Anytime I click on... No, sorry, this function. Okay. Music DSPs. I'm still only seeing Spotify and Apple Music anywhere. I don't know what's up with the other DSPs. They need to be there. And for those DSPs, when we list them in the sidebar, I would list them the same way we list social links. I wouldn't use the pills here. I'd list them the same way we use social links. And I'd give them a little ellipsis action menu to disconnect them or to refresh them. My Venmo is set, but I don’t see it on the Ern tab that should be there and be displayed the same way as the social links are I should be able to copy it or delete it. I might do some helper copy for social Lynx to kind of describe that visibility is set automatically and not by them just so it’s clear that like these might not show up on your profile they may show up on your profile you know same thing with music DSP’s website I would remove that for now and just put it under social links. I’d probably add a setting stab and move the allow photo downloads to the setting tab on that sidebar for the user profile. If you’re verified, you should see the verified badge in the profile, I’d maybe not let them Editor handle on the profile details and force them to go change it in the settings. It’s a little too easy to change that and that’s like that’s a big change. I’d also probably put it behind a confirmation model in the settings at least so people don’t accidentally change their handle cause that can have bad effects. I don’t think you need the sidebar toggle. If we have the close button on the drop-down we only need the sidebar toggle when the side bar is closed copy session ID should probably move to an Action‘s menu along with the delete thread and those should be the same menu that you see on the threads in the sidebar also Wright clicking any item in the sidebar or at least any thread should open up that items action menu and that should be true also of like the profile action menu and just any item in the ava in the future that might have actions for it should have an action menu. That’s also opened up as a context menu when you right click send feedback. I might consider moving to the learn more menu. I’d consider moving settings down below manage billing or just consider ordering that menu more intelligently maybe it’s optimized already I don’t know but it’s worth considering my dashboard is currently seeing Sencherey metrics require token and Sencherey for slug. I think we do have a set in Doppler, but this hasn’t hit production yet, so I don’t know if it works or not. Generally, the admin overview I would clean it up a little bit. I don’t need all this information. I don’t even need the activity feed there. I already have a separate activity feed. I just really wanna know how many profiles are. I really wanna know I really want to know like a ride up top. I mean I guess you kind of got it with these four metrics I would just maybe tighten it up clean it up there’s a lot of crap that I don’t really care about. I don’t need to know my P90. I don’t know. Maybe I guess the chart I mean I guess I guess it’s relatively good to get rid of the activity feed and then just clean it up tighten it up make it more modern move the labels underneath the metrics the company health banner maybe move it below the core matrix as like a more compact batter it’s like occupying a lot of space for a little bit of information generally clean it up and make the page she used designed tokens and just look good. Seems that every time I toggle dark mode I get a focus ring around some piece of at least if I’m in the main Content area and I toggle dark mode. All of a sudden I get a focus ring on it that should not be the case audience loads down and then crashes. We already have that though there’s no disconnect button on the Apple Music pill and releases tab and then there’s no disconnect button on the Spotify one on the drop-down menu they both should have a drop-down mini Spotify one currently just has a button where the Apple Music one has a drop-down menu, even though the only option to sync those pills with those drop-down menus should be exactly how they are displayed in the other locations that they displayed like in the settings let’s go look at a public profile now again cookie banner does not need to show up on a public profile in the US. I’m on a local machine right now in my public profile is not loading at all. Not sure what that’s about. I’d also on the cookie batter and make sure it’s not UI blocking in any way like if that’s not accepted it shouldn’t break the system or anything also can analytics in marketing beyond by default in the cookie preferences I don’t know how that you know works and stuff but if it’s legal to do it that way, let’s do it that way if it’s not legal to do it that way let’s not do it that way, but let’s turn it on for any location that doesn’t require explicit consent if any of these issues are already addressed by open PR’s they can safely be ignored. If any of these are quick wins they should be addressed immediately if any of these require thorough investigation or planning then a linear issue should be open for them.

---

## Assistant

- Investigate why the cookie banner displays in California (U.S.).  
- Ensure geolocation uses Vercel Edge configuration to determine country.  
- Hide cookie banner for all U.S. users unless legally required.  
- Ensure cookie banner only displays in countries with legal requirements.  
- Ensure cookie banner is non-blocking and does not break functionality if not accepted.  
- Enable analytics and marketing by default where legally permitted; require explicit consent where required.  

- Remove duplicate “Don’t have an account” CTAs on login page (keep only one correct version).  
- Remove duplicate “Already have an account, sign in” on signup page (keep only one).  
- Remove “You used Google last time” messaging.  
- Remove all resorting logic and extra authentication methods on login/signup pages.  
- Limit auth options to: Google and Continue with Email only.  
- Remove “Sign up with Google or email in seconds and make it unmistakably yours.”  
- Revert to simple “Get your account” messaging.  

- Update signup loader:  
  - Make white Jovie logo more subtle (gray/faded or slight 3D effect).  
  - Improve “Loading…” text styling to be cleaner.  

- Releases page:  
  - Reduce badge corner radius (more subtle rounding).  
  - Make release icons significantly smaller.  
  - Reorder columns to: Smart Link → Popularity Score → Year.  
  - Move artist name under track title (important for DJ collabs).  
  - Create future issue: clicking artist name filters by that artist.  
  - Add artist filter (currently missing).  

- Feature flag off the display menu entirely.  
- Ensure global search always focuses the search input from any page.  

- Audience page (Local tab):  
  - Fix crash: “Cannot read properties of undefined (reading ‘id’).”  
  - Standardize oversized sidebar icon.  

- Ensure sidebar icon sizing is consistent across all admin pages.  

- Admin overview:  
  - Fix overscroll issue.  
  - Fix black-on-black chart in dark mode.  
  - Remove activity feed from overview.  
  - Tighten layout and modernize UI.  
  - Move metric labels underneath metrics.  
  - Make company health banner more compact and move below core metrics.  
  - Remove unnecessary metrics (e.g., P90 if not essential).  
  - Ensure design tokens are used consistently.  

- Waitlist:  
  - Add Admin Settings section under Artist Settings.  
  - Move waitlist settings into proper settings cards.  
  - Remove waitlist feature flags; control solely via admin waitlist gate setting.  
  - Allow manual acceptance even if over daily limit.  
  - Fix waitlist gate and auto-accept settings not saving.  
  - Autosave settings on change.  
  - Add test coverage for waitlist settings persistence.  
  - Open separate issue: full waitlist audit before launch.  

- Creators table:  
  - Ensure consistent table component styling (remove mismatched border).  
  - Check against existing migration issue to avoid duplication.  

- Activity feed:  
  - Remove boxed-within-box layout issue.  

- Music DSPs:  
  - Investigate missing DSPs (currently only Spotify and Apple Music visible).  
  - Replace DSP pills with list-style display (like social links).  
  - Add ellipsis action menu (disconnect, refresh).  
  - Ensure consistent dropdown menu behavior for Spotify and Apple Music.  
  - Add disconnect options where missing (Apple Music pill, Spotify dropdown).  

- Earn tab:  
  - Display Venmo like social links (copy + delete options).  

- Social links:  
  - Add helper copy explaining automatic visibility logic.  
  - Move Website under Social Links.  

- Profile settings:  
  - Add Settings tab to profile sidebar.  
  - Move “Allow photo downloads” into Settings tab.  
  - Display verified badge on profile if verified.  
  - Prevent handle editing in profile details; require change via Settings only.  
  - Add confirmation modal before handle change.  

- Sidebar behavior:  
  - Remove sidebar toggle if close button already exists.  
  - Only show sidebar toggle when sidebar is closed.  
  - Move “Copy Session ID” into actions menu (same as delete thread).  
  - Standardize action menus across threads and profile.  
  - Enable right-click context menu for threads and future actionable items.  

- Navigation/menu cleanup:  
  - Consider moving “Send Feedback” into Learn More menu.  
  - Consider reordering Settings below Manage Billing (evaluate menu hierarchy).  

- Dashboard errors:  
  - Fix “Sentry metrics require token” and “Sentry for slug” errors (verify Doppler production config).  

- Dark mode:  
  - Fix unexpected focus ring appearing after toggling dark mode.  

- Public profile:  
  - Ensure cookie banner does not show for U.S. users.  
  - Fix public profile not loading on local machine.  

- General:  
  - Check all items against existing open PRs before duplicating work.  
  - Address quick wins immediately.  
  - Open Linear issues for items requiring investigation or planning.

---

## User

Okay, batch 2. When I start typing, as soon as I put a letter into the inbox for the handle claim, I get layout shift. And it looks pretty bad. Also, the your profile will be live at chovi slash your profile is left aligned, and it looks kind of weird. I feel like it should be center aligned. As is the checking availability and the handle must be at least three characters. I don't really want them to jump around, so they probably should be left aligned, but their container should be centered or something like that. I don't know, but like optically it looks whack right now and cheap. I also have a loader inside the input and then a loader inside the call to action button, and the call to action button says checking dot dot dot. It's also not, it's very slow and this is the homepage call to action. It has to be performant and it can't be blocking. You should be able to continue right away. We can't have any issues there. Also, if we're moving to signing up with a username, does it make sense for our auth flow on our Create Account page, if we're passing along that CTA, or we're passing along that username they reserved, we should put, you know, your username is available on the Create Account page, somewhere cleanly and well-designed, so that we know that it moves along with them, if you know what I mean. So, you know, create that FOMO on that page to increase them completing the next step, you know what I mean? I want that to happen. Um, I also think, I'm thinking that availability checking on the handle on the homepage should maybe even be non-blocking. Um, and like this should be its own issue, um, to switch it to non-blocking, but like, you know. I don't want to be in a situation where a user... Come here, Suki. Suki, no, no, no, no. No, Suki, no. No, no, no. Suki, no. Um, I don't, no, Suki. Suki. Suki. Suki. Um. Suki. You know me yelling at my cat. Um, Sooks, come on. Suki.

---

## Assistant

- Handle-claim input: typing the first character causes noticeable layout shift; fix to eliminate shifting/jank.  

- Handle-claim section alignment:  
  - “Your profile will be live at jov.ie/<handle>” is left-aligned and looks off; center-align visually.  
  - Status/helper text (“Checking availability”, “Handle must be at least 3 characters”) should not jump around.  
  - Keep status text left-aligned if needed, but center the container/overall block for better optical alignment.  

- Loading states/performance (homepage CTA):  
  - Remove redundant loaders (currently one inside the input and another in the CTA button).  
  - CTA button text “Checking…” + spinner feels slow; homepage CTA must be highly performant.  
  - Availability check should not block forward progress; user should be able to continue immediately.  
  - Investigate why availability check is slow (network, debounce, server latency, edge caching, etc.).  

- Auth flow continuity (username reserved on homepage → Create Account):  
  - If signup starts with reserving a username, pass that handle into Create Account flow.  
  - Display “Your username is available” (or equivalent) clearly on Create Account page, styled cleanly, to reinforce completion/FOMO.  

- Create a separate issue: switch homepage handle availability checking to a non-blocking flow (async validation that doesn’t stall CTA progression).


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_app-ux-flow-improvement]]
- [[chatgpt/chatgpt_bar-improvement-tactics]]
- [[chatgpt/chatgpt_bio-improvement-request]]
- [[chatgpt/chatgpt_ci-improvement-suggestions]]
- [[chatgpt/chatgpt_comment-improvement-with-snark]]
