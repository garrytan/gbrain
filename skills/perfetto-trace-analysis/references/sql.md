## Guidelines and Hints

- **Idempotency:** Ensure queries are idempotent to prevent "already exists" errors during multiple executions.
  - For Perfetto objects, always use `CREATE OR REPLACE`: `CREATE OR REPLACE
    PERFETTO TABLE`, `CREATE OR REPLACE PERFETTO VIEW`, `CREATE OR REPLACE
    PERFETTO FUNCTION`, `CREATE OR REPLACE PERFETTO MACRO`.
  - For SQLite Virtual Tables (such as `SPAN_JOIN`), `CREATE OR REPLACE` is not supported. Explicitly drop them first: `DROP TABLE IF EXISTS
    my_table; CREATE VIRTUAL TABLE my_table USING SPAN_JOIN(...);`
  - For standard SQLite indexes, prepend `DROP INDEX IF EXISTS index_name;`.
- `SPAN_JOIN` will crash if intervals **within the same input table** overlap. Always use the `PARTITIONED {column}` (for example, `PARTITIONED upid`) clause to isolate intervals.
- Intermediate tables fed into a `SPAN_JOIN` must be materialized using `CREATE PERFETTO TABLE`, not `CREATE VIEW`.
- **Trace Boundaries (`dur = -1`):** Slices or thread states that don't finish before the trace ends are recorded with `dur = -1`. When calculating a bounding box (for example, `ts + dur`) or summing durations (`SUM(dur)`), handle incomplete durations using: `IIF(dur = -1, trace_end() - ts, dur)`.
- **Robust State Transitions:** Avoid manual timestamp arithmetic (for example, `ts + dur = next.ts`) to join adjacent events. Rely on standard library modules (for example, `sched.runnable`, `linux.perf.counters`, `intervals.overlap`) which safely handle trace gaps and preemptions.
- **Unique Identifiers:** When writing SQL queries in Perfetto, you must join tables using `utid` (unique thread ID) or `upid` (unique process ID) instead of the regular `tid` or `pid`. **Why it's useful** : The operating system recycles `TIDs` and `PIDs`, while `UTIDs` and `UPIDs` remain unique for the lifetime of the trace, which prevents incorrect joins.
- **Safe Argument Extraction:** Use `EXTRACT_ARG(arg_set_id, 'key')` to extract dictionary or JSON-like properties from slices or tracks. Don't attempt string parsing.
- **String Matching (Always use GLOB):** Use `GLOB` instead of `LIKE`. `LIKE` causes performance bottlenecks and treats underscores (`_`) as wildcards, leading to bugs.
  - **Exact matches:** Use `=`.
  - **Substring matches:** Use `GLOB` with `*` (for example, `name GLOB
    '*RenderThread*'`).
  - **Case-insensitive matches:** Use `LOWER(name) GLOB` and make sure the search string is fully lowercase (for example, `LOWER(name) GLOB
    '*renderthread*'`). Use this when dealing with inconsistent trace capitalization (for example, `WakeLock` versus `wakelock`).
- **Calculating Time Overlaps:** To calculate the overlap duration between two
  time intervals `[start1, end1]` and `[start2, end2]`:

  > **Precedence Rule:** Always prefer using `SPAN_JOIN` or standard library
  > functions (for example, `intervals.overlap`) to calculate overlaps
  > **between two different sets of intervals** . Avoid manual arithmetic if a
  > standard library feature or `SPAN_JOIN` can achieve the same result. Use
  > the following logic if no built-in alternative exists.
  1. **Condition:** The intervals overlap if `start1 < end2` and `start2 <
     end1`.
  2. **Duration:** The overlap duration is calculated as `MIN(end1, end2) -
     MAX(start1, start2)`

     > **Important:** Incomplete Perfetto slices have a duration of -1
     > (`dur = -1`). Always calculate the effective end time using `ts +
     > IIF(dur = -1, trace_end() - ts, dur)` before applying this logic.
- Query `android_thread_slices_for_all_startups` for app startup requests.

- Join `counter_track` with `counter` to get values of counter with a specific
  name.

- When querying for a CPU frequency counter, include the `linux.cpu.frequency`
  module and use the `cpu_frequency_counters` table.

- When looking for events around a specific timestamp, start with 100ms as the
  window size.

- Always prefix column names with table or view alias, that is:
  `{alias}.{column_name}`.

- To calculate the total time spent in slices matching a specific name pattern
  (for example, `*{name_pattern}*`), you must sum their durations. **Why it's
  useful** : This helps quantify the total impact of a specific function or
  feature on performance across multiple calls. Here is an example query (note
  the safe handling of incomplete slices): `sql SELECT count(*) as
  total_count, sum(IIF(slice.dur = -1, trace_end() - slice.ts, slice.dur)) /
  1000000.0 as total_dur_ms FROM slice WHERE slice.name GLOB
  '*{name_pattern}*';`

## Resources

- **Documentation:** The Perfetto Standard Library documentation is in [`perfetto-stdlib.md`](perfetto-stdlib.md). Use this file as a reference to discover available modules, find schemas (columns and types) for specific tables or views, or determine the `INCLUDE PERFETTO MODULE` statements required before drafting SQL query.
- **Execution Tool:** Queries are executed using the official `trace_processor` wrapper script downloaded directly from Perfetto. Output is returned in pure CSV format.

## Execution Protocol

You must follow these steps sequentially, mirroring a multi-agent pipeline:

### Step 0: Tool Setup

**Fetch the Wrapper:** You must use the top level of the current project workspace (`./trace_processor`).

> **CRITICAL GUARDRAIL:** NEVER use filesystem search tools (`find`, `find_by_name`, `grep`, `dir /s`, `Get-ChildItem`) across the home directory or workspace to locate `trace_processor` — unconstrained searches across entire workspaces will stop responding or time out.

Perform a direct file check at the top level of your workspace (e.g., `ls trace_processor`). If missing, download `https://get.perfetto.dev/trace_processor` directly into the root workspace (`curl -LO`), make it executable on macOS/Linux (`chmod +x`), and ensure `trace_processor` is added to `.gitignore`. Execute queries directly via `./trace_processor` (on Windows, explicitly invoke `python trace_processor`).

> **Important:** The file served at this URL is a `~10KB` Python wrapper script. Don't assume the download failed because it is human-readable text. This is the intended behavior. This script handles lazy-loading the precompiled binary automatically on its first run. Use it directly.

### Step 1: Dissection and Schema Research

1. Identify the core question, required data points, and filtering conditions.
2. **Precedence Rule:** If the user's request contains a SQL query, use it **without modification** and skip to Step 2 for validation.
3. **Mandatory Schema and Module Search:** For every table or view you plan to use, you MUST find its schema in [`perfetto-stdlib.md`](perfetto-stdlib.md). **Don't read the entire documentation file** --- it consumes the context window. Follow this precise workflow:
   - **Discovery and Search:** Use available search tools (`grep`, `read_file` or file search) with line limits to discover relevant views, tables or modules based on your problem domain and high-level intents (for example, 'CPU time', 'running time', 'overlap', 'jank').
     - **Why:** Searching solely for exact table names misses comprehensive, pre-computed views built for these analyses.
     - **Note:** You must verify if a Standard Library module already provides the needed abstraction before drafting manual arithmetic or custom functions.
   - **Targeted Bounded Reads:** Once you identify the relevant modules, efficiently read the tables and views within that module section.
   - **Extract:** Extract only the schema, columns, and the exact `INCLUDE
     PERFETTO MODULE` statements for the required object from the documentation.
   - **Verify:** Review the columns, types, and descriptions to ensure the table matches your needs.
4. Print the research results before drafting the query:
5. *Tables/Views:* `Schema for {name}:` listing columns and types.

### Step 2: Draft and Validate Loop (Max 3 Iterations)

Draft the SQL query in SQLite syntax using **only** the schemas retrieved in
Step 1. After drafting, you must validate against this checklist:

- \[ \] **SQLite Syntax:** Does the query parse successfully without syntax errors?
- \[ \] **Idempotency:** Are all object creations safe to re-run? (Did you use `CREATE OR REPLACE PERFETTO` and `DROP TABLE IF EXISTS` for virtual tables?)
- \[ \] **Existence:** Were all tables found in the documentation?
- \[ \] **Intent Check:** Is there a pre-existing standard library table or view that will fulfill this intent before instead of writing manual arithmetic?
- \[ \] **Column Accuracy:** Do columns match the retrieved schemas?
- \[ \] **Alias Check:** Are ALL column names prefixed with their table or view alias (for example, `alias.column_name`)?
- \[ \] **Module Check:** Are `INCLUDE PERFETTO MODULE` statements included for all non-prelude modules? **You must use the exact module names provided in
  the documentation.**
- \[ \] **Span Join Check:** If using `SPAN_JOIN`, are tables safely `PARTITIONED` to prevent overlapping interval crashes? Are intermediate tables materialized with `CREATE PERFETTO TABLE`?
- \[ \] **No LIKE Constraint:** Did you map string matches using `GLOB` or `=` instead of prohibited `LIKE`?
- \[ \] **Execution Check:** You MUST run queries using the standalone
  `./trace_processor` wrapper with the `--query-string` flag:
  `./trace_processor --query-string "QUERY" {trace_file}`.

  **Execution Rules:**
  - **File Usage** : If you must create a SQL file to execute queries (for example, due to query length or escaping issues), you must create them in the `/tmp/` directory.
  - **State:** The execution is purely ephemeral. Database state does not persist across turns. You **cannot** share state (like views or tables) across queries in different turns. Every query must be standalone and fully self-contained.
  - **Failure Resilience:** Debug and fix SQL syntax and logic errors when query fails.Don't simplify the analytical intent to pass validation. For example, if requested to calculate an overlap or intersection, you must fix the intersection math. Don't substitute with disjoint queries (for example, returning independent total durations) as a workaround.

### Step 3: Final Output

1. Explicitly return and state the final validated SQL and explain the results to the user.
2. Before finishing your response, delete all temporary SQL files you created in `/tmp/` directory.