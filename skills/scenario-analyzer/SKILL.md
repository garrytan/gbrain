---
name: scenario-analyzer
description: |
  Skill that analyzes 18-month scenarios from a news headline.
  Runs the primary analysis with the scenario-analyst agent and obtains a
  second opinion with the strategy-reviewer agent.
  Generates a comprehensive English report covering 1st/2nd/3rd-order
  impacts, recommended stocks, and a critical review.
  Example: /scenario-analyzer "Fed raises rates by 50bp"
  Triggers: news analysis, scenario analysis, 18-month outlook,
  medium-to-long-term investment strategy
---

# Scenario Analyzer

## Overview

This skill analyzes medium-to-long-term (18-month) investment scenarios
starting from a news headline. It invokes two specialized agents in sequence
(`scenario-analyst` and `strategy-reviewer`) and integrates multi-angle
analysis with a critical review into a comprehensive report.

## When to Use This Skill

Use this skill when:

- You want to analyze the medium-to-long-term investment impact of a news headline
- You want to construct multiple 18-month scenarios
- You want sector/stock impacts organized into 1st/2nd/3rd-order effects
- You need a comprehensive analysis that includes a second opinion

**Examples:**
```
/scenario-analyzer "Fed raises interest rates by 50bp, signals more hikes ahead"
/scenario-analyzer "China announces new tariffs on US semiconductors"
/scenario-analyzer "OPEC+ agrees to cut oil production by 2 million barrels per day"
```

## Prerequisites

- **API Keys**: None (uses only WebSearch/WebFetch)
- **MCP Servers**: None
- **Dependencies**: The scenario-analyst and strategy-reviewer agents must be available via the Task tool

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Skill (orchestrator)                              │
│                                                                      │
│  Phase 1: Preparation                                                │
│  ├─ Headline parsing                                                 │
│  ├─ Event type classification                                        │
│  └─ Reference loading                                                │
│                                                                      │
│  Phase 2: Agent invocation                                           │
│  ├─ scenario-analyst (primary analysis)                              │
│  └─ strategy-reviewer (second opinion)                               │
│                                                                      │
│  Phase 3: Integration & report generation                            │
│  └─ reports/scenario_analysis_<topic>_YYYYMMDD.md                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Workflow

### Phase 1: Preparation

#### Step 1.1: Headline Parsing

Parse the headline provided by the user.

1. **Headline check**
   - Confirm a headline was passed as an argument
   - If not provided, ask the user for input

2. **Keyword extraction**
   - Key entities (company names, country names, institution names)
   - Numeric data (rates, prices, quantities)
   - Actions (raise, cut, announce, agree, etc.)

#### Step 1.2: Event Type Classification

Classify the headline into one of the following categories:

| Category | Examples |
|----------|----------|
| Monetary Policy | FOMC, ECB, BOJ, rate hike, rate cut, QE/QT |
| Geopolitics | War, sanctions, tariffs, trade friction |
| Regulation & Policy | Environmental regulation, financial regulation, antitrust |
| Technology | AI, EV, renewables, semiconductors |
| Commodities | Crude oil, gold, copper, agricultural products |
| Corporate & M&A | Acquisitions, bankruptcies, earnings, industry restructuring |

#### Step 1.3: Reference Loading

Based on the event type, load the relevant references:

```
Read references/headline_event_patterns.md
Read references/sector_sensitivity_matrix.md
Read references/scenario_playbooks.md
```

**Reference contents:**
- `headline_event_patterns.md`: Historical event patterns and market reactions
- `sector_sensitivity_matrix.md`: Event × sector impact-magnitude matrix
- `scenario_playbooks.md`: Scenario-construction templates and best practices

---

### Phase 2: Agent Invocation

#### Step 2.1: Invoke scenario-analyst

Use the Agent tool to invoke the primary analysis agent.

```
Agent tool:
- subagent_type: "scenario-analyst"
- prompt: |
    Perform an 18-month scenario analysis for the following headline.

    ## Target Headline
    [the input headline]

    ## Event Type
    [classification result]

    ## Reference Information
    [summary of the loaded references]

    ## Analysis Requirements
    1. Use WebSearch to collect related news from the past 2 weeks
    2. Construct 3 scenarios — Base/Bull/Bear (probabilities sum to 100%)
    3. Analyze 1st/2nd/3rd-order impacts by sector
    4. Select 3-5 positive- and 3-5 negative-impact stocks (US market only)
    5. Output everything in English
```

**Expected output:**
- List of related news articles
- Details of the 3 scenarios (Base/Bull/Bear)
- Sector impact analysis (1st/2nd/3rd-order)
- Stock recommendation list

#### Step 2.2: Invoke strategy-reviewer

Using the scenario-analyst's results, invoke the review agent.

```
Agent tool:
- subagent_type: "strategy-reviewer"
- prompt: |
    Review the following scenario analysis.

    ## Target Headline
    [the input headline]

    ## Analysis Result
    [the full scenario-analyst output]

    ## Review Requirements
    Review from the following angles:
    1. Overlooked sectors/stocks
    2. Validity of the scenario probability allocation
    3. Logical consistency of the impact analysis
    4. Detection of optimism/pessimism bias
    5. Proposal of alternative scenarios
    6. Realism of the timeline

    Output constructive and specific feedback in English.
```

**Expected output:**
- Pointing out blind spots
- Opinion on the scenario probabilities
- Pointing out bias
- Proposal of alternative scenarios
- Final recommendations

---

### Phase 3: Integration & Report Generation

#### Step 3.1: Integrate Results

Integrate the output of both agents to produce the final investment judgment.

**Integration points:**
1. Fill in the blind spots raised in the review
2. Adjust the probability allocation (if needed)
3. Make the final judgment accounting for bias
4. Formulate a concrete action plan

#### Step 3.2: Generate Report

Generate the final report in the following format and save it to a file.

**Save location:** `reports/scenario_analysis_<topic>_YYYYMMDD.md`

```markdown
# Headline Scenario Analysis Report

**Analyzed at**: YYYY-MM-DD HH:MM
**Target headline**: [the input headline]
**Event type**: [classification category]

---

## 1. Related News Articles
[news list collected by scenario-analyst]

## 2. Scenario Overview (through 18 months out)

### Base Case (XX% probability)
[scenario details]

### Bull Case (XX% probability)
[scenario details]

### Bear Case (XX% probability)
[scenario details]

## 3. Sector / Industry Impact

### 1st-Order Impact (direct)
[impact table]

### 2nd-Order Impact (value chain / related industries)
[impact table]

### 3rd-Order Impact (macro / regulation / technology)
[impact table]

## 4. Stocks Expected to Benefit (3-5 tickers)
[stock table]

## 5. Stocks Expected to Be Hurt (3-5 tickers)
[stock table]

## 6. Second Opinion / Review
[strategy-reviewer output]

## 7. Final Investment Judgment & Implications

### Recommended Actions
[concrete actions informed by the review]

### Risk Factors
[list of key risks]

### Monitoring Points
[indicators / events to follow]

---
**Generated by**: scenario-analyzer skill
**Agents**: scenario-analyst, strategy-reviewer
```

#### Step 3.3: Save the Report

1. Create the `reports/` directory if it does not exist
2. Save as `scenario_analysis_<topic>_YYYYMMDD.md` (e.g., `scenario_analysis_venezuela_20260104.md`)
3. Notify the user that the save completed
4. **Do not save directly to the project root**

---

## Output Format

This skill generates the following file:

| File | Format | Description |
|------|--------|-------------|
| `reports/scenario_analysis_<topic>_YYYYMMDD.md` | Markdown | Comprehensive scenario analysis report |

**Output contents:**
- List of related news articles
- 3 scenarios — Base/Bull/Bear (with probability allocation)
- Sector impact analysis (1st/2nd/3rd-order)
- Positive/negative stock recommendations
- Second opinion / review
- Final investment judgment & implications

## Resources

### References
- `references/headline_event_patterns.md` - Event patterns and market reactions
- `references/sector_sensitivity_matrix.md` - Sector sensitivity matrix
- `references/scenario_playbooks.md` - Scenario-construction templates

### Agents
- `scenario-analyst` - Primary scenario analysis
- `strategy-reviewer` - Second opinion / review

---

## Important Notes

### Language
- All analysis and output are in **English**
- Stock tickers remain in their standard (English) symbols

### Target Market
- Stock selection is **US-listed equities only**
- ADRs included

### Time Horizon
- Scenarios target **18 months**
- Described in 3 phases: 0-6 months / 6-12 months / 12-18 months

### Probability Allocation
- Base + Bull + Bear = **100%**
- Each scenario's probability is described with its rationale

### Second Opinion
- **Mandatory** (always invoke strategy-reviewer)
- Review results are reflected in the final judgment

### Output Location (Important)
- **Always** save under the `reports/` directory
- Path: `reports/scenario_analysis_<topic>_YYYYMMDD.md`
- Example: `reports/scenario_analysis_fed_rate_hike_20260104.md`
- Create the `reports/` directory if it does not exist
- **Must not save directly to the project root**

---

## Quality Checklist

Confirm the following before finalizing the report:

- [ ] Is the headline parsed correctly?
- [ ] Is the event type classification appropriate?
- [ ] Do the 3 scenario probabilities sum to 100%?
- [ ] Are the 1st/2nd/3rd-order impacts logically connected?
- [ ] Is the stock selection backed by concrete rationale?
- [ ] Is the strategy-reviewer review included?
- [ ] Is the final judgment reflecting the review documented?
- [ ] Is the report saved to the correct path?

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
