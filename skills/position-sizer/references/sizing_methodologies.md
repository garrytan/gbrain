# Position Sizing Methodologies

## Overview

Position sizing determines how many shares to buy on each trade. Correct sizing is the single most important factor in long-term portfolio survival. A great stock pick with bad sizing can destroy an account; a mediocre pick with proper sizing preserves capital for the next opportunity.

This reference covers three primary methods: Fixed Fractional, ATR-based, and Kelly Criterion. Each has distinct strengths and ideal use cases.

---

## Fixed Fractional Method (Percentage Risk)

### Concept

Risk a fixed percentage of the account on every trade. The most widely used method among professional traders, popularized by Van Tharp and applied rigorously by Mark Minervini and William O'Neil.

### Formula

```
risk_per_share = entry_price - stop_price
dollar_risk    = account_size * risk_pct / 100
shares         = int(dollar_risk / risk_per_share)
```

### Standard Risk Levels

| Risk % | Trader Profile | Notes |
|--------|---------------|-------|
| 0.25-0.50% | Conservative / large account | Institutional-grade risk |
| 0.50-1.00% | Experienced swing trader | Minervini recommended range |
| 1.00-1.50% | Active trader, proven edge | Standard for tested systems |
| 1.50-2.00% | Aggressive, high win-rate | Maximum for most strategies |
| > 2.00% | Dangerous | Ruin risk increases rapidly |

### Example

- Account: $100,000
- Entry: $155.00, Stop: $148.50
- Risk per share: $6.50
- At 1% risk: $1,000 / $6.50 = **153 shares**
- Position value: $23,715 (23.7% of account)

### When to Use

- Default method for most swing and position trades
- When you have a clear technical stop level (support, moving average, prior low)
- When trading a system with established risk parameters

### Minervini / O'Neil Integration

Mark Minervini recommends:
- Risk no more than 1% per trade during the early stages of a rally
- Tighten to 0.5% after consecutive losses
- Use a "progressive exposure" model: start with half position, add on confirmation
- Maximum portfolio heat (total open risk): 6-8%

William O'Neil recommends:
- Cut losses at 7-8% below purchase price (hard maximum)
- Preferred loss cut: 3-5% for experienced traders
- Use a "follow-through day" to confirm market direction before increasing exposure

---

## ATR-Based Method (Volatility Sizing)

### Concept

Use the Average True Range (ATR) to set stop distance, automatically adjusting position size to a stock's volatility. Originated with the Turtle Traders (Richard Dennis, 1983).

### Formula

```
stop_distance  = atr * atr_multiplier
stop_price     = entry_price - stop_distance
risk_per_share = stop_distance
dollar_risk    = account_size * risk_pct / 100
shares         = int(dollar_risk / risk_per_share)
```

### ATR Multiplier Guidance

| Multiplier | Stop Width | Style |
|-----------|-----------|-------|
| 1.0x | Tight | Day trading, very short-term |
| 1.5x | Moderate-tight | Swing trading, 2-5 day holds |
| 2.0x | Standard | Default for most swing trades (Turtle Traders) |
| 2.5x | Wide | Position trading, 2-8 week holds |
| 3.0x | Very wide | Trend following, multi-month holds |

### Example

- Account: $100,000, Risk: 1%
- Entry: $155.00, ATR(14) = $3.20, Multiplier = 2.0x
- Stop distance: $6.40, Stop: $148.60
- Dollar risk: $1,000
- Shares: int($1,000 / $6.40) = **156 shares**

### When to Use

- When you want volatility-adjusted sizing across different stocks
- When a stock lacks clear support/resistance for a discrete stop
- For systematic/mechanical trading systems
- When comparing positions across stocks with different price ranges and volatilities

### Advantages Over Fixed Stop

1. Low-volatility stocks get larger positions (tighter stop relative to price)
2. High-volatility stocks get smaller positions (wider stop protects against noise)
3. Normalizes risk across the portfolio regardless of stock price

---

## Kelly Criterion

### Concept

The Kelly Criterion calculates the mathematically optimal fraction of capital to risk, given known win rate and payoff ratio. Developed by John L. Kelly Jr. (1956) at Bell Labs.

### Formula

```
R         = avg_win / avg_loss       (payoff ratio)
kelly_pct = W - (1 - W) / R          (full Kelly percentage)
half_kelly = kelly_pct / 2            (practical recommendation)
```

Where W = historical win rate (0 to 1).

### Full Kelly vs. Half Kelly

**Full Kelly** maximizes long-term geometric growth but produces extreme volatility. Drawdowns of 50%+ are common. No professional fund uses full Kelly.

**Half Kelly** achieves approximately 75% of the theoretical growth rate with dramatically lower drawdowns. This is the standard recommendation for real trading.

| Metric | Full Kelly | Half Kelly | Quarter Kelly |
|--------|-----------|-----------|---------------|
| Growth rate | 100% | ~75% | ~50% |
| Max drawdown | Severe (50%+) | Moderate (25-35%) | Mild (15-20%) |
| Practical use | Never | Aggressive | Conservative |

### Example

- Win rate: 55%, Avg win: $2.50, Avg loss: $1.00
- R = 2.5 / 1.0 = 2.5
- Kelly = 0.55 - 0.45 / 2.5 = 0.55 - 0.18 = 0.37 = **37%**
- Half Kelly = **18.5%**
- On $100,000 account: risk budget = $18,500

### Negative Expectancy

When the Kelly formula produces a negative value, the system has negative expected value. The Kelly percentage is floored at 0%, meaning "do not trade this system."

Example:
- Win rate: 30%, Avg win: $1.00, Avg loss: $1.50
- R = 1.0 / 1.5 = 0.667
- Kelly = 0.30 - 0.70 / 0.667 = 0.30 - 1.05 = **-0.75** -> floored to **0%**

### Two Modes of Use

1. **Budget Mode** (no entry price): Returns a recommended risk budget as a percentage of account. Useful for capital allocation planning before identifying specific entries.

2. **Shares Mode** (with entry and stop): Converts the half-Kelly budget into a specific share count using the entry/stop distance.

### When to Use

- When you have reliable historical win rate and payoff statistics (100+ trades minimum)
- For portfolio-level capital allocation across multiple strategies
- As a ceiling check: "Am I risking more than Kelly suggests?"
- Not suitable for discretionary traders without track records

---

## Portfolio Constraints

### Maximum Position Size

Limit any single position to a percentage of account value:

```
max_shares = int(account_size * max_position_pct / 100 / entry_price)
```

**Guidelines:**
- 5-10%: Conservative (diversified portfolio, 10-20 positions)
- 10-15%: Moderate (concentrated portfolio, 7-10 positions)
- 15-25%: Aggressive (high-conviction portfolio, 4-7 positions)
- > 25%: Speculative (not recommended for most traders)

### Sector Concentration

Limit total exposure to any single sector:

```
remaining_pct = max_sector_pct - current_sector_exposure
remaining_dollars = remaining_pct / 100 * account_size
max_shares = int(remaining_dollars / entry_price)
```

**Guidelines:**
- Individual stock: 5-10% of portfolio
- Single sector: 25-30% maximum
- Correlated positions: Treat as a single exposure

### Position Count and Diversification

| Positions | Diversification | Notes |
|-----------|----------------|-------|
| 1-4 | Very concentrated | High volatility, requires high conviction |
| 5-10 | Focused | Sweet spot for active traders |
| 10-20 | Diversified | Diminishing returns above 15 |
| 20+ | Over-diversified | Dilutes edge, approaches index performance |

Research shows that beyond 20 uncorrelated positions, additional diversification benefit is minimal. For active traders, 5-10 positions with proper sizing often produces better risk-adjusted returns than 20+ positions with diluted conviction.

### Binding Constraint Logic

When multiple constraints apply, the strictest (minimum share count) wins. The position sizer identifies which constraint is "binding" so the trader understands what limits the position.

Priority order:
1. Risk-based shares (from Fixed Fractional, ATR, or Kelly)
2. Max position % limit
3. Max sector % limit
4. Final = minimum of all candidates

---

## Method Comparison

| Feature | Fixed Fractional | ATR-Based | Kelly Criterion |
|---------|-----------------|-----------|-----------------|
| Input needed | Entry, stop, risk % | Entry, ATR, multiplier, risk % | Win rate, avg win/loss |
| Adjusts for volatility | No | Yes | No (uses historical stats) |
| Requires track record | No | No | Yes (100+ trades) |
| Best for | Discretionary trades | Systematic/mechanical | Capital allocation |
| Complexity | Low | Medium | Medium |
| Typical use | Primary sizing | Primary sizing | Ceiling check / allocation |
| Stop determined by | Chart analysis | ATR calculation | External (chart or ATR) |

### Recommended Workflow

1. **Start with Fixed Fractional** at 1% risk for new strategies or market conditions
2. **Switch to ATR-based** when comparing opportunities across different volatility profiles
3. **Use Kelly as a ceiling** after accumulating 100+ trade records
4. **Always apply constraints** (position limit, sector limit) as a final filter
5. **Reduce risk** after consecutive losses (Minervini's "progressive exposure" in reverse)

---

## Risk Management Principles

### The 1% Rule

Never risk more than 1% of account equity on a single trade. This ensures survival through inevitable losing streaks:

- 10 consecutive losses at 1% = 9.6% drawdown (recoverable)
- 10 consecutive losses at 5% = 40.1% drawdown (devastating)
- 10 consecutive losses at 10% = 65.1% drawdown (account-threatening)

### Portfolio Heat

Total open risk across all positions should not exceed 6-8% of account:

```
portfolio_heat = sum(shares_i * risk_per_share_i) / account_size * 100
```

If portfolio heat exceeds 8%, do not add new positions until existing trades are moved to breakeven or closed.

### Asymmetry of Losses

Losses require disproportionately larger gains to recover:

| Loss | Gain to Recover |
|------|----------------|
| 10% | 11.1% |
| 20% | 25.0% |
| 30% | 42.9% |
| 50% | 100.0% |
| 75% | 300.0% |

This asymmetry is why position sizing and loss cutting are more important than stock selection.
