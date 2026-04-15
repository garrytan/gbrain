# RFC: Technical Knowledge Map — Cross-Codebase Navigation Layer for GBrain

**Status:** Proposed  
**Date:** 2026-04-15  
**Decision type:** Product + architecture

---

## 1. Summary

GBrain should support a **technical knowledge map** layer that serves as a persistent, pre-computed navigation index for large, multi-repository engineering environments.

In this mode:

- **concept pages** evolve from flat notes into **structured maps** that track how a single concept manifests across multiple codebases, layers, and systems
- a new **`system`** page type captures codebase-level architecture summaries (entry points, key abstractions, build commands, directory structure)
- new **link types** express technical relationships: `depends_on`, `implements`, `contradicts`, `extends`, `layer_of`
- a new **`codemap`** frontmatter field on concept pages records per-codebase pointers (file paths, function names, module names) that the AI agent checks and updates incrementally
- the **brain-first lookup rule** extends to technical queries: before grep/read on a 100K-line codebase, consult the brain for orientation

The result is a **"map before territory"** workflow: the AI agent reads a 500-token brain page to orient itself, then reads only the 2,000 tokens of source code that actually matter — instead of scanning 12,000+ tokens of unfamiliar code from scratch every session.

---

## 2. Motivation

### 2.1 The Problem: Cold-Start Codebase Navigation

AI coding agents (Claude Code, Codex, Copilot) are stateless per session. When a user asks "how does concept X work across systems A, B, and C?", the agent must:

1. Search codebase A for X → read 5,000+ tokens of source
2. Search codebase B for X → read 3,000+ tokens of source
3. Search codebase C for X → read 4,000+ tokens of source
4. Synthesize a cross-system answer

**Total: 12,000+ tokens consumed just for orientation**, and the synthesis is discarded at session end. The next session repeats the same work.

### 2.2 The Deeper Problem: Cross-System Understanding

Engineering concepts rarely live in one place. "Operator fusion" might be:

- **Decided** by a compiler (as an IR optimization pass in LLVM)
- **Triggered** by a framework (as a graph-level transformation in PyTorch Inductor)
- **Executed** by a runtime (as a fused CUDA kernel in TensorRT)

No single codebase search can reconstruct this cross-cutting picture. The agent must already know the concept spans three systems, know which files to look at in each, and know the vocabulary differences (LLVM calls it "instruction combining", PyTorch calls it "fusion group", TensorRT calls it "fused kernel").

### 2.3 What GBrain Already Does Well

GBrain is already a compounding knowledge system with:

- **Compiled truth + timeline** pattern (pre-computed synthesis, not raw RAG)
- **Graph links** between pages (typed, bidirectional)
- **Concept pages** that capture mental models
- **Hybrid search** (keyword + vector + RRF fusion)
- **Brain-first lookup** rule (check brain before external APIs)

The gap is that concept pages today are designed for **people/company/deal** knowledge ("who believes what"), not **technical system** knowledge ("what implements what, where, and how the pieces connect").

### 2.4 The Proposed Solution: Brain as Technical Map

Extend GBrain so that concept pages can serve as **navigation indexes** for technical knowledge:

```
User asks: "How does operator fusion work across PyTorch and LLVM?"

Without map:
  Agent: *searches 2 codebases, reads 12K tokens, synthesizes from scratch*

With map:
  Agent: gbrain get "concepts/operator-fusion"
  Brain returns:
    Compiled truth: "Operator fusion merges multiple operations into one kernel.
      - In LLVM: InstructionCombining pass merges adjacent ops in IR
        → see llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp
      - In PyTorch: Inductor's group_fusion.py identifies fusible subgraphs
        → see torch/_inductor/fx_passes/group_fusion.py
      - In TensorRT: builder merges layers during engine optimization
        → see NvInferRuntime.h, IBuilderConfig::setFlag(BuilderFlag::kFP16)
    Key insight: LLVM fuses at instruction level, PyTorch at graph level,
    TensorRT at layer level — three different granularities."
  
  Agent: *reads only the 3 specific files, verifies details, answers*
  → 2,500 tokens instead of 12,000
```

---

## 3. Problem Statement

GBrain's current concept system has the following limitations for technical knowledge:

1. **Flat concept pages** — no structured fields for codebase-specific pointers
2. **No system-level pages** — nowhere to store "codebase X has these entry points, this directory structure, these key abstractions"
3. **Limited link types** — `references`, `invested_in`, `works_at` are people/deal-oriented; no `depends_on`, `implements`, `layer_of`
4. **No staleness detection for code pointers** — a brain page might reference `src/foo.cc:bar()` that was renamed last week
5. **No cross-codebase vocabulary mapping** — the same concept has different names in different systems
6. **Agent rules don't trigger brain-first for code questions** — the brain-agent loop currently fires for entity mentions (people, companies), not for technical concept mentions

---

## 4. Goals

### 4.1 Primary goals

- Add a **`system`** page type for codebase-level architecture maps
- Extend **`concept`** pages with a structured **`codemap`** field for per-codebase pointers
- Add **technical link types**: `depends_on`, `implements`, `extends`, `contradicts`, `layer_of`, `vocabulary_alias`
- Define a **staleness protocol** for code pointers (verify on read, mark stale if file/function missing)
- Extend the **brain-agent loop** to trigger on technical concept mentions, not just people/company mentions
- Create an **ingest skill** for building system pages from codebase exploration

### 4.2 Quality goals

- **Zero new infrastructure** — works with existing SQLite and Postgres engines
- **Backward compatible** — existing concept/person/company pages unchanged
- **Incremental buildable** — system pages can be created one at a time, not all-or-nothing
- **Verifiable pointers** — code references include enough context to be grep-validated
- **Agent-maintainable** — the AI agent can update maps during normal coding sessions

### 4.3 Token economy targets

For a cross-codebase question spanning 3 repositories:

| Metric | Without map | With map | Improvement |
|--------|-------------|----------|-------------|
| Tokens to orient | 12,000+ | 2,500 | ~5x reduction |
| Sessions to build understanding | Every session | Once (then verify) | Amortized |
| Answer quality for cross-system Qs | Fragmented | Holistic | Qualitative improvement |

---

## 5. Non-goals

- **Replacing code search** — the map is orientation, not a substitute for grep/read
- **Auto-generating maps from ASTs** — maps are authored by agents with human review, not parsed from syntax trees
- **Real-time code sync** — pointers are verified lazily (on read), not via filesystem watchers
- **Supporting every programming language** — the system is language-agnostic; pointers are free-text paths
- **Building a full knowledge graph UI** — visualization is out of scope for v1; graph traversal via MCP tools is sufficient
- **Enforcing map completeness** — partial maps are useful; perfection is not required

---

## 6. User Scenarios

### Scenario A: Engineer Asks Cross-System Question

An engineer asks their AI agent: "How does automatic differentiation work across PyTorch and JAX?"

**Today:** Agent searches both codebases from scratch. Reads 50+ files. Spends 15K tokens. Produces a long answer that's mostly correct but may miss connections between the two systems.

**With knowledge map:** Agent calls `gbrain get "concepts/autograd"`. Gets a 400-token compiled truth with pointers to both codebases. Verifies 2 key files. Answers in 3K tokens with a clear cross-system picture and specific file references.

### Scenario B: New Team Member Onboarding

A new engineer joins and needs to understand the LLVM codebase.

**Today:** They ask the AI agent "explain the LLVM architecture." Agent reads README, scans directory tree, reads 10 random files. Produces a vague overview. Next session, it forgets everything.

**With knowledge map:** Agent calls `gbrain get "systems/llvm"`. Gets architecture summary, key entry points, pass pipeline structure, and build commands. Uses this as a starting point for targeted exploration. The knowledge persists and improves over time.

### Scenario C: Agent Builds Map Incrementally

During a normal coding session, the agent fixes a bug in PyTorch's memory allocator. While exploring the code, it discovers how the caching allocator interacts with CUDA streams.

**Today:** This understanding is lost at session end.

**With knowledge map:** The agent updates `concepts/cuda-memory-management` with the new code pointers and cross-references it discovers. Next session, any agent working on related code benefits from this accumulated knowledge.

### Scenario D: Stale Pointer Detection

A brain page says "see `torch/csrc/autograd/engine.cpp:Engine::execute()`" but that file was refactored in the latest PyTorch release.

**With staleness protocol:** When the agent tries to verify the pointer, it fails the grep check. The agent marks the pointer as `stale: true` in the codemap, searches for the new location, and updates the page. The map self-heals through normal use.

---

## 7. Design

### 7.1 New Page Type: `system`

A `system` page represents a **single codebase or major subsystem**. It is the entry point for an AI agent encountering that codebase for the first time.

```yaml
---
type: system
title: "PyTorch"
tags: [deep-learning, framework, python, cpp]
slug: "systems/pytorch"
repo: "https://github.com/pytorch/pytorch"
language: ["Python", "C++", "CUDA"]
build_command: "python setup.py develop"
test_command: "pytest test/ -x"
---

## Architecture Summary
PyTorch is a deep learning framework with a Python frontend and C++/CUDA
backend. The core abstraction is the Tensor — a multi-dimensional array
with automatic differentiation support. The codebase is organized into
a Python layer (torch/), a C++ core (aten/), an autograd engine
(torch/csrc/autograd/), and a JIT compiler (torch/csrc/jit/). [200-400 words]

## Key Entry Points
| Entry Point | Path | Purpose |
|-------------|------|---------|
| Tensor ops (Python) | `torch/_torch_docs.py` | Python-facing tensor API |
| ATen native functions | `aten/src/ATen/native/` | C++ kernel implementations |
| Autograd engine | `torch/csrc/autograd/engine.cpp` | Backward pass execution |
| Inductor compiler | `torch/_inductor/` | torch.compile graph compiler |
| Dispatcher | `aten/src/ATen/core/dispatch/` | Op routing (CPU/CUDA/autograd) |

## Component Map
- **torch/** — Python frontend, nn.Module, optim, data loaders
- **aten/** — C++ tensor library (ATen), native kernels
- **c10/** — Core abstractions (Tensor, Storage, Device, Stream)
- **torch/csrc/autograd/** — Autograd engine, Function, Node graph
- **torch/_inductor/** — Inductor compiler (torch.compile backend)
- **torch/distributed/** — Distributed training (DDP, FSDP, RPC)

## Key Abstractions
- **Tensor**: Multi-dim array with device, dtype, layout, requires_grad
- **Dispatcher**: Routes op calls to correct backend (CPU, CUDA, autograd, ...)
- **Autograd Node**: DAG node for backward computation graph
- **FX Graph**: Intermediate representation for torch.compile

## Build & Run
[build commands, typical invocation, debug flags]

---

## Timeline
- **2026-04-15** | System page created from codebase exploration session
```

**Design decisions:**
- `repo`, `language`, `build_command`, `test_command` are first-class frontmatter fields (queryable)
- "Key Entry Points" table gives the agent grep-able file paths
- "Component Map" is a lightweight dependency catalog
- "Key Abstractions" captures the vocabulary needed to read this codebase

### 7.2 Extended Concept Pages: `codemap` Field

Concept pages gain an optional `codemap` field in frontmatter — a structured, per-system index of where the concept lives in code.

```yaml
---
type: concept
title: "Operator Fusion"
tags: [optimization, compilation, performance]
slug: "concepts/operator-fusion"
codemap:
  - system: "systems/llvm"
    pointers:
      - path: "llvm/lib/Transforms/InstCombine/InstructionCombining.cpp"
        symbol: "InstCombinerImpl::run()"
        role: "Combines adjacent IR instructions into fewer, equivalent ops"
        verified_at: "2026-04-15"
      - path: "llvm/lib/Transforms/Scalar/LoopFuse.cpp"
        symbol: "FusionCandidate"
        role: "Loop-level fusion pass — merges adjacent loop nests"
        verified_at: "2026-04-15"
    vocabulary: "instruction combining / loop fusion"
  - system: "systems/pytorch"
    pointers:
      - path: "torch/_inductor/fx_passes/group_fusion.py"
        symbol: "group_fusion_passes()"
        role: "Identifies fusible subgraph patterns in FX graph"
        verified_at: "2026-04-15"
      - path: "torch/_inductor/codegen/triton.py"
        symbol: "TritonKernel"
        role: "Code-generates a single Triton kernel from fused ops"
        verified_at: "2026-04-15"
    vocabulary: "fusion group / fused kernel"
  - system: "systems/tvm"
    pointers:
      - path: "src/relay/transforms/fuse_ops.cc"
        symbol: "FuseOps()"
        role: "Relay-level op fusion pass using dominator-tree analysis"
        verified_at: "2026-04-15"
    vocabulary: "fused function / FuseOps"
---

## Compiled Truth

Operator fusion merges multiple operations into a single kernel to reduce
memory bandwidth overhead and kernel launch costs. Different systems fuse
at different levels of granularity:

**Cross-system comparison:**
1. **LLVM** fuses at the instruction level (InstCombine) and loop level
   (LoopFuse). This is target-agnostic IR-to-IR transformation.
2. **PyTorch Inductor** fuses at the graph level — identifies subgraph
   patterns in FX IR, then code-generates a single Triton/C++ kernel.
3. **TVM** fuses at the Relay IR level using dominator-tree analysis to
   determine which ops can share memory without intermediate buffers.

**Key insight:** LLVM operates on scalar/vector instructions (low level),
PyTorch operates on tensor operations (high level), TVM sits in between.
They're solving the same problem at different abstraction layers.

**Vocabulary map:**
| System | Term | Granularity |
|--------|------|-------------|
| LLVM | instruction combining | IR instruction level |
| PyTorch Inductor | fusion group | Tensor op graph level |
| TVM Relay | fused function | Relay IR op level |

---

## Timeline
- **2026-04-15** | Mapped operator fusion across LLVM, PyTorch, and TVM.
  Key finding: all three use dominator analysis but at different IR levels.
  [Source: Code analysis session]
```

**Design decisions:**
- `codemap` is a structured YAML array, not free text — queryable and validatable
- Each entry has `system` (slug reference), `pointers` (file + symbol + role), and `vocabulary` (local term)
- `verified_at` enables staleness detection
- The compiled truth section synthesizes the cross-system picture in plain language
- The vocabulary table resolves naming differences explicitly

### 7.3 New Link Types

| Link Type | Direction | Example |
|-----------|-----------|---------|
| `depends_on` | A depends on B | `concepts/autograd` depends_on `concepts/tensor-storage` |
| `implements` | A implements B | `systems/pytorch` implements `concepts/operator-fusion` |
| `extends` | A extends B | `concepts/torch-compile` extends `concepts/operator-fusion` |
| `contradicts` | A contradicts B | `concepts/eager-execution` contradicts `concepts/graph-compilation` |
| `layer_of` | A is a layer of B | `systems/aten` layer_of `systems/pytorch` |
| `vocabulary_alias` | A is called B in context C | (stored in codemap, not as a separate link) |
| `prerequisite_for` | understand A before B | `concepts/computation-graph` prerequisite_for `concepts/autograd` |

These are stored in the existing `links` table using the `link_type` TEXT column. No schema change required.

### 7.4 Staleness Protocol

When an agent reads a concept page with codemap pointers, it SHOULD verify pointers that are relevant to the current task:

```
1. Read codemap pointer: { path: "src/foo.cc", symbol: "bar()", verified_at: "2026-03-01" }
2. If verified_at is older than 30 days OR the pointer is central to the current task:
   a. Grep for the symbol in the expected path
   b. If found → update verified_at to today
   c. If NOT found:
      i.  Grep broader (whole repo) for the symbol
      ii. If found at new path → update pointer, add timeline entry
      iii. If not found → mark pointer as stale: true, add timeline entry
3. Stale pointers are NOT deleted — they're evidence of what changed
```

**Implementation:** The `verified_at` field is in the codemap YAML. Updates go through normal `put_page` operations. No new MCP tools needed.

### 7.5 Brain-Agent Loop Extension

The current brain-agent rules say: "On EVERY inbound message, detect entities (people, companies, concepts)."

This RFC extends that to: "Also detect **technical concept mentions** and **system/codebase mentions**."

**Detection triggers:**
- User mentions a concept name that matches a brain page title/tag
- User mentions a codebase, repo, or system name
- User asks "how does X work" or "where is X implemented"
- User asks a cross-system question ("how does X in system A relate to Y in system B")

**Agent behavior on trigger:**
1. `gbrain search "concept name"` or `gbrain get "concepts/slug"`
2. If page exists with codemap → use pointers for targeted code navigation
3. If page exists without codemap → read code, then update page with discovered pointers
4. If no page exists → explore code, then create concept page with codemap

### 7.6 New Skill: `codemap-ingest`

A new skill file (`skills/codemap-ingest/`) that guides agents through building system and concept pages from codebase exploration.

**Workflow:**

```
1. EXPLORE: Agent reads README, directory structure, key source files
2. DRAFT: Agent creates a system page with architecture summary, entry points, component map
3. IDENTIFY: Agent identifies cross-cutting concepts from code comments, variable names, patterns
4. LINK: Agent creates concept pages with codemap pointers
5. CROSS-REFERENCE: Agent adds links between systems and concepts
6. VERIFY: Agent grep-validates all pointers
7. COMMIT: Agent calls put_page for each page, sync_brain to index
```

**Invocation:** The user can say "build a knowledge map for repo X" or the agent can trigger it during normal exploration when it discovers a new system.

---

## 8. Schema Changes

### 8.1 PageType Extension

```typescript
// src/core/types.ts
export type PageType =
  | 'person' | 'company' | 'deal' | 'yc' | 'civic'
  | 'project' | 'concept' | 'source' | 'media'
  | 'system';   // NEW
```

### 8.2 Codemap Type

```typescript
// src/core/types.ts (new)
export interface CodemapPointer {
  path: string;           // relative file path within the repo
  symbol?: string;        // function, class, variable name
  role: string;           // what this code does for the concept
  verified_at?: string;   // ISO date of last verification
  stale?: boolean;        // true if verification failed
}

export interface CodemapEntry {
  system: string;         // slug of the system page (e.g., "systems/pytorch")
  pointers: CodemapPointer[];
  vocabulary?: string;    // local term for the concept in this system
}
```

### 8.3 No Database Schema Changes

- `system` pages use the existing `pages` table (type = 'system')
- `codemap` is stored in the existing `frontmatter` JSONB/JSON column
- New link types use the existing `link_type` TEXT column
- No new tables, columns, or indexes required

### 8.4 Recommended Frontmatter Fields for `system` Pages

```typescript
// Stored in frontmatter JSONB, not as SQL columns
interface SystemFrontmatter {
  repo?: string;          // git remote URL
  language?: string[];    // primary languages
  build_command?: string; // how to build
  test_command?: string;  // how to test
  key_entry_points?: { name: string; path: string; purpose: string }[];
}
```

---

## 9. MCP Tool Changes

### 9.1 No New Tools Required

The existing tools are sufficient:

| Operation | Tool | Notes |
|-----------|------|-------|
| Create system page | `put_page` | type: 'system' in frontmatter |
| Create concept with codemap | `put_page` | codemap in frontmatter YAML |
| Link concept to system | `add_link` | link_type: 'implements' |
| Find related concepts | `traverse_graph` | depth: 2 from a system page |
| Search for concepts | `query` | "operator fusion" → concept page |
| Verify pointers | External | Agent uses grep/read, then `put_page` to update |

### 9.2 Optional Future Tool: `verify_codemap`

If codemap verification becomes a common operation, a dedicated tool could batch-verify all pointers in a page:

```typescript
// Future — not in v1
verify_codemap({
  slug: "concepts/operator-fusion",
  repo_paths: {
    "systems/llvm": "/home/user/llvm-project",
    "systems/pytorch": "/home/user/pytorch",
  }
})
// Returns: { verified: 5, stale: 1, updated: [...] }
```

This is a **non-goal for v1** but a natural evolution.

---

## 10. Skill Changes

### 10.1 New Skill: `skills/codemap-ingest/`

Guides agents through building system and concept pages. See Section 7.6.

### 10.2 Updated Skill: `skills/query/`

Add guidance for technical queries:

```markdown
## Technical Concept Queries

When the user asks about a technical concept (architecture, mechanism, 
pattern) that might span multiple systems:

1. Search brain: `gbrain search "concept name"`
2. If concept page exists with codemap:
   - Read the compiled truth for orientation
   - Use codemap pointers for targeted code navigation
   - Verify pointers if older than 30 days
3. If concept page exists without codemap:
   - Use compiled truth as starting orientation
   - After code exploration, update page with discovered pointers
4. If no concept page:
   - Explore code first
   - After understanding, create concept page with codemap
```

### 10.3 Updated: Agent Rules (GBRAIN_AGENT_RULES.md)

Add to Section 3 (Entity Detection):

```markdown
### Technical Concept Mentions

In addition to people/company/deal entities, detect:

| Signal | Destination |
|--------|-------------|
| User asks "how does X work" | `brain/concepts/{x-slug}.md` |
| User mentions a system/repo | `brain/systems/{system-slug}.md` |
| User asks cross-system question | Check all relevant concept + system pages |
| Agent discovers code pattern | Update or create concept page with codemap |
```

---

## 11. SKILLPACK Changes

Add a new section to `docs/GBRAIN_SKILLPACK.md`:

```markdown
## Section 19: Technical Knowledge Maps

### 19.1 System Pages

Create one system page per major codebase or subsystem. Include:
- Architecture summary (200-400 words)
- Key entry points table (path + purpose)
- Component map (name + path + one-liner)
- Key abstractions / vocabulary
- Build and run commands

### 19.2 Concept Pages with Codemap

When a concept spans multiple systems, add a codemap to frontmatter:
- One entry per system
- Each entry lists file paths, symbols, roles
- Include vocabulary mapping (concept name differs across systems)
- Compiled truth section synthesizes the cross-system picture

### 19.3 Maintenance Discipline

- Verify codemap pointers when using them (lazy verification)
- Mark stale pointers; don't delete them
- Update compiled truth when new cross-system connections are found
- Add timeline entries when understanding changes materially
```

---

## 12. Migration & Rollout

### Phase 1: Schema + Type (Week 1)

- Add `'system'` to `PageType` union
- Add `CodemapPointer` and `CodemapEntry` type definitions
- Update `put_page` validation to accept `system` type
- Update documentation (SKILLPACK, AGENT_RULES)
- No database migration needed

### Phase 2: Skills + Templates (Week 2)

- Create `skills/codemap-ingest/` skill file
- Create page templates for `system` and codemap-enhanced `concept`
- Update `skills/query/` with technical query guidance
- Add recommended link types to SKILLPACK

### Phase 3: Agent Rule Update (Week 2)

- Update AGENT_RULES Section 3 with technical concept detection
- Add codemap verification guidance
- Update brain-first lookup protocol for code questions

### Phase 4: Validation (Week 3)

- Build 2-3 real system pages from actual codebases
- Build 5-10 cross-system concept pages with codemaps
- Validate token savings (measure before/after for cross-system questions)
- Iterate on templates based on real usage

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Code pointers go stale quickly | High | Medium | Lazy verification on read; stale markers instead of deletion |
| Agents over-invest in map building | Medium | Low | Skill file scopes work; maps are built incrementally during normal sessions |
| Maps become too verbose | Medium | Medium | Compiled truth has a 400-word target; codemap is structured YAML, not prose |
| Vocabulary mapping is incomplete | High | Low | Partial maps are useful; vocabulary field is optional |
| System pages duplicate READMEs | Low | Low | System pages are agent-oriented (entry points, abstractions), not user-oriented (install guide) |

---

## 14. Success Metrics

| Metric | Measurement | Target |
|--------|-------------|--------|
| Token savings on cross-system questions | Compare token usage with/without brain lookup | >3x reduction |
| Map coverage | % of frequently-asked concepts with codemap entries | >60% after 3 months |
| Pointer accuracy | % of codemap pointers that pass verification | >80% at any given time |
| Agent adoption | % of code-related sessions where brain-first lookup fires | >50% after rules update |
| User satisfaction | Qualitative: "Did the brain help orient the answer?" | Positive signal in >70% of cross-system questions |

---

## 15. Open Questions

1. **Should codemap live in frontmatter or in a dedicated section of the page body?** Frontmatter (YAML) is queryable but verbose for many pointers. Body (markdown table) is readable but harder to parse programmatically. This RFC proposes frontmatter; revisit if pointer counts exceed ~20 per system.

2. **Should system pages track git commit hashes for version pinning?** This would allow pointer staleness to be checked against git log instead of calendar dates. Deferred to v2.

3. **Should there be a `verify_codemap` MCP tool in v1?** The current proposal says no (agents verify via grep + put_page). If verification becomes a bottleneck, reconsider.

4. **How does this interact with CLAUDE.md / AGENTS.md files in repos?** These files describe project conventions for the AI agent. System pages describe architecture for the knowledge brain. They're complementary: CLAUDE.md says "how to work here", system pages say "what is here and how it connects to the rest of the world."

---

## 16. Appendix: Full Example — System Page + Concept Page

### A. System Page: LLVM

```markdown
---
type: system
title: "LLVM Compiler Infrastructure"
tags: [compiler, llvm, optimization, code-generation]
slug: "systems/llvm"
repo: "https://github.com/llvm/llvm-project"
language: ["C++", "TableGen", "CMake"]
build_command: "cmake -G Ninja ../llvm -DLLVM_ENABLE_PROJECTS='clang' && ninja"
test_command: "ninja check-llvm"
---

## Architecture Summary

LLVM is a modular compiler infrastructure. Source code is lowered through
multiple intermediate representations: Clang AST → LLVM IR → SelectionDAG
→ MachineInstr → MCInst → assembly/object code. Each stage has its own
pass pipeline. The key design principle is that optimizations operate on
LLVM IR, which is target-independent, while code generation passes handle
target-specific lowering.

## Key Entry Points

| Entry Point | Path | Purpose |
|-------------|------|---------|
| LLVM IR passes | `llvm/lib/Transforms/` | Optimization passes (InstCombine, GVN, LICM, ...) |
| SelectionDAG | `llvm/lib/CodeGen/SelectionDAG/` | IR → machine instruction lowering |
| Target backends | `llvm/lib/Target/{X86,AArch64,...}/` | Target-specific code generation |
| Pass manager | `llvm/lib/Passes/PassBuilder.cpp` | New pass manager pipeline construction |
| Clang frontend | `clang/lib/CodeGen/` | AST → LLVM IR emission |

## Key Abstractions

- **LLVM IR**: SSA-form intermediate representation (Module → Function → BasicBlock → Instruction)
- **Pass**: A transformation or analysis on IR; registered via PassBuilder
- **SelectionDAG**: DAG-based instruction selection (IR → target machine ops)
- **TableGen**: DSL for describing target instruction sets and register files

---

## Timeline
- **2026-04-15** | System page created from codebase exploration
```

### B. Concept Page with Codemap: Memory Allocation

```markdown
---
type: concept
title: "GPU Memory Allocation"
tags: [memory, gpu, cuda, allocation, caching]
slug: "concepts/gpu-memory-allocation"
codemap:
  - system: "systems/pytorch"
    pointers:
      - path: "c10/cuda/CUDACachingAllocator.cpp"
        symbol: "CUDACachingAllocator::malloc()"
        role: "Caching allocator — pools CUDA allocations to avoid cudaMalloc overhead"
        verified_at: "2026-04-15"
      - path: "torch/cuda/memory.py"
        symbol: "memory_stats()"
        role: "Python API for inspecting allocator state"
        verified_at: "2026-04-15"
    vocabulary: "caching allocator / memory pool"
  - system: "systems/jax"
    pointers:
      - path: "jax/_src/interpreters/xla.py"
        symbol: "Backend.buffer_from_pyval()"
        role: "XLA buffer allocation — delegates to XLA runtime"
        verified_at: "2026-04-15"
    vocabulary: "XLA buffer / DeviceArray"
  - system: "systems/linux-kernel"
    pointers:
      - path: "drivers/gpu/drm/nouveau/nouveau_mem.c"
        symbol: "nouveau_mem_new()"
        role: "Kernel-level GPU memory allocation via DRM subsystem"
        verified_at: "2026-04-15"
    vocabulary: "GEM object / TTM buffer object"
---

## Compiled Truth

GPU memory allocation spans from user frameworks down to kernel drivers.
Each layer adds its own abstraction:

**Cross-system comparison:**
1. **PyTorch** uses a caching allocator — pools cudaMalloc results to avoid
   expensive allocation syscalls. Freed tensors return to pool, not to CUDA.
2. **JAX** delegates to XLA runtime, which manages its own buffer pool.
   Allocation is implicit — users don't call malloc directly.
3. **Linux kernel** manages GPU memory via DRM/GEM objects and TTM (Translation
   Table Manager). This is the lowest level — frameworks ultimately call into this.

**Key insight:** PyTorch's "out of memory" is often a fragmentation problem
in the caching allocator, not actual GPU memory exhaustion. Understanding
the pool structure (small/large bins, stream-ordered allocation) is essential
for debugging OOM errors.

**Vocabulary map:**
| System | Term | Level |
|--------|------|-------|
| PyTorch | caching allocator | Framework (user-space) |
| JAX | XLA buffer | Framework (via XLA runtime) |
| Linux kernel | GEM/TTM object | Kernel driver |

---

## Timeline
- **2026-04-15** | Mapped GPU memory allocation across PyTorch, JAX,
  and Linux kernel. Key finding: PyTorch OOM often caused by caching
  allocator fragmentation, not physical memory limits.
  [Source: Code analysis session]
```
