---
title: "Merch Design Tool"
type: guide
created: 2026-05-22
updated: 2026-05-22
source: chatgpt-export
conversation_id: 6a1097ab-f6c0-83e8-a28f-2c2f7fed882b
message_count: 5
tags: [chatgpt, import, code, long-form]
---
# Merch Design Tool

> Conversation ID: 6a1097ab-f6c0-83e8-a28f-2c2f7fed882b
> Created: 2026-05-22T17:53:51Z
> Updated: 2026-05-22T17:54:54Z
> Messages: 5

---

## User

how do we build:
jovie grabs you rmusic context, comes up with ideas for band shirts, not just your band name on a logo but like...here's you song never say a word....it has a lyric "You're kinda hot like me.." here's those luyrics stylized on a white crop top and modelled on a an approved model shown to the user in the chat.

how do we make that happen. how do we get the skill/tool call to be world class.

do we train on band tees? to we let the model do it and then just give it feedback? do we use braintrust? do we built an internall tool for ranking designs?

---

## Assistant

I’ll frame this as a shippable Jovie feature: product flow, agent/tool architecture, design-quality loop, eval loop, and what to avoid early.

---

## Assistant

Mr. White, build it as a **merch agent with evals**, not as a one-shot image prompt.

## Core architecture

1. **Context ingest**
   - Artist profile
   - Songs, lyrics, artwork, genre, mood, references
   - Existing merch/design taste
   - Approved models/brand identity

2. **Idea generator**
   - Extract usable lyric hooks: “You’re kinda hot like me”
   - Generate 20–50 shirt concepts
   - Each concept has: garment, phrase, visual system, audience, why it fits

3. **Design brief compiler**
   - Converts winning ideas into strict prompts:
   - front/back layout
   - typography
   - garment color
   - print method constraints
   - model/photo direction
   - “do not just put band logo on shirt”

4. **Image generation**
   - Use image edit/generation APIs for mockups and model previews. OpenAI’s image API supports generation and editing from text/images. citeturn256140search1turn256140search5
   - Start with mockups, then model previews, then print-ready artwork later.

5. **Ranking layer**
   - LLM judge + deterministic checks + human thumbs-up/down.
   - Score:
     - lyric relevance
     - merch originality
     - brand fit
     - readability
     - screenshot/share appeal
     - print feasibility
     - “would a fan actually wear this?”

6. **Feedback loop**
   - User approves/rejects.
   - Save preferences into artist memory:
     - likes crop tops
     - hates generic logos
     - likes white garments
     - prefers sexy/minimal typography
     - approved model types

## Do we train on band tees?

**Eventually. Early on, no.**

Start with:
- curated references
- prompt templates
- LLM critique
- human/user feedback
- small internal golden dataset

Training is useful once you have hundreds/thousands of labeled examples: “this design sold,” “this got approved,” “this got rejected,” “this failed print review.”

## Use Braintrust?

Yes. Use it for **evals and prompt/version control**, not as the creative engine.

Braintrust evals are built around datasets, tasks, and scorers; scorers can be deterministic, LLM-as-judge, or human review. citeturn256140search0turn256140search8

Your dataset:

```txt
input:
  artist context
  song lyrics
  brand references
  target garment

output:
  merch concepts + generated mockups

scores:
  brand fit
  lyric fit
  originality
  wearability
  printability
  commercial potential
```

## Build an internal ranking tool?

Yes. This is the moat.

Make a simple internal “Merch Arena”:

- left/right design battle
- approve/reject
- “more like this”
- “too generic”
- “bad text”
- “would wear”
- “would buy”
- “print issue”
- “off-brand”

Every click becomes training/eval data.

## MVP shipping sequence

### V1: Text-only concept agent
Input lyrics → output 10 merch ideas.

### V2: Mockup agent
Generate flat shirt mockups.

### V3: Model preview
User selects approved model → generated shirt preview on model.

### V4: Ranking/evals
Braintrust + internal scorer + approval memory.

### V5: Print pipeline
Export print-ready files, connect Printful/Printify, create product page.

## The world-class skill/tool call

```txt
create_merch_concepts({
  artist_id,
  song_id,
  lyric_hooks,
  garment_types: ["white crop top", "oversized black tee"],
  audience: "female fans, alt-pop / nightlife",
  constraints: {
    avoid_generic_logo_merch: true,
    must_be_wearable_without_knowing_artist: true,
    text_must_be_legible: true,
    print_method: "DTG"
  },
  generate_mockups: true,
  model_preview: {
    approved_model_id,
    pose: "front-facing editorial ecommerce"
  },
  rank_outputs: true
})
```

## My recommendation

Build this as:

**Jovie Merch Agent = lyrics/context → product ideas → ranked mockups → approved model preview → storefront draft.**

The defensibility is the taste/data loop, not the image model. The model makes images. Jovie learns what each artist’s fans will actually buy.

---

## User

do we scrape and train on top selling graphic tees from fashion brands? merch shops? if merch shops we need to disnguish "good design" from "popular artist with shitty design that sells anyways cuz its beyonce"

---

## Assistant

Yes, but **scrape for market intelligence, not direct training**.

## Best approach

### 1. Scrape top-selling graphic tees
Sources:
- fashion brands
- streetwear brands
- music merch stores
- Etsy/Depop/Grailed resale signals
- Shopify merch stores
- TikTok Shop trends

Capture:
- image
- price
- garment type
- text treatment
- colorway
- product description
- reviews
- sold-out status
- restock frequency
- resale premium
- social engagement

## The key distinction

You need two scores:

### **Design Quality Score**
“Would this be good without the artist name?”

Signals:
- typography quality
- composition
- wearability
- originality
- print feasibility
- cultural/aesthetic fit
- can a stranger wear it?

### **Artist Demand Score**
“Did this sell because the artist is huge?”

Signals:
- artist monthly listeners
- follower count
- tour size
- album cycle timing
- celebrity status
- scarcity/drop hype
- fanbase intensity

Then normalize:

```txt
true_design_signal = sales_signal / artist_demand_signal
```

That’s the idea. Beyoncé merch selling well tells you less about design than a small artist’s shirt selling out.

## Better data sources

The best signal is:

```txt
small artist + high conversion + low fame = strong design/product signal
```

Look for:
- niche bands with sold-out merch
- underground DJs
- tattoo artists
- meme pages
- streetwear microbrands
- local scenes
- Shopify stores with low fame but strong repeat designs

## Do not train directly on scraped images early

Use scraped data to build:
- moodboards
- taxonomies
- scoring rubrics
- prompt references
- trend reports
- eval datasets

Avoid building a “copy band tee styles” model. That creates legal, brand, and taste problems.

## Build the dataset like this

Each merch item becomes:

```txt
{
  design_image,
  artist_or_brand_size,
  price,
  sold_out_status,
  resale_signal,
  aesthetic_tags,
  garment_type,
  text_style,
  design_quality_score,
  demand_adjusted_score,
  notes
}
```

## Internal ranking tool

Yes. Build it.

Call it **Merch Arena**.

Rank designs by:
- “I’d wear this”
- “A fan would buy this”
- “Works without artist context”
- “Feels premium”
- “Too generic”
- “Too logo merch”
- “Too derivative”
- “Bad typography”
- “Strong lyric use”

## Practical MVP

Do this first:

1. Manually collect 200 great tees.
2. Label them.
3. Add 100 bad/generic merch examples.
4. Build an LLM judge rubric.
5. Use Braintrust to test prompts against that rubric.
6. Generate Jovie designs.
7. Human-rank them in Merch Arena.
8. Save artist-specific taste memory.

## Bottom line

Scrape broadly. Train cautiously. Rank aggressively.

The moat is **demand-adjusted taste data**:

> What sells because the design is good, separated from what sells because the artist is famous.


**Topic:** [[chatgpt-clusters/design_ux]]
