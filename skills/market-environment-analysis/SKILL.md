---
name: market-environment-analysis
description: Comprehensive market environment analysis and reporting tool. Analyzes global markets including US, European, Asian markets, forex, commodities, and economic indicators. Provides risk-on/risk-off assessment, sector analysis, and technical indicator interpretation. Triggers on keywords like market analysis, market environment, global markets, trading environment, market conditions, investment climate, market sentiment, forex analysis, stock market analysis, 相場環境, 市場分析, マーケット状況, 投資環境.
---

# Market Environment Analysis

Comprehensive analysis tool for understanding market conditions and creating professional market reports anytime.

## When to Use

- When you need a comprehensive overview of global market conditions
- Before making trading or investment decisions
- For daily/weekly market briefings
- When assessing risk-on/risk-off sentiment
- For understanding inter-market correlations and sector rotation
- When preparing market reports for clients or personal records

## Prerequisites

- **WebSearch access**: Required for fetching real-time market data
- **No API keys required**: This skill uses web search for data collection
- **Optional**: Economic calendar data for event-driven analysis

## Core Workflow

### 1. Initial Data Collection
Collect latest market data using web_search tool:
1. Major stock indices (S&P 500, NASDAQ, Dow, Nikkei 225, Shanghai Composite, Hang Seng)
2. Forex rates (USD/JPY, EUR/USD, major currency pairs)
3. Commodity prices (WTI crude, Gold, Silver)
4. US Treasury yields (2-year, 10-year, 30-year)
5. VIX index (Fear gauge)
6. Market trading status (open/close/current values)

### 2. Market Environment Assessment
Evaluate the following from collected data:
- **Trend Direction**: Uptrend/Downtrend/Range-bound
- **Risk Sentiment**: Risk-on/Risk-off
- **Volatility Status**: Market anxiety level from VIX
- **Sector Rotation**: Where capital is flowing

### 3. Report Structure

#### Standard Report Format:
```
1. Executive Summary (3-5 key points)
2. Global Market Overview
   - US Markets
   - Asian Markets
   - European Markets
3. Forex & Commodities Trends
4. Key Events & Economic Indicators
5. Risk Factor Analysis
6. Investment Strategy Implications
```

## Script Usage

### market_utils.py
Provides common functions for report creation:
```bash
# Generate report header
python scripts/market_utils.py

# Available functions:
- format_market_report_header(): Create header
- get_market_session_times(): Check trading hours
- categorize_volatility(vix): Interpret VIX levels
- format_percentage_change(value): Format price changes
```

## Reference Documentation

### Key Indicators Interpretation
Load `references/indicators.md` when you need:
- Important levels for each index
- Technical analysis key points
- Sector-specific focus areas

### Analysis Patterns
Load `references/analysis_patterns.md` when analyzing:
- Risk-on/Risk-off criteria
- Economic indicator interpretation
- Inter-market correlations
- Seasonality and market anomalies

## Output Format Examples

### Quick Summary Version
```
📊 Market Summary [2025/01/15 14:00]
━━━━━━━━━━━━━━━━━━━━━
【US】S&P 500: 5,123.45 (+0.45%)
【JP】Nikkei 225: 38,456.78 (-0.23%)
【FX】USD/JPY: 149.85 (↑0.15)
【VIX】16.2 (Normal range)

⚡ Key Events
- Japan GDP Flash
- US Employment Report

📈 Environment: Risk-On Continues
```

### Detailed Analysis Version
Start with executive summary, then analyze each section in detail.
Key clarifications:
1. Current market phase (Bullish/Bearish/Neutral)
2. Short-term direction (1-5 days outlook)
3. Risk events to monitor
4. Recommended position adjustments

## Important Considerations

### Timezone Awareness
- Consider all major market timezones
- US markets: Evening to early morning (Asian time)
- European markets: Afternoon to evening (Asian time)
- Asian markets: Morning to afternoon (Local time)

### Economic Calendar Priority
Categorize by importance:
- ⭐⭐⭐ Critical (FOMC, NFP, CPI, etc.)
- ⭐⭐ Important (GDP, Retail Sales, etc.)
- ⭐ Reference level

### Data Source Priority
1. Official releases (Central banks, Government statistics)
2. Major financial media (Bloomberg, Reuters)
3. Broker reports
4. Analyst consensus estimates

## Troubleshooting

### Data Collection Notes
- Check market holidays (holiday calendars)
- Be aware of daylight saving time changes
- Distinguish between flash and final data

### Market Volatility Response
1. First organize the facts
2. Reference historical similar events
3. Verify with multiple sources
4. Maintain objective analysis

## Customization Options

Adjust based on user's investment style:
- **Day Traders**: Intraday charts, order flow focus
- **Swing Traders**: Daily/weekly technicals emphasis
- **Long-term Investors**: Fundamentals, macro economics focus
- **Forex Traders**: Currency correlations, interest rate differentials
- **Options Traders**: Volatility analysis, Greeks monitoring

## Resources

- `references/indicators.md` - Key market indicators and interpretation guides
- `references/analysis_patterns.md` - Risk-on/risk-off criteria and inter-market correlations
- `scripts/market_utils.py` - Utility functions for report formatting and market status

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
