
Mr. White, yes. This is the actual wedge:

> **Artists do not want to be Instagrammers. Jovie makes their catalog post itself.**

That is much bigger than a release planner. It works for inactive artists, legacy catalogs, managers, estates, labels, and artists between releases. The product should become **evergreen catalog activation**, with new-release campaigns as one use case.

## The new product definition

**Jovie Vault / Jovie Daily**

> Connect your music, videos, photos, emails, Drive, YouTube, and old assets. Jovie turns your catalog into daily social videos you approve in one tap.

The artist does not prompt. The artist does not edit. The artist does not become a creator. Jovie wakes up, finds usable material, generates modern-feeling content, and asks for approval.

The key product promise:

> **“Every song you have ever made can keep working.”**

That is the line.

## Why evergreen is mandatory

You are right: this dies if it only works around new releases.

The real money is in:

- legacy catalogs
- artists with dormant followings
- labels with thousands of under-activated songs
- managers who cannot manually run content for every artist
- estates and nostalgia catalogs
- artists who have not released in years but still have audience, songs, stories, and scraps

For your own proof, this is perfect. The founder has not released in years. If Jovie can make your old catalog feel postable today, the demo sells itself.

The case study becomes:

> “I had not released in years. Jovie found my old music, videos, lyrics, photos, emails, and stories, then started generating daily content that felt current.”

That is much stronger than “we help active artists promote releases.”

## The product should be an autonomous content archaeologist

The ingestion layer matters as much as the generation layer.

Jovie should ask for access, then go hunting:

- songs
- stems
- masters
- demos
- music videos
- lyric videos
- cover art
- press photos
- old tour photos
- studio footage
- Dropbox/Drive folders
- Gmail attachments
- old manager emails
- rollout docs
- unreleased snippets
- YouTube uploads
- TikTok/Instagram archives
- Apple Photos / iCloud-adjacent media
- lyrics
- comments
- captions
- descriptions
- release metadata
- old bios and press copy
- fan messages
- visual references

Then it builds an **artist memory graph**:

| Object | What Jovie stores |
|---|---|
| Song | title, date, era, mood, lyrics, themes, hooks, chorus, bpm, story |
| Asset | source, file type, quality, date, people shown, rights status |
| Visual identity | colors, type, era, recurring motifs, wardrobe, locations |
| Rights | master owner, composition owner, likeness permissions, third-party flags |
| Content ideas | formats that work for this song, rejected styles, approved styles |
| Performance | which posts worked, why, and for which audience |

The “AI video generator” is just one worker inside this larger system.

## The dated-content problem is solvable

Old content feels bad when it pretends to be new.

It works when the product frames it correctly:

- **from the vault**
- **this aged well**
- **the line still hits**
- **before the release**
- **the song I forgot about**
- **the demo that became…**
- **what this song would look like today**
- **AI visualizer for an old track**
- **lost footage, rebuilt**
- **the music video we should have made**
- **song from 2019, visualized in 2026**
- **old track, new world**
- **the chorus deserved a second life**

The content should admit the age or abstract away from it. It should avoid pretending old footage is fresh.

## The content formats that matter

Jovie needs a large format library. Not “generate viral video.” More like: **choose the right post type for this song, this artist, this asset, this week.**

### 1. Lyric-first posts

The safest evergreen format.

Examples:

- kinetic lyrics flying through AI footage
- one brutal lyric over a cinematic loop
- chorus typography synced to beat
- lyric cards that look like movie posters
- “this line still hurts” posts
- comment bait: “which lyric hits hardest?”

This works even when there is no new footage.

### 2. AI visualizers

Turn an old song into a new visual world.

Examples:

- desert highway at night
- impossible billboard in Times Square
- underwater nightclub
- burning motel sign
- empty basketball court at 3 a.m.
- futuristic tour poster
- city collapsing into lyrics
- VHS footage becoming a dream sequence

This lets legacy music feel current without needing new shoots.

### 3. Asset remix posts

Use old material but modernize it.

Examples:

- crop old music video into vertical
- upscale old footage
- add captions
- add motion graphics
- isolate performance shots
- make album art move
- turn still photos into animated loops
- combine old footage with new AI backgrounds

### 4. Story posts

Artists have stories buried everywhere.

Examples:

- “I wrote this after…”
- “This song almost had a different chorus.”
- “This was the first song that got me noticed.”
- “We shot this video with no budget.”
- “The lyric came from an email I never sent.”
- “This song was supposed to be on an album that never came out.”

Email and Drive ingestion become valuable here.

### 5. Absurd internet-native posts

This is the “Iron Man dancing on the billboard” instinct, but legally safer.

Use original concepts:

- an original armored robot dancing on a fake Jovie billboard
- giant floating boombox over Los Angeles
- fake festival crowd chanting an old hook
- animated raccoon DJing the chorus
- alien paparazzi outside a fake release party
- skeleton band performing the bridge
- billboard in the sky with the lyric

The product should generate **original surreal content**, not copyrighted characters. “Iron Man” specifically creates copyright, trademark, and brand-risk issues. U.S. courts have recognized distinctive fictional characters/vehicles as copyright-protectable, and trademark confusion is a separate risk when famous marks or brands are used commercially. citeturn546262search4turn546262search5

### 6. Fan-memory posts

For legacy artists, nostalgia is the asset.

Examples:

- “Who remembers this one?”
- “This was the soundtrack to what year?”
- “I forgot how hard this hook went.”
- “Should we bring this one back live?”
- “This song disappeared for a while.”
- “The comments on this old video are insane.”

### 7. Pseudo-trailer posts

Treat songs like films.

Examples:

- “If this song were a movie…”
- “Official trailer for a song from 2018”
- “The villain arc version”
- “The heartbreak scene”
- “The closing credits version”

### 8. Catalog comparison posts

Useful for artists with range.

Examples:

- “same artist, different era”
- “2018 me vs. 2026 me”
- “the song before the breakthrough”
- “the one people slept on”
- “the song that should have been bigger”

### 9. AI music-video fragments

Not full videos. Short moments.

Examples:

- 8-second chorus loop
- 12-second cinematic hook
- 15-second surreal scene
- 20-second lyric drop
- 30-second story + chorus

Shorts/Reels/TikTok reward repeatable fragments. Full videos are optional.

## The autonomous ingestion roadmap

Do not build every connector first. But the long-term product must feel like it can find everything.

### V0: Manual ingestion disguised as product

For the first proof, manually ingest your own catalog:

- old songs
- old videos
- YouTube links
- Drive folders
- photos
- lyrics
- emails
- release notes
- comments
- artwork

Build the internal pipeline before building public OAuth flows.

### V1: Direct upload + Google Drive + YouTube metadata

This is probably the real first technical MVP.

Google Drive is a strong first connector because the API supports downloading stored files and exporting Google Workspace documents, with different methods for blob files versus Docs/Sheets/Slides. citeturn696144search0turn696144search7

YouTube can supply channel/video metadata through the Data API, and videos can be searched/listed through official endpoints. citeturn410105search1 But downloading or reproducing YouTube videos through unofficial methods creates Terms of Service risk; YouTube’s terms restrict downloading, reproducing, altering, or otherwise using content unless authorized by the service or rights holders. citeturn305004search0

So the safe path is:

- use YouTube for metadata, captions, titles, descriptions, thumbnails, comments where permitted
- ask user to upload masters or connect Drive/Dropbox
- support Google Takeout/manual import
- avoid “scraping YouTube videos” as the stated/default behavior

### V2: Gmail ingestion

Gmail is valuable because artists have old attachments, press copy, rollout notes, lyrics, manager emails, and assets buried there. Gmail’s API supports message search using Gmail-style queries and attachment retrieval. citeturn103223search0turn103223search1

But Gmail and Drive scopes can trigger Google OAuth verification, restricted-scope review, and user-data-policy obligations. Google says restricted scopes provide wide access to user data and require verification before broad use. citeturn103223search2turn103223search5

So do Gmail later, with narrow permissions and a clear product reason.

### V3: Apple Photos

Apple Photos access should probably be a mobile app path. Apple’s PhotoKit lets apps access image and video assets managed by Photos, but access requires user authorization and can be limited to selected assets. citeturn151026search4turn151026search0turn151026search2

This is very powerful for solo artists and founders because their real content is often on their phone.

### V4: Auto-posting

Auto-posting is feasible but should come after trust.

Instagram’s Content Publishing API supports publishing images, videos, Reels, and carousel posts for eligible professional accounts. citeturn696144search3 TikTok’s Content Posting API supports direct posting for approved apps and authorized users, with required scopes and app audit before broader public visibility. citeturn307357view0 YouTube’s Data API supports video upload through `videos.insert`. citeturn542392search0

Start with “approve and download/post” or concierge posting. Then add publishing once the quality and trust are high.

## The rights ledger is core product

This cannot be a buried legal checkbox. It should be part of the product.

Every asset should have a rights state:

| Status | Meaning |
|---|---|
| Green | User owns or controls it |
| Yellow | User likely controls it, but rights unclear |
| Red | Third-party IP, celebrity likeness, brand, unclear sample, unlicensed clip |
| Blocked | Jovie should refuse or require manual override/legal clearance |

Every generated post should show:

- music used
- source assets used
- AI model/tool used
- likenesses detected
- third-party brands/characters detected
- disclosure needed
- rights confidence
- platform risk

This becomes a trust feature for labels and managers.

## The hard legal boundary

The legal posture should be:

> Jovie helps create drafts. The customer approves and publishes. The customer must have the rights to every input and must accept responsibility for each output.

This matters because U.S. copyright law still centers human authorship. The U.S. Copyright Office says generative AI outputs are copyrightable only where a human author determines sufficient expressive elements; mere prompts are generally insufficient. It also says works containing AI-generated material may need disclosure and that copyright protection covers the human-authored portions. citeturn877809search4turn877809search1

Training/fine-tuning risk is also unsettled. The Copyright Office’s Part 3 report treats generative-AI training as context-dependent under fair use rather than categorically lawful or unlawful, and major music-label litigation against AI music companies shows the issue is commercially serious. citeturn219133search0turn219133search8

Digital replicas are another major boundary. The Copyright Office recommended federal digital-replica legislation, and California has already enacted performer/digital-likeness protections addressing AI replicas of living and deceased performers. citeturn146497search4turn146497search5

## Product-safe AI rules

Jovie should ship with these rules:

1. **No third-party characters unless licensed.**  
   No Iron Man, Batman, Mickey, SpongeBob, Barbie, etc. Generate original characters with similar energy, not protected characters.

2. **No celebrity likenesses unless authorized.**  
   No Drake voice. No Taylor face. No fake public-figure endorsement.

3. **No private-person likeness without consent.**  
   Especially no exes, fans, minors, random people from old footage, or background people transformed into AI content.

4. **No misleading realism without disclosure.**  
   YouTube requires disclosure for meaningfully altered or synthetic realistic content, including making a real person appear to say/do something they did not, altering real events/places, or generating realistic scenes that did not occur. citeturn410105search0 TikTok requires labeling AI-generated or significantly edited realistic-looking people/scenes and says unlabeled content may be removed, restricted, or labeled. citeturn781461view0 Meta also moved toward labeling AI-generated content across Facebook, Instagram, and Threads using user disclosure and industry signals. citeturn877809search6

5. **No fake endorsements.**  
   Do not show a brand, celebrity, festival, chart, or award implying affiliation.

6. **No unlicensed lyrics unless owned/licensed.**  
   For the artist’s own songs this may still implicate publishers/co-writers, so the rights ledger needs composition ownership.

7. **No scraping that violates platform terms.**  
   Use APIs, user uploads, exports, licensed sources, or user-provided masters.

## Hard disclosure language

Something like this belongs in onboarding and approval:

> **You are responsible for the content you approve and publish.**  
> Jovie may generate, edit, remix, or suggest audio, images, video, captions, lyrics, and other creative material based on assets, prompts, accounts, files, and instructions you provide or authorize Jovie to access. You represent that you own, control, or have all required rights, licenses, permissions, and consents for the materials you provide and for the content you approve, including rights related to music, sound recordings, compositions, lyrics, artwork, video, photographs, trademarks, names, voices, likenesses, publicity rights, and third-party intellectual property.  
>
> You agree not to approve or publish content that infringes or violates another person’s rights, misleads viewers, falsely implies endorsement, uses an unauthorized digital replica, or violates platform rules. You are responsible for any required AI, synthetic-media, sponsored-content, or platform-specific disclosures. Jovie may block, flag, watermark, label, or refuse to generate or publish content that appears legally or commercially high risk.

Then, at the approval point:

> By approving this post, you confirm that you have the rights to the music, visuals, likenesses, lyrics, and AI-generated elements used in this content, and that you accept responsibility for publishing it.

That should be paired with actual controls. A disclaimer alone is weak. A disclaimer plus rights scoring, blocked terms, AI labeling, and audit logs is much stronger.

## The MVP should be “Catalog Reanimation,” not “Video Generator”

The product should feel magical because it finds things and makes decisions.

**Bad MVP:**  
“Upload a song and prompt a video.”

**Good MVP:**  
“Connect your vault. Tomorrow morning, Jovie sends you three finished posts from songs you forgot you had.”

**Best MVP:**  
“Jovie revived my dead catalog without me becoming a content creator.”

## First paid SKU

### Jovie Catalog Reanimation

For artists, managers, labels, and estates.

**Offer:**

- connect/upload catalog
- Jovie audits available assets
- Jovie generates daily vertical posts
- artist approves in one tap
- Jovie publishes or prepares for publishing
- weekly performance recap
- rights/risk review on every post
- artist profile/smart link as traffic destination

**Pricing:**

- founder/indie beta: **$500–$1,500/month**
- manager plan: **$1,500–$5,000/month** for multiple artists
- label/catalog plan: **$5,000–$25,000/month**, depending on catalog size and output volume
- campaign package: **$1,000–$5,000 per 30-day catalog activation sprint**

This should be priced like outsourced creative ops plus AI, not like a profile page.

## The founder dogfood plan

Use your own catalog as the first public proof.

### Week-one style target

Do not overbuild.

Create:

- 20 posts from old songs
- 5 lyric motion posts
- 5 AI visualizers
- 5 old-footage remixes
- 3 story posts
- 2 absurd surreal posts

Then test:

- What feels cringe?
- What feels real?
- What would you actually approve?
- What feels postable today?
- Which old songs suddenly feel alive?
- How little input can you tolerate giving?

The proof is your own behavior. If you start posting again because Jovie makes it painless, that is the signal.

## What the internal system should do

A real Jovie run should look like this:

1. **Harvest**  
   Pull files, links, metadata, captions, lyrics, attachments, thumbnails, comments, and old context.

2. **Understand**  
   Transcribe audio/video, identify choruses, detect best lyric moments, classify mood, detect people/brands, map assets to songs.

3. **Select**  
   Choose the best song/content opportunity for today.

4. **Generate concepts**  
   Produce 10–30 candidate ideas internally.

5. **Risk filter**  
   Remove third-party IP, unclear likenesses, copyrighted characters, fake endorsements, platform-risky outputs.

6. **Render**  
   Generate 2–3 polished vertical videos.

7. **Package**  
   Add caption, hashtags, post time, AI disclosure recommendation, destination link.

8. **Ask for approval**  
   Send via SMS/app/email: approve, skip, edit, regenerate.

9. **Publish**  
   Post or queue.

10. **Learn**  
   Track watch time, saves, comments, follows, link clicks, song streams if available, and approval behavior.

## The approval UX

The artist should receive something like:

> **3 posts ready from your catalog today**  
>  
> **1. “The line still hits”**  
> Song: “X”  
> Format: kinetic lyric + AI night-drive visual  
> Risk: green  
> Disclosure: AI visualizer recommended  
> Caption: “Forgot how much this line still hurts.”  
>  
> Buttons: **Post / Edit / Skip / More like this**

That is the product.

The artist should not need to open a dashboard.

## The taste layer is the moat

A lot of people can generate AI videos. The hard part is deciding what an artist would not be embarrassed to post.

Jovie needs taste filters:

- Does this feel like the artist?
- Does this feel desperate?
- Does this look like generic AI slop?
- Does the caption sound human?
- Does it make the old song feel relevant?
- Would the artist actually approve this?
- Is the AI weird in a good way or cheap in a bad way?
- Is the datedness used intentionally?

The product should learn from approvals and rejections. Every thumbs-down should train taste.

## The artist profile still matters

The profile becomes infrastructure, not the hook.

Jovie Daily drives traffic. The profile captures it.

Profile functions:

- current link destination
- catalog page
- song pages
- merch/tip/payment
- mailing list/SMS capture
- presave when relevant
- tour/show links
- fan conversion
- artist identity source of truth

The profile is the home. Daily content is the engine.

## The bigger vision

This becomes:

> **An autonomous creative department for music catalogs.**

Not a chatbot.  
Not a smart link.  
Not a release checklist.  
Not a prompt-based video toy.

A system that continuously asks:

> “What can we make from this artist’s existing body of work that feels worth posting today?”

That is the category.

## Final recommendation

Build **Jovie Catalog Reanimation** first.

The MVP should be:

> **Connect your vault. Jovie turns your old music into daily posts. Approve by text.**

Use your own catalog as proof. Make the system work even with dated songs, old videos, old emails, old photos, and no new release. Keep the artist profile as the conversion layer. Keep chat as a control surface. Keep auto-posting behind approval. Build the rights ledger from day one.

The best version of this company is:

> **Jovie makes every song in your catalog feel alive again.**


would you apply to yc with this and then explain were pivoting and then the demo wouldnt reflect the currentpitch?


Mr. White, I’d frame this as a YC application narrative issue: the pivot can work if it feels inevitable and the demo still proves the new thesis.


Mr. White, **yes, I’d apply**, but I would **not frame it as “we’re pivoting and the demo doesn’t match.”**

I’d frame it as:

> “We started by building artist profiles and release infrastructure. While dogfooding, we found the sharper problem: artists do not want to become content creators. Jovie now turns an artist’s existing catalog and archive into daily approval-ready social videos.”

That sounds like insight, not confusion.

YC explicitly says clarity matters a lot in the application, and that the first sentence should explain the company in the simplest possible terms. They also say many funded startups change their idea significantly, so a pivot itself is fine. The problem is a muddy story. citeturn777864view1

## My answer

Apply with the **current pitch**:

> **Jovie is an AI catalog reactivation engine for music artists. It connects to an artist’s old songs, videos, photos, Drive, email, and YouTube, then generates daily social videos they approve and post.**

Then explain the old demo like this:

> “The current product started as the artist profile / release hub. That product gave us the foundation: artist identity, catalog data, links, fan conversion, and release context. We’re now using that foundation to build the higher-value workflow: autonomous catalog content generation.”

Do **not** say:

> “We’re pivoting, and the demo doesn’t reflect the pitch.”

Say:

> “The existing product is the foundation. The new wedge is catalog autopilot.”

## The demo issue

The demo cannot be purely old Jovie profile stuff. That will make the application feel incoherent.

You need a **rough demo of the new loop**, even if it is partially manual or stitched together.

It can be extremely simple:

1. Connect/import catalog assets.
2. Jovie finds songs, videos, lyrics, old photos, and context.
3. Jovie generates 3 daily post candidates from an old song.
4. Artist approves one.
5. Jovie outputs/publishes the video.
6. The artist profile becomes the destination link.

That demo can be a Loom, Figma, hacked internal flow, Airtable backend, or concierge workflow. YC’s application video is supposed to be founders talking, not a product demo, and YC provides a separate place for the demo. citeturn777864view3

## The right application narrative

Use this structure:

### What are you making?

> Jovie turns dormant music catalogs into daily social videos. Artists connect their songs, old videos, photos, emails, Drive folders, and YouTube channel; Jovie finds usable material, generates modern vertical posts, and sends them for one-tap approval.

### What changed?

> We originally built artist profiles and release tools. While using it ourselves and talking to artists, we realized the bigger problem is evergreen content generation. Artists do not want to be Instagrammers. They want their music catalog to keep working without them becoming full-time content creators.

### What exists today?

> We have the artist profile/release infrastructure live, and we’re now building the catalog-autopilot layer on top of it. The demo shows the new workflow using our own dormant catalog: old music in, daily videos out.

### Why now?

> AI video, multimodal retrieval, and social distribution make it possible to reactivate old songs at scale. Legacy catalogs and inactive artists have huge archives, but no daily creative operating system.

### Why you?

> We are artists/builders solving our own problem. The founder has a dormant catalog and can dogfood immediately. If Jovie can reactivate our own catalog, we can sell the same workflow to artists, managers, labels, and catalog owners.

## What I’d submit

I’d submit **two links** if the application allows it:

1. **Existing Jovie product**  
   Shows you have shipped something real.

2. **New Catalog Autopilot demo**  
   Shows the current thesis.

The second link matters more.

If you only show the old profile product, YC may think you are applying with one idea while talking about another. If you show the old product plus a scrappy new workflow, it looks like fast iteration.

## Timing

YC is currently accepting late applications for the Summer 2026 batch. The on-time deadline was May 4, 2026 at 8pm PT, but YC says late applications are still considered, with less predictable response timing. citeturn777864view2

So I would apply, but I’d first create the minimum believable catalog-autopilot demo.

## The strongest possible sentence

Use this:

> **Jovie is an AI creative department for music catalogs: it turns an artist’s old songs, videos, photos, and archive into daily social posts they approve in one tap.**

That is the company.

The old artist profile is supporting infrastructure. The new wedge is the thing you sell.


help me imaging this then. what does the flow look like. is this an ios app? is this a web app/desktop app? all? what does the yc demo worthy flow look like. 


Mr. White, I’d separate the eventual product surface from the YC-demo surface. The demo should be much narrower than the final app.
