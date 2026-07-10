# Market Breadth Analysis Methodology

## Overview

Market breadth measures the degree of participation in a market move. A healthy advance is characterized by broad participation (many stocks rising), while a narrowing market (fewer stocks leading) often precedes corrections.

This methodology uses TraderMonty's breadth dataset to quantify market health across 6 dimensions, producing a composite score from 0 (critical) to 100 (maximum health).

---

## Data Description

### Breadth Index
The breadth index (0-1) measures the proportion of S&P 500 stocks trading above their 200-day moving average. Key derivatives:
- **Raw:** Daily breadth value (percentage of stocks above 200DMA)
- **8-day EMA (8MA):** Short-term exponentially weighted moving average (fast signal)
- **200-day EMA (200MA):** Long-term exponentially weighted moving average (trend filter)

**Important:** Both moving averages use **EMA** (Exponential Moving Average), not SMA. The source repository calculates them as `ewm(span=N, adjust=False)`. EMA gives more weight to recent data points, making it more responsive to changes than SMA.

### Key Thresholds
| Level | Interpretation |
|-------|---------------|
| 8MA > 0.70 | Very strong breadth - broad rally |
| 8MA > 0.60 | Healthy breadth - above average participation |
| 8MA > 0.50 | Neutral - about half of stocks participating |
| 8MA > 0.40 | Weakening - below average participation |
| 8MA < 0.40 | Extreme weakness - potential trough formation |
| 8MA < 0.20 | Crisis levels - rare, precedes major bottoms |

### Signal Flags
- **Breadth_200MA_Trend:** 1 = 200MA rising (bullish regime), -1 = 200MA falling (bearish regime). Uses hysteresis with threshold=0.001 to prevent whipsaw signals.
- **Bearish_Signal:** Backtested signal combining trend and momentum deterioration
- **Is_Peak / Is_Trough:** Cyclical turning points detected using `scipy.signal.find_peaks` with `distance=50, prominence=0.015` on the 200MA. This ensures at least 50 trading days (~10 weeks) between consecutive peaks/troughs and a minimum prominence of 0.015.
- **Is_Trough_8MA_Below_04:** Extreme trough marker detected with `prominence=0.02` on inverted 8MA values below 0.4.

### Pink Zone (Bearish Region)
The source repository's charts use a pink background to highlight the most dangerous market condition:

```
Pink Zone = (Breadth_200MA_Trend == -1) AND (8MA < 200MA)
```

This means the long-term trend is declining AND the short-term breadth has fallen below the long-term average. Historically, markets in the Pink Zone experience elevated volatility and downside risk. The Pink Zone is distinct from the Bearish_Signal flag - it is a structural condition that can persist for weeks or months.

---

## Component Details

### C1: Current Breadth Level & Trend (25%)

**Rationale:** The most direct measure of current market health. Higher 8MA means more stocks participating; uptrend in 200MA means the long-term structure is supportive.

**Weighting within component:**
- 8MA Level: 70% - immediate health snapshot
- 200MA Trend: 30% - longer-term regime confirmation

**8MA Direction Modifier:** A 5-day lookback on the 8MA itself adjusts the score based on the short-term direction of breadth. This ensures C1 considers not just the level, but whether breadth is accelerating or decelerating:

| Condition | Modifier | Rationale |
|-----------|----------|-----------|
| 8MA falling & level > 0.60 | -10 | Deceleration from a high level — early warning of potential peak |
| 8MA falling & level < 0.40 | +5 | Near-bottom with limited further downside — less penalty |
| 8MA rising & level < 0.60 | +5 | Early recovery bonus — breadth improving from a weak base |
| Otherwise | 0 | No adjustment needed |

**Key insight:** An 8MA of 0.65 in an uptrend (score ~80) is healthier than 0.65 in a downtrend (score ~62), because the downtrend context suggests the level may be transient. The direction modifier further differentiates: a falling 8MA at 0.65 signals emerging weakness (-10), while a rising 8MA at the same level confirms strength.

### C2: 8MA vs 200MA Crossover Dynamics (20%)

**Rationale:** The gap between fast and slow MAs reveals momentum. A wide positive gap means breadth is accelerating above trend; a negative gap means it's deteriorating below trend.

**Direction modifier:** When the 8MA is recovering (rising) while still below the 200MA, this early recovery signal adds +10. Conversely, when 8MA is falling while still above 200MA, this early deterioration signal subtracts -10.

**Key insight:** The crossover point (8MA crossing 200MA) is a significant signal. Bull markets maintain 8MA above 200MA; bear phases see 8MA below 200MA.

### C3: Peak/Trough Cycle Position (20%)

**Rationale:** Breadth moves in cycles. Knowing whether we are in the early, middle, or late phase of a cycle helps calibrate expectations.

**Cycle phases:**
1. **Trough → Early Recovery (0-20 days):** Highest potential for upside if 8MA is rising
2. **Sustained Recovery (21-60 days):** Confirmed recovery with decreasing upside magnitude
3. **Mature Recovery (60+ days):** Late-cycle, watch for next peak
4. **Post-Peak Decline (0-20 days):** Highest risk period
5. **Sustained Decline (21-60 days):** Deep correction territory
6. **Prolonged Decline (60+ days):** Potential bottom formation if 8MA starts rising

**Extreme trough bonus:** When 8MA drops below 0.4 at a trough, history shows these are often excellent long-term entry points, warranting a +10 bonus.

### C4: Bearish Signal Status (15%)

**Rationale:** The dataset includes a backtested bearish signal flag that combines multiple factors. Its value depends on context.

**Interpretation matrix:**
| Signal | Trend | Score | Meaning |
|--------|-------|-------|---------|
| Off | Up | 85 | All clear - no concerns |
| Off | Down | 50 | No immediate danger but bearish backdrop |
| On | Up | 30 | Warning in otherwise bullish environment |
| On | Down | 10 | Full bearish alignment |

**Context matters:** A bearish signal when 8MA is above 0.50 is less concerning (+15 adjustment) than one when 8MA is below 0.25 (-5 adjustment).

**Pink Zone integration:** When in the Pink Zone (200MA downtrend + 8MA below 200MA) but without an active bearish signal, a -10 penalty is applied to reflect structural weakness that the bearish flag alone may not capture.

### C5: Historical Percentile (10%)

**Rationale:** Knowing where current breadth stands relative to the full 10-year history provides framing. Is this level normal, unusually high, or unusually low?

**Overheated/oversold adjustments:** When current 8MA approaches the average peak level, a -10 penalty reflects elevated risk of mean reversion. When near the average trough level, a +10 bonus reflects contrarian opportunity.

### C6: S&P 500 vs Breadth Divergence (10%)

**Rationale:** The most dangerous market condition is when the index makes new highs but breadth is declining (fewer stocks participating). This divergence preceded major tops in 2000, 2007, and 2021.

**Multi-Window Analysis (20d + 60d):** Divergence is measured at two time scales and combined:
- **60-day window (weight 60%):** Captures structural, medium-term divergence
- **20-day window (weight 40%):** Detects short-term emerging divergence

Composite score = 60d_score x 0.6 + 20d_score x 0.4

**Early Warning flag:** When the 20-day window shows bearish divergence (score <= 25) while the 60-day window is still healthy (score >= 50), an Early Warning is triggered. This signals that short-term breadth deterioration has begun before it becomes visible in the structural window.

**Near-flat classification:** When both S&P 500 change and breadth change are below noise thresholds (|S&P %| < 0.5 and |breadth change| < 0.01), the window is classified as "Near-flat (insufficient movement)" with a neutral score of 50. This prevents misclassification of trivial movements as divergence or alignment signals.

**Key patterns (per window):**
- **S&P up + Breadth up:** Healthy, sustainable rally (70)
- **S&P up + Breadth down:** Dangerous narrow market (10-25)
- **S&P down + Breadth up:** Bullish divergence, potential bottom (65-80)
- **S&P down + Breadth down:** Consistent decline, wait for stabilization (30)
- **Both near-flat:** Neutral (50) - insufficient movement to classify

### Weight Redistribution

When a component has `data_available: False` (e.g., insufficient rows for divergence analysis), its weight is excluded and the remaining weights are proportionally redistributed:

```
effective_weight[i] = base_weight[i] / sum(base_weight[j] for all available j)
```

**Example:** If C6 (10%) is unavailable, the remaining 90% is redistributed:
- C1: 25/90 = 27.8%, C2: 20/90 = 22.2%, C3: 20/90 = 22.2%, C4: 15/90 = 16.7%, C5: 10/90 = 11.1%

**Zero-division guard:** If all components are unavailable, the composite score defaults to 50 with zone "Neutral" and a warning that the score is a reference value only.

**Data Quality Labels:**

| Available Components | Label | Interpretation |
|---------------------|-------|----------------|
| 6/6 | Complete | Full confidence |
| 4-5/6 | Partial | Interpret with caution |
| 0-3/6 | Limited | Low confidence |

---

## Composite Score Interpretation

### Zone Thresholds

| Score | Zone | Exposure | Key Actions |
|-------|------|----------|-------------|
| 80-100 | **Strong** | 90-100% | Full position sizing; growth/momentum strategies; wide stops |
| 60-79 | **Healthy** | 75-90% | Normal operations; standard risk management |
| 40-59 | **Neutral** | 60-75% | Selective; tighter stops; avoid speculative names |
| 20-39 | **Weakening** | 40-60% | Profit-taking; raise cash; defensive rotation |
| 0-19 | **Critical** | 25-40% | Capital preservation; hedging; watch for trough |

### Guidance Caution Warning

When the 8MA direction modifier is negative in C1 (Breadth Level & Trend) or C2 (MA Crossover), the report automatically appends a Caution warning to the Overall Assessment guidance. This alerts analysts that the zone-based guidance (e.g., "Normal operations") may be overly optimistic given the deteriorating short-term momentum.

The Caution warning also triggers additional protective actions in the Recommended Actions section:
- "Reduce new position sizes until 8MA stabilizes"
- "Tighten stop-loss levels on existing positions"

These are appended to the standard zone-based actions, not replacing them.

### Cross-Referencing with Other Skills

- **Market Top Detector:** If breadth is Weakening (20-39) AND top detector is Orange/Red, this is strong confirmation of topping conditions.
- **CANSLIM Screener:** In Strong/Healthy zones, CANSLIM stock selections have higher success rates.
- **Sector Analyst:** Weakening breadth often coincides with rotation from offensive to defensive sectors.

### Score History & Trend

The analyzer maintains a rolling history of composite scores to detect trend direction.

**Storage format:** JSON file (`market_breadth_history.json`) in the output directory, structured as an array of objects:

```json
[
  {"data_date": "2025-06-10", "composite_score": 72.3, "component_scores": {"breadth_level_trend": 80, "ma_crossover": 70, "...": "..."}, "recorded_at": "2025-06-10 14:30:00"},
  {"data_date": "2025-06-11", "composite_score": 68.1, "component_scores": {"breadth_level_trend": 75, "ma_crossover": 65, "...": "..."}, "recorded_at": "2025-06-11 09:15:00"}
]
```

**Key rules:**
- **Keyed by data date:** Each entry uses the latest data row's date, not the analysis run date.
- **Duplicate prevention:** If an entry with the same date already exists, it is overwritten (no duplicates).
- **Rolling window:** Maximum 20 entries retained. When the limit is reached, the oldest entry is pruned first.
- **Trend detection:** The delta between the first and last score in the most recent N entries (default N=5) determines the trend label:
  - `delta > 2` → "Improving"
  - `delta < -2` → "Deteriorating"
  - `-2 <= delta <= 2` → "Stable"

**Usage in reports:** The trend summary (`direction`, `delta`, `entries`) is included in both JSON and Markdown outputs, giving analysts a quick read on whether market breadth is accelerating or decelerating.

---

## Historical Context

### Average Values (from Summary CSV)
- **Average Peak (200MA):** ~0.729 - breadth cycles typically top around this level
- **Average Trough (8MA < 0.4):** ~0.232 - extreme troughs average around this level
- **Peak Count:** ~5 over 10 years (roughly every 2 years)
- **Trough Count:** ~10 extreme troughs (roughly twice per year on average)

### Notable Historical Patterns
- **COVID-19 (March 2020):** 8MA crashed to extreme lows, followed by one of the sharpest breadth recoveries in history
- **2022 Bear Market:** Sustained period of 8MA below 200MA with multiple bearish signals
- **2023 Recovery:** Gradual breadth improvement with 8MA crossing above 200MA

---

## Live Resources

- **Interactive Dashboard:** https://tradermonty.github.io/market-breadth-analysis/
- **Data CSV:** https://tradermonty.github.io/market-breadth-analysis/market_breadth_data.csv
- **Summary CSV:** https://tradermonty.github.io/market-breadth-analysis/market_breadth_summary.csv
- **Source Repository:** https://github.com/tradermonty/market-breadth-analysis

Data is automatically updated twice daily via GitHub Actions. CSV files are freely accessible without API keys.

---

## Limitations

1. **Lagging indicator:** Breadth data reflects what has happened, not what will happen. Use alongside forward-looking indicators.
2. **No sector granularity:** The breadth index is market-wide. A few large sectors can dominate the reading.
3. **CSV update frequency:** Data depends on TraderMonty's update schedule. Check data freshness before analysis.
4. **Single market:** Covers S&P 500 only. Does not reflect international markets, small caps, or other asset classes.
5. **No volume context:** The breadth index is price-based and does not incorporate volume data.
