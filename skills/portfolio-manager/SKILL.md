---
name: portfolio-manager
description: Comprehensive portfolio analysis using Alpaca MCP Server integration to fetch holdings and positions, then analyze asset allocation, risk metrics, individual stock positions, diversification, and generate rebalancing recommendations. Use when user requests portfolio review, position analysis, risk assessment, performance evaluation, or rebalancing suggestions for their brokerage account.
---

# Portfolio Manager

## Overview

Analyze and manage investment portfolios by integrating with Alpaca MCP Server to fetch real-time holdings data, then performing comprehensive analysis covering asset allocation, diversification, risk metrics, individual position evaluation, and rebalancing recommendations. Generate detailed portfolio reports with actionable insights.

This skill leverages Alpaca's brokerage API through MCP (Model Context Protocol) to access live portfolio data, ensuring analysis is based on actual current positions rather than manually entered data.

## When to Use

Invoke this skill when the user requests:
- "Analyze my portfolio"
- "Review my current positions"
- "What's my asset allocation?"
- "Check my portfolio risk"
- "Should I rebalance my portfolio?"
- "Evaluate my holdings"
- "Portfolio performance review"
- "What stocks should I buy or sell?"
- Any request involving portfolio-level analysis or management

## Prerequisites

### Alpaca MCP Server Setup

This skill requires Alpaca MCP Server to be configured and connected. The MCP server provides access to:
- Current portfolio positions
- Account equity and buying power
- Historical positions and transactions
- Market data for held securities

**MCP Server Tools Used:**
- `get_account_info` - Fetch account equity, buying power, cash balance
- `get_positions` - Retrieve all current positions with quantities, cost basis, market value
- `get_portfolio_history` - Historical portfolio performance data
- Market data tools for price quotes and fundamentals

If Alpaca MCP Server is not connected, inform the user and provide setup instructions from `references/alpaca_mcp_setup.md`.

## Workflow

### Step 1: Fetch Portfolio Data via Alpaca MCP or REST fallback

Use Alpaca MCP Server tools to gather current portfolio information when available. In scheduled Hermes jobs, MCP tools may not be exposed even when Alpaca credentials are present; in that case, use the Alpaca REST API directly with `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, and `ALPACA_PAPER`.

**1.1 Get Account Information:**
```
Preferred: use mcp__alpaca__get_account_info to fetch:
- Account equity (total portfolio value)
- Cash balance
- Buying power
- Account status

Fallback REST endpoints:
- paper: https://paper-api.alpaca.markets/v2/account
- live:  https://api.alpaca.markets/v2/account
Headers:
- APCA-API-KEY-ID=$ALPACA_API_KEY
- APCA-API-SECRET-KEY=$ALPACA_SECRET_KEY
```

**1.2 Get Current Positions:**
```
Preferred: use mcp__alpaca__get_positions to fetch all holdings:
- Symbol ticker
- Quantity held
- Average entry price (cost basis)
- Current market price
- Current market value
- Unrealized P&L ($ and %)
- Position size as % of portfolio

Fallback REST endpoints:
- paper: https://paper-api.alpaca.markets/v2/positions
- live:  https://api.alpaca.markets/v2/positions
```

**1.3 Get Portfolio History (Optional):**
```
Preferred: use mcp__alpaca__get_portfolio_history for performance analysis:
- Historical equity values
- Time-weighted return calculation
- Drawdown analysis

Fallback REST endpoint:
- /v2/account/portfolio/history
```

**Scheduled-job fallback discipline:**
- Clearly label the source as `Alpaca REST fallback` rather than MCP.
- Use `ALPACA_PAPER=true` to choose paper endpoint; otherwise use live endpoint.
- Still validate that long market value plus cash approximately reconciles to equity, and highlight margin/leverage if `long_market_value > equity`.
- For weekly core portfolio cron jobs, compute exposure using equity as the denominator as well as gross market value: `gross_long_exposure = long_market_value / equity`, `cash_pct = cash / equity`, and explicitly flag margin-funded portfolios when gross exposure is materially above 100% or cash is negative. Do not let sector weights look benign by using only gross-long denominator when the account is levered.
- When the request emphasizes dividend holdings or forced-review triggers, build normalized monitor input from the live holdings and hand it to `kanchi-dividend-review-monitor` rather than treating dividend review as a narrative-only section. Also build tax-planning input for `kanchi-dividend-us-tax-accounting` when account-location notes are requested; label it degraded if account type or holding-period windows are unavailable.

**Data Validation:**
- Verify all positions have valid ticker symbols
- Confirm market values sum to approximate account equity
- Check for any stale or inactive positions
- Handle edge cases (fractional shares, options, crypto if supported)

### Step 2: Enrich Position Data

For each position in the portfolio, gather additional market data and fundamentals:

**2.1 Current Market Data:**
- Real-time or delayed price quotes
- Daily volume and liquidity metrics
- 52-week range
- Market capitalization

**2.2 Fundamental Data:**
Use WebSearch or available market data APIs to fetch:
- Sector and industry classification
- Key valuation metrics (P/E, P/B, dividend yield)
- Recent earnings and financial health indicators
- Analyst ratings and price targets
- Recent news and material developments

**2.3 Technical Analysis:**
- Price trend (20-day, 50-day, 200-day moving averages)
- Relative strength
- Support and resistance levels
- Momentum indicators (RSI, MACD if available)

### Step 3: Portfolio-Level Analysis

Perform comprehensive portfolio analysis using frameworks from reference files:

#### 3.1 Asset Allocation Analysis

**Read references/asset-allocation.md** for allocation frameworks

Analyze current allocation across multiple dimensions:

**By Asset Class:**
- Equities vs Fixed Income vs Cash vs Alternatives
- Compare to target allocation for user's risk profile
- Assess if allocation matches investment goals

**By Sector:**
- Technology, Healthcare, Financials, Consumer, etc.
- Identify sector concentration risks
- Compare to benchmark sector weights (e.g., S&P 500)

**By Market Cap:**
- Large-cap vs Mid-cap vs Small-cap distribution
- Concentration in mega-caps
- Market cap diversification score

**By Geography:**
- US vs International vs Emerging Markets
- Domestic concentration risk assessment

**Output Format:**
```markdown
## Asset Allocation

### Current Allocation vs Target
| Asset Class | Current | Target | Variance |
|-------------|---------|--------|----------|
| US Equities | XX.X% | YY.Y% | +/- Z.Z% |
| ... |

### Sector Breakdown
[Pie chart description or table with sector percentages]

### Top 10 Holdings
| Rank | Symbol | % of Portfolio | Sector |
|------|--------|----------------|--------|
| 1 | AAPL | X.X% | Technology |
| ... |
```

#### 3.2 Diversification Analysis

**Read references/diversification-principles.md** for diversification theory

Evaluate portfolio diversification quality:

**Position Concentration:**
- Identify top holdings and their aggregate weight
- Flag if any single position exceeds 10-15% of portfolio
- Calculate Herfindahl-Hirschman Index (HHI) for concentration measurement

**Sector Concentration:**
- Identify dominant sectors
- Flag if any sector exceeds 30-40% of portfolio
- Compare to benchmark sector diversity

**Correlation Analysis:**
- Estimate correlation between major positions
- Identify highly correlated holdings (potential redundancy)
- Assess true diversification benefit

**Number of Positions:**
- Optimal range: 15-30 stocks for individual portfolios
- Flag if under-diversified (<10 stocks) or over-diversified (>50 stocks)

**Output:**
```markdown
## Diversification Assessment

**Concentration Risk:** [Low / Medium / High]
- Top 5 holdings represent XX% of portfolio
- Largest single position: [SYMBOL] at XX%

**Sector Diversification:** [Excellent / Good / Fair / Poor]
- Dominant sector: [Sector Name] at XX%
- [Assessment of balance across sectors]

**Position Count:** [Optimal / Under-diversified / Over-diversified]
- Total positions: XX stocks
- [Recommendation]

**Correlation Concerns:**
- [List any highly correlated position pairs]
- [Diversification improvement suggestions]
```

#### 3.3 Risk Analysis

**Read references/portfolio-risk-metrics.md** for risk measurement frameworks

Calculate and interpret key risk metrics:

**Volatility Measures:**
- Estimated portfolio beta (weighted average of position betas)
- Individual position volatilities
- Portfolio standard deviation (if historical data available)

**Downside Risk:**
- Maximum drawdown (from portfolio history)
- Current drawdown from peak
- Positions with significant unrealized losses

**Risk Concentration:**
- Percentage in high-volatility stocks (beta > 1.5)
- Percentage in speculative/unprofitable companies
- Leverage usage (if applicable)

**Tail Risk:**
- Exposure to potential black swan events
- Single-stock concentration risk
- Sector-specific event risk

**Output:**
```markdown
## Risk Assessment

**Overall Risk Profile:** [Conservative / Moderate / Aggressive]

**Portfolio Beta:** X.XX (vs market at 1.00)
- Interpretation: Portfolio is [more/less] volatile than market

**Maximum Drawdown:** -XX.X% (from $XXX,XXX to $XXX,XXX)
- Current drawdown from peak: -XX.X%

**High-Risk Positions:**
| Symbol | % of Portfolio | Beta | Risk Factor |
|--------|----------------|------|-------------|
| [TICKER] | XX% | X.XX | [High volatility / Recent loss / etc] |

**Risk Concentrations:**
- XX% in single sector ([Sector])
- XX% in stocks with beta > 1.5
- [Other concentration risks]

**Risk Score:** XX/100 ([Low/Medium/High] risk)
```

#### 3.4 Performance Analysis

Evaluate portfolio performance using available data:

**Absolute Returns:**
- Overall portfolio unrealized P&L ($ and %)
- Best performing positions (top 5 by % gain)
- Worst performing positions (bottom 5 by % loss)

**Time-Weighted Returns (if history available):**
- YTD return
- 1-year, 3-year, 5-year annualized returns
- Compare to benchmark (S&P 500, relevant index)

**Position-Level Performance:**
- Winners vs Losers ratio
- Average gain on winning positions
- Average loss on losing positions
- Positions near 52-week highs/lows

**Output:**
```markdown
## Performance Review

**Total Portfolio Value:** $XXX,XXX
**Total Unrealized P&L:** $XX,XXX (+XX.X%)
**Cash Balance:** $XX,XXX (XX% of portfolio)

**Best Performers:**
| Symbol | Gain | Position Value |
|--------|------|----------------|
| [TICKER] | +XX.X% | $XX,XXX |
| ... |

**Worst Performers:**
| Symbol | Loss | Position Value |
|--------|------|----------------|
| [TICKER] | -XX.X% | $XX,XXX |
| ... |

**Performance vs Benchmark (if available):**
- Portfolio return: +X.X%
- S&P 500 return: +Y.Y%
- Alpha: +/- Z.Z%
```

### Step 4: Individual Position Analysis

For key positions (top 10-15 by portfolio weight), perform detailed analysis:

**Read references/position-evaluation.md** for position analysis framework

For each significant position:

**4.1 Current Thesis Validation:**
- Why was this position initiated? (if known from user context)
- Has the investment thesis played out or broken?
- Recent company developments and news

**4.2 Valuation Assessment:**
- Current valuation metrics (P/E, P/B, etc.)
- Compare to historical valuation range
- Compare to sector peers
- Overvalued / Fair / Undervalued assessment

**4.3 Technical Health:**
- Price trend (uptrend, downtrend, sideways)
- Position relative to moving averages
- Support and resistance levels
- Momentum status

**4.4 Position Sizing:**
- Current weight in portfolio
- Is size appropriate given conviction and risk?
- Overweight or underweight vs optimal

**4.5 Action Recommendation:**
- **HOLD** - Position is well-sized and thesis intact
- **ADD** - Underweight given opportunity, thesis strengthening
- **TRIM** - Overweight or valuation stretched
- **SELL** - Thesis broken, better opportunities elsewhere

**Output per position:**
```markdown
### [SYMBOL] - [Company Name] (XX.X% of portfolio)

**Position Details:**
- Shares: XXX
- Avg Cost: $XX.XX
- Current Price: $XX.XX
- Market Value: $XX,XXX
- Unrealized P/L: $X,XXX (+XX.X%)

**Fundamental Snapshot:**
- Sector: [Sector]
- Market Cap: $XX.XB
- P/E: XX.X | Dividend Yield: X.X%
- Recent developments: [Key news or earnings]

**Technical Status:**
- Trend: [Uptrend / Downtrend / Sideways]
- Price vs 50-day MA: [Above/Below by XX%]
- Support: $XX.XX | Resistance: $XX.XX

**Position Assessment:**
- **Thesis Status:** [Intact / Weakening / Broken / Strengthening]
- **Valuation:** [Undervalued / Fair / Overvalued]
- **Position Sizing:** [Optimal / Overweight / Underweight]

**Recommendation:** [HOLD / ADD / TRIM / SELL]
**Rationale:** [1-2 sentence explanation]
```

### Step 5: Rebalancing Recommendations

**Read references/rebalancing-strategies.md** for rebalancing approaches

Generate specific rebalancing recommendations:

**5.1 Identify Rebalancing Triggers:**
- Positions that have drifted significantly from target weights
- Sector/asset class allocations requiring adjustment
- Overweight positions to trim (exceeded threshold)
- Underweight areas to add (below threshold)
- Tax considerations (capital gains implications)

**5.2 Develop Rebalancing Plan:**

**Positions to TRIM:**
- Overweight positions (>threshold deviation from target)
- Stocks that have run up significantly (valuation concerns)
- Concentrated positions exceeding 15-20% of portfolio
- Positions with broken thesis

**Positions to ADD:**
- Underweight sectors or asset classes
- High-conviction positions currently underweight
- New opportunities to improve diversification

**Cash Deployment:**
- If excess cash (>10% of portfolio), suggest deployment
- Prioritize based on opportunity and allocation gaps

**5.3 Prioritization:**
Rank rebalancing actions by priority:
1. **Immediate** - Risk reduction (trim concentrated positions)
2. **High Priority** - Major allocation drift (>10% from target)
3. **Medium Priority** - Moderate drift (5-10% from target)
4. **Low Priority** - Fine-tuning and opportunistic adjustments

**Output:**
```markdown
## Rebalancing Recommendations

### Summary
- **Rebalancing Needed:** [Yes / No / Optional]
- **Primary Reason:** [Concentration risk / Sector drift / Cash deployment / etc]
- **Estimated Trades:** X sell orders, Y buy orders

### Recommended Actions

#### HIGH PRIORITY: Risk Reduction
**TRIM [SYMBOL]** from XX% to YY% of portfolio
- **Shares to Sell:** XX shares (~$XX,XXX)
- **Rationale:** [Overweight / Valuation extended / etc]
- **Tax Impact:** $X,XXX capital gain (est)

#### MEDIUM PRIORITY: Asset Allocation
**ADD [Sector/Asset Class]** exposure
- **Target:** Increase from XX% to YY%
- **Suggested Stocks:** [SYMBOL1, SYMBOL2, SYMBOL3]
- **Amount to Invest:** ~$XX,XXX

#### CASH DEPLOYMENT
**Current Cash:** $XX,XXX (XX% of portfolio)
- **Recommendation:** [Deploy / Keep for opportunities / Reduce to X%]
- **Suggested Allocation:** [Distribution across sectors/stocks]

### Implementation Plan
1. [First action - highest priority]
2. [Second action]
3. [Third action]
...

**Timing Considerations:**
- [Tax year-end planning / Earnings season / Market conditions]
- [Suggested phasing if applicable]
```

### Step 6: Generate Portfolio Report

Create comprehensive markdown report saved to repository root:

**Filename:** `portfolio_analysis_YYYY-MM-DD.md`

**Report Structure:**

```markdown
# Portfolio Analysis Report

**Account:** [Account type if available]
**Report Date:** YYYY-MM-DD
**Portfolio Value:** $XXX,XXX
**Total P&L:** $XX,XXX (+XX.X%)

---

## Executive Summary

[3-5 bullet points summarizing key findings]
- Overall portfolio health assessment
- Major strengths
- Key risks or concerns
- Primary recommendations

---

## Holdings Overview

[Summary table of all positions]

---

## Asset Allocation
[Section from Step 3.1]

---

## Diversification Analysis
[Section from Step 3.2]

---

## Risk Assessment
[Section from Step 3.3]

---

## Performance Review
[Section from Step 3.4]

---

## Position Analysis
[Detailed analysis of top 10-15 positions from Step 4]

---

## Rebalancing Recommendations
[Section from Step 5]

---

## Action Items

**Immediate Actions:**
- [ ] [Action 1]
- [ ] [Action 2]

**Medium-Term Actions:**
- [ ] [Action 3]
- [ ] [Action 4]

**Monitoring Priorities:**
- [ ] [Watch list item 1]
- [ ] [Watch list item 2]

---

## Appendix: Full Holdings

[Complete table with all positions and metrics]
```

### Step 7: Interactive Follow-up

Be prepared to answer follow-up questions:

**Common Questions:**

**"Why should I sell [SYMBOL]?"**
- Explain specific concerns (valuation, thesis breakdown, concentration)
- Provide supporting data
- Offer alternative positions if applicable

**"What should I buy instead?"**
- Suggest specific stocks to improve allocation
- Explain how they address portfolio gaps
- Provide brief investment thesis

**"What's my biggest risk?"**
- Identify primary risk factor (concentration, sector exposure, volatility)
- Quantify the risk
- Suggest mitigation strategies

**"How does my portfolio compare to [benchmark]?"**
- Compare allocation, sector weights, risk metrics
- Highlight key differences
- Assess if differences are justified

**"Should I rebalance now or wait?"**
- Consider market conditions, tax implications, transaction costs
- Provide timing recommendation with rationale

**"Can you analyze [specific position] in more detail?"**
- Perform deep-dive analysis using us-stock-analysis skill if needed
- Integrate findings back into portfolio context

## Analysis Frameworks

### Target Allocation Templates

This skill includes reference allocation models for different investor profiles:

**Read references/target-allocations.md** for detailed models:

- **Conservative** (Capital preservation, income focus)
- **Moderate** (Balanced growth and income)
- **Growth** (Long-term capital appreciation)
- **Aggressive** (Maximum growth, high risk tolerance)

Each model includes:
- Asset class targets (Stocks/Bonds/Cash/Alternatives)
- Sector guidelines
- Market cap distribution
- Geographic allocation
- Position sizing rules

Use these as comparison benchmarks when user hasn't specified their allocation strategy.

### Risk Profile Assessment

If user's target allocation is unknown, assess appropriate risk profile based on:
- Age (if mentioned)
- Investment timeline (if mentioned)
- Current allocation (reveals preferences)
- Position types (conservative vs speculative stocks)

**Read references/risk-profile-questionnaire.md** for assessment framework

## Output Format Guidelines

**Tone and Style:**
- Objective and analytical
- Actionable recommendations with clear rationale
- Acknowledge uncertainty in market forecasts
- Balance optimism with risk awareness
- Quantify whenever possible

**Data Presentation:**
- Tables for comparisons and metrics
- Percentages for allocations and returns
- Dollar amounts for absolute values
- Consistent formatting throughout report

**Recommendation Clarity:**
- Explicit action verbs (TRIM, ADD, HOLD, SELL)
- Specific quantities (sell XX shares, add $X,XXX)
- Priority levels (Immediate, High, Medium, Low)
- Supporting rationale for each recommendation

**Visual Descriptions:**
- Describe allocation breakdowns as if creating pie charts
- Sector weights as bar chart equivalents
- Performance trends with directional indicators (↑ ↓ →)

## Reference Files

Load these references as needed during analysis:

**references/alpaca-mcp-setup.md**
- When: User needs help setting up Alpaca MCP Server
- Contains: Installation instructions, API key configuration, MCP server connection steps, troubleshooting

**references/asset-allocation.md**
- When: Analyzing portfolio allocation or creating rebalancing plan
- Contains: Asset allocation theory, optimal allocation by risk profile, sector allocation guidelines, rebalancing triggers

**references/diversification-principles.md**
- When: Assessing portfolio diversification quality
- Contains: Modern portfolio theory basics, correlation concepts, optimal position count, concentration risk thresholds, diversification metrics

**references/portfolio-risk-metrics.md**
- When: Calculating risk scores or interpreting volatility
- Contains: Beta calculation, standard deviation, Sharpe ratio, maximum drawdown, Value at Risk (VaR), risk-adjusted return metrics

**references/position-evaluation.md**
- When: Analyzing individual holdings for buy/hold/sell decisions
- Contains: Position analysis framework, thesis validation checklist, position sizing guidelines, sell discipline criteria

**references/rebalancing-strategies.md**
- When: Developing rebalancing recommendations
- Contains: Rebalancing methodologies (calendar-based, threshold-based, tactical), tax optimization strategies, transaction cost considerations, implementation timing

**references/target-allocations.md**
- When: Need benchmark allocations for comparison
- Contains: Model portfolios for conservative/moderate/growth/aggressive investors, sector target ranges, market cap distributions

**references/risk-profile-questionnaire.md**
- When: User hasn't specified risk tolerance or target allocation
- Contains: Risk assessment questions, scoring methodology, risk profile classification

## Error Handling

**If Alpaca MCP Server is not connected:**
1. Inform user that Alpaca integration is required
2. Provide setup instructions from references/alpaca-mcp-setup.md
3. Offer alternative: manual data entry (less ideal, user provides CSV of positions)

**If API returns incomplete data:**
- Proceed with available data
- Note limitations in report
- Suggest manual verification for missing positions

**If position data seems stale:**
- Flag the issue
- Recommend refreshing connection or checking Alpaca status
- Proceed with analysis but caveat findings

**If user has no positions:**
- Acknowledge empty portfolio
- Offer portfolio construction guidance instead of analysis
- Suggest using value-dividend-screener or us-stock-analysis for stock ideas

## Advanced Features

### Tax-Loss Harvesting Opportunities

Identify positions with unrealized losses suitable for tax-loss harvesting:
- Positions with losses >5%
- Holding period considerations (avoid wash sale rule)
- Replacement security suggestions (similar but not substantially identical)

### Dividend Income Analysis

For portfolios with dividend-paying stocks:
- Estimate annual dividend income
- Dividend growth rate trajectory
- Dividend coverage and sustainability
- Yield on cost for long-term holdings

### Correlation Matrix

For portfolios with 5-20 positions:
- Estimate correlation between major positions
- Identify redundant positions (correlation >0.8)
- Suggest diversification improvements

### Scenario Analysis

Model portfolio behavior under different scenarios:
- **Bull Market** (+20% equity appreciation)
- **Bear Market** (-20% equity decline)
- **Sector Rotation** (Tech weakness, Value strength)
- **Rising Rates** (Impact on growth stocks and bonds)

## Example Queries

**Basic Portfolio Review:**
- "Analyze my portfolio"
- "Review my positions"
- "How's my portfolio doing?"

**Allocation Analysis:**
- "What's my asset allocation?"
- "Am I too concentrated in tech?"
- "Show me my sector breakdown"

**Risk Assessment:**
- "Is my portfolio too risky?"
- "What's my portfolio beta?"
- "What are my biggest risks?"

**Rebalancing:**
- "Should I rebalance?"
- "What should I buy or sell?"
- "How can I improve diversification?"

**Performance:**
- "What are my best and worst positions?"
- "How am I performing vs the market?"
- "Which stocks are winning and losing?"

**Position-Specific:**
- "Should I sell [SYMBOL]?"
- "Is [SYMBOL] overweight in my portfolio?"
- "What should I do with [SYMBOL]?"

## Limitations and Disclaimers

**Include in all reports:**

*This analysis is for informational purposes only and does not constitute financial advice. Investment decisions should be made based on individual circumstances, risk tolerance, and financial goals. Past performance does not guarantee future results. Consult with a qualified financial advisor before making investment decisions.*

*Data accuracy depends on Alpaca API and third-party market data sources. Verify critical information independently. Tax implications are estimates only; consult a tax professional for specific guidance.*

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
