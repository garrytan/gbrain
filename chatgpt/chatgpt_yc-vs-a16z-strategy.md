---
title: "YC vs A16Z Strategy"
type: guide
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69ebdbde-1600-83e8-aed4-700efa438e1c
message_count: 5
tags: [chatgpt, import, code, long-form]
---
# YC vs A16Z Strategy

> Conversation ID: 69ebdbde-1600-83e8-aed4-700efa438e1c
> Created: 2026-04-24T21:08:49Z
> Updated: 2026-04-24T21:16:28Z
> Messages: 5

---

## User

Okay so here's where we're at: $1,200 in the bank for Jovie, out of the $25k we raised starting December 15th. We raised one check, an angel check, just to start the company. We have not started raising an actual round yet. The hope was that that would get us into YC and build enough that we could prove execution and get into YC. Now the product is built but in all honesty I'm learning as I go here so there are a lot of things that are on-site stable and we're knocking them out. Our shipping iteration is faster and faster every day and we're getting better and better and better at everything and new models keep coming out that are compounding everything. We're just shipping faster and faster. We found a huge breakthrough in design quality in the last two days with a combination of some internal techniques and then also some new design tools like Claude Design, which came out last week. Moving to the 5.5 model of GPT was huge.

So the product exists but some things are kind of broken and stuff. It exists. Here's the basic situation: I have to get the YC application in. The only thing I'm waiting on is the actual product demo. I've been afraid to film the demo because some things are just kind of janky but I can write the bullets and do that today or tomorrow.

Now I'm actually looking at A16Z and I think we'd actually benefit better from going to A16Z than YC at this point to be honest. In an ideal world we'd just do both but A16Z speed run also won't buy two.

That's where we're at with the company that we have. We have $1,200 in the bank. It's Friday, April something. April 24th. YC deadline is May 4th. I have to go to a wedding so I'm leaving on Thursday and coming back on Tuesday. I think ideally this is all done before I leave. I've probably got half my day burnt tomorrow and half my day burnt Sunday on non-work-related things. I've got to get a haircut and do a couple of other things so time is limited over the next couple of days. I am pulling crazy hours so I'm trying to figure out what makes the most sense right now to lock in here.

It's basically going to have to be, okay and so a huge thing. I have a lot of content that is ready to go and be deployed on to Twitter. I have a lot of content for LinkedIn and for threads, all of which can drive traffic to Jovie. All of those people are investors and stuff. A lot of those people are music people and everything so it'll be a good idea to start dropping this stuff; however, I'm generally scared to drop it for two reasons:
1. Crappy design homepage and crappy artist profiles. Fixing both of those right now so I'm probably going to spend the rest of my afternoon on that and then I'd probably be cool to turn on and go to market engine.
2. Still a little unclear on
 Okay so basically I need to figure out what to do right now to make sure that the company isn't just going to die. That means we need money and I'm also not even paying myself a salary right now so I need cash. Help me think about that and what my priorities should be.
- I can finish a pitch deck, which would probably take me an hour.
- I can finish the homepage design and the profile designs so they look slick for the demo, which would probably take me two hours.
- I can turn on go to market.


My big question is: would it be better for me to just throw up a wait list and just waitlist people at this point? Is it a better idea to just be, like, you know what I'm saying? Would it be better to just turn on a waitlist and then just go ham on go to market right now and just get attention and not even try to get users and then raise money and then go keep building and let users in or should I be letting users in? You 

---

## Assistant

Mr. White, I’ll treat this as a survival-prioritization problem: cash runway, fundraise probability, YC/A16Z optionality, and whether GTM should drive waitlist or active users.

---

## Assistant

Mr. White: **turn on a waitlist now, but do it with selective access.**

Your priority order:

1. **Today: finish homepage + artist profile polish.**  
   Two hours to remove obvious jank is worth it. It increases demo quality, investor confidence, and conversion.

2. **Today/tomorrow: launch GTM to a waitlist, not fully open product.**  
   Position it as: “We’re letting in artists, managers, and music teams in waves.”  
   This gives you demand, emails, social proof, and investor heat without forcing you to support a fragile product for everyone.

3. **Let in handpicked users manually.**  
   Do not keep everyone out. Pick 5–20 high-signal users who can give testimonials, screenshots, usage, intros, or credibility. Treat them like concierge beta customers.

4. **Finish YC application before leaving Thursday.**  
   YC’s on-time deadline is **May 4 at 8pm PT**, with decisions by **June 5**. Submit even with an imperfect demo. The demo should show the core magic, not every edge case. citeturn946190search0

5. **Apply to a16z speedrun after YC submission.**  
   a16z speedrun SR007 closes **May 17 at 11:59pm PT**, so you have more time. It offers up to **$1M** and runs July 27–Oct 11. citeturn946190search1turn946190search3

6. **Deck: do the 1-hour version only.**  
   You need a usable deck for angel/pre-seed conversations. Do not over-polish it right now.

The strategic answer: **waitlist + controlled beta beats open launch.**  
Open launch creates support burden and reputational risk. Pure waitlist creates no proof. Controlled beta gives you the best of both: attention, scarcity, proof, and product learning.

Suggested next 72 hours:

**Friday**
- Polish homepage/profile.
- Add waitlist CTA.
- Create “request access” flow.
- Draft YC bullets.

**Saturday**
- Film rough demo.
- Finish YC application.
- Start posting content.

**Sunday**
- Ship more content.
- DM warm investor/operator/music contacts.
- Let in first beta users manually.

Your immediate goal is **convert attention into evidence**:
- waitlist count
- credible signups
- artist/manager interest
- beta usage
- screenshots/demo
- investor conversations

Do not wait for perfect. Make it look credible, constrain access, generate demand, and use the demand to raise.

---

## User

Okay, anything that is code heavy, we'll run an agent on in cloud code. So that's gonna be like the waitlist configuration, stuff like that. Whatever metrics you need, that needs to be added to the current metric dashboard, and it should be revised, not added to. So we should clean up the dashboard so that it just has the metrics that matter in a clean, concise dashboard right there, so it's obvious, so I can use that for everything. And so give me the prompt for the code right now. I want exactly what code I need to put into Joby right now for the waitlist.

---

## Assistant

Mr. White, paste this into Cloud Code:

```text
You are working in the Jovie codebase.

Goal:
Ship a lightweight waitlist + controlled beta access system immediately, and revise the existing metrics dashboard so it shows only the metrics that matter for fundraising, YC, and product launch decisions.

Do not overbuild. Use existing app patterns, components, styling, analytics, database, auth, and dashboard conventions wherever possible.

Core product behavior:
1. Replace or supplement the main homepage CTA with:
   - Primary CTA: “Request Access”
   - Secondary CTA where appropriate: “See Demo” or existing product flow if already stable.
2. Add a waitlist/request-access flow.
3. Users should be able to submit:
   - name
   - email
   - role: artist / manager / label / investor / fan / other
   - artist or company name, optional
   - website/social link, optional
   - what they want to use Jovie for, optional
   - referral source, optional
4. After submit, show a polished confirmation:
   “You’re on the list. We’re letting people in gradually and will reach out if you’re a fit for early access.”
5. If user is already logged in, prefill known name/email where possible.
6. Prevent duplicate emails. If the email already exists, update the existing record with any new fields and refresh submitted_at / last_seen_at.
7. Store source attribution:
   - landing page URL
   - referrer
   - UTM params: utm_source, utm_medium, utm_campaign, utm_content, utm_term
8. Create a clean admin/internal view for waitlist submissions if one does not already exist.
9. Add simple status management:
   - waitlisted
   - invited
   - active
   - rejected
   - duplicate
10. Add notes field for internal use.
11. Add ability to mark someone as invited / active manually from the admin view.
12. Gate unstable product access if there is already a clear product entry point:
   - Default public users go to request access.
   - Invited/active users can access the product.
   - Do not break existing authenticated/internal/admin users.

Database:
Create or update a waitlist table/model with fields roughly:
- id
- email unique required
- name
- role
- artist_or_company_name
- website_or_social
- use_case
- referral_source
- status default waitlisted
- internal_notes
- utm_source
- utm_medium
- utm_campaign
- utm_content
- utm_term
- landing_page_url
- referrer
- submitted_at
- last_seen_at
- invited_at
- activated_at
- created_at
- updated_at

Use the existing database migration system. Keep naming consistent with the repo.

Analytics/events:
Instrument these events using the existing analytics system:
- waitlist_viewed
- waitlist_started
- waitlist_submitted
- waitlist_duplicate_updated
- waitlist_error
- access_invited
- access_activated

Include properties:
- role
- source/referrer
- UTM params
- page path
- authenticated boolean

Metrics dashboard:
Revise the existing metrics dashboard. Do not add another cluttered dashboard. Clean up the current one so it focuses on these metrics only:

Top-level cards:
1. Total waitlist signups
2. New waitlist signups last 24h
3. New waitlist signups last 7d
4. Invited users
5. Activated users
6. Waitlist → invited conversion %
7. Invited → activated conversion %
8. Product/demo CTA clicks if already tracked, otherwise omit until implemented cleanly

Breakdowns:
1. Signups by role
2. Signups by source / UTM source
3. Signups by day for the last 14 days
4. Top website/social links or artist/company names, if available
5. Recent high-signal signups:
   - investor
   - manager
   - label
   - artist with website/social link

Dashboard design requirements:
- One clean screen if possible.
- No vanity clutter.
- Prioritize fundraising usefulness.
- Use existing UI components.
- Make it screenshot-friendly.
- Show empty states cleanly.
- Do not show broken charts.
- Do not add metrics that require unreliable data.

Implementation standards:
- Use server-side validation.
- Validate email.
- Handle errors gracefully.
- Avoid exposing admin data publicly.
- Add loading states.
- Add success states.
- Add basic tests if the repo already has a test pattern.
- Keep code simple and shippable today.
- Do not introduce large new dependencies unless absolutely necessary.

Acceptance criteria:
1. A public visitor can request access from the homepage.
2. Submission persists correctly.
3. Duplicate email does not create duplicate records.
4. UTM/referrer/source data is captured.
5. Admin/internal user can view waitlist submissions.
6. Admin/internal user can change status to invited or active.
7. Current metrics dashboard is revised into a concise waitlist/fundraising dashboard.
8. Dashboard numbers match database records.
9. Existing product/admin access is not broken.
10. The app builds and passes existing checks.

After implementation:
- Summarize exactly what files changed.
- Include any migrations created.
- Include any environment variables needed.
- Include how to test manually.
```

Use this as the homepage copy:

```text
Jovie is opening early access to selected artists, managers, labels, and music teams.

Build, launch, and manage your artist presence with AI-native tools designed for modern music teams.

Request access now. We’re letting users in gradually while we finish polishing the product.
```
