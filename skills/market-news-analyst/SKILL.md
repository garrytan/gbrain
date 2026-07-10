---
name: market-news-analyst
description: This skill should be used when analyzing recent market-moving news events and their impact on equity markets and commodities. Use this skill when the user requests analysis of major financial news from the past 10 days, wants to understand market reactions to monetary policy decisions (FOMC, ECB, BOJ), needs assessment of geopolitical events' impact on commodities, or requires comprehensive review of earnings announcements from mega-cap stocks. The skill automatically collects news using WebSearch/WebFetch tools and produces impact-ranked analysis reports. All analysis thinking and output are conducted in English.
---

# Market News Analyst

## Overview

This skill enables comprehensive analysis of market-moving news events from the past 10 days, focusing on their impact on US equity markets and commodities. The skill automatically collects news from trusted sources using WebSearch and WebFetch tools, evaluates market impact magnitude, analyzes actual market reactions, and produces structured English reports ranked by market impact significance.

## Prerequisites

- **Tools:** WebSearch and WebFetch tools must be available for news collection
- **API Keys:** None required (uses built-in web search capabilities)
- **Knowledge:** Familiarity with financial markets terminology is helpful but not required

## Output Format

This skill produces **conversational guidance** during the analysis session. When the full workflow is executed, Claude generates a comprehensive Markdown report (see Step 6 for format) that can be saved to the `reports/` directory upon user request. No files are generated automatically; output is presented in the conversation.

## When to Use This Skill

Use this skill when:
- User requests analysis of recent major market news (past 10 days)
- User wants to understand market reactions to specific events (FOMC decisions, earnings, geopolitical)
- User needs comprehensive market news summary with impact assessment
- User asks about correlations between news events and commodity price movements
- User requests analysis of how central bank policy announcements affected markets

Example user requests:
- "Analyze the major market news from the past 10 days"
- "How did the latest FOMC decision impact the market?"
- "What were the most important market-moving events this week?"
- "Analyze recent geopolitical news and commodity price reactions"
- "Review mega-cap tech earnings and their market impact"

## Analysis Workflow

Follow this structured 6-step workflow when analyzing market news:

### Step 1: News Collection via WebSearch/WebFetch

**Objective:** Gather comprehensive news from the past 10 days covering major market-moving events.

**Search Strategy:**

Execute parallel WebSearch queries covering different news categories:

**Monetary Policy:**
- Search: "FOMC meeting past 10 days", "Federal Reserve interest rate", "ECB policy decision", "Bank of Japan"
- Target: Central bank decisions, forward guidance changes, inflation commentary

**Inflation/Economic Data:**
- Search: "CPI inflation report [current month]", "jobs report NFP", "GDP data", "PPI producer prices"
- Target: Major economic data releases and surprises

**Mega-Cap Earnings:**
- Search: "Apple earnings [current quarter]", "Microsoft earnings", "NVIDIA earnings", "Amazon earnings", "Tesla earnings", "Meta earnings", "Google earnings"
- Target: Results, guidance, market reactions for largest companies

**Geopolitical Events:**
- Search: "Middle East conflict oil prices", "Ukraine war", "US China tensions", "trade war tariffs"
- Target: Conflicts, sanctions, trade disputes affecting markets

**Commodity Markets:**
- Search: "oil prices news past week", "gold prices", "OPEC meeting", "natural gas prices", "copper prices"
- Target: Supply disruptions, demand shifts, price movements

**Corporate News:**
- Search: "major M&A announcement", "bank earnings", "tech sector news", "bankruptcy", "credit rating downgrade"
- Target: Large corporate events beyond mega-caps

**Recommended News Sources (Priority Order):**
1. Official sources: FederalReserve.gov, SEC.gov (EDGAR), Treasury.gov, BLS.gov
2. Tier 1 financial news: Bloomberg, Reuters, Wall Street Journal, Financial Times
3. Specialized: CNBC (real-time), MarketWatch (summaries), S&P Global Platts (commodities)

**Search Execution:**
- Use WebSearch for broad topic searches
- Use WebFetch for specific URLs from official sources or major news outlets
- Collect publication dates to ensure news is within 10-day window
- Capture: Event date, source, headline, key details, market context (pre-market, trading hours, after-hours)

**Filtering Criteria:**
- Focus on Tier 1 market-moving events (see references/market_event_patterns.md)
- Prioritize news with clear market impact (price moves, volume spikes)
- Exclude: Stock-specific small-cap news, minor product updates, routine filings

Think in English throughout collection process. Document each significant news item with:
- Date and time
- Event type (monetary policy, earnings, geopolitical, etc.)
- Source reliability tier
- Initial market reaction (if observable)

### Step 2: Load Knowledge Base References

**Objective:** Access domain expertise to inform impact assessment.

Load relevant reference files based on collected news types:

**Always Load:**
- `references/market_event_patterns.md` - Comprehensive patterns for all major event types
- `references/trusted_news_sources.md` - Source credibility assessment

**Conditionally Load (Based on News Collected):**

If **monetary policy news** found:
- Focus on: market_event_patterns.md → Central Bank Monetary Policy Events section
- Key frameworks: Interest rate hike/cut reactions, QE/QT impacts, hawkish/dovish tone

If **geopolitical events** found:
- Load: `references/geopolitical_commodity_correlations.md`
- Focus on: Energy Commodities, Precious Metals, regional frameworks matching event

If **mega-cap earnings** found:
- Load: `references/corporate_news_impact.md`
- Focus on: Specific company sections, sector contagion patterns

If **commodity news** found:
- Load: `references/geopolitical_commodity_correlations.md`
- Focus on: Specific commodity sections (Oil, Gold, Copper, etc.)

**Knowledge Integration:**
Compare collected news against historical patterns to:
- Predict expected market reactions
- Identify anomalies (market reacted differently than historical pattern)
- Assess whether reaction was typical magnitude or outsized
- Determine if contagion occurred as expected

### Step 3: Impact Magnitude Assessment

**Objective:** Rank each news event by market impact significance.

**Impact Assessment Framework:**

For each news item, evaluate across three dimensions:

**1. Asset Price Impact (Primary Factor):**

Measure actual or estimated price movements:

**Equity Markets:**
- Index-level: S&P 500, Nasdaq 100, Dow Jones
  - Severe: ±2%+ in day
  - Major: ±1-2%
  - Moderate: ±0.5-1%
  - Minor: ±0.2-0.5%
  - Negligible: <0.2%

- Sector-level: Specific sector ETFs
  - Severe: ±5%+
  - Major: ±3-5%
  - Moderate: ±1-3%
  - Minor: <1%

- Stock-specific: Individual mega-caps
  - Severe: ±10%+ (and index weight causes index move)
  - Major: ±5-10%
  - Moderate: ±2-5%

**Commodity Markets:**
- Oil (WTI/Brent):
  - Severe: ±5%+
  - Major: ±3-5%
  - Moderate: ±1-3%

- Gold:
  - Severe: ±3%+
  - Major: ±1.5-3%
  - Moderate: ±0.5-1.5%

- Base Metals (Copper, etc.):
  - Severe: ±4%+
  - Major: ±2-4%
  - Moderate: ±1-2%

**Bond Markets:**
- 10-Year Treasury Yield:
  - Severe: ±20bps+ in day
  - Major: ±10-20bps
  - Moderate: ±5-10bps

**Currency Markets:**
- USD Index (DXY):
  - Severe: ±1.5%+
  - Major: ±0.75-1.5%
  - Moderate: ±0.3-0.75%

**2. Breadth of Impact (Multiplier):**

Assess how many markets/sectors affected:

- **Systemic (3x multiplier):** Multiple asset classes, global markets
  - Examples: FOMC surprise, banking crisis, major war outbreak

- **Cross-Asset (2x multiplier):** Equities + commodities, or equities + bonds
  - Examples: Inflation surprise, geopolitical supply shock

- **Sector-Wide (1.5x multiplier):** Entire sector or related sectors
  - Examples: Tech earnings cluster, energy policy announcement

- **Stock-Specific (1x multiplier):** Single company (unless mega-cap with index impact)
  - Examples: Individual company earnings, M&A

**3. Forward-Looking Significance (Modifier):**

Consider future implications:

- **Regime Change (+50%):** Fundamental market structure shift
  - Examples: Fed pivot from hiking to cutting, major geopolitical realignment

- **Trend Confirmation (+25%):** Reinforces existing trajectory
  - Examples: Consecutive strong inflation prints, sustained earnings beats

- **Isolated Event (0%):** One-off with limited forward signal
  - Examples: Single data point within range, company-specific issue

- **Contrary Signal (-25%):** Contradicts prevailing narrative
  - Examples: Good news ignored by market, bad news rallied

**Impact Score Calculation:**

```
Impact Score = (Price Impact Score × Breadth Multiplier) + Forward-Looking Modifier

Price Impact Score:
- Severe: 10 points
- Major: 7 points
- Moderate: 4 points
- Minor: 2 points
- Negligible: 1 point
```

**Example Calculations:**

**FOMC 75bps Rate Hike (hawkish tone):**
- Price Impact: S&P 500 -2.5% (Severe = 10 points)
- Breadth: Systemic (equities, bonds, USD, commodities all moved) = 3x
- Forward: Trend confirmation (ongoing tightening) = +25%
- **Score: (10 × 3) × 1.25 = 37.5**

**NVIDIA Earnings Beat:**
- Price Impact: NVDA +15%, Nasdaq +1.5% (Severe = 10 points)
- Breadth: Sector-wide (semis, tech broadly) = 1.5x
- Forward: Trend confirmation (AI demand) = +25%
- **Score: (10 × 1.5) × 1.25 = 18.75**

**Geopolitical Flare-up (Middle East):**
- Price Impact: Oil +8%, S&P -1.2% (Severe = 10 points)
- Breadth: Cross-asset (oil, equities, gold) = 2x
- Forward: Isolated event (no escalation) = 0%
- **Score: (10 × 2) × 1.0 = 20**

**Single Stock Earnings (Non-Mega-Cap):**
- Price Impact: Stock +12%, no index impact (Major = 7 points)
- Breadth: Stock-specific = 1x
- Forward: Isolated = 0%
- **Score: (7 × 1) × 1.0 = 7**

**Ranking:**
After scoring all news items, rank from highest to lowest impact score. This determines report ordering.

### Step 4: Market Reaction Analysis

**Objective:** Analyze how markets actually responded to each event.

For each significant news item (Impact Score >5), conduct detailed reaction analysis:

**Immediate Reaction (Intraday):**
- Direction: Positive, negative, mixed
- Magnitude: Align with price impact categories
- Timing: Pre-market, during trading, after-hours
- Volatility: VIX movement, bid-ask spreads

**Multi-Asset Response:**

**Equities:**
- Index performance (S&P 500, Nasdaq, Dow, Russell 2000)
- Sector rotation (which sectors outperformed/underperformed)
- Individual stock moves (mega-caps, relevant companies)
- Growth vs Value, Large vs Small Cap divergences

**Fixed Income:**
- Treasury yields (2Y, 10Y, 30Y)
- Yield curve shape (steepening, flattening, inversion)
- Credit spreads (IG, HY)
- TIPS breakevens (inflation expectations)

**Commodities:**
- Energy: Oil (WTI, Brent), Natural Gas
- Precious Metals: Gold, Silver
- Base Metals: Copper, Aluminum (if relevant)
- Agricultural: Wheat, Corn, Soybeans (if relevant)

**Currencies:**
- USD Index (DXY)
- EUR/USD, USD/JPY, GBP/USD
- Emerging market currencies
- Safe havens (JPY, CHF)

**Derivatives:**
- VIX (volatility index)
- Options activity (put/call ratio, unusual volume)
- Futures positioning

**Pattern Comparison:**

Compare observed reaction against expected pattern from knowledge base:

- **Consistent:** Reaction matched historical pattern
  - Example: Fed hike → Tech stocks down, USD up (as expected)

- **Amplified:** Reaction exceeded typical pattern
  - Example: Inflation print +0.3% above consensus → Selloff 2x typical
  - Investigate: Positioning, sentiment, cumulative factors

- **Dampened:** Reaction less than historical pattern
  - Example: Geopolitical event → Oil barely moved
  - Investigate: Already priced in, other offsetting factors

- **Inverse:** Reaction opposite of historical pattern
  - Example: Good news ignored, bad news rallied
  - Investigate: "Good news is bad news" dynamics, Fed pivot hopes

**Anomaly Identification:**

Flag reactions that deviate significantly from patterns:
- Market shrugged off typically market-moving news
- Overreaction to typically minor news
- Contagion failed to spread as expected
- Safe havens didn't work (correlations broke)

**Sentiment Indicators:**

- Risk-On vs Risk-Off: Which regime dominated
- Positioning: Evidence of crowded trades unwinding
- Momentum: Follow-through in subsequent sessions or reversal

### Step 5: Correlation and Causation Assessment

**Objective:** Distinguish direct impacts from coincidental timing.

**Multi-Event Analysis:**

When multiple significant events occurred in the 10-day period, assess interactions:

**Reinforcing Events:**
- Same directional impact
- Example: Hawkish FOMC + hot CPI → Both bearish for equities, amplified move
- Combined impact often non-linear (greater than sum of parts)

**Offsetting Events:**
- Opposite directional impacts
- Example: Strong earnings (positive) + geopolitical tensions (negative) → Muted net reaction
- Identify which factor dominated

**Sequential Events:**
- One event set up reaction to next
- Example: First rate hike modest reaction, second rate hike severe (cumulative tightening concerns)
- Path dependence matters

**Coincidental Timing:**
- Events unrelated but occurred simultaneously
- Difficult to isolate individual impacts
- Note uncertainty in attribution

**Geopolitical-Commodity Correlations:**

For geopolitical events, specifically analyze commodity market reactions using geopolitical_commodity_correlations.md:

**Energy:**
- Map conflict/sanction to supply disruption risk
- Assess actual vs feared supply impact
- Duration: Temporary spike vs sustained elevation

**Precious Metals:**
- Safe-haven flows vs real rate drivers
- Gold response to risk-off events
- Central bank buying implications

**Industrial Metals:**
- Demand destruction from economic slowdown fears
- Supply chain disruptions
- China factor in copper, aluminum

**Agriculture:**
- Black Sea grain exports (Russia-Ukraine)
- Weather overlays
- Food security policy responses

**Transmission Mechanisms:**

Trace how news impacts flowed through markets:

**Direct Channel:**
- News → Immediate asset price reaction
- Example: OPEC cuts → Oil prices up immediately

**Indirect Channels:**
- News → Economic impact → Asset prices
- Example: Rate hike → Mortgage rates up → Housing slows → Homebuilder stocks down

**Sentiment Channel:**
- News → Risk appetite shift → Broad asset reallocation
- Example: Banking crisis → Flight to quality → Treasuries rally, stocks sell

**Feedback Loops:**
- Initial reaction creates secondary effects
- Example: Stock selloff → Margin calls → Forced selling → Deeper selloff

### Step 6: Report Generation

**Objective:** Create structured English Markdown report ranked by market impact.

**Report Structure:**

```markdown
# Market News Analysis Report - [Date Range]

## Executive Summary

[3-4 sentences covering:]
- Period analyzed (specific dates)
- Number of significant events identified
- Dominant market theme/regime (risk-on/risk-off, sector rotation)
- Top 1-2 highest-impact events

## Market Impact Rankings

[Table format, sorted by Impact Score descending]

| Rank | Event | Date | Impact Score | Asset Classes Affected | Market Reaction |
|------|-------|------|--------------|------------------------|-----------------|
| 1 | [Event] | [Date] | [Score] | [Equities, Commodities, etc.] | [Brief reaction] |
| 2 | ... | ... | ... | ... | ... |

---

## Detailed Event Analysis

[For each event in rank order, provide comprehensive analysis]

### [Rank]. [Event Name] (Impact Score: [X])

**Event Date:** [Date, Time]
**Event Type:** [Monetary Policy / Earnings / Geopolitical / Economic Data / Corporate]
**News Source:** [Source, with credibility tier]

#### Event Summary
[3-4 sentences describing what happened]
- Key details (e.g., rate decision, earnings beat/miss magnitude, conflict developments)
- Context (was this expected, surprise factor)
- Forward guidance or implications stated

#### Market Reaction

**Immediate (Day-of):**
- **Equities:** S&P 500 [+/-X%], Nasdaq [+/-X%], Sector rotation [details]
- **Bonds:** 10Y yield [change], credit spreads [movement]
- **Commodities:** Oil [+/-X%], Gold [+/-X%], Copper [+/-X%] (if relevant)
- **Currencies:** USD [+/-X%], [other relevant pairs]
- **Volatility:** VIX [level/change]

**Follow-Through (Subsequent Sessions):**
- [Direction: sustained, reversed, or consolidated]
- [Additional price action details if significant]

**Pattern Comparison:**
- **Expected Reaction:** [Based on historical patterns from knowledge base]
- **Actual vs Expected:** [Consistent / Amplified / Dampened / Inverse]
- **Explanation of Deviation:** [If applicable, why reaction differed]

#### Impact Assessment Detail

**Asset Price Impact:** [Severe/Major/Moderate/Minor] - [Justification]
**Breadth:** [Systemic/Cross-Asset/Sector/Stock-Specific] - [Affected markets]
**Forward Significance:** [Regime Change/Trend Confirmation/Isolated/Contrary] - [Rationale]

**Calculated Score:** ([Price Score] × [Breadth Multiplier]) × [Forward Modifier] = [Total]

#### Sector-Specific Impacts

[If relevant, detail which sectors/industries were most affected]
- [Sector 1]: [Impact and reason]
- [Sector 2]: [Impact and reason]
- [Example: Technology -3% (rate sensitivity), Energy +5% (oil price spillover)]

#### Geopolitical-Commodity Correlation Analysis

[Include this section only for geopolitical events]
- [Specific commodity affected]: [Price movement]
- [Supply/demand mechanism]: [Explanation]
- [Historical precedent]: [Comparison to similar past events]
- [Expected duration]: [Temporary shock vs sustained impact]

[Repeat detailed analysis for each ranked event]

---

## Thematic Synthesis

### Dominant Market Narrative
[Identify overarching theme across the 10-day period]
- [E.g., "Persistent inflation concerns dominated despite mixed economic data"]
- [E.g., "Tech sector strength drove markets higher despite geopolitical headwinds"]

### Interconnected Events
[Analyze how events related or compounded]
- [Event A] + [Event B] → [Combined impact analysis]
- [Sequential causation if applicable]

### Market Regime Assessment
**Risk Appetite:** [Risk-On / Risk-Off / Mixed]
**Evidence:**
- [Supporting indicators: sector performance, safe haven flows, credit spreads, VIX]

**Sector Rotation Trends:**
- [Growth vs Value]
- [Cyclicals vs Defensives]
- [Outperformers and underperformers]

### Anomalies and Surprises
[Highlight unexpected market reactions]
1. [Event]: Market reacted [unexpectedly] because [explanation]
2. [Continue for significant anomalies]

---

## Commodity Market Deep Dive

[Dedicated section for commodity movements]

### Energy
- **Crude Oil (WTI/Brent):** [Price level, % change over period, key drivers]
- **Natural Gas:** [If significant movement]
- **Key Events:** [Specific news impacting energy: OPEC, geopolitics, inventory data]

### Precious Metals
- **Gold:** [Price level, % change, safe-haven flows vs real rate dynamics]
- **Silver:** [If significant divergence from gold]
- **Drivers:** [Geopolitical risk premium, inflation hedging, USD strength]

### Base Metals
- **Copper:** [As economic barometer - demand signals]
- **Aluminum, Nickel:** [If relevant supply/demand news]
- **China Factor:** [Impact of Chinese economic data/policy]

### Agricultural (If Relevant)
- **Grains:** [Wheat, Corn, Soybeans - weather, Ukraine conflict impacts]

[For each commodity, reference geopolitical events from main analysis and draw correlations]

---

## Forward-Looking Implications

### Market Positioning Insights
[What the news suggests for current market positioning]
- [Trend continuation or reversal signals]
- [Overvaluation or undervaluation indications]
- [Sentiment extremes (complacency or panic)]

### Upcoming Catalysts
[Events on horizon that may be set up by recent news]
- [Next FOMC meeting expectations post-recent decision]
- [Upcoming earnings seasons based on guidance]
- [Geopolitical developments to monitor]

### Risk Scenarios
[Based on recent news, identify key risks]
1. **[Risk Name]:** [Description, probability, potential impact]
2. **[Risk Name]:** [Description, probability, potential impact]
3. [Continue for 3-5 key risks]

---

## Data Sources and Methodology

### News Sources Consulted
[List primary sources used, organized by tier]
- **Official Sources:** [e.g., FederalReserve.gov, SEC.gov]
- **Tier 1 Financial News:** [e.g., Bloomberg, Reuters, WSJ]
- **Specialized:** [e.g., S&P Global Platts for commodities]

### Analysis Period
- **Start Date:** [Specific date]
- **End Date:** [Specific date]
- **Total Days:** 10

### Market Data
- Equity indices: [Data sources]
- Commodity prices: [Data sources]
- Economic data: [Government sources]

### Knowledge Base References
- `market_event_patterns.md` - Historical reaction patterns
- `geopolitical_commodity_correlations.md` - Geopolitical-commodity frameworks
- `corporate_news_impact.md` - Mega-cap impact analysis
- `trusted_news_sources.md` - Source credibility assessment

---

*Analysis Date: [Date report generated]*
*Language: English*
*Analysis Thinking: English*

```

**File Naming Convention:**
`market_news_analysis_[START_DATE]_to_[END_DATE].md`

Example: `market_news_analysis_2024-10-25_to_2024-11-03.md`

**Report Quality Standards:**
- Objective, fact-based analysis (no speculation beyond probability-weighted scenarios)
- Quantify price movements with specific percentages
- Cite sources for major claims
- Distinguish between correlation and causation
- Acknowledge uncertainty when attributing market moves to specific news
- Use proper financial terminology
- Maintain consistent English throughout

## Key Analysis Principles

When conducting market news analysis:

1. **Impact Over Noise:** Focus on truly market-moving news, filter out minor events
2. **Multi-Asset Perspective:** Analyze across equities, bonds, commodities, currencies to understand full impact
3. **Pattern Recognition:** Compare against historical precedents while noting unique aspects
4. **Causation Discipline:** Be rigorous about attributing market moves to specific news vs coincidental timing
5. **Forward-Looking:** Emphasize implications for future market behavior, not just backward-looking description
6. **Objectivity:** Separate market reaction (what happened) from personal market view (what should happen)
7. **Quantification:** Use specific numbers (%, bps) rather than vague terms ("significant," "large")
8. **Source Credibility:** Weight official sources and Tier 1 news over rumors and unverified reports
9. **Breadth Analysis:** Individual stock moves only significant if mega-cap or systemic signal
10. **English Consistency:** All thinking, analysis, and output in English for consistency

## Common Pitfalls to Avoid

**Over-Attribution:**
- Not every market move is news-driven (technicals, flows, month-end rebalancing exist)
- Acknowledge when attribution is uncertain

**Recency Bias:**
- Latest news isn't always most important
- Rank by actual impact, not chronological order

**Hindsight Bias:**
- Distinguish "obvious in retrospect" from "surprising at the time"
- Note consensus expectations vs actual outcomes

**Single-Factor Analysis:**
- Markets respond to multiple factors simultaneously
- Acknowledge interaction effects

**Ignoring Magnitude:**
- A "hot" CPI that's 0.1% above consensus is different from 0.5% above
- Quantify surprise factor

## Resources

### references/

**market_event_patterns.md** - Comprehensive knowledge base covering:
- Central bank monetary policy events (FOMC, ECB, BOJ, PBOC)
- Inflation data releases (CPI, PPI, PCE)
- Employment data (NFP, unemployment, wages)
- GDP reports
- Geopolitical events (conflicts, trade wars, sanctions)
- Corporate earnings (mega-cap technology, banks, energy)
- Credit events and rating changes
- Commodity-specific events (OPEC, weather, supply disruptions)
- Recession indicators
- Historical case studies (2008 crisis, COVID-19, 2022 inflation)
- Pattern recognition framework and sentiment analysis

**geopolitical_commodity_correlations.md** - Detailed correlations covering:
- Energy commodities (crude oil, natural gas, coal) and geopolitical conflicts
- Precious metals (gold, silver, platinum, palladium) safe-haven dynamics
- Base metals (copper, aluminum, nickel, zinc) and economic/political risks
- Agricultural commodities (wheat, corn, soybeans) and weather/policy
- Rare earth elements and critical minerals (China dominance, supply security)
- Regional geopolitical frameworks (Middle East, Russia-Europe, Asia-Pacific, Latin America)
- Correlation summary tables
- Time horizon considerations

**corporate_news_impact.md** - Mega-cap analysis framework:
- "Magnificent 7" technology stocks (NVIDIA, Apple, Microsoft, Amazon, Meta, Google, Tesla)
- Financial sector mega-caps (JPMorgan, Bank of America, etc.)
- Healthcare mega-caps (UnitedHealth, Pfizer, J&J, Merck)
- Energy mega-caps (Exxon Mobil, Chevron)
- Consumer staples mega-caps (P&G, Coca-Cola, PepsiCo)
- Industrial mega-caps (Boeing, Caterpillar)
- Earnings impact frameworks, product launches, M&A, regulatory issues
- Sector contagion patterns
- Impact magnitude framework

**trusted_news_sources.md** - Source credibility guide:
- Tier 1 primary sources (central banks, government agencies, SEC)
- Tier 2 major financial news (Bloomberg, Reuters, WSJ, FT, CNBC)
- Tier 3 specialized sources (energy, tech, emerging markets, China-specific, crypto)
- Tier 4 analysis and research (independent research, central bank publications, think tanks)
- Search and aggregation tools
- Source quality assessment criteria
- Speed vs accuracy trade-offs
- Recommended search strategies for 10-day analysis
- Source credibility framework
- Red flag sources to avoid

## Important Notes

- All analysis thinking must be conducted in English
- All output Markdown files must be in English
- Use WebSearch and WebFetch tools to collect news automatically
- Focus on trusted news sources as defined in references
- Rank events by impact score (price impact × breadth × forward significance)
- Target analysis period: Past 10 days from current date
- Emphasize US equity markets and commodities as primary analysis subjects
- FOMC and other central bank policy decisions receive highest priority analysis
- Distinguish between correlation and causation rigorously
- Quantify all market reactions with specific percentages
- Load appropriate reference files based on news types collected
- Generate comprehensive reports ranked by market impact (highest impact first)

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
