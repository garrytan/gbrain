
Mr. White, I’d imagine it as **web-first, phone-approved, native-later**.

The YC demo should **not** be an iOS app demo. It should be a **web app showing the vault + catalog intelligence + generated posts**, with a **phone approval moment** at the end.

The clean product framing:

> **Jovie connects to an artist’s archive, finds forgotten songs and assets, turns them into daily social videos, and sends them for one-tap approval.**

## The product surfaces

| Surface | Role | Build order |
|---|---:|---:|
| **Web app** | Setup, source connections, catalog review, generated videos, rights review, calendar, analytics | First |
| **SMS / WhatsApp / email approval** | Daily approve / skip / regenerate | First |
| **iOS app** | Approvals, quick uploads, Apple Photos import, notifications | Later |
| **Mac desktop helper** | Local drive scans, Apple Photos library, big media folders, old hard drives | Later |
| **Public artist profile** | Destination link, fan capture, catalog page, payments | Already useful infrastructure |

So the first version is **not “an app artists live in.”**

It is:

> **A web command center for onboarding + a daily text message for approvals.**

Artists do not want another dashboard. Managers and labels will tolerate dashboards. Artists will tolerate a daily text if the videos are good.

## Why web-first

The setup flow is too heavy for iOS:

- connect Google Drive
- connect YouTube
- upload music/videos/photos
- review discovered assets
- confirm rights
- inspect generated posts
- manage a posting calendar
- add team members
- review analytics

That belongs in a browser.

Google Drive is a strong first source because Google’s Drive API supports searching files/folders, upload/download, metadata queries, and file export/download workflows. Gmail can also be valuable later because the Gmail API supports message search/filtering and attachment retrieval. citeturn997308search17turn997308search1turn318353search3turn318353search1

## Why iOS later

The iOS app becomes valuable when you want **Apple Photos ingestion** and dead-simple artist approval.

Apple’s PhotoKit is the relevant framework for accessing image and video assets managed by Photos, so native iOS/macOS eventually matters. citeturn655367search2

But for YC, native iOS is a distraction unless the demo is specifically “Jovie found old photos from my phone and made posts from them.”

The MVP can use:

- upload
- Google Drive
- YouTube links
- manual import
- seeded founder catalog

Then later add native Photos access.

## The ideal user flow

### 1. Create artist vault

First screen:

> **Reactivate your catalog**  
> Connect your old songs, videos, photos, lyrics, emails, Drive folders, and YouTube channel. Jovie will find postable moments and generate daily videos.

Buttons:

- Connect Google Drive
- Connect YouTube
- Upload songs/videos
- Add lyrics
- Add photos
- Add artist profile
- Invite manager

For the YC demo, you can show real files already loaded.

### 2. Jovie scans the archive

After connection/import:

> **Jovie found:**
>
> - 27 songs
> - 6 music videos
> - 3 lyric videos
> - 184 photos
> - 41 video clips
> - 9 artwork files
> - 12 lyric docs
> - 23 old release/context emails
> - 74 usable post ideas

This is the magic moment.

The user should feel:

> “Oh shit, it found my career.”

### 3. Catalog graph appears

The app shows songs as cards.

Example:

**Song: “Late Night Exit”**  
Era: 2019  
Mood: lonely, cinematic, LA, regret  
Best hook: 0:42–0:57  
Best lyric: “I only call when the city goes quiet”  
Assets found: music video, cover art, 12 photos, 3 email notes  
Suggested formats: lyric visualizer, archive remix, fake movie trailer, night-drive scene  
Rights status: green

Each song becomes a content object.

### 4. Jovie generates today’s posts

The main daily screen:

> **3 posts ready for approval**

Card 1:

**“The line still hits”**  
Song: Late Night Exit  
Format: kinetic lyric video  
Source: master audio + lyric doc + AI night-drive scene  
Risk: green  
Disclosure: AI visualizer recommended  
Caption: “Forgot how much this line still hurts.”

Buttons:

- Approve
- Edit caption
- Regenerate
- More like this
- Skip

Card 2:

**“From the vault”**  
Song: Late Night Exit  
Format: old music video recut vertically  
Source: 2019 video + new motion typography  
Risk: green/yellow  
Caption: “Found this buried in the archive.”

Card 3:

**“Fake billboard visualizer”**  
Song: Late Night Exit  
Format: original surreal AI scene  
Source: master audio + AI-generated fictional city billboard  
Risk: yellow  
Caption: “What this song would look like if it had a second life.”

This is the product.

### 5. Rights check before approval

Before posting, every card has a rights panel:

> **Rights check**
>
> Music: user-provided  
> Lyrics: user-provided  
> Visuals: AI-generated + user-owned artwork  
> People detected: none  
> Brands detected: none  
> Character/IP risk: low  
> AI disclosure: recommended  
> Publishing risk: green

For risky ideas, Jovie should rewrite automatically.

Prompt:

> “Iron Man dancing on my billboard”

Jovie output:

> “Original chrome armored robot dancing on a fictional glowing billboard.”

That shows taste and legal intelligence in one move.

### 6. Approval happens by phone

The artist receives:

> **Jovie: 3 posts ready today.**  
> Post 1: lyric visualizer for “Late Night Exit”  
> [Preview]  
> Reply: **1** to post, **2** to skip, **3** to regenerate.

Or in-app:

- Approve
- Skip
- Regenerate
- Edit caption

This matters because the artist should not need to open the web app daily.

### 7. Jovie schedules/publishes

For YC demo, you can show “queued for Instagram Reels / TikTok / YouTube Shorts.”

Actual auto-posting can come later, but it is technically plausible through official platform APIs. Meta’s Instagram publishing docs describe publishing images, videos, Reels, and carousels through the Content Publishing API. citeturn655367search3

In the demo, the final state can be:

> **Approved and scheduled.**  
> Destination: jov.ie/tim  
> Post time: Today, 12:30 PM  
> Platform: Instagram Reels  
> AI disclosure: enabled

### 8. Jovie learns

After posts go live:

> “Your lyric visualizer outperformed archive footage by 2.4x. Tomorrow Jovie will generate more night-drive lyric posts from this era.”

The app should learn from:

- approvals
- skips
- regenerations
- captions edited
- watch time
- saves
- comments
- follows
- profile clicks
- song clicks

## The YC-demo-worthy flow

The YC demo should be a **2–3 minute screen recording**. The YC founder video itself should be separate; YC’s own application-video instructions say the founder video should be one minute of founders talking, and that product demos belong in a separate application slot. citeturn348989view1

The demo should show the **new thesis**, even if the backend is partly concierge.

### Demo title

> **Jovie revives dormant music catalogs.**

### Demo structure

#### 0:00 — The problem

Show landing/dashboard.

Narration:

> “Artists do not want to be Instagrammers. Jovie turns their old music and archive into daily approval-ready social videos.”

#### 0:15 — Connect the archive

Show source tiles:

- Google Drive
- YouTube
- Upload songs
- Upload lyrics
- Upload photos
- Gmail later
- Apple Photos later

Click “Use founder catalog.”

The demo should not rely on waiting for OAuth or crawling in real time. Use seeded data.

#### 0:30 — Jovie discovers the catalog

Show:

> “Jovie found 18 songs, 4 videos, 73 photos, 11 lyric files, and 39 post ideas.”

This is the first wow moment.

#### 0:45 — Open one old song

Click a song.

Show:

- waveform
- chorus timestamp
- best lyric
- old video matched
- artwork matched
- mood tags
- source assets
- rights status

This proves Jovie understands the catalog, not just files.

#### 1:10 — Generate today’s posts

Click:

> **Generate today’s posts**

Show three cards:

1. lyric motion post
2. archive music-video remix
3. surreal AI visualizer

This is the second wow moment.

#### 1:35 — Preview one finished video

Open a real rendered vertical video.

It should look good enough that you would actually post it.

The best demo output is probably:

> old song + lyric hook + cinematic AI visualizer + motion typography + caption

Avoid making the demo depend on a perfect AI human face. Use abstract/cinematic visuals where quality is easier to control.

#### 1:55 — Show rights intelligence

Open the rights drawer.

Show:

- no third-party characters
- no brand logos
- AI disclosure recommended
- artist owns/controls source music
- post approved for social

This makes it feel serious, not like another AI toy.

#### 2:10 — Approve from phone

Show a phone mockup or actual SMS:

> “3 posts ready. Reply 1 to post.”

Tap/reply approve.

The web app updates:

> **Approved. Queued for posting.**

This is the third wow moment.

#### 2:30 — Show destination/profile

Show the approved post routes to:

> jov.ie/tim

That connects the new pivot to existing Jovie infrastructure.

Message:

> “Jovie creates the content, publishes it, and sends traffic to the artist profile.”

#### 2:45 — Show learning loop

Show dashboard:

> “Jovie learned that lyric visualizers from this era are getting the most approvals. Tomorrow it will generate more like this.”

End.

## What screens you actually need

For YC, you only need about **seven screens**.

### 1. Home

Headline:

> **Your catalog is ready to post.**

Stats:

- songs found
- assets found
- posts generated
- posts approved
- posts scheduled

CTA:

> Generate today’s posts

### 2. Sources

Tiles:

- Google Drive
- YouTube
- Upload folder
- Lyrics
- Photos
- Gmail
- Apple Photos

For demo, show Drive/YouTube/upload as “connected” and Gmail/Apple Photos as “coming soon” or “request access.”

### 3. Vault

A searchable archive:

- Songs
- Videos
- Photos
- Lyrics
- Notes
- Emails
- Artwork

Each item has:

- source
- date
- linked song
- rights status
- quality score

### 4. Song page

This is the most important screen.

For each song:

- song preview
- best hook
- lyrics
- mood
- story/context
- matched assets
- post formats
- rights status
- generated post history

This is where Jovie feels like it understands music.

### 5. Daily posts

Three approval cards.

Each card has:

- video preview
- caption
- platform
- source assets
- risk label
- disclosure label
- approve/skip/regenerate

### 6. Approval message

SMS/iOS mock:

> “Post 1 is ready. Approve?”

This shows the artist does not live in the app.

### 7. Calendar / queued posts

Shows approved posts scheduled across platforms.

## What the demo should avoid

Do not demo a giant blank dashboard.

Do not demo chat first.

Do not start with “artist profile.”

Do not show a generic prompt box.

Do not make the user type:

> “Make me a viral video.”

That makes it look like a generator.

The magic is:

> Jovie already knows the artist, finds the material, proposes the posts, and asks for approval.

## The right product mental model

This should feel less like Canva and more like an autonomous creative department.

The user flow is:

> Connect vault → Jovie understands catalog → Jovie generates daily posts → artist approves → Jovie posts → Jovie learns.

The artist’s daily experience is:

> “Jovie texted me three posts. I approved one.”

The manager’s weekly experience is:

> “Jovie kept the artist active all week and showed what worked.”

The label/catalog owner’s monthly experience is:

> “Jovie reactivated songs that had no current campaign.”

## What should be real for YC

For a credible demo, make these real:

1. **Use a real dormant song.**
2. **Use real old assets.**
3. **Generate at least 3 real post candidates.**
4. **Make at least 1 final video genuinely postable.**
5. **Show a real approval action.**
6. **Show the existing Jovie profile as the destination.**

The connectors can be partially simulated. The ingestion can be seeded. The final video cannot look fake/bad. The output quality is the proof.

## The strongest demo concept

Use your own catalog.

Demo line:

> “This is my own dormant catalog. I haven’t released in years. Jovie found an old song, pulled the best lyric, matched old assets, generated three posts, flagged the rights risk, and sent it to me for approval.”

That is founder-market fit and product proof in one story.

## The first version I’d build

### Product name inside app

**Jovie Vault** for ingestion.  
**Jovie Daily** for generated posts.

### App structure

Left nav:

- Home
- Vault
- Songs
- Daily Posts
- Calendar
- Rights
- Profile
- Analytics

### Primary CTA

> **Generate today’s posts**

### Daily output

3 videos per day.

### Approval

SMS first. Native app later.

### Publishing

Download/queue/concierge first. API posting later.

## The final answer

Build the YC demo as a **web app** with a **phone approval moment**.

The flow:

> **Connect archive → Jovie finds old songs/assets → Jovie understands one song → Jovie generates 3 modern vertical videos → rights check → approve by phone → queued to post → traffic goes to Jovie profile.**

That is demo-worthy because it shows the whole company in one loop.

The product is not “an iOS app.”  
The product is **a catalog activation engine**.

The first interface is web.  
The daily interface is text.  
The future ingestion layer includes iOS/Mac.


OK, cash is like literally hitting zero so what I think is like imperative is like I think I need a simple demo video that I can show someone even if it’s fucking fake. That is like holy shit I need this that’s all I need right and then that should be enough for me to go to my friends who are musicians and be like. I could activate this on your. Know what I mean and so I’ve got a bunch of friends who this could be fucking cool for like I got several and so what I’m trying to think about is like and like we’re talking about people who have like Content too like I do have people who have like contact libraries and stuff like you know so and honestly, I think diplo would fucking your best in this shit in the heartbeat the guy to connect me to him too so basically my question then becomes like is this something where we have to right so something shouldn’t be that hard it shouldn’t be that hard to just show something that has. I guess here’s my question right so what is the demo? That’s like a magic moment that we could show people and you’ve got me as the pilot right can we take my profile and make it look active right so you know you’ve got a ton of photos that you could pull in and I can manually upload them for now I don’t need fancy integration and stuff right so I can upload my photos, right I could upload my music videos or we could pull them automatically from my YouTube channel. We we already pulled in my songs and then we should be able to do something like figure out figure out what I think we should be able to then let the user ingest them or we should be able to create generate a fucking TikTok and post it on TikTok right like this shouldn’t be hard and I would probably say like can we can we create a new account and just fill with Content right like to me I guess the most interesting thing would be like yeah just like can you create a TikTok Account that might be the product create a TikTok account created TikTok account connected to my thing to Jovie and let Jovie pull my catalog in and automatically generate a new video and post every day to my account that uses this all that’s it and then we just narrowing on that and hide everything else and I just and then we can show and then we have an actual thing that we can show and we can work backwards from numbers on right? How many views did the video get and then just self improve that’s it that’s the belt that’s that’s what I want to build. How do I build this now and then OK well here then here comes back a certain right so I have a couple ideas right? I still think that the general concept of like make every Friday count and these cycles makes sense right it’s just that you want to be able to create the only change. Here is not release more music with less work. It’s it’s Create. It is continually ship whether or not you have new music right continually ship it’s continuous continuous output for music artists regardless of the input so that should mean taking your existing catalogue and turning it into assets and those assets can be OK so here’s how we think about it. You give us the input your import is your music catalog your input is your existing merch designs your logo, your existing social media right Jovie learns about all of this and then outputs content. The content is an approved merch design for sale on your artist profile without you doing anything external and we just ship it through print right which like itself could be an MVP another piece of Content can be like Instagram lyric reels or something right and then another one could be TikTok videos right? I think the TikTok videos are the most valuable one and the most impressive. I also think that the merch one is impressive because you could literally have it generate merch and then put it for sale and do the fulfillment without you ever touching anything but the artist profiles could be cool too. My thing is quality merch designs. We could literally just go out and train an AI on a bunch of what good band designs are and Founder taste is a perky. I’m really good at fashion and design and so I could just sit there and tell you what’s good what sucks and train the shit out of the thing but also the TikTok thing might be better, but the TikTok thing needs to be trained unlike virality and stuff and we need to have a virality loop in there and Higgs💕🥳 Field has like an MTP for this and stuff so kind of like what do we think is like the best way to build this that’s what I’m trying to figure out you know and do we build it for me or do we build it for and then like then like how come you know how do we get it to like ship and then my biggest concern though is like cost right so like I don’t wanna play one of these games where it’s a race to the bottom with cost right so like you know if the models that we need to do video generation are gonna be crazy expensive you know is it gonna become capital intensive right? That’s my that’s like a core concern because we don’t have a lot of cash right so like we could probably demo it but if we’re going to build, you know, I don’t want to build a company that just has to keep fucking freezing money and raising money and raising money and raising money, you know I don’t wanna build a company that gets a default to live very quickly. I don’t want to be one of these fucking companies. That’s like you know I just don’t want my job to become raising money for the rest of my life you know so I mean, I’ll probably change my mind once we’re making a bunch of money but like but I’m just I’m concerned that like you know I don’t know I need the facts. I need you to do research and just be like OK like what would this actually cost right like if we’re generating three video ideas that are good enough to go on TikTok and benefits three videos you know potentially that means you know how much training work and stuff that we have to do generating videos in order to get it good you know how much is that cost and stuff now that being said the generation models are fucking going crazy like Brock has a new agentic image generation thing that like an agent works with you to build the whole video and stuff like it looks crazy like all of this stuff pretty much exist like out of the box already so like this isn’t crazy and that’s why I think we should be building it but I am concerned for costs so like you know, I don’t know just just worried about costs and then like also you know if we’re doing this as a fucking trial I could build the thing where like like we could literally build a thing we like like I don’t I don’t mind if it’s like even human in the loop right like if you know, someone signs up for it in our trial and it’s paying $1000 a month or something right and then I have to sit there and just like you know the Jovie Jovie shows the admin it’s suggested Content and then I have to review it and then I could literally just like make my own shit and drag it into Jovie and upload it and have it appeared to the user as if Jovie generated that video, but I actually went in and edit it and stuff like that would be fine as you know a human in the loop kind of thing because if someone’s paying $500 a month like we could afford that humans in the loop and then just eventually remove them you know what I mean so I think that that might be the more interesting play. What do we think about that? What do we think about the angles on this and is it like? Is it all AI video or do we take people have existing music videos and stuff and cut them up and stuff and like one experiment we could run as we could just pick an artist that we don’t even have Wright like I could be like OK let’s try this with like you too right and then we could just go and take all the U2 to videos and everything and adjust them and then just like run this and then deploy it onto TikTok or something and then just like watch it go viral and then be like hey we drove a song to the top of the charts you know what I mean that’s kind of like what we’re trying to do right like so you know cause if you if you can do that in a test, then prove it then like you know then you’ve got something right and then also if we actually achieve that achieve it with one of my songs and like we’re making money anyway you know what I mean I don’t know like, how do we think about this and and is that and is that more the tool is the tool like more like plugged into the like TikTok ads library and look at what trending and what’s working use models like Higgs💕🥳 Field’s virality thing and all this shit and just like engineer clips to go viral that use our music like I honestly got that might even just be the product like no interface or anything just like we sell it as a consulting service and we just run it you know what I mean cause I don’t even have to build interfaces if you just do it I’m kind of tempted to just make that the thing


Mr. White, I’d separate the urgent sales demo from the eventual default-alive product, then anchor the plan in current model costs and platform constraints.


The practical path is a concierge workflow that mostly remixes existing assets, lyrics, and motion graphics, using AI video sparingly for hero shots. Only test on catalogs you control or have explicit permission to use.


Mr. White, I would **not build the full product first**.

I would build a **Wizard-of-Oz Jovie Catalog Autopilot demo/service** immediately:

> **“Give Jovie your old music and assets. Jovie turns them into one TikTok every day. You approve. Jovie posts.”**

That is the wedge. The magic moment is **not** the dashboard. The magic moment is seeing a dead artist account suddenly full of good posts from old music.

## The immediate call

Build this for **you first**, then sell it to musician friends as a **paid concierge beta**.

Do not start with iOS.  
Do not start with Gmail/Drive/Apple Photos integrations.  
Do not start with merch.  
Do not start with a full autonomous TikTok API system.

Start with:

1. manually uploaded catalog/assets
2. internal admin workflow
3. daily generated TikTok/Reels/Shorts
4. human-in-the-loop quality control
5. one-tap approval
6. manual or semi-manual posting

The customer-facing product can look automated. The back end can be Tim/Jovie ops for now.

## The holy-shit demo

The demo should be:

> **“This was my dormant artist profile. Jovie reactivated it.”**

The video should show:

### 1. Dead account

Open a TikTok account or Jovie profile:

> “No posts in months/years.”

### 2. Jovie Vault

Show a simple screen:

> **Jovie found:**  
> 24 songs  
> 4 music videos  
> 137 photos  
> 18 lyric moments  
> 41 post ideas  
> 7 posts ready this week

This can be fake UI over real prepared data.

### 3. Song intelligence

Click one old song.

Show:

> Best hook: 0:42–0:56  
> Best lyric: “_____”  
> Mood: lonely / cinematic / LA / night drive  
> Assets: 2019 video, 12 photos, artwork, lyric file  
> Suggested formats: lyric visualizer, fake trailer, archive remix

### 4. Jovie generates three posts

Show three cards:

1. **Kinetic lyric video**  
   Old song + animated lyric + cinematic AI background.

2. **Archive remix**  
   Old music video or old photos, cropped vertical, motion graphics, captions.

3. **Surreal visualizer**  
   Fictional billboard / robot / fantasy scene / AI world with the song.

### 5. Approval

Show a text message:

> “Jovie: 3 posts ready today. Reply 1 to post the lyric visualizer.”

You reply:

> “1”

Then the web app says:

> **Approved. Posted to TikTok.**

### 6. Live result

Show the TikTok feed with 5–10 actual posts already published.

That is the real proof. The account should look alive.

## The demo video script

Use this exact structure:

> “Artists don’t want to be Instagrammers. They want to make music. Jovie turns their old catalog into daily TikToks they approve in one tap.”

Then screen recording:

> “Here’s my own dormant catalog. I haven’t released in years. Jovie imported my old songs, videos, lyrics, and photos. It found the best hooks, generated daily post ideas, made three videos, checked rights risk, and sent them to me for approval. I approve one by text, and it posts.”

End with:

> “The product is simple: your catalog keeps posting, even when you’re not releasing.”

## What to actually build now

Build the smallest internal system that lets you run the service.

### Customer-facing side

Very little.

A landing page:

> **Jovie Catalog Autopilot**  
> Daily TikToks from your old music.  
> Upload your catalog. Approve posts by text. Stay active without becoming a content creator.

A form:

- artist name
- TikTok handle
- Instagram handle
- upload/Drive link
- songs
- videos
- photos
- lyrics
- “what should this feel like?”
- “what should we avoid?”

An approval message:

- preview video
- caption
- approve / skip / edit

### Internal side

A dead-simple admin:

| Column | Meaning |
|---|---|
| Artist | Tim / friend / pilot |
| Song | Which track |
| Asset source | photo, video, lyric, AI, music video |
| Concept | what the post is |
| Status | idea / rendering / needs review / approved / posted |
| Platform | TikTok / Reels / Shorts |
| Cost | model cost + human time |
| Result | views, likes, saves, comments |

This can be Airtable, Notion, Supabase, Linear, whatever ships fastest.

## The format mix

Do **not** make this all AI video. That becomes expensive and lower-margin.

Use this split:

| Format | % of posts | Why |
|---|---:|---|
| Lyric motion graphics | 40% | Cheap, evergreen, reliable |
| Existing video/photo remixes | 30% | Uses owned assets, feels authentic |
| AI visualizer shots | 20% | Magic, modern, demo-worthy |
| Story/archive posts | 10% | Adds artist personality/context |

The core insight:

> **AI video should be the spice, not the whole meal.**

A fully AI-generated 15-second video every day can work, but the best early product is old music + old assets + modern editing + occasional AI visual spectacle.

## Cost reality

The costs are manageable **only if you avoid rendering tons of full AI videos per artist.**

Current public API pricing shows why. Runway API credits are $0.01 each; Gen-4 Turbo is 5 credits/second, Gen-4.5 is 12 credits/second, Veo 3.1 Fast without audio is 10 credits/second, and Veo 3.1 with audio is 40 credits/second. That means a 10-second output ranges roughly from **$0.50 to $4.00**, depending on model choice. citeturn198463view0

OpenAI’s Sora 2 API pricing currently lists **$0.10/second** for Sora 2 at 720p, while Sora 2 Pro ranges from **$0.30/second at 720p** to **$0.70/second at 1080p**, with batch pricing at half those rates. A 10-second Sora 2 base video is about **$1**; a 10-second 1080p Sora 2 Pro video is about **$7**. citeturn198463view1

Fal’s public pricing shows other model economics: Wan 2.5 at **$0.05/second**, Kling 2.5 Turbo Pro at **$0.07/second**, and Veo 3 at **$0.40/second**. So a 10-second clip can be roughly **$0.50, $0.70, or $4.00**, depending on the model. citeturn195790view0

### Practical monthly cost per artist

Assume one daily post, 30 days/month.

| Workflow | Approx model cost/month | Notes |
|---|---:|---|
| Mostly lyric graphics + existing footage | $5–$50 | Use FFmpeg/Remotion/CapCut-style editing |
| One light AI shot per post | $30–$150 | Good early target |
| 3 fully rendered AI candidates/day | $70–$500+ | Gets expensive after retries |
| Premium AI video with multiple retries | $500–$2,000+ | Dangerous unless client pays high retainer |

The killer is retries. If you generate 3 candidates/day and each needs 3 attempts, your cost multiplies fast.

So the product should generate **many ideas cheaply**, then render **few final videos expensively**.

## Pricing

For cash, sell this as a service now.

### Offer 1: Catalog Reactivation Sprint

**$750–$1,500 for 14 days**

Includes:

- upload catalog/assets
- 10–20 post concepts
- 7–14 finished TikToks/Reels
- approval by text
- posting support
- performance recap

### Offer 2: Always-On Artist Autopilot

**$1,500/month**

Includes:

- 1 post/day
- 3–5 posts/week guaranteed
- captions
- posting/scheduling
- weekly analytics
- monthly creative refresh

### Offer 3: Manager/label beta

**$3,000–$10,000/month**

For 3–10 artists.

This is where the money is. A manager does not want to hire five editors to keep every artist active.

## Build the service before the software

Your instinct is right: you can sell this with humans in the loop.

A customer pays $1,000/month. Behind the scenes:

- Jovie suggests ideas
- you review/edit
- you use Higgsfield/Runway/Sora/Pika/Grok/CapCut/After Effects/Remotion
- you upload the finished video into Jovie
- Jovie sends the artist an approval message
- Jovie appears to have generated it

That is fine as long as your actual claim is:

> “Jovie creates daily approval-ready posts for you.”

The internal method can be AI + human ops. Do not claim “fully autonomous” until it is.

## TikTok posting reality

TikTok posting can be automated eventually, but it has platform friction.

TikTok’s Content Posting API supports direct posting and draft upload from desktop/cloud/web apps. It also supports uploading content to TikTok as a draft for the creator to finish in TikTok. citeturn198463view4

The catch: TikTok says unaudited API clients are restricted to private viewing mode until the app passes audit. citeturn198463view3

So for the demo and first pilots:

- generate the video
- manually post from the artist account, or
- upload as a draft where possible, or
- have the artist post from their phone

Do not let TikTok API approval block the business.

Instagram is technically easier for API posting in some cases. Meta’s Instagram Content Publishing docs say API publishing supports media publishing, and Instagram accounts are limited to 100 API-published posts in a 24-hour moving period. citeturn568153search0

YouTube Shorts can also be uploaded through the YouTube Data API using `videos.insert`, with OAuth and metadata fields like title, description, keywords, category, and privacy status. citeturn576935view0

## Trend/virality loop

Do use TikTok trend intelligence, but don’t make the product dependent on a magical virality predictor.

TikTok Creative Center already exposes top ads, trend discovery, trending hashtags, songs, creators, and videos. That is enough to inspire formats manually at first. citeturn198463view5

Higgsfield’s Virality Predictor claims to analyze a clip and return a virality/engagement score, peak hook timestamp, hold-rate estimate, and heatmap. That can be useful as a ranking signal for drafts, but actual TikTok performance still has to be measured post by post. citeturn198463view2

The loop should be:

> trend scan → generate concepts → render drafts → human taste filter → optional virality score → publish → measure → make more like winners

## Do not use U2 publicly

Do not post U2 content as a test unless you have rights.

YouTube’s Terms restrict downloading, reproducing, altering, or using YouTube content outside the service unless expressly authorized or permitted by rights holders, and they restrict automated access such as scrapers without permission. citeturn622747view0

Copyright owners have exclusive rights to reproduce works, prepare derivative works, distribute copies, perform works publicly, and display works publicly. citeturn677482search4

So the safe test set is:

1. your own catalog
2. friends who give written permission
3. public-domain/cleared material
4. label/manager catalogs where rights are clear

Use U2-style workflows internally as inspiration, not as public proof.

## AI disclosure / legal guardrails

TikTok requires creators to label AI-generated content containing realistic images, audio, or video, and it says creators should label content that is completely generated or significantly edited by AI. TikTok also prohibits certain AI content, including unauthorized private-person likenesses, minors’ likenesses, and fake public-figure endorsements. citeturn198463view6

So Jovie needs a basic risk label on every post:

- **Green:** owned music, owned photos/video, abstract AI, lyric graphics
- **Yellow:** realistic AI scene, altered face/body, fake billboard, background people
- **Red:** copyrighted characters, celebrities, brands/logos, fake endorsements, third-party footage, unlicensed songs

For the demo, keep everything green/yellow.

## The merch idea

Merch is real, but I would not make it the first demo.

Print-on-demand APIs exist. Printify’s REST API lets apps manage a Printify shop, create products, submit orders, and more; Printful also has an API for custom print-on-demand workflows. citeturn195790view5turn737030search0

The problem is that merch has slower feedback. You need design quality, mockups, ecommerce, fulfillment, sizing, shipping, returns, and buyer demand.

TikTok gives immediate proof:

- views
- likes
- comments
- saves
- follows
- profile clicks
- stream/link clicks

Merch can become a second content type:

> “Jovie turned this lyric into a shirt and put it on your profile.”

But the first wedge should be daily social output.

## What I would build in 7 days

### Day 1: Collect founder assets

Upload:

- 10 songs
- lyrics
- artwork
- 50–100 photos
- any music videos
- old clips
- artist bio/context
- visual references

Pick 3 songs max for the demo.

### Day 2: Create 20 post concepts

For each song:

- 5 lyric posts
- 3 archive remixes
- 3 AI visualizers
- 2 story/context posts
- 2 absurd/surreal posts

Use AI for ideation, not expensive rendering.

### Day 3–4: Produce 10 real videos

Make:

- 4 lyric motion videos
- 3 photo/video remixes
- 2 AI visualizers
- 1 fake-trailer style post

These need to actually look postable.

### Day 5: Create the fake/light UI

A simple Jovie screen:

- “Catalog imported”
- “Song intelligence”
- “3 posts ready”
- “rights check”
- “approve”
- “posted”

This can be built in web, Framer, Figma, or the existing app.

### Day 6: Post to TikTok

Create the account.

Post several videos.

You need the feed to look alive.

### Day 7: Record the demo

Record:

- the dead-to-active story
- the Jovie workflow
- the approval moment
- the live TikTok account

## The actual MVP spec

Name:

> **Jovie Catalog Autopilot**

Promise:

> **Daily TikToks from your old music. Approve by text.**

Input:

- music
- lyrics
- photos
- videos
- artwork
- artist notes

Output:

- one daily short-form video
- caption
- posting recommendation
- rights/disclosure note
- approval link

Internal workflow:

1. generate ideas
2. rank ideas
3. render drafts
4. human review
5. send approval
6. post
7. track results

## What to show musician friends

Do not show them a giant product vision.

Show them:

> “Here’s my dead catalog. Jovie made these 10 posts. Here’s the account. I can do this for you.”

Then sell:

> “Give me your Drive folder and 10 songs. I’ll reactivate your catalog for 14 days. You approve posts by text. $1,000 beta.”

That is enough.

## The capital-intensity answer

This does **not** have to become a capital-intensive race to the bottom.

It becomes capital-intensive if the product is:

> “Generate unlimited premium AI videos for cheap.”

It becomes a good business if the product is:

> “An AI-assisted creative ops system that keeps music catalogs active.”

Your margin comes from:

- reusing existing assets
- using low-cost motion graphics
- rendering selectively
- human taste + templates
- charging for outcomes, not GPU seconds
- building artist-specific content memory
- measuring what works and repeating formats

The expensive model calls should be reserved for posts where AI video actually adds value.

## Final recommendation

Launch this as a **consulting/service product immediately**, with a fake/light product wrapper.

The first real goal:

> **Create a TikTok account for your catalog and make it look alive in 7 days.**

The first customer promise:

> **“Your catalog will start posting every day without you becoming an Instagrammer.”**

The first paid offer:

> **“14-day Catalog Reactivation Sprint — $1,000 beta.”**

The first demo:

> **dead artist account → Jovie imports catalog → generates 3 posts → approval by text → live TikTok feed full of good posts**

That is the thing to build.


## See Also
- [[chatgpt/chatgpt_jovi-sign-up-ideas]]
- [[chatgpt/chatgpt_mvp-ideas-for-jovi-part1]]
- [[chatgpt/chatgpt_mvp-ideas-for-jovi-part2]]
- [[chatgpt/chatgpt_mvp-ideas-for-jovi-part4]]
- [[chatgpt/chatgpt_branch-branch-branch-sms-subscription-ideas-part3]]
