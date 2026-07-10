# Portfolio Risk Metrics

This document provides comprehensive guidance on measuring and interpreting portfolio risk using standard financial metrics.

## Overview

Portfolio risk assessment requires both quantitative metrics and qualitative judgment. This guide covers:

1. Volatility-based metrics (standard deviation, beta)
2. Downside risk measures (maximum drawdown, semi-deviation)
3. Risk-adjusted return metrics (Sharpe ratio, Sortino ratio)
4. Concentration and correlation metrics
5. Interpretation frameworks for different investor types

## Volatility Metrics

### Standard Deviation (σ)

**Definition:** Measure of how much returns vary from the average return over time.

**Formula:**
```
σ = √[Σ(R_i - R_avg)² / (n-1)]

Where:
R_i = Return in period i
R_avg = Average return
n = Number of periods
```

**Interpretation:**

| Annual Std Dev | Risk Level | Typical Assets |
|---------------|------------|----------------|
| **<5%** | Very Low | Cash, short-term bonds |
| **5-10%** | Low | Bond portfolios, conservative balanced |
| **10-15%** | Moderate | Balanced portfolios (60/40), dividend stocks |
| **15-20%** | High | Stock portfolios, growth stocks |
| **>20%** | Very High | Small caps, emerging markets, sector funds |

**S&P 500 Historical:** ~15-18% annualized standard deviation

**Usage in Portfolio Analysis:**
- Compare portfolio volatility to benchmarks
- Assess if volatility matches investor risk tolerance
- Track changes in volatility over time (increasing volatility = warning sign)

**Limitations:**
- Assumes normal distribution (actual returns have "fat tails")
- Treats upside and downside volatility equally
- Based on historical data (may not predict future)

### Beta (β)

**Definition:** Measure of portfolio sensitivity to market movements.

**Formula:**
```
β = Cov(R_portfolio, R_market) / Var(R_market)

Or estimated as:
β = (Σw_i × β_i)

Where:
w_i = Weight of position i
β_i = Beta of position i
```

**Interpretation:**

| Beta | Market Sensitivity | Portfolio Behavior |
|------|-------------------|-------------------|
| **β < 0.5** | Very low | Defensive, low correlation to market |
| **β = 0.5-0.8** | Low | Below-market volatility, defensive tilt |
| **β = 0.8-1.0** | Moderate | Slightly less volatile than market |
| **β = 1.0** | Market | Moves in line with market (index-like) |
| **β = 1.0-1.3** | Moderate-high | More volatile than market |
| **β = 1.3-1.6** | High | Significantly more volatile |
| **β > 1.6** | Very high | Extremely volatile, aggressive |

**Typical Security Betas:**
- Utilities: 0.4-0.7
- Consumer Staples: 0.5-0.8
- Healthcare: 0.8-1.1
- S&P 500 Index: 1.0
- Technology: 1.1-1.5
- Small-cap growth: 1.3-2.0
- Leveraged ETFs: 2.0-3.0

**Example Portfolio Beta Calculation:**

Portfolio:
- 40% SPY (S&P 500 ETF, β=1.0): 0.40 × 1.0 = 0.40
- 30% QQQ (Nasdaq ETF, β=1.2): 0.30 × 1.2 = 0.36
- 20% VNQ (REIT ETF, β=0.9): 0.20 × 0.9 = 0.18
- 10% TLT (Bond ETF, β=0.3): 0.10 × 0.3 = 0.03

**Portfolio Beta** = 0.40 + 0.36 + 0.18 + 0.03 = **0.97**

**Interpretation:** Portfolio expected to move 97% as much as the market (slightly defensive).

**Usage:**
- Assess portfolio aggressiveness
- Predict portfolio behavior in market moves (β=1.2 means 12% drop when market drops 10%)
- Identify need for hedging or rebalancing

**Limitations:**
- Beta changes over time
- Based on historical correlations
- May not hold in extreme markets

### Semi-Deviation

**Definition:** Standard deviation of returns below the mean (focuses on downside volatility only).

**Formula:**
```
Semi-deviation = √[Σ(R_i - R_avg)² for all R_i < R_avg / n]
```

**Interpretation:**
- Lower semi-deviation = better downside protection
- Useful for risk-averse investors who care more about losses than gains
- Typically 60-70% of standard deviation for symmetric distributions

**Usage:**
- Evaluate downside risk specifically
- Compare defensive vs aggressive strategies
- Input for Sortino ratio (risk-adjusted return metric)

## Downside Risk Metrics

### Maximum Drawdown (MDD)

**Definition:** Largest peak-to-trough decline in portfolio value over a specific period.

**Formula:**
```
MDD = (Trough Value - Peak Value) / Peak Value

Or: MDD = max[(P_peak - P_trough) / P_peak] over all peaks
```

**Example:**
- Portfolio peak: $150,000 (March 2020)
- Portfolio trough: $105,000 (March 2020 crash)
- MDD = ($105k - $150k) / $150k = **-30%**

**Historical Maximum Drawdowns:**

| Asset/Portfolio | Max Drawdown | Period |
|----------------|--------------|--------|
| S&P 500 | -57% | 2007-2009 (Financial Crisis) |
| S&P 500 | -34% | 2020 (COVID Crash) |
| Nasdaq 100 | -83% | 2000-2002 (Tech Bubble) |
| Nasdaq 100 | -32% | 2021-2022 (Rate Hikes) |
| 60/40 Portfolio | -32% | 2007-2009 |
| Treasury Bonds | -48% | 2020-2023 (Rising Rates) |

**Risk Tolerance Guide:**

| Investor Type | Max Acceptable Drawdown |
|--------------|------------------------|
| **Conservative** | -10 to -15% |
| **Moderate** | -15 to -25% |
| **Growth** | -25 to -35% |
| **Aggressive** | -35 to -50% |

**Usage:**
- Assess worst-case historical scenario
- Compare to investor risk tolerance
- Set risk management triggers (e.g., hedge if drawdown >20%)
- Estimate recovery time needed

**Recovery Time:**
- 20% drawdown requires +25% gain to recover
- 30% drawdown requires +43% gain
- 50% drawdown requires +100% gain (doubling)

### Current Drawdown

**Definition:** Decline from most recent peak to current value.

**Formula:**
```
Current Drawdown = (Current Value - Recent Peak Value) / Recent Peak Value
```

**Example:**
- Recent peak: $150,000 (last month)
- Current value: $142,500
- Current drawdown = ($142.5k - $150k) / $150k = **-5%**

**Interpretation:**

| Current Drawdown | Status | Action |
|-----------------|--------|--------|
| **0%** | At all-time high | Monitor for complacency |
| **-1% to -5%** | Minor pullback | Normal, no action |
| **-5% to -10%** | Moderate correction | Review positions, monitor |
| **-10% to -20%** | Correction | Assess portfolio, consider adjustments |
| **>-20%** | Bear market territory | Review allocation, consider rebalancing |

**Usage:**
- Real-time risk monitoring
- Identify when portfolio is under stress
- Trigger rebalancing or risk reduction

### Value at Risk (VaR)

**Definition:** Maximum expected loss over a given time period at a given confidence level.

**Example:**
- 1-month VaR at 95% confidence = $10,000
- **Interpretation:** 95% confident that portfolio will not lose more than $10,000 in the next month (or: 5% chance of losing more than $10,000)

**Calculation Methods:**

1. **Historical VaR:** Use historical return distribution
2. **Parametric VaR:** Assume normal distribution, use mean and std dev
3. **Monte Carlo VaR:** Simulate thousands of scenarios

**Simplified Parametric VaR Formula:**
```
VaR = Portfolio Value × (z-score × σ - μ)

Where:
z-score = 1.65 for 95% confidence, 2.33 for 99% confidence
σ = Portfolio standard deviation (daily or monthly)
μ = Expected return (daily or monthly)
```

**Example Calculation:**
- Portfolio value: $100,000
- Annual std dev: 18%
- Monthly std dev: 18% / √12 = 5.2%
- Expected monthly return: 0.5%

**95% 1-month VaR:**
```
VaR = $100,000 × (1.65 × 5.2% - 0.5%)
    = $100,000 × (8.58% - 0.5%)
    = $100,000 × 8.08%
    = $8,080
```

**Interpretation:** 95% confident that portfolio will not lose more than $8,080 in the next month.

**Usage:**
- Risk budgeting
- Setting position limits
- Regulatory compliance (for institutions)

**Limitations:**
- Assumes historical patterns continue
- Underestimates tail risk (extreme events)
- Doesn't tell you about losses beyond VaR threshold

## Risk-Adjusted Return Metrics

### Sharpe Ratio

**Definition:** Excess return per unit of risk (reward-to-variability ratio).

**Formula:**
```
Sharpe Ratio = (R_portfolio - R_f) / σ_portfolio

Where:
R_portfolio = Portfolio return (annualized)
R_f = Risk-free rate (typically 10-year Treasury)
σ_portfolio = Portfolio standard deviation (annualized)
```

**Example Calculation:**
- Portfolio return: 12%
- Risk-free rate: 4%
- Portfolio std dev: 15%

**Sharpe = (12% - 4%) / 15% = 8% / 15% = 0.53**

**Interpretation:**

| Sharpe Ratio | Quality | Interpretation |
|--------------|---------|----------------|
| **< 0** | Poor | Return less than risk-free rate |
| **0 - 0.5** | Suboptimal | Low excess return for risk taken |
| **0.5 - 1.0** | Good | Adequate risk-adjusted return |
| **1.0 - 2.0** | Very Good | Strong risk-adjusted return |
| **> 2.0** | Excellent | Exceptional risk-adjusted return |

**Typical Sharpe Ratios:**
- S&P 500 (long-term): 0.3-0.5
- Well-managed equity portfolio: 0.5-0.8
- Exceptional hedge fund: 1.0-1.5
- Market-neutral strategy: 1.5-2.0+

**Usage:**
- Compare different portfolios or strategies
- Assess if additional risk is being compensated
- Benchmark against market (S&P 500 Sharpe)

**Limitations:**
- Penalizes upside volatility equally with downside
- Assumes normal distribution
- Sensitive to time period chosen

### Sortino Ratio

**Definition:** Like Sharpe ratio, but uses downside deviation instead of total volatility.

**Formula:**
```
Sortino Ratio = (R_portfolio - R_f) / Semi-deviation

Where semi-deviation only counts returns below risk-free rate
```

**Example:**
- Portfolio return: 12%
- Risk-free rate: 4%
- Semi-deviation (downside only): 10%

**Sortino = (12% - 4%) / 10% = 0.80**

**Interpretation:**
- Higher Sortino = better downside-adjusted returns
- Sortino typically higher than Sharpe (since semi-deviation < standard deviation)
- Preferred metric for risk-averse investors

**Usage:**
- Evaluate strategies with asymmetric returns (e.g., option strategies)
- Focus on downside protection
- Compare portfolios with different return distributions

### Calmar Ratio

**Definition:** Return relative to maximum drawdown.

**Formula:**
```
Calmar Ratio = Annualized Return / |Max Drawdown|
```

**Example:**
- Annualized return: 10%
- Max drawdown: -25%

**Calmar = 10% / 25% = 0.40**

**Interpretation:**

| Calmar Ratio | Quality |
|--------------|---------|
| **< 0.5** | Poor (high drawdown relative to return) |
| **0.5 - 1.0** | Acceptable |
| **1.0 - 2.0** | Good |
| **> 2.0** | Excellent (low drawdown, high return) |

**Usage:**
- Focus on worst-case scenarios
- Evaluate hedge funds and absolute return strategies
- Assess recovery potential

## Concentration and Correlation Metrics

### Concentration Metrics

**1. Top-N Concentration**

Percentage of portfolio in largest N positions:

```
Top-N % = (Σ Top N Position Values) / Total Portfolio Value
```

**Guidelines:**
- Top 1 position: <10% ideal, <15% maximum
- Top 5 positions: <40% ideal, <50% maximum
- Top 10 positions: <60% ideal, <70% maximum

**2. Herfindahl-Hirschman Index (HHI)**

(See diversification-principles.md for detailed explanation)

```
HHI = Σ(Weight_i × 100)²
```

**Quick Assessment:**
- HHI < 1000: Well-diversified
- HHI 1000-1800: Moderately concentrated
- HHI > 1800: High concentration

### Correlation Metrics

**Average Pairwise Correlation**

Average correlation between all position pairs:

```
Avg Correlation = Σ(ρ_ij) / Number of pairs

Where:
ρ_ij = correlation between positions i and j
Number of pairs = n(n-1)/2 for n positions
```

**Example (5 positions):**
- 10 pairs total
- Sum of correlations: 5.2
- Average: 5.2 / 10 = **0.52**

**Interpretation:**

| Avg Correlation | Diversification Quality |
|----------------|------------------------|
| **< 0.3** | Excellent (low correlation) |
| **0.3 - 0.5** | Good |
| **0.5 - 0.7** | Moderate (typical equity portfolio) |
| **> 0.7** | Poor (positions move together) |

## Risk Scoring Framework

### Composite Risk Score (0-100)

Combine multiple metrics into single score:

**Scoring Formula:**

```
Risk Score =
  (Volatility Score × 30%) +
  (Beta Score × 20%) +
  (Drawdown Score × 25%) +
  (Concentration Score × 25%)
```

**Individual Component Scores (0-100):**

**1. Volatility Score:**
- <10% std dev: 0-20 points (low risk)
- 10-15% std dev: 20-40 points
- 15-20% std dev: 40-60 points
- 20-25% std dev: 60-80 points
- >25% std dev: 80-100 points (very high risk)

**2. Beta Score:**
- β < 0.8: 0-20 points
- β 0.8-1.0: 20-40 points
- β 1.0-1.3: 40-60 points
- β 1.3-1.6: 60-80 points
- β > 1.6: 80-100 points

**3. Drawdown Score:**
- Max DD <10%: 0-20 points
- Max DD 10-20%: 20-40 points
- Max DD 20-30%: 40-60 points
- Max DD 30-40%: 60-80 points
- Max DD >40%: 80-100 points

**4. Concentration Score:**
- HHI <1000: 0-20 points
- HHI 1000-1500: 20-40 points
- HHI 1500-2000: 40-60 points
- HHI 2000-2500: 60-80 points
- HHI >2500: 80-100 points

**Composite Risk Score Interpretation:**

| Score | Risk Level | Appropriate For |
|-------|-----------|-----------------|
| **0-20** | Very Low | Ultra-conservative, retirees |
| **20-40** | Low | Conservative investors |
| **40-60** | Moderate | Balanced investors |
| **60-80** | High | Growth-oriented investors |
| **80-100** | Very High | Aggressive, long time horizon |

## Practical Risk Assessment Workflow

### Step 1: Calculate Basic Metrics

1. **Portfolio Beta** (weighted average of position betas)
2. **Standard Deviation** (if historical data available, else estimate)
3. **Maximum Drawdown** (from portfolio history)
4. **Current Drawdown** (vs recent peak)
5. **Top-5 Concentration** (sum of 5 largest positions)
6. **HHI** (concentration index)

### Step 2: Compare to Benchmarks

**Against S&P 500:**
- Is beta higher or lower than 1.0?
- Is volatility higher or lower than ~16%?

**Against Risk Profile Targets:**
- Does risk level match investor's stated risk tolerance?
- Is maximum drawdown acceptable?

### Step 3: Identify Risk Concentrations

**Position-Level:**
- Any position >15%? → Immediate trim
- Top 5 >50%? → High concentration

**Sector-Level:**
- Any sector >35%? → Concentration risk
- Any sector missing? → Diversification gap

**Factor-Level:**
- All high-beta growth stocks? → Factor concentration
- All value stocks? → Style concentration

### Step 4: Risk-Adjusted Performance

1. **Calculate Sharpe Ratio** (if return history available)
2. **Compare to benchmark:** Is portfolio delivering better risk-adjusted returns?
3. **Calculate Sortino Ratio** for downside focus
4. **Assess if excess risk is being rewarded**

### Step 5: Generate Risk Assessment

**Summary Format:**

```markdown
## Portfolio Risk Assessment

**Overall Risk Profile:** [Conservative / Moderate / Growth / Aggressive]

**Risk Score:** XX/100 ([Low / Medium / High / Very High])

**Key Metrics:**
- Portfolio Beta: X.XX (vs market 1.00)
- Estimated Volatility: XX% annualized
- Maximum Drawdown: -XX% (acceptable for [risk profile])
- Current Drawdown: -X% (vs recent peak)

**Risk Concentrations:**
- Top 5 positions: XX% of portfolio ([OK / High / Excessive])
- Largest single position: [SYMBOL] at XX% ([OK / Trim recommended])
- HHI: XXXX ([Well-diversified / Concentrated])

**Risk-Adjusted Performance:**
- Sharpe Ratio: X.XX ([Below / In-line / Above] market)
- Sortino Ratio: X.XX
- Performance for risk taken: [Excellent / Good / Fair / Poor]

**Risk Recommendations:**
- [List specific actions to reduce risk if needed]
```

## Risk Management Guidelines

### When to Reduce Risk

**Signals:**
- Portfolio beta >1.5 for moderate risk tolerance investor
- Max drawdown exceeds investor's tolerance
- Single position >15% of portfolio
- Sector concentration >40%
- Current drawdown >20% (entering bear market)

**Actions:**
- Trim concentrated positions
- Add defensive sectors (Utilities, Staples, Healthcare)
- Increase bond allocation
- Raise cash levels

### When to Increase Risk

**Signals:**
- Portfolio beta <0.7 for growth-oriented investor
- Cash position >15% (unless intentionally defensive)
- Underperforming benchmark significantly with lower volatility
- Long time horizon with conservative allocation

**Actions:**
- Add growth sectors (Technology, Consumer Discretionary)
- Increase equity allocation
- Deploy excess cash
- Add higher-conviction positions

## Summary

**Key Takeaways:**

1. **Multiple metrics needed:** No single metric tells the full story
2. **Volatility measures:** Standard deviation and beta for overall risk
3. **Downside risk:** Maximum drawdown, current drawdown, VaR for worst-case scenarios
4. **Risk-adjusted returns:** Sharpe and Sortino ratios for performance quality
5. **Concentration:** HHI and top-N positions for diversification assessment
6. **Match to investor:** Risk metrics must align with risk tolerance and goals
7. **Monitor continuously:** Risk characteristics change as markets move

**Practical Application:**

- Calculate key metrics quarterly
- Compare to investor risk tolerance
- Identify concentrations and gaps
- Adjust allocation to maintain target risk level
- Document risk assessment in portfolio reports

**Remember:** Risk metrics are tools, not absolute truth. Use judgment and consider qualitative factors (market environment, economic outlook, investor circumstances) alongside quantitative metrics.
