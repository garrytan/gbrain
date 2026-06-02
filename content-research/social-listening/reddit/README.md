# Reddit Social Listening

## Purpose

Raw data from Reddit crawls. Reddit is a rich source of authentic audience discussions, pain points, and emerging trends.

## What Data Lives Here

- Subreddit thread data (title, body, comments, upvotes, awards)
- Comment-level sentiment and engagement metrics
- Subreddit metadata (subscriber count, activity level)

## File Naming Convention

```
YYYY-MM-DD-r-<subreddit-name>.json
```

Examples:
- `2026-05-30-r-content-marketing.json`
- `2026-05-29-r-SEO.json`
- `2026-05-28-r-writing.json`

## Target Subreddets

Update this list based on your niche. Common starting points:

- r/content_marketing
- r/SEO
- r/copywriting
r/digital_marketing
- r/juststart
- r/Entrepreneur

## Notes

- Respect Reddit's API rate limits and terms of service
- Store both the raw API response and a cleaned/parsed version
- Comment threads deeper than 3 levels are usually not worth storing in full
