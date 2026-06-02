# Social Listening

## Purpose

This directory stores **raw crawl data** from social media platforms. It is the entry point of the content research pipeline — agents scrape discussions, comments, and threads to identify emerging topics, pain points, and audience sentiment.

## What Data Lives Here

Data is organized by platform:

| Subdirectory | Platform | Data Type |
|---|---|---|
| `reddit/` | Reddit | Subreddit threads, comments, upvote counts |
| `twitter/` | Twitter/X | Tweets, threads, engagement metrics |
| `youtube/` | YouTube | Video titles, descriptions, comments, view counts |

Within each subdirectory, data is organized by **date of crawl**:

```
social-listening/
├── reddit/
│   ├── 2026-05-30-r-content-marketing.json
│   └── 2026-05-29-r-SEO.json
├── twitter/
│   ├── 2026-05-30-ai-writing-tools.json
│   └── 2026-05-29-content-strategy.json
└── youtube/
    ├── 2026-05-30-ai-tools-review.json
    └── 2026-05-29-seo-tips.json
```

## File Naming Convention

```
<platform>/YYYY-MM-DD-<query-or-channel>.<format>
```

- Date prefix for chronological sorting
- Descriptive slug for the query or channel crawled
- Format is typically `.json` (structured) or `.md` (human-readable summary)

## Data Retention

- Raw data is **rotated monthly**
- Archive anything older than **90 days** to cold storage
- Summarized insights should be extracted to `topics/` before raw data is archived

## How Agents Use This Directory

- **Crawl agents** write raw data here on a scheduled basis
- **Research agents** read raw data to extract topics and pain points
- **Topic agents** create `topics/*.md` files from insights found here
- **Maintenance agents** handle data rotation and archival
