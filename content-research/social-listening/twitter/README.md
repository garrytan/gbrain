# Twitter/X Social Listening

## Purpose

Raw data from Twitter/X crawls. Twitter is valuable for real-time trend detection, influencer tracking, and short-form sentiment analysis.

## What Data Lives Here

- Tweet and thread data (text, engagement metrics, author info)
- Hashtag tracking data
- Mention and reply chains
- Author follower counts and verification status

## File Naming Convention

```
YYYY-MM-DD-<query-or-hashtag>.json
```

Examples:
- `2026-05-30-ai-writing-tools.json`
- `2026-05-29-content-strategy.json`
- `2026-05-28-#ChatGPT.json`

## Data Structure

Each file should contain:
- Query or hashtag that was searched
- Timestamp of the crawl
- Array of tweet objects with: `id`, `text`, `author`, `likes`, `retweets`, `replies`, `date`

## Notes

- Twitter API access tier determines crawl depth and rate limits
- Thread data should be reconstructed (individual tweets grouped by thread ID)
- Quote tweets should be tracked separately from original tweets
