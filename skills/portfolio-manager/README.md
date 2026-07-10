# Portfolio Manager

Comprehensive portfolio analysis and management skill that integrates with Alpaca MCP Server to fetch real-time holdings data and generate detailed portfolio reports with rebalancing recommendations.

## Overview

Portfolio Manager analyzes your investment portfolio across multiple dimensions:

- **Asset Allocation** - Stocks, bonds, cash distribution vs target allocation
- **Diversification** - Sector breakdown, position concentration, correlation analysis
- **Risk Assessment** - Portfolio beta, volatility, maximum drawdown, risk score
- **Performance Review** - Winners/losers, absolute and relative returns, benchmarking
- **Position Analysis** - Detailed evaluation of individual holdings (HOLD/ADD/TRIM/SELL recommendations)
- **Rebalancing Plan** - Specific actions to optimize portfolio allocation

## Features

✅ **Alpaca Integration** - Automatically fetches positions via Alpaca MCP Server
✅ **Multi-Dimensional Analysis** - Asset class, sector, geography, market cap, style
✅ **Risk Metrics** - Beta, volatility, drawdown, concentration, HHI
✅ **Position Evaluation** - Thesis validation, valuation, sizing, relative opportunity
✅ **Rebalancing Recommendations** - Prioritized actions (TRIM/ADD/HOLD/SELL)
✅ **Comprehensive Reports** - Markdown reports saved to repository
✅ **Model Portfolios** - Compare to Conservative/Moderate/Growth/Aggressive benchmarks

## Prerequisites

### Required: Alpaca Account and MCP Server

This skill requires:

1. **Alpaca Brokerage Account** (paper or live)
   - Sign up: https://alpaca.markets/
   - Paper trading account (free, simulated money) recommended for testing

2. **Alpaca MCP Server** configured in Claude
   - Provides access to portfolio positions via MCP tools
   - Setup guide: `references/alpaca-mcp-setup.md`

3. **API Credentials** (API Key ID and Secret Key)
   - Generate in Alpaca dashboard
   - Set environment variables:
     ```bash
     export ALPACA_API_KEY="your_api_key_id"
     export ALPACA_SECRET_KEY="your_secret_key"
     export ALPACA_PAPER="true"  # or "false" for live trading
     ```

### Optional: Manual Data Entry

If Alpaca MCP Server is unavailable, you can provide portfolio data manually via CSV:

```csv
symbol,quantity,cost_basis,current_price
AAPL,100,150.00,175.50
MSFT,50,280.00,310.25
```

## Installation

### For Claude Desktop/Code Users

1. **Copy skill to Claude Skills directory:**
   ```bash
   cp -r portfolio-manager ~/.claude/skills/
   ```

2. **Restart Claude** to detect the skill

3. **Configure Alpaca credentials** (see Prerequisites)

### For Claude Web App Users

1. **Download skill package:**
   - `skill-packages/portfolio-manager.skill`

2. **Upload to Claude:**
   - Click "+" in Claude web interface
   - Select "Upload Skill"
   - Choose `portfolio-manager.skill`

3. **Note:** Alpaca MCP Server may not be available in web version; use manual CSV data entry

## Usage

### Basic Portfolio Analysis

Simply ask Claude to analyze your portfolio:

```
"Analyze my portfolio"
"Review my current positions"
"How's my portfolio doing?"
```

The skill will:
1. Fetch positions from Alpaca via MCP
2. Enrich data with market information
3. Perform comprehensive analysis
4. Generate detailed report
5. Provide rebalancing recommendations

### Specific Analysis Types

**Asset Allocation Check:**
```
"What's my current asset allocation?"
"Am I properly diversified?"
```

**Risk Assessment:**
```
"How risky is my portfolio?"
"What's my portfolio beta?"
"What are my biggest risks?"
```

**Rebalancing:**
```
"Should I rebalance my portfolio?"
"What should I buy or sell?"
"Is anything too concentrated?"
```

**Position Review:**
```
"Should I sell Tesla?"
"Is Apple overweight in my portfolio?"
"What should I do with my tech stocks?"
```

**Performance:**
```
"What are my best performing stocks?"
"Which positions are losing money?"
"How am I doing vs the S&P 500?"
```

## Analysis Output

Portfolio Manager generates a comprehensive markdown report including:

### 1. Executive Summary
- Overall portfolio health
- Key strengths and concerns
- Primary recommendations

### 2. Holdings Overview
- All positions with quantities, values, P/L

### 3. Asset Allocation Analysis
- Current vs target allocation
- Sector breakdown
- Geographic distribution
- Market cap distribution

### 4. Diversification Assessment
- Position concentration analysis
- Sector diversification score
- Correlation concerns
- HHI concentration index

### 5. Risk Assessment
- Portfolio beta and volatility
- Maximum drawdown
- Risk concentrations
- Overall risk score

### 6. Performance Review
- Total portfolio value and P/L
- Best and worst performers
- Performance vs benchmark (if available)

### 7. Position Analysis
- Detailed analysis of top 10-15 holdings
- Thesis validation
- Valuation assessment
- Position sizing
- HOLD/ADD/TRIM/SELL recommendations

### 8. Rebalancing Recommendations
- Prioritized actions (High/Medium/Low priority)
- Specific trade recommendations
- Cash deployment suggestions
- Tax considerations

### 9. Action Items
- Immediate actions
- Medium-term tasks
- Monitoring priorities

**Report Location:** `portfolio_analysis_YYYY-MM-DD.md` in repository root

## Reference Materials

The skill includes comprehensive reference documentation:

- **`references/alpaca-mcp-setup.md`** - Alpaca API setup guide
- **`references/asset-allocation.md`** - Asset allocation theory and frameworks
- **`references/diversification-principles.md`** - Diversification concepts and metrics
- **`references/portfolio-risk-metrics.md`** - Risk measurement and interpretation
- **`references/position-evaluation.md`** - Position analysis framework
- **`references/rebalancing-strategies.md`** - Rebalancing methodologies
- **`references/target-allocations.md`** - Model portfolios by risk profile
- **`references/risk-profile-questionnaire.md`** - Risk tolerance assessment

These references are loaded automatically by the skill as needed during analysis.

## Testing Alpaca Connection

Before using the skill, test your Alpaca API connection:

```bash
python3 skills/portfolio-manager/scripts/check_alpaca_connection.py
```

Expected output:
```
✓ Successfully connected to Alpaca API
Account Status: ACTIVE
Equity: $100,000.00
Cash: $50,000.00
Buying Power: $200,000.00
Positions: 5
```

If you see errors, consult `references/alpaca-mcp-setup.md` for troubleshooting.

## Example Workflow

### Initial Portfolio Review

1. **Trigger analysis:**
   ```
   User: "Analyze my portfolio"
   ```

2. **Skill workflow:**
   - Fetches positions from Alpaca MCP
   - Retrieves account information
   - Gathers market data for each position
   - Performs comprehensive analysis
   - Generates detailed report

3. **Report generated:**
   - `portfolio_analysis_2025-11-08.md`
   - Includes all analysis sections
   - Specific recommendations provided

4. **Follow-up questions:**
   ```
   User: "Why should I trim NVDA?"
   User: "What should I buy instead?"
   User: "Is my tech allocation too high?"
   ```

### Ongoing Monitoring

**Quarterly Review:**
```
User: "Review my portfolio for Q4 2025"
```

**After Market Events:**
```
User: "How did the market crash affect my portfolio?"
```

**Before Rebalancing:**
```
User: "Generate rebalancing recommendations"
```

## Key Concepts

### Asset Allocation
Distribution of portfolio across asset classes (stocks, bonds, cash). The primary driver of portfolio risk and return.

### Diversification
Spreading investments across multiple positions, sectors, and geographies to reduce unsystematic risk.

### Rebalancing
Systematically selling overweight positions and buying underweight positions to maintain target allocation.

### Position Sizing
Determining appropriate weight for each holding based on conviction, risk, and portfolio constraints.

### Risk-Adjusted Returns
Evaluating performance relative to risk taken (Sharpe ratio, Sortino ratio).

### Concentration Risk
Excessive exposure to single position, sector, or theme that creates elevated portfolio risk.

## Limitations and Disclaimers

**Important Notes:**

1. **Not Financial Advice** - This tool provides informational analysis only, not personalized financial advice.

2. **Data Accuracy** - Analysis quality depends on Alpaca API data accuracy and third-party market data.

3. **Market Conditions** - Historical analysis may not predict future performance, especially during regime changes.

4. **Tax Implications** - Tax impact estimates are approximate only; consult a tax professional.

5. **Execution Risk** - Recommendations assume ability to execute trades at current market prices.

**Always:**
- Verify critical data independently
- Consult qualified financial advisor before major decisions
- Consider your unique circumstances, risk tolerance, and goals
- Review tax implications with tax professional

## Troubleshooting

### "Alpaca MCP Server not connected"

**Solutions:**
1. Verify MCP server is running (`claude mcp status` if available)
2. Check environment variables are set: `echo $ALPACA_API_KEY`
3. Restart Claude to reinitialize MCP servers
4. Verify API keys in Alpaca dashboard
5. See `references/alpaca-mcp-setup.md` for detailed setup

### "Invalid API credentials"

**Solutions:**
1. Verify API Key ID and Secret Key (no typos, spaces)
2. Check `ALPACA_PAPER` setting matches your keys (paper vs live)
3. Regenerate API keys in Alpaca dashboard
4. Ensure account status is active

### "No positions found"

**Solutions:**
1. Verify positions exist in Alpaca dashboard
2. Confirm you're checking correct account (paper vs live)
3. Check account number matches
4. Try refreshing: ask Claude to fetch positions again

### Report seems inaccurate

**Solutions:**
1. Verify Alpaca data is current (check Alpaca dashboard)
2. Check if market data is delayed (free tier is 15-min delayed)
3. Manually verify a few key positions
4. Report discrepancies to improve analysis

## Version History

- **v1.0** (November 2025) - Initial release
  - Alpaca MCP Server integration
  - Comprehensive portfolio analysis
  - Multi-dimensional risk assessment
  - Position evaluation framework
  - Rebalancing recommendations
  - Model portfolio benchmarks

## Support and Contributing

**For Issues:**
- Check `references/` documentation
- Review troubleshooting section above
- Test Alpaca connection with `check_alpaca_connection.py`
- Check Alpaca API status: https://status.alpaca.markets/

**For Questions:**
- Alpaca API docs: https://alpaca.markets/docs/
- Alpaca community: https://forum.alpaca.markets/

**Skill Enhancement Ideas:**
- Additional broker integrations (Interactive Brokers, Schwab)
- Options portfolio analysis
- Factor exposure analysis
- Monte Carlo retirement projections
- Tax-loss harvesting automation

## Related Skills

This skill works well in combination with:

- **US Stock Analysis** - Deep dive into individual positions
- **Value Dividend Screener** - Find replacement stocks for rebalancing
- **Market News Analyst** - Understand recent market-moving events
- **Sector Analyst** - Analyze sector rotation patterns
- **US Market Bubble Detector** - Assess overall market risk environment

## License

See repository root for license information.

---

**Remember:** Successful portfolio management requires discipline, patience, and long-term perspective. Use this skill to maintain systematic approach and avoid emotional decision-making. The best portfolio is one you can stick with through all market conditions.
