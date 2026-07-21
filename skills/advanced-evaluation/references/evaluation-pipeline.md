# Evaluation Pipeline Diagram

Visual layout of a production evaluation pipeline.

```
┌─────────────────────────────────────────────────┐
│                 Evaluation Pipeline              │
├─────────────────────────────────────────────────┤
│                                                   │
│  Input: Response + Prompt + Context               │
│           │                                       │
│           ▼                                       │
│  ┌─────────────────────┐                         │
│  │   Criteria Loader   │ ◄── Rubrics, weights    │
│  └──────────┬──────────┘                         │
│             │                                     │
│             ▼                                     │
│  ┌─────────────────────┐                         │
│  │   Primary Scorer    │ ◄── Direct or Pairwise  │
│  └──────────┬──────────┘                         │
│             │                                     │
│             ▼                                     │
│  ┌─────────────────────┐                         │
│  │   Bias Mitigation   │ ◄── Position swap, etc. │
│  └──────────┬──────────┘                         │
│             │                                     │
│             ▼                                     │
│  ┌─────────────────────┐                         │
│  │ Confidence Scoring  │ ◄── Calibration         │
│  └──────────┬──────────┘                         │
│             │                                     │
│             ▼                                     │
│  Output: Scores + Justifications + Confidence     │
│                                                   │
└─────────────────────────────────────────────────┘
```

## Pipeline Stages

1. **Criteria Loader**: Loads rubrics and criterion weights from configuration
2. **Primary Scorer**: Applies direct scoring or pairwise comparison
3. **Bias Mitigation**: Runs position swaps, length normalization, and other debiasing
4. **Confidence Scoring**: Calibrates confidence based on position consistency and evidence strength
