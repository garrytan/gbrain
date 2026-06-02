
Mr. White — work backward from the demo and build **one narrow live loop**:

> **Jovie finds an opportunity → recommends a drop → artist approves → Jovie makes it live → fans are notified → money comes in → Jovie measures what happened.**

Do **not** start by building the whole AI manager. Start by building the smallest thing that can increase **MRI: Monthly Recurring Income** for an artist and for Jovie.

YC framing: launch fast, talk to users, make a few users love you, measure the thing that matters, and do unscalable things manually until the pattern is obvious. Paul Graham’s “Startups in 13 Sentences” explicitly emphasizes launching fast, understanding users, making a few users love you, measuring carefully, spending little, and getting ramen profitable. citeturn394903view2 YC also says a demo should be a working version of what you’ve built or plan to build, and they care about growth, usage, retention, unit economics, and what surprises you about users. citeturn394903view3

# The wedge to build first

Build this:

> **Jovie Surprise Drops**  
> An AI-assisted campaign engine that turns catalog + fan/link data + external signals into one-click merch or commerce drops.

The first version does **not** need a fully autonomous trend crawler, full Printful API integration, full artist graph, full manager agent, or perfect chat. It needs to make one thing real:

> An artist can approve a campaign, and Jovie can make the campaign live without the artist setting up products, checkout, notifications, or fulfillment.

That is the product wedge.

# What should be real vs. faked

For the **cinematic demo**, you can seed the EDC/Cosmic Gate/Prime Day opportunity. EDC Las Vegas 2026’s official lineup and set-times include Cosmic Gate on Friday, May 15, and Amazon has officially announced Prime Day 2026 for June, so this is a strong demo seed. citeturn494896search0turn494896search2turn494896search1

For the **live product**, do not depend on fully automated trend detection first. Let a human/Jovie operator create the opportunity behind the scenes. The user experience can still be:

> “Jovie found this.”

That is a classic YC move: do the hard thing manually until you know what to automate.

# The MVP product

## User-facing promise

> “Jovie watches your catalog, fan activity, and market signals, then turns the best moments into revenue-driving drops.”

## First live use case

A small number of artists get one campaign:

```text
Jovie found a timely opportunity for one song.
Jovie recommends a drop.
Artist approves.
Jovie makes it live on the artist profile.
Jovie sends/schedules the fan notification.
Jovie handles checkout, payments, and fulfillment.
Jovie reports revenue and next steps.
```

## The actual first campaign type

Start with **limited merch drops**, because they are concrete, visual, revenue-linked, and demo well.

Later expand to:

```text
VIP drops
paid fan clubs
tip campaigns
presave/save campaigns
ticket/show campaigns
content campaigns
press campaigns
playlist campaigns
remix contests
private listening parties
```

But the first wedge is merch because it proves revenue.

# The build order

## Build 1 — Campaign object and state machine

This is the foundation.

Create a backend model for a campaign/drop.

```ts
Campaign {
  id
  artistId
  title
  type // merch_drop, fan_notification, release_push, tip_campaign
  status // draft, recommended, approved, scheduled, live, completed
  sourceOpportunityId
  revenueTargetCents
  launchAt
  endAt
  selectedAudienceSegmentId
  productId
  notificationId
  profileModuleId
  createdBy // jovie_agent, admin, artist
  approvedBy
  approvedAt
}
```

Statuses should be simple:

```text
recommended → approved → scheduled → live → completed
```

The demo needs to show “Jovie does the work,” so the backend needs one command:

```text
Approve campaign
```

That command should trigger:

```text
create product
publish to artist profile
update Jovie Link
create notification draft
schedule notification
create content tasks
enable tracking
```

Even if some steps are manually fulfilled behind the scenes, the product needs the state machine now.

## Build 2 — Opportunity object

Do not build a full trend engine yet. Build an **Opportunity** model.

```ts
Opportunity {
  id
  artistId
  title
  description
  confidence
  status // detected, recommended, dismissed, converted
  externalSignals[]
  matchedEntities[]
  recommendedAction
  createdBy // admin, system, agent
}
```

For the demo:

```json
{
  "title": "Cosmic Gate festival attention spike",
  "externalSignals": [
    "Cosmic Gate is playing EDC this weekend",
    "Prime Day is coming in June"
  ],
  "matchedEntities": [
    "The Deep End",
    "Cosmic Gate",
    "Tim White",
    "Trance fan segment"
  ],
  "recommendedAction": "Launch The Deep End Weekend Drop next Friday"
}
```

The initial version can be admin-created. That is fine. The user sees it as Jovie surfacing the opportunity.

## Build 3 — Entity chips in chat

This is one of the most important UI pieces because it makes Jovie feel like it has memory.

When the chat mentions:

```text
The Deep End
```

It should render as:

```text
🎵 The Deep End
```

Expanded card:

```text
The Deep End
Tim White × Cosmic Gate
Release history
Fan activity
Jovie Link activity
Campaign opportunities
```

For the MVP, entity chips only need to support:

```text
Song
Artist
Collaborator
Campaign
Product
Fan segment
```

Do not build universal entity recognition. Start with known entities from the database and match by name.

## Build 4 — Campaign recommendation card

This is the core UI.

Jovie should not just output a paragraph. It should render a structured card:

```text
Recommended:
The Deep End Weekend Drop

Launch:
Next Friday · 10:00 AM

Goal:
$10k test campaign

Best product:
The Deep End Tee

Why:
Cosmic Gate is in a high-attention festival window.
The Deep End is a relevant catalog match.
Your trance segment has recent Jovie Link activity.
Prime Day is coming in June.

Approve?
```

Buttons:

```text
Approve drop
Edit
Show audience
Dismiss
```

The **Approve drop** button is the key product action.

## Build 5 — Product/merch module on artist profile

The artist profile must be able to display a live merch product.

Minimum product object:

```ts
Product {
  id
  artistId
  campaignId
  name
  description
  priceCents
  imageUrl
  status // draft, active, hidden, sold_out
  fulfillmentMode // manual, printful, shopify, external
  checkoutMode // stripe_checkout, external_url
}
```

Artist profile module:

```text
The Deep End Weekend Drop
Limited tee · Live next Friday
[Buy]
```

This is where the demo becomes real. The campaign must appear on the public artist profile.

## Build 6 — Checkout and payments

For the first live wedge, I would **not** start with Printful. I would start with **Stripe Checkout** or existing Jovie payment rails.

Why: the first KPI is MRI. You need money captured before you need fulfillment automation.

Minimum:

```text
Product page
Buy button
Stripe Checkout
Order record
Payment success webhook
Artist/campaign revenue attribution
```

Backend:

```ts
Order {
  id
  artistId
  campaignId
  productId
  fanId
  stripeSessionId
  amountCents
  status // pending, paid, refunded, fulfilled
  shippingAddress
  createdAt
}
```

Use Stripe Checkout to collect shipping address and payment. Then fulfill manually for the first few drops.

## Build 7 — Manual fulfillment first, Printful later

Do **not** build the full Printful integration first.

Build this instead:

```text
Fulfillment mode: manual
```

The artist experience is still:

> “There’s nothing for the artist to set up.”

Because **Jovie handles fulfillment** behind the scenes.

Add Printful only after:

```text
3–5 successful drops
real order volume
repeatable product types
manual fulfillment becomes painful
```

The Printful integration becomes worth it when you know artists actually approve drops and fans actually buy. Until then, Printful is a distraction.

When you do integrate Printful, you need:

```text
product template sync
variant/size sync
mockup generation
shipping rates
order creation
fulfillment status webhooks
tracking numbers
refund handling
```

But for the first live wedge: **manual or semi-manual fulfillment is correct**.

## Build 8 — Fan notification scheduler

This is the second most important execution primitive after checkout.

Minimum notification object:

```ts
Notification {
  id
  artistId
  campaignId
  channel // sms, email, push
  audienceSegmentId
  message
  status // draft, scheduled, sent
  scheduledAt
  sentAt
}
```

The UI should show:

```text
Fan text scheduled
Audience: 12,482 fans
Send time: Friday 10:00 AM
```

For the first version, send only to fans who have clearly opted in. Include opt-out handling. Keep it simple and compliant.

The fan notification should feel like:

```text
The Deep End drop goes live next Friday.
Limited tee inspired by the track with Cosmic Gate.
First access: jov.ie/timwhite
```

No customizable email-builder UI. That is the wrong product. The wedge is:

> Jovie knows what to send, who to send it to, and when.

## Build 9 — Event tracking / fan graph

This is the data layer that makes the product compound.

Track every meaningful fan action:

```ts
FanEvent {
  id
  artistId
  fanId
  campaignId
  entityType
  entityId
  type // profile_view, link_click, listen_click, sms_open, sms_click, purchase, tip, reply
  source
  metadata
  createdAt
}
```

You need this before the AI gets smart.

Initial segments:

```text
All fans
Prior Jovie Link clickers
Prior buyers
Trance-engaged fans
SMS subscribers
High-intent fans
```

Do not overbuild segmentation. Start with rule-based segments.

## Build 10 — Monitoring panel

After launch, Jovie should report:

```text
Clicks
Purchases
Conversion rate
Revenue
Replies
Top fan segment
Recommended next action
```

Campaign result model:

```ts
CampaignMetrics {
  campaignId
  profileViews
  productViews
  checkoutStarts
  purchases
  revenueCents
  notificationSent
  notificationClicks
  conversionRate
}
```

This closes the loop.

# UI elements to create

## 1. Jovie opportunity alert

```text
Jovie found an opportunity.
```

Expanded:

```text
Cosmic Gate is playing EDC this weekend.

You have a relevant song:
🎵 The Deep End
Tim White × Cosmic Gate
```

## 2. Evidence/data map

Not a paragraph. Use cards.

```text
External signal
Cosmic Gate festival attention
```

```text
Catalog graph
The Deep End · Tim White × Cosmic Gate
```

```text
Fan activity
Prior Jovie Link clicks, listens, signups, purchases
```

```text
Audience overlap
Tim fans + Cosmic Gate audience proxy
```

```text
Commerce signal
Prime Day coming in June
```

Important: say **audience proxy** or **overlap signal** unless you actually have Cosmic Gate’s first-party fan graph. Do not imply you have private fan data from Cosmic Gate unless they are connected.

## 3. Recommendation card

```text
Recommended:
The Deep End Weekend Drop

Launch:
Next Friday · 10:00 AM

Goal:
$10k test campaign

Best product:
The Deep End Tee

Approve this and I’ll make it live.
```

## 4. Merch design cards

Three cards:

```text
The Deep End Tee
The Deep End Poster
The Deep End Hoodie
```

Each card needs:

```text
image
price
target audience
revenue path
recommendation reason
approve button
```

## 5. Approval/execution checklist

This is the emotional payoff.

```text
✓ Merch item created
✓ Product page live
✓ Artist profile updated
✓ Jovie Link updated
✓ Fan text scheduled
✓ Content tasks created
✓ Payments connected
✓ Fulfillment handled
✓ Monitoring enabled
```

## 6. Artist profile product module

```text
The Deep End Weekend Drop
Limited tee · Live next Friday
[Buy]
```

## 7. Fan text preview

```text
The Deep End drop goes live next Friday.
Limited tee inspired by the track with Cosmic Gate.
First access: jov.ie/timwhite
```

## 8. Campaign status view

```text
The Deep End Weekend Drop

Status: Scheduled
Profile: Live
Text: Scheduled
Payments: Ready
Fulfillment: Ready
Monitoring: On
```

## 9. Onboarding import view

This should exist for the demo and product.

```text
Catalog imported
Collaborators mapped
Fan graph created
Release workflows generated
Jovie Link activated
Notifications connected
Payments connected
```

## 10. Release workflow view

This proves domain expertise.

```text
Release workflow
Metadata
Smart link
Fan notification
Press targets
Playlist targets
Content calendar
Merch opportunity
Post-release reporting
```

# Backend services to build

## Required for V0

```text
CampaignService
OpportunityService
ProductService
ProfilePublisher
CheckoutService
OrderService
NotificationService
FanEventService
MetricsService
```

## Optional for V0, required later

```text
PrintfulService
TrendSignalService
SpotifyCatalogImportService
TikTokTrendService
GoogleTrendsService
Bandsintown/SongkickEventService
PressScoringService
AgentTaskRunner
```

# Integrations

## Build now

### 1. Stripe Checkout or existing payment rails

Needed because MRI requires money.

Use for:

```text
checkout
shipping address capture
payment success webhooks
revenue attribution
```

### 2. SMS/fan notification provider

Use whatever Jovie already has. If nothing exists, use the fastest compliant SMS provider path.

Needed for:

```text
scheduled fan text
click tracking
reply tracking if available
```

### 3. Existing Jovie Link/profile publishing

This is core. The product must appear on the artist profile.

### 4. Event tracking

Needed for:

```text
profile views
link clicks
checkout starts
purchases
fan segment creation
campaign analytics
```

## Do later

### Printful

Add after manual drops prove demand.

### Spotify/Apple catalog import

If you already have catalog data, use it. If not, start with manual import or CSV for the first artists.

### External trend data

Start manually. Later pull from:

```text
tour calendars
festival lineups
social trend velocity
YouTube velocity
TikTok sounds
Google Trends
commerce calendar
```

### Shopify

Only integrate if artists already have Shopify stores and you need to publish there. Otherwise, Jovie should own the profile/checkout experience first.

# What I would start editing first

## Priority 1 — Campaign primitives

Edit/create:

```text
models/Campaign
models/Opportunity
models/Product
models/Order
models/Notification
models/FanEvent
```

Then build:

```text
approveCampaign(campaignId)
```

That function is the whole wedge.

It should run:

```text
1. set campaign status = approved
2. create product
3. publish product to artist profile
4. create checkout session/product price
5. create notification draft
6. schedule notification
7. create content tasks
8. enable monitoring
```

## Priority 2 — Artist profile product module

If the campaign cannot appear on the public artist profile, the demo is fake.

Build:

```text
ArtistProfileProductBlock
CampaignProductCard
BuyButton
```

## Priority 3 — Checkout and order attribution

MRI requires attribution.

Build:

```text
createCheckoutSession(productId, fanId?)
handleStripeWebhook()
createOrderFromPayment()
attributeRevenueToCampaign()
```

## Priority 4 — Fan notification draft/schedule

Build:

```text
NotificationPreview
ScheduleNotification
SendNotificationJob
TrackNotificationClick
```

## Priority 5 — Opportunity UI

Build:

```text
OpportunityAlert
EvidenceMap
RecommendationCard
ApproveCampaignButton
ExecutionChecklist
```

## Priority 6 — Demo seed route

Build a deterministic route for the cinematic demo:

```text
/demo/jovie-opportunity
```

Seed it with:

```text
Cosmic Gate EDC signal
The Deep End catalog match
Prime Day commerce window
Jovie Link activity
Three merch designs
Approve tee
Campaign scheduled
```

This lets you record the Loom and also gives Codex/Playwright a stable target.

# Narrowest live version

The first live version can be almost embarrassingly small.

## Artist sees

```text
Jovie found an opportunity.
Approve this drop?
```

## Artist clicks

```text
Approve
```

## Jovie does

```text
creates product page
puts product on profile
creates checkout
schedules fan text
tracks purchases
reports revenue
```

## Jovie team does manually behind the scenes

```text
curates opportunity
creates merch design
sets up fulfillment
checks quality
handles edge cases
```

That is fine. That is the right amount of unscalable.

# What not to build first

Do **not** start with:

```text
full Printful integration
full autonomous trend detection
full open-ended AI chat
full universal artist graph
full cross-artist fan graph
full press-list intelligence
full release operating system UI
full multi-agent dashboard
custom email campaign builder
complex merch editor
```

Those are expansion layers.

The first live wedge is:

> **Approve a recommended drop and make money.**

# How this expands

## Phase 1 — Surprise merch drops

```text
catalog match
fan segment
product drop
notification
checkout
fulfillment
monitoring
```

## Phase 2 — Release workflows

```text
catalog import
release task generation
smart link
content plan
fan notification
post-release report
```

## Phase 3 — Opportunity engine

```text
festival signals
tour signals
collaborator signals
commerce signals
social trend signals
platform activity
```

## Phase 4 — Agentic execution

```text
release agent
merch agent
fan agent
press agent
content agent
payments agent
```

## Phase 5 — Full operating system

```text
artist profile
smart links
catalog graph
fan graph
payments
merch
press
content
release ops
AI manager
```

# MRI-first KPI stack

Assuming MRI means **Monthly Recurring Income**, I would measure this:

## North Star

```text
Artist MRI generated through Jovie
```

Definition:

```text
Recurring monthly artist income attributable to Jovie campaigns, links, notifications, tips, merch, paid drops, or fan monetization.
```

## Company KPI

```text
Jovie MRI
```

Definition:

```text
Jovie recurring revenue from subscriptions, take rate, payment margin, fulfillment margin, or platform fees.
```

## First wedge metrics

```text
campaigns approved per artist per month
approved campaigns that go live
time from recommendation to live
GMV per campaign
artist revenue per campaign
Jovie revenue per campaign
notification click rate
profile conversion rate
checkout conversion rate
repeat campaign rate
```

## The one metric I would obsess over first

```text
Revenue per approved opportunity
```

Because that tells you whether Jovie is actually finding valuable moments.

Second:

```text
Artist approval rate
```

Because if artists do not approve Jovie’s recommendations, the AI manager is not trusted.

Third:

```text
Time from approval to live
```

Because “Jovie does the work” only matters if it is fast.

# The first 2-week sprint

## Days 1–2

Build data models:

```text
Opportunity
Campaign
Product
Order
Notification
FanEvent
```

Seed the demo opportunity.

## Days 3–4

Build UI:

```text
Opportunity alert
Evidence map
Recommendation card
Merch cards
Approve button
Execution checklist
```

## Days 5–6

Build artist profile product module:

```text
product appears on profile
buy button works
campaign status updates
```

## Days 7–8

Build checkout:

```text
Stripe Checkout
payment webhook
order created
campaign revenue attribution
```

## Days 9–10

Build notification scheduling:

```text
fan text preview
audience segment
schedule/send
click tracking
```

## Days 11–12

Build monitoring:

```text
views
clicks
orders
revenue
conversion
next recommendation placeholder
```

## Days 13–14

Run it with 1–3 real artists:

```text
Tim
one friendly artist
one external artist
```

Do the fulfillment manually.

# The “go live” bar

Do not wait for all of this to be beautiful.

The live bar is:

```text
1. Artist can approve a drop.
2. Product appears on artist profile.
3. Fans can buy.
4. Fans can be notified.
5. Revenue is attributed to the campaign.
6. Jovie shows what happened.
```

If those six things work, you have the wedge.

# The Codex prompt I would give

```text
Build the narrow live wedge for Jovie Surprise Drops.

Goal:
An artist can approve a Jovie-recommended opportunity and Jovie will create a campaign, publish a product to the artist profile, create checkout, schedule a fan notification, and track campaign revenue.

Start with deterministic seeded data for Tim White / The Deep End / Cosmic Gate / EDC / Prime Day.

Do not build full trend detection or Printful integration yet. Use manual fulfillment mode and Stripe Checkout.

Required models:
Opportunity, Campaign, Product, Order, Notification, FanEvent, CampaignMetrics.

Required UI:
OpportunityAlert, EvidenceMap, RecommendationCard, MerchOptionCard, ApproveCampaignButton, ExecutionChecklist, ArtistProfileProductBlock, NotificationPreview, CampaignStatusPanel.

Required backend action:
approveCampaign(campaignId), which creates/publishes product, creates checkout info, schedules notification, creates tasks, and enables monitoring.

Build a demo route at /demo/jovie-opportunity and a real route under the artist dashboard.
```

# Final recommendation

Start building **Surprise Drops**.

Not “AI manager.”  
Not “ops dashboard.”  
Not “Printful integration.”  
Not “trend engine.”  

Build the one loop that proves the company:

> **Jovie finds a moment, ships the campaign, and creates monthly income for the artist.**

Once that works, everything else expands naturally.
