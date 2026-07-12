# Pipeline Patterns for LLM Projects

This reference provides detailed patterns for structuring LLM processing pipelines. These patterns apply to batch processing, data analysis, content generation, and similar workloads.

## The Canonical Pipeline

```
acquire → prepare → process → parse → render
```

### Stage Characteristics

| Stage | Deterministic | Expensive | Parallelizable | Idempotent |
|-------|---------------|-----------|----------------|------------|
| Acquire | Yes | Low | Yes | Yes |
| Prepare | Yes | Low | Yes | Yes |
| Process | No | High | Yes | Yes (with caching) |
| Parse | Yes | Low | Yes | Yes |
| Render | Yes | Low | Partially | Yes |

The key insight: only the Process stage involves LLM calls. All other stages are deterministic transformations that can be debugged, tested, and iterated independently.

## File System State Management

### Directory Structure Pattern

```
project/
├── data/
│   └── {batch_id}/
│       └── {item_id}/
│           ├── raw.json         # Acquire output
│           ├── prompt.md        # Prepare output
│           ├── response.md      # Process output
│           └── parsed.json      # Parse output
├── output/
│   └── {batch_id}/
│       └── index.html           # Render output
└── config/
    └── prompts/
        └── template.md          # Prompt templates
```

### State Checking Pattern

```python
def needs_processing(item_dir: Path, stage: str) -> bool:
    """Check if an item needs processing for a given stage."""
    stage_outputs = {
        "acquire": ["raw.json"],
        "prepare": ["prompt.md"],
        "process": ["response.md"],
        "parse": ["parsed.json"],
    }
    
    for output_file in stage_outputs[stage]:
        if not (item_dir / output_file).exists():
            return True
    return False
```

### Clean/Retry Pattern

```python
def clean_from_stage(item_dir: Path, stage: str):
    """Remove outputs from stage and all downstream stages."""
    stage_order = ["acquire", "prepare", "process", "parse", "render"]
    stage_outputs = {
        "acquire": ["raw.json"],
        "prepare": ["prompt.md"],
        "process": ["response.md"],
        "parse": ["parsed.json"],
    }
    
    start_idx = stage_order.index(stage)
    for s in stage_order[start_idx:]:
        for output_file in stage_outputs.get(s, []):
            filepath = item_dir / output_file
            if filepath.exists():
                filepath.unlink()
```

## Parallel Execution Patterns

### ThreadPoolExecutor for LLM Calls

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def process_batch(items: list, max_workers: int = 10):
    """Process items in parallel with progress tracking."""
    results = []
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_item, item): item for item in items}
        
        for future in as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
                results.append((item, result, None))
            except Exception as e:
                results.append((item, None, str(e)))
    
    return results
```

### Batch Size Considerations

- **Small batches (1-10)**: Sequential processing is fine; overhead of parallelization not worth it
- **Medium batches (10-100)**: Parallelize with 5-15 workers depending on API rate limits
- **Large batches (100+)**: Consider chunking with checkpoints; implement resume capability

### Rate Limiting

```python
import time
from functools import wraps

def rate_limited(calls_per_second: float):
    """Decorator to rate limit function calls."""
    min_interval = 1.0 / calls_per_second
    last_call = [0.0]
    
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            elapsed = time.time() - last_call[0]
            if elapsed < min_interval:
                time.sleep(min_interval - elapsed)
            result = func(*args, **kwargs)
            last_call[0] = time.time()
            return result
        return wrapper
    return decorator
```

## Structured Output Patterns

### Prompt Template Structure

```markdown
[INSTRUCTION BLOCK]
Analyze the following content and provide your response in exactly this format.

[FORMAT SPECIFICATION]
## Section 1: Summary
[Your summary here - 2-3 sentences]

## Section 2: Analysis
- Point 1
- Point 2
- Point 3

## Section 3: Score
Rating: [1-10]
Confidence: [low/medium/high]

[FORMAT ENFORCEMENT]
Follow this format exactly because I will be parsing it programmatically.

---

[CONTENT BLOCK]
# Title: {title}

## Content
{content}

## Additional Context
{context}
```

### Parsing Patterns

**Section Extraction**

```python
import re

def extract_section(text: str, section_name: str) -> str | None:
    """Extract content between section headers."""
    # Match section header with optional markdown formatting
    pattern = rf'(?:^|\n)(?:#+ *)?{re.escape(section_name)}[:\s]*\n(.*?)(?=\n(?:#+ |\Z))'
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else None
```

**Structured Field Extraction**

```python
def extract_field(text: str, field_name: str) -> str | None:
    """Extract value after field label."""
    # Handle: "Field: value" or "Field - value" or "**Field**: value"
    pattern = rf'(?:\*\*)?{re.escape(field_name)}(?:\*\*)?[\s:\-]+([^\n]+)'
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1).strip() if match else None
```

**List Extraction**

```python
def extract_list_items(text: str, section_name: str) -> list[str]:
    """Extract bullet points from a section."""
    section = extract_section(text, section_name)
    if not section:
        return []
    
    # Match lines starting with -, *, or numbered
    items = re.findall(r'^[\-\*\d\.]+\s*(.+)$', section, re.MULTILINE)
    return [item.strip() for item in items]
```

**Score Extraction with Validation**

```python
def extract_score(text: str, field_name: str, min_val: int, max_val: int) -> int | None:
    """Extract and validate numeric score."""
    raw = extract_field(text, field_name)
    if not raw:
        return None
    
    # Extract first number from the value
    match = re.search(r'\d+', raw)
    if not match:
        return None
    
    score = int(match.group())
    return max(min_val, min(max_val, score))  # Clamp to valid range
```

### Graceful Degradation

```python
@dataclass
class ParseResult:
    summary: str = ""
    score: int | None = None
    items: list[str] = field(default_factory=list)
    parse_errors: list[str] = field(default_factory=list)

def parse_response(text: str) -> ParseResult:
    """Parse LLM response with graceful error handling."""
    result = ParseResult()
    
    # Try each field, log errors but continue
    try:
        result.summary = extract_section(text, "Summary") or ""
    except Exception as e:
        result.parse_errors.append(f"Summary extraction failed: {e}")
    
    try:
        result.score = extract_score(text, "Rating", 1, 10)
    except Exception as e:
        result.parse_errors.append(f"Score extraction failed: {e}")
    
    try:
        result.items = extract_list_items(text, "Analysis")
    except Exception as e:
        result.parse_errors.append(f"Items extraction failed: {e}")
    
    return result
```

## Error Handling Patterns

### Retry with Exponential Backoff

```python
import time
from functools import wraps

def retry_with_backoff(max_retries: int = 3, base_delay: float = 1.0):
    """Retry decorator with exponential backoff."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_retries - 1:
                        delay = base_delay * (2 ** attempt)
                        time.sleep(delay)
            raise last_exception
        return wrapper
    return decorator
```

### Error Logging Pattern

```python
import json
from datetime import datetime

def log_error(item_dir: Path, stage: str, error: str, context: dict = None):
    """Log error to file for later analysis."""
    error_file = item_dir / "errors.jsonl"
    
    error_record = {
        "timestamp": datetime.now().isoformat(),
        "stage": stage,
        "error": error,
        "context": context or {},
    }
    
    with open(error_file, "a") as f:
        f.write(json.dumps(error_record) + "\n")
```

### Partial Success Handling

```python
def process_batch_with_partial_success(items: list) -> tuple[list, list]:
    """Process batch, separating successes from failures."""
    successes = []
    failures = []
    
    for item in items:
        try:
            result = process_item(item)
            successes.append((item, result))
        except Exception as e:
            failures.append((item, str(e)))
            log_error(item.directory, "process", str(e))
    
    # Report summary
    print(f"Processed {len(items)} items: {len(successes)} succeeded, {len(failures)} failed")
    
    return successes, failures
```

## Cost Estimation Patterns

### Token Counting

```python
import tiktoken

def count_tokens(text: str, model: str = "gpt-4") -> int:
    """Count tokens for cost estimation."""
    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")
    
    return len(encoding.encode(text))

def estimate_cost(
    input_tokens: int,
    output_tokens: int,
    input_price_per_mtok: float,
    output_price_per_mtok: float,
) -> float:
    """Estimate cost in dollars."""
    input_cost = (input_tokens / 1_000_000) * input_price_per_mtok
    output_cost = (output_tokens / 1_000_000) * output_price_per_mtok
    return input_cost + output_cost
```

### Batch Cost Estimation

```python
def estimate_batch_cost(
    items: list,
    prompt_template: str,
    avg_output_tokens: int = 1000,
    model_pricing: dict = None,
) -> dict:
    """Estimate total cost for a batch."""
    model_pricing = model_pricing or {
        "input_price_per_mtok": 3.00,   # Example: GPT-4 Turbo input
        "output_price_per_mtok": 15.00,  # Example: GPT-4 Turbo output
    }
    
    total_input_tokens = 0
    for item in items:
        prompt = format_prompt(prompt_template, item)
        total_input_tokens += count_tokens(prompt)
    
    total_output_tokens = len(items) * avg_output_tokens
    
    estimated_cost = estimate_cost(
        total_input_tokens,
        total_output_tokens,
        **model_pricing,
    )
    
    return {
        "item_count": len(items),
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "estimated_cost_usd": estimated_cost,
        "avg_input_tokens_per_item": total_input_tokens / len(items),
        "cost_per_item_usd": estimated_cost / len(items),
    }
```

## CLI Pattern

### Standard CLI Structure

```python
import argparse
from datetime import date

def main():
    parser = argparse.ArgumentParser(description="LLM Processing Pipeline")
    
    parser.add_argument(
        "stage",
        choices=["acquire", "prepare", "process", "parse", "render", "all", "clean"],
        help="Pipeline stage to run",
    )
    parser.add_argument(
        "--batch-id",
        default=None,
        help="Batch identifier (default: today's date)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of items (for testing)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=10,
        help="Number of parallel workers for processing",
    )
    parser.add_argument(
        "--model",
        default="gpt-4-turbo",
        help="Model to use for processing",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Estimate costs without processing",
    )
    parser.add_argument(
        "--clean-stage",
        choices=["acquire", "prepare", "process", "parse"],
        help="For clean: only clean this stage and downstream",
    )
    
    args = parser.parse_args()
    
    batch_id = args.batch_id or date.today().isoformat()
    
    if args.stage == "clean":
        stage_clean(batch_id, args.clean_stage)
    elif args.dry_run:
        estimate_costs(batch_id, args.limit)
    else:
        run_pipeline(batch_id, args.stage, args.limit, args.workers, args.model)

if __name__ == "__main__":
    main()
```

## Rendering Patterns

### Static HTML Output

```python
import html
import json

def render_html(data: list[dict], output_path: Path, template: str):
    """Render data to static HTML file."""
    # Escape data for JavaScript embedding
    data_json = json.dumps([
        {k: html.escape(str(v)) if isinstance(v, str) else v 
         for k, v in item.items()}
        for item in data
    ])
    
    html_content = template.replace("{{DATA_JSON}}", data_json)
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(html_content)
```

### Incremental Output

```python
def render_incremental(items: list, output_dir: Path):
    """Render each item as it completes, plus index."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Render individual item pages
    for item in items:
        item_html = render_item(item)
        item_path = output_dir / f"{item.id}.html"
        with open(item_path, "w") as f:
            f.write(item_html)
    
    # Render index linking to all items
    index_html = render_index(items)
    with open(output_dir / "index.html", "w") as f:
        f.write(index_html)
```

## Checkpoint and Resume Pattern

For long-running pipelines:

```python
import json
from pathlib import Path

class PipelineCheckpoint:
    def __init__(self, checkpoint_file: Path):
        self.checkpoint_file = checkpoint_file
        self.state = self._load()
    
    def _load(self) -> dict:
        if self.checkpoint_file.exists():
            with open(self.checkpoint_file) as f:
                return json.load(f)
        return {"completed": [], "failed": [], "last_item": None}
    
    def save(self):
        with open(self.checkpoint_file, "w") as f:
            json.dump(self.state, f, indent=2)
    
    def mark_complete(self, item_id: str):
        self.state["completed"].append(item_id)
        self.state["last_item"] = item_id
        self.save()
    
    def mark_failed(self, item_id: str, error: str):
        self.state["failed"].append({"id": item_id, "error": error})
        self.save()
    
    def get_remaining(self, all_items: list[str]) -> list[str]:
        completed = set(self.state["completed"])
        return [item for item in all_items if item not in completed]
```

## Testing Patterns

### Stage Unit Tests

```python
def test_prepare_stage():
    """Test prompt generation independently."""
    test_item = {"id": "test", "content": "Sample content"}
    prompt = prepare_prompt(test_item)
    
    assert "Sample content" in prompt
    assert "## Section 1" in prompt  # Format markers present

def test_parse_stage():
    """Test parsing with known good output."""
    test_response = """
    ## Summary
    This is a test summary.
    
    ## Score
    Rating: 7
    """
    
    result = parse_response(test_response)
    assert result.summary == "This is a test summary."
    assert result.score == 7

def test_parse_stage_malformed():
    """Test parsing handles malformed output."""
    test_response = "Some random text without sections"
    
    result = parse_response(test_response)
    assert result.summary == ""
    assert result.score is None
    assert len(result.parse_errors) > 0
```

### Integration Test Pattern

```python
def test_pipeline_end_to_end():
    """Test full pipeline with single item."""
    test_dir = Path("test_data")
    test_item = create_test_item()
    
    try:
        # Run each stage
        acquire_result = stage_acquire(test_dir, [test_item])
        assert (test_dir / test_item.id / "raw.json").exists()
        
        prepare_result = stage_prepare(test_dir)
        assert (test_dir / test_item.id / "prompt.md").exists()
        
        # Skip process stage in unit tests (costs money)
        # Create mock response instead
        mock_response(test_dir / test_item.id)
        
        parse_result = stage_parse(test_dir)
        assert (test_dir / test_item.id / "parsed.json").exists()
        
    finally:
        # Cleanup
        shutil.rmtree(test_dir, ignore_errors=True)
```

