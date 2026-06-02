---
title: "Refine TikTok Search Criteria"
type: guide
created: 2024-04-11
updated: 2024-04-11
source: chatgpt-export
topic: coding-ai
message_count: 14
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Refine TikTok Search Criteria

> **Source:** ChatGPT conversation
> **Date:** 2024-04-11T20:41:50Z
> **Messages:** 14
> **Topic:** coding-ai

## Question

i would like to search google. I want to create a complex search query and i need your help inputing the filters into a text prompt for google.

My base query is site:tiktok.com shopltk.com
but i would also like to only include results where the tiktok profile follower count is above 10k

## Answer

To refine your Google search to meet your specific requirements, we can use advanced search operators along with your base query. Unfortunately, Google does not directly support filtering search results by the follower count of TikTok profiles. However, we can craft a query that targets pages likely to indicate a higher follower count through contextual hints.

Here’s how you can structure your Google search query:

1. **Base Site**: Use `site:tiktok.com` to limit results to TikTok.
2. **Keyword Association**: Add terms like "followers" alongside a numerical range to hint at a minimum follower count. For example, "10K followers" or "10000 followers".
3. **Linking Site**: Include `shopltk.com` to focus on pages that reference this site.

**Example Query**:
```
site:tiktok.com "10000 followers" | "10K followers" shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits search to TikTok.
- `"10000 followers" | "10K followers"`: Tries to capture profiles mentioning these follower counts (use of OR `|` broadens the match).
- `shopltk.com`: Ensures some association with Shopltk.

Keep in mind that the effectiveness of this search will depend on whether these follower details are mentioned explicitly in the text accessible to Google’s crawlers.

## Question

exactly now how can we craft that follower count to include a range between 10k and 10M

## Answer

To create a search query that captures a follower count range between 10K and 10M on TikTok profiles, you can use numerical ranges and combine them with logical operators in your Google search. Here’s how you can structure your query:

1. **Base Site**: Use `site:tiktok.com` to limit results to TikTok.
2. **Keyword Association**: Use numerical ranges and keywords to approximate the follower count. Google search supports text-based queries, so you’ll need to spell out variations.
3. **Linking Site**: Include `shopltk.com` to focus on pages that reference this site.

**Example Query**:
```
site:tiktok.com ("10K followers" | "20K followers" | "50K followers" | "100K followers" | "200K followers" | "500K followers" | "1M followers" | "2M followers" | "5M followers" | "10M followers") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- The range in parentheses uses the OR operator `|` to include multiple possible follower count mentions. You can adjust these increments based on how granular you want the search to be.
- `shopltk.com`: Ensures the pages have some reference to Shopltk.

This approach helps to focus on profiles that likely mention these specific follower counts within their content. However, the effectiveness of this query depends on these details being explicitly mentioned in a way that Google's search engine can index.

## Question

ok but we would need to also include a wildcard for inbetween values. for example would this current query miss out on 10.5K?

## Answer

Yes, the current query could potentially miss follower counts that aren't explicitly listed, such as "10.5K" or other in-between values. To handle this more effectively, you can use a broader search term that might capture a wider range of follower counts. However, Google's search capabilities are somewhat limited when it comes to parsing exact numerical values within a specific range, especially with the 'K' and 'M' suffixes that denote thousands and millions.

A more inclusive approach could use wildcards or broader terms, but Google does not support true wildcard searches for partial words (like numbers). Instead, you can simplify the search to catch any mention of "K followers" or "M followers," which are likely indicators of profiles within your desired range. Here's a revised version of your query:

**Example Query**:
```
site:tiktok.com ("K followers" | "M followers") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- `"K followers" | "M followers"`: Aims to capture any mention of thousands or millions of followers, making it more likely to include accounts like "10.5K" or similar.
- `shopltk.com`: Ensures that the TikTok profiles being searched are associated with Shopltk.com.

This simplified approach broadens your search to include profiles that mention having followers in the thousands to millions, without specifying exact numbers. It should help you avoid missing profiles due to variations in how follower counts are reported.

## Question

now we need to add location. so we want people only in los angeles but we need to handle various ways of writing los angeles 

## Answer

To include variations of "Los Angeles" in your search query and limit the results to profiles mentioning follower counts within your specified range, you can utilize additional search terms for location. Here's how you can modify your query:

**Example Query**:
```
site:tiktok.com ("K followers" | "M followers") ("Los Angeles" | "LA" | "L.A.") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- `"K followers" | "M followers"`: Aims to capture any mention of thousands or millions of followers.
- `("Los Angeles" | "LA" | "L.A.")`: Includes variations of Los Angeles to ensure comprehensive coverage.
- `shopltk.com`: Ensures that the TikTok profiles being searched are associated with Shopltk.com.

This modification allows your search to cover various ways of writing "Los Angeles" while still focusing on TikTok profiles mentioning follower counts in the specified range and associated with Shopltk.com.

## Question

great but we also want to include hollywood or west hollywood or sanata monica or malibu or venice beach or beverly hills and variations on those

## Answer

To expand the search to include additional locations such as Hollywood, West Hollywood, Santa Monica, Malibu, Venice Beach, and Beverly Hills, along with variations, you can integrate these terms into the existing query. Here's the modified query:

**Example Query**:
```
site:tiktok.com ("K followers" | "M followers") ("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- `"K followers" | "M followers"`: Aims to capture any mention of thousands or millions of followers.
- `("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls")`: Includes variations of these locations to ensure comprehensive coverage.
- `shopltk.com`: Ensures that the TikTok profiles being searched are associated with Shopltk.com.

This modification expands the search to include various locations and their common variations while still focusing on TikTok profiles mentioning follower counts within the specified range and associated with Shopltk.com.

## Question

ok great and we want ones with personal email addresses

## Answer

To refine the search further to include TikTok profiles with personal email addresses, you can modify the query to include terms that might indicate the presence of contact information. Here's how you can integrate this into the existing query:

**Example Query**:
```
site:tiktok.com ("K followers" | "M followers") ("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls") ("email" | "contact" | "reach out" | "DM" | "direct message" | "inbox" | "message") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- `"K followers" | "M followers"`: Aims to capture any mention of thousands or millions of followers.
- `("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls")`: Includes variations of these locations.
- `("email" | "contact" | "reach out" | "DM" | "direct message" | "inbox" | "message")`: Includes terms that might indicate the presence of contact information.
- `shopltk.com`: Ensures that the TikTok profiles being searched are associated with Shopltk.com.

This modification expands the search to include TikTok profiles associated with the specified locations and follower counts, which also mention terms related to contact information. It should help identify profiles that may have personal email addresses listed for contacting purposes.

## Question

no we should look for gmail.com etc

## Answer

To specifically target TikTok profiles that may include Gmail addresses, you can refine the search query to focus on mentions of Gmail domains. Here's the modified query:

**Example Query**:
```
site:tiktok.com ("K followers" | "M followers") ("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls") ("@gmail.com" | "@googlemail.com") shopltk.com
```

This query includes:
- `site:tiktok.com`: Limits the search to TikTok.
- `"K followers" | "M followers"`: Aims to capture any mention of thousands or millions of followers.
- `("Los Angeles" | "LA" | "L.A." | "Hollywood" | "West Hollywood" | "Santa Monica" | "Malibu" | "Venice Beach" | "Beverly Hills" | "Hollywood Hills" | "WeHo" | "Santa Mon" | "Venice Bch" | "Beverly Hls")`: Includes variations of these locations.
- `("@gmail.com" | "@googlemail.com")`: Targets mentions of Gmail domains.
- `shopltk.com`: Ensures that the TikTok profiles being searched are associated with Shopltk.com.

This modification narrows down the search to TikTok profiles associated with specific locations and follower counts, which also mention Gmail domains. It should help identify profiles that may include Gmail addresses for contacting purposes.
