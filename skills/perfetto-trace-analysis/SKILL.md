---
name: perfetto-trace-analysis
description: Analyzes Perfetto traces to find the root cause of latency, memory, or
  jank issues in Android apps. Use when the user provides a Perfetto trace file and
  asks any question, ongoing investigation, or open-ended request to analyze its contents.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-05-14'
  keywords:
  - Perfetto
  - trace analysis
  - Android performance
  - debugging
  - profiling
  - jank
  - bottleneck
  - SQL
triggers:
  - android
  - jetpack
  - compose
---

## Resources

- **Domain Hints:** Reference files for specific performance areas: [`CPU`](references/hints_cpu.md), [`Graphics`](references/hints_graphics.md), [`I/O`](references/hints_io.md), [`IPC`](references/hints_ipc.md), [`Memory`](references/hints_memory.md), [`Power`](references/hints_power.md). These files each contain multiple expert-vetted, powerful trace analysis techniques to steer and aid in the analysis.
- **Perfetto SQL Reference:** Reference guidelines for translating intents into valid queries are located in [the SQL reference](references/sql.md). You must read this reference and follow its Execution Protocol for all SQL generation.

## Setup Phase (Mandatory)

1. **Initialize Scratchpad (Chain of Evidence):**
   - Maintain your working memory in a local scratchpad file located in the exact same directory as the target trace file.
   - Name the file using the trace's filename appended with `_analysis.md` (e.g., `[trace_filename]_analysis.md`). Before creating it, check if a file with that name already exists by listing the directory's contents---to avoid biasing your investigation, DO NOT read the file's contents to check for its existence. If it does, append an incrementing version number (e.g., `_v2.md`, `_v3.md`) until you find an available filename. You MUST hardcode this exact filename in all subsequent tool calls.
   - Use this scratchpad STRICTLY to log verified facts: timestamps, slice names, thread IDs (utid/tid), and thread states.
   - DO NOT write preliminary hypotheses or premature conclusions in the scratchpad. It is a strict Chain of Evidence.
2. **Review Domain Hints:** Read the Domain Hints in each file to get a high-level overview of what techniques are possible. Make sure to use this baseline knowledge when researching and retrieving hints during the ongoing investigation.
3. **Review SQL Reference:** Read the SQL reference in [`references/sql.md`](references/sql.md) and follow its Execution Protocol for all SQL generation. Do not guess schemas.
4. **Target Resolution:** If the user's request is broad (e.g., "why is the app slow?") and doesn't specify a package name:
   - Execute a query to identify the active application: `sql INCLUDE
     PERFETTO MODULE android.startup.startups; SELECT package FROM
     android_startups;`
   - If multiple packages are returned, ask the user to choose one. Save the chosen `package_name` to your scratchpad.

## Investigation Protocol

Follow this iterative loop until you have isolated the definitive root cause(s):

### 1. Formulate Hypothesis

- **Prioritization:** Form hypotheses using information from: user prompt \> "Domain Hints" ([`CPU`](references/hints_cpu.md), [`Graphics`](references/hints_graphics.md), [`I/O`](references/hints_io.md), [`IPC`](references/hints_ipc.md), [`Memory`](references/hints_memory.md), [`Power`](references/hints_power.md)) \> general knowledge. Be sure to leverage these "Domain Hints" as they are expert-vetted analysis techniques.
- **Source Attribution:** Explicitly mention the source of your hypothesis (e.g., "Based on hints_io.md...").
- **Focus Constraint:** Focus on the primary bottleneck. Avoid investigating deep into binder transactions unless the user explicitly asks for it or there is no other obvious bottleneck.
- **State Reasoning:** Briefly state your reasoning based on previous findings *before* generating a new query.

### 2. Plan and Collect Data

- **Metrics First:** Start with a high-level view using trace metrics before diving into custom SQL (e.g., `./trace_processor --run-metrics
  android_startup`).
- **Broad to Narrow:** Begin with broad queries using minimal filters. Favor fuzzy matching (e.g., `GLOB '*abc*'`) over exact matching.
- **Overlapping Time:** When filtering by time, you MUST check for events that overlap with the target time range (e.g., `start1 < end2 AND start2 < end1`) to ensure you don't miss slices that span across the boundaries.

### 3. Analyze and Drill Down (Depth-First)

- **Evidentiary Rigor:** Do not draw conclusions without explicit data.
- **Wall Time vs. CPU Time:** Do not assume a long-running slice is actively computing. You MUST query the `thread_state` table for the exact timestamp window of suspicious slices to verify if the thread was `Running`, `Runnable` (waiting for CPU), or `Sleeping`/`Uninterruptible Sleep` (blocked).
- **Follow Dependencies:** If a thread is blocked/waiting, you MUST find what it is waiting *for* (Binder, Lock, I/O, etc.). Cross process boundaries if necessary. You cannot conclude an investigation on a waiting thread without identifying the blocker.

### 4. Exhaustive Investigation (Do Not Give Up Early)

- **Multiple Bottlenecks:** Complex performance issues rarely have a single cause. Do NOT stop your investigation after finding the first anomaly. Even if you find a major bottleneck (e.g., emulator graphics lag), you MUST continue searching for other independent system-wide issues (e.g., lock contention, I/O stalls). To find other bottlenecks, search through the content of the "Domain Hints" files ([`CPU`](references/hints_cpu.md), [`Graphics`](references/hints_graphics.md), [`I/O`](references/hints_io.md), [`IPC`](references/hints_ipc.md), [`Memory`](references/hints_memory.md), [`Power`](references/hints_power.md)) to retrieve and leverage expert-vetted, powerful trace analysis techniques. Investigate each relevant hint with depth.
- **Global Verification:** Periodically perform a system-wide query for the longest running slices (`ORDER BY slice.dur DESC`) and most frequent D-states to ensure your local investigation hasn't missed a massive, unrelated system stall.
- **Persist Through Dead Ends:** If a hypothesis is disproven or a query returns empty, do not conclude. Pivot your focus, broaden your search constraints (fuzzy matching, wider time windows), and continue the mission.

## Final Report

Only when you have followed the entire chain of dependencies to the root
cause(s) AND confirmed through exhaustive search that no other major bottlenecks
exist: 1. Summarize your findings detailing the verified chain of evidence. 2.
Conclude with: "This concludes the trace analysis. You can review the full chain
of evidence in \[scratchpad_filename\]. Let me know if you would like me to drill
down into any of these specific threads, or if you'd like help drafting a bug
report."

## Contract
- Inputs: Android project context and the skill's target surface (Compose, Play, profiling, security, etc.).
- Outputs: concrete, API-accurate Android guidance and code that matches official Android docs for the skill topic.
- Failure modes: outdated AGP/API assumptions, inventing SDK APIs, or applying mobile guidance to non-Android targets.

## Output Format
1. State the target Android surface and constraints.
2. Provide the minimal correct implementation or migration steps.
3. Call out version requirements, common pitfalls, and verification.

## Anti-Patterns
- Do not invent Jetpack/Play/Compose APIs or dependency coordinates.
- Do not hardcode secrets, signing keys, or production package names from examples into real apps.
- Do not skip version/AGP compatibility checks.
- Do not treat sample emails or demo identities as real credentials.
