# LLM-as-Judge Implementation Patterns

This reference provides detailed implementation patterns for building production-grade LLM evaluation systems.

## Pattern 1: Structured Evaluation Pipeline

The most reliable evaluation systems follow a structured pipeline that separates concerns:

```
Input Validation → Criteria Loading → Scoring → Bias Mitigation → Output Formatting
```

### Input Validation Layer

Before evaluation begins, validate:

1. **Response presence**: Non-empty response to evaluate
2. **Prompt presence**: Original prompt for context
3. **Criteria validity**: At least one criterion with name and description
4. **Weight normalization**: Weights sum to 1.0 (or normalize them)

```python
def validate_input(response, prompt, criteria):
    if not response or not response.strip():
        raise ValueError("Response cannot be empty")
    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty")
    if not criteria or len(criteria) == 0:
        raise ValueError("At least one criterion required")
    
    # Normalize weights
    total_weight = sum(c.get('weight', 1) for c in criteria)
    for c in criteria:
        c['weight'] = c.get('weight', 1) / total_weight
```

### Criteria Loading Layer

Criteria should be loaded from configuration, not hardcoded:

```python
class CriteriaLoader:
    def __init__(self, rubric_path=None):
        self.rubrics = self._load_rubrics(rubric_path)
    
    def get_criteria(self, task_type):
        return self.rubrics.get(task_type, self.default_criteria)
    
    def get_rubric(self, criterion_name):
        return self.rubrics.get(criterion_name, {}).get('levels', [])
```

### Scoring Layer

The scoring layer handles the actual LLM call:

```python
async def score_response(response, prompt, criteria, rubric, model):
    system_prompt = build_system_prompt(criteria, rubric)
    user_prompt = build_user_prompt(response, prompt, criteria)
    
    result = await generate_text(
        model=model,
        system=system_prompt,
        prompt=user_prompt,
        temperature=0.3  # Lower temperature for consistency
    )
    
    return parse_scores(result.text)
```

### Bias Mitigation Layer

For pairwise comparison, always include position swapping:

```python
async def compare_with_bias_mitigation(response_a, response_b, prompt, criteria, model):
    # First pass: A first
    pass1 = await compare_pair(response_a, response_b, prompt, criteria, model)
    
    # Second pass: B first
    pass2 = await compare_pair(response_b, response_a, prompt, criteria, model)
    
    # Map pass2 winner back
    pass2_mapped = map_winner(pass2.winner)  # A→B, B→A, TIE→TIE
    
    # Check consistency
    if pass1.winner == pass2_mapped:
        return {
            'winner': pass1.winner,
            'confidence': (pass1.confidence + pass2.confidence) / 2,
            'consistent': True
        }
    else:
        return {
            'winner': 'TIE',
            'confidence': 0.5,
            'consistent': False
        }
```

## Pattern 2: Hierarchical Evaluation

For complex evaluations, use a hierarchical approach:

```
Quick Screen (cheap model) → Detailed Evaluation (expensive model) → Human Review (edge cases)
```

### Quick Screen Implementation

```python
async def quick_screen(response, prompt, threshold=0.7):
    """Fast, cheap screening for obvious passes/fails."""
    result = await generate_text(
        model='gpt-5.2',  # Cheaper model
        prompt=f"Rate 0-1 if this response adequately addresses the prompt:\n\nPrompt: {prompt}\n\nResponse: {response}",
        temperature=0
    )
    score = float(result.text.strip())
    return score, score > threshold
```

### Detailed Evaluation

```python
async def detailed_evaluation(response, prompt, criteria):
    """Full evaluation for borderline or important cases."""
    result = await generate_text(
        model='gpt-5.2',  # More capable model
        system=DETAILED_EVALUATION_PROMPT,
        prompt=build_detailed_prompt(response, prompt, criteria),
        temperature=0.3
    )
    return parse_detailed_scores(result.text)
```

## Pattern 3: Panel of LLM Judges (PoLL)

For high-stakes evaluation, use multiple models:

```python
async def poll_evaluation(response, prompt, criteria, models):
    """Aggregate judgments from multiple LLM judges."""
    results = await asyncio.gather(*[
        score_with_model(response, prompt, criteria, model)
        for model in models
    ])
    
    # Aggregate scores
    aggregated = aggregate_scores(results)
    
    # Calculate agreement
    agreement = calculate_agreement(results)
    
    return {
        'scores': aggregated,
        'agreement': agreement,
        'individual_results': results
    }

def aggregate_scores(results):
    """Aggregate scores using median (robust to outliers)."""
    scores = {}
    for criterion in results[0]['scores'].keys():
        criterion_scores = [r['scores'][criterion] for r in results]
        scores[criterion] = {
            'score': statistics.median(criterion_scores),
            'std': statistics.stdev(criterion_scores) if len(criterion_scores) > 1 else 0
        }
    return scores
```

## Pattern 4: Confidence Calibration

Confidence scores should be calibrated to actual reliability:

```python
def calibrate_confidence(raw_confidence, position_consistent, evidence_count):
    """Calibrate confidence based on multiple signals."""
    
    # Base confidence from model output
    calibrated = raw_confidence
    
    # Position consistency is a strong signal
    if not position_consistent:
        calibrated *= 0.6  # Significant reduction
    
    # More evidence = higher confidence
    evidence_factor = min(evidence_count / 3, 1.0)  # Cap at 3 pieces
    calibrated *= (0.7 + 0.3 * evidence_factor)
    
    return min(calibrated, 0.99)  # Never 100% confident
```

## Pattern 5: Output Formatting

Always return structured outputs with consistent schemas:

```python
@dataclass
class ScoreResult:
    criterion: str
    score: float
    max_score: float
    justification: str
    evidence: List[str]
    improvement: str

@dataclass
class EvaluationResult:
    success: bool
    scores: List[ScoreResult]
    overall_score: float
    weighted_score: float
    summary: Dict[str, Any]
    metadata: Dict[str, Any]

def format_output(scores, metadata) -> EvaluationResult:
    """Format evaluation results consistently."""
    return EvaluationResult(
        success=True,
        scores=scores,
        overall_score=sum(s.score for s in scores) / len(scores),
        weighted_score=calculate_weighted_score(scores),
        summary=generate_summary(scores),
        metadata=metadata
    )
```

## Error Handling Patterns

### Graceful Degradation

```python
async def evaluate_with_fallback(response, prompt, criteria):
    try:
        return await full_evaluation(response, prompt, criteria)
    except RateLimitError:
        # Fall back to simpler evaluation
        return await simple_evaluation(response, prompt, criteria)
    except ParseError as e:
        # Return partial results with error flag
        return {
            'success': False,
            'partial_results': e.partial_data,
            'error': str(e)
        }
```

### Retry Logic

```python
async def evaluate_with_retry(response, prompt, criteria, max_retries=3):
    for attempt in range(max_retries):
        try:
            result = await evaluate(response, prompt, criteria)
            if is_valid_result(result):
                return result
        except TransientError:
            await asyncio.sleep(2 ** attempt)  # Exponential backoff
    
    raise EvaluationError("Max retries exceeded")
```

## Testing Patterns

### Unit Tests for Parsing

```python
def test_score_parsing():
    raw_output = '{"scores": [{"criterion": "Accuracy", "score": 4}]}'
    result = parse_scores(raw_output)
    assert result.scores[0].criterion == "Accuracy"
    assert result.scores[0].score == 4

def test_malformed_output():
    raw_output = 'Invalid JSON'
    with pytest.raises(ParseError):
        parse_scores(raw_output)
```

### Integration Tests with Real API

```python
@pytest.mark.integration
async def test_full_evaluation_pipeline():
    result = await evaluate(
        response="Water boils at 100°C at sea level.",
        prompt="At what temperature does water boil?",
        criteria=[{"name": "Accuracy", "description": "Factual correctness", "weight": 1}]
    )
    
    assert result.success
    assert len(result.scores) == 1
    assert result.scores[0].score >= 4  # Should score high for accurate response
```

### Bias Detection Tests

```python
async def test_position_bias_mitigation():
    # Same response in both positions should tie
    result = await compare(
        response_a="Same response",
        response_b="Same response",
        prompt="Test prompt",
        criteria=["quality"],
        swap_positions=True
    )
    
    assert result.winner == "TIE"
    assert result.consistent == True
```

