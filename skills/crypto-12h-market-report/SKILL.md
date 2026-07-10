---
name: crypto-12h-market-report
description: Run Adam's 12-hour crypto market report with MoA synthesis. Combines scanner script data, trading-skills analysis, AI-Trader market-intel/Polymarket read-only context, 3x verification gate, and no auto-trade. Use for crypto-12h cron and manual 12h reports.
version: 1.2.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [crypto, trading, report, moa, 12h, bybit, phemex, binance, ai-trader]
    related_skills:
      - crypto-opportunity-scanner
      - crypto-trade-verification-gate
      - trading-skills-navigator
      - market-news-analyst
      - macro-regime-detector
      - technical-analyst
      - scenario-analyzer
      - pre-trade-discipline-gate
      - market-intel
      - polymarket-public-data
      - ai-trader
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

### Local crypto
- `crypto-opportunity-scanner`, `crypto-trade-verification-gate`

### tradermonty/claude-trading-skills (Hermes `trading/`)
- `trading-skills-navigator`, `market-news-analyst`, `macro-regime-detector`
- `technical-analyst`, `scenario-analyzer`, `pre-trade-discipline-gate`

### HKUDS/AI-Trader (Hermes `ai-trader/` + `trading/` symlinks)
| Skill | Role in 12h report |
|---|---|
| `market-intel` | **Read-only** financial-event snapshots / news board context |
| `polymarket-public-data` | Optional sentiment: resolve crypto-related Polymarket odds (public APIs only) |
| `ai-trader` | Platform reference only — **do not auto-register or auto-trade** |
| `ai-trader-copytrade` / `ai-trader-tradesync` / `ai-trader-heartbeat` | **Not used** in 12h report (copy/sync requires explicit user opt-in) |

Equity-only screeners are optional context only — never force US stock picks into crypto report.

## Non-negotiable
- Never execute trades (exchange, copytrade, or AI-Trader operations)
- Never auto-register AI-Trader agents without Adam's explicit email/token approval
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

2. **AI-Trader market intel (read-only, best-effort)**  
   Follow `market-intel` skill endpoints (AI-Trader public snapshots). On HTTP failure, skip and note `market_intel: unavailable`.  
   Optional: if BTC/ETH event narrative needs prediction-market odds, use `polymarket-public-data` (Gamma/CLOB public APIs only).

3. **Enrich (skill patterns)**  
   From scanner + market-intel + web if needed, draft:
   - Market regime (risk-on / risk-off / range / high-vol)
   - BTC/ETH context (trend, vol)
   - Top 3 candidates max
   - Rejected short list
   - News/macro catalysts (last ~12h)
   - Polymarket crypto narrative (if fetched)

4. **MoA synthesis**  
   Fan-out the same structured brief to MoA references; aggregator produces final report (concise, Telegram-ready).

5. **Verification gate**  
   Any trade plan → `crypto-trade-verification-gate` 3×. If not 3/3 → map-only.

6. **Deliver**  
   Telegram markdown.

## Output Format
```markdown
# Crypto 12h Market Report
- window: <UTC or local>
- moa: triad | offline
- data: Bybit + Phemex + Binance
- market_intel: ok | unavailable
- polymarket: skipped | ok

## Regime
...

## BTC / majors
...

## Market intel / narrative
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
- Side effects: none (no orders, no AI-Trader register/copy)

## Anti-Patterns
- Auto-trade / copytrade / tradesync without explicit user command
- Emitting unverified entry plans
- Replacing scanner data with pure LLM prices
- Using AI-Trader marketplace as sole signal without scanner verification
- Using US equity screener skills as crypto signals without adaptation

## Cron wiring
- schedule: `17 */12 * * *`
- skills include this skill + crypto scanners + market-intel + polymarket-public-data
- model: MoA triad / provider `moa`
- never execute trades
