---
name: technical-analyst
description: This skill should be used when analyzing weekly price charts for stocks, stock indices, cryptocurrencies, or forex pairs. Use this skill when the user provides chart images and requests technical analysis, trend identification, support/resistance levels, scenario planning, or probability assessments based purely on chart data without consideration of news or fundamental factors.
---

# Technical Analyst

## Overview

This skill enables comprehensive technical analysis of weekly price charts. Analyze chart images to identify trends, support and resistance levels, moving average relationships, volume patterns, and develop probabilistic scenarios for future price movement. All analysis is conducted objectively using only chart data, without influence from news, fundamentals, or market sentiment.

## When to Use

- User provides weekly chart images (stocks, indices, crypto, forex) and requests technical analysis
- Need to identify trend direction, strength, and potential reversal points
- Looking for support/resistance levels and key price zones
- Want probabilistic scenario planning with specific price targets
- Require objective chart-based analysis without fundamental or news considerations

## Prerequisites

- **Chart Images**: User must provide weekly timeframe chart images for analysis
- **No API Keys Required**: This skill analyzes user-provided images; no external data fetches

## Output Format

This skill generates markdown analysis reports saved to the `reports/` directory:
- **File format**: `[SYMBOL]_technical_analysis_[YYYY-MM-DD].md`
- **Content**: Comprehensive analysis including trend, S/R levels, MA analysis, volume, patterns, and 2-4 probabilistic scenarios with targets and invalidation levels

## Core Principles

1. **Pure Chart Analysis**: Base all conclusions exclusively on technical data visible in the chart
2. **Systematic Approach**: Follow a structured methodology for each chart analysis
3. **Objective Assessment**: Avoid subjective bias; focus on observable patterns and data
4. **Probabilistic Scenarios**: Express future possibilities as probability-weighted scenarios
5. **Sequential Processing**: Analyze each chart individually and document findings immediately

## Analysis Workflow

### Step 1: Receive Chart Images

When the user provides one or more weekly chart images for analysis:

1. Confirm receipt of all chart images
2. Identify the number of charts to analyze
3. Note any specific focus areas requested by the user
4. Proceed to analyze charts sequentially, one at a time

### Step 2: Load Technical Analysis Framework

Before beginning analysis, read the comprehensive technical analysis methodology:

```
Read: references/technical_analysis_framework.md
```

This reference contains detailed guidance on:
- Trend analysis and classification
- Support and resistance identification
- Moving average interpretation
- Volume analysis
- Chart patterns and candlestick analysis
- Scenario development and probability assignment
- Analysis discipline and objectivity

### Step 3: Analyze Each Chart Systematically

For each chart image, conduct a systematic analysis following this sequence:

#### 3.1 Trend Analysis
- Identify trend direction (uptrend, downtrend, sideways)
- Assess trend strength (strong, moderate, weak)
- Note trend duration and potential exhaustion signals
- Examine higher highs/lows or lower highs/lows pattern

#### 3.2 Support and Resistance Analysis
- Mark significant horizontal support levels
- Mark significant horizontal resistance levels
- Identify trendline support/resistance
- Note any support-resistance role reversals
- Assess confluence zones where multiple S/R levels align

#### 3.3 Moving Average Analysis
- Determine price position relative to 20-week, 50-week, and 200-week MAs
- Assess MA alignment (bullish, bearish, or neutral configuration)
- Note MA slope (rising, falling, flat)
- Identify any recent or pending MA crossovers
- Observe MAs acting as dynamic support or resistance

#### 3.4 Volume Analysis
- Assess overall volume trend (increasing, decreasing, stable)
- Identify volume spikes and their context (at support/resistance, on breakouts)
- Check for volume confirmation or divergence with price
- Note any volume climax or exhaustion patterns

#### 3.5 Chart Patterns and Price Action
- Identify any reversal patterns (hammers, shooting stars, engulfing patterns, etc.)
- Identify any continuation patterns (flags, triangles, etc.)
- Note significant candlestick formations
- Observe recent breakouts or breakdowns

#### 3.6 Synthesize Observations
- Integrate all technical elements into coherent current assessment
- Identify the most significant factors influencing the chart
- Note any conflicting signals or ambiguity
- Establish key levels that will determine future direction

### Step 4: Develop Probabilistic Scenarios

For each analyzed chart, create 2-4 distinct scenarios for future price movement:

#### Scenario Structure

Each scenario must include:
1. **Scenario Name**: Clear, descriptive title (e.g., "Bull Case: Breakout Above Resistance")
2. **Probability Estimate**: Percentage likelihood based on technical factors (must sum to 100% across all scenarios)
3. **Description**: What this scenario entails and how it would unfold
4. **Supporting Factors**: Technical evidence supporting this scenario (minimum 2-3 factors)
5. **Target Levels**: Expected price levels if scenario plays out
6. **Invalidation Level**: Specific price level that would negate this scenario

#### Typical Scenario Framework

- **Base Case Scenario (40-60%)**: Most likely outcome based on current structure
- **Bull Case Scenario (20-40%)**: Optimistic scenario requiring upside breakout
- **Bear Case Scenario (20-40%)**: Pessimistic scenario requiring downside breakdown
- **Alternative Scenario (5-15%)**: Lower probability but technically plausible outcome

Adjust probabilities based on strength of supporting technical factors. Ensure probabilities are realistic and sum to 100%.

### Step 5: Generate Analysis Report

For each chart analyzed, create a comprehensive markdown report using the template structure:

```
Read and use as template: assets/analysis_template.md
```

The report must include all sections:
1. Chart Overview
2. Trend Analysis
3. Support and Resistance Levels
4. Moving Average Analysis
5. Volume Analysis
6. Chart Patterns and Price Action
7. Current Market Assessment
8. Scenario Analysis (2-4 scenarios with probabilities)
9. Summary
10. Disclaimer

**File Naming Convention**: Save each analysis as `[SYMBOL]_technical_analysis_[YYYY-MM-DD].md`

Example: `SPY_technical_analysis_2025-11-02.md`

### Step 6: Repeat for Multiple Charts

If multiple charts are provided:

1. Complete the full analysis workflow (Steps 3-5) for the first chart
2. Save the analysis report
3. Proceed to the next chart
4. Repeat until all charts have been analyzed and documented

Do not batch analyses. Complete and save each report before moving to the next chart.

## Quality Standards

### Objectivity Requirements

- Base all analysis strictly on observable chart data
- Avoid incorporating external information (news, fundamentals, sentiment)
- Do not use subjective language like "I think" or "I feel"
- Express uncertainty clearly when signals are ambiguous
- Present both bullish and bearish possibilities to avoid confirmation bias

### Completeness Requirements

- Address all sections of the analysis template
- Provide specific price levels for support, resistance, and targets
- Justify probability estimates with technical factors
- Include invalidation levels for each scenario
- Note any limitations or caveats to the analysis

### Clarity Requirements

- Use precise technical terminology correctly
- Write in clear, professional language
- Structure information logically
- Include specific price levels (not vague descriptions)
- Make scenarios distinct and mutually exclusive

## Example Usage Scenarios

**Example 1: Single Chart Analysis**
```
User: "Please analyze this weekly chart of the S&P 500"
[Provides chart image]

Analyst:
1. Confirms receipt of chart image
2. Reads technical_analysis_framework.md for methodology
3. Conducts systematic analysis (trend, S/R, MA, volume, patterns)
4. Develops 3 scenarios with probabilities (e.g., 55% bullish continuation, 30% consolidation, 15% reversal)
5. Generates comprehensive analysis report using template
6. Saves as SPY_technical_analysis_2025-11-02.md
```

**Example 2: Multiple Chart Analysis**
```
User: "Analyze these three charts: Bitcoin, Ethereum, and Nasdaq"
[Provides 3 chart images]

Analyst:
1. Confirms receipt of 3 charts
2. Reads technical_analysis_framework.md
3. Analyzes Bitcoin chart completely → Generates report → Saves as BTC_technical_analysis_2025-11-02.md
4. Analyzes Ethereum chart completely → Generates report → Saves as ETH_technical_analysis_2025-11-02.md
5. Analyzes Nasdaq chart completely → Generates report → Saves as NDX_technical_analysis_2025-11-02.md
6. Notifies user that all three analyses are complete
```

**Example 3: Focused Analysis Request**
```
User: "I'm particularly interested in whether this stock will break above resistance. Analyze the chart."
[Provides chart image]

Analyst:
1. Conducts full systematic analysis
2. Pays special attention to resistance levels and breakout probability
3. Develops scenarios with emphasis on breakout vs. rejection possibilities
4. Assigns probabilities based on volume, trend strength, and proximity to resistance
5. Generates complete report with focused scenario analysis
```

## Resources

This skill includes the following bundled resources:

### references/technical_analysis_framework.md

Comprehensive methodology for technical analysis including:
- Trend analysis criteria and classification
- Support and resistance identification techniques
- Moving average interpretation guidelines
- Volume analysis principles
- Chart pattern recognition
- Scenario development and probability assignment framework
- Objectivity and discipline reminders

**Usage**: Read this file before conducting analysis to ensure systematic, objective approach.

### assets/analysis_template.md

Structured template for technical analysis reports with all required sections.

**Usage**: Use this template structure for every analysis report. Copy the format and populate with specific findings for each chart.

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
