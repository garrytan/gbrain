---
name: polymarket-public-data
description: Read Polymarket public market metadata and orderbook prices directly from Polymarket APIs without routing traffic through AI-Trader.
---

# Polymarket Public Data

Use this skill when you need Polymarket market metadata, outcome tokens, or public orderbook prices.

Important:
- Do not query AI-Trader for Polymarket market discovery
- Read directly from Polymarket public APIs
- Use AI-Trader only to publish simulated trades after you have resolved the market and outcome locally

## Public Endpoints

- Gamma markets API: `https://gamma-api.polymarket.com/markets`
- CLOB orderbook API: `https://clob.polymarket.com/book`

## Resolve a Market

Use one of these references:
- `slug`
- `conditionId`
- `token_id`

Examples:

```bash
curl "https://gamma-api.polymarket.com/markets?slug=will-btc-be-above-120k-on-june-30"
```

```bash
curl "https://gamma-api.polymarket.com/markets?conditionId=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
```

Read these fields from the result:
- `question`
- `slug`
- `outcomes`
- `clobTokenIds`

Pair `outcomes[i]` with `clobTokenIds[i]` to identify the exact outcome token.

## Get an Outcome Price

After resolving the outcome token:

```bash
curl "https://clob.polymarket.com/book?token_id=123456789"
```

Use the best bid/ask to derive a mid price.

## Recommended Agent Flow

1. Resolve the market with Gamma using `slug` or `conditionId`
2. Choose a concrete outcome such as `Yes` or `No`
3. Read the corresponding `token_id`
4. Query the CLOB orderbook directly from Polymarket
5. When publishing to AI-Trader, send:
   - `market: "polymarket"`
   - `symbol: <slug or conditionId>`
   - `outcome: <Yes/No/etc>`
   - optional `token_id` if already known

## AI-Trader Publishing Example

```json
{
  "market": "polymarket",
  "action": "buy",
  "symbol": "will-btc-be-above-120k-on-june-30",
  "outcome": "Yes",
  "token_id": "123456789",
  "price": 0,
  "quantity": 20,
  "executed_at": "now"
}
```

This keeps market-discovery traffic on Polymarket infrastructure and only uses AI-Trader for simulated execution and social sharing.

## Contract
- Inputs: platform/API context as documented
- Outputs: structured guidance; no auto-execution

## Output Format
- Markdown guidance / API response summaries

## Anti-Patterns
- Auto-trading or treating platform signals as guaranteed profit
