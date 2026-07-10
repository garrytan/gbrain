# Sector Sensitivity Matrix

This reference organizes sector-by-sector sensitivity to various event types
in matrix form. Use it during scenario analysis to quickly judge which sectors
are most likely to be affected.

## Legend

**Impact:**
- `++` : Strong positive impact
- `+` : Positive impact
- `0` : Neutral / minor impact
- `-` : Negative impact
- `--` : Strong negative impact

**Confidence:**
- `H` : High (past patterns are consistent)
- `M` : Medium (situation-dependent)
- `L` : Low (high uncertainty)

---

## 1. Monetary Policy Event Matrices

### Rate-Hike Environment

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Financials (banks) | + | H | JPM, BAC, WFC | Higher net interest income |
| Financials (insurance) | + | M | MET, PRU, AIG | Improved investment income |
| Technology | - | H | AAPL, MSFT, NVDA | High-valuation discount |
| Consumer Discretionary | - | H | AMZN, HD, NKE | Higher borrowing costs |
| Real Estate (REIT) | -- | H | AMT, PLD, EQIX | Rate-sensitive, higher funding costs |
| Utilities | - | H | NEE, DUK, SO | Reduced appeal as a bond substitute |
| Healthcare | 0 | M | UNH, JNJ, PFE | Relatively defensive |
| Consumer Staples | 0 | M | PG, KO, WMT | Relatively defensive |
| Energy | 0 | L | XOM, CVX, COP | Macro-environment dependent |
| Materials | - | M | LIN, APD, ECL | Economically sensitive |
| Industrials | - | M | CAT, DE, HON | Capex-slowdown concern |
| Communication Services | 0 | M | GOOGL, META, DIS | Idiosyncratic factors dominate |

### Rate-Cut Environment

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Technology | ++ | H | AAPL, MSFT, NVDA | Growth-stock valuation expansion |
| Real Estate (REIT) | ++ | H | AMT, PLD, EQIX | Lower funding costs |
| Utilities | + | H | NEE, DUK, SO | Relatively more attractive dividend yield |
| Consumer Discretionary | + | H | AMZN, HD, NKE | Consumption stimulus |
| Financials (banks) | - | H | JPM, BAC, WFC | Lower net interest income |
| Healthcare | 0 | M | UNH, JNJ, PFE | Relatively defensive |
| Consumer Staples | 0 | M | PG, KO, WMT | Relatively defensive |
| Energy | 0 | L | XOM, CVX, COP | Macro-environment dependent |

---

## 2. Geopolitical Event Matrices

### War / Armed Conflict

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Defense | ++ | H | LMT, RTX, NOC, GD | Higher military spending |
| Energy | + | H | XOM, CVX, COP | Prices rise on supply concerns |
| Gold (miners) | ++ | H | NEM, GOLD, AEM | Safe-asset demand |
| Airlines | -- | H | DAL, UAL, AAL | Fuel costs, weaker demand |
| Travel & Leisure | -- | H | MAR, HLT, BKNG | Demand decline |
| Insurance | - | M | AIG, TRV, ALL | Geopolitical-risk reserves |
| Semiconductors | - | M | NVDA, AMD, INTC | Supply-chain risk |
| Shipping | +/- | L | ZIM, DAC, MATX | Impact differs by route dependence |

### Tariffs / Trade Friction (vs. China)

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Semiconductors (equipment) | -- | H | AMAT, LRCX, KLAC | China-market restrictions |
| Consumer goods (China-dependent) | - | H | NKE, AAPL | Impact on both manufacturing and sales |
| Agriculture | - | H | DE, ADM, BG | Lower exports to China |
| Mexico-production companies | + | M | - | Supply-chain substitution benefit |
| Domestic manufacturers | + | M | - | Onshoring benefit |

---

## 3. Regulation & Policy Change Matrices

### Tighter Environmental Regulation

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Renewables (solar) | ++ | H | ENPH, SEDG, FSLR | Expanded policy support |
| Renewables (wind) | ++ | H | NEE, AES | Expanded policy support |
| EV | ++ | H | TSLA, RIVN, LCID | Demand increase from regulation |
| Lithium / batteries | ++ | H | ALB, LTHM | Tied to EV demand |
| Oil & gas | -- | H | XOM, CVX, COP | Stranded-asset risk |
| Coal | -- | H | - | Accelerated fade-out |
| Airlines | - | M | DAL, UAL, AAL | SAF-mandate cost |
| Automakers (legacy) | - | M | F, GM | EV-transition cost |

### Tighter Financial Regulation

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Large banks | - | H | JPM, BAC, C | Higher capital requirements, profit pressure |
| Regional banks | -- | H | - | Heavy regulatory-cost burden |
| Fintech | +/- | M | SQ, PYPL | Benefit/hurt depending on regulation |
| Crypto-asset related | - | M | COIN | Regulatory uncertainty |

### Tighter Antitrust

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Big Tech | - | M | GOOGL, META, AMZN, AAPL | Business-breakup risk |
| Telecom | - | M | T, VZ | M&A-blocking risk |
| Small/mid tech | + | M | - | Improved competitive-environment benefit |

---

## 4. Technology Shift Matrices

### Accelerating AI Revolution

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Semiconductors (GPU) | ++ | H | NVDA, AMD | AI training/inference chip demand |
| Semiconductors (memory) | ++ | H | MU, WDC | HBM demand |
| Cloud infrastructure | ++ | H | MSFT, AMZN, GOOGL | Provides AI foundation |
| Enterprise SW | + | H | CRM, NOW, ADBE | AI feature integration |
| Data-center REIT | ++ | H | EQIX, DLR | Surging demand |
| Utilities | + | M | NEE, SO | Data-center power demand |
| BPO / outsourcing | -- | M | - | Replacement by AI automation |

### Accelerating EV Adoption

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| EV manufacturing | ++ | H | TSLA, RIVN | Market expansion |
| Battery / lithium | ++ | H | ALB, LTHM, LAC | Material demand |
| Charging infrastructure | ++ | H | CHPT, BLNK | Infrastructure investment |
| Utilities | + | M | NEE, SO | Higher power demand |
| Legacy automakers | - | M | F, GM | Transition cost |
| Auto parts (engines) | -- | H | - | Demand-structure change |
| Oil refining | - | M | VLO, PSX | Lower gasoline demand |

---

## 5. Commodity Shock Matrices

### Crude Oil Price Spike ($100+/bbl)

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Oil majors | ++ | H | XOM, CVX, COP | Surging profits |
| Shale companies | ++ | H | PXD, EOG, DVN | Large improvement in economics |
| Oilfield services | ++ | H | SLB, HAL, BKR | Increased drilling activity |
| Airlines | -- | H | DAL, UAL, AAL | Sharply higher fuel costs |
| Transportation | -- | H | UPS, FDX | Higher fuel costs |
| Chemicals | - | H | DOW, LYB | Higher feedstock costs |
| Consumer goods | - | M | Broad | Lower consumer purchasing power |

### Crude Oil Price Crash ($50-/bbl)

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Oil majors | -- | H | XOM, CVX, COP | Lower profits, capex cuts |
| Shale companies | -- | H | PXD, EOG, DVN | Below-breakeven risk |
| Airlines | ++ | H | DAL, UAL, AAL | Lower fuel costs |
| Consumer goods | + | M | Broad | Higher disposable income |
| Chemicals | + | M | DOW, LYB | Lower feedstock costs |

### Gold Price Spike

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Gold miners | ++ | H | NEM, GOLD, AEM | Leverage effect |
| Silver miners | ++ | H | PAAS, AG, HL | Precious-metals linkage |
| Jewelry | 0 | M | SIG, TIF | Demand decline offset by higher inventory value |

---

## 6. Economic Cycle Matrices

### Economic Expansion

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Technology | ++ | H | AAPL, MSFT, NVDA | Higher corporate IT spending |
| Consumer Discretionary | ++ | H | AMZN, HD, NKE | Consumption expansion |
| Industrials | ++ | H | CAT, DE, HON | Higher capex |
| Materials | + | H | LIN, APD, FCX | Higher demand |
| Financials | + | H | JPM, BAC, GS | Credit expansion, active M&A |

### Economic Recession

| Sector | Impact | Confidence | Representative tickers | Notes |
|--------|--------|------------|------------------------|-------|
| Consumer Staples | + | H | PG, KO, WMT | Defensive |
| Healthcare | + | H | UNH, JNJ, PFE | Non-discretionary spending |
| Utilities | + | H | NEE, DUK, SO | Stable dividends |
| Consumer Discretionary | -- | H | AMZN, HD, NKE | Discretionary-spending cuts |
| Industrials | -- | H | CAT, DE, HON | Capex freeze |
| Financials | - | H | JPM, BAC | Rising loan-loss concerns |

---

## How to Use

1. **Identify the event type**: Judge the event category from the headline
2. **Refer to the relevant matrix**: Select the appropriate matrix above
3. **Check impact and confidence**: Understand the impact per sector
4. **Use representative tickers as a starting point**: As the basis for deeper analysis
5. **For compound scenarios, refer to multiple matrices**: Integrate multiple matrices when several events are involved

## Caveats

- **Single-stock situation**: Sector impact and single-stock impact can differ
- **Timing**: Distinguish immediate impact from delayed impact
- **Scale**: Impact magnitude varies with the scale of the event
- **Degree of market pricing-in**: If the market has already priced it in, the reaction is limited
