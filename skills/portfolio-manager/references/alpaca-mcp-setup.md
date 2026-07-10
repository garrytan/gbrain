# Alpaca MCP Server Setup Guide

This guide explains how to set up and configure the Alpaca MCP (Model Context Protocol) Server for use with the Portfolio Manager skill.

## What is Alpaca MCP Server?

The Alpaca MCP Server is a Model Context Protocol server that provides Claude with access to your Alpaca brokerage account data through a standardized interface. This allows the Portfolio Manager skill to fetch real-time portfolio positions, account information, and transaction history directly from your Alpaca account.

## Prerequisites

### 1. Alpaca Account

You need an Alpaca brokerage account (paper trading or live):

- **Sign up:** https://alpaca.markets/
- **Paper Trading:** Free, uses simulated money (recommended for testing)
- **Live Trading:** Real money account (requires funding)

### 2. Alpaca API Keys

Generate API keys from your Alpaca dashboard:

**For Paper Trading:**
1. Log into Alpaca dashboard: https://app.alpaca.markets/
2. Navigate to "Paper Trading" account
3. Go to "Your API Keys" section
4. Click "Generate New Key"
5. Save your:
   - **API Key ID** (public key)
   - **Secret Key** (private key - only shown once!)

**For Live Trading:**
1. Log into Alpaca dashboard
2. Navigate to "Live Trading" account
3. Go to "Your API Keys" section
4. Click "Generate New Key"
5. Save your API credentials

⚠️ **Security Note:** Never share your Secret Key or commit it to version control. Treat it like a password.

## Installation

### Option 1: Using MCP Server (Recommended for Claude Desktop/Web)

**Step 1: Install Alpaca MCP Server**

The Alpaca MCP server may be available through Claude's MCP marketplace or as a standalone package.

Check if available in your Claude environment:
```bash
# List available MCP servers
claude mcp list
```

If not installed, follow Anthropic's MCP server installation guide for your platform.

**Step 2: Configure API Keys**

Set environment variables with your Alpaca credentials:

**On macOS/Linux:**
```bash
# For Paper Trading
export ALPACA_API_KEY="your_api_key_id"
export ALPACA_SECRET_KEY="your_secret_key"
export ALPACA_PAPER=true

# For Live Trading
export ALPACA_API_KEY="your_api_key_id"
export ALPACA_SECRET_KEY="your_secret_key"
export ALPACA_PAPER=false
```

Add to `~/.bashrc` or `~/.zshrc` to persist across sessions:
```bash
echo 'export ALPACA_API_KEY="your_api_key_id"' >> ~/.bashrc
echo 'export ALPACA_SECRET_KEY="your_secret_key"' >> ~/.bashrc
echo 'export ALPACA_PAPER=true' >> ~/.bashrc
source ~/.bashrc
```

**On Windows (PowerShell):**
```powershell
# For Paper Trading
$env:ALPACA_API_KEY="your_api_key_id"
$env:ALPACA_SECRET_KEY="your_secret_key"
$env:ALPACA_PAPER="true"

# For Live Trading
$env:ALPACA_API_KEY="your_api_key_id"
$env:ALPACA_SECRET_KEY="your_secret_key"
$env:ALPACA_PAPER="false"
```

To persist environment variables on Windows:
```powershell
[System.Environment]::SetEnvironmentVariable('ALPACA_API_KEY', 'your_api_key_id', 'User')
[System.Environment]::SetEnvironmentVariable('ALPACA_SECRET_KEY', 'your_secret_key', 'User')
[System.Environment]::SetEnvironmentVariable('ALPACA_PAPER', 'true', 'User')
```

**Step 3: Start MCP Server**

The MCP server should start automatically when Claude launches. Verify connection:
```bash
# Check MCP server status (if CLI available)
claude mcp status
```

### Option 2: Direct API Integration (Alternative)

If MCP server is unavailable, the skill can fall back to direct Alpaca API integration using Python:

**Step 1: Install Alpaca Python SDK**
```bash
pip install alpaca-trade-api
```

**Step 2: Create Configuration File**

Create `~/.alpaca/config.ini`:
```ini
[alpaca]
api_key_id = your_api_key_id
secret_key = your_secret_key
base_url = https://paper-api.alpaca.markets  # For paper trading
# base_url = https://api.alpaca.markets     # For live trading
```

Set proper permissions:
```bash
chmod 600 ~/.alpaca/config.ini
```

**Step 3: Test Connection**

Use the provided test script:
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

## Available MCP Tools

Once configured, the Portfolio Manager skill can use these Alpaca MCP tools:

### `mcp__alpaca__get_account_info`
Fetches account summary:
- Total equity (portfolio value)
- Cash balance
- Buying power
- Account status
- Day trading buying power (if applicable)

### `mcp__alpaca__get_positions`
Retrieves all open positions:
- Symbol ticker
- Quantity (shares)
- Average entry price (cost basis)
- Current market price
- Current market value
- Unrealized P&L ($ and %)
- Today's P&L

### `mcp__alpaca__get_portfolio_history`
Gets historical portfolio performance:
- Equity time series
- Profit/loss time series
- Timeframes: 1D, 1W, 1M, 3M, 1Y, All

### `mcp__alpaca__get_orders`
Lists orders (open, filled, cancelled):
- Order ID
- Symbol
- Quantity
- Order type (market, limit, stop, etc.)
- Status
- Fill price (if filled)
- Timestamps

### `mcp__alpaca__get_activities`
Retrieves account activities:
- Trades (fills)
- Dividend payments
- Stock splits
- Journal entries

## Verification and Testing

### Test 1: Account Connection

Ask Claude to fetch account info:
```
"Can you get my Alpaca account information?"
```

Expected response should include your equity, cash, and buying power.

### Test 2: Portfolio Positions

Request current positions:
```
"What positions do I have in my portfolio?"
```

Expected response should list all holdings with quantities and values.

### Test 3: Portfolio Analysis

Trigger the Portfolio Manager skill:
```
"Analyze my portfolio"
```

The skill should:
1. Fetch positions via MCP
2. Gather additional market data
3. Perform comprehensive analysis
4. Generate detailed report

## Troubleshooting

### Error: "Alpaca MCP Server not connected"

**Possible causes:**
1. MCP server not running
2. API keys not configured
3. API keys invalid or expired

**Solutions:**
1. Restart Claude to reinitialize MCP servers
2. Verify environment variables are set: `echo $ALPACA_API_KEY`
3. Check API keys in Alpaca dashboard (regenerate if needed)
4. Verify account status (ensure not suspended)

### Error: "Invalid API credentials"

**Possible causes:**
1. Wrong API keys
2. Using live keys with paper mode (or vice versa)
3. API keys revoked

**Solutions:**
1. Double-check API Key ID and Secret Key (no extra spaces)
2. Verify `ALPACA_PAPER` setting matches your API keys
3. Regenerate API keys in Alpaca dashboard
4. Ensure you're using the correct account (paper vs live)

### Error: "Forbidden - insufficient permissions"

**Possible causes:**
1. API keys have restricted permissions
2. Account not approved for trading

**Solutions:**
1. Regenerate API keys with full permissions
2. Check Alpaca dashboard for account status
3. For live accounts, ensure account approval is complete

### Error: "No positions found"

**Possible causes:**
1. Portfolio is actually empty
2. Wrong account selected (paper vs live)
3. API returning stale data

**Solutions:**
1. Verify positions exist in Alpaca dashboard
2. Confirm `ALPACA_PAPER` setting matches intended account
3. Try refreshing: ask Claude to fetch positions again
4. Check Alpaca API status page: https://status.alpaca.markets/

### MCP Server Not Responding

**Solutions:**
1. Restart Claude application
2. Check MCP server logs (if available)
3. Verify network connectivity
4. Fall back to direct API integration (Option 2)

## Security Best Practices

### 1. Use Paper Trading for Testing
Always test with paper trading account first. Never risk real money until thoroughly tested.

### 2. Protect API Keys
- Never commit API keys to GitHub or version control
- Use environment variables, not hardcoded values
- Set file permissions: `chmod 600` for config files
- Rotate keys periodically (every 90 days)

### 3. Use Read-Only Keys (If Available)
For portfolio analysis only, use read-only API keys if Alpaca supports them. This prevents accidental trading.

### 4. Monitor API Usage
- Check Alpaca dashboard for API call logs
- Review account activities regularly
- Set up alerts for unusual activity

### 5. Separate Paper and Live Environments
- Use different environment variable prefixes
- Never mix paper and live credentials
- Document which keys are which

## API Rate Limits

Alpaca imposes rate limits on API calls:

**Free Tier:**
- 200 requests per minute
- Data delayed by 15 minutes (for free market data)

**Paid Tier (Alpaca Markets Data subscription):**
- Higher rate limits
- Real-time data

**Best Practices:**
- Portfolio Manager skill includes built-in rate limiting
- Avoid running analysis more than once per minute
- For frequent monitoring, consider caching results

## Alternative: Manual Data Entry

If Alpaca integration is unavailable, Portfolio Manager can accept manually entered portfolio data:

**CSV Format:**
```csv
symbol,quantity,cost_basis,current_price
AAPL,100,150.00,175.50
MSFT,50,280.00,310.25
GOOGL,25,2500.00,2750.00
```

**Usage:**
1. Export positions from your broker as CSV
2. Provide file to Claude: "Analyze my portfolio using this CSV file"
3. Skill will parse data and perform analysis

**Limitations:**
- No real-time updates
- No historical performance data
- Manual updates required

## Additional Resources

**Alpaca Documentation:**
- API docs: https://alpaca.markets/docs/
- Python SDK: https://github.com/alpacahq/alpaca-trade-api-python
- API reference: https://alpaca.markets/docs/api-references/trading-api/

**MCP Protocol:**
- Anthropic MCP docs: https://docs.anthropic.com/claude/docs/model-context-protocol
- MCP specification: https://github.com/anthropics/mcp

**Support:**
- Alpaca support: support@alpaca.markets
- Alpaca community: https://forum.alpaca.markets/
- API status: https://status.alpaca.markets/
