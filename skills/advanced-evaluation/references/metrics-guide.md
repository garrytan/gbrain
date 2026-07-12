# Metric Selection Guide for LLM Evaluation

This reference provides guidance on selecting appropriate metrics for different evaluation scenarios.

## Metric Categories

### Classification Metrics

Use for binary or multi-class evaluation tasks (pass/fail, correct/incorrect).

#### Precision

```
Precision = True Positives / (True Positives + False Positives)
```

**Interpretation**: Of all responses the judge said were good, what fraction were actually good?

**Use when**: False positives are costly (e.g., approving unsafe content)

```python
def precision(predictions, ground_truth):
    true_positives = sum(1 for p, g in zip(predictions, ground_truth) if p == 1 and g == 1)
    predicted_positives = sum(predictions)
    return true_positives / predicted_positives if predicted_positives > 0 else 0
```

#### Recall

```
Recall = True Positives / (True Positives + False Negatives)
```

**Interpretation**: Of all actually good responses, what fraction did the judge identify?

**Use when**: False negatives are costly (e.g., missing good content in filtering)

```python
def recall(predictions, ground_truth):
    true_positives = sum(1 for p, g in zip(predictions, ground_truth) if p == 1 and g == 1)
    actual_positives = sum(ground_truth)
    return true_positives / actual_positives if actual_positives > 0 else 0
```

#### F1 Score

```
F1 = 2 * (Precision * Recall) / (Precision + Recall)
```

**Interpretation**: Harmonic mean of precision and recall

**Use when**: You need a single number balancing both concerns

```python
def f1_score(predictions, ground_truth):
    p = precision(predictions, ground_truth)
    r = recall(predictions, ground_truth)
    return 2 * p * r / (p + r) if (p + r) > 0 else 0
```

### Agreement Metrics

Use for comparing automated evaluation with human judgment.

#### Cohen's Kappa (κ)

```
κ = (Observed Agreement - Expected Agreement) / (1 - Expected Agreement)
```

**Interpretation**: Agreement adjusted for chance
- κ > 0.8: Almost perfect agreement
- κ 0.6-0.8: Substantial agreement
- κ 0.4-0.6: Moderate agreement
- κ < 0.4: Fair to poor agreement

**Use for**: Binary or categorical judgments

```python
def cohens_kappa(judge1, judge2):
    from sklearn.metrics import cohen_kappa_score
    return cohen_kappa_score(judge1, judge2)
```

#### Weighted Kappa

For ordinal scales where disagreement severity matters:

```python
def weighted_kappa(judge1, judge2):
    from sklearn.metrics import cohen_kappa_score
    return cohen_kappa_score(judge1, judge2, weights='quadratic')
```

**Interpretation**: Penalizes large disagreements more than small ones

### Correlation Metrics

Use for ordinal/continuous scores.

#### Spearman's Rank Correlation (ρ)

**Interpretation**: Correlation between rankings, not absolute values
- ρ > 0.9: Very strong correlation
- ρ 0.7-0.9: Strong correlation
- ρ 0.5-0.7: Moderate correlation
- ρ < 0.5: Weak correlation

**Use when**: Order matters more than exact values

```python
def spearmans_rho(scores1, scores2):
    from scipy.stats import spearmanr
    rho, p_value = spearmanr(scores1, scores2)
    return {'rho': rho, 'p_value': p_value}
```

#### Kendall's Tau (τ)

**Interpretation**: Similar to Spearman but based on pairwise concordance

**Use when**: You have many tied values

```python
def kendalls_tau(scores1, scores2):
    from scipy.stats import kendalltau
    tau, p_value = kendalltau(scores1, scores2)
    return {'tau': tau, 'p_value': p_value}
```

#### Pearson Correlation (r)

**Interpretation**: Linear correlation between scores

**Use when**: Exact score values matter, not just order

```python
def pearsons_r(scores1, scores2):
    from scipy.stats import pearsonr
    r, p_value = pearsonr(scores1, scores2)
    return {'r': r, 'p_value': p_value}
```

### Pairwise Comparison Metrics

#### Agreement Rate

```
Agreement = (Matching Decisions) / (Total Comparisons)
```

**Interpretation**: Simple percentage of agreement

```python
def pairwise_agreement(decisions1, decisions2):
    matches = sum(1 for d1, d2 in zip(decisions1, decisions2) if d1 == d2)
    return matches / len(decisions1)
```

#### Position Consistency

```
Consistency = (Consistent across position swaps) / (Total comparisons)
```

**Interpretation**: How often does swapping position change the decision?

```python
def position_consistency(results):
    consistent = sum(1 for r in results if r['position_consistent'])
    return consistent / len(results)
```

## Selection Decision Tree

```
What type of evaluation task?
│
├── Binary classification (pass/fail)
│   └── Use: Precision, Recall, F1, Cohen's κ
│
├── Ordinal scale (1-5 rating)
│   ├── Comparing to human judgments?
│   │   └── Use: Spearman's ρ, Weighted κ
│   └── Comparing two automated judges?
│       └── Use: Kendall's τ, Spearman's ρ
│
├── Pairwise preference
│   └── Use: Agreement rate, Position consistency
│
└── Multi-label classification
    └── Use: Macro-F1, Micro-F1, Per-label metrics
```

## Metric Selection by Use Case

### Use Case 1: Validating Automated Evaluation

**Goal**: Ensure automated evaluation correlates with human judgment

**Recommended Metrics**:
1. Primary: Spearman's ρ (for ordinal scales) or Cohen's κ (for categorical)
2. Secondary: Per-criterion agreement
3. Diagnostic: Confusion matrix for systematic errors

```python
def validate_automated_eval(automated_scores, human_scores, criteria):
    results = {}
    
    # Overall correlation
    results['overall_spearman'] = spearmans_rho(automated_scores, human_scores)
    
    # Per-criterion agreement
    for criterion in criteria:
        auto_crit = [s[criterion] for s in automated_scores]
        human_crit = [s[criterion] for s in human_scores]
        results[f'{criterion}_spearman'] = spearmans_rho(auto_crit, human_crit)
    
    return results
```

### Use Case 2: Comparing Two Models

**Goal**: Determine which model produces better outputs

**Recommended Metrics**:
1. Primary: Win rate (from pairwise comparison)
2. Secondary: Position consistency (bias check)
3. Diagnostic: Per-criterion breakdown

```python
def compare_models(model_a_outputs, model_b_outputs, prompts):
    results = []
    for a, b, p in zip(model_a_outputs, model_b_outputs, prompts):
        comparison = await compare_with_position_swap(a, b, p)
        results.append(comparison)
    
    return {
        'a_wins': sum(1 for r in results if r['winner'] == 'A'),
        'b_wins': sum(1 for r in results if r['winner'] == 'B'),
        'ties': sum(1 for r in results if r['winner'] == 'TIE'),
        'position_consistency': position_consistency(results)
    }
```

### Use Case 3: Quality Monitoring

**Goal**: Track evaluation quality over time

**Recommended Metrics**:
1. Primary: Rolling agreement with human spot-checks
2. Secondary: Score distribution stability
3. Diagnostic: Bias indicators (position, length)

```python
class QualityMonitor:
    def __init__(self, window_size=100):
        self.window = deque(maxlen=window_size)
    
    def add_evaluation(self, automated, human_spot_check=None):
        self.window.append({
            'automated': automated,
            'human': human_spot_check,
            'length': len(automated['response'])
        })
    
    def get_metrics(self):
        # Filter to evaluations with human spot-checks
        with_human = [e for e in self.window if e['human'] is not None]
        
        if len(with_human) < 10:
            return {'insufficient_data': True}
        
        auto_scores = [e['automated']['score'] for e in with_human]
        human_scores = [e['human']['score'] for e in with_human]
        
        return {
            'correlation': spearmans_rho(auto_scores, human_scores),
            'mean_difference': np.mean([a - h for a, h in zip(auto_scores, human_scores)]),
            'length_correlation': spearmans_rho(
                [e['length'] for e in self.window],
                [e['automated']['score'] for e in self.window]
            )
        }
```

## Interpreting Metric Results

### Good Evaluation System Indicators

| Metric | Good | Acceptable | Concerning |
|--------|------|------------|------------|
| Spearman's ρ | > 0.8 | 0.6-0.8 | < 0.6 |
| Cohen's κ | > 0.7 | 0.5-0.7 | < 0.5 |
| Position consistency | > 0.9 | 0.8-0.9 | < 0.8 |
| Length correlation | < 0.2 | 0.2-0.4 | > 0.4 |

### Warning Signs

1. **High agreement but low correlation**: May indicate calibration issues
2. **Low position consistency**: Position bias affecting results
3. **High length correlation**: Length bias inflating scores
4. **Per-criterion variance**: Some criteria may be poorly defined

## Reporting Template

```markdown
## Evaluation System Metrics Report

### Human Agreement
- Spearman's ρ: 0.82 (p < 0.001)
- Cohen's κ: 0.74
- Sample size: 500 evaluations

### Bias Indicators
- Position consistency: 91%
- Length-score correlation: 0.12

### Per-Criterion Performance
| Criterion | Spearman's ρ | κ |
|-----------|--------------|---|
| Accuracy | 0.88 | 0.79 |
| Clarity | 0.76 | 0.68 |
| Completeness | 0.81 | 0.72 |

### Recommendations
- All metrics within acceptable ranges
- Monitor "Clarity" criterion - lower agreement may indicate need for rubric refinement
```

