# Content Research Data Schema

All files in this system use **Markdown with YAML frontmatter**. The frontmatter fields defined here are the contract between agents — every agent that reads or writes these files must adhere to this schema.

---

## Topic File

**Location:** `topics/<slug>.md`
**Purpose:** A single topic discovered through social listening or keyword research.

### Frontmatter Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Human-readable topic title |
| `source` | string | ✅ | Origin of the topic (e.g., `reddit/r/SEO`, `twitter`, `youtube`, `keyword-research`) |
| `date` | date | ✅ | Date the topic was discovered (`YYYY-MM-DD`) |
| `platforms` | string[] | ✅ | Platforms where this topic appears (e.g., `["reddit", "twitter", "youtube"]`) |
| `sentiment` | enum | ✅ | Overall sentiment: `positive`, `negative`, `neutral`, `mixed` |
| `pain_points` | string[] | ✅ | Specific pain points or problems mentioned by the audience |
| `keywords` | string[] | ✅ | Associated keywords and phrases |
| `content_angles` | string[] | ✅ | Potential angles for content (e.g., `"how-to"`, `"comparison"`, `"case-study"`) |
| `pillar_fit_score` | int (1-10) | ✅ | How well this topic fits an existing pillar (10 = perfect fit) |
| `search_volume_estimate` | int | ✅ | Estimated monthly search volume (0 if unknown) |
| `commercial_intent` | int (1-10) | ✅ | Commercial intent of searchers (10 = ready to buy) |
| `recommended_action` | enum | ✅ | `create-content`, `monitor`, `skip`, `merge-with-existing` |

### Example

```markdown
---
title: "Best AI Writing Tools for Long-Form Content"
source: "reddit/r/content_marketing"
date: "2026-05-30"
platforms: ["reddit", "twitter"]
sentiment: "mixed"
pain_points:
  - "AI tools produce generic content"
  - "Hard to maintain brand voice with AI"
  - "Too many tools to evaluate"
keywords:
  - "AI writing tools"
  - "long-form AI content"
  - "best AI copywriter"
content_angles:
  - "comparison"
  - "honest-review"
  - "how-to-choose"
pillar_fit_score: 8
search_volume_estimate: 12000
commercial_intent: 7
recommended_action: "create-content"
---

## Summary

Reddit users in r/content_marketing are actively discussing the limitations
of AI writing tools for long-form content. The dominant complaint is that
most tools produce generic output that doesn't match brand voice.

## Key Quotes

> "I've tried 6 different AI writers and they all sound the same after
> paragraph 3."

## Notes

Strong overlap with existing topic "AI Content Detection Tools" — consider
merging if content angle overlaps.
```

---

## Pillar File

**Location:** `pillars/<slug>.md`
**Purpose:** A content pillar — a broad thematic cluster that groups related topics and content.

### Frontmatter Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Pillar name (human-readable) |
| `status` | enum | ✅ | `active`, `draft`, `archived`, `merged` |
| `topics_count` | int | ✅ | Number of topics currently mapped to this pillar |
| `total_search_volume` | int | ✅ | Sum of search volumes across all mapped topics |
| `avg_commercial_intent` | float | ✅ | Average commercial intent across mapped topics (1-10) |
| `created` | date | ✅ | Date the pillar was created (`YYYY-MM-DD`) |
| `updated` | date | ✅ | Date the pillar was last updated (`YYYY-MM-DD`) |

### Example

```markdown
---
name: "AI in Marketing"
status: "active"
topics_count: 14
total_search_volume: 87000
avg_commercial_intent: 6.4
created: "2026-01-15"
updated: "2026-05-30"
---

## Description

Covers all topics related to the use of artificial intelligence in marketing
content creation, automation, and strategy.

## Mapped Topics

- best-ai-writing-tools-for-long-form-content
- ai-content-detection-tools
- chatgpt-for-seo-research
- ai-image-generation-for-marketing

## Content Strategy

This pillar targets marketing professionals evaluating AI tools. Content
should balance educational how-to content with honest comparisons and
product reviews.
```

---

## Idea Queue

**Location:** `ideas/queue.md`
**Purpose:** A prioritized queue of content ideas, ranked by composite score.

### Frontmatter Fields (per idea entry)

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Content piece title (working title is fine) |
| `type` | enum | ✅ | `blog-post`, `video`, `newsletter`, `social-thread`, `guide`, `comparison`, `case-study` |
| `pillar` | string | ✅ | Slug of the parent pillar |
| `search_volume` | int | ✅ | Target keyword monthly search volume |
| `competition` | enum | ✅ | `low`, `medium`, `high` |
| `jovie_fit` | int (1-10) | ✅ | How well this fits the brand/audience (10 = perfect) |
| `score` | float | ✅ | Composite priority score (auto-calculated, higher = better) |
| `status` | enum | ✅ | `queued`, `researching`, `drafting`, `review`, `scheduled`, `published`, `killed` |
| `created` | date | ✅ | Date the idea was added (`YYYY-MM-DD`) |

### Score Calculation

```
score = (search_volume_normalized * 0.3) +
        (commercial_intent * 0.25) +
        (jovie_fit * 0.25) +
        (competition_inverse * 0.2)
```

Where:
- `search_volume_normalized` = search_volume / max_volume_in_queue (0-1 scale)
- `competition_inverse` = 1.0 for low, 0.6 for medium, 0.3 for high

### Example

```markdown
# Content Idea Queue

## 1. Score: 8.42
- **Title:** "7 AI Writing Tools Tested for Long-Form Content (2026)"
- **Type:** comparison
- **Pillar:** ai-in-marketing
- **Search Volume:** 12000
- **Competition:** medium
- **Jovie Fit:** 9
- **Status:** drafting
- **Created:** 2026-05-30

## 2. Score: 7.85
- **Title:** "How to Keep Your Brand Voice When Using AI Writers"
- **Type:** blog-post
- **Pillar:** ai-in-marketing
- **Search Volume:** 4400
- **Competition:** low
- **Jovie Fit:** 8
- **Status:** queued
- **Created:** 2026-05-28
```

---

## Change Log

| Date | Change |
|---|---|
| 2026-05-30 | Initial schema definition |
