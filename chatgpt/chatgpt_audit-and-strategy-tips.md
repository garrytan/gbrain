---
title: "Audit and strategy tips"
type: essay
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
conversation_id: 6897b11e-7664-8322-8ff5-df8c79949335
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Audit and strategy tips

> Conversation ID: 6897b11e-7664-8322-8ff5-df8c79949335
> Created: 2025-08-09T20:36:08Z
> Updated: 2025-08-09T21:43:01Z
> Messages: 8

---

## User

audit https://github.com/itstimwhite/Jovie 

Think about everything you know about our goals for Joby. Think about the problem that we're facing, our musicians are facing. One, in that these Lincoln Bio products just don't work because they don't convert, and then two, they don't make musicians' lives easier, and with all of the noise from hundreds of thousands of songs being uploaded every day, it's really important to have tools that help you stand out, and then finally, the automation of a lot of the manual processes in the back end, the unsexy parts of operations for the music industry, submitting songs to hundreds of different lyric sites, forums, you know, sync sites, there's, you know, emailing sync agents, emailing, you know, music blogs, emailing playlist curators, emailing music directors, trying to get your music played in gyms, you know, all these different things that are handled by different companies, and there's hundreds and hundreds of companies that you have to get in touch with every time you put out a song, hundreds and hundreds of bloggers, journalists, everything just down the line, DJs that you want to play your music, DJs that you want to remix your music, dancers that you want to dance to your music and make videos of, influencers, you want to use them in their TikTok videos, you know, cover artists that you want to cover them because when they cover them, you get publishing money, and it drives more stream to the original song. Just on and on down the list, you know, distributors distribute to, you know, a hundred DSPs, but they don't update any of the content on those DSPs. You have to go in and claim your artist profile on every single one of these DSPs, and oftentimes they don't even have an artist panel. They're not one of the big ones. You have to go in and manually email your photos to people and stuff. A lot of times you have to go into, like, the Korean DSPs aren't even in English, a lot of them, and so a lot of artists just don't have, you know, you go on, they don't, I mean, there's major label artists and legacy artists that don't even have control of their profiles on a lot of DSPs. Their photos aren't up-to-date and stuff. Their bios are out of sync, you know. They have all these different social media accounts that all have to be updated and stuff, and so we're looking at this, we're looking at how do you update music brands? How do you update all these things? How do you take control of your artist persona across all of the internet, keep everything up-to-date, and continually churn out content? Lyric videos, AI videos, I mean, you should have a music video for every song that's AI anime style. You should have a music video for every song that's AI sketch style, just auto-generated. You should have a lyric video for every song. You should have a visualizer for every song. You should have a video for every song that is Lego-themed built by AI, you know what I mean? There's no reason that artists can't just constantly be churning out content around their music and constantly be getting all sorts of creators to make different content around their music and do this stuff, and this is the kind of stuff that got me personally to, you know, 70 million user-generated streams on my first song, and this is the stuff that got me licensing deals with major labels and stuff, and this is stuff that people are not good at, and that there's no tools really handling, and so how do we do this in an Apple-friendly way at scale for people? How do we, you know, starting with this Lincoln Bio product? So kind of wrapping your head around all of that craziness and where we want to go in the future, and knowing, looking at our code base of what it currently is right now, let's have a brainstorming session. I like the way that Michael Seibel talks about building features at Twitch and at other companies, and what he says they basically do is they sit in a room with all the engineers and all the stakeholders in the company, sometimes even investors, and they just all spit out ideas, and they write all the ideas on the board, and no idea doesn't go on the board. Every idea goes on the board, so everyone feels hurt, right? And then what they do is they look at all the ideas, and they say, okay, how long, how difficult is this idea to implement? How long would it take us to build it? Would it take us a day? Would it take us an hour? Would it take us a month? Would it take us a year? Would it cost us anything? Then they say, how impactful would this idea be in terms of moving us closer to our KPI? In our case, our current KPI is MRR. We want to get to 10k MRR. That's our current goal, and our KPI is MRR. And then they say, they look at them, and they rank them by what is the one that's going to be, you know, the most impactful thing for our KPI that we can feasibly do, you know, in the short term. And there's like, people have like the quadrant system for this, like, you know, the medium tasks, but the high-impact, the high-cost tasks, but low-impact, and all that in the quadrants and stuff. We basically want to, you know, follow that principle to knock out all the stuff that we can to get us to our KPI. So let's do that right now. Let's have you and me, you, Chatshubt5, and me have a brainstorming session where we come up with all kinds of ideas for what we can do on these profiles to make them, to do on this product based on our current code, to get us towards our goal. I'll let you ingest everything I just said and take a look at the code base, and take a look at our previous conversations, take a look at our founders box accelerator application, so you kind of have an idea of where we want to go with the company. And I'll let you take a look at that, and I'll let you take the first stab at coming up with a list of ideas for features. And then once you do that, I'll fire back with my own list, and we'll just keep going back and forth building a big list, and then we'll sort of triage it.

---

## Assistant

Got it, Mr. White. I skimmed the repo and README—Next.js 15 + Supabase + Clerk (with optional Clerk Billing), Statsig flags, Spotify pull, Vercel deploys, tests (Vitest/Playwright). Live prod/preview look wired up; envs include Supabase/Clerk/Spotify/Statsig and optional Segment/Billing toggles. Good bones. citeturn1view0

Here’s a tight idea dump aimed at $10k MRR fast. I’m biasing to “ships in days, moves revenue/retention.”

### 1–3 day wins (ship now)
- **Claim-your-handle → Clerk → Artist-claim flow**: Replace home search with “claim your handle,” then auth, then pick artist (Spotify), prefill profile, publish `/[handle]`. [Low effort / High impact]
- **Pricing on day 1**: Free vs Pro ($12/mo starter). Gate custom domain, analytics depth, “Smart Buttons,” UTM campaigns. Use Clerk Billing’s pricing table toggle already suggested in README. [Low / High] citeturn1view0
- **Smart Buttons v1**: Reorder “Listen on …” per visitor (last click + UA heuristic). Persist in Supabase, A/B via Statsig. [Low / High] citeturn1view0
- **Tip Jar (flagged) → live**: Stripe link or lightweight Checkout; upsell: lower fee on Pro. [Low / Med] citeturn1view0
- **Release Link Templates**: 1-click “New Single” page preset (hero, pre-save, out-now variant). Pro gets more templates. [Low / Med]
- **Campaign Links + UTM presets**: Auto-append UTMs and show per-campaign CTR in dashboard. [Low / Med]
- **Auto-prefill assets from Spotify**: Pull artist image, latest release; fallback to clean placeholders. [Low / Med] citeturn1view0
- **“Featured Action” above the fold**: One giant primary (Play on X) with small “More options.” A/B via Statsig. [Low / High] citeturn1view0
- **Lightweight EPK page**: Toggle on profile: bio, press photos, links, contact. Pro-only. [Low / Med]
- **Copy-paste blocks**: “Linktree-import” (paste URL → we scrape major links) to reduce onboarding pain. [Med / High]

### 1–2 week bets (near-term revenue/retention)
- **Auto-Content Kit v1 (no AI infra yet)**: On “Add Release,” generate: square cover crops, vertical story card, 15-sec visualizer (FFmpeg + template), lyric poster PNG. Store in Supabase Storage; Pro unlocks hi-res. [Med / High]
- **Drops Schedule**: Simple scheduler that posts “Out Friday” countdown banners on profile; reminder email templates. [Med / Med]
- **Creator CTA block**: Public “Use this track” card with: download stems (or snippet), usage guidelines, #hashtag, “submit your video” form. [Med / High]
- **Pro Analytics**: Per-destination click-through, geo, device, campaign roll-ups; weekly email report. [Med / High]
- **Invite Manager/Team**: 1–3 seats on Pro. Clerk orgs or roles. [Med / Med]
- **Custom Domain + SSL**: One-click via Vercel; Pro-only. [Med / High]
- **“Collections”**: Group links (Tour, Merch, Collabs). Clean UI, minimal chrome. [Med / Med]
- **Email capture + Export**: Tiny subscribe box; CSV export; Zapier/Make webhook. [Med / Med]

### Bigger rocks (prove pull, then build)
- **Flows (Automation Engine v1)**: Event → actions. Example: “New Spotify release detected” → create release page → generate assets → email me a press kit → open “creator CTA” block. Implement as Supabase cron + queue; actions are internal webhooks you already control. [High / Very high]
- **Outbound Integrations (phaseable)**: Start with MusicBrainz update + YouTube description template + Twitter/X/IG captions export. Don’t promise closed APIs (Musixmatch/LyricFind) until licensed—ship “export packs” first. [High / High]
- **Creator Bounties (marketplace later)**: Post a $ bounty + rules; creators submit links; simple manual payout for now. Stripe Connect later. [High / High]
- **Playlists/Gym partner toolkit**: Unique share links, attribution, summary page for curators/venues. [High / Med]

### UX polish (fast)
- **Apple-clean profile**: Bigger hero image, single dominant action, sticky quick-open bar, skeletons for instant paint. [Low / Med]
- **Horizontal “featured artist” scroll-on-scroll**: Subtle parallax, no layout shift. [Low / Med]
- **Ultra-fast TTI**: Image CDN params, route-level caching, defer non-critical scripts; keep Lighthouse 90+. [Low / Med] citeturn1view0

### Growth levers (cheap tests)
- **Pro trial (14 days)** with a “content kit” carrot. [Low / High]
- **“Powered by Jovie” toggle**: Free shows badge; Pro removes. (You already mention this approach in your pricing thinking.) [Low / High]
- **Public gallery**: Opt-in showcase of best profiles; “clone this layout.” [Low / Med]
- **Referral**: Give $10 credit per referral; pay out only after first charge. [Low / Med]

---

If you want, I’ll turn this into an ICE list with rough hour/day/week tags and a suggested 2-week sprint plan. Or we jump straight to: **Handle-claim flow + Pricing + Smart Buttons + Tip Jar** as Sprint 1, then **Content Kit v1 + Pro Analytics** as Sprint 2.

---

## User

Okay, this is not a bad list of things. Some quick notes on it. I like the Linktree import as a growth strategy. I would hold off on doing something like that until... I mean, it's not a bad idea. And it's a good way to convert musicians who are on Linktree to a music-focused product. So I definitely think we'll use that. But I think that... I just want to hold off on that until we have paying customers, at least have the basic flow going. I think a basic analytics thing would be a good thing to display at the beginning. Just a very quick thing, but I really want actionable analytics. How many... I'd love to show it in a funnel, because I don't think a lot of people do that. I don't think a lot of people show things in a funnel. For example, how many people actually clicked my link, my Joby link? And how many people clicked through to a streaming service? Right. And in an ideal world, we'd be able to know how many of those converted to plays or presaves or something. But obviously we don't have that ability quite yet. But what's the minimal thing that we could implement in terms of analytics that's at least useful? I don't want to just do things to make people happy. I want to do things to make people money. I want that to be a core philosophy here. Kind of the renaissance periodization of tech here in that we're not doing things just because we think people will like them. We're doing things because people will actually make money. Because I think that if I can make musicians more money, they'll want to pay me more money for my products. You know what I mean? I'm trying to make musicians more money is the end goal here, and I don't want to do things just to do things. I do think auto-appended UTMs and per-campaign click-through rates, stuff like that, great. That definitely results in more money. Love that marketing angle on it. Lightweight EPK page I definitely think is something that we will include. I'm going to hold off on that for now, though. I think there's probably a world in which we have them connect to all the social media. In addition to a normal EPK, it also pulls in all their social content and stuff as a media kit, so they can use it both for booking gigs, but also for booking brand partnerships. Because there's a lot of crossover with influencers, and that opens the door if we decide that a creator market is a better market than a music market. I have a thesis that music might be the way to go, but we might find that comedians use this better, or we might find that actors use it better, or whatever. It's just influencers in general. I don't know. Auto-content kit definitely sounds like something we'll add in the future. Got to wait on that. I think pro-analytics is something we'll probably get into at some point. Not yet. Teams definitely is something we'll do, but I need users before I touch that. I don't want to touch Teams until I've got a significant number of users using the product. In fact, I probably wouldn't even touch the team manager accounts until customers are asking for them. Custom domains I don't think are a good idea, mainly because we want people using the Joby links. We want there to be a cool factor to having the Joby link. The email capture, I think we build into the universal notifications idea, and I do think that's a thing that I want to push for very soon, because I do think that competing with Lalo is a good idea. I would wait until we have a solid thing. A lot of these other things look cool to me. UX polish, that's a huge one. That should be prioritized. Yeah, let's move that. That's priority. Horizontal featured artists, scroll and scroll. We're already tackling that, so we can remove that from the list. Yeah, that optimization and speed and performance and everything is definitely something we'll tackle, but stuff like that is kind of going to slow us down until we figure out what we want the profiles to look like and stuff, so I'm probably going to hold off on that for a minute. Growth leverage, cheap testers, pro trial. Powered by Joby, it's a toggle, we're already on that. Public opt-in showcase of best profiles. Clone this layout. Yeah, clone this layout doesn't work, because I don't want people, like the whole point of the product is we take control of the layout. I think a huge marketing angle on this really is that you're an artist, you're good at making music, go make music. Why are you spending time customizing a link tree and designing a link tree and trying to test, oh, should my Spotify be first, or my Apple Music, or my Spotify, or my Apple Music, or should I send people to Twitter and then send them to Spotify, or should they be on my Instagram? No. Should I put an email capture on here or something? No. Let us do that. You sign up, we generate one profile. You don't get to pick what it looks like, we pick what it looks like. And we have thousands of artists using these profiles, and we're running tests every day to figure out, should the button be blue, should the button be purple? Should the button be indigo? Should the button be aquamarine? Should the button be 40 pixels or 42 pixels tall? Should there be 8 pixels of padding, or 12 pixels of padding, or 10 pixels of padding? We are doing all of these tests and figuring out what works. Should we send them to a page where they pick their network, or should we just automatically send them to Spotify? Do we get a better conversion rate assuming everyone has Spotify and losing out on the people who don't? Or do we get a better conversion rate asking them to pick? Or are we changing, running tests on Spotify first or Spotify second? Should we rank them by, should it be different per country? We're doing all of this complex data science on behalf of the artist to make this the highest converting thing that's going to make you money. You just tell us who you are. Oh, you're Britney Spears? Okay, here's your profile. And we give you the best profile there is for Britney Spears to make money. Oh, you're U2? Here's the best profile for U2 to make money. We do all of this, and we use AI, and we use data science, machine learning, and complex analytics, and territory-based targeting, and DSP-based targeting. We're creating different profile layouts and running them to different people and running tests and picking the ones that are best. That's kind of the angle of the product.

---

## Assistant

Roger, Mr. White. Aligning to “money-first, one canonical layout, we do the testing,” here’s a tight plan that ships fast and gives **actionable** analytics from day one.

# Minimal Actionable Analytics (MAA) — what we ship first
**Funnel we show (unique users, last 7/28 days):**
1) **Visits** → 2) **Primary DSP clicks** → 3) **Other link clicks**  
(+ campaign and country slices)

**Why it’s useful (today):** tells artists if their Jovie link is getting traffic, if the **primary action** is converting, and which campaigns/countries are paying off. That’s enough to make better promo decisions immediately.

**How to implement (quick + robust):**
- **Visitor/session**: Edge middleware sets `jv_vid` (UUID, 1yr) + `jv_sid` (30-min rolling). No PII.
- **Pageview (visit)**: 1×1 **/t.gif** beacon (no JS needed) logs: handle, session, visitor, referrer, `utm_*`, country (from IP), device UA.
- **Outbound clicks**: All DSP buttons hit **/r?d=spotify|apple|ytm…&h=HANDLE&…** → log row → 302 to the final URL. (This guarantees click capture.)
- **Schema (Supabase):**
  - `events(id, ts, handle, artist_id, event_type ['visit','click'], dest, session_id, visitor_id, country, device, utm_source, utm_medium, utm_campaign, referrer)`.
  - `event_hourly` materialized view for cheap charts (REFRESH every 5–10 min).
- **Dash UI (simple, no fluff):**
  - Funnel cards: **Visits → Primary clicks → CTR** (+ tiny sparkline).
  - **Top campaigns** (visits, primary CTR).
  - **Top countries** (visits, primary CTR).
  - **Last share links** (auto-generated UTMs) with copy buttons.

# Money levers baked in (day one)
- **Auto-UTMs**: every “Share” in the dashboard copies a UTM’d Jovie link (platform prefilled: ig_story, tiktok_bio, yt_desc, etc.). Campaign compare becomes turnkey.
- **Primary DSP auto-selection** (network effect): default primary uses rolling 14-day **per-country CTR** across our whole network, with artist-level override if their data is strong. (We test for you; you just make music.)
- **Actionable insights (no vanity):**
  - “Primary CTR is higher in **UK** for **Apple**; we’re defaulting to Apple there.”
  - “**Instagram Story** traffic has 2.1× higher primary CTR than Bio; push Stories.”
  - “Campaign **PRE-SAVE-UK** underperforming vs baseline (-32% CTR); try fresh creative.”

# Experiments that fit the philosophy (central control, no theming)
- **Statsig gates/experiments**:
  - `primary_dest_v1`: choose primary per geo/device.
  - `button_label_v1`: “Listen now” vs “Open in Spotify”.
  - `choice_screen_v1`: direct-to-primary vs picker for countries where share is <X.
- Success metric: **Primary DSP click-through rate.**  
- Rollout centrally; artists don’t pick layouts—results do.

# What we **don’t** build yet (per your call)
- Linktree import, EPK, Teams, Custom domains, Content Kit, “Clone layout.”  
- Universal notifications: collect emails softly now (hidden field on profile + dashboard form) but ship the Lalo-competitor later.

# Sprint plan (7–10 dev days total)
**Sprint A (3–4 days)**
- Handle-claim → Clerk → artist select (Spotify) → publish `/[handle]` (you’re already mid-flow).
- **Tracking plumbing**: middleware IDs, `/t.gif`, `/r` redirect, Supabase tables + RLS.
- Replace all DSP hrefs with `/r?...`.
- **Dashboard v0**: funnel cards + Top Campaigns + Top Countries.
- **Share buttons** that copy pre-UTM’d links.

**Sprint B (4–6 days)**
- **Primary DSP auto-selection** + per-country fallbacks.
- **Statsig** experiments above, live.
- **Event_hourly** view + cache; charts snappy.
- Weekly email digest (visits, primary CTR, top campaign) — Pro-only later, free now to seed habit.

# Issue cut list (bite-size, assignable)
1) Edge middleware: set/read `jv_vid`, `jv_sid`.
2) `/api/t` (serve pixel + log visit).
3) `/api/r` (log click + 302).
4) Supabase: `events` table, RLS (insert via service key only), `event_hourly` matview.
5) Replace DSP links with `/r` helper.
6) Dashboard: Funnel cards, Campaigns, Countries (7/28d).
7) Share-link generator (UTM presets).
8) Primary-picker service (country→DSP) + Statsig gate.
9) Weekly digest email (cron + template).

# Guardrails
- **Speed**: pixel + redirects are near-zero overhead, Edge-friendly.
- **Privacy**: no PII; cookie IDs only; honor DNT by skipping visit logs for `navigator.doNotTrack==='1'`.
- **Data truth**: unique users by `jv_vid`; sessions by inactivity; all numbers labeled (7d/28d).

If you’re good with this, I’ll turn the cut list into GitHub issues with tight acceptance criteria and wire up the schema + endpoints first.

---

## User

Okay, I think an easy win, very, very simple win, easy to implement too, I believe, is to create on the dashboard, allow the user to set their remarketing pixels for TikTok, for Facebook, for Google Ads, and for Google Analytics, allow them to set those remarketing pixels, and then we just put those on their profile, if they have them, and ideally we do that in a smart and efficient way that doesn't slow down their profile at all, but yeah, we hook them up with those remarketing pixels, and we gate that as a pro feature. I think that's probably one of the easiest wins for a pro thing.

---

## Assistant

Absolutely. This is a fast, high-ROI Pro feature. Here’s the tight plan to ship “Remarketing Pixels” without slowing profiles.

# What we support (v1)
- **Facebook Pixel** (`fbq`, numeric ID)
- **TikTok Pixel** (`ttq`, alphanumeric ID)
- **Google Analytics 4** (`G-XXXX…`)
- **Google Ads Remarketing** (`AW-XXXXXXXXX`)  
*(Optional later: a specific Ads conversion label, but not needed for remarketing audiences.)*

# Implementation (2–3 dev days)
**1) DB + validation**
- `artist_pixels` table: `artist_id (PK)`, `fb_pixel_id`, `tt_pixel_id`, `ga4_id`, `gads_id`, `updated_at`.
- Server-side validation (regex):
  - FB: `^\d{6,20}$`
  - TikTok: `^[A-Za-z0-9_-]{4,64}$`
  - GA4: `^G-[A-Z0-9]{4,16}$`
  - GAds: `^AW-\d{6,12}$`

**2) Dashboard UI (Pro-gated)**
- “Remarketing Pixels” panel with four inputs, helper text, and a **Test fire** button (opens the profile in debug mode).
- Gate by plan in API + UI; show upsell for Free.

**3) Zero-drag loader (per profile)**
- Inject a single tiny inline bootstrap that conditionally loads each vendor **async** only if an ID exists.
- Load after first paint: `requestIdleCallback` fallback to `setTimeout(500)`.
- Preconnect only to used vendors (perf win).

**4) Code sketch (single loader)**
```html
<script>
(function(){
  const cfg = window.__JOVIE_PIXELS__ || {}; // injected server-side per artist
  const idle = (cb)=>('requestIdleCallback'in window)?requestIdleCallback(cb):setTimeout(cb,500);
  const add = (src, cb) => { const s=document.createElement('script'); s.async=1; s.src=src; s.onload=cb||null; document.head.appendChild(s); };
  const pre = (url)=>{ const l=document.createElement('link'); l.rel='preconnect'; l.href=url; document.head.appendChild(l); };

  idle(function(){
    // Facebook
    if (cfg.fb) {
      pre('https://connect.facebook.net');
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n; n.loaded=!0; n.version='2.0'; n.queue=[]; t=b.createElement(e); t.async=!0;
      t.src=v; s=b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', cfg.fb); fbq('track', 'PageView');
    }
    // TikTok
    if (cfg.tt) {
      pre('https://analytics.tiktok.com');
      !function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=
      ['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];
      ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}; 
      for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]); ttq.load=function(e){var i='https://analytics.tiktok.com/i18n/pixel/events.js';
      ttq._i=ttq._i||[]; ttq._i.push([e]); var s=d.createElement('script'); s.async=1; s.src=i; d.head.appendChild(s)}; 
      ttq.load(cfg.tt); ttq.page();
    }
    // GA4 + Google Ads via single gtag.js
    if (cfg.ga4 || cfg.gads) {
      pre('https://www.googletagmanager.com');
      window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);}
      add('https://www.googletagmanager.com/gtag/js?id='+(cfg.ga4 || cfg.gads));
      gtag('js', new Date());
      if (cfg.ga4)  gtag('config', cfg.ga4,  { send_page_view: true });
      if (cfg.gads) gtag('config', cfg.gads, { allow_enhanced_conversions: false });
    }
  });
})();
</script>
<noscript>
  <!-- Optional FB noscript pixel if fb is set -->
  <!-- <img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=FB_ID&ev=PageView&noscript=1"/> -->
</noscript>
```

**5) Server injection**
- In `/[handle]` page `getServerSideProps` (or server component), fetch `artist_pixels` and emit:
  ```js
  <script dangerouslySetInnerHTML={{__html:`window.__JOVIE_PIXELS__=${JSON.stringify({fb,tt,ga4,gads})}`}} />
  ```
- Add a `?jv_debug=pixels=1` mode to console.log what loaded.

**6) Events (optional v1.1)**
- On primary click (before navigating), enqueue:
  - `fbq('track','Lead',{content_name: dest})`
  - `ttq.track('ClickButton',{content_name: dest})`
  - `gtag('event','primary_click',{destination: dest})`
- Use `navigator.sendBeacon` to our own `/api/track` in parallel; don’t delay navigation.

**7) Perf & privacy**
- No blocking scripts; all `async`, idle-loaded.
- Respect DNT: if `doNotTrack==='1'`, skip tags.
- EEA/UK consent flag (configurable): show minimal consent bar; only load after consent (can land in v1.1).

# Acceptance criteria
- Pro users can save IDs; Free sees upsell.
- Profiles load with **no CLS/LCP regression** (±5% baseline).
- Pixel network requests appear only when IDs exist.
- PageView fires once per load; debug mode confirms injections.
- Docs page lists where to find each ID + copy/paste examples.

# Issues to open
1) DB table + API routes (create/update/read) with regex validation.
2) Dashboard “Remarketing Pixels” card (Pro gated) + debug link.
3) Profile injector: `__JOVIE_PIXELS__` + loader snippet.
4) Perf checks: preconnect, idle-load, DNT, consent flag.
5) (v1.1) Click events + weekly “audience growth” email.

If you say go, I’ll cut the issues and wire the DB + injector first.

---

## User

Great, so we'll add that to our list, but before that, we need to make the MVP rock solid. So just like, you know, a user needs to be able to hit the landing page, pick their username, sign up, get referred to ClerkAuth, put in their email and password, get the dashboard, and then be able to see their whole profile and set up their whole profile, and then get the profile. So we need that working before anything else, and we need that to be rock solid and like Apple-level polish before we start adding features.

---

## Assistant

Locked. Here’s the **rock-solid MVP flow** spec + cut list. Zero fluff, Apple-clean, testable end-to-end.

# Target user journey (happy path)
1) **Landing:** enter handle → validate → “Continue”.
2) **Auth (Clerk):** email + password (or OAuth) → redirect back with session.
3) **Claim finalize:** create artist + claim handle (atomic).
4) **Onboarding wizard (1–2 mins):**
   - Pull from Spotify (search + pick) → prefill name/photo.
   - Confirm primary DSP (auto or pick) + paste other DSP links (optional).
   - Preview → **Publish**.
5) **Dashboard v0:** share link, quick status, minimal funnel (Visits → Primary clicks).

# Data model (Supabase)
- `artists` (id uuid pk, owner_user_id, handle unique, display_name, image_url, created_at).
- `artist_claims` (id uuid pk, handle unique, pending_user_token, created_at, expires_at).
- `artist_links` (id pk, artist_id fk, kind enum['spotify','apple','ytm','yt','soundcloud','bandcamp','website','instagram','tiktok','x'], url text).
- (from analytics plan) `events` table (visit/click) — keep, but not blocking MVP publish.

**Constraints**
- `handle` UNIQUE + lowercase check, regex: `^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$` (3–30, no leading/trailing hyphen).
- Reserved list: `['admin','api','app','auth','login','logout','signup','dashboard','settings','about','help','support','pricing','static','_next','assets','vercel','www']`.

# Handle claim — race-proof
- **Start (unauth):** POST `/api/claim/start` → create `artist_claims(handle, pending_user_token, expires_at=15m)` if available; 409 if taken.
- **After Clerk:** POST `/api/claim/finalize` with `pending_user_token` (from cookie/localStorage) → server **transaction**:
  - INSERT `artists` with handle **IF NOT EXISTS** (unique enforcer).
  - Attach `owner_user_id = clerk_user.id`.
  - Delete `artist_claims`.
- If conflict (lost race), redirect back to landing with “Handle just taken” toast and repopulated field.

# Onboarding wizard (4 cards, single column, no clutter)
1) **Artist identity:** search Spotify → choose → prefill name/photo. Skip allowed.
2) **Primary action:** auto-select per our default; allow manual override (radio).
3) **Links:** paste other DSPs (smart detect domains → set `kind`).
4) **Preview & publish:** right-side live preview; “Publish” enables `/[handle]`.

**Polish**
- Instant validation with debounced (300ms) availability check.
- No layout shift: fixed field heights, skeletons for image.
- Keyboard-first: Enter submits; visible focus rings; inline errors only.
- Copy tone: short, directive (“Pick a handle”, “Continue”).

# Profile page `/[handle]`
- Streaming-fast SSR/Server Component.
- OG/Twitter meta from artist data.
- Above-the-fold: hero image, **one primary button**, “More options” expander.
- Error states: 404 (clean), private/draft guard bounce to dashboard.

# Definition of Done (MVP)
- New user can: claim → auth → finish wizard → see live profile → copy share link.
- Cold first paint ≤ 1.2s on Vercel edge test page, CLS ≈ 0.
- Handle collisions handled gracefully (no 500s).
- Wizard fully responsive; Lighthouse ≥ 90 (mobile).
- Basic analytics hooks present (pageview + primary click) even if charts land next sprint.

# Tests (must pass)
- **Unit:** handle regex, reserved list, URL classifier → `artist_links.kind`.
- **API:** claim start/finalize happy path; finalize race (parallel); expiry invalidates token.
- **E2E (Playwright):**
  - Happy path (claim→auth→publish→profile loads).
  - Handle already taken.
  - Abandon mid-flow then resume after login (claim token survives).
  - Wizard skip Spotify still publishes.
- **Perf check:** CI Lighthouse on `/[handle]` sample (assertions on LCP/CLS/TBT).

# Cut list (GitHub issues)
1) **Handle input UI** (landing): regex + debounced availability; reserved-name error; CTA → Clerk.
2) **Claim API**: `/api/claim/start` + `/api/claim/finalize` with transactional upsert; sets cookie `jv_claim_token`.
3) **DB migrations**: `artists`, `artist_claims`, `artist_links` (enums, indexes, RLS: only owner can mutate; public read).
4) **Clerk redirects**: preserve `jv_claim_token` through OAuth/email; post-auth finalize; error UX for conflicts/expiry.
5) **Spotify picker**: server action to search + prefill; safe fallback image.
6) **Wizard UI**: 4 steps + right-side live preview; publish toggles `is_published`.
7) **Profile route**: SSR, OG tags, primary action + “More options”; 404/guard states.
8) **URL classifier**: detect DSP from pasted links; normalize URLs; prevent duplicates.
9) **Analytics hooks** (thin): `/api/t` pixel + `/api/r` redirect wrappers; store events (no charts yet).
10) **E2E + Lighthouse**: Playwright flows + perf budget; GitHub Action.

# Nice-to-have (if time remains)
- “Copy profile link” on publish toast.
- Share presets (UTM’d) in dashboard.
- Welcome email: “Your profile is live” + share tips (can be plain text).

If you approve, I’ll turn this into issues with acceptance criteria and start with **DB + claim APIs + landing UI**. Then wizard → profile → tests.
