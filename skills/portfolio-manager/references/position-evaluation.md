# Position Evaluation Framework

This document provides a systematic framework for evaluating individual positions within a portfolio to determine appropriate actions: HOLD, ADD, TRIM, or SELL.

## Overview

Position evaluation requires both quantitative analysis and qualitative judgment. This framework helps answer:

1. Is the original investment thesis still intact?
2. Is the position appropriately sized given current conviction and risk?
3. Has the valuation become stretched or attractive?
4. What is the expected forward return vs risk?
5. Are there better opportunities elsewhere?

## Four-Factor Evaluation Model

Every position should be evaluated across four dimensions:

### 1. Thesis Validation (40% weight)
- Is the investment thesis playing out as expected?
- Have fundamentals improved, remained stable, or deteriorated?
- Are growth prospects intact or changed?

### 2. Valuation Assessment (30% weight)
- Is the stock overvalued, fairly valued, or undervalued?
- How does current valuation compare to historical range?
- How does it compare to peer group?

### 3. Position Sizing (20% weight)
- Is current position size appropriate?
- Does it match conviction level?
- Is it creating concentration risk?

### 4. Relative Opportunity (10% weight)
- Are there better uses of capital?
- Would selling this improve portfolio?
- Cost of holding vs deploying elsewhere

## Detailed Evaluation Framework

### Thesis Validation Analysis

**Original Thesis Documentation:**

For each position, document the original investment thesis:

**Example Thesis Template:**
```
Symbol: AAPL
Initial Thesis (Date: Jan 2023):
- Services revenue growing 15%+ annually
- Installed base expansion (1.8B → 2.0B devices)
- Margin expansion from services mix shift
- Capital return program (dividends + buybacks)
- Valuation: P/E 24x vs historical 18x, justified by services growth

Entry Price: $145
Target Price: $180 (12-month)
Expected Return: 24% (+2% dividend = 26% total)
Risk Factors: iPhone demand slowdown, China regulatory risk
```

**Thesis Validation Checklist:**

- [ ] **Revenue/Earnings Growth:** On track vs expectations?
  - Expected: +15% revenue growth
  - Actual: +12% (slightly below, acceptable / -5% (concerning))

- [ ] **Margins:** Improving, stable, or declining?
  - Expected: Expanding by 100bps
  - Actual: Expanded 80bps (close enough / Contracted 50bps (negative))

- [ ] **Competitive Position:** Strengthening or weakening?
  - Market share trends
  - New product success/failures
  - Competitor actions

- [ ] **Management Execution:** Meeting targets?
  - Guidance met/beaten/missed
  - Capital allocation decisions
  - Strategic pivots if any

- [ ] **Industry Tailwinds:** Still present?
  - Secular trends intact?
  - Regulatory changes
  - Technology shifts

**Thesis Status Classification:**

| Status | Criteria | Action Bias |
|--------|----------|-------------|
| **Strengthening** | Fundamentals improving, thesis accelerating | Consider ADD |
| **Intact** | On track with expectations, no changes | HOLD |
| **Weakening** | Some concerns, thesis partially impaired | Consider TRIM |
| **Broken** | Thesis invalid, fundamentals deteriorating | SELL |

### Valuation Assessment

**Valuation Methodology:**

Compare current valuation across multiple dimensions:

**1. Historical Valuation Range**

| Metric | Current | 1Y Avg | 3Y Avg | 5Y Avg | Min | Max |
|--------|---------|--------|--------|--------|-----|-----|
| P/E | 28x | 25x | 22x | 20x | 12x | 35x |
| P/B | 6.5x | 5.8x | 5.2x | 4.8x | 3.5x | 8.0x |
| EV/EBITDA | 22x | 19x | 17x | 16x | 10x | 25x |
| Div Yield | 1.2% | 1.4% | 1.6% | 1.8% | 0.8% | 2.5% |

**Analysis:**
- Current P/E (28x) near 3Y max (35x) → Expensive vs history
- P/B elevated vs 5Y avg → Premium valuation
- Dividend yield low vs range → Not a value play

**2. Peer Group Comparison**

| Company | P/E | P/B | EV/EBITDA | Dividend Yield | Rev Growth | Margin |
|---------|-----|-----|-----------|----------------|------------|--------|
| **[Target]** | 28x | 6.5x | 22x | 1.2% | 12% | 28% |
| Peer A | 22x | 4.2x | 18x | 1.8% | 8% | 22% |
| Peer B | 31x | 7.8x | 25x | 0.9% | 18% | 32% |
| Peer C | 25x | 5.1x | 20x | 1.5% | 10% | 25% |
| **Sector Median** | 25x | 5.5x | 20x | 1.4% | 11% | 26% |

**Analysis:**
- P/E slightly above sector median → Modest premium
- Growth (12%) above median (11%) → Premium partially justified
- Margins (28%) above median (26%) → Quality justifies some premium
- **Assessment:** Fair to slightly expensive vs peers

**3. Growth-Adjusted Valuation (PEG Ratio)**

```
PEG Ratio = P/E / Earnings Growth Rate

Example:
P/E: 28x
Expected EPS growth: 15%
PEG = 28 / 15 = 1.87

Interpretation:
< 1.0 = Undervalued
1.0-2.0 = Fair value
> 2.0 = Overvalued
```

**4. DCF Fair Value Estimate (Simplified)**

If time permits, estimate intrinsic value using discounted cash flow:

```
Fair Value = (FCF × (1 + growth rate)^5) / (discount rate - terminal growth)

Example inputs:
Current FCF: $100B
Growth (5Y): 12%
Discount rate: 10%
Terminal growth: 4%
```

**Valuation Status Classification:**

| Status | Criteria | Action Bias |
|--------|----------|-------------|
| **Undervalued** | Below historical avg, below peers, low PEG | ADD |
| **Fair Value** | In-line with history and peers | HOLD |
| **Overvalued** | Above historical range, premium to peers, high PEG | TRIM |
| **Severely Overvalued** | Extreme multiples, bubble-like | SELL |

### Position Sizing Analysis

**Current Position Assessment:**

```
Position Size = Position Value / Total Portfolio Value

Example:
Position value: $18,000
Portfolio value: $120,000
Position size: 18,000 / 120,000 = 15%
```

**Position Sizing Guidelines:**

| Conviction Level | Target Position Size | Max Position Size |
|------------------|---------------------|-------------------|
| **High Conviction** | 8-12% | 15% |
| **Medium Conviction** | 5-8% | 10% |
| **Low Conviction / Speculative** | 2-5% | 7% |
| **Starter Position** | 2-3% | 5% |

**Position Sizing Risk Assessment:**

| Current Size | Risk Level | Typical Action |
|--------------|-----------|----------------|
| **<5%** | Low | Can add if conviction high |
| **5-10%** | Normal | Monitor |
| **10-15%** | Elevated | Trim if conviction not very high |
| **15-20%** | High | Trim recommended |
| **>20%** | Excessive | Urgent trim required |

**Position Drift Analysis:**

Track how position size has changed due to price appreciation:

```
Position Appreciation Impact:

Initial investment: $10,000 (10% of $100K portfolio)
Other holdings flat, this position doubled
Current value: $20,000 (18% of $110K portfolio)

Position drift: 10% → 18% (increased 8 percentage points)
Exceeded target: Yes (assuming 10% target)
Action: Trim back to 10-12% range
```

**Rebalancing Calculation:**

```
To trim from 18% to 10%:

Target value: $110,000 × 10% = $11,000
Current value: $20,000
Amount to sell: $20,000 - $11,000 = $9,000
Shares to sell: $9,000 / Current Price
```

### Relative Opportunity Analysis

**Opportunity Cost Framework:**

Ask: "If I sold this position today, where would I deploy the capital?"

**Comparison Matrix:**

| Option | Expected Return | Risk Level | Conviction | Notes |
|--------|----------------|------------|-----------|-------|
| **Hold [Current]** | 8% | Medium | Medium | Fairly valued, thesis intact |
| Alternative A | 15% | High | High | Undervalued, strong thesis |
| Alternative B | 10% | Low | Medium | Defensive, lower risk |
| Cash (wait) | 4% | None | N/A | Opportunity cost |

**Decision Logic:**

If (Alternative Expected Return - Hold Expected Return) > Switching Cost:
→ Consider selling current, buying alternative

**Switching Costs to Consider:**
- **Taxes:** Capital gains (15-20% long-term, ordinary income short-term)
- **Transaction costs:** Commissions (minimal) + bid-ask spread
- **Opportunity risk:** Wrong about alternative, miss rebound in current

**Example Calculation:**

```
Current position: Expected 8% return
Alternative: Expected 15% return
Differential: 7%

Unrealized gain: $8,000 on $20,000 position (67% gain)
Tax on sale (20% long-term): $8,000 × 0.20 = $1,600
After-tax proceeds: $20,000 - $1,600 = $18,400

After-tax opportunity gain (1 year):
Hold current: $20,000 × 1.08 = $21,600
Buy alternative: $18,400 × 1.15 = $21,160

Conclusion: Tax drag eliminates benefit for 1-year hold
Consider if: (1) Multi-year horizon, or (2) Tax-advantaged account, or (3) Can tax-loss harvest elsewhere
```

## Position Action Decision Matrix

Combine the four factors to determine action:

### HOLD Decision

**Criteria:**
- ✅ Thesis: Intact or strengthening
- ✅ Valuation: Fair to undervalued
- ✅ Position Size: Within target range (5-10% for medium conviction)
- ✅ Relative Opportunity: No clearly better alternative after costs

**Example:**
```
Position: Johnson & Johnson (JNJ)
Thesis: ✅ Intact (healthcare demand, dividend aristocrat)
Valuation: ✅ Fair (P/E 16x vs 15x historical avg)
Position Size: ✅ 7% of portfolio (target range)
Opportunity: ✅ No compelling alternative in healthcare

Decision: HOLD
Rationale: Position performing as expected, appropriately sized, no reason to change
Next Review: Quarterly earnings (Q3 2024)
```

### ADD Decision

**Criteria:**
- ✅ Thesis: Strengthening or intact with high conviction
- ✅ Valuation: Undervalued or fair with improving fundamentals
- ✅ Position Size: Below target, room to add without excessive concentration
- ✅ Opportunity: Among top ideas, better than alternatives

**Example:**
```
Position: Meta Platforms (META)
Thesis: ✅ Strengthening (AI monetization exceeding expectations, cost discipline)
Valuation: ✅ Undervalued (P/E 22x vs 28x historical, PEG 1.2)
Position Size: ✅ 5% of portfolio (room to add to 8-10%)
Opportunity: ✅ Top conviction, better expected return than alternatives

Decision: ADD 3-5% more (increase position to 8-10% total)
Rationale: Thesis improving, valuation attractive, high conviction
Entry Strategy: Add 3% now, 2% more if pullback to $450 support
Risk Management: Set stop-loss at $420 (recent low)
```

### TRIM Decision

**Criteria:**
- ⚠️ Thesis: Weakening OR still intact but lower conviction
- ⚠️ Valuation: Overvalued or expensive vs historical/peers
- ⚠️ Position Size: Exceeded target (>12% for medium conviction, >15% for high conviction)
- ⚠️ Opportunity: Better alternatives available or risk reduction needed

**Example:**
```
Position: NVIDIA (NVDA)
Thesis: ✅ Intact (AI demand strong) ⚠️ but slowing growth rates expected
Valuation: ⚠️ Expensive (P/E 65x vs 45x historical, extended vs peers)
Position Size: ⚠️ 18% of portfolio (exceeded 15% max)
Opportunity: ⚠️ Other high-quality tech at better valuations

Decision: TRIM from 18% to 10-12%
Rationale: Valuation extended, position too large, take some profits
Trim Strategy: Sell 6% now, consider selling another 2% if rallies above $950
Redeployment: Add to underweight healthcare and financials sectors
Tax Strategy: Sell highest-cost-basis shares first (minimize tax impact)
```

### SELL Decision

**Criteria:**
- ❌ Thesis: Broken or significantly impaired
- OR: Valuation severely overvalued with deteriorating fundamentals
- OR: Better opportunities + need to reduce position count
- OR: Risk management (stop-loss triggered, risk too high)

**Example:**
```
Position: Teladoc (TDOC)
Thesis: ❌ Broken (telehealth adoption slower than expected, competition intense, path to profitability unclear)
Valuation: ❌ Expensive vs peers despite losses (EV/Sales 2.5x vs 1.2x sector)
Position Size: ⚠️ 4% of portfolio (not excessive, but capital can be better deployed)
Opportunity: ❌ Multiple better healthcare alternatives (UNH, ELW, CVS)

Decision: SELL (exit position entirely)
Rationale: Investment thesis has not materialized, competitive position weakening, capital better deployed elsewhere
Exit Strategy: Sell entire position over 2-3 days (avoid moving market)
Redeployment: Reallocate to UnitedHealth Group (stronger healthcare thesis)
Tax Benefit: Harvest $2,000 capital loss to offset gains
Lesson Learned: Avoid unprofitable growth stocks in competitive industries
```

## Position Review Checklist

Use this checklist when reviewing each position:

### Fundamental Review
- [ ] Read recent earnings report and call transcript
- [ ] Review updated financial metrics (revenue, margins, EPS)
- [ ] Check for guidance changes (raised, lowered, maintained)
- [ ] Read recent analyst reports or news
- [ ] Verify competitive position (market share, new entrants)

### Valuation Review
- [ ] Calculate current P/E, P/B, EV/EBITDA
- [ ] Compare to 1Y, 3Y, 5Y historical averages
- [ ] Compare to peer group
- [ ] Calculate PEG ratio
- [ ] Assess if valuation justified by fundamentals

### Portfolio Fit Review
- [ ] Calculate current position size (% of portfolio)
- [ ] Assess if size matches conviction
- [ ] Check if position contributes to concentration risk
- [ ] Verify sector allocation impact
- [ ] Evaluate correlation with other holdings

### Risk Review
- [ ] Identify new risks (regulatory, competitive, macro)
- [ ] Assess if stop-loss should be updated
- [ ] Review downside scenario (what could go wrong?)
- [ ] Check beta and volatility (has it increased?)
- [ ] Evaluate if risk/reward still favorable

### Action Decision
- [ ] Does thesis warrant HOLD/ADD/TRIM/SELL?
- [ ] If change needed, what is specific action?
- [ ] What is timeline for action (immediate, gradual, wait for level)?
- [ ] What are trigger points for future action?
- [ ] Document decision and rationale

## Common Position Evaluation Mistakes

### Mistake 1: Anchoring to Purchase Price

**Problem:** "I bought at $100, now it's $80, I'll wait to break even before selling"

**Why wrong:** Purchase price is irrelevant to forward returns. Sunk cost fallacy.

**Correct approach:** Evaluate position based on current fundamentals and forward outlook. If thesis broken, sell now regardless of gain/loss.

### Mistake 2: Letting Winners Run Indefinitely

**Problem:** "It's my best performer, I'll never sell!"

**Why wrong:** Position becomes oversized, creates concentration risk, valuation may become stretched.

**Correct approach:** Trim winners back to target weight periodically. Take some profits. Reinvest in undervalued areas.

### Mistake 3: Selling Losers Too Quickly

**Problem:** "It's down 15%, I need to cut losses"

**Why wrong:** Volatility is normal. Selling in panic often locks in losses before recovery.

**Correct approach:** Evaluate if thesis still intact. If yes, consider adding (averaging down). If no, sell regardless of loss size.

### Mistake 4: Ignoring Valuation ("Quality at Any Price")

**Problem:** "This is a great company, valuation doesn't matter"

**Why wrong:** Even great companies can be overvalued. Future returns depend on entry price.

**Correct approach:** Great companies at fair prices. Trim when expensive, add when cheap, even for high-quality names.

### Mistake 5: Falling in Love with Stocks

**Problem:** Emotional attachment prevents objective evaluation

**Why wrong:** Stocks don't love you back. Capital allocation should be ruthlessly rational.

**Correct approach:** Treat positions as capital deployment decisions, not relationships. Be willing to sell anything if better opportunity exists.

## Summary

**Position Evaluation Framework:**

1. **Thesis Validation (40%)** - Is the story still true?
2. **Valuation Assessment (30%)** - Is the price right?
3. **Position Sizing (20%)** - Is the size appropriate?
4. **Relative Opportunity (10%)** - Are there better uses of capital?

**Four Actions:**

- **HOLD:** Thesis intact, fair valuation, appropriate size
- **ADD:** Strengthening thesis, undervalued, room to add
- **TRIM:** Weakening thesis OR expensive OR oversized
- **SELL:** Broken thesis OR severely overvalued OR much better alternatives

**Best Practices:**

- Review positions quarterly (at minimum)
- Document thesis at purchase
- Update thesis as new information emerges
- Be willing to admit mistakes early
- Trim winners to maintain diversification
- Average down only if thesis intact
- Ignore purchase price (sunk cost)
- Remain objective and unemotional

**Remember:** Position evaluation is both art and science. Combine quantitative metrics with qualitative judgment. When in doubt, reduce position size rather than holding full position or selling entirely.
