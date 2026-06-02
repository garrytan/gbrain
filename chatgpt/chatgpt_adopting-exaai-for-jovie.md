---
title: "Adopting Exa.ai for Jovie"
type: essay
created: 2026-05-21
updated: 2026-05-21
source: chatgpt-export
conversation_id: 6a0f4808-8070-83e8-823f-9150f309a8a9
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# Adopting Exa.ai for Jovie

> Conversation ID: 6a0f4808-8070-83e8-823f-9150f309a8a9
> Created: 2026-05-21T17:59:37Z
> Updated: 2026-05-21T18:19:07Z
> Messages: 7

---

## User

https://exa.ai/ how can this make jovie better and should we adot it

---

## Assistant

I’ll assess Exa’s current product/API capabilities against Jovie’s workflows, then give a practical adoption recommendation with use cases, risks, and a pilot path.

---

## Assistant

Mr. White, **yes — adopt Exa selectively**, starting with a focused pilot. It is a strong fit for Jovie as a **live web-intelligence layer** for the AI artist manager, especially for surfacing artist opportunities, monitoring open-web signals, enriching artist profiles, and grounding AI chat.

## Why Exa fits Jovie

Jovie is positioned as an **AI artist manager** that “watches your catalog,” surfaces next actions, and helps artists ship presaves, fan paths, and playlist pitches. citeturn660166view1 Jovie also has audience segmentation, fan messaging, AI-assisted chat, analytics, and smart-link workflows. citeturn959958view0turn959958view1turn959958view2turn959958view3

Exa’s core value is that it gives AI products live web search, crawling, structured extraction, and recurring monitors through an API. Its docs describe Search, Contents, Deep Search, Agent, Websets, and Monitors as tools for search, crawling, research, list-building, enrichment, and web updates. citeturn497976view0turn497976view1turn542002view0turn542002view1

## Best Jovie use cases

| Use case | How Exa improves Jovie | Priority |
|---|---:|---:|
| **Artist Opportunity Feed** | Find new playlist targets, blogs, curators, radio shows, tastemakers, local promoters, and release-relevant opportunities. | **High** |
| **Web monitoring** | Track new mentions, reviews, playlist placements, live dates, press, creator posts, and competitor/comparable-artist activity. Exa Monitors run scheduled searches, dedupe prior results, and send webhook updates. citeturn542002view0 | **High** |
| **AI chat grounding** | Let the artist/fan AI answer questions with fresher context from official sites, press, release pages, and event listings. Jovie already plans AI-assisted fan replies and common-question handling. citeturn959958view2 | **High** |
| **Profile enrichment** | Auto-suggest bios, social links, press quotes, similar artists, genre tags, and missing metadata from public sources. | Medium |
| **Playlist pitch research** | Generate target lists with evidence: why this curator/blog/radio show is relevant, what they recently covered, and how to pitch. | **High** |
| **Internal artist-manager copilot** | Give Jovie ops/team members fast research summaries on an artist, release, label, distributor, or campaign. | Medium |
| **Lead discovery for partnerships** | Find indie labels, managers, distributors, agencies, and creators that match Jovie’s ICP. Exa has people/company indexes and structured output support. citeturn621390view0 | Medium |

## The feature I would build first

### **“What should I do next?” powered by Exa**

For each artist/release, Jovie could generate a ranked feed like:

> **Pitch this blog**  
> Evidence: covered 3 similar artists in the past 30 days.  
> Suggested action: send a premiere pitch for the new single.  
> Draft: generated outreach copy.  
> Confidence: 82%.

Each recommendation should include:

| Field | Example |
|---|---|
| `opportunity_type` | playlist, blog, radio, press, creator, venue, sync, fan activation |
| `evidence_url` | source URL |
| `why_it_matters` | short explanation |
| `recommended_action` | exact next step |
| `deadline` | if time-sensitive |
| `confidence_score` | internal ranking |
| `draft_copy` | email, DM, broadcast, or pitch copy |

This maps directly to Jovie’s promise: artists need fewer dashboards and more specific actions.

## Adoption recommendation

### Decision: **Adopt for a 2-week pilot.**

Use Exa for **open-web intelligence**, while keeping DSPs, social APIs, CRM data, and first-party Jovie analytics as the source of truth for streams, fan data, clicks, presaves, purchases, and private user behavior.

### Start with these Exa products

| Exa product | Use in Jovie |
|---|---|
| **Search API** | Real-time lookup for artist mentions, playlist targets, blogs, venues, curators. |
| **Contents API / highlights** | Extract clean, token-efficient page content. Exa says highlights can reduce token usage by 10x versus full text. citeturn542002view3 |
| **Monitors** | Recurring alerts for new artist/release mentions and opportunities. |
| **Websets** | Build verified lists: “indie pop curators accepting submissions,” “music blogs covering electronic releases,” etc. Websets can verify criteria and enrich each result. citeturn542002view1 |
| **Agent** | Use cautiously for internal async research. It is currently beta and designed for list-building, enrichment, and deep research workflows. citeturn497976view3 |

## Cost reality

Exa is cheap enough to test. Current pricing shows:

| Endpoint | Listed price |
|---|---:|
| Free tier | 1,000 requests/month |
| Search | $7 / 1k requests |
| Deep Search | $12–15 / 1k requests |
| Contents | $1 / 1k pages per content type |
| Monitors | $15 / 1k requests |
| Agent | $0.025–$2.00/run, with email/phone enrichment billed separately |

citeturn497976view2turn248640view0

Example pilot math: **500 artists × 1 monitor/day × 30 days = 15,000 monitor runs/month**, roughly **$225/month before extra contents/enrichment**. That is acceptable for testing an opportunity engine.

## Main risks

| Risk | Mitigation |
|---|---|
| **Music-specific coverage may be uneven** | Run an eval on 50–100 real artists across genres before shipping. |
| **False positives** | Require source URLs, confidence scoring, and human-review states. |
| **Latency** | Use `instant`, `fast`, or `auto` for product UX; reserve `deep`/Agent for async jobs. Exa supports different latency/quality modes. citeturn497976view1turn542002view3 |
| **Rate limits** | Default Search limit is 10 QPS; Contents is 100 QPS. Plan batching and queueing. citeturn542002view2 |
| **Privacy / fan data** | Avoid sending fan PII. For sensitive workflows, use enterprise terms; Exa advertises Zero Data Retention options and SOC 2 Type II certification. citeturn746812view0 |
| **Beta instability** | Keep Exa Agent out of core production paths until the beta matures. |

## Pilot plan

### Week 1: Evaluation

Create a dataset:

- 50 artists
- 50 releases
- 200 target tasks:
  - find playlist targets
  - find blog/press opportunities
  - detect recent mentions
  - identify comparable artists
  - enrich profile/bio data
  - answer common fan questions

Score Exa on:

| Metric | Target |
|---|---:|
| Useful opportunities | ≥70% |
| Bad/irrelevant recommendations | ≤20% |
| Critical false positives | <5% |
| Median latency for Search | acceptable for user-facing flows |
| Cost per artist/month | below your gross-margin threshold |
| Source quality | official/reputable sources preferred |

### Week 2: Internal feature flag

Ship an internal-only **Jovie Opportunity Feed**:

1. Artist/release enters Jovie.
2. Exa monitors public web signals.
3. Jovie converts findings into structured opportunities.
4. Artist sees ranked “do this next” cards.
5. Jovie tracks whether users save, dismiss, or act.

## Final call

**Adopt Exa now as a pilot dependency for Jovie’s intelligence layer.** The strongest wedge is an **artist opportunity engine** that finds timely, source-backed actions from the open web.

Use it for:

- release intelligence
- playlist/blog/curator discovery
- web monitoring
- AI chat grounding
- profile enrichment
- internal research

Keep it out of:

- private fan-data processing
- stream/presave source-of-truth metrics
- mission-critical workflows using beta Agent
- anything requiring guaranteed coverage from closed platforms

The test is simple: if Exa helps Jovie surface more accurate “what should I do next?” cards than your current stack, it is worth adopting.

---

## User

plan this as a feature extensively. for artists mentions we need a me/not me type training so that for example tim white doesnt flag every tim white on the internet, etc. 

we also need this organized in a ship first, ship later. and how this materically is structured and benefits mrr at an early stage.

---

## Assistant

I’ll turn this into a feature spec covering UX, data structure, me/not-me training, ship-first versus later scope, and the early MRR case.

---

## Assistant

I’m also grounding the plan around Exa Monitors/webhooks and treating mentions as candidate evidence that feeds a ranked action inbox, with correction loops driving precision and retention.

---

## Assistant

Mr. White, build this as **Jovie Radar**: a web-intelligence layer that finds artist mentions, filters “me / not me,” and turns verified signals into manager-style actions.

The core principle: **do not ship “mentions” as the product. Ship “verified opportunities.”** Mentions are raw material. The revenue feature is: “Jovie found this thing happening on the internet and tells you exactly what to do next.”

Jovie’s existing promise is that it watches an artist’s catalog, surfaces what to do next, and helps them ship presaves, fan paths, or playlist pitches. This feature extends that from catalog intelligence into **open-web intelligence**. citeturn610133view0

---

# 1. Feature name

## **Jovie Radar**

### One-line product description

> Jovie Radar watches the internet for verified artist mentions, playlist/press opportunities, and market signals, then turns them into source-backed actions.

### User-facing positioning

> “Jovie watches the web for you. When your name, release, or scene moves, Jovie tells you what happened and what to do next.”

---

# 2. Product thesis

Artists do not need another analytics feed. They need **manager-level context**:

- Who mentioned me?
- Is this actually me?
- Is it worth acting on?
- What should I do?
- Can Jovie help me respond, pitch, share, or follow up?

Exa is useful here because it supports real-time search, clean page extraction, scheduled monitors, structured outputs, and verified/enriched web collections. Exa Monitors can run recurring searches, dedupe new results, produce structured output, and deliver results to a webhook. citeturn882259view0 Exa Contents can extract clean page text, highlights, summaries, and structured information from URLs. citeturn882259view1 Websets can verify and enrich web results against criteria, which is useful later for curator, blog, venue, playlist, and partner discovery. citeturn882259view2

---

# 3. What should ship first

## Ship first: **Verified Mentions + Opportunity Cards**

The MVP should include five things:

| Component | Description | Why it matters |
|---|---|---|
| **Artist Identity Profile** | Stores names, aliases, handles, releases, official URLs, genres, city, collaborators, labels, and known negatives. | Prevents false positives. |
| **Mention Candidate Pipeline** | Uses Exa to find possible artist mentions across the web. | Creates the raw signal. |
| **Me / Not Me Training** | Artist or internal reviewer marks ambiguous results as “Me,” “Not Me,” or “Maybe.” | Makes the system trustworthy. |
| **Identity Scoring** | Each candidate gets a confidence score before it reaches the artist. | Avoids Tim White ≠ every Tim White problem. |
| **Action Cards** | Verified mentions become recommended next steps. | Creates paid value. |

### MVP output example

**Card title:**  
> New blog mention: “The Deep End” included in indie electronic roundup

**Card body:**  
> This appears to be you. The page mentions your artist name, release title, Spotify link, and electronic genre context.

**Actions:**  
- Share to fans  
- Generate thank-you DM  
- Add outlet to press CRM  
- Pitch next release  
- Save as press quote  
- Mark as Not Me

---

# 4. What should ship later

## Ship later: **Opportunity Engine**

Once the mentions system is accurate, expand into proactive opportunities.

| Later feature | Description | Revenue value |
|---|---|---|
| **Curator discovery** | Find playlists, blogs, radio shows, DJs, newsletters, and creators likely to cover the artist. | Strong upgrade lever. |
| **Pitch assistant** | Generate source-backed pitch drafts based on the curator’s recent coverage. | Saves time; manager-like value. |
| **Release-specific radar** | Monitor a song, EP, album, remix, or campaign window. | Great for paid launch plans. |
| **Competitive/comparable artist watch** | Track similar artists’ playlist adds, blog coverage, tour announcements, and collaborations. | Useful for serious artists/teams. |
| **Auto-generated weekly manager report** | “Here’s what happened this week and what to do next.” | Retention driver. |
| **CRM memory** | Save outlets, contacts, prior pitches, outcomes, and notes. | Makes Jovie stickier. |
| **Team/label portfolio dashboard** | Radar for 5, 10, 50, or 100 artists. | Expansion MRR. |
| **Websets-based verified lists** | Build continuously updated lists like “blogs covering indie electronic releases this month.” | Higher-ticket feature. |

Exa Websets are a better fit for this later stage because they can search, verify each item against criteria, enrich each result, and return structured items over time. citeturn882259view2

---

# 5. The me / not me system

This is the most important part.

A mention should never be accepted because the name matches. For common names, the system should assume ambiguity until identity evidence is present.

## 5.1 Artist Identity Profile

Each artist gets an identity graph.

### `artist_identity_profile`

| Field | Example |
|---|---|
| `artist_id` | `artist_123` |
| `primary_name` | `Tim White` |
| `aliases` | `Tim White Music`, `timwhiteofficial`, etc. |
| `official_urls` | Spotify, Apple Music, YouTube, Instagram, TikTok, SoundCloud, Bandcamp, website |
| `release_titles` | `The Deep End`, etc. |
| `genre_terms` | electronic, indie pop, dance, singer-songwriter |
| `location_terms` | Los Angeles, California |
| `collaborators` | producers, featured artists, labels |
| `catalog_identifiers` | ISRCs, UPCs, Spotify artist ID, Apple artist ID |
| `positive_keywords` | artist-specific words that indicate true identity |
| `negative_keywords` | real estate, professor, football, lawyer, obituary, politician, etc. |
| `negative_people` | known unrelated people with the same name |
| `negative_domains` | domains that repeatedly mention the wrong person |
| `review_thresholds` | confidence thresholds per artist |

---

## 5.2 Candidate states

Every result moves through clear states:

| State | Meaning |
|---|---|
| `candidate` | Found by search/monitor, not yet classified. |
| `auto_me` | High confidence it is the artist. |
| `needs_review` | Ambiguous. Show internally or ask artist. |
| `user_confirmed_me` | Artist/reviewer confirmed it. |
| `user_confirmed_not_me` | Artist/reviewer rejected it. |
| `auto_not_me` | System suppressed it due to strong negative evidence. |
| `muted` | User muted this source, person, or pattern. |

---

## 5.3 Identity scoring

Use a weighted identity score.

### Suggested scoring model

| Signal | Weight | Example |
|---|---:|---|
| Exact artist name / alias match | 15% | “Tim White” appears |
| Official URL / handle match | 25% | Links to artist’s Spotify or Instagram |
| Release title match | 20% | Mentions “The Deep End” |
| Music context match | 15% | Mentions single, album, Spotify, tour, DJ, producer |
| Genre / city / label match | 10% | LA electronic artist |
| Collaborator match | 5% | Mentions known collaborator |
| Source relevance | 10% | Music blog, playlist site, radio, venue, DSP page |
| Negative evidence penalty | -10% to -80% | “Tim White real estate broker” |

### Thresholds

| Score | Handling |
|---:|---|
| `0.85–1.00` | Auto-accept, show as verified. |
| `0.60–0.84` | Needs review. |
| `0.35–0.59` | Internal review only; do not notify artist. |
| `<0.35` | Suppress. |
| Any strong negative rule | Suppress regardless of score. |

For a common name like **Tim White**, a page that only says “Tim White” should score low. A page that says “Tim White,” links to his Spotify, mentions a known song, and appears on a music site should score high.

---

## 5.4 Training loop

The training loop should be simple and visible.

### User labels

Each ambiguous card has:

- **This is me**
- **This is not me**
- **Maybe**
- **Mute this source**
- **Mute this person**
- **Always trust this source**
- **Report bad match**

### What each label updates

| Label | System update |
|---|---|
| **This is me** | Adds source, phrases, entities, and embeddings to positive identity memory. |
| **This is not me** | Adds source, person, occupation, phrases, and embeddings to negative memory. |
| **Maybe** | Keeps candidate in review; avoids model overtraining. |
| **Mute source** | Suppresses future matches from that domain unless strong positive evidence exists. |
| **Mute person** | Creates a named negative entity, e.g. “Tim White, real estate broker.” |
| **Always trust source** | Boosts domain for this artist, e.g. their own website or label page. |

---

## 5.5 Artist onboarding flow

During setup, ask the artist to confirm their identity.

### Step 1: Confirm official links

> “Which of these are you?”

Show found profiles:

- Spotify
- Apple Music
- Instagram
- TikTok
- YouTube
- SoundCloud
- Bandcamp
- website
- label page

### Step 2: Confirm releases

> “Which releases belong to you?”

Use Jovie catalog data first. The artist should not need to manually enter this if Jovie already has it.

### Step 3: Confirm common false matches

> “We found other people named Tim White. Mark the ones that are not you.”

Examples:

- Tim White, real estate agent
- Tim White, professor
- Tim White, athlete
- Tim White, photographer
- Tim White, obituary
- Tim White, local politician

### Step 4: Set alert preference

| Option | Behavior |
|---|---|
| Conservative | Only high-confidence verified mentions. |
| Balanced | Verified mentions + review prompts. |
| Aggressive | More discovery, more false positives. Best for teams. |

Default should be **Conservative**.

---

# 6. Search and monitor strategy

## 6.1 Mention searches

Use multiple query types per artist.

### Exact identity queries

```text
"{artist_name}" "{release_title}"
"{artist_name}" "{spotify_artist_id_or_profile_url}"
"{artist_name}" "{official_handle}"
"{artist_name}" "{label_name}"
"{artist_name}" "{city}" "{genre}"
```

### Semantic query example

```text
Recent web pages about the musician Tim White, especially pages related to his releases, music profiles, playlists, press coverage, artist pages, interviews, DJ sets, radio shows, or music videos. Exclude unrelated people such as real estate agents, professors, athletes, politicians, obituaries, and business executives unless the page clearly links to the musician's official music profiles.
```

Exa’s Search API supports long, semantically rich queries, highlights, output schemas, freshness controls, and category filters, which maps well to this use case. citeturn882259view4

---

## 6.2 Monitor cadence

Use different cadences by tier.

| Tier | Cadence | Scope |
|---|---:|---|
| Free | Manual scan only | 1 artist, limited results |
| Starter | Weekly | Artist name + releases |
| Pro | Daily | Artist, releases, playlist/blog opportunities |
| Team | Daily or twice daily | Portfolio of artists |
| Label/Manager | Custom | Many artists, webhook/CRM export |

Exa Monitors are specifically built for scheduled recurring searches with webhook delivery and deduplication, so they are the natural fit for the ongoing watch layer. citeturn882259view0

---

# 7. Data model

## 7.1 Core tables

### `artists`

| Field | Type |
|---|---|
| `id` | uuid |
| `name` | text |
| `user_id` | uuid |
| `created_at` | timestamp |
| `primary_genre` | text |
| `home_city` | text |
| `status` | active/inactive |

---

### `artist_identity_profiles`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `confidence_mode` | conservative/balanced/aggressive |
| `identity_score_threshold_auto_accept` | decimal |
| `identity_score_threshold_review` | decimal |
| `last_trained_at` | timestamp |
| `positive_embedding_profile_id` | uuid |
| `negative_embedding_profile_id` | uuid |

---

### `artist_aliases`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `alias` | text |
| `alias_type` | legal_name/stage_name/handle/project_name/misspelling |
| `confidence` | decimal |
| `source` | user/catalog/web/system |

---

### `artist_official_links`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `platform` | spotify/apple/instagram/tiktok/youtube/soundcloud/bandcamp/website |
| `url` | text |
| `external_id` | text |
| `verified_by_user` | boolean |
| `verified_at` | timestamp |

---

### `artist_releases`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `title` | text |
| `release_type` | single/ep/album/remix |
| `release_date` | date |
| `isrc` | text |
| `upc` | text |
| `spotify_url` | text |
| `apple_url` | text |

---

## 7.2 Mention tables

### `mention_candidates`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `source_url` | text |
| `source_domain` | text |
| `title` | text |
| `snippet` | text |
| `published_at` | timestamp |
| `discovered_at` | timestamp |
| `source_type` | blog/playlist/news/social/video/forum/venue/radio/dsp/unknown |
| `raw_provider` | exa/manual/import |
| `raw_payload` | jsonb |
| `dedupe_hash` | text |
| `status` | candidate/auto_me/needs_review/not_me/muted |

---

### `mention_identity_features`

| Field | Type |
|---|---|
| `id` | uuid |
| `mention_candidate_id` | uuid |
| `name_match_score` | decimal |
| `official_link_score` | decimal |
| `release_match_score` | decimal |
| `music_context_score` | decimal |
| `genre_location_score` | decimal |
| `collaborator_score` | decimal |
| `source_relevance_score` | decimal |
| `negative_penalty` | decimal |
| `final_identity_score` | decimal |
| `explanation` | text |

---

### `mention_labels`

| Field | Type |
|---|---|
| `id` | uuid |
| `mention_candidate_id` | uuid |
| `artist_id` | uuid |
| `labeled_by_user_id` | uuid |
| `label` | me/not_me/maybe/mute_source/mute_person |
| `notes` | text |
| `created_at` | timestamp |

---

### `negative_identity_rules`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `rule_type` | keyword/domain/person/entity/url_pattern/occupation |
| `value` | text |
| `strength` | soft/hard |
| `created_from_label_id` | uuid |
| `created_at` | timestamp |

Example:

| `rule_type` | `value` | `strength` |
|---|---|---|
| occupation | real estate broker | hard |
| domain | localrealtyexample.com | hard |
| keyword | professor of economics | soft |
| person | Tim White, football coach | hard |

---

## 7.3 Opportunity tables

### `opportunities`

| Field | Type |
|---|---|
| `id` | uuid |
| `artist_id` | uuid |
| `mention_candidate_id` | uuid nullable |
| `opportunity_type` | mention/press/playlist/radio/venue/creator/collab/reputation/seo |
| `title` | text |
| `summary` | text |
| `why_it_matters` | text |
| `recommended_action` | text |
| `priority_score` | decimal |
| `confidence_score` | decimal |
| `status` | new/viewed/saved/dismissed/completed |
| `created_at` | timestamp |

---

### `opportunity_actions`

| Field | Type |
|---|---|
| `id` | uuid |
| `opportunity_id` | uuid |
| `action_type` | share/generate_pitch/generate_dm/save_quote/contact_outlet/create_campaign/add_to_crm |
| `generated_copy` | text |
| `completed_at` | timestamp |
| `user_feedback` | useful/not_useful |

---

# 8. Ship-first product requirements

## 8.1 User stories

### Artist

> As an artist, I want Jovie to tell me when I am mentioned online, without showing me unrelated people with the same name.

### Artist

> As an artist, I want each mention to include a suggested next step so I can act quickly.

### Manager / label

> As a manager, I want to monitor multiple artists and only see verified or review-worthy signals.

### Jovie internal team

> As Jovie, I want to track false positives, useful opportunities, and upgrade conversions so we can prove revenue impact.

---

## 8.2 MVP requirements

| Requirement | Ship first? |
|---|---:|
| Artist identity profile | Yes |
| Exa-powered mention candidate search | Yes |
| Daily or weekly monitor jobs | Yes |
| Me / Not Me labels | Yes |
| Identity score | Yes |
| Suppression rules | Yes |
| Mention cards | Yes |
| Basic opportunity cards | Yes |
| Source-backed evidence | Yes |
| Paid-tier gating | Yes |
| Outreach automation | Later |
| Curator CRM | Later |
| Websets list building | Later |
| Team portfolio dashboard | Later |
| Full campaign automation | Later |

---

# 9. Ship-later roadmap

## Phase 2: Opportunity discovery

Add proactive cards that do not depend on the artist already being mentioned.

Examples:

- “This blog covered 3 similar artists this month.”
- “This playlist added 5 songs in your genre recently.”
- “This radio show accepts submissions and played a comparable artist.”
- “This venue booked two artists similar to you.”
- “This creator used songs in your genre in recent videos.”

## Phase 3: Action automation

For each opportunity, generate:

- pitch email
- DM
- fan post
- press quote
- playlist submission copy
- one-click campaign
- CRM task

## Phase 4: Portfolio intelligence

For managers and labels:

- portfolio radar
- artist-by-artist feed
- weekly report
- campaign health
- outlet history
- opportunity ownership
- team notes

This is where the feature becomes a higher-ARPA product.

---

# 10. Metrics structure

## North Star metric

### **Verified actionable opportunities per paid artist per month**

A “verified actionable opportunity” means:

1. Jovie found a source-backed signal.
2. The signal was correctly associated with the artist.
3. The user viewed, saved, dismissed, acted, or labeled it.
4. It produced a recommended action.

This is stronger than “mentions found,” because mentions can be noisy.

---

## Product quality metrics

| Metric | Target |
|---|---:|
| Verified mention precision | 85%+ after onboarding |
| False positive alerts | <1 per artist/week |
| Ambiguous review rate | <30% after 10 labels |
| Duplicate rate | <10% |
| Time to first useful signal | <24 hours for active artists |
| Opportunity usefulness rating | 60%+ useful |
| Label completion rate | 40%+ for ambiguous cards |
| Auto-classification improvement | Improves after 5–10 labels |

---

## Revenue metrics

| Metric | Why it matters |
|---|---|
| Trial-to-paid conversion | Radar can create immediate perceived value. |
| Upgrade rate to Pro | Daily radar and opportunity cards can justify Pro. |
| Add-on attach rate | Radar can be sold as an intelligence add-on. |
| Paid retention | Weekly “what happened / what to do” creates repeat use. |
| ARPA | Team/manager tiers can pay more per artist. |
| Expansion revenue | Labels and managers can add more artists. |
| Gross margin per monitored artist | Ensures Exa + LLM costs do not eat margin. |

---

# 11. How this benefits early-stage MRR

## The MRR mechanism

Jovie Radar affects MRR through five levers:

| Lever | How Radar helps |
|---|---|
| **Activation** | New users get a fast “Jovie found something for me” moment. |
| **Conversion** | Free users see useful but limited intelligence and upgrade. |
| **ARPA** | Radar can be gated into Pro or sold as an add-on. |
| **Retention** | Weekly verified opportunities give artists a reason to return. |
| **Expansion** | Managers and labels pay for multiple artists. |

The strongest early-stage MRR lever is **conversion + retention**, not enterprise expansion. Enterprise expansion comes later.

---

## Suggested packaging

### Free

- Manual scan only
- 1 artist
- 3 results/month
- No daily monitoring
- Me / Not Me training available

Purpose: activation and teaser.

### Starter

- Weekly Radar scan
- Verified mentions
- Basic action cards
- Limited history

Purpose: entry-level paid conversion.

### Pro

- Daily Radar
- Release-specific monitoring
- Opportunity cards
- Pitch/DM generation
- Saved outlets
- Weekly manager report

Purpose: main paid tier.

### Team / Manager

- Multi-artist portfolio
- Shared inbox
- CRM
- Team notes
- Higher monitoring frequency
- Export/reporting

Purpose: expansion MRR.

---

## Example unit economics

Exa’s listed pricing shows Search at **$7 per 1,000 requests**, Contents at **$1 per 1,000 pages per content type**, and Monitors at **$15 per 1,000 requests**. citeturn882259view3

Illustrative monthly cost per paid artist:

| Item | Usage | Approx. cost |
|---|---:|---:|
| Daily monitor | 30 runs × $0.015 | $0.45 |
| Ad hoc searches | 20 searches × $0.007 | $0.14 |
| Contents extraction | 100 pages × $0.001 | $0.10 |
| LLM classification/summaries | Depends on model | likely variable |
| App infra | Depends on stack | low at MVP scale |

Even after adding LLM costs, this can likely fit inside a **$10–$20/month intelligence add-on** or support a **$10+ Pro tier price gap**, assuming controlled usage and conservative monitoring.

---

## Example MRR model

Illustrative numbers, not a forecast:

### Without Radar

| Metric | Value |
|---|---:|
| Activated artists | 1,000 |
| Paid conversion | 8% |
| Paid users | 80 |
| ARPA | $19 |
| MRR | $1,520 |

### With Radar

| Metric | Value |
|---|---:|
| Activated artists | 1,000 |
| Paid conversion | 11% |
| Paid users | 110 |
| Base ARPA | $19 |
| Radar add-on attach | 35% |
| Add-on price | $10 |
| MRR | `(110 × $19) + (110 × 35% × $10)` = **$2,475** |

That is a **63% MRR increase** in this example.

The most important assumption is paid conversion lift. Radar needs to create a first-week “Jovie is managing my career” moment.

---

# 12. What the first version should look like in the app

## Dashboard module

### **Radar**

Tabs:

1. **Verified**
2. **Review**
3. **Opportunities**
4. **Muted**
5. **Training**

---

## Card types

### 1. Verified mention

> “This blog mentioned your new single.”

Actions:

- Share
- Save quote
- Generate thank-you message
- Add to press list
- Dismiss

---

### 2. Needs review

> “We found a possible Tim White mention. Is this you?”

Actions:

- This is me
- This is not me
- Maybe
- Mute source

---

### 3. Opportunity

> “This playlist recently added three similar artists.”

Actions:

- Generate playlist pitch
- Save curator
- Add to release campaign
- Dismiss

---

### 4. Reputation / issue

> “A page may have outdated or incorrect artist information.”

Actions:

- Generate correction request
- Save issue
- Dismiss

---

# 13. Internal review flow

Do not make artists train too much at launch. Use internal review for early cohorts.

## Launch approach

| Cohort | Handling |
|---|---|
| First 25 artists | Internal review before user-facing alerts. |
| Next 100 artists | User sees review cards, but only high-confidence alerts trigger notifications. |
| Paid Pro users | Verified alerts + review queue. |
| Team users | Bulk review and manager controls. |

This keeps trust high while the system learns.

---

# 14. Technical architecture

```text
Exa Search / Monitors
        ↓
Raw Candidate Ingestion
        ↓
URL Normalization + Deduplication
        ↓
Content Extraction / Highlights
        ↓
Identity Feature Extraction
        ↓
Me / Not Me Classifier
        ↓
Mention State Assignment
        ↓
Opportunity Classifier
        ↓
Action Generator
        ↓
Jovie Radar UI + Notifications
        ↓
User Feedback
        ↓
Artist Identity Memory
```

## Key design rule

**Exa finds candidates. Jovie decides identity.**

Do not outsource the final “is this the artist?” decision entirely to Exa or an LLM. Jovie should own identity memory because that becomes proprietary product value.

---

# 15. Implementation plan

## Week 1: Data + search foundation

Build:

- `artist_identity_profiles`
- `artist_aliases`
- `artist_official_links`
- `artist_releases`
- `mention_candidates`
- `mention_identity_features`
- `mention_labels`
- Exa search wrapper
- result normalization
- dedupe logic

Goal: get candidate mentions into the database.

---

## Week 2: Identity scoring + review UI

Build:

- scoring model
- review queue
- Me / Not Me buttons
- negative rules
- muted sources
- internal admin dashboard

Goal: reduce false positives before artists see the feature.

---

## Week 3: Artist-facing Radar MVP

Build:

- Radar dashboard
- verified mention cards
- review cards
- source evidence
- basic actions:
  - save
  - dismiss
  - share
  - generate response
  - mark not me

Goal: ship to 25–50 friendly artists.

---

## Week 4: MRR packaging experiment

Build:

- Free teaser
- Pro gate
- upgrade CTA
- usage limits
- weekly digest
- revenue analytics

Goal: test whether Radar increases activation, conversion, and retention.

---

# 16. Ship-first acceptance criteria

Do not fully launch until these are true:

| Criterion | Target |
|---|---:|
| High-confidence mention precision | 85%+ |
| False positive notifications | <1 per artist/week |
| Median setup time | <5 minutes |
| First useful card generated | <24 hours for active artists |
| User says card is useful | 60%+ |
| Cost per active monitored artist | <$2/month excluding edge cases |
| Upgrade CTA conversion from Radar teaser | Meaningfully above baseline |
| Weekly digest open/click rate | Strong enough to justify recurring value |

---

# 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Common-name false positives | Identity graph, negative rules, review thresholds, no name-only alerts. |
| Alert fatigue | Conservative default, weekly digest, only notify high-confidence/high-priority cards. |
| Bad sources | Source quality scoring and domain-level mute/trust rules. |
| Stale content | Use freshness controls and dedupe. |
| Hallucinated recommendations | Every card must include source URL and evidence. |
| High variable costs | Tier-based cadence, result caps, highlights over full text, async batch processing. |
| Social platform gaps | Be clear that Radar watches the open web and indexable sources; integrate direct social APIs later. |

---

# 18. What I would explicitly avoid in v1

Avoid these until the core system is accurate:

- fully automated outreach
- notifying artists about low-confidence mentions
- letting name-only matches hit the dashboard
- building a massive curator CRM before proving demand
- selling this as “brand monitoring”
- making users label 50 examples during onboarding
- shipping without internal QA

The initial product should feel like:

> “Jovie found 3 useful things and 1 thing to review.”

It should never feel like:

> “Here are 100 random Google Alerts.”

---

# 19. The strongest version of the feature

The long-term feature is bigger than mentions.

## **Jovie Manager Feed**

A ranked feed of source-backed recommendations:

| Card | Example |
|---|---|
| Mention | “A blog covered your single.” |
| Opportunity | “This playlist added similar artists.” |
| Campaign | “Your release has no current pitch targets.” |
| Reputation | “This page has outdated bio information.” |
| Fan growth | “This creator used songs in your genre recently.” |
| Competitive | “A similar artist got press from this outlet.” |
| Action | “Send this pitch today.” |

This becomes the product loop:

```text
Jovie finds signal
→ verifies identity
→ creates recommendation
→ user acts
→ Jovie learns
→ better future recommendations
→ user upgrades or stays subscribed
```

---

# 20. Final recommendation

Adopt Exa as the external web-intelligence provider, but build the valuable layer inside Jovie:

1. **Exa = candidate discovery**
2. **Jovie = identity resolution**
3. **Jovie = training memory**
4. **Jovie = opportunity ranking**
5. **Jovie = manager action layer**
6. **Revenue = Pro gating, add-ons, retention, and team expansion**

Ship first:

- verified mentions
- me/not me training
- conservative alerts
- basic action cards
- paid gating

Ship later:

- curator discovery
- Websets-powered opportunity lists
- automated pitch workflows
- manager/label portfolio intelligence
- CRM and campaign automation

The early-stage MRR benefit comes from giving artists a recurring, concrete reason to believe Jovie is managing their career every week. Verified web intelligence plus recommended actions is a stronger paid feature than passive analytics.


**Topic:** [[chatgpt-clusters/jovie_music]]
