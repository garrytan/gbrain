---
title: "Band T-Shirt Generator"
type: guide
created: 2026-05-24
updated: 2026-05-24
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Band T-Shirt Generator

> **Source:** ChatGPT conversation
> **Date:** 2026-05-24T02:30:00Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

I need a prompt for world class band t-hsirt generation. it should pull artist context from jovie and Then automatically generate 3 designs and show em. User selects one. Learn from the selection in the future. should like like real band merch or grashic tees In the top seven brands. not like a bs shirt bought on teespring or some shit. like real fashion that youd be proud to sell. should also pull from the printful inventory and be able to create any item printful supports. if none specified it picks on.

## Answer

I’ll turn this into a production-grade prompt for a merch-generation agent, covering Jovie artist context, Printful catalog selection, three design options, quality standards, user choice, and preference learning.

## Answer

Mr. White, use this as the **master system prompt** for the merch-generation agent.

Printful-specific constraints to encode: Printful’s catalog is built around products and variants, and real creation/order flows should use **variant IDs**, since variants represent the exact physical blank, size, color, and attributes. Printful also notes that product stock changes daily and should be checked by region/availability endpoints. Jewelry products are excluded from API support. Mockups and uploaded print files can process asynchronously, so the agent should create tasks and poll or use webhooks rather than assuming instant completion. citeturn422439view1turn416091view3turn277174view0turn416091view2

Jovie currently positions itself as an AI artist manager that watches an artist’s catalog and helps ship fan-facing actions like presaves, fan paths, playlist pitches, release pages, media assets, and artist profiles. That makes it the correct context source for artist identity, catalog, release visuals, audience, and campaign strategy. citeturn316100view0

```text
You are Jovie’s world-class music merch creative director and production agent.

Your job is to generate premium, sellable, fashion-grade merch for artists using:
1. The artist’s context from Jovie.
2. The live Printful product catalog, variants, availability, placements, techniques, mockup styles, and print-file requirements.
3. The user’s prior merch preferences and selection history.

The output must feel like legitimate band merch or a premium graphic tee from a top-tier streetwear, fashion, or tour-merch brand. It must never look like generic print-on-demand, Teespring, Canva, Etsy-template, AI-slop, or fan-art merch.

Core objective:
Generate exactly 3 distinct merch design directions, render them as realistic product mockups, show them to the user, let the user select one, then save the selection signal so future generations improve.

Inputs:
- artist_id or artist_name: required.
- user_id: required.
- item_type: optional. Examples: t-shirt, hoodie, crewneck, tote, hat, poster, long sleeve, crop tee, jacket, mug, phone case, etc.
- region: optional. Default to the user/store’s primary selling region.
- release_id, song_id, tour_id, campaign_id, or mood: optional.
- price_band: optional. Default to “premium but commercially sane.”
- design_mode: optional. Default to “fashion-grade band merch.”
- quantity/use_case: optional. Examples: online drop, tour table, limited capsule, fan club, VIP bundle.

Available tools:
- JOVIE.getArtistProfile(artist_id)
- JOVIE.getArtistCatalog(artist_id)
- JOVIE.getReleaseAssets(artist_id, release_id)
- JOVIE.getBrandKit(artist_id)
- JOVIE.getAudienceInsights(artist_id)
- JOVIE.getSocialContext(artist_id)
- JOVIE.getCampaignContext(artist_id, campaign_id)
- MEMORY.getMerchPreferenceProfile(user_id, artist_id)
- MEMORY.saveMerchSelection(user_id, artist_id, selection_payload)
- PRINTFUL.getCatalogProducts(filters)
- PRINTFUL.getCatalogProduct(product

*(Answer truncated — 14757 chars total)*

## Question

the end goal should be that i can ask jovie to create a merch item and she shows me 3 design and i pick one and she creates a merch card and make it for sale on the profile. users purchase and we fullfil. for mvp, we'll accept payments on behalf of artist and pay them out manually. later well add stripe connect or whatever unless its easy to build that first. then users cna kill or create merch from chat and we auto resort cards based on popular merch or most likely to sell to a user.

## Answer

I’ll fold this into a product-ready MVP spec and agent prompt covering chat creation, 3-design selection, merch cards, profile sales, Printful fulfillment, manual payouts, and ranking logic.

## Answer

Mr. White, the product goal is clearer now:

> **Jovie should let an artist say “make merch,” generate 3 premium designs, let the artist pick one, create a live merch card on the artist profile, sell it to fans, route fulfillment through Printful, and track sales/payouts.**

For the MVP, I’d **avoid Stripe Connect at first** unless you already want artist onboarding/KYC in scope. Use normal Stripe Checkout/PaymentIntents under Jovie, maintain an internal artist royalty ledger, and pay artists manually. Stripe Connect can come later through destination charges or separate charges/transfers. Stripe’s Connect docs support both: destination charges create a charge on the platform and immediately transfer funds to a connected account, while separate charges/transfers create the charge on the platform and move funds later, with the platform responsible for fees, refunds, and chargebacks. citeturn951997view0turn951997view1

Printful should be treated as the fulfillment backend. Use catalog products for browsing, but use **variant IDs** for actual purchasable items/orders; Printful explicitly says product IDs are for browsing and variant IDs represent the actual physical blank. citeturn729114view0 Printful v2 currently supports catalog, files, mockups, orders, shipping rates, and webhooks, while v2 product-management/sync-product endpoints are marked unavailable; for MVP, create your own Jovie merch card/product record and create Printful orders directly after purchase. citeturn199395view2turn199395view1

## Revised master prompt

```text
You are Jovie’s merch creation agent.

Your job is to let an artist create, publish, sell, manage, and retire merch from chat.

The desired user experience:
The artist can say:
- “Jovie, make me merch.”
- “Create a hoodie for this release.”
- “Make a premium tee for my profile.”
- “Kill that black hoodie.”
- “Make the Static Bloom tee live again.”
- “Create merch for my top fans.”
- “Make something that would actually sell.”

Jovie must:
1. Pull artist context from Jovie.
2. Pull available product/variant/placement data from Printful.
3. Generate 3 premium merch design options.
4. Show realistic mockups.
5. Let the artist pick one.
6. Create a merch card on the artist profile.
7. Make the item purchasable.
8. Route fan purchases through Jovie checkout.
9. Send paid orders to Printful for fulfillment.
10. Track revenue, margin, fulfillment status, and artist payout liability.
11. Learn from each artist/user selection.
12. Allow merch cards to be created, killed, edited, ranked, and resurfaced from chat.

Quality standard:
The merch must look like real band merch, tour merch, premium streetwear, or high-end graphic tees from a top fashion/streetwear ecosystem. It must never look like generic print-on-demand, Teespring, Canva, Etsy-template, fan-art, or AI-slop.

Core commands Jovie must support:
- create_merch
- preview_merch_options
- select_merch_design
- publish_merch_card
- update_merch_card
- pause_merch_c

*(Answer truncated — 17130 chars total)*
