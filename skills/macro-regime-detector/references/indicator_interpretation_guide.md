# Indicator Interpretation Guide

Quick reference for interpreting each component's output values and signals.

## Component 1: Market Concentration (RSP/SPY)

**What it measures**: Relative performance of equal-weight S&P 500 vs cap-weight S&P 500.

| RSP/SPY Trend | Interpretation | Regime Signal |
|---------------|---------------|---------------|
| Declining | Mega-caps outperforming, market narrowing | Concentration |
| Rising | Broader participation, equal-weight catching up | Broadening |
| Bottoming + turning | Potential regime shift from concentration to broadening | Transition |

**Key levels** (approximate, varies over time):
- 0.28-0.29: Extreme concentration (2024 lows)
- 0.30-0.32: Moderate concentration
- 0.33+: Broadening phase

**Crossover interpretation**:
- Golden cross (6M > 12M): Broadening gaining momentum
- Death cross (6M < 12M): Concentration deepening

## Component 2: Yield Curve (10Y-2Y Spread)

**What it measures**: Shape of the Treasury yield curve, reflecting rate cycle position.

| Spread Level | Curve State | Typical Environment |
|-------------|-------------|-------------------|
| < -0.5% | Deeply inverted | Pre-recession, aggressive tightening |
| -0.5% to 0% | Inverted | Late-cycle, recession risk elevated |
| 0% to 0.5% | Flat/Normalizing | Transition period |
| 0.5% to 1.5% | Normal | Mid-cycle expansion |
| > 1.5% | Steep | Early recovery, accommodative policy |

**Direction signals**:
- Steepening: Either rates normalizing (bull steepener) or long end rising (bear steepener)
- Flattening: Late-cycle tightening or flight to long bonds

**Fallback (SHY/TLT proxy)**: When Treasury API is unavailable, SHY/TLT ratio provides a rough proxy. Rising SHY/TLT ≈ flattening curve. Less precise than actual spread data.

## Component 3: Credit Conditions (HYG/LQD)

**What it measures**: Risk appetite in credit markets — willingness to hold junk bonds vs investment grade.

| HYG/LQD Trend | Interpretation | Regime Signal |
|---------------|---------------|---------------|
| Rising | Credit risk appetite expanding | Risk-on, easing |
| Falling | Flight to quality | Risk-off, tightening |
| Stable | Established credit regime | No transition |

**Why it matters**: Credit markets often lead equity markets. HYG/LQD deterioration preceded the 2020 crash by ~2 weeks and the 2008 crisis by ~3 months.

**Warning levels**:
- Sharp drop (ROC < -3% over 3 months): Potential credit event
- Persistent decline with negative ROC: Late-cycle deterioration
- Stable with positive ROC: Supportive environment for risk assets

## Component 4: Size Factor (IWM/SPY)

**What it measures**: Relative performance of small-caps (Russell 2000) vs large-caps (S&P 500).

| IWM/SPY Trend | Interpretation | Regime Signal |
|---------------|---------------|---------------|
| Rising | Small-caps outperforming — economic optimism | Broadening |
| Falling | Large-cap preference — defensive/quality bias | Concentration |
| Diverging from RSP/SPY | Inconsistent signal — check credit conditions | Uncertain |

**Cycle position**:
- Small-cap outperformance often starts 3-6 months before economic recovery becomes consensus
- Small-cap underperformance accelerates in late-cycle as credit conditions tighten
- IWM/SPY and RSP/SPY usually move together; divergence warrants investigation

## Component 5: Equity-Bond Relationship (SPY/TLT + Correlation)

**What it measures**: Two aspects of the stock-bond relationship.

### SPY/TLT Ratio

| SPY/TLT Trend | Interpretation |
|---------------|---------------|
| Rising | Equities outperforming bonds (risk-on) |
| Falling | Bonds outperforming equities (risk-off) |

### Stock-Bond Correlation (6-month rolling)

| Correlation | Regime | Implication |
|-------------|--------|-------------|
| < -0.3 | Negative (normal) | Bonds effectively hedge equity risk |
| -0.3 to 0 | Mildly negative | Hedging works but weakened |
| 0 to 0.3 | Near zero | Transitional — hedging unreliable |
| > 0.3 | Positive (inflationary) | Both move together — diversification fails |

**Critical signal**: Correlation sign change (negative → positive or vice versa) is one of the most important regime signals. Positive correlation typically occurs during:
- Inflation shocks (2022)
- Stagflation concerns
- Central bank credibility crises

**Correlation bonus scoring**: When 6M and 12M correlation have opposite signs, an additional 20 points are added to the component score, reflecting the significance of this regime shift.

## Component 6: Sector Rotation (XLY/XLP)

**What it measures**: Consumer sentiment through discretionary vs staples spending preference.

| XLY/XLP Trend | Interpretation | Regime Signal |
|---------------|---------------|---------------|
| Rising | Consumer confidence, risk appetite | Risk-on, broadening |
| Falling | Defensive positioning, consumer caution | Risk-off, contraction |
| Stable | Established consumer sentiment | No transition |

**Why Consumer Discretionary vs Staples**:
- Most direct consumer-facing comparison
- Staples demand is relatively inelastic; discretionary is highly cyclical
- XLY includes Amazon, Tesla — captures both consumer and growth sentiment
- XLP is pure defensive (Procter & Gamble, Coca-Cola, Costco)

## Cross-Component Analysis

### Confirmation Patterns

**Strong Broadening Confirmation** (4+ components aligned):
- RSP/SPY ↑ + IWM/SPY ↑ + HYG/LQD stable/↑ + XLY/XLP ↑

**Strong Contraction Confirmation**:
- HYG/LQD ↓ + XLY/XLP ↓ + SPY/TLT ↓ + Yield curve steepening

**Inflationary Confirmation**:
- Stock-bond correlation positive + SPY/TLT ↓ + Yield curve behavior unusual

### Divergence Signals

- **RSP/SPY ↑ but HYG/LQD ↓**: Broadening without credit support — fragile
- **IWM/SPY ↑ but XLY/XLP ↓**: Small-cap rally without consumer backing — suspicious
- **Yield curve steepening but HYG/LQD ↓**: Rate cuts due to crisis, not growth

## Score Interpretation Quick Reference

| Composite Score | Zone | Action |
|----------------|------|--------|
| 0-20 | Stable | Maintain current positioning |
| 21-40 | Early Signal | Increase monitoring frequency |
| 41-60 | Transition Zone | Begin planning adjustments |
| 61-80 | Active Transition | Execute repositioning |
| 81-100 | Confirmed | Complete repositioning |
