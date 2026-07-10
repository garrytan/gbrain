# Scenario Playbooks

This reference provides templates and best practices for constructing
18-month scenarios. Use it during scenario analysis to produce consistent,
high-quality scenarios.

## Core Principles of Scenario Construction

### 1. MECE Principle (Mutually Exclusive, Collectively Exhaustive)

Scenarios should satisfy:
- **Mutually exclusive**: scenarios do not overlap
- **Collectively exhaustive**: cover all major possibilities

### 2. Probability Allocation Guidelines

| Scenario | Typical range | Rationale for the allocation |
|----------|---------------|------------------------------|
| Base Case | 50-65% | Most probable development |
| Bull Case | 15-25% | Positive upside |
| Bear Case | 20-30% | Negative downside |
| Total | 100% | Always adjust so it sums to 100% |

**When an asymmetric allocation is appropriate:**
- Bull > Bear: environment with many bullish drivers
- Bear > Bull: environment with many risk factors
- Base > 60%: low-uncertainty situation
- Base < 50%: extremely high-uncertainty situation (even the Base Case is uncertain)

### 3. Timeline Segmentation

**3-phase structure:**
- **0-6 months**: short-term reaction, initial moves
- **6-12 months**: medium-term development, trend formation
- **12-18 months**: long-term outcome, new equilibrium

---

## Scenario Templates

### Base Case Template

```markdown
### Base Case (XX% probability)

**Summary**:
[Summarize the scenario in 1-2 sentences. Describe the most probable development.]

**Assumptions**:
- [Assumption 1]: [specific condition]
- [Assumption 2]: [specific condition]
- [Assumption 3]: [specific condition]

**Timeline**:

**0-6 months:**
- [Key development 1]
- [Key development 2]
- [Expected market reaction]

**6-12 months:**
- [Medium-term development 1]
- [Medium-term development 2]
- [Trend direction]

**12-18 months:**
- [Long-term outcome 1]
- [New equilibrium state]
- [Structural change (if any)]

**Impact on economic indicators**:
| Indicator | Current | 6-month forecast | 12-month forecast | 18-month forecast |
|-----------|---------|------------------|-------------------|-------------------|
| GDP growth | X% | X% | X% | X% |
| Inflation | X% | X% | X% | X% |
| Policy rate | X% | X% | X% | X% |
| Unemployment | X% | X% | X% | X% |

**Key catalysts**:
- [Factor that supports this scenario 1]
- [Factor that supports this scenario 2]

**Invalidation signals**:
- [Sign this scenario is breaking down 1]
- [Sign this scenario is breaking down 2]
```

### Bull Case Template

```markdown
### Bull Case (XX% probability)

**Summary**:
[Summarize the optimistic scenario in 1-2 sentences. What kind of upside occurs.]

**Assumptions**:
- [Optimistic assumption 1]: [specific condition]
- [Optimistic assumption 2]: [specific condition]
- [Optimistic assumption 3]: [specific condition]

**Timeline**:

**0-6 months:**
- [Positive development 1]
- [Positive development 2]
- [Expected favorable market reaction]

**6-12 months:**
- [Continuation of the upside trend]
- [Additional positive factors]
- [Improving market sentiment]

**12-18 months:**
- [Outcome of the optimistic scenario]
- [State achieved]
- [Sustainability assessment]

**Impact on economic indicators**:
[Assume figures better than the Base Case]

**Upside catalysts**:
- [Factor that realizes this scenario 1]
- [Factor that realizes this scenario 2]

**Conditions that raise this scenario's probability**:
- [Condition 1]
- [Condition 2]
```

### Bear Case Template

```markdown
### Bear Case (XX% probability)

**Summary**:
[Summarize the risk scenario in 1-2 sentences. What kind of downside occurs.]

**Assumptions**:
- [Risk assumption 1]: [specific condition]
- [Risk assumption 2]: [specific condition]
- [Risk assumption 3]: [specific condition]

**Timeline**:

**0-6 months:**
- [Negative development 1]
- [Negative development 2]
- [Expected adverse market reaction]

**6-12 months:**
- [Continuation/deepening of the downside trend]
- [Secondary problems surfacing]
- [Deteriorating market sentiment]

**12-18 months:**
- [Outcome of the risk scenario]
- [Worst-case state]
- [Recovery path (if any)]

**Impact on economic indicators**:
[Assume figures worse than the Base Case]

**Downside risk factors**:
- [Factor that triggers this scenario 1]
- [Factor that triggers this scenario 2]

**Conditions that raise this scenario's probability**:
- [Condition 1]
- [Condition 2]

**Risk-mitigating factors**:
- [Factor that may mitigate this scenario 1]
- [Factor that may mitigate this scenario 2]
```

---

## Scenario Playbooks by Event Type

### 1. Monetary Policy Event (Rate Hike)

**Base Case (55%):**
- Rate hike implemented as expected
- Market has largely priced it in
- Mild equity dip, slight rise in bond yields

**Bull Case (20%):**
- Hike smaller than expected
- Dovish forward guidance
- Equity-market rally

**Bear Case (25%):**
- Hike larger than expected
- Hawkish forward guidance
- Sharp equity selloff, widening credit spreads

### 2. Geopolitical Event (Conflict Outbreak)

**Base Case (50%):**
- Limited escalation of the conflict
- Short-term rise in commodity prices
- Situation stabilizes within a few months

**Bull Case (15%):**
- Early ceasefire / peace agreement
- Commodity prices normalize
- Market recovers early

**Bear Case (35%):**
- Prolonged / expanded conflict
- Serious disruption of commodity supply
- Accelerating global inflation, recession risk

### 3. Technology Shift (AI Regulation)

**Base Case (50%):**
- Gradual introduction of regulation
- Industry self-regulation predominates
- Limited impact on innovation

**Bull Case (25%):**
- Regulation formulated in a way favorable to the industry
- Regulatory clarity actually accelerates investment
- Entry barriers formed that favor incumbents

**Bear Case (25%):**
- Strict regulation introduced
- Significant restrictions on AI development
- Decline in US companies' competitiveness

### 4. Corporate Event (Large M&A)

**Base Case (60%):**
- Regulatory approval obtained
- Closing on schedule
- Gradual realization of integration synergies

**Bull Case (15%):**
- Synergies realized beyond expectations
- Integration goes smoothly
- Additional M&A strategy succeeds

**Bear Case (25%):**
- Blocked by regulators or conditional approval
- Delay / failure of integration
- Synergies not achieved

---

## Scenario Quality Checklist

### Internal Consistency
- [ ] Are the assumptions of each scenario logically consistent?
- [ ] Is the causality of the timeline development clear?
- [ ] Are the economic-indicator forecasts mutually consistent?

### External Validity
- [ ] Is it consistent with past analogous events?
- [ ] Does it appropriately reflect the current market environment?
- [ ] Does it not diverge greatly from expert views?

### Practicality
- [ ] Is there enough specificity to be useful for investment decisions?
- [ ] Are monitorable catalysts identified?
- [ ] Are invalidation signals clear?

### Comprehensiveness
- [ ] Are the major risk scenarios included?
- [ ] Is the upside possibility appropriately considered?
- [ ] Is there mention of tail risk?

---

## Common Mistakes and How to Avoid Them

### 1. Status-quo bias
**Problem**: Assigning excessive probability to the Base Case (70%+)
**Avoid**: Recognize that historically the probability of "nothing changes" is low

### 2. Recency bias
**Problem**: Overestimating the impact of the most recent event
**Avoid**: Maintain a long-term view, refer to past patterns

### 3. Confirmation bias
**Problem**: Adopting only interpretations aligned with the headline
**Avoid**: Deliberately seek out opposing views

### 4. Excessive precision
**Problem**: Forecasting figures 18 months out to decimal places
**Avoid**: Acknowledge uncertainty, express as a range

### 5. Scenario overlap
**Problem**: Base/Bull/Bear partially overlap
**Avoid**: Clarify the boundary conditions of each scenario

---

## Probability Update Guidelines

Probability adjustment when new information arrives:

| Nature of new information | Direction of probability adjustment |
|---------------------------|-------------------------------------|
| Data supporting a scenario | +5-15% |
| Data contradicting a scenario | -5-15% |
| Decisive evidence | +20-30% or -20-30% |
| Emergence of a new risk factor | Bear Case +5-10% |
| Resolution of a risk factor | Bear Case -5-10% |

**After adjustment, always re-normalize to 100% total**

---

## Output Quality Standards

Characteristics of a high-quality scenario:
1. **Specificity**: not abstract; includes figures, dates, names
2. **Logic**: clear causality
3. **Verifiability**: correctness can be judged later
4. **Practicality**: includes information directly tied to investment decisions
5. **Humility**: appropriately expresses uncertainty
