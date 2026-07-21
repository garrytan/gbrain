# Case Studies: LLM Project Development

This reference contains detailed case studies of production LLM projects that demonstrate effective development methodology. Each case study analyzes the problem, approach, architecture, and lessons learned.

## Case Study 1: Karpathy's HN Time Capsule

**Source**: https://github.com/karpathy/hn-time-capsule

### Problem Statement

Analyze Hacker News discussions from 10 years ago and grade commenters on how prescient their predictions were with the benefit of hindsight.

### Task-Model Fit Analysis

This task is well-suited for LLM processing because:

| Factor | Assessment |
|--------|------------|
| Synthesis | Combining article content + multiple comment threads |
| Subjective judgment | Grading predictions against known outcomes |
| Domain knowledge | Model has knowledge of what actually happened |
| Error tolerance | Wrong grade on one comment does not break the system |
| Batch processing | Each article is independent |
| Natural language output | Human-readable analysis is the goal |

### Development Methodology

**Step 1: Manual Prototype**

Before building any automation, Karpathy copy-pasted one article + comment thread into ChatGPT to validate the approach. This took minutes and confirmed:
- The model could produce insightful hindsight analysis
- The output format worked for the intended use case
- The quality exceeded what he could do manually

**Step 2: Agent-Assisted Implementation**

Used Opus 4.5 to build the pipeline in approximately 3 hours. The agent handled:
- HTML parsing for HN frontpage
- Algolia API integration for comments
- Prompt template design
- Output parsing logic
- Static HTML rendering

**Step 3: Batch Execution**

- 930 LLM queries (31 days × 30 articles)
- 15 parallel workers
- ~$58 total cost
- ~1 hour execution time

### Pipeline Architecture

```
fetch → prompt → analyze → parse → render
```

**Stage 1: Fetch**
- Download HN frontpage for target date
- Fetch article content via HTTP
- Fetch comments via Algolia API
- Output: `data/{date}/{item_id}/meta.json`, `article.txt`, `comments.json`

**Stage 2: Prompt**
- Load article metadata and content
- Load comment tree
- Generate markdown prompt from template
- Output: `data/{date}/{item_id}/prompt.md`

**Stage 3: Analyze**
- Submit prompt to GPT 5.1 Thinking API
- Parallel execution with ThreadPoolExecutor
- Output: `data/{date}/{item_id}/response.md`

**Stage 4: Parse**
- Extract grades from "Final grades" section via regex
- Extract interestingness score via regex
- Aggregate grades across all articles
- Output: `data/{date}/{item_id}/grades.json`, `score.json`

**Stage 5: Render**
- Generate static HTML with embedded JavaScript
- Create day pages with article navigation
- Create Hall of Fame with aggregated rankings
- Output: `output/{date}/index.html`, `output/hall-of-fame.html`

### Structured Output Design

The prompt template specifies exact output format:

```
Let's use our benefit of hindsight now in 6 sections:

1. Give a brief summary of the article and the discussion thread.
2. What ended up happening to this topic?
3. Give out awards for "Most prescient" and "Most wrong" comments.
4. Mention any other fun or notable aspects.
5. Give out grades to specific people for their comments.
6. At the end, give a final score (from 0-10).

As for the format of Section 5, use the header "Final grades" and follow it 
with simply an unordered list in the format of "name: grade (optional comment)".

Please follow the format exactly because I will be parsing it programmatically.
```

Key techniques:
- Numbered sections for structure
- Explicit format specification with examples
- Rationale disclosure ("because I will be parsing it")
- Constrained output (letter grades, 0-10 scores)

### Parsing Implementation

The parsing code handles variations gracefully:

```python
def parse_grades(text: str) -> dict[str, dict]:
    # Match "Final grades" with optional section number or markdown
    pattern = r'(?:^|\n)(?:\d+[\.\)]\s*)?(?:#+ *)?Final grades\s*\n'
    match = re.search(pattern, text, re.IGNORECASE)
    
    # Handle both ASCII and Unicode minus signs
    line_pattern = r'^[\-\*]\s*([^:]+):\s*([A-F][+\-−]?)(?:\s*\(([^)]+)\))?'
```

### Lessons Learned

1. **Manual validation first**: The 5-minute copy-paste test prevented hours of wasted development.

2. **File system as state**: Each article directory contains all intermediate outputs, making debugging trivial.

3. **Idempotent stages**: Re-running only processes items that lack output files.

4. **Agent-assisted development**: 3 hours to working code by focusing on requirements, not implementation details.

5. **Parallel execution**: 15 workers reduced execution time without increasing token costs.

---

## Case Study 2: Vercel d0 Architectural Reduction

**Source**: https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools

### Problem Statement

Build a text-to-SQL agent that enables anyone at Vercel to query analytics data through natural language questions in Slack.

### Initial Approach (Failed)

The team built a sophisticated system with:
- 17 specialized tools (schema lookup, query validation, error recovery, etc.)
- Heavy prompt engineering to constrain reasoning
- Careful context management
- Hand-coded retrieval for schema information

**Results**:
- 80% success rate
- 274.8 seconds average execution time
- ~102k tokens average usage
- ~12 steps average
- Constant maintenance burden

### The Problem

The team was solving problems the model could handle on its own:
- Pre-filtering context
- Constraining options
- Wrapping every interaction in validation logic
- Building tools to "protect" the model from complexity

Every edge case required another patch. Every model update required re-calibrating constraints. More time was spent maintaining scaffolding than improving outcomes.

### Architectural Reduction

The hypothesis: What if we just give Claude access to the raw files and let it figure things out?

**New architecture**:
- 2 tools total: ExecuteCommand (bash) + ExecuteSQL
- Direct file system access via sandbox
- Semantic layer as YAML/Markdown/JSON files
- Standard Unix utilities (grep, cat, find, ls)

```javascript
const agent = new ToolLoopAgent({
  model: "anthropic/claude-opus-4.5",
  tools: {
    ExecuteCommand: executeCommandTool(sandbox),
    ExecuteSQL,
  },
});
```

### Results

| Metric | Before (17 tools) | After (2 tools) | Change |
|--------|-------------------|-----------------|--------|
| Avg execution time | 274.8s | 77.4s | 3.5x faster |
| Success rate | 80% | 100% | +20% |
| Avg token usage | ~102k | ~61k | 37% fewer |
| Avg steps | ~12 | ~7 | 42% fewer |

The worst case before: 724 seconds, 100 steps, 145k tokens, and still failed.
Same query after: 141 seconds, 19 steps, 67k tokens, succeeded.

### Why It Worked

1. **Good documentation already existed**: The semantic layer files contained dimension definitions, measure calculations, and join relationships. The tools were summarizing what was already legible.

2. **File systems are proven abstractions**: The model understands file systems deeply from training. grep is 50 years old and works perfectly.

3. **Constraints became liabilities**: With better models, the guardrails were limiting performance more than helping.

### Key Lessons

1. **Addition by subtraction**: The best agents might be ones with the fewest tools. Every tool is a choice you are making for the model.

2. **Build for future models**: Models improve faster than tooling. Architectures optimized for today may be over-constrained for tomorrow.

3. **Good context over clever tools**: Invest in documentation, clear naming, and well-structured data. That foundation matters more than sophisticated tooling.

4. **Start simple**: Model + file system + goal. Add complexity only when proven necessary.

---

## Case Study 3: Manus Context Engineering

**Source**: Peak Ji's blog "Context Engineering for AI Agents: Lessons from Building Manus"

### Problem Statement

Build a general-purpose consumer agent that can accomplish complex tasks across 50+ tool calls while maintaining performance and managing costs.

### Core Insight

KV-cache hit rate is the single most important metric for production agents. It directly affects both latency and cost.

- Claude Sonnet cached: $0.30/MTok
- Claude Sonnet uncached: $3.00/MTok
- 10x cost difference

With an average input-to-output ratio of 100:1 in agentic workloads, optimizing for cache hits dominates the cost equation.

### Key Patterns

**1. Append-Only Context**

Never modify previous actions or observations. Ensure deterministic serialization (JSON key ordering must be stable). A single token difference invalidates the cache from that point forward.

Common mistake: Including a timestamp at the beginning of the system prompt kills cache hit rate entirely.

**2. Mask, Do Not Remove**

Do not dynamically add or remove tools mid-iteration. Tool definitions live near the front of context - any change invalidates the KV-cache for all subsequent content.

Instead, use logit masking during decoding to constrain tool selection without modifying definitions. This maintains cache while still controlling behavior.

**3. File System as Context**

Treat the file system as unlimited, persistent, agent-operable memory. The model learns to write and read files on demand.

Compression strategies should be restorable:
- Web page content can be dropped if URL is preserved
- Document contents can be omitted if file path remains available

**4. Recitation for Attention**

Manus creates a todo.md file and updates it step-by-step. This is not just organization - it pushes the global plan into the model's recent attention span.

By constantly rewriting objectives at the end of context, the agent avoids "lost in the middle" issues and maintains goal alignment.

**5. Keep Errors In Context**

Do not hide failures. When the model sees a failed action and the resulting error, it implicitly updates beliefs and avoids repeating mistakes.

Erasing failures removes evidence the model needs to adapt.

### Multi-Agent for Context Isolation

The primary goal of sub-agents in Manus is context isolation, not role division. For tasks requiring discrete work:
- Planner assigns tasks to sub-agents with their own context windows
- Simple tasks: pass instructions via function call
- Complex tasks: share full context with sub-agent

Sub-agents have a submit_results tool with constrained output schema. Constrained decoding ensures adherence to defined format.

### Layered Action Space

Rather than binding every utility as a tool:
- Small set (<20) of atomic functions: Bash, filesystem access, code execution
- Most actions offload to sandbox layer
- MCP tools exposed through CLI, executed via Bash tool

This reduces tool definition tokens and prevents model confusion from overlapping descriptions.

### Iteration Expectation

Manus has refactored their agent framework five times since launch. The Bitter Lesson suggests structures added for current limitations become constraints as models improve.

Test across model strengths to verify your harness is not limiting performance. Simple, unopinionated designs adapt better to model improvements.

---

## Case Study 4: Anthropic Multi-Agent Research

**Source**: Anthropic blog "How we built our multi-agent research system"

### Problem Statement

Build a research feature that can explore complex topics using multiple parallel agents searching across web, Google Workspace, and integrations.

### Architecture

Orchestrator-worker pattern:
- Lead agent analyzes query and develops strategy
- Lead spawns subagents for parallel exploration
- Subagents return findings to lead for synthesis
- Citation agent processes final output

### Performance Insight

Three factors explained 95% of performance variance in BrowseComp evaluation:
- Token usage: 80% of variance
- Number of tool calls: additional factor
- Model choice: additional factor

Multi-agent architectures effectively scale token usage for tasks exceeding single-agent limits.

### Token Economics

- Chat interactions: baseline
- Single agent: ~4x more tokens than chat
- Multi-agent: ~15x more tokens than chat

Multi-agent requires high-value tasks to justify the cost.

### Prompting Principles

1. **Think like your agents**: Build simulations, watch step-by-step, identify failure modes.

2. **Teach delegation**: Subagents need objective, output format, tools/sources guidance, and clear boundaries.

3. **Scale effort to complexity**: Explicit guidelines for agent/tool call counts by task type.

4. **Tool design is critical**: Distinct purpose and clear description for each tool. Bad descriptions send agents down wrong paths entirely.

5. **Let agents improve themselves**: Claude 4 models can diagnose prompt failures and suggest improvements. Tool-testing agents can rewrite tool descriptions to avoid common mistakes.

6. **Start wide, then narrow**: Broad queries first, evaluate landscape, then drill into specifics.

7. **Guide thinking process**: Extended thinking mode as controllable scratchpad for planning.

8. **Parallel tool calling**: 3-5 subagents in parallel, 3+ tools per subagent in parallel. Cut research time by up to 90%.

### Evaluation Approach

- Start with ~20 representative queries immediately
- LLM-as-judge with rubric: factual accuracy, citation accuracy, completeness, source quality, tool efficiency
- Human evaluation catches edge cases automation misses
- Focus on end-state evaluation for multi-turn agents

---

## Cross-Case Patterns

### Common Success Factors

1. **Manual validation before automation**: All successful projects validated task-model fit with simple tests first.

2. **File system as foundation**: Whether for state management (Karpathy), tool interface (Vercel), or memory (Manus), the file system provides proven abstractions.

3. **Architectural simplicity**: Reduction outperformed complexity in multiple cases. Start minimal, add only what proves necessary.

4. **Structured outputs with robust parsing**: Explicit format specifications combined with flexible parsing that handles variations.

5. **Iteration expectation**: No project got architecture right on the first try. Build for change.

### Common Failure Patterns

1. **Over-constraining models**: Guardrails that helped with weaker models become liabilities as capabilities improve.

2. **Tool proliferation**: More tools often means more confusion and worse performance.

3. **Hiding errors**: Removing failures from context prevents models from learning.

4. **Premature optimization**: Adding complexity before basic functionality works.

5. **Ignoring economics**: Token costs compound quickly; estimation and tracking are essential.

