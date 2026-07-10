# Endpoint Selection

Ask this before picking an endpoint:

- **What should Firecrawl do in the product?**

Use the narrowest endpoint that matches the feature:

| Endpoint | Use when | Do not start here when |
|---|---|---|
| `/scrape` | You already have the URL and need one page | The feature starts with a query |
| `/search` | The feature starts with a query and must discover sources | The target URL is already known |
| `/interact` | The page must be clicked, typed into, or navigated after scrape | Plain `/scrape` already returns the data |

Default priority for most product integrations:

1. `/scrape`
2. `/search`
3. `/interact`

Escalation rules:

- Start with `/scrape` before `/interact`.
- Start with `/search` when URL discovery is part of the product behavior.
