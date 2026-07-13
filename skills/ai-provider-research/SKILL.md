---
name: ai-provider-research
description: Research and compare AI/API providers, aggregators, proxies, pricing, compatibility, and operational risk using fresh source evidence and explicit calculations.
triggers:
  - compare AI API providers
  - find cheaper LLM API provider
  - official pricing versus proxy pricing
  - OpenAI-compatible provider research
  - Claude API aggregator comparison
  - LLM API pricing risk ranking
writes_pages: false
mutating: false
---

# AI Provider Research

## Contract

A run of this skill is complete when:

1. Primary pricing/model pages are refreshed before making price claims.
2. Candidate set includes multiple provider classes, not just the first plausible vendor.
3. Token/character pricing is normalized with the formula shown.
4. Recommendation separates price, compatibility, payment/legal fit, privacy/logging risk, and reliability.

## Output Format

- Ranked shortlist table.
- Pricing comparison with formula and units.
- Risk notes per provider.
- Recommended smoke test matrix for the user’s toolchain.

## Anti-Patterns

- Calling a cheap provider reliable without evidence.
- Mixing official routes and proxy/alternative routes without labeling the route.
- Flattening complex pricing into one number without showing units and assumptions.

## Procedure

Use this skill when the user asks to compare AI/API providers, find cheaper alternatives, evaluate reliability, or benchmark official pricing vs proxies/aggregators.

### Core principles

1. **Refresh pricing from primary pages first.** Provider prices change often; never rely only on memory or old reference notes.
2. **Do not stop at the first plausible vendor.** Build a candidate set, then rank it. If the user asks for “more variants”, broaden search terms and include weaker candidates with explicit caveats.
3. **Compare like-for-like.** For token pricing, split input/output/cache when possible. When a quick scalar comparison is needed, compute `80% input + 20% output` and label it as an estimate.
4. **Use the user’s FX rate if provided.** If the user corrects the exchange rate, recalculate instead of arguing; ratios between ₽ services are unaffected, but ₽↔USD comparisons change.
5. **Separate price from risk.** Very cheap providers need explicit caveats: route opacity, rate limits, privacy/logging, upstream substitution, stability, and whether they use official routes or alternative backends.
6. **Be concise but evidence-backed.** Prefer ranked shortlists and tables over long prose. Mention sources by service/page and highlight what was actually verified.

### Workflow

1. **Clarify the target only if necessary.** Otherwise assume the relevant target is LLM API use for coding agents/IDE integrations when the conversation mentions Claude Code, Codex, Cursor, Cline, OpenCode, etc.
2. **Gather candidates from multiple query styles:**
   - direct: `<provider> pricing`, `OpenAI API Claude API оплата в рублях`, `российский LLM API агрегатор`
   - comparative: `alternatives ProxyAPI`, `топ агрегаторов API нейросетей без VPN`
   - exact phrases from found pages: `OpenAI-compatible`, `base_url`, `Claude Code`, `ЭДО`, `СБП`, `карта РФ`
3. **Extract for each candidate:**
   - API compatibility / base URL
   - model coverage
   - payment methods and documents for legal entities
   - public legal/requisites signals
   - pricing for the user’s key models
   - rate limits, logs/privacy, fallback/routing if published
4. **Calculate standard comparisons:**
   - `80/20 = 0.8 * input + 0.2 * output`
   - `cheaper_x = baseline_80_20 / candidate_80_20`
   - compare against official pricing separately from reseller/proxy pricing.
5. **Rank by use case, not only price:**
   - cheapest test provider
   - most reliable RU intermediary
   - best for dev tooling / agents
   - best for corporate documents / ЭДО
   - fallback option
6. **Recommend a small paid smoke test when practical:** same prompt set across 2–4 providers; test streaming, tool calling, JSON schema, long context, agent CLI compatibility, latency, failures, and billing accuracy.

### Pitfalls

- Do not call a service “reliable” solely because it is cheap.
- Do not mix official Anthropic/OpenAI routes with alternative routes without labelling the route; providers may show very different prices per backend.
- Do not flatten complex pricing into one number without showing the formula.
- Watch units carefully: some RU services price by **1K characters** rather than 1M tokens. For these, show a range using 2–4 chars/token and do not present the converted result as exact.
- For JS/SPA provider sites that return 406 or partial pages via extraction, try their browser-rendered page, `.md` documentation links, or `llms-full.txt` indexes before giving up. RouterAI specifically exposes `https://routerai.ru/llms-full.txt` and docs pages often have “open as Markdown” links.
- Avoid stale definitive claims. Say “as of checked pages” and recommend refreshing before purchase.
- If a scraped page fails, use browser/alternate URLs/search snippets where allowed, but label unverified pricing clearly.

### Reference notes

- See `references/ru-llm-api-intermediaries-2026.md` for a condensed snapshot of RU-facing LLM API intermediaries and comparison heuristics discovered in a July 2026 research session. Treat it as a starting map, not current truth.

## Verification Checklist

- [ ] The answer is grounded in current sources or explicit live probe output when the task requires freshness.
- [ ] Private credentials, cookies, sessions, personal names, and internal infrastructure are absent or redacted.
- [ ] Uncertainty is labeled instead of hidden behind a confident recommendation.
- [ ] The final response gives the user a concrete next action, not only background context.
