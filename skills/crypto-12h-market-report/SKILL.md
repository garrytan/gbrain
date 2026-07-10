---
name: crypto-12h-market-report
description: Run Adam's 12-hour crypto market report with MoA synthesis. Combines scanner script data, trading-skills analysis patterns, 3x verification gate, and no auto-trade. Use for crypto-12h cron and manual 12h reports.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [crypto, trading, report, moa, 12h, bybit, phemex, binance]
    related_skills:
      - crypto-opportunity-scanner
      - crypto-trade-verification-gate
      - trading-skills-navigator
      - market-news-analyst
      - macro-regime-detector
      - technical-analyst
      - scenario-analyzer
      - pre-trade-discipline-gate
---

# Crypto 12h Market Report (MoA)

## When to use
- Cron job `crypto-12h-market-report`
- User asks for 12h crypto market report / map / best setups

## Model: MoA required
Use Hermes MoA preset **`triad`** (or active MoA):
- `openai-codex:gpt-5.6-sol`
- `xai-oauth:grok-4.5`
- `nous:tencent/hy3:free`
- Aggregator: `openai-codex:gpt-5.6-sol`

If MoA unavailable, fall back to strongest single model and label `moa: offline`.

## Related skill packs
Installed from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) under Hermes `trading/`:
- `trading-skills-navigator` — route analysis tasks
- `market-news-analyst` — macro/news impact (crypto lens)
- `macro-regime-detector` — regime framing (adapt cross-asset to crypto risk-on/off)
- `technical-analyst` — structure/levels (BTC/ETH majors)
- `scenario-analyzer` — bull/base/bear paths
- `pre-trade-discipline-gate` — no sloppy plan language
- Local: `crypto-opportunity-scanner`, `crypto-trade-verification-gate`

Equity-only screeners in the pack are **optional context only** — never force US stock picks into crypto report.

## Non-negotiable
- Never execute trades
- Futures max loss **$1–$4** per trade if plan emitted
- Plans only after **3/3** verification (`crypto-trade-verification-gate`)
- Manual execution by Adam only
- Fail-closed on stale/missing multi-exchange data → `NO TRADE`

## Pipeline
1. **Data (deterministic)**  
   ```bash
   /home/adam/.hermes/scripts/crypto_scanner.py --mode report
   ```
   Capture stdout as `SCANNER_RAW`.

2. **Enrich (skill patterns, not full equity workflow)**  
   From scanner + web if needed, draft:
   - Market regime (risk-on / risk-off / range / high-vol)
   - BTC/ETH context (trend, vol)
   - Top 3 candidates max
   - Rejected short list
   - News/macro catalysts (if material in last ~12h)

3. **MoA synthesis**  
   Fan-out the same structured brief to MoA references; aggregator produces final report in English or Indonesian per user preference (default: concise dual-friendly).

4. **Verification gate**  
   Any trade plan → run `crypto-trade-verification-gate` 3×. If not 3/3 → keep plan out; report remains map-only.

5. **Deliver**  
   Telegram-ready markdown, concise.

## Output Format
```markdown
# Crypto 12h Market Report
- window: <UTC or local>
- moa: triad | offline
- data: Bybit + Phemex + Binance

## Regime
...

## BTC / majors
...

## Best candidates (max 3)
| asset | bias | why | risk note |
|---|---|---|---|

## Trade plans
Only if 3/3 verified; else: `NO TRADE — map only`

## Watchlist
...

## Rejected
...
```

## Contract
- Inputs: optional focus assets; always run full scanner first
- Outputs: report markdown; optional verified plans
- Side effects: none (no orders)

## Anti-Patterns
- Auto-trade / exchange private API orders
- Emitting unverified entry plans
- Spamming low-quality setups
- Replacing scanner data with pure LLM prices
- Using US equity screener skills as crypto signals without adaptation

## Cron wiring
Preferred job shape (agent + MoA, not no_agent script-only):
- schedule: `17 */12 * * *`
- skills: `crypto-12h-market-report`, `crypto-opportunity-scanner`, `crypto-trade-verification-gate`
- model: MoA triad / provider `moa`
- prompt: follow this skill end-to-end; never execute trades
- Optional: still run scanner script inside the agent for live data
