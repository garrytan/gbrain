*This page documents the PerfettoSQL standard library.*

## Introduction

The PerfettoSQL standard library is a repository of tables, views, functions
and macros, contributed by domain experts, which make querying traces easier
Its design is heavily inspired by standard libraries in languages like Python,
C++ and Java.

Some of the purposes of the standard library include:
1) Acting as a way of sharing and commonly written queries without needing
to copy/paste large amounts of SQL.
2) Raising the abstraction level when exposing data in the trace. Many
modules in the standard library convert low-level trace concepts
e.g. slices, tracks and into concepts developers may be more familar with
e.g. for Android developers: app startups, binder transactions etc.

Standard library modules can be included as follows

    -- Include all tables/views/functions from the android.startup.startups
    -- module in the standard library.
    INCLUDE PERFETTO MODULE android.startup.startups;

    -- Use the android_startups table defined in the android.startup.startups
    -- module.
    SELECT *
    FROM android_startups;

Prelude is a special module is automatically included. It contains key helper
tables, views and functions which are universally useful.

More information on importing modules is available in the
[syntax documentation](https://perfetto.dev/docs/analysis/perfetto-sql-syntax#including-perfettosql-modules)
for the `INCLUDE PERFETTO MODULE` statement.

## Package: prelude

#### Views/Tables

<br />

**trace_metrics**. Lists all metrics built-into trace processor.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| name | STRING | The name of the metric. |

<br />

<br />

<br />

**track**. Tracks are a fundamental concept in trace processor and represent a "timeline" for events of the same type and with the same context

<br />

VIEW
Tracks are a fundamental concept in trace processor and represent a
"timeline" for events of the same type and with the same context. See
https://perfetto.dev/docs/analysis/trace-processor#tracks for a more
detailed explanation, with examples.

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this track. Identical to \|track_id\|, prefer using \|track_id\| instead. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| name | STRING | Name of the track; can be null for some types of tracks (e.g. thread tracks). |
| parent_id | UINT | The track which is the "parent" of this track. Only non-null for tracks created using Perfetto's track_event API. |
| source_arg_set_id | UINT | Args for this track which store information about "source" of this track in the trace. For example: whether this track orginated from atrace, Chrome tracepoints etc. Alias of `args.arg_set_id`. |
| machine_id | UINT | Machine identifier, non-null for tracks on a remote machine. |

<br />

<br />

<br />

**cpu**. Contains information about the CPUs on the device this trace was taken on.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this CPU. Identical to \|ucpu\|, prefer using \|ucpu\| instead. |
| ucpu | UINT | Unique identifier for this CPU. Isn't equal to \|cpu\| for remote machines and is equal to \|cpu\| for the host machine. |
| cpu | UINT | The 0-based CPU core identifier. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| cluster_id | UINT | The cluster id is shared by CPUs in the same cluster. |
| processor | STRING | A string describing this core. |
| machine_id | UINT | Machine identifier, non-null for CPUs on a remote machine. |
| capacity | UINT | Capacity of a CPU of a device, a metric which indicates the relative performance of a CPU on a device For details see: https://www.kernel.org/doc/Documentation/devicetree/bindings/arm/cpu-capacity.txt |
| arg_set_id | UINT | Extra key/value pairs associated with this cpu. |

<br />

<br />

<br />

**cpu_available_frequencies**. Contains the frequency values that the CPUs on the device are capable of running at.

<br />

VIEW
Contains the frequency values that the CPUs on the device are capable of
running at.

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this cpu frequency. |
| cpu | UINT | The CPU for this frequency, meaningful only in single machine traces. For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| freq | UINT | CPU frequency in KHz. |
| ucpu | UINT | The CPU that the slice executed on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |

<br />

<br />

<br />

**sched_slice**. This table holds slices with kernel thread scheduling information

<br />

VIEW
This table holds slices with kernel thread scheduling information. These
slices are collected when the Linux "ftrace" data source is used with the
"sched/switch" and "sched/wakeup\*" events enabled.

The rows in this table will always have a matching row in the \|thread_state\|
table with \|thread_state.state\| = 'Running'

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this scheduling slice. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp at the start of the slice (in nanoseconds). |
| dur | LONG | The duration of the slice (in nanoseconds). |
| cpu | UINT | The CPU that the slice executed on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| utid | UINT | The thread's unique id in the trace. |
| end_state | STRING | A string representing the scheduling state of the kernel thread at the end of the slice. The individual characters in the string mean the following: R (runnable), S (awaiting a wakeup), D (in an uninterruptible sleep), T (suspended), t (being traced), X (exiting), P (parked), W (waking), I (idle), N (not contributing to the load average), K (wakeable on fatal signals) and Z (zombie, awaiting cleanup). |
| priority | INT | The kernel priority that the thread ran at. |
| ucpu | UINT | The unique CPU identifier that the slice executed on. |

<br />

<br />

<br />

**sched** . Shorter alias for table `sched_slice`.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Alias for `sched_slice.id`. |
| type | STRING | Alias for `sched_slice.type`. |
| ts | LONG | Alias for `sched_slice.ts`. |
| dur | LONG | Alias for `sched_slice.dur`. |
| cpu | UINT | Alias for `sched_slice.cpu`. |
| utid | UINT | Alias for `sched_slice.utid`. |
| end_state | STRING | Alias for `sched_slice.end_state`. |
| priority | INT | Alias for `sched_slice.priority`. |
| ucpu | UINT | Alias for `sched_slice.ucpu`. |
| ts_end | UINT | Legacy column, should no longer be used. |

<br />

<br />

<br />

**thread_state**. This table contains the scheduling state of every thread on the system during the trace. The rows in this table which have \|state\| = 'Running', will have a corresponding row in the \|sched_slice\| table.

<br />

VIEW
This table contains the scheduling state of every thread on the system during
the trace.

The rows in this table which have \|state\| = 'Running', will have a
corresponding row in the \|sched_slice\| table.

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this thread state. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp at the start of the slice (in nanoseconds). |
| dur | LONG | The duration of the slice (in nanoseconds). |
| cpu | UINT | The CPU that the thread executed on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| utid | UINT | The thread's unique id in the trace. |
| state | STRING | The scheduling state of the thread. Can be "Running" or any of the states described in \|sched_slice.end_state\|. |
| io_wait | UINT | Indicates whether this thread was blocked on IO. |
| blocked_function | STRING | The function in the kernel this thread was blocked on. |
| waker_utid | UINT | The unique thread id of the thread which caused a wakeup of this thread. |
| waker_id | UINT | The unique thread state id which caused a wakeup of this thread. |
| irq_context | UINT | Whether the wakeup was from interrupt context or process context. |
| ucpu | UINT | The unique CPU identifier that the thread executed on. |

<br />

<br />

<br />

**raw**. Contains 'raw' events from the trace for some types of events

<br />

VIEW
Contains 'raw' events from the trace for some types of events. This table
only exists for debugging purposes and should not be relied on in production
usecases (i.e. metrics, standard library etc.)

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this raw event. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp of this event. |
| name | STRING | The name of the event. For ftrace events, this will be the ftrace event name. |
| cpu | UINT | The CPU this event was emitted on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| utid | UINT | The thread this event was emitted on. |
| arg_set_id | UINT | The set of key/value pairs associated with this event. |
| common_flags | UINT | Ftrace event flags for this event. Currently only emitted for sched_waking events. |
| ucpu | UINT | The unique CPU identifier that this event was emitted on. |

<br />

<br />

<br />

**ftrace_event**. Contains all the ftrace events in the trace

<br />

VIEW
Contains all the ftrace events in the trace. This table exists only for
debugging purposes and should not be relied on in production usecases (i.e.
metrics, standard library etc). Note also that this table might be empty if
raw ftrace parsing has been disabled.

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this ftrace event. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp of this event. |
| name | STRING | The ftrace event name. |
| cpu | UINT | The CPU this event was emitted on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| utid | UINT | The thread this event was emitted on. |
| arg_set_id | UINT | The set of key/value pairs associated with this event. |
| common_flags | UINT | Ftrace event flags for this event. Currently only emitted for sched_waking events. |
| ucpu | UINT | The unique CPU identifier that this event was emitted on. |

<br />

<br />

<br />

**experimental_sched_upid**. The sched_slice table with the upid column.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this scheduling slice. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp at the start of the slice (in nanoseconds). |
| dur | LONG | The duration of the slice (in nanoseconds). |
| cpu | UINT | The CPU that the slice executed on (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| utid | UINT | The thread's unique id in the trace. |
| end_state | STRING | A string representing the scheduling state of the kernel thread at the end of the slice. The individual characters in the string mean the following: R (runnable), S (awaiting a wakeup), D (in an uninterruptible sleep), T (suspended), t (being traced), X (exiting), P (parked), W (waking), I (idle), N (not contributing to the load average), K (wakeable on fatal signals) and Z (zombie, awaiting cleanup). |
| priority | INT | The kernel priority that the thread ran at. |
| ucpu | UINT | The unique CPU identifier that the slice executed on. |
| upid | UINT | The process's unique id in the trace. |

<br />

<br />

<br />

**cpu_track**. Tracks which are associated to a single CPU.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this cpu track. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| name | STRING | Name of the track. |
| parent_id | UINT | The track which is the "parent" of this track. Only non-null for tracks created using Perfetto's track_event API. |
| source_arg_set_id | UINT | Args for this track which store information about "source" of this track in the trace. For example: whether this track orginated from atrace, Chrome tracepoints etc. |
| machine_id | UINT | Machine identifier, non-null for tracks on a remote machine. |
| cpu | UINT | The CPU that the track is associated with (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| ucpu | UINT | The unique CPU identifier that this track is associated with. |

<br />

<br />

<br />

**cpu_counter_track**. Tracks containing counter-like events associated to a CPU.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Unique identifier for this cpu counter track. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| name | STRING | Name of the track. |
| parent_id | UINT | The track which is the "parent" of this track. Only non-null for tracks created using Perfetto's track_event API. |
| source_arg_set_id | UINT | Args for this track which store information about "source" of this track in the trace. For example: whether this track orginated from atrace, Chrome tracepoints etc. |
| machine_id | UINT | Machine identifier, non-null for tracks on a remote machine. |
| unit | STRING | The units of the counter. This column is rarely filled. |
| description | STRING | The description for this track. For debugging purposes only. |
| cpu | UINT | The CPU that the track is associated with (meaningful only in single machine traces). For multi-machine, join with the `cpu` table on `ucpu` to get the CPU identifier of each machine. |
| ucpu | UINT | The unique CPU identifier that this track is associated with. |

<br />

<br />

<br />

**counters** . Alias of the `counter` table.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Alias of `counter.id`. |
| type | STRING | Alias of `counter.type`. |
| ts | LONG | Alias of `counter.ts`. |
| track_id | INT | Alias of `counter.track_id`. |
| value | DOUBLE | Alias of `counter.value`. |
| arg_set_id | INT | Alias of `counter.arg_set_id`. |
| name | STRING | Legacy column, should no longer be used. |
| unit | STRING | Legacy column, should no longer be used. |
| description | STRING | Legacy column, should no longer be used. |

<br />

<br />

<br />

**slice**. Contains slices from userspace which explains what threads were doing during the trace.

<br />

VIEW
Contains slices from userspace which explains what threads were doing
during the trace.

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the slice. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | LONG | The timestamp at the start of the slice (in nanoseconds). |
| dur | LONG | The duration of the slice (in nanoseconds). |
| track_id | INT | The id of the track this slice is located on. |
| category | STRING | The "category" of the slice. If this slice originated with track_event, this column contains the category emitted. Otherwise, it is likely to be null (with limited exceptions). |
| name | STRING | The name of the slice. The name describes what was happening during the slice. |
| depth | INT | The depth of the slice in the current stack of slices. |
| stack_id | LONG | A unique identifier obtained from the names of all slices in this stack. This is rarely useful and kept around only for legacy reasons. |
| parent_stack_id | LONG | The stack_id for the parent of this slice. Rarely useful. |
| parent_id | INT | The id of the parent (i.e. immediate ancestor) slice for this slice. |
| arg_set_id | INT | The id of the argument set associated with this slice. |
| thread_ts | LONG | The thread timestamp at the start of the slice. This column will only be populated if thread timestamp collection is enabled with track_event. |
| thread_dur | LONG | The thread time used by this slice. This column will only be populated if thread timestamp collection is enabled with track_event. |
| thread_instruction_count | LONG | The value of the CPU instruction counter at the start of the slice. This column will only be populated if thread instruction collection is enabled with track_event. |
| thread_instruction_delta | LONG | The change in value of the CPU instruction counter between the start and end of the slice. This column will only be populated if thread instruction collection is enabled with track_event. |
| cat | STRING | Alias of `category`. |
| slice_id | LONG | Alias of `id`. |

<br />

<br />

<br />

**instant**. Contains instant events from userspace which indicates what happened at a single moment in time.

<br />

VIEW
Contains instant events from userspace which indicates what happened at a
single moment in time.

| Column | Type | Description |
|---|---|---|
| ts | LONG | The timestamp of the instant (in nanoseconds). |
| track_id | INT | The id of the track this instant is located on. |
| name | STRING | The name of the instant. The name describes what happened during the instant. |
| arg_set_id | INT | The id of the argument set associated with this instant. |

<br />

<br />

<br />

**slices** . Alternative alias of table `slice`.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | UINT | Alias of `slice.id`. |
| type | STRING | Alias of `slice.type`. |
| ts | LONG | Alias of `slice.ts`. |
| dur | LONG | Alias of `slice.dur`. |
| track_id | INT | Alias of `slice.track_id`. |
| category | STRING | Alias of `slice.category`. |
| name | STRING | Alias of `slice.name`. |
| depth | INT | Alias of `slice.depth`. |
| stack_id | LONG | Alias of `slice.stack_id`. |
| parent_stack_id | LONG | Alias of `slice.parent_stack_id`. |
| parent_id | INT | Alias of `slice.parent_id`. |
| arg_set_id | INT | Alias of `slice.arg_set_id`. |
| thread_ts | LONG | Alias of `slice.thread_ts`. |
| thread_dur | LONG | Alias of `slice.thread_dur`. |
| thread_instruction_count | LONG | Alias of `slice.thread_instruction_count`. |
| thread_instruction_delta | LONG | Alias of `slice.thread_instruction_delta`. |
| cat | LONG | Alias of `slice.cat`. |
| slice_id | LONG | Alias of `slice.slice_id`. |

<br />

<br />

<br />

**thread**. Contains information of threads seen during the trace.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the thread. Prefer using `utid` instead. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| utid | INT | Unique thread id. This is != the OS tid. This is a monotonic number associated to each thread. The OS thread id (tid) cannot be used as primary key because tids and pids are recycled by most kernels. |
| tid | INT | The OS id for this thread. Note: this is *not* unique over the lifetime of the trace so cannot be used as a primary key. Use \|utid\| instead. |
| name | STRING | The name of the thread. Can be populated from many sources (e.g. ftrace, /proc scraping, track event etc). |
| start_ts | LONG | The start timestamp of this thread (if known). Is null in most cases unless a thread creation event is enabled (e.g. task_newtask ftrace event on Linux/Android). |
| end_ts | LONG | The end timestamp of this thread (if known). Is null in most cases unless a thread destruction event is enabled (e.g. sched_process_free ftrace event on Linux/Android). |
| upid | LONG | The process hosting this thread. |
| is_main_thread | BOOL | Boolean indicating if this thread is the main thread in the process. |
| machine_id | INT | Machine identifier, non-null for threads on a remote machine. |

<br />

<br />

<br />

**process**. Contains information of processes seen during the trace.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the process. Prefer using `upid` instead. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| upid | LONG | Unique process id. This is != the OS pid. This is a monotonic number associated to each process. The OS process id (pid) cannot be used as primary key because tids and pids are recycled by most kernels. |
| pid | LONG | The OS id for this process. Note: this is *not* unique over the lifetime of the trace so cannot be used as a primary key. Use \|upid\| instead. |
| name | STRING | The name of the process. Can be populated from many sources (e.g. ftrace, /proc scraping, track event etc). |
| start_ts | LONG | The start timestamp of this process (if known). Is null in most cases unless a process creation event is enabled (e.g. task_newtask ftrace event on Linux/Android). |
| end_ts | LONG | The end timestamp of this process (if known). Is null in most cases unless a process destruction event is enabled (e.g. sched_process_free ftrace event on Linux/Android). |
| parent_upid | INT | The upid of the process which caused this process to be spawned. |
| uid | INT | The Unix user id of the process. |
| android_appid | INT | Android appid of this process. |
| cmdline | STRING | /proc/cmdline for this process. |
| arg_set_id | INT | Extra args for this process. |
| machine_id | INT | Machine identifier, non-null for processes on a remote machine. |

<br />

<br />

<br />

**args**. Arbitrary key-value pairs which allow adding metadata to other, strongly typed tables. Note: for a given row, only one of \|int_value\|, \|string_value\|, \|real_value\| will be non-null.

<br />

VIEW
Arbitrary key-value pairs which allow adding metadata to other, strongly
typed tables.
Note: for a given row, only one of \|int_value\|, \|string_value\|, \|real_value\|
will be non-null.

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the arg. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| arg_set_id | INT | The id for a single set of arguments. |
| flat_key | STRING | The "flat key" of the arg: this is the key without any array indexes. |
| key | STRING | The key for the arg. |
| int_value | LONG | The integer value of the arg. |
| string_value | STRING | The string value of the arg. |
| real_value | DOUBLE | The double value of the arg. |
| value_type | STRING | The type of the value of the arg. Will be one of 'int', 'uint', 'string', 'real', 'pointer', 'bool' or 'json'. |
| display_value | STRING | The human-readable formatted value of the arg. |

<br />

<br />

<br />

**perf_session**. Contains the Linux perf sessions in the trace.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the perf session. Prefer using `perf_session_id` instead. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| perf_session_id | INT | The id of the perf session. |
| cmdline | STRING | Command line used to collect the data. |

<br />

<br />

#### Functions

<br />

**slice_is_ancestor** -\> BOOL. Given two slice ids, returns whether the first is an ancestor of the second.

<br />

<br />

<br />

Returns BOOL: Whether `ancestor_id` slice is an ancestor of `descendant_id`.

| Argument | Type | Description |
|---|---|---|
| ancestor_id | LONG | Id of the potential ancestor slice. |
| descendant_id | LONG | Id of the potential descendant slice. |

<br />

<br />

<br />

**trace_start** -\> LONG. Fetch start of the trace.

<br />

<br />

<br />

Returns LONG: Start of the trace in nanoseconds.

<br />

<br />

<br />

**trace_end** -\> LONG. Fetch end of the trace.

<br />

<br />

<br />

Returns LONG: End of the trace in nanoseconds.

<br />

<br />

<br />

**trace_dur** -\> LONG. Fetch duration of the trace.

<br />

<br />

<br />

Returns LONG: Duration of the trace in nanoseconds.

<br />

<br />

#### Macros

<br />

**cast_int** . Casts \|value\| to INT.

<br />

<br />

<br />

Returns: Expr,

| Argument | Type | Description |
|---|---|---|
| value | Expr | Query or subquery that will be cast. |

<br />

<br />

<br />

**cast_double** . Casts \|value\| to DOUBLE.

<br />

<br />

<br />

Returns: Expr,

| Argument | Type | Description |
|---|---|---|
| value | Expr | Query or subquery that will be cast. |

<br />

<br />

<br />

**cast_string** . Casts \|value\| to STRING.

<br />

<br />

<br />

Returns: Expr,

| Argument | Type | Description |
|---|---|---|
| value | Expr | Query or subquery that will be cast. |

<br />

<br />

## Package: v8

### v8.jit

#### Views/Tables

<br />

**v8_isolate**. A V8 Isolate instance

<br />

VIEW
A V8 Isolate instance. A V8 Isolate represents an isolated instance of the V8
engine.

| Column | Type | Description |
|---|---|---|
| v8_isolate_id | UINT | Unique V8 isolate id. |
| upid | UINT | Process the isolate was created in. |
| internal_isolate_id | UINT | Internal id used by the v8 engine. Unique in a process. |
| embedded_blob_code_start_address | LONG | Absolute start address of the embedded code blob. |
| embedded_blob_code_size | LONG | Size in bytes of the embedded code blob. |
| code_range_base_address | LONG | Base address of the code range if the isolate defines one. |
| code_range_size | LONG | Size of a code range if the isolate defines one. |
| shared_code_range | LONG | Whether the code range for this Isolate is shared with others in the same process. There is at max one such shared code range per process. |
| embedded_blob_code_copy_start_address | LONG | Used when short builtin calls are enabled, where embedded builtins are copied into the CodeRange so calls can be nearer. |

<br />

<br />

<br />

**v8_js_script**. Represents a script that was compiled to generate code

<br />

VIEW
Represents a script that was compiled to generate code. Some V8 code is
generated out of scripts and will reference a V8Script other types of code
will not (e.g. builtins).

| Column | Type | Description |
|---|---|---|
| v8_js_script_id | UINT | Unique V8 JS script id. |
| v8_isolate_id | UINT | V8 isolate this script belongs to (joinable with `v8_isolate.v8_isolate_id`). |
| internal_script_id | UINT | Script id used by the V8 engine. |
| script_type | STRING | Script type. |
| name | STRING | Script name. |
| source | STRING | Actual contents of the script. |

<br />

<br />

<br />

**v8_wasm_script**. Represents one WASM script.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| v8_wasm_script_id | UINT | Unique V8 WASM script id. |
| v8_isolate_id | UINT | V8 Isolate this script belongs to (joinable with `v8_isolate.v8_isolate_id`). |
| internal_script_id | UINT | Script id used by the V8 engine. |
| url | STRING | URL of the source. |
| source | STRING | Actual contents of the script. |

<br />

<br />

<br />

**v8_js_function**. Represents a v8 Javascript function.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| v8_js_function_id | UINT | Unique V8 JS function id. |
| name | STRING | Function name. |
| v8_js_script_id | UINT | Script where the function is defined (joinable with `v8_js_script.v8_js_script_id`). |
| is_toplevel | BOOL | Whether this function represents the top level script. |
| kind | STRING | Function kind (e.g. regular function or constructor). |
| line | UINT | Line in script where function is defined. Starts at 1. |
| col | UINT | Column in script where function is defined. Starts at 1. |

<br />

<br />

## Package: wattson

### wattson.system_state

#### Views/Tables

<br />

**wattson_system_states**. The final system state for the CPU subsystem, which has all the information needed by Wattson to estimate energy for the CPU subsystem.

<br />

TABLE
The final system state for the CPU subsystem, which has all the information
needed by Wattson to estimate energy for the CPU subsystem.

| Column | Type | Description |
|---|---|---|
| ts | LONG | Starting timestamp of the current counter where system state is constant. |
| dur | INT | Duration of the current counter where system state is constant. |
| l3_hit_count | INT | Number of L3 hits the current system state. |
| l3_miss_count | INT | Number of L3 misses in the current system state. |
| freq_0 | INT | Frequency of CPU0. |
| idle_0 | INT | Idle state of CPU0. |
| freq_1 | INT | Frequency of CPU1. |
| idle_1 | INT | Idle state of CPU1. |
| freq_2 | INT | Frequency of CPU2. |
| idle_2 | INT | Idle state of CPU2. |
| freq_3 | INT | Frequency of CPU3. |
| idle_3 | INT | Idle state of CPU3. |
| freq_4 | INT | Frequency of CPU4. |
| idle_4 | INT | Idle state of CPU4. |
| freq_5 | INT | Frequency of CPU5. |
| idle_5 | INT | Idle state of CPU5. |
| freq_6 | INT | Frequency of CPU6. |
| idle_6 | INT | Idle state of CPU6. |
| freq_7 | INT | Frequency of CPU7. |
| idle_7 | INT | Idle state of CPU7. |
| suspended | BOOL | Flag indicating if current system state is suspended. |

<br />

<br />

## Package: stacks

### stacks.cpu_profiling

#### Views/Tables

<br />

**cpu_profiling_samples**. Table containing all the timestamped samples of CPU profiling which occurred during the trace. Currently, this table is backed by the following data sources: \* Linux perf \* macOS instruments \* Chrome CPU profiling \* Legacy V8 CPU profiling \* Profiling data in Gecko traces

<br />

TABLE
Table containing all the timestamped samples of CPU profiling which occurred
during the trace.

Currently, this table is backed by the following data sources:
\* Linux perf
\* macOS instruments
\* Chrome CPU profiling
\* Legacy V8 CPU profiling
\* Profiling data in Gecko traces

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the sample. |
| ts | INT | The timestamp of the sample. |
| utid | INT | The utid of the thread of the sample, if available. |
| tid | INT | The tid of the sample, if available. |
| thread_name | STRING | The thread name of thread of the sample, if available. |
| ucpu | INT | The ucpu of the sample, if available. |
| cpu | INT | The cpu of the sample, if available. |
| callsite_id | INT | The callsite id of the sample. |

<br />

<br />

<br />

**cpu_profiling_summary_tree** . Table summarising the callstacks captured during any CPU profiling which occurred during the trace. Specifically, this table returns a tree containing all the callstacks seen during the trace with `self_count` equal to the number of samples with that frame as the leaf and `cumulative_count` equal to the number of samples with the frame anywhere in the tree. The data sources supported are the same as the `cpu_profiling_samples` table.

<br />

TABLE
Table summarising the callstacks captured during any CPU profiling which
occurred during the trace.

Specifically, this table returns a tree containing all the callstacks seen
during the trace with `self_count` equal to the number of samples with that
frame as the leaf and `cumulative_count` equal to the number of samples with
the frame anywhere in the tree.

The data sources supported are the same as the `cpu_profiling_samples` table.

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the callstack; by callstack we mean a unique set of frames up to the root frame. |
| parent_id | INT | The id of the parent callstack for this callstack. NULL if this is root. |
| name | STRING | The function name of the frame for this callstack. |
| mapping_name | STRING | The name of the mapping containing the frame. This can be a native binary, library, JAR or APK. |
| source_file | STRING | The name of the file containing the function. |
| line_number | INT | The line number in the file the function is located at. |
| self_count | INT | The number of samples with this function as the leaf frame. |
| cumulative_count | INT | The number of samples with this function appearing anywhere on the callstack. |

<br />

<br />

## Package: pkvm

### pkvm.hypervisor

#### Views/Tables

<br />

**pkvm_hypervisor_events**. Events when CPU entered hypervisor.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| slice_id | INT | Id of the corresponding slice in slices table. |
| cpu | INT | CPU that entered hypervisor. |
| ts | INT | Timestamp when CPU entered hypervisor (in nanoseconds). |
| dur | INT | How much time CPU spent in hypervisor (in nanoseconds). |
| reason | STRING | Reason for entering hypervisor (e.g. host_hcall, host_mem_abort), or NULL if unknown. |

<br />

<br />

## Package: slices

### slices.cpu_time

#### Views/Tables

<br />

**thread_slice_cpu_time**. Time each thread slice spent running on CPU. Requires scheduling data to be available in the trace.

<br />

TABLE
Time each thread slice spent running on CPU.
Requires scheduling data to be available in the trace.

| Column | Type | Description |
|---|---|---|
| id | INT | Id of a slice. Alias of `slice.id`. |
| name | STRING | Name of the slice. |
| utid | INT | Id of the thread the slice is running on. Alias of `thread.id`. |
| thread_name | STRING | Name of the thread. |
| upid | INT | Id of the process the slice is running on. Alias of `process.id`. |
| process_name | STRING | Name of the process. |
| cpu_time | INT | Duration of the time the slice was running. |

<br />

<br />

<br />

**thread_slice_cpu_cycles**. CPU cycles per each slice.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Id of a slice. Alias of `slice.id`. |
| name | STRING | Name of the slice. |
| utid | INT | Id of the thread the slice is running on. Alias of `thread.id`. |
| thread_name | STRING | Name of the thread. |
| upid | INT | Id of the process the slice is running on. Alias of `process.id`. |
| process_name | STRING | Name of the process. |
| millicycles | INT | Sum of CPU millicycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |
| megacycles | INT | Sum of CPU megacycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |

<br />

<br />

### slices.with_context

#### Views/Tables

<br />

**thread_slice**. All thread slices with data about thread, thread track and process. Where possible, use available view functions which filter this view.

<br />

VIEW
All thread slices with data about thread, thread track and process.
Where possible, use available view functions which filter this view.

| Column | Type | Description |
|---|---|---|
| id | INT | Alias for `slice.id`. |
| type | STRING | Alias for `slice.type`. |
| ts | INT | Alias for `slice.ts`. |
| dur | INT | Alias for `slice.dur`. |
| category | STRING | Alias for `slice.category`. |
| name | STRING | Alias for `slice.name`. |
| track_id | INT | Alias for `slice.track_id`. |
| track_name | STRING | Alias for `thread_track.name`. |
| thread_name | STRING | Alias for `thread.name`. |
| utid | INT | Alias for `thread.utid`. |
| tid | INT | Alias for `thread.tid`. |
| is_main_thread | BOOL | Alias for `thread.is_main_thread`. |
| process_name | STRING | Alias for `process.name`. |
| upid | INT | Alias for `process.upid`. |
| pid | INT | Alias for `process.pid`. |
| depth | INT | Alias for `slice.depth`. |
| parent_id | INT | Alias for `slice.parent_id`. |
| arg_set_id | INT | Alias for `slice.arg_set_id`. |
| thread_ts | INT | Alias for `slice.thread_ts`. |
| thread_dur | INT | Alias for `slice.thread_dur`. |

<br />

<br />

<br />

**process_slice**. All process slices with data about process track and process. Where possible, use available view functions which filter this view.

<br />

VIEW
All process slices with data about process track and process.
Where possible, use available view functions which filter this view.

| Column | Type | Description |
|---|---|---|
| id | INT | Alias for `slice.id`. |
| type | STRING | Alias for `slice.type`. |
| ts | INT | Alias for `slice.ts`. |
| dur | INT | Alias for `slice.dur`. |
| category | STRING | Alias for `slice.category`. |
| name | STRING | Alias for `slice.name`. |
| track_id | INT | Alias for `slice.track_id`. |
| track_name | STRING | Alias for `process_track.name`. |
| process_name | STRING | Alias for `process.name`. |
| upid | INT | Alias for `process.upid`. |
| pid | INT | Alias for `process.pid`. |
| depth | INT | Alias for `slice.depth`. |
| parent_id | INT | Alias for `slice.parent_id`. |
| arg_set_id | INT | Alias for `slice.arg_set_id`. |
| thread_ts | INT | Alias for `slice.thread_ts`. |
| thread_dur | INT | Alias for `slice.thread_dur`. |

<br />

<br />

## Package: sched

### sched.runnable

#### Views/Tables

<br />

**sched_previous_runnable_on_thread**. Previous runnable slice on the same thread. For each "Running" thread state finds: - previous "Runnable" (or runnable preempted) state. - previous uninterrupted "Runnable" state with a valid waker thread.

<br />

TABLE
Previous runnable slice on the same thread.
For each "Running" thread state finds:
- previous "Runnable" (or runnable preempted) state.
- previous uninterrupted "Runnable" state with a valid waker thread.

| Column | Type | Description |
|---|---|---|
| id | INT | `thread_state.id` id. |
| prev_runnable_id | INT | Previous runnable `thread_state.id`. |
| prev_wakeup_runnable_id | INT | Previous runnable `thread_state.id` with valid waker thread. |

<br />

<br />

### sched.states

#### Functions

<br />

**sched_state_to_human_readable_string** -\> STRING. Translates a single-letter scheduling state to a human-readable string.

<br />

<br />

<br />

Returns STRING: Humanly readable string representing the scheduling state of the kernel thread. The individual characters in the string mean the following: R (runnable), S (awaiting a wakeup), D (in an uninterruptible sleep), T (suspended), t (being traced), X (exiting), P (parked), W (waking), I (idle), N (not contributing to the load average), K (wakeable on fatal signals) and Z (zombie, awaiting cleanup).

| Argument | Type | Description |
|---|---|---|
| short_name | STRING | An individual character string representing the scheduling state of the kernel thread at the end of the slice. |

<br />

<br />

<br />

**sched_state_io_to_human_readable_string** -\> STRING. Translates a single-letter scheduling state and IO wait information to a human-readable string.

<br />

<br />

<br />

Translates a single-letter scheduling state and IO wait information to
a human-readable string.
Returns STRING: A human readable string with information about the scheduling state and IO wait.

| Argument | Type | Description |
|---|---|---|
| sched_state | STRING | An individual character string representing the scheduling state of the kernel thread at the end of the slice. |
| io_wait | BOOL | A (posssibly NULL) boolean indicating, if the device was in uninterruptible sleep, if it was an IO sleep. |

<br />

<br />

### sched.thread_level_parallelism

#### Views/Tables

<br />

**sched_runnable_thread_count**. The count of runnable threads over time.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp when the runnable thread count changed to the current value. |
| runnable_thread_count | INT | Number of runnable threads, covering the range from this timestamp to the next row's timestamp. |

<br />

<br />

<br />

**sched_active_cpu_count**. The count of active CPUs over time.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp when the number of active CPU changed. |
| active_cpu_count | INT | Number of active CPUs, covering the range from this timestamp to the next row's timestamp. |

<br />

<br />

### sched.time_in_state

#### Views/Tables

<br />

**sched_time_in_state_for_thread**. The time a thread spent in each scheduling state during it's lifetime.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| utid | INT | Utid of the thread. |
| total_runtime | INT | Total runtime of thread. |
| state | STRING | One of the scheduling states of kernel thread. |
| time_in_state | INT | Total time spent in the scheduling state. |
| percentage_in_state | INT | Percentage of time thread spent in scheduling state in \[0-100\] range. |

<br />

<br />

<br />

**sched_percentage_of_time_in_state**. Summary of time spent by thread in each scheduling state, in percentage (\[0, 100\] ranges)

<br />

TABLE
Summary of time spent by thread in each scheduling state, in percentage (\[0, 100\]
ranges). Sum of all states might be smaller than 100, as those values
are rounded down.

| Column | Type | Description |
|---|---|---|
| utid | INT | Utid of the thread. |
| running | INT | Percentage of time thread spent in running ('Running') state in \[0, 100\] range. |
| runnable | INT | Percentage of time thread spent in runnable ('R') state in \[0, 100\] range. |
| runnable_preempted | INT | Percentage of time thread spent in preempted runnable ('R+') state in \[0, 100\] range. |
| sleeping | INT | Percentage of time thread spent in sleeping ('S') state in \[0, 100\] range. |
| uninterruptible_sleep | INT | Percentage of time thread spent in uninterruptible sleep ('D') state in \[0, 100\] range. |
| other | INT | Percentage of time thread spent in other ('T', 't', 'X', 'Z', 'x', 'I', 'K', 'W', 'P', 'N') states in \[0, 100\] range. |

<br />

<br />

#### Table Functions

<br />

**sched_time_in_state_for_thread_in_interval** . Time the thread spent each state in a given interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | The start of the interval. |
| dur | INT | The duration of the interval. |
| utid | INT | The utid of the thread. |

| Column | Type | Description |
|---|---|---|
| state | INT | Thread state (from the `thread_state` table). Use `sched_state_to_human_readable_string` function to get full name. |
| io_wait | BOOL | A (posssibly NULL) boolean indicating, if the device was in uninterruptible sleep, if it was an IO sleep. |
| blocked_function | INT | Some states can specify the blocked function. Usually NULL. |
| dur | INT | Total time spent with this state, cpu and blocked function. |

<br />

<br />

<br />

**sched_time_in_state_and_cpu_for_thread_in_interval** . Time the thread spent each state and cpu in a given interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | The start of the interval. |
| dur | INT | The duration of the interval. |
| utid | INT | The utid of the thread. |

| Column | Type | Description |
|---|---|---|
| state | INT | Thread state (from the `thread_state` table). Use `sched_state_to_human_readable_string` function to get full name. |
| io_wait | BOOL | A (posssibly NULL) boolean indicating, if the device was in uninterruptible sleep, if it was an IO sleep. |
| cpu | INT | Id of the CPU. |
| blocked_function | INT | Some states can specify the blocked function. Usually NULL. |
| dur | INT | Total time spent with this state, cpu and blocked function. |

<br />

<br />

<br />

**sched_time_in_state_for_cpu_in_interval** . Time spent by CPU in each scheduling state in a provided interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| cpu | INT | CPU id. |
| ts | INT | Interval start. |
| dur | INT | Interval duration. |

| Column | Type | Description |
|---|---|---|
| end_state | STRING | End state. From `sched.end_state`. |
| dur | INT | Duration in state. |

<br />

<br />

## Package: intervals

### intervals.overlap

#### Macros

<br />

**intervals_overlap_count** . Compute the distribution of the overlap of the given intervals over time. Each interval is a (ts, dur) pair and the overlap represented as a (ts, value) counter, with the value corresponding to the number of intervals that overlap the given timestamp and interval until the next timestamp.

<br />

<br />

<br />

Compute the distribution of the overlap of the given intervals over time.

Each interval is a (ts, dur) pair and the overlap represented as a (ts, value)
counter, with the value corresponding to the number of intervals that overlap
the given timestamp and interval until the next timestamp.
Returns: TableOrSubquery, The returned table has the schema (ts INT64, value UINT32). \|ts\| is the timestamp when the number of open segments changed. \|value\| is the number of open segments.

| Argument | Type | Description |
|---|---|---|
| segments | TableOrSubquery | Table or subquery containing interval data. |
| ts_column | ColumnName | Column containing interval starts (usually `ts`). |
| dur_column | ColumnName | Column containing interval durations (usually `dur`). |

<br />

<br />

## Package: time

### time.conversion

#### Functions

<br />

**time_from_ns** -\> INT. Returns the provided nanosecond duration, which is the default representation of time durations in trace processor

<br />

<br />

<br />

Returns the provided nanosecond duration, which is the default
representation of time durations in trace processor. Provided for
consistency with other functions.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_from_us** -\> INT. Converts a duration in microseconds to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in microseconds to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| micros | INT | Time duration in microseconds. |

<br />

<br />

<br />

**time_from_ms** -\> INT. Converts a duration in millseconds to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in millseconds to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| millis | INT | Time duration in milliseconds. |

<br />

<br />

<br />

**time_from_s** -\> INT. Converts a duration in seconds to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in seconds to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| seconds | INT | Time duration in seconds. |

<br />

<br />

<br />

**time_from_min** -\> INT. Converts a duration in minutes to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in minutes to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| minutes | INT | Time duration in minutes. |

<br />

<br />

<br />

**time_from_hours** -\> INT. Converts a duration in hours to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in hours to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| hours | INT | Time duration in hours. |

<br />

<br />

<br />

**time_from_days** -\> INT. Converts a duration in days to nanoseconds, which is the default representation of time durations in trace processor.

<br />

<br />

<br />

Converts a duration in days to nanoseconds, which is the default
representation of time durations in trace processor.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| days | INT | Time duration in days. |

<br />

<br />

<br />

**time_to_ns** -\> INT. Returns the provided nanosecond duration, which is the default representation of time durations in trace processor

<br />

<br />

<br />

Returns the provided nanosecond duration, which is the default
representation of time durations in trace processor. Provided for
consistency with other functions.
Returns INT: Time duration in nanoseconds.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_us** -\> INT. Converts a duration in nanoseconds to microseconds

<br />

<br />

<br />

Converts a duration in nanoseconds to microseconds. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in microseconds.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_ms** -\> INT. Converts a duration in nanoseconds to millseconds

<br />

<br />

<br />

Converts a duration in nanoseconds to millseconds. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in milliseconds.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_s** -\> INT. Converts a duration in nanoseconds to seconds

<br />

<br />

<br />

Converts a duration in nanoseconds to seconds. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in seconds.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_min** -\> INT. Converts a duration in nanoseconds to minutes

<br />

<br />

<br />

Converts a duration in nanoseconds to minutes. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in minutes.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_hours** -\> INT. Converts a duration in nanoseconds to hours

<br />

<br />

<br />

Converts a duration in nanoseconds to hours. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in hours.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

<br />

**time_to_days** -\> INT. Converts a duration in nanoseconds to days

<br />

<br />

<br />

Converts a duration in nanoseconds to days. Nanoseconds is the default
representation of time durations in trace processor.
Returns INT: Time duration in days.

| Argument | Type | Description |
|---|---|---|
| nanos | INT | Time duration in nanoseconds. |

<br />

<br />

## Package: linux

### linux.cpu.frequency

#### Views/Tables

<br />

**cpu_frequency_counters**. Counter information for each frequency change for each CPU

<br />

TABLE
Counter information for each frequency change for each CPU. Finds each time
region where a CPU frequency is constant.

| Column | Type | Description |
|---|---|---|
| id | INT | Counter id. |
| track_id | INT | Joinable with 'counter_track.id'. |
| ts | LONG | Starting timestamp of the counter |
| dur | INT | Duration in which counter is constant and frequency doesn't change. |
| freq | INT | Frequency in kHz of the CPU that corresponds to this counter. NULL if not found or undefined. |
| ucpu | INT | Unique CPU id. |
| cpu | INT | CPU that corresponds to this counter. |

<br />

<br />

### linux.cpu.idle

#### Views/Tables

<br />

**cpu_idle_counters**. Counter information for each idle state change for each CPU

<br />

TABLE
Counter information for each idle state change for each CPU. Finds each time
region where a CPU idle state is constant.

| Column | Type | Description |
|---|---|---|
| id | INT | Counter id. |
| track_id | INT | Joinable with 'counter_track.id'. |
| ts | LONG | Starting timestamp of the counter. |
| dur | INT | Duration in which the counter is contant and idle state doesn't change. |
| idle | INT | Idle state of the CPU that corresponds to this counter. An idle state of -1 is defined to be active state for the CPU, and the larger the integer, the deeper the idle state of the CPU. NULL if not found or undefined. |
| cpu | INT | CPU that corresponds to this counter. |

<br />

<br />

### linux.cpu.idle_stats

#### Views/Tables

<br />

**cpu_idle_stats**. Aggregates cpu idle statistics per core.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| cpu | INT | CPU core number. |
| state | INT | CPU idle state (C-states). |
| count | INT | The count of entering idle state. |
| dur | INT | Total CPU core idle state duration in nanoseconds. |
| avg_dur | INT | Average CPU core idle state duration in nanoseconds. |
| idle_percent | FLOAT | Idle state percentage of non suspend time (C-states + P-states). |

<br />

<br />

### linux.cpu.idle_time_in_state

#### Views/Tables

<br />

**cpu_idle_time_in_state_counters**. Counter information for sysfs cpuidle states. Tracks the percentage of time spent in each state between two timestamps, by dividing the incremental time spent in one state, by time all CPUS spent in any state.

<br />

TABLE
Counter information for sysfs cpuidle states.
Tracks the percentage of time spent in each state between two timestamps, by
dividing the incremental time spent in one state, by time all CPUS spent in
any state.

| Column | Type | Description |
|---|---|---|
| ts | LONG | Timestamp. |
| state_name | STRING | State name. |
| idle_percentage | DOUBLE | Percentage of time all CPUS spent in this state. |
| total_residency | DOUBLE | Incremental time spent in this state (residency), in microseconds. |
| time_slice | INT | Time all CPUS spent in any state, in microseconds. |

<br />

<br />

### linux.cpu.utilization.process

#### Views/Tables

<br />

**cpu_cycles_per_process**. Aggregated CPU statistics for each process.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| upid | INT | Unique process id |
| millicycles | INT | Sum of CPU millicycles |
| megacycles | INT | Sum of CPU megacycles |
| runtime | INT | Total runtime duration |
| min_freq | INT | Minimum CPU frequency in kHz |
| max_freq | INT | Maximum CPU frequency in kHz |
| avg_freq | INT | Average CPU frequency in kHz |

<br />

<br />

#### Table Functions

<br />

**cpu_process_utilization_per_period** . Returns a table of process utilization per given period. Utilization is calculated as sum of average utilization of each CPU in each period, which is defined as a multiply of \|interval\|

<br />

<br />

<br />

Returns a table of process utilization per given period.
Utilization is calculated as sum of average utilization of each CPU in each
period, which is defined as a multiply of \|interval\|. For this reason
first and last period might have lower then real utilization.
Argument \| Type \| Description
--- \| --- \| ---
interval \| INT \| Length of the period on which utilization should be averaged.
upid \| INT \| Upid of the process.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_process_utilization_per_second** . Returns a table of process utilization per second. Utilization is calculated as sum of average utilization of each CPU in each period, which is defined as a multiply of \|interval\|

<br />

<br />

<br />

Returns a table of process utilization per second.
Utilization is calculated as sum of average utilization of each CPU in each
period, which is defined as a multiply of \|interval\|. For this reason
first and last period might have lower then real utilization.
Argument \| Type \| Description
--- \| --- \| ---
upid \| INT \| Upid of the process.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_cycles_per_process_in_interval** . Aggregated CPU statistics for each process in a provided interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | Start of the interval. |
| dur | INT | Duration of the interval. |

| Column | Type | Description |
|---|---|---|
| upid | INT | Unique process id. Joinable with `process.id`. |
| millicycles | INT | Sum of CPU millicycles |
| megacycles | INT | Sum of CPU megacycles |
| runtime | INT | Total runtime duration |
| min_freq | INT | Minimum CPU frequency in kHz |
| max_freq | INT | Maximum CPU frequency in kHz |
| avg_freq | INT | Average CPU frequency in kHz |

<br />

<br />

### linux.cpu.utilization.slice

#### Views/Tables

<br />

**cpu_cycles_per_thread_slice**. CPU cycles per each slice.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | Id of a slice. Alias of `slice.id`. |
| name | STRING | Name of the slice. |
| utid | INT | Id of the thread the slice is running on. Alias of `thread.id`. |
| thread_name | STRING | Name of the thread. |
| upid | INT | Id of the process the slice is running on. Alias of `process.id`. |
| process_name | STRING | Name of the process. |
| millicycles | INT | Sum of CPU millicycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |
| megacycles | INT | Sum of CPU megacycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |

<br />

<br />

#### Table Functions

<br />

**cpu_cycles_per_thread_slice_in_interval** . CPU cycles per each slice in interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | Start of the interval. |
| dur | INT | Duration of the interval. |

| Column | Type | Description |
|---|---|---|
| id | INT | Id of a slice. Alias of `slice.id`. |
| name | STRING | Name of the slice. |
| utid | INT | Id of the thread the slice is running on. Alias of `thread.id`. |
| thread_name | STRING | Name of the thread. |
| upid | INT | Id of the process the slice is running on. Alias of `process.id`. |
| process_name | STRING | Name of the process. |
| millicycles | INT | Sum of CPU millicycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |
| megacycles | INT | Sum of CPU megacycles. Null if frequency couldn't be fetched for any period during the runtime of the slice. |

<br />

<br />

### linux.cpu.utilization.system

#### Views/Tables

<br />

**cpu_utilization_per_second**. Table with system utilization per second. Utilization is calculated by sum of average utilization of each CPU every second

<br />

TABLE
Table with system utilization per second.
Utilization is calculated by sum of average utilization of each CPU every
second. For this reason first and last second might have lower then real
utilization.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_cycles**. Aggregated CPU statistics for whole trace

<br />

TABLE
Aggregated CPU statistics for whole trace. Results in only one row.

| Column | Type | Description |
|---|---|---|
| millicycles | INT | Sum of CPU millicycles. |
| megacycles | INT | Sum of CPU megacycles. |
| runtime | INT | Total runtime of all threads running on all CPUs. |
| min_freq | INT | Minimum CPU frequency in kHz. |
| max_freq | INT | Maximum CPU frequency in kHz. |
| avg_freq | INT | Average CPU frequency in kHz. |

<br />

<br />

<br />

**cpu_cycles_per_cpu**. Aggregated CPU statistics for each CPU.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| ucpu | INT | Unique CPU id. Joinable with `cpu.id`. |
| cpu | INT | The number of the CPU. Might not be the same as ucpu in multi machine cases. |
| millicycles | INT | Sum of CPU millicycles. |
| megacycles | INT | Sum of CPU megacycles. |
| runtime | INT | Total runtime of all threads running on CPU. |
| min_freq | INT | Minimum CPU frequency in kHz. |
| max_freq | INT | Maximum CPU frequency in kHz. |
| avg_freq | INT | Average CPU frequency in kHz. |

<br />

<br />

#### Table Functions

<br />

**cpu_utilization_per_period** . Returns a table of system utilization per given period. Utilization is calculated as sum of average utilization of each CPU in each period, which is defined as a multiply of \|interval\|

<br />

<br />

<br />

Returns a table of system utilization per given period.
Utilization is calculated as sum of average utilization of each CPU in each
period, which is defined as a multiply of \|interval\|. For this reason
first and last period might have lower then real utilization.
Argument \| Type \| Description
--- \| --- \| ---
interval \| INT \| Length of the period on which utilization should be averaged.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_cycles_in_interval** . Aggregated CPU statistics in a provided interval

<br />

<br />

<br />

Aggregated CPU statistics in a provided interval. Results in one row.
Argument \| Type \| Description
--- \| --- \| ---
ts \| INT \| Start of the interval.
dur \| INT \| Duration of the interval.

| Column | Type | Description |
|---|---|---|
| millicycles | INT | Sum of CPU millicycles. |
| megacycles | INT | Sum of CPU megacycles. |
| runtime | INT | Total runtime of all threads running on all CPUs. |
| min_freq | INT | Minimum CPU frequency in kHz. |
| max_freq | INT | Maximum CPU frequency in kHz. |
| avg_freq | INT | Average CPU frequency in kHz. |

<br />

<br />

<br />

**cpu_cycles_per_cpu_in_interval** . Aggregated CPU statistics for each CPU in a provided interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | Start of the interval. |
| dur | INT | Duration of the interval. |

| Column | Type | Description |
|---|---|---|
| ucpu | INT | Unique CPU id. Joinable with `cpu.id`. |
| cpu | INT | CPU number. |
| millicycles | INT | Sum of CPU millicycles. |
| megacycles | INT | Sum of CPU megacycles. |
| runtime | INT | Total runtime of all threads running on CPU. |
| min_freq | INT | Minimum CPU frequency in kHz. |
| max_freq | INT | Maximum CPU frequency in kHz. |
| avg_freq | INT | Average CPU frequency in kHz. |

<br />

<br />

### linux.cpu.utilization.thread

#### Views/Tables

<br />

**cpu_cycles_per_thread**. Aggregated CPU statistics for each thread.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| utid | INT | Unique thread id |
| millicycles | INT | Sum of CPU millicycles |
| megacycles | INT | Sum of CPU megacycles |
| runtime | INT | Total runtime duration |
| min_freq | INT | Minimum CPU frequency in kHz |
| max_freq | INT | Maximum CPU frequency in kHz |
| avg_freq | INT | Average CPU frequency in kHz |

<br />

<br />

#### Table Functions

<br />

**cpu_thread_utilization_per_period** . Returns a table of thread utilization per given period. Utilization is calculated as sum of average utilization of each CPU in each period, which is defined as a multiply of \|interval\|

<br />

<br />

<br />

Returns a table of thread utilization per given period.
Utilization is calculated as sum of average utilization of each CPU in each
period, which is defined as a multiply of \|interval\|. For this reason
first and last period might have lower then real utilization.
Argument \| Type \| Description
--- \| --- \| ---
interval \| INT \| Length of the period on which utilization should be averaged.
utid \| INT \| Utid of the thread.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_thread_utilization_per_second** . Returns a table of thread utilization per second. Utilization is calculated as sum of average utilization of each CPU in each period, which is defined as a multiply of \|interval\|

<br />

<br />

<br />

Returns a table of thread utilization per second.
Utilization is calculated as sum of average utilization of each CPU in each
period, which is defined as a multiply of \|interval\|. For this reason
first and last period might have lower then real utilization.
Argument \| Type \| Description
--- \| --- \| ---
utid \| INT \| Utid of the thread.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp of start of a second. |
| utilization | DOUBLE | Sum of average utilization over period. Note: as the data is normalized, the values will be in the \[0, 1\] range. |
| unnormalized_utilization | DOUBLE | Sum of average utilization over all CPUs over period. Note: as the data is unnormalized, the values will be in the \[0, cpu_count\] range. |

<br />

<br />

<br />

**cpu_cycles_per_thread_in_interval** . Aggregated CPU statistics for each thread in a provided interval.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| ts | INT | Start of the interval. |
| dur | INT | Duration of the interval. |

| Column | Type | Description |
|---|---|---|
| utid | INT | Unique thread id. Joinable with `thread.id`. |
| millicycles | INT | Sum of CPU millicycles |
| megacycles | INT | Sum of CPU megacycles |
| runtime | INT | Total runtime duration |
| min_freq | INT | Minimum CPU frequency in kHz |
| max_freq | INT | Maximum CPU frequency in kHz |
| avg_freq | INT | Average CPU frequency in kHz |

<br />

<br />

### linux.devfreq

#### Views/Tables

<br />

**linux_devfreq_dsu_counter**. ARM DSU device frequency counters

<br />

TABLE
ARM DSU device frequency counters. This table will only be populated on
traces collected with "devfreq/devfreq_frequency" ftrace event enabled,
and from ARM devices with the DSU (DynamIQ Shared Unit) hardware.

| Column | Type | Description |
|---|---|---|
| id | INT | Unique identifier for this counter. |
| ts | LONG | Starting timestamp of the counter. |
| dur | INT | Duration in which counter is constant and frequency doesn't chamge. |
| dsu_freq | INT | Frequency in kHz of the device that corresponds to the counter. |

<br />

<br />

#### Table Functions

<br />

**linux_get_devfreq_counters** . Gets devfreq frequency counter based on device queried

<br />

<br />

<br />

Gets devfreq frequency counter based on device queried. These counters will
only be available if the "devfreq/devfreq_frequency" ftrace event is enabled.
Argument \| Type \| Description
--- \| --- \| ---
device_name \| STRING \| Devfreq name to query for.

| Column | Type | Description |
|---|---|---|
| id | INT | Unique identifier for this counter. |
| ts | LONG | Starting timestamp of the counter. |
| dur | INT | Duration in which counter is constant and frequency doesn't chamge. |
| freq | INT | Frequency in kHz of the device that corresponds to the counter. |

<br />

<br />

### linux.memory.high_watermark

#### Views/Tables

<br />

**memory_rss_high_watermark_per_process**. For each process fetches the memory high watermark until or during timestamp.

<br />

VIEW
For each process fetches the memory high watermark until or during
timestamp.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp |
| dur | INT | Duration |
| upid | INT | Upid of the process |
| pid | INT | Pid of the process |
| process_name | STRING | Name of the process |
| rss_high_watermark | INT | Maximum `rss` value until now |

<br />

<br />

### linux.memory.process

#### Views/Tables

<br />

**memory_rss_and_swap_per_process**. Memory metrics timeline for each process.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp |
| dur | INT | Duration |
| upid | INT | Upid of the process |
| pid | INT | Pid of the process |
| process_name | STRING | Name of the process |
| anon_rss | INT | Anon RSS counter value |
| file_rss | INT | File RSS counter value |
| shmem_rss | INT | Shared memory RSS counter value |
| rss | INT | Total RSS value. Sum of `anon_rss`, `file_rss` and `shmem_rss`. Returns value even if one of the values is NULL. |
| swap | INT | Swap counter value |
| anon_rss_and_swap | INT | Sum or `anon_rss` and `swap`. Returns value even if one of the values is NULL. |
| rss_and_swap | INT | Sum or `rss` and `swap`. Returns value even if one of the values is NULL. |

<br />

<br />

### linux.perf.samples

#### Views/Tables

<br />

**linux_perf_samples_summary_tree** . Table summarising the callstacks captured during all perf samples in the trace. Specifically, this table returns a tree containing all the callstacks seen during the trace with `self_count` equal to the number of samples with that frame as the leaf and `cumulative_count` equal to the number of samples with the frame anywhere in the tree.

<br />

TABLE
Table summarising the callstacks captured during all
perf samples in the trace.

Specifically, this table returns a tree containing all
the callstacks seen during the trace with `self_count`
equal to the number of samples with that frame as the
leaf and `cumulative_count` equal to the number of
samples with the frame anywhere in the tree.

| Column | Type | Description |
|---|---|---|
| id | INT | The id of the callstack. A callstack in this context is a unique set of frames up to the root. |
| parent_id | INT | The id of the parent callstack for this callstack. |
| name | STRING | The function name of the frame for this callstack. |
| mapping_name | STRING | The name of the mapping containing the frame. This can be a native binary, library, JAR or APK. |
| source_file | STRING | The name of the file containing the function. |
| line_number | INT | The line number in the file the function is located at. |
| self_count | INT | The number of samples with this function as the leaf frame. |
| cumulative_count | INT | The number of samples with this function appearing anywhere on the callstack. |

<br />

<br />

### linux.perf.spe

#### Views/Tables

<br />

**linux_perf_spe_record**. Contains ARM Statistical Profiling Extension records

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| ts | LONG | Timestap when the operation was sampled |
| utid | INT | Thread the operation executed in |
| exception_level | STRING | Exception level the instruction was executed in |
| instruction_frame_id | INT | Instruction virtual address |
| operation | STRING | Type of operation sampled |
| data_virtual_address | LONG | The virtual address accessed by the operation (0 if no memory access was performed) |
| data_physical_address | LONG | The physical address accessed by the operation (0 if no memory access was performed) |
| total_latency | INT | Cycle count from the operation being dispatched for issue to the operation being complete. |
| issue_latency | INT | Cycle count from the operation being dispatched for issue to the operation being issued for execution. |
| translation_latency | INT | Cycle count from a virtual address being passed to the MMU for translation to the result of the translation being available. |
| data_source | STRING | Where the data returned for a load operation was sourced |
| exception_gen | BOOL | Operation generated an exception |
| retired | BOOL | Operation architecturally retired |
| l1d_access | BOOL | Operation caused a level 1 data cache access |
| l1d_refill | BOOL | Operation caused a level 1 data cache refill |
| tlb_access | BOOL | Operation caused a TLB access |
| tlb_refill | BOOL | Operation caused a TLB refill involving at least one translation table walk |
| not_taken | BOOL | Conditional instruction failed its condition code check |
| mispred | BOOL | Whether a branch caused a correction to the predicted program flow |
| llc_access | BOOL | Operation caused a last level data or unified cache access |
| llc_refill | BOOL | Whether the operation could not be completed by the last level data cache (or any above) |
| remote_access | BOOL | Operation caused an access to another socket in a multi-socket system |
| alignment | BOOL | Operation that incurred additional latency due to the alignment of the address and the size of the data being accessed |
| tme_transaction | BOOL | Whether the operation executed in transactional state |
| sve_partial_pred | BOOL | SVE or SME operation with at least one false element in the governing predicate(s) |
| sve_empty_pred | BOOL | SVE or SME operation with no true element in the governing predicate(s) |
| l2d_access | BOOL | Whether a load operation caused a cache access to at least the level 2 data or unified cache |
| l2d_hit | BOOL | Whether a load operation accessed and missed the level 2 data or unified cache. Not set for accesses that are satisfied from refilling data of a previous miss |
| cache_data_modified | BOOL | Whether a load operation accessed modified data in a cache |
| recenty_fetched | BOOL | Wheter a load operation hit a recently fetched line in a cache |
| data_snooped | BOOL | Whether a load operation snooped data from a cache outside the cache hierarchy of this core |

<br />

<br />

### linux.threads

#### Views/Tables

<br />

**linux_kernel_threads**. All kernel threads of the trace

<br />

TABLE
All kernel threads of the trace. As kernel threads are processes, provides
also process data.

| Column | Type | Description |
|---|---|---|
| upid | INT | Upid of kernel thread. Alias of \|process.upid\|. |
| utid | INT | Utid of kernel thread. Alias of \|thread.utid\|. |
| pid | INT | Pid of kernel thread. Alias of \|process.pid\|. |
| tid | INT | Tid of kernel thread. Alias of \|process.pid\|. |
| process_name | STRING | Name of kernel process. Alias of \|process.name\|. |
| thread_name | STRING | Name of kernel thread. Alias of \|thread.name\|. |
| machine_id | INT | Machine id of kernel thread. If NULL then it's a single machine trace. Alias of \|process.machine_id\|. |

<br />

<br />

## Package: android

### android.anrs

#### Views/Tables

<br />

**android_anrs**. List of all ANRs that occurred in the trace (one row per ANR).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| process_name | STRING | Name of the process that triggered the ANR. |
| pid | INT | PID of the process that triggered the ANR. |
| upid | INT | UPID of the process that triggered the ANR. |
| error_id | STRING | UUID of the ANR (generated on the platform). |
| ts | INT | Timestamp of the ANR. |
| subject | STRING | Subject line of the ANR. |

<br />

<br />

### android.app_process_starts

#### Views/Tables

<br />

**android_app_process_starts**. All app cold starts with information about their cold start reason: broadcast, service, activity or provider.

<br />

TABLE
All app cold starts with information about their cold start reason:
broadcast, service, activity or provider.

| Column | Type | Description |
|---|---|---|
| start_id | INT | Slice id of the bindApplication slice in the app. Uniquely identifies a process start. |
| id | INT | Slice id of intent received in the app. |
| track_id | INT | Track id of the intent received in the app. |
| process_name | STRING | Name of the process receiving the intent. |
| pid | INT | Pid of the process receiving the intent. |
| upid | INT | Upid of the process receiving the intent. |
| intent | STRING | Intent action or component responsible for the cold start. |
| reason | STRING | Process start reason: activity, broadcast, service or provider. |
| proc_start_ts | INT | Timestamp the process start was dispatched from system_server. |
| proc_start_dur | INT | Duration to dispatch the process start from system_server. |
| bind_app_ts | INT | Timestamp the bindApplication started in the app. |
| bind_app_dur | INT | Duration to complete bindApplication in the app. |
| intent_ts | INT | Timestamp the Intent was received in the app. |
| intent_dur | INT | Duration to handle intent in the app. |
| total_dur | INT | Total duration from proc_start dispatched to intent completed. |

<br />

<br />

### android.auto.multiuser

#### Views/Tables

<br />

**android_auto_multiuser_timing**. Time elapsed between the latest user start and the specific end event like package startup(ex carlauncher) or previous user stop.

<br />

TABLE
Time elapsed between the latest user start
and the specific end event
like package startup(ex carlauncher) or previous user stop.

| Column | Type | Description |
|---|---|---|
| event_start_user_id | STRING | Id of the started android user |
| event_start_time | INT | Start event time |
| event_end_time | INT | End event time |
| event_end_name | STRING | End event name |
| event_start_name | STRING | Start event name |
| duration | LONG | User switch duration from start event to end event |

<br />

<br />

<br />

**android_auto_multiuser_timing_with_previous_user_resource_usage** . This table extends `android_auto_multiuser_timing` table with previous user resource usage.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| event_start_user_id | STRING | Start user id |
| event_start_time | INT | Start event time |
| event_end_time | INT | End event time |
| event_end_name | STRING | End event name |
| event_start_name | STRING | Start event name |
| duration | LONG | User switch duration from start event to end event |
| user_id | INT | User id |
| total_cpu_time | LONG | Total CPU time for a user |
| total_memory_usage_kb | LONG | Total memory user for a user |

<br />

<br />

### android.battery

#### Views/Tables

<br />

**android_battery_charge**. Battery charge at timestamp.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp. |
| current_avg_ua | DOUBLE | Current average micro ampers. |
| capacity_percent | DOUBLE | Current capacity percentage. |
| charge_uah | DOUBLE | Current charge in micro ampers. |
| current_ua | DOUBLE | Current micro ampers. |

<br />

<br />

### android.battery_stats

#### Views/Tables

<br />

**android_battery_stats_state**. View of human readable battery stats counter-based states

<br />

VIEW
View of human readable battery stats counter-based states. These are recorded
by BatteryStats as a bitmap where each 'category' has a unique value at any
given time.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp in nanoseconds. |
| dur | INT | The duration the state was active, may be negative for incomplete slices. |
| safe_dur | INT | The same as `dur`, but extends to trace end for incomplete slices. |
| track_name | STRING | The name of the counter track. |
| value | INT | The counter value as a number. |
| value_name | STRING | The counter value as a human-readable string. |

<br />

<br />

<br />

**android_battery_stats_event_slices**. View of slices derived from battery_stats events

<br />

VIEW
View of slices derived from battery_stats events. Battery stats records all
events as instants, however some may indicate whether something started or
stopped with a '+' or '-' prefix. Events such as jobs, top apps, foreground
apps or long wakes include these details and allow drawing slices between
instant events found in a trace.

For example, we may see an event like the following on 'battery_stats.top':

     -top=10215:"com.google.android.apps.nexuslauncher"

This view will find the associated start ('+top') with the matching suffix
(everything after the '=') to construct a slice. It computes the timestamp
and duration from the events and extract the details as follows:

     track_name='battery_stats.top'
     str_value='com.google.android.apps.nexuslauncher'
     int_value=10215

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp in nanoseconds. |
| dur | INT | The duration the state was active, may be negative for incomplete slices. |
| safe_dur | INT | The same as `dur`, but extends to trace end for incomplete slices. |
| track_name | STRING | The name of the counter track. |
| str_value | STRING | String value. |
| int_value | INT | Int value. |

<br />

<br />

#### Functions

<br />

**android_battery_stats_counter_to_string** -\> STRING. Converts a battery_stats counter value to human readable string.

<br />

<br />

<br />

Returns STRING: The human-readable name for the counter value.

| Argument | Type | Description |
|---|---|---|
| track | STRING | The counter track name (e.g. 'battery_stats.audio'). |
| value | FLOAT | The counter value. |

<br />

<br />

### android.binder

#### Views/Tables

<br />

**android_binder_metrics_by_process**. Count Binder transactions per process.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| process_name | STRING | Name of the process that started the binder transaction. |
| pid | INT | PID of the process that started the binder transaction. |
| slice_name | STRING | Name of the slice with binder transaction. |
| event_count | INT | Number of binder transactions in process in slice. |

<br />

<br />

<br />

**android_sync_binder_thread_state_by_txn**. Aggregated thread_states on the client and server side per binder txn This builds on the data from \|_sync_binder_metrics_by_txn\| and for each end (client and server) of the transaction, it returns the aggregated sum of all the thread state durations. The \|thread_state_type\| column represents whether a given 'aggregated thread_state' row is on the client or server side

<br />

VIEW
Aggregated thread_states on the client and server side per binder txn
This builds on the data from \|_sync_binder_metrics_by_txn\| and
for each end (client and server) of the transaction, it returns
the aggregated sum of all the thread state durations.
The \|thread_state_type\| column represents whether a given 'aggregated thread_state'
row is on the client or server side. 'binder_txn' is client side and 'binder_reply'
is server side.

| Column | Type | Description |
|---|---|---|
| binder_txn_id | INT | slice id of the binder txn |
| client_ts | INT | Client timestamp |
| client_tid | INT | Client tid |
| binder_reply_id | INT | slice id of the binder reply |
| server_ts | INT | Server timestamp |
| server_tid | INT | Server tid |
| thread_state_type | STRING | whether thread state is on the txn or reply side |
| thread_state | STRING | a thread_state that occurred in the txn |
| thread_state_dur | INT | aggregated dur of the \|thread_state\| in the txn |
| thread_state_count | INT | aggregated count of the \|thread_state\| in the txn |

<br />

<br />

<br />

**android_sync_binder_blocked_functions_by_txn**. Aggregated blocked_functions on the client and server side per binder txn This builds on the data from \|_sync_binder_metrics_by_txn\| and for each end (client and server) of the transaction, it returns the aggregated sum of all the kernel blocked function durations. The \|thread_state_type\| column represents whether a given 'aggregated blocked_function' row is on the client or server side

<br />

VIEW
Aggregated blocked_functions on the client and server side per binder txn
This builds on the data from \|_sync_binder_metrics_by_txn\| and
for each end (client and server) of the transaction, it returns
the aggregated sum of all the kernel blocked function durations.
The \|thread_state_type\| column represents whether a given 'aggregated blocked_function'
row is on the client or server side. 'binder_txn' is client side and 'binder_reply'
is server side.

| Column | Type | Description |
|---|---|---|
| binder_txn_id | INT | slice id of the binder txn |
| client_ts | INT | Client ts |
| client_tid | INT | Client tid |
| binder_reply_id | INT | slice id of the binder reply |
| server_ts | INT | Server ts |
| server_tid | INT | Server tid |
| thread_state_type | STRING | whether thread state is on the txn or reply side |
| blocked_function | STRING | blocked kernel function in a thread state |
| blocked_function_dur | INT | aggregated dur of the \|blocked_function\| in the txn |
| blocked_function_count | INT | aggregated count of the \|blocked_function\| in the txn |

<br />

<br />

<br />

**android_binder_txns**. Breakdown binder transactions per txn. It returns data about the client and server ends of every binder transaction async.

<br />

TABLE
Breakdown binder transactions per txn.
It returns data about the client and server ends of every binder transaction async.

| Column | Type | Description |
|---|---|---|
| aidl_name | STRING | name of the binder interface if existing. |
| aidl_ts | INT | Timestamp the binder interface name was emitted. Proxy to 'ts' and 'dur' for async txns. |
| aidl_dur | INT | Duration of the binder interface name. Proxy to 'ts' and 'dur' for async txns. |
| binder_txn_id | INT | slice id of the binder txn. |
| client_process | STRING | name of the client process. |
| client_thread | STRING | name of the client thread. |
| client_upid | INT | Upid of the client process. |
| client_utid | INT | Utid of the client thread. |
| client_tid | INT | Tid of the client thread. |
| client_pid | INT | Pid of the client thread. |
| is_main_thread | BOOL | Whether the txn was initiated from the main thread of the client process. |
| client_ts | INT | timestamp of the client txn. |
| client_dur | INT | wall clock dur of the client txn. |
| binder_reply_id | INT | slice id of the binder reply. |
| server_process | STRING | name of the server process. |
| server_thread | STRING | name of the server thread. |
| server_upid | INT | Upid of the server process. |
| server_utid | INT | Utid of the server thread. |
| server_tid | INT | Tid of the server thread. |
| server_pid | INT | Pid of the server thread. |
| server_ts | INT | timestamp of the server txn. |
| server_dur | INT | wall clock dur of the server txn. |
| client_oom_score | INT | oom score of the client process at the start of the txn. |
| server_oom_score | INT | oom score of the server process at the start of the reply. |
| is_sync | BOOL | whether the txn is synchronous or async (oneway). |
| client_monotonic_dur | INT | monotonic clock dur of the client txn. |
| server_monotonic_dur | INT | monotonic clock dur of the server txn. |
| client_package_version_code | INT | Client package version_code. |
| server_package_version_code | INT | Server package version_code. |
| is_client_package_debuggable | INT | Whether client package is debuggable. |
| is_server_package_debuggable | INT | Whether server package is debuggable. |

<br />

<br />

#### Table Functions

<br />

**android_binder_outgoing_graph** . Returns a DAG of all outgoing binder txns from a process. The roots of the graph are the threads making the txns and the graph flows from: thread -\> server_process -\> AIDL interface -\> AIDL method. The weights of each node represent the wall execution time in the server_process.

<br />

<br />

<br />

Returns a DAG of all outgoing binder txns from a process.
The roots of the graph are the threads making the txns and the graph flows from:
thread -\> server_process -\> AIDL interface -\> AIDL method.
The weights of each node represent the wall execution time in the server_process.
Argument \| Type \| Description
--- \| --- \| ---
upid \| INT \| Upid of process to generate an outgoing graph for.

| Column | Type | Description |
|---|---|---|
| pprof | BYTES | Pprof of outgoing binder txns. |

<br />

<br />

<br />

**android_binder_incoming_graph** . Returns a DAG of all incoming binder txns from a process. The roots of the graph are the clients making the txns and the graph flows from: client_process -\> AIDL interface -\> AIDL method. The weights of each node represent the wall execution time in the server_process.

<br />

<br />

<br />

Returns a DAG of all incoming binder txns from a process.
The roots of the graph are the clients making the txns and the graph flows from:
client_process -\> AIDL interface -\> AIDL method.
The weights of each node represent the wall execution time in the server_process.
Argument \| Type \| Description
--- \| --- \| ---
upid \| INT \| Upid of process to generate an incoming graph for.

| Column | Type | Description |
|---|---|---|
| pprof | BYTES | Pprof of incoming binder txns. |

<br />

<br />

<br />

**android_binder_graph** . Returns a graph of all binder txns in a trace. The nodes are client_process and server_process. The weights of each node represent the wall execution time in the server_process.

<br />

<br />

<br />

Returns a graph of all binder txns in a trace.
The nodes are client_process and server_process.
The weights of each node represent the wall execution time in the server_process.
Argument \| Type \| Description
--- \| --- \| ---
min_client_oom_score \| INT \| Matches txns from client_processes greater than or equal to the OOM score.
max_client_oom_score \| INT \| Matches txns from client_processes less than or equal to the OOM score.
min_server_oom_score \| INT \| Matches txns to server_processes greater than or equal to the OOM score.
max_server_oom_score \| INT \| Matches txns to server_processes less than or equal to the OOM score.

| Column | Type | Description |
|---|---|---|
| pprof | BYTES | Pprof of binder txns. |

<br />

<br />

### android.binder_breakdown

#### Views/Tables

<br />

**android_binder_server_breakdown**. Server side binder breakdowns per transactions per txn.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| binder_txn_id | INT | Client side id of the binder txn. Alias of `slice.id`. |
| binder_reply_id | INT | Server side id of the binder txn. Alias of `slice.id`. |
| ts | INT | Timestamp of an exclusive interval during the binder reply with a single reason. |
| dur | INT | Duration of an exclusive interval during the binder reply with a single reason. |
| reason | STRING | Cause of delay during an exclusive interval of the binder reply. |

<br />

<br />

<br />

**android_binder_client_breakdown**. Client side binder breakdowns per transactions per txn.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| binder_txn_id | INT | Client side id of the binder txn. Alias of `slice.id`. |
| binder_reply_id | INT | Server side id of the binder txn. Alias of `slice.id`. |
| ts | INT | Timestamp of an exclusive interval during the binder txn with a single latency reason. |
| dur | INT | Duration of an exclusive interval during the binder txn with a single latency reason. |
| reason | STRING | Cause of delay during an exclusive interval of the binder txn. |

<br />

<br />

### android.cpu.cluster_type

#### Views/Tables

<br />

**android_cpu_cluster_mapping**. Stores the mapping of a cpu to its cluster type - e.g

<br />

TABLE
Stores the mapping of a cpu to its cluster type - e.g. little, medium, big.
This cluster type is determined by initially using cpu_capacity from sysfs
and grouping clusters with identical capacities, ordered by size.
In the case that capacities are not present, max frequency is used instead.
If nothing is avaiable, NULL is returned.

| Column | Type | Description |
|---|---|---|
| ucpu | INT | Alias of `cpu.ucpu`. |
| cpu | INT | Alias of `cpu.cpu`. |
| cluster_type | STRING | The cluster type of the CPU. |

<br />

<br />

### android.device

#### Views/Tables

<br />

**android_device_name**. Extract name of the device based on metadata from the trace.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| name | STRING | Device name. |

<br />

<br />

### android.dvfs

#### Views/Tables

<br />

**android_dvfs_counters**. Dvfs counter with duration.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| name | STRING | Counter name. |
| ts | INT | Timestamp when counter value changed. |
| value | DOUBLE | Counter value. |
| dur | INT | Counter duration. |

<br />

<br />

<br />

**android_dvfs_counter_stats**. Aggregates dvfs counter slice for statistic.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| name | STRING | Counter name on which all the other values are aggregated on. |
| max | DOUBLE | Max of all counter values for the counter name. |
| min | DOUBLE | Min of all counter values for the counter name. |
| dur | INT | Duration between the first and last counter value for the counter name. |
| wgt_avg | FLOAT | Weighted avergate of all the counter values for the counter name. |

<br />

<br />

<br />

**android_dvfs_counter_residency**. Aggregates dvfs counter slice for residency

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| name | STRING | Counter name. |
| value | DOUBLE | Counter value. |
| dur | INT | Counter duration. |
| pct | DOUBLE | Counter duration as a percentage of total duration. |

<br />

<br />

### android.frames.jank_type

#### Functions

<br />

**android_is_sf_jank_type** -\> BOOL. Categorizes whether the jank was caused by Surface Flinger

<br />

<br />

<br />

Returns BOOL: True when the jank type represents sf jank

| Argument | Type | Description |
|---|---|---|
| jank_type | STRING | the jank type from args.display_value with key = "Jank type" |

<br />

<br />

<br />

**android_is_app_jank_type** -\> BOOL. Categorizes whether the jank was caused by the app

<br />

<br />

<br />

Returns BOOL: True when the jank type represents app jank

| Argument | Type | Description |
|---|---|---|
| jank_type | STRING | the jank type from args.display_value with key = "Jank type" |

<br />

<br />

### android.frames.per_frame_metrics

#### Views/Tables

<br />

**android_frames_overrun**. The amount by which each frame missed of hit its deadline

<br />

TABLE
The amount by which each frame missed of hit its deadline. Negative if the
deadline was not missed. Frames are considered janky if `overrun` is
positive.
Calculated as the difference between the end of the
`expected_frame_timeline_slice` and `actual_frame_timeline_slice` for the
frame.
Availability: from S (API 31).
For Googlers: more details in go/android-performance-metrics-glossary.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id. |
| overrun | INT | Difference between `expected` and `actual` frame ends. Negative if frame didn't miss deadline. |

<br />

<br />

<br />

**android_frames_ui_time**. How much time did the frame's Choreographer callbacks take.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id |
| ui_time | INT | UI time duration |

<br />

<br />

<br />

**android_app_vsync_delay_per_frame**. App Vsync delay for a frame

<br />

TABLE
App Vsync delay for a frame. The time between the VSYNC-app signal and the
start of Choreographer work.
Calculated as time difference between the actual frame start (from
`actual_frame_timeline_slice`) and start of the `Choreographer#doFrame`
slice.
For Googlers: more details in go/android-performance-metrics-glossary.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id |
| app_vsync_delay | INT | App VSYNC delay. |

<br />

<br />

<br />

**android_cpu_time_per_frame** . How much time did the frame take across the UI Thread + RenderThread. Calculated as sum of `app VSYNC delay` `Choreographer#doFrame` slice duration and summed durations of all `DrawFrame` slices associated with this frame. Availability: from N (API 24). For Googlers: more details in go/android-performance-metrics-glossary.

<br />

TABLE
How much time did the frame take across the UI Thread + RenderThread.
Calculated as sum of `app VSYNC delay` `Choreographer#doFrame` slice
duration and summed durations of all `DrawFrame` slices associated with this
frame.
Availability: from N (API 24).
For Googlers: more details in go/android-performance-metrics-glossary.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id |
| app_vsync_delay | INT | Difference between actual timeline of the frame and `Choreographer#doFrame`. See `android_app_vsync_delay_per_frame` table for more details. |
| do_frame_dur | INT | Duration of `Choreographer#doFrame` slice. |
| draw_frame_dur | INT | Duration of `DrawFrame` slice. Summed duration of all `DrawFrame` slices, if more than one. See `android_frames_draw_frame` for more details. |
| cpu_time | INT | CPU time across the UI Thread + RenderThread. |

<br />

<br />

<br />

**android_frame_stats**. Aggregated stats of the frame. For Googlers: more details in go/android-performance-metrics-glossary.

<br />

TABLE
Aggregated stats of the frame.

For Googlers: more details in go/android-performance-metrics-glossary.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id. |
| overrun | INT | The amount by which each frame missed of hit its deadline. See `android_frames_overrun` for details. |
| cpu_time | INT | How much time did the frame take across the UI Thread + RenderThread. |
| ui_time | INT | How much time did the frame's Choreographer callbacks take. |
| was_jank | BOOL | Was frame janky. |
| was_slow_frame | BOOL | CPU time of the frame took over 20ms. |
| was_big_jank | BOOL | CPU time of the frame took over 50ms. |
| was_huge_jank | BOOL | CPU time of the frame took over 200ms. |

<br />

<br />

### android.frames.timeline

#### Views/Tables

<br />

**android_frames_choreographer_do_frame** . All of the `Choreographer#doFrame` slices with their frame id.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | `slice.id` |
| frame_id | INT | Frame id |
| ui_thread_utid | INT | Utid of the UI thread |
| upid | INT | Upid of application process |
| ts | INT | Timestamp of the slice. |

<br />

<br />

<br />

**android_frames_draw_frame** . All of the `DrawFrame` slices with their frame id and render thread. There might be multiple DrawFrames slices for a single vsync (frame id). This happens when we are drawing multiple layers (e.g

<br />

TABLE
All of the `DrawFrame` slices with their frame id and render thread.
There might be multiple DrawFrames slices for a single vsync (frame id).
This happens when we are drawing multiple layers (e.g. status bar and
notifications).

| Column | Type | Description |
|---|---|---|
| id | INT | `slice.id` |
| frame_id | INT | Frame id |
| render_thread_utid | INT | Utid of the render thread |
| upid | INT | Upid of application process |

<br />

<br />

<br />

**android_frames**. All slices related to one frame

<br />

TABLE
All slices related to one frame. Aggregates `Choreographer#doFrame`,
`DrawFrame`, `actual_frame_timeline_slice` and
`expected_frame_timeline_slice` slices.
See https://perfetto.dev/docs/data-sources/frametimeline for details.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id. |
| ts | INT | Timestamp of the frame. Start of the frame as defined by the start of "Choreographer#doFrame" slice and the same as the start of the frame in \`actual_frame_timeline_slice if present. |
| dur | INT | Duration of the frame, as defined by the duration of the corresponding `actual_frame_timeline_slice` or, if not present the time between the `ts` and the end of the final `DrawFrame`. |
| do_frame_id | INT | `slice.id` of "Choreographer#doFrame" slice. |
| draw_frame_id | INT | `slice.id` of "DrawFrame" slice. |
| actual_frame_timeline_id | INT | `slice.id` from `actual_frame_timeline_slice` |
| expected_frame_timeline_id | INT | `slice.id` from `expected_frame_timeline_slice` |
| render_thread_utid | INT | `utid` of the render thread. |
| ui_thread_utid | INT | `utid` of the UI thread. |
| actual_frame_timeline_count | INT | Count of slices in `actual_frame_timeline_slice` related to this frame. |
| expected_frame_timeline_count | INT | Count of slices in `expected_frame_timeline_slice` related to this frame. |

<br />

<br />

#### Table Functions

<br />

**android_first_frame_after** . Returns first frame after the provided timestamp

<br />

<br />

<br />

Returns first frame after the provided timestamp. The returning table has at
most one row.
Argument \| Type \| Description
--- \| --- \| ---
ts \| INT \| Timestamp.

| Column | Type | Description |
|---|---|---|
| frame_id | INT | Frame id. |
| ts | INT | Start of the frame, the timestamp of the "Choreographer#doFrame" slice. |
| dur | INT | Duration of the frame. |
| do_frame_id | INT | `slice.id` of "Choreographer#doFrame" slice. |
| draw_frame_id | INT | `slice.id` of "DrawFrame" slice. |
| actual_frame_timeline_id | INT | `slice.id` from `actual_frame_timeline_slice` |
| expected_frame_timeline_id | INT | `slice.id` from `expected_frame_timeline_slice` |
| render_thread_utid | INT | `utid` of the render thread. |
| ui_thread_utid | INT | `utid` of the UI thread. |

<br />

<br />

### android.freezer

#### Views/Tables

<br />

**android_freezer_events**. All frozen processes and their frozen duration.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| upid | INT | Upid of frozen process |
| pid | INT | Pid of frozen process |
| ts | INT | Timestamp process was frozen. |
| dur | INT | Duration process was frozen for. |
| unfreeze_reason_int | INT | Unfreeze reason Integer. |
| unfreeze_reason_str | STRING | Unfreeze reason String. |

<br />

<br />

### android.garbage_collection

#### Views/Tables

<br />

**android_garbage_collection_events**. All Garbage collection events with a breakdown of the time spent and heap reclaimed.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| tid | INT | Tid of thread running garbage collection. |
| pid | INT | Pid of process running garbage collection. |
| utid | INT | Utid of thread running garbage collection. |
| upid | INT | Upid of process running garbage collection. |
| thread_name | STRING | Name of thread running garbage collection. |
| process_name | STRING | Name of process running garbage collection. |
| gc_type | STRING | Type of garbage collection. |
| is_mark_compact | INT | Whether gargage collection is mark compact or copying. |
| reclaimed_mb | DOUBLE | MB reclaimed after garbage collection. |
| min_heap_mb | DOUBLE | Minimum heap size in MB during garbage collection. |
| max_heap_mb | DOUBLE | Maximum heap size in MB during garbage collection. |
| gc_id | INT | Garbage collection id. |
| gc_ts | INT | Garbage collection timestamp. |
| gc_dur | INT | Garbage collection wall duration. |
| gc_running_dur | INT | Garbage collection duration spent executing on CPU. |
| gc_runnable_dur | INT | Garbage collection duration spent waiting for CPU. |
| gc_unint_io_dur | INT | Garbage collection duration spent waiting in the Linux kernel on IO. |
| gc_unint_non_io_dur | INT | Garbage collection duration spent waiting in the Linux kernel without IO. |
| gc_int_dur | INT | Garbage collection duration spent waiting in interruptible sleep. |

<br />

<br />

### android.gpu.frequency

#### Views/Tables

<br />

**android_gpu_frequency**. GPU frequency counter per GPU.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp |
| dur | INT | Duration |
| gpu_id | INT | GPU id. Joinable with `gpu_counter_track.gpu_id`. |
| gpu_freq | INT | GPU frequency |

<br />

<br />

### android.gpu.memory

#### Views/Tables

<br />

**android_gpu_memory_per_process**. Counter for GPU memory per process with duration.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp |
| dur | INT | Duration |
| upid | INT | Upid of the process |
| gpu_memory | INT | GPU memory |

<br />

<br />

### android.input

#### Views/Tables

<br />

**android_input_events**. All input events with round trip latency breakdown

<br />

TABLE
All input events with round trip latency breakdown. Input delivery is socket based and every
input event sent from the OS needs to be ACK'ed by the app. This gives us 4 subevents to measure
latencies between:
1. Input dispatch event sent from OS.
2. Input dispatch event received in app.
3. Input ACK event sent from app.
4. Input ACk event received in OS.

| Column | Type | Description |
|---|---|---|
| dispatch_latency_dur | INT | Duration from input dispatch to input received. |
| handling_latency_dur | INT | Duration from input received to input ACK sent. |
| ack_latency_dur | INT | Duration from input ACK sent to input ACK recieved. |
| total_latency_dur | INT | Duration from input dispatch to input event ACK received. |
| end_to_end_latency_dur | INT | Duration from input read to frame present time. Null if an input event has no associated frame event. |
| tid | INT | Tid of thread receiving the input event. |
| thread_name | STRING | Name of thread receiving the input event. |
| pid | INT | Pid of process receiving the input event. |
| process_name | STRING | Name of process receiving the input event. |
| event_type | STRING | Input event type. See InputTransport.h: InputMessage#Type |
| event_action | STRING | Input event action. |
| event_seq | STRING | Input event sequence number, monotonically increasing for an event channel and pid. |
| event_channel | STRING | Input event channel name. |
| input_event_id | STRING | Unique identifier for the input event. |
| read_time | INT | Timestamp input event was read by InputReader. |
| dispatch_track_id | INT | Thread track id of input event dispatching thread. |
| dispatch_ts | INT | Timestamp input event was dispatched. |
| dispatch_dur | INT | Duration of input event dispatch. |
| receive_track_id | INT | Thread track id of input event receiving thread. |
| receive_ts | INT | Timestamp input event was received. |
| receive_dur | INT | Duration of input event receipt. |
| frame_id | INT | Vsync Id associated with the input. Null if an input event has no associated frame event. |

<br />

<br />

<br />

**android_key_events**. Key events processed by the Android framework (from android.input.inputevent data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the trace entry |
| event_id | INT | The randomly-generated ID associated with each input event processed by Android Framework, used to track the event through the input pipeline |
| ts | INT | The timestamp of when the input event was processed by the system |
| arg_set_id | INT | Details of the input event parsed from the proto message |

<br />

<br />

<br />

**android_motion_events**. Motion events processed by the Android framework (from android.input.inputevent data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the trace entry |
| event_id | INT | The randomly-generated ID associated with each input event processed by Android Framework, used to track the event through the input pipeline |
| ts | INT | The timestamp of when the input event was processed by the system |
| arg_set_id | INT | Details of the input event parsed from the proto message |

<br />

<br />

<br />

**android_input_event_dispatch**. Input event dispatching information in Android (from android.input.inputevent data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the trace entry |
| event_id | INT | Event ID of the input event that was dispatched |
| arg_set_id | INT | Extra args parsed from the proto message |
| vsync_id | INT | Vsync ID that identifies the state of the windows during which the dispatch decision was made |
| window_id | INT | Window ID of the window receiving the event |

<br />

<br />

### android.job_scheduler

#### Views/Tables

<br />

**android_job_scheduler_events**. All scheduled jobs and their latencies.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| job_id | INT | Id of the scheduled job assigned by the app developer. |
| uid | INT | Uid of the process running the scheduled job. |
| package_name | STRING | Package name of the process running the scheduled job. |
| job_service_name | STRING | Service component name of the scheduled job. |
| track_id | INT | Thread track id of the job scheduler event slice. |
| id | INT | Slice id of the job scheduler event slice. |
| ts | INT | Timestamp the job was scheduled. |
| dur | INT | Duration of the scheduled job. |

<br />

<br />

### android.memory.dmabuf

#### Views/Tables

<br />

**android_dmabuf_allocs**. Track dmabuf allocations, re-attributing gralloc allocations to their source (if binder transactions to gralloc are recorded).

<br />

TABLE
Track dmabuf allocations, re-attributing gralloc allocations to their source
(if binder transactions to gralloc are recorded).

| Column | Type | Description |
|---|---|---|
| ts | INT | timestamp of the allocation |
| buf_size | INT | allocation size (will be negative for release) |
| inode | INT | dmabuf inode |
| utid | INT | utid of thread responsible for the allocation if a dmabuf is allocated by gralloc we follow the binder transaction to the requesting thread (requires binder tracing) |
| tid | INT | tid of thread responsible for the allocation |
| thread_name | STRING | thread name |
| upid | INT | upid of process responsible for the allocation (matches utid) |
| pid | INT | pid of process responsible for the allocation |
| process_name | STRING | process name |

<br />

<br />

### android.memory.heap_graph.dominator_tree

#### Views/Tables

<br />

**heap_graph_dominator_tree**. All reachable heap graph objects, their immediate dominators and summary of their dominated sets. The heap graph dominator tree is calculated by stdlib graphs.dominator_tree. Each reachable object is a node in the dominator tree, their immediate dominator is their parent node in the tree, and their dominated set is all their descendants in the tree

<br />

TABLE
All reachable heap graph objects, their immediate dominators and summary of
their dominated sets.
The heap graph dominator tree is calculated by stdlib graphs.dominator_tree.
Each reachable object is a node in the dominator tree, their immediate
dominator is their parent node in the tree, and their dominated set is all
their descendants in the tree. All size information come from the
heap_graph_object prelude table.

| Column | Type | Description |
|---|---|---|
| id | INT | Heap graph object id. |
| idom_id | INT | Immediate dominator object id of the object. If the immediate dominator is the "super-root" (i.e. the object is a root or is dominated by multiple roots) then `idom_id` will be NULL. |
| dominated_obj_count | INT | Count of all objects dominated by this object, self inclusive. |
| dominated_size_bytes | INT | Total self_size of all objects dominated by this object, self inclusive. |
| dominated_native_size_bytes | INT | Total native_size of all objects dominated by this object, self inclusive. |
| depth | INT | Depth of the object in the dominator tree. Depth of root objects are 1. |

<br />

<br />

### android.memory.heap_graph.heap_graph_class_aggregation

#### Views/Tables

<br />

**android_heap_graph_class_aggregation**. Class-level breakdown of the java heap. Per type name aggregates the object stats and the dominator tree stats.

<br />

TABLE
Class-level breakdown of the java heap.
Per type name aggregates the object stats and the dominator tree stats.

| Column | Type | Description |
|---|---|---|
| upid | INT | Process upid |
| graph_sample_ts | INT | Heap dump timestamp |
| type_id | INT | Class type id |
| type_name | STRING | Class name (deobfuscated if available) |
| is_libcore_or_array | BOOL | Is type an instance of a libcore object (java.\*) or array |
| obj_count | INT | Count of class instances |
| size_bytes | INT | Size of class instances |
| native_size_bytes | INT | Native size of class instances |
| reachable_obj_count | INT | Count of reachable class instances |
| reachable_size_bytes | INT | Size of reachable class instances |
| reachable_native_size_bytes | INT | Native size of reachable class instances |
| dominated_obj_count | INT | Count of all objects dominated by instances of this class Only applies to reachable objects |
| dominated_size_bytes | INT | Size of all objects dominated by instances of this class Only applies to reachable objects |
| dominated_native_size_bytes | INT | Native size of all objects dominated by instances of this class Only applies to reachable objects |

<br />

<br />

### android.memory.process

#### Views/Tables

<br />

**memory_oom_score_with_rss_and_swap_per_process**. Process memory and it's OOM adjuster scores

<br />

TABLE
Process memory and it's OOM adjuster scores. Detects transitions, each new
interval means that either the memory or OOM adjuster score of the process changed.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp the oom_adj score or memory of the process changed |
| dur | INT | Duration until the next oom_adj score or memory change of the process. |
| score | INT | oom adjuster score of the process. |
| bucket | STRING | oom adjuster bucket of the process. |
| upid | INT | Upid of the process having an oom_adj update. |
| process_name | STRING | Name of the process having an oom_adj update. |
| pid | INT | Pid of the process having an oom_adj update. |
| oom_adj_id | INT | Slice of the latest oom_adj update in the system_server. Alias of `slice.id`. |
| oom_adj_ts | INT | Timestamp of the latest oom_adj update in the system_server. |
| oom_adj_dur | INT | Duration of the latest oom_adj update in the system_server. |
| oom_adj_track_id | INT | Track of the latest oom_adj update in the system_server. Alias of `track.id`. |
| oom_adj_thread_name | STRING | Thread name of the latest oom_adj update in the system_server. |
| oom_adj_reason | STRING | Reason for the latest oom_adj update in the system_server. |
| oom_adj_trigger | STRING | Trigger for the latest oom_adj update in the system_server. |
| anon_rss | INT | Anon RSS counter value |
| file_rss | INT | File RSS counter value |
| shmem_rss | INT | Shared memory RSS counter value |
| rss | INT | Total RSS value. Sum of `anon_rss`, `file_rss` and `shmem_rss`. Returns value even if one of the values is NULL. |
| swap | INT | Swap counter value |
| anon_rss_and_swap | INT | Sum or `anon_rss` and `swap`. Returns value even if one of the values is NULL. |
| rss_and_swap | INT | Sum or `rss` and `swap`. Returns value even if one of the values is NULL. |

<br />

<br />

### android.monitor_contention

#### Views/Tables

<br />

**android_monitor_contention**. Contains parsed monitor contention slices.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| blocking_method | STRING | Name of the method holding the lock. |
| blocked_method | STRING | Blocked_method without arguments and return types. |
| short_blocking_method | STRING | Blocking_method without arguments and return types. |
| short_blocked_method | STRING | Blocked_method without arguments and return types. |
| blocking_src | STRING | File location of blocking_method in form <filename:linenumber>. |
| blocked_src | STRING | File location of blocked_method in form <filename:linenumber>. |
| waiter_count | INT | Zero indexed number of threads trying to acquire the lock. |
| blocked_utid | INT | Utid of thread holding the lock. |
| blocked_thread_name | STRING | Thread name of thread holding the lock. |
| blocking_utid | INT | Utid of thread holding the lock. |
| blocking_thread_name | STRING | Thread name of thread holding the lock. |
| blocking_tid | INT | Tid of thread holding the lock. |
| upid | INT | Upid of process experiencing lock contention. |
| process_name | STRING | Process name of process experiencing lock contention. |
| id | INT | Slice id of lock contention. |
| ts | INT | Timestamp of lock contention start. |
| dur | INT | Wall clock duration of lock contention. |
| monotonic_dur | INT | Monotonic clock duration of lock contention. |
| track_id | INT | Thread track id of blocked thread. |
| is_blocked_thread_main | INT | Whether the blocked thread is the main thread. |
| blocked_thread_tid | INT | Tid of the blocked thread |
| is_blocking_thread_main | INT | Whether the blocking thread is the main thread. |
| blocking_thread_tid | INT | Tid of thread holding the lock. |
| binder_reply_id | INT | Slice id of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_ts | INT | Timestamp of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_tid | INT | Tid of binder reply slice if lock contention was part of a binder txn. |
| pid | INT | Pid of process experiencing lock contention. |

<br />

<br />

<br />

**android_monitor_contention_chain**. Contains parsed monitor contention slices with the parent-child relationships.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| parent_id | INT | Id of monitor contention slice blocking this contention. |
| blocking_method | STRING | Name of the method holding the lock. |
| blocked_method | STRING | Blocked_method without arguments and return types. |
| short_blocking_method | STRING | Blocking_method without arguments and return types. |
| short_blocked_method | STRING | Blocked_method without arguments and return types. |
| blocking_src | STRING | File location of blocking_method in form <filename:linenumber>. |
| blocked_src | STRING | File location of blocked_method in form <filename:linenumber>. |
| waiter_count | INT | Zero indexed number of threads trying to acquire the lock. |
| blocked_utid | INT | Utid of thread holding the lock. |
| blocked_thread_name | STRING | Thread name of thread holding the lock. |
| blocking_utid | INT | Utid of thread holding the lock. |
| blocking_thread_name | STRING | Thread name of thread holding the lock. |
| blocking_tid | INT | Tid of thread holding the lock. |
| upid | INT | Upid of process experiencing lock contention. |
| process_name | STRING | Process name of process experiencing lock contention. |
| id | INT | Slice id of lock contention. |
| ts | INT | Timestamp of lock contention start. |
| dur | INT | Wall clock duration of lock contention. |
| monotonic_dur | INT | Monotonic clock duration of lock contention. |
| track_id | INT | Thread track id of blocked thread. |
| is_blocked_thread_main | INT | Whether the blocked thread is the main thread. |
| blocked_thread_tid | INT | Tid of the blocked thread |
| is_blocking_thread_main | INT | Whether the blocking thread is the main thread. |
| blocking_thread_tid | INT | Tid of thread holding the lock. |
| binder_reply_id | INT | Slice id of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_ts | INT | Timestamp of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_tid | INT | Tid of binder reply slice if lock contention was part of a binder txn. |
| pid | INT | Pid of process experiencing lock contention. |
| child_id | INT | Id of monitor contention slice blocked by this contention. |

<br />

<br />

<br />

**android_monitor_contention_chain_thread_state**. Note that we only span join the duration where the lock was actually held and contended. This can be less than the duration the lock was 'waited on' when a different waiter acquired the lock earlier than the first waiter.

<br />

TABLE
Note that we only span join the duration where the lock was actually held and contended.
This can be less than the duration the lock was 'waited on' when a different waiter acquired the
lock earlier than the first waiter.

| Column | Type | Description |
|---|---|---|
| parent_id | None | Id of slice blocking the blocking_thread. |
| blocking_method | None | Name of the method holding the lock. |
| blocked_methhod | None | Name of the method trying to acquire the lock. |
| short_blocking_method | None | Blocking_method without arguments and return types. |
| short_blocked_method | None | Blocked_method without arguments and return types. |
| blocking_src | None | File location of blocking_method in form <filename:linenumber>. |
| blocked_src | None | File location of blocked_method in form <filename:linenumber>. |
| waiter_count | None | Zero indexed number of threads trying to acquire the lock. |
| blocking_utid | None | Utid of the blocking \|thread_state\|. |
| blocking_thread_name | None | Thread name of thread holding the lock. |
| upid | None | Upid of process experiencing lock contention. |
| process_name | None | Process name of process experiencing lock contention. |
| id | None | Slice id of lock contention. |
| ts | None | Timestamp of the blocking \|thread_state\|. |
| dur | None | Wall clock duration of lock contention. |
| monotonic_dur | None | Monotonic clock duration of lock contention. |
| track_id | None | Thread track id of blocked thread. |
| is_blocked_main_thread | None | Whether the blocked thread is the main thread. |
| is_blocking_main_thread | None | Whether the blocking thread is the main thread. |
| binder_reply_id | None | Slice id of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_ts | None | Timestamp of binder reply slice if lock contention was part of a binder txn. |
| binder_reply_tid | None | Tid of binder reply slice if lock contention was part of a binder txn. |
| state | None | Thread state of the blocking thread. |
| blocked_function | None | Blocked kernel function of the blocking thread. |

<br />

<br />

<br />

**android_monitor_contention_chain_thread_state_by_txn**. Aggregated thread_states on the 'blocking thread', the thread holding the lock. This builds on the data from \|android_monitor_contention_chain\| and for each contention slice, it returns the aggregated sum of all the thread states on the blocking thread. Note that this data is only available for the first waiter on a lock.

<br />

VIEW
Aggregated thread_states on the 'blocking thread', the thread holding the lock.
This builds on the data from \|android_monitor_contention_chain\| and
for each contention slice, it returns the aggregated sum of all the thread states on the
blocking thread.

Note that this data is only available for the first waiter on a lock.

| Column | Type | Description |
|---|---|---|
| id | INT | Slice id of the monitor contention. |
| thread_state | STRING | A \|thread_state\| that occurred in the blocking thread during the contention. |
| thread_state_dur | INT | Total time the blocking thread spent in the \|thread_state\| during contention. |
| thread_state_count | INT | Count of all times the blocking thread entered \|thread_state\| during the contention. |

<br />

<br />

<br />

**android_monitor_contention_chain_blocked_functions_by_txn**. Aggregated blocked_functions on the 'blocking thread', the thread holding the lock. This builds on the data from \|android_monitor_contention_chain\| and for each contention, it returns the aggregated sum of all the kernel blocked function durations on the blocking thread. Note that this data is only available for the first waiter on a lock.

<br />

VIEW
Aggregated blocked_functions on the 'blocking thread', the thread holding the lock.
This builds on the data from \|android_monitor_contention_chain\| and
for each contention, it returns the aggregated sum of all the kernel
blocked function durations on the blocking thread.

Note that this data is only available for the first waiter on a lock.

| Column | Type | Description |
|---|---|---|
| id | INT | Slice id of the monitor contention. |
| blocked_function | STRING | Blocked kernel function in a thread state in the blocking thread during the contention. |
| blocked_function_dur | INT | Total time the blocking thread spent in the \|blocked_function\| during the contention. |
| blocked_function_count | INT | Count of all times the blocking thread executed the \|blocked_function\| during the contention. |

<br />

<br />

#### Functions

<br />

**android_extract_android_monitor_contention_blocking_thread** -\> STRING. Extracts the blocking thread from a slice name

<br />

<br />

<br />

Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_blocking_tid** -\> INT. Extracts the blocking thread tid from a slice name

<br />

<br />

<br />

Returns INT: Blocking thread tid

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_blocking_method** -\> STRING. Extracts the blocking method from a slice name

<br />

<br />

<br />

Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_short_blocking_method** -\> STRING. Extracts a shortened form of the blocking method name from a slice name. The shortened form discards the parameter and return types.

<br />

<br />

<br />

Extracts a shortened form of the blocking method name from a slice name.
The shortened form discards the parameter and return
types.
Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_blocked_method** -\> STRING. Extracts the monitor contention blocked method from a slice name

<br />

<br />

<br />

Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_short_blocked_method** -\> STRING. Extracts a shortened form of the monitor contention blocked method name from a slice name

<br />

<br />

<br />

Extracts a shortened form of the monitor contention blocked method name
from a slice name. The shortened form discards the parameter and return
types.
Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_waiter_count** -\> INT. Extracts the number of waiters on the monitor from a slice name

<br />

<br />

<br />

Returns INT: Count of waiters on the lock

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_blocking_src** -\> STRING. Extracts the monitor contention blocking source location from a slice name

<br />

<br />

<br />

Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

<br />

**android_extract_android_monitor_contention_blocked_src** -\> STRING. Extracts the monitor contention blocked source location from a slice name

<br />

<br />

<br />

Returns STRING: Blocking thread

| Argument | Type | Description |
|---|---|---|
| slice_name | STRING | Name of slice |

<br />

<br />

#### Table Functions

<br />

**android_monitor_contention_graph** . Returns a DAG of all Java lock contentions in a process. Each node in the graph is a pair. Each edge connects from a node waiting on a lock to a node holding a lock. The weights of each node represent the cumulative wall time the node blocked other nodes connected to it.

<br />

<br />

<br />

Returns a DAG of all Java lock contentions in a process.
Each node in the graph is a pair. Each edge connects from a node waiting on a lock to a node holding a lock. The weights of each node represent the cumulative wall time the node blocked other nodes connected to it. Argument \| Type \| Description --- \| --- \| --- upid \| INT \| Upid of process to generate a lock graph for.

| Column | Type | Description |
|---|---|---|
| pprof | BYTES | Pprof of lock graph. |

<br />

<br />

### android.network_packets

#### Views/Tables

<br />

**android_network_packets**. Android network packet events (from android.network_packets data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp in nanoseconds. |
| dur | INT | Duration (non-zero only in aggregate events) |
| track_name | STRING | The track name (interface and direction) |
| package_name | STRING | Traffic package source (or uid=$X if not found) |
| iface | STRING | Traffic interface name (linux interface name) |
| direction | STRING | Traffic direction ('Transmitted' or 'Received') |
| packet_count | INT | Number of packets in this event |
| packet_length | INT | Number of bytes in this event (wire size) |
| packet_transport | STRING | Transport used for traffic in this event |
| packet_tcp_flags | INT | TCP flags used by tcp frames in this event |
| socket_tag | STRING | The Android traffic tag of the network socket |
| socket_uid | INT | The Linux user id of the network socket |
| local_port | INT | The local port number (for udp or tcp only) |
| remote_port | INT | The remote port number (for udp or tcp only) |
| packet_icmp_type | INT | 1-byte ICMP type identifier. |
| packet_icmp_code | INT | 1-byte ICMP code identifier. |
| packet_tcp_flags_int | INT | Packet's tcp flags bitmask (e.g. FIN=0x1, SYN=0x2). |
| socket_tag_int | INT | Packet's socket tag as an integer. |

<br />

<br />

### android.oom_adjuster

#### Views/Tables

<br />

**android_oom_adj_intervals**. All oom adj state intervals across all processes along with the reason for the state update.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp the oom_adj score of the process changed |
| dur | INT | Duration until the next oom_adj score change of the process. |
| score | INT | oom_adj score of the process. |
| bucket | STRING | oom_adj bucket of the process. |
| upid | INT | Upid of the process having an oom_adj update. |
| process_name | STRING | Name of the process having an oom_adj update. |
| oom_adj_id | INT | Slice id of the latest oom_adj update in the system_server. |
| oom_adj_ts | INT | Timestamp of the latest oom_adj update in the system_server. |
| oom_adj_dur | INT | Duration of the latest oom_adj update in the system_server. |
| oom_adj_track_id | INT | Track id of the latest oom_adj update in the system_server |
| oom_adj_thread_name | STRING | Thread name of the latest oom_adj update in the system_server. |
| oom_adj_reason | STRING | Reason for the latest oom_adj update in the system_server. |
| oom_adj_trigger | STRING | Trigger for the latest oom_adj update in the system_server. |

<br />

<br />

#### Functions

<br />

**android_oom_adj_score_to_bucket_name** -\> STRING. Converts an oom_adj score Integer to String sample name. One of: cached, background, job, foreground_service, bfgs, foreground and system.

<br />

<br />

<br />

Converts an oom_adj score Integer to String sample name.
One of: cached, background, job, foreground_service, bfgs, foreground and
system.
Returns STRING: Returns the sample bucket based on the oom score.

| Argument | Type | Description |
|---|---|---|
| oom_score | INT | `oom_score` value |

<br />

<br />

<br />

**android_oom_adj_score_to_detailed_bucket_name** -\> STRING. Converts an oom_adj score Integer to String bucket name. Deprecated: use `android_oom_adj_score_to_bucket_name` instead.

<br />

<br />

<br />

Converts an oom_adj score Integer to String bucket name.
Deprecated: use `android_oom_adj_score_to_bucket_name` instead.
Returns STRING: Returns the oom_adj bucket.

| Argument | Type | Description |
|---|---|---|
| value | INT | oom_adj score. |
| android_appid | INT | android_app id of the process. |

<br />

<br />

### android.power_rails

#### Views/Tables

<br />

**android_power_rails_counters**. Android power rails counters data. For details see: https://perfetto.dev/docs/data-sources/battery-counters#odpm NOTE: Requires dedicated hardware - table is only populated on Pixels.

<br />

TABLE
Android power rails counters data.
For details see: https://perfetto.dev/docs/data-sources/battery-counters#odpm
NOTE: Requires dedicated hardware - table is only populated on Pixels.

| Column | Type | Description |
|---|---|---|
| id | INT | `counter.id` |
| ts | INT | Timestamp of the energy measurement. |
| dur | INT | Time until the next energy measurement. |
| power_rail_name | STRING | Power rail name. Alias of `counter_track.name`. |
| raw_power_rail_name | STRING | Raw power rail name. |
| energy_since_boot | DOUBLE | Energy accumulated by this rail since boot in microwatt-seconds (uWs) (AKA micro-joules). Alias of `counter.value`. |
| energy_since_boot_at_end | DOUBLE | Energy accumulated by this rail at next energy measurement in microwatt-seconds (uWs) (AKA micro-joules). Alias of `counter.value` of the next meaningful (with value change) counter value. |
| average_power | DOUBLE | Average power in mW (milliwatts) over between ts and the next energy measurement. |
| energy_delta | DOUBLE | The change of energy accumulated by this rails since the last measurement in microwatt-seconds (uWs) (AKA micro-joules). |
| track_id | INT | Power rail track id. Alias of `counter_track.id`. |
| value | DOUBLE | DEPRECATED. Use `energy_since_boot` instead. |

<br />

<br />

### android.process_metadata

#### Views/Tables

<br />

**android_process_metadata**. Data about packages running on the process.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| upid | INT | Process upid. |
| pid | INT | Process pid. |
| process_name | STRING | Process name. |
| uid | INT | Android app UID. |
| shared_uid | BOOL | Whether the UID is shared by multiple packages. |
| package_name | STRING | Name of the packages running in this process. |
| version_code | INT | Package version code. |
| debuggable | INT | Whether package is debuggable. |

<br />

<br />

### android.screenshots

#### Views/Tables

<br />

**android_screenshots**. Screenshot slices, used in perfetto UI.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | Slice id. |
| ts | INT | Slice timestamp. |
| dur | INT | Slice duration, should be typically 0 since screeenshot slices are of instant type. |
| name | STRING | Slice name. |

<br />

<br />

### android.services

#### Views/Tables

<br />

**android_service_bindings**. All service bindings from client app to server app.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| client_oom_score | INT | OOM score of client process making the binding. |
| client_process | STRING | Name of client process making the binding. |
| client_thread | STRING | Name of client thread making the binding. |
| client_pid | INT | Pid of client process making the binding. |
| client_tid | INT | Tid of client process making the binding. |
| client_upid | INT | Upid of client process making the binding. |
| client_utid | INT | Utid of client thread making the binding. |
| client_ts | INT | Timestamp the client process made the request. |
| client_dur | INT | Duration of the client binding request. |
| server_oom_score | INT | OOM score of server process getting bound to. |
| server_process | STRING | Name of server process getting bound to |
| server_thread | STRING | Name of server thread getting bound to. |
| server_pid | INT | Pid of server process getting bound to. |
| server_tid | INT | Tid of server process getting bound to. |
| server_upid | INT | Upid of server process getting bound to. |
| server_utid | INT | Utid of server process getting bound to. |
| server_ts | INT | Timestamp the server process got bound to. |
| server_dur | INT | Duration of the server process handling the binding. |
| token | STRING | Unique binder identifier for the Service binding. |
| act | STRING | Intent action name for the service binding. |
| cmp | STRING | Intent component name for the service binding. |
| flg | STRING | Intent flag for the service binding. |
| bind_seq | INT | Monotonically increasing id for the service binding. |

<br />

<br />

### android.slices

#### Functions

<br />

**android_standardize_slice_name** -\> STRING. Some slice names have params in them

<br />

<br />

<br />

Some slice names have params in them. This functions removes them to make it
possible to aggregate by name.
Some examples are:
- Lock/monitor contention slices. The name includes where the lock
contention is in the code. That part is removed.
- DrawFrames/ooFrame. The name also includes the frame number.
- Apk/oat/dex loading: The name of the apk is removed
Returns STRING: Simplified name.

| Argument | Type | Description |
|---|---|---|
| name | STRING | The raw slice name. |

<br />

<br />

### android.startup.startups

#### Views/Tables

<br />

**android_startups**. All activity startups in the trace by startup id. Populated by different scripts depending on the platform version/contents.

<br />

TABLE
All activity startups in the trace by startup id.
Populated by different scripts depending on the platform version/contents.

| Column | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| ts | INT | Timestamp of startup start. |
| ts_end | INT | Timestamp of startup end. |
| dur | INT | Startup duration. |
| package | STRING | Package name. |
| startup_type | STRING | Startup type. |

<br />

<br />

<br />

**android_startup_processes**. Maps a startup to the set of processes that handled the activity start. The vast majority of cases should be a single process

<br />

TABLE
Maps a startup to the set of processes that handled the activity start.

The vast majority of cases should be a single process. However it is
possible that the process dies during the activity startup and is respawned.

| Column | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| upid | INT | Upid of process on which activity started. |
| startup_type | STRING | Type of the startup. |

<br />

<br />

<br />

**android_startup_threads**. Maps a startup to the set of threads on processes that handled the activity start.

<br />

VIEW
Maps a startup to the set of threads on processes that handled the
activity start.

| Column | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| ts | INT | Timestamp of start. |
| dur | INT | Duration of startup. |
| upid | INT | Upid of process involved in startup. |
| utid | INT | Utid of the thread. |
| thread_name | STRING | Name of the thread. |
| is_main_thread | BOOL | Thread is a main thread. |

<br />

<br />

<br />

**android_thread_slices_for_all_startups**. All the slices for all startups in trace. Generally, this view should not be used

<br />

VIEW
All the slices for all startups in trace.

Generally, this view should not be used. Instead, use one of the view functions related
to the startup slices which are created from this table.

| Column | Type | Description |
|---|---|---|
| startup_ts | INT | Timestamp of startup. |
| startup_ts_end | INT | Timestamp of startup end. |
| startup_id | INT | Startup id. |
| utid | INT | UTID of thread with slice. |
| thread_name | STRING | Name of thread. |
| is_main_thread | BOOL | Whether it is main thread. |
| arg_set_id | INT | Arg set id. |
| slice_id | INT | Slice id. |
| slice_name | STRING | Name of slice. |
| slice_ts | INT | Timestamp of slice start. |
| slice_dur | INT | Slice duration. |

<br />

<br />

#### Functions

<br />

**android_sum_dur_for_startup_and_slice** -\> INT. Returns duration of startup for slice name. Sums duration of all slices of startup with provided name.

<br />

<br />

<br />

Returns duration of startup for slice name.

Sums duration of all slices of startup with provided name.
Returns INT: Sum of duration.

| Argument | Type | Description |
|---|---|---|
| startup_id | LONG | Startup id. |
| slice_name | STRING | Slice name. |

<br />

<br />

<br />

**android_sum_dur_on_main_thread_for_startup_and_slice** -\> INT. Returns duration of startup for slice name on main thread. Sums duration of all slices of startup with provided name only on main thread.

<br />

<br />

<br />

Returns duration of startup for slice name on main thread.

Sums duration of all slices of startup with provided name only on main thread.
Returns INT: Sum of duration.

| Argument | Type | Description |
|---|---|---|
| startup_id | LONG | Startup id. |
| slice_name | STRING | Slice name. |

<br />

<br />

#### Table Functions

<br />

**android_slices_for_startup_and_slice_name** . Given a startup id and GLOB for a slice name, returns matching slices with data.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| slice_name | STRING | Glob of the slice. |

| Column | Type | Description |
|---|---|---|
| slice_id | INT | Id of the slice. |
| slice_name | STRING | Name of the slice. |
| slice_ts | INT | Timestamp of start of the slice. |
| slice_dur | INT | Duration of the slice. |
| thread_name | STRING | Name of the thread with the slice. |
| arg_set_id | INT | Arg set id. |

<br />

<br />

<br />

**android_binder_transaction_slices_for_startup** . Returns binder transaction slices for a given startup id with duration over threshold.

<br />

<br />

<br />

| Argument | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| threshold | DOUBLE | Only return slices with duration over threshold. |

| Column | Type | Description |
|---|---|---|
| id | INT | Slice id. |
| slice_dur | INT | Slice duration. |
| thread_name | STRING | Name of the thread with slice. |
| process | STRING | Name of the process with slice. |
| arg_set_id | INT | Arg set id. |
| is_main_thread | BOOL | Whether is main thread. |

<br />

<br />

### android.startup.time_to_display

#### Views/Tables

<br />

**android_startup_time_to_display**. Startup metric defintions, which focus on the observable time range: TTID - Time To Initial Display \* https://developer.android.com/topic/performance/vitals/launch-time#time-initial \* end of first RenderThread.DrawFrame - bindApplication TTFD - Time To Full Display \* https://developer.android.com/topic/performance/vitals/launch-time#retrieve-TTFD \* end of next RT.DrawFrame, after reportFullyDrawn called - bindApplication Googlers: see go/android-performance-metrics-glossary for details.

<br />

TABLE
Startup metric defintions, which focus on the observable time range:
TTID - Time To Initial Display
\* https://developer.android.com/topic/performance/vitals/launch-time#time-initial
\* end of first RenderThread.DrawFrame - bindApplication
TTFD - Time To Full Display
\* https://developer.android.com/topic/performance/vitals/launch-time#retrieve-TTFD
\* end of next RT.DrawFrame, after reportFullyDrawn called - bindApplication
Googlers: see go/android-performance-metrics-glossary for details.

| Column | Type | Description |
|---|---|---|
| startup_id | INT | Startup id. |
| time_to_initial_display | INT | Time to initial display (TTID) |
| time_to_full_display | INT | Time to full display (TTFD) |
| ttid_frame_id | INT | `android_frames.frame_id` of frame for initial display |
| ttfd_frame_id | INT | `android_frames.frame_id` of frame for full display |
| upid | INT | `process.upid` of the startup |

<br />

<br />

### android.statsd

#### Views/Tables

<br />

**android_statsd_atoms**. Statsd atoms. A subset of the slice table containing statsd atom instant events.

<br />

VIEW
Statsd atoms.

A subset of the slice table containing statsd atom instant events.

| Column | Type | Description |
|---|---|---|
| id | INT | Unique identifier for this slice. |
| type | STRING | The name of the "most-specific" child table containing this row. |
| ts | INT | The timestamp at the start of the slice (in nanoseconds). |
| dur | INT | The duration of the slice (in nanoseconds). |
| arg_set_id | INT | The id of the argument set associated with this slice. |
| thread_instruction_count | INT | The value of the CPU instruction counter at the start of the slice. This column will only be populated if thread instruction collection is enabled with track_event. |
| thread_instruction_delta | INT | The change in value of the CPU instruction counter between the start and end of the slice. This column will only be populated if thread instruction collection is enabled with track_event. |
| track_id | INT | The id of the track this slice is located on. |
| category | STRING | The "category" of the slice. If this slice originated with track_event, this column contains the category emitted. Otherwise, it is likely to be null (with limited exceptions). |
| name | STRING | The name of the slice. The name describes what was happening during the slice. |
| depth | INT | The depth of the slice in the current stack of slices. |
| stack_id | INT | A unique identifier obtained from the names of all slices in this stack. This is rarely useful and kept around only for legacy reasons. |
| parent_stack_id | INT | The stack_id for the parent of this slice. Rarely useful. |
| parent_id | INT | The id of the parent (i.e. immediate ancestor) slice for this slice. |
| thread_ts | INT | The thread timestamp at the start of the slice. This column will only be populated if thread timestamp collection is enabled with track_event. |
| thread_dur | INT | The thread time used by this slice. This column will only be populated if thread timestamp collection is enabled with track_event. |

<br />

<br />

### android.suspend

#### Views/Tables

<br />

**android_suspend_state**. Table of suspended and awake slices. Selects either the minimal or full ftrace source depending on what's available, marks suspended periods, and complements them to give awake periods.

<br />

TABLE
Table of suspended and awake slices.

Selects either the minimal or full ftrace source depending on what's
available, marks suspended periods, and complements them to give awake
periods.

| Column | Type | Description |
|---|---|---|
| ts | INT | Timestamp |
| dur | INT | Duration |
| power_state | STRING | 'awake' or 'suspended' |

<br />

<br />

### android.winscope.inputmethod

#### Views/Tables

<br />

**android_inputmethod_clients**. Android inputmethod clients state dumps (from android.inputmethod data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Dump id |
| ts | INT | Timestamp when the dump was triggered |
| arg_set_id | INT | Extra args parsed from the proto message |

<br />

<br />

<br />

**android_inputmethod_manager_service**. Android inputmethod manager service state dumps (from android.inputmethod data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Dump id |
| ts | INT | Timestamp when the dump was triggered |
| arg_set_id | INT | Extra args parsed from the proto message |

<br />

<br />

<br />

**android_inputmethod_service**. Android inputmethod service state dumps (from android.inputmethod data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Dump id |
| ts | INT | Timestamp when the dump was triggered |
| arg_set_id | INT | Extra args parsed from the proto message |

<br />

<br />

### android.winscope.viewcapture

#### Views/Tables

<br />

**android_viewcapture**. Android viewcapture (from android.viewcapture data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Snapshot id |
| ts | INT | Timestamp when the snapshot was triggered |
| arg_set_id | INT | Extra args parsed from the proto message |

<br />

<br />

### android.winscope.windowmanager

#### Views/Tables

<br />

**android_windowmanager**. Android WindowManager (from android.windowmanager data source).

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Snapshot id |
| ts | INT | Timestamp when the snapshot was triggered |
| arg_set_id | INT | Extra args parsed from the proto message |

<br />

<br />

## Package: chrome

### chrome.chrome_scrolls

#### Views/Tables

<br />

**chrome_scrolls**. Defines slices for all of the individual scrolls in a trace based on the LatencyInfo-based scroll definition. NOTE: this view of top level scrolls is based on the LatencyInfo definition of a scroll, which differs subtly from the definition based on EventLatencies. TODO(b/278684408): add support for tracking scrolls across multiple Chrome/ WebView instances

<br />

TABLE
Defines slices for all of the individual scrolls in a trace based on the
LatencyInfo-based scroll definition.

NOTE: this view of top level scrolls is based on the LatencyInfo definition
of a scroll, which differs subtly from the definition based on
EventLatencies.
TODO(b/278684408): add support for tracking scrolls across multiple Chrome/
WebView instances. Currently gesture_scroll_id unique within an instance, but
is not unique across multiple instances. Switching to an EventLatency based
definition of scrolls should resolve this.

| Column | Type | Description |
|---|---|---|
| id | INT | The unique identifier of the scroll. |
| ts | INT | The start timestamp of the scroll. |
| dur | INT | The duration of the scroll. |
| gesture_scroll_begin_ts | INT | The earliest timestamp of the EventLatency slice of the GESTURE_SCROLL_BEGIN type for the corresponding scroll id. |
| gesture_scroll_end_ts | INT | The earliest timestamp of the EventLatency slice of the GESTURE_SCROLL_END type / the latest timestamp of the EventLatency slice of the GESTURE_SCROLL_UPDATE type for the corresponding scroll id. |

<br />

<br />

### chrome.cpu_powerups

#### Views/Tables

<br />

**chrome_cpu_power_slice**. The CPU power transitions in the trace. Power states are encoded as non-negative integers, with zero representing full-power operation and positive values representing increasingly deep sleep states. On ARM systems, power state 1 represents the WFI (Wait For Interrupt) sleep state that the CPU enters while idle.

<br />

VIEW
The CPU power transitions in the trace.
Power states are encoded as non-negative integers, with zero representing
full-power operation and positive values representing increasingly deep
sleep states.

On ARM systems, power state 1 represents the WFI (Wait For Interrupt) sleep
state that the CPU enters while idle.

| Column | Type | Description |
|---|---|---|
| ts | INT | The timestamp at the start of the slice. |
| dur | INT | The duration of the slice. |
| cpu | INT | The CPU on which the transition occurred |
| power_state | INT | The power state that the CPU was in at time 'ts' for duration 'dur'. |
| previous_power_state | INT | The power state that the CPU was previously in. |
| powerup_id | INT | A unique ID for the CPU power-up. |

<br />

<br />

<br />

**chrome_cpu_power_first_sched_slice_after_powerup**. The Linux scheduler slices that executed immediately after a CPU power up.

<br />

TABLE
The Linux scheduler slices that executed immediately after a
CPU power up.

| Column | Type | Description |
|---|---|---|
| ts | INT | The timestamp at the start of the slice. |
| dur | INT | The duration of the slice. |
| cpu | INT | The cpu on which the slice executed. |
| sched_id | INT | Id for the sched_slice table. |
| utid | INT | Unique id for the thread that ran within the slice. |
| previous_power_state | INT | The CPU's power state before this slice. |
| powerup_id | INT | A unique ID for the CPU power-up. |

<br />

<br />

<br />

**chrome_cpu_power_post_powerup_slice**. A table holding the slices that executed within the scheduler slice that ran on a CPU immediately after power-up.

<br />

TABLE
A table holding the slices that executed within the scheduler
slice that ran on a CPU immediately after power-up.

| Column | Type | Description |
|---|---|---|
| ts | None | Timestamp of the resulting slice |
| dur | None | Duration of the slice. |
| cpu | None | The CPU the sched slice ran on. |
| utid | None | Unique thread id for the slice. |
| sched_id | None | 'id' field from the sched_slice table. |
| type | None | From the sched_slice table, always 'sched_slice'. |
| end_state | None | The ending state for the sched_slice |
| priority | None | The kernel thread priority |
| slice_id | None | Id of the top-level slice for this (sched) slice. |

<br />

<br />

<br />

**chrome_cpu_power_first_toplevel_slice_after_powerup**. The first top-level slice that ran after a CPU power-up.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| slice_id | INT | ID of the slice in the slice table. |
| previous_power_state | INT | The power state of the CPU prior to power-up. |

<br />

<br />

### chrome.event_latency

#### Views/Tables

<br />

**chrome_event_latencies**. All EventLatency slices.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | Slice Id for the EventLatency scroll event. |
| name | STRING | Slice name. |
| ts | INT | The start timestamp of the scroll. |
| dur | INT | The duration of the scroll. |
| scroll_update_id | INT | The id of the scroll update event. |
| is_presented | BOOL | Whether this input event was presented. |
| event_type | STRING | EventLatency event type. |
| track_id | INT | Perfetto track this slice is found on. |

<br />

<br />

<br />

**chrome_gesture_scroll_events**. All scroll-related events (frames) including gesture scroll updates, begins and ends with respective scroll ids and start/end timestamps, regardless of being presented

<br />

TABLE
All scroll-related events (frames) including gesture scroll updates, begins
and ends with respective scroll ids and start/end timestamps, regardless of
being presented. This includes pinches that were presented. See b/315761896
for context on pinches.

| Column | Type | Description |
|---|---|---|
| id | INT | Slice Id for the EventLatency scroll event. |
| name | STRING | Slice name. |
| ts | INT | The start timestamp of the scroll. |
| dur | INT | The duration of the scroll. |
| scroll_update_id | INT | The id of the scroll update event. |
| scroll_id | INT | The id of the scroll. |
| is_presented | BOOL | Whether this input event was presented. |
| presentation_timestamp | INT | Frame presentation timestamp aka the timestamp of the SwapEndToPresentationCompositorFrame substage. TODO(b/341047059): temporarily use LatchToSwapEnd as a workaround if SwapEndToPresentationCompositorFrame is missing due to b/247542163. |
| event_type | STRING | EventLatency event type. |
| track_id | INT | Perfetto track this slice is found on. |

<br />

<br />

#### Functions

<br />

**chrome_get_most_recent_scroll_begin_id** -\> INT. Extracts scroll id for the EventLatency slice at `ts`.

<br />

<br />

<br />

Returns INT: The event_latency_id of the EventLatency slice with the type GESTURE_SCROLL_BEGIN that is the closest to `ts`.

| Argument | Type | Description |
|---|---|---|
| ts | INT | Timestamp of the EventLatency slice to get the scroll id for. |

<br />

<br />

### chrome.event_latency_description

#### Views/Tables

<br />

**chrome_event_latency_stage_descriptions**. Source of truth of the descriptions of EventLatency stages.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| name | STRING | The name of the EventLatency stage. |
| description | STRING | A description of the EventLatency stage. |

<br />

<br />

### chrome.histograms

#### Views/Tables

<br />

**chrome_histograms**. A helper view on top of the histogram events emitted by Chrome. Requires "disabled-by-default-histogram_samples" Chrome category.

<br />

TABLE
A helper view on top of the histogram events emitted by Chrome.
Requires "disabled-by-default-histogram_samples" Chrome category.

| Column | Type | Description |
|---|---|---|
| name | STRING | The name of the histogram. |
| value | INT | The value of the histogram sample. |
| ts | INT | Alias of \|slice.ts\|. |
| thread_name | STRING | Thread name. |
| utid | INT | Utid of the thread. |
| tid | INT | Tid of the thread. |
| process_name | STRING | Process name. |
| upid | INT | Upid of the process. |
| pid | INT | Pid of the process. |

<br />

<br />

### chrome.interactions

#### Views/Tables

<br />

**chrome_interactions**. All critical user interaction events, including type and table with associated metrics.

<br />

TABLE
All critical user interaction events, including type and table with
associated metrics.

| Column | Type | Description |
|---|---|---|
| scoped_id | INT | Identifier of the interaction; this is not guaranteed to be unique to the table - rather, it is unique within an individual interaction type. Combine with type to get a unique identifier in this table. |
| type | STRING | Type of this interaction, which together with scoped_id uniquely identifies this interaction. Also corresponds to a SQL table name containing more details specific to this type of interaction. |
| name | STRING | Interaction name - e.g. 'PageLoad', 'Tap', etc. Interactions will have unique metrics stored in other tables. |
| ts | INT | Timestamp of the CUI event. |
| dur | INT | Duration of the CUI event. |

<br />

<br />

### chrome.metadata

#### Functions

<br />

**chrome_hardware_class** -\> STRING. Returns hardware class of the device, often use to find device brand and model.

<br />

<br />

<br />

Returns hardware class of the device, often use to find device brand
and model.
Returns STRING: Hardware class name.

<br />

<br />

### chrome.page_loads

#### Views/Tables

<br />

**chrome_page_loads**. Chrome page loads, including associated high-level metrics and properties.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the navigation and Chrome browser process; this combination is unique to every individual navigation. |
| navigation_id | INT | ID of the navigation associated with the page load (i.e. the cross-document navigation in primary main frame which created this page's main document). Also note that navigation_id is specific to a given Chrome browser process, and not globally unique. |
| navigation_start_ts | INT | Timestamp of the start of navigation. |
| fcp | INT | Duration between the navigation start and the first contentful paint event (web.dev/fcp). |
| fcp_ts | INT | Timestamp of the first contentful paint. |
| lcp | INT | Duration between the navigation start and the largest contentful paint event (web.dev/lcp). |
| lcp_ts | INT | Timestamp of the largest contentful paint. |
| dom_content_loaded_event_ts | INT | Timestamp of the DomContentLoaded event: https://developer.mozilla.org/en-US/docs/Web/API/Document/DOMContentLoaded_event |
| load_event_ts | INT | Timestamp of the window load event: https://developer.mozilla.org/en-US/docs/Web/API/Window/load_event |
| mark_fully_loaded_ts | INT | Timestamp of the page self-reporting as fully loaded through the performance.mark('mark_fully_loaded') API. |
| mark_fully_visible_ts | INT | Timestamp of the page self-reporting as fully visible through the performance.mark('mark_fully_visible') API. |
| mark_interactive_ts | INT | Timestamp of the page self-reporting as fully interactive through the performance.mark('mark_interactive') API. |
| url | STRING | URL at the page load event. |
| browser_upid | INT | The unique process id (upid) of the browser process where the page load occurred. |

<br />

<br />

### chrome.scroll_interactions

#### Views/Tables

<br />

**chrome_scroll_interactions**. Top level scroll events, with metrics.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | Unique id for an individual scroll. |
| name | STRING | Name of the scroll event. |
| ts | INT | Start timestamp of the scroll. |
| dur | INT | Duration of the scroll. |
| frame_count | INT | The total number of frames in the scroll. |
| vsync_count | INT | The total number of vsyncs in the scroll. |
| missed_vsync_max | INT | The maximum number of vsyncs missed during any and all janks. |
| missed_vsync_sum | INT | The total number of vsyncs missed during any and all janks. |
| delayed_frame_count | INT | The number of delayed frames. |
| predictor_janky_frame_count | INT | The number of frames that are deemed janky to the human eye after Chrome has applied its scroll prediction algorithm. |
| renderer_upid | INT | The process id this event occurred on. |

<br />

<br />

### chrome.scroll_jank.predictor_error

#### Views/Tables

<br />

**chrome_predictor_error**. The scrolling offsets and predictor jank values for the actual (applied) scroll events.

<br />

TABLE
The scrolling offsets and predictor jank values for the actual (applied)
scroll events.

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | An ID that ties all EventLatencies in a particular scroll. (implementation note: This is the EventLatency TraceId of the GestureScrollbegin). |
| event_latency_slice_id | INT | An ID for this particular EventLatency regardless of it being presented or not. |
| scroll_update_id | INT | An ID that ties this \|event_latency_id\| with the Trace Id (another event_latency_id) that it was presented with. |
| present_ts | INT | Presentation timestamp. |
| delta_y | DOUBLE | The delta in raw coordinates between this presented EventLatency and the previous presented frame. |
| relative_offset_y | DOUBLE | The pixel offset of this presented EventLatency compared to the initial one. |
| prev_delta | DOUBLE | The delta in raw coordinates of the previous scroll update event. |
| next_delta | DOUBLE | The delta in raw coordinates of the subsequent scroll update event. |
| predictor_jank | DOUBLE | The jank value based on the discrepancy between scroll predictor coordinates and the actual deltas between scroll update events. |
| delta_threshold | DOUBLE | The threshold used to determine if jank occurred. |

<br />

<br />

### chrome.scroll_jank.scroll_jank_cause_map

#### Views/Tables

<br />

**chrome_scroll_jank_cause_descriptions**. Source of truth of the descriptions of EventLatency-based scroll jank causes.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| event_latency_stage | STRING | The name of the EventLatency stage. |
| cause_process | STRING | The process where the cause of scroll jank occurred. |
| cause_thread | STRING | The thread where the cause of scroll jank occurred. |
| cause_description | STRING | A description of the cause of scroll jank. |

<br />

<br />

<br />

**chrome_scroll_jank_causes_with_event_latencies**. Combined description of scroll jank cause and associated event latency stage.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| name | STRING | The name of the EventLatency stage. |
| description | STRING | Description of the EventLatency stage. |
| cause_process | STRING | The process name that may cause scroll jank. |
| cause_thread | STRING | The thread name that may cause scroll jank. The thread will be on the cause_process. |
| cause_description | STRING | Description of the cause of scroll jank on this process and thread. |

<br />

<br />

### chrome.scroll_jank.scroll_jank_cause_utils

#### Table Functions

<br />

**chrome_select_scroll_jank_cause_thread** . Function to retrieve the thread id of the thread on a particular process if there are any slices during a particular EventLatency slice duration; this upid/thread combination refers to a cause of Scroll Jank.

<br />

<br />

<br />

Function to retrieve the thread id of the thread on a particular process if
there are any slices during a particular EventLatency slice duration; this
upid/thread combination refers to a cause of Scroll Jank.
Argument \| Type \| Description
--- \| --- \| ---
event_latency_id \| INT \| The slice id of an EventLatency slice.
process_type \| STRING \| The process type that the thread is on: one of 'Browser', 'Renderer' or 'GPU'.
thread_name \| STRING \| The name of the thread.

| Column | Type | Description |
|---|---|---|
| utid | INT | The utid associated with |

<br />

<br />

### chrome.scroll_jank.scroll_jank_intervals

#### Views/Tables

<br />

**chrome_janky_event_latencies_v3**. Selects EventLatency slices that correspond with janks in a scroll

<br />

TABLE
Selects EventLatency slices that correspond with janks in a scroll. This is
based on the V3 version of scroll jank metrics.

| Column | Type | Description |
|---|---|---|
| id | INT | The slice id. |
| ts | INT | The start timestamp of the slice. |
| dur | INT | The duration of the slice. |
| track_id | INT | The track_id for the slice. |
| name | STRING | The name of the slice (EventLatency). |
| cause_of_jank | STRING | The stage of EventLatency that the caused the jank. |
| sub_cause_of_jank | STRING | The stage of cause_of_jank that caused the jank. |
| delayed_frame_count | INT | How many vsyncs this frame missed its deadline by. |
| frame_jank_ts | INT | The start timestamp where frame presentation was delayed. |
| frame_jank_dur | INT | The duration in ms of the delay in frame presentation. |

<br />

<br />

<br />

**chrome_janky_frame_presentation_intervals**. Frame presentation interval is the delta between when the frame was supposed to be presented and when it was actually presented.

<br />

VIEW
Frame presentation interval is the delta between when the frame was supposed
to be presented and when it was actually presented.

| Column | Type | Description |
|---|---|---|
| id | INT | Unique id. |
| ts | INT | The start timestamp of the slice. |
| dur | INT | The duration of the slice. |
| delayed_frame_count | INT | How many vsyncs this frame missed its deadline by. |
| cause_of_jank | STRING | The stage of EventLatency that the caused the jank. |
| sub_cause_of_jank | STRING | The stage of cause_of_jank that caused the jank. |
| event_latency_id | INT | The id of the associated event latency in the slice table. |

<br />

<br />

<br />

**chrome_scroll_stats**. Scroll jank frame presentation stats for individual scrolls.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | Id of the individual scroll. |
| frame_count | INT | The number of frames in the scroll. |
| missed_vsyncs | INT | The number of missed vsyncs in the scroll. |
| presented_frame_count | INT | The number presented frames in the scroll. |
| janky_frame_count | INT | The number of janky frames in the scroll. |
| janky_frame_percent | FLOAT | The % of frames that janked in the scroll. |

<br />

<br />

<br />

**chrome_scroll_jank_intervals_v3**. Defines slices for all of janky scrolling intervals in a trace.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | The unique identifier of the janky interval. |
| ts | INT | The start timestamp of the janky interval. |
| dur | INT | The duration of the janky interval. |

<br />

<br />

### chrome.scroll_jank.scroll_jank_v3

#### Views/Tables

<br />

**chrome_gesture_scroll_updates**. Grabs all gesture updates with respective scroll ids and start/end timestamps, regardless of being presented.

<br />

TABLE
Grabs all gesture updates with respective scroll ids and start/end
timestamps, regardless of being presented.

| Column | Type | Description |
|---|---|---|
| ts | INT | The start timestamp of the scroll. |
| dur | INT | The duration of the scroll. |
| id | INT | Slice id for the scroll. |
| scroll_update_id | INT | The id of the scroll update event. |
| scroll_id | INT | The id of the scroll. |
| is_presented | BOOL | Whether this input event was presented. |
| presentation_timestamp | INT | Frame presentation timestamp aka the timestamp of the SwapEndToPresentationCompositorFrame substage. |
| event_type | STRING | EventLatency event type. |

<br />

<br />

<br />

**chrome_presented_gesture_scrolls**. Scroll updates, corresponding to all input events that were converted to a presented scroll update.

<br />

TABLE
Scroll updates, corresponding to all input events that were converted to a
presented scroll update.

| Column | Type | Description |
|---|---|---|
| id | INT | Minimum slice id for input presented in this frame, the non-presented input. |
| ts | INT | The start timestamp for producing the frame. |
| dur | INT | The duration between producing and presenting the frame. |
| last_presented_input_ts | INT | The timestamp of the last input that arrived and got presented in the frame. |
| scroll_update_id | INT | The id of the scroll update event, a unique identifier to the gesture. |
| scroll_id | INT | The id of the ongoing scroll. |
| presentation_timestamp | INT | Frame presentation timestamp. |
| event_type | STRING | EventLatency event type. |

<br />

<br />

<br />

**chrome_scroll_updates_with_deltas**. Associate every trace_id with it's perceived delta_y on the screen after prediction.

<br />

TABLE
Associate every trace_id with it's perceived delta_y on the screen after
prediction.

| Column | Type | Description |
|---|---|---|
| scroll_update_id | INT | The id of the scroll update event. |
| delta_y | DOUBLE | The perceived delta_y on the screen post prediction. |

<br />

<br />

<br />

**chrome_full_frame_view**. Obtain the subset of input events that were fully presented.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the frame. |
| ts | INT | Start timestamp of the frame. |
| last_presented_input_ts | INT | The timestamp of the last presented input. |
| scroll_id | INT | ID of the associated scroll. |
| scroll_update_id | INT | ID of the associated scroll update. |
| event_latency_id | INT | ID of the associated EventLatency. |
| dur | INT | Duration of the associated EventLatency. |
| presentation_timestamp | INT | Frame presentation timestamp. |

<br />

<br />

<br />

**chrome_full_frame_delta_view**. Join deltas with EventLatency data.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the frame. |
| ts | INT | Start timestamp of the frame. |
| scroll_id | INT | ID of the associated scroll. |
| scroll_update_id | INT | ID of the associated scroll update. |
| last_presented_input_ts | INT | The timestamp of the last presented input. |
| delta_y | DOUBLE | The perceived delta_y on the screen post prediction. |
| event_latency_id | INT | ID of the associated EventLatency. |
| dur | INT | Duration of the associated EventLatency. |
| presentation_timestamp | INT | Frame presentation timestamp. |

<br />

<br />

<br />

**chrome_merged_frame_view**. Group all gestures presented at the same timestamp together in a single row.

<br />

TABLE
Group all gestures presented at the same timestamp together in
a single row.

| Column | Type | Description |
|---|---|---|
| id | INT | ID of the frame. |
| max_start_ts | INT | The timestamp of the last presented input. |
| min_start_ts | INT | The earliest frame start timestamp. |
| scroll_id | INT | ID of the associated scroll. |
| scroll_update_id | INT | ID of the associated scroll update. |
| encapsulated_scroll_ids | STRING | All scroll updates associated with the frame presentation timestamp. |
| total_delta | DOUBLE | Sum of all perceived delta_y values at the frame presentation timestamp. |
| segregated_delta_y | STRING | Lists all of the perceived delta_y values at the frame presentation timestamp. |
| event_latency_id | INT | ID of the associated EventLatency. |
| dur | INT | Maximum duration of the associated EventLatency. |
| presentation_timestamp | INT | Frame presentation timestamp. |

<br />

<br />

<br />

**chrome_frame_info_with_delay**. View contains all chrome presented frames during gesture updates while calculating delay since last presented which usually should equal to \|VSYNC_INTERVAL\| if no jank is present.

<br />

TABLE
View contains all chrome presented frames during gesture updates
while calculating delay since last presented which usually should
equal to \|VSYNC_INTERVAL\| if no jank is present.

| Column | Type | Description |
|---|---|---|
| id | INT | gesture scroll slice id. |
| max_start_ts | INT | OS timestamp of the last touch move arrival within a frame. |
| min_start_ts | INT | OS timestamp of the first touch move arrival within a frame. |
| scroll_id | INT | The scroll which the touch belongs to. |
| scroll_update_id | INT | ID of the associated scroll update. |
| encapsulated_scroll_ids | STRING | Trace ids of all frames presented in at this vsync. |
| total_delta | DOUBLE | Summation of all delta_y of all gesture scrolls in this frame. |
| segregated_delta_y | STRING | All delta y of all gesture scrolls comma separated, summing those gives \|total_delta\|. |
| event_latency_id | INT | Event latency id of the presented frame. |
| dur | INT | Duration of the EventLatency. |
| presentation_timestamp | INT | Timestamp at which the frame was shown on the screen. |
| delay_since_last_frame | DOUBLE | Time elapsed since the previous frame was presented, usually equals \|VSYNC\| if no frame drops happened. |
| delay_since_last_input | DOUBLE | Difference in OS timestamps of inputs in the current and the previous frame. |
| prev_event_latency_id | INT | The event latency id that will be used as a reference to determine the jank cause. |

<br />

<br />

<br />

**chrome_vsyncs**. Calculate \|VSYNC_INTERVAL\| as the lowest vsync seen in the trace or the minimum delay between frames larger than zero. TODO(\~M130): Remove the lowest vsync since we should always have vsync_interval_ms.

<br />

TABLE
Calculate \|VSYNC_INTERVAL\| as the lowest vsync seen in the trace or the
minimum delay between frames larger than zero.

TODO(\~M130): Remove the lowest vsync since we should always have vsync_interval_ms.

| Column | Type | Description |
|---|---|---|
| vsync_interval | DOUBLE | The lowest delay between frames larger than zero. |

<br />

<br />

<br />

**chrome_janky_frames_no_cause**. Filter the frame view only to frames that had missed vsyncs.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| delay_since_last_frame | DOUBLE | Time elapsed since the previous frame was presented, will be more than \|VSYNC\| in this view. |
| event_latency_id | INT | Event latency id of the presented frame. |
| vsync_interval | DOUBLE | Vsync interval at the time of recording the trace. |
| hardware_class | STRING | Device brand and model. |
| scroll_id | INT | The scroll corresponding to this frame. |
| prev_event_latency_id | INT | The event latency id that will be used as a reference to determine the jank cause. |

<br />

<br />

<br />

**chrome_janky_frames_no_subcause**. Janky frame information including the jank cause.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| delay_since_last_frame | DOUBLE | Time elapsed since the previous frame was presented, will be more than \|VSYNC\| in this view. |
| event_latency_id | INT | Event latency id of the presented frame. |
| vsync_interval | DOUBLE | Vsync interval at the time of recording the trace. |
| hardware_class | STRING | Device brand and model. |
| scroll_id | INT | The scroll corresponding to this frame. |
| prev_event_latency_id | INT | The event latency id that will be used as a reference to determine the jank cause. |
| cause_id | INT | Id of the slice corresponding to the offending stage. |

<br />

<br />

<br />

**chrome_janky_frames**. Finds all causes of jank for all janky frames, and a cause of sub jank if the cause of jank was GPU related.

<br />

TABLE
Finds all causes of jank for all janky frames, and a cause of sub jank
if the cause of jank was GPU related.

| Column | Type | Description |
|---|---|---|
| cause_of_jank | STRING | The reason the Vsync was missed. |
| sub_cause_of_jank | STRING | Further breakdown if the root cause was GPU related. |
| delay_since_last_frame | DOUBLE | Time elapsed since the previous frame was presented, will be more than \|VSYNC\| in this view. |
| event_latency_id | INT | Event latency id of the presented frame. |
| vsync_interval | DOUBLE | Vsync interval at the time of recording the trace. |
| hardware_class | STRING | Device brand and model. |
| scroll_id | INT | The scroll corresponding to this frame. |

<br />

<br />

<br />

**chrome_unique_frame_presentation_ts**. Counting all unique frame presentation timestamps.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| presentation_timestamp | INT | The unique frame presentation timestamp. |

<br />

<br />

<br />

**chrome_janky_frames_percentage**. Dividing missed frames over total frames to get janky frame percentage. This represents the v3 scroll jank metrics. Reflects Event.Jank.DelayedFramesPercentage UMA metric.

<br />

TABLE
Dividing missed frames over total frames to get janky frame percentage.
This represents the v3 scroll jank metrics.
Reflects Event.Jank.DelayedFramesPercentage UMA metric.

| Column | Type | Description |
|---|---|---|
| delayed_frame_percentage | FLOAT | The percent of missed frames relative to total frames - aka the percent of janky frames. |

<br />

<br />

<br />

**chrome_frames_per_scroll**. Number of frames and janky frames per scroll.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | The ID of the scroll. |
| num_frames | INT | The number of frames in the scroll. |
| num_janky_frames | INT | The number of delayed/janky frames. |
| scroll_jank_percentage | DOUBLE | The percentage of janky frames relative to total frames. |

<br />

<br />

<br />

**chrome_causes_per_scroll**. Scroll jank causes per scroll.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | The ID of the scroll. |
| max_delay_since_last_frame | DOUBLE | The maximum time a frame was delayed after the presentation of the previous frame. |
| vsync_interval | DOUBLE | The expected vsync interval. |
| scroll_jank_causes | BYTES | A proto amalgamation of each scroll jank cause including cause name, sub cause and the duration of the delay since the previous frame was presented. |

<br />

<br />

### chrome.scroll_jank.scroll_jank_v3_cause

#### Functions

<br />

**chrome_get_v3_jank_cause_id** -\> LONG. Given two slice Ids A and B, find the maximum difference between the durations of it's direct children with matching names for example if slice A has children named (X, Y, Z) with durations of (10, 10, 5) and slice B has children named (X, Y) with durations of (9, 9), the function will return the slice id of the slice named Z that is A's child, as no matching slice named Z was found under B, making 5 - 0 = 5 the maximum delta between both slice's direct children

<br />

<br />

<br />

Given two slice Ids A and B, find the maximum difference
between the durations of it's direct children with matching names
for example if slice A has children named (X, Y, Z) with durations of (10, 10, 5)
and slice B has children named (X, Y) with durations of (9, 9), the function will return
the slice id of the slice named Z that is A's child, as no matching slice named Z was found
under B, making 5 - 0 = 5 the maximum delta between both slice's direct children
Returns LONG: The slice id of the breakdown that has the maximum duration delta.

| Argument | Type | Description |
|---|---|---|
| janky_slice_id | LONG | The slice id of the parent slice that we want to cause among it's children. |
| prev_slice_id | LONG | The slice id of the parent slice that's the reference in comparison to \|janky_slice_id\|. |

<br />

<br />

### chrome.scroll_jank.scroll_offsets

#### Views/Tables

<br />

**chrome_scroll_input_offsets**. The raw coordinates and pixel offsets for all input events which were part of a scroll.

<br />

TABLE
The raw coordinates and pixel offsets for all input events which were part of
a scroll.

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | An ID that ties all EventLatencies in a particular scroll. (implementation note: This is the EventLatency TraceId of the GestureScrollbegin). |
| event_latency_slice_id | INT | An ID for this particular EventLatency regardless of it being presented or not. |
| scroll_update_id | INT | An ID that ties this \|event_latency_id\| with the Trace Id (another event_latency_id) that it was presented with. |
| ts | INT | Timestamp the of the scroll input event. |
| delta_y | DOUBLE | The delta in raw coordinates between this scroll update event and the previous. |
| relative_offset_y | DOUBLE | The pixel offset of this scroll update event compared to the initial one. |

<br />

<br />

<br />

**chrome_presented_scroll_offsets**. The scrolling offsets for the actual (applied) scroll events

<br />

TABLE
The scrolling offsets for the actual (applied) scroll events. These are not
necessarily inclusive of all user scroll events, rather those scroll events
that are actually processed.

| Column | Type | Description |
|---|---|---|
| scroll_id | INT | An ID that ties all EventLatencies in a particular scroll. (implementation note: This is the EventLatency TraceId of the GestureScrollbegin). |
| event_latency_slice_id | INT | An ID for this particular EventLatency regardless of it being presented or not. |
| scroll_update_id | INT | An ID that ties this \|event_latency_id\| with the Trace Id (another event_latency_id) that it was presented with. |
| ts | INT | Presentation timestamp. |
| delta_y | DOUBLE | The delta in raw coordinates between this scroll update event and the previous. |
| relative_offset_y | DOUBLE | The pixel offset of this scroll update event compared to the initial one. |

<br />

<br />

### chrome.scroll_jank.utils

#### Table Functions

<br />

**chrome_select_long_task_slices** . Extract mojo information for the long-task-tracking scenario for specific names

<br />

<br />

<br />

Extract mojo information for the long-task-tracking scenario for specific
names. For example, LongTaskTracker slices may have associated IPC
metadata, or InterestingTask slices for input may have associated IPC to
determine whether the task is fling/etc.
Argument \| Type \| Description
--- \| --- \| ---
name \| STRING \| The name of slice.

| Column | Type | Description |
|---|---|---|
| interface_name | STRING | Name of the interface of the IPC call. |
| ipc_hash | INT | Hash of the IPC call. |
| message_type | STRING | Message type (e.g. reply). |
| id | INT | The slice id. |

<br />

<br />

### chrome.speedometer

#### Views/Tables

<br />

**chrome_speedometer_measure**. Augmented slices for Speedometer measurements. These are the intervals of time Speedometer uses to compute the final score. There are two intervals that are measured for every test: sync and async

<br />

TABLE
Augmented slices for Speedometer measurements.
These are the intervals of time Speedometer uses to compute the final score.
There are two intervals that are measured for every test: sync and async

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the measure slice |
| dur | INT | Duration of the measure slice |
| name | STRING | Full measure name |
| iteration | INT | Speedometer iteration the slice belongs to. |
| suite_name | STRING | Suite name |
| test_name | STRING | Test name |
| measure_type | STRING | Type of the measure (sync or async) |

<br />

<br />

<br />

**chrome_speedometer_iteration**. Slice that covers one Speedometer iteration. Depending on the Speedometer version these slices might need to be estimated as older versions of Speedometer to not emit marks for this interval

<br />

TABLE
Slice that covers one Speedometer iteration.
Depending on the Speedometer version these slices might need to be estimated
as older versions of Speedometer to not emit marks for this interval. The
metrics associated are the same ones Speedometer would output, but note we
use ns precision (Speedometer uses \~100us) so the actual values might differ
a bit.

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the iteration |
| dur | INT | Duration of the iteration |
| name | STRING | Iteration name |
| iteration | INT | Iteration number |
| geomean | DOUBLE | Geometric mean of the suite durations for this iteration. |
| score | DOUBLE | Speedometer score for this iteration (The total score for a run in the average of all iteration scores). |

<br />

<br />

#### Functions

<br />

**chrome_speedometer_score** -\> DOUBLE. Returns the Speedometer score for all iterations in the trace

<br />

<br />

<br />

Returns DOUBLE: Speedometer score

<br />

<br />

<br />

**chrome_speedometer_renderer_main_utid** -\> INT. Returns the utid for the main thread that ran Speedometer 3

<br />

<br />

<br />

Returns INT: Renderer main utid

<br />

<br />

### chrome.speedometer_2_1

#### Views/Tables

<br />

**chrome_speedometer_2_1_measure**. Augmented slices for Speedometer measurements. These are the intervals of time Speedometer uses to compute the final score. There are two intervals that are measured for every test: sync and async sync is the time between the start and sync-end marks, async is the time between the sync-end and async-end marks.

<br />

TABLE
Augmented slices for Speedometer measurements.
These are the intervals of time Speedometer uses to compute the final score.
There are two intervals that are measured for every test: sync and async
sync is the time between the start and sync-end marks, async is the time
between the sync-end and async-end marks.

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the measure slice |
| dur | INT | Duration of the measure slice |
| name | STRING | Full measure name |
| iteration | INT | Speedometer iteration the slice belongs to. |
| suite_name | STRING | Suite name |
| test_name | STRING | Test name |
| measure_type | STRING | Type of the measure (sync or async) |

<br />

<br />

<br />

**chrome_speedometer_2_1_iteration**. Slice that covers one Speedometer iteration. This slice is actually estimated as a default Speedometer run will not emit marks to cover this interval

<br />

TABLE
Slice that covers one Speedometer iteration.
This slice is actually estimated as a default Speedometer run will not emit
marks to cover this interval. The metrics associated are the same ones
Speedometer would output, but note we use ns precision (Speedometer uses
\~100us) so the actual values might differ a bit. Also note Speedometer
returns the values in ms these here and in ns.

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the iteration |
| dur | INT | Duration of the iteration |
| name | STRING | Iteration name |
| iteration | INT | Iteration number |
| geomean | DOUBLE | Geometric mean of the suite durations for this iteration. |
| score | DOUBLE | Speedometer score for this iteration (The total score for a run in the average of all iteration scores). |

<br />

<br />

#### Functions

<br />

**chrome_speedometer_2_1_score** -\> DOUBLE. Returns the Speedometer 2.1 score for all iterations in the trace

<br />

<br />

<br />

Returns DOUBLE: Speedometer 2.1 score

<br />

<br />

<br />

**chrome_speedometer_2_1_renderer_main_utid** -\> INT. Returns the utid for the main thread that ran Speedometer 2.1

<br />

<br />

<br />

Returns INT: Renderer main utid

<br />

<br />

### chrome.speedometer_3

#### Views/Tables

<br />

**chrome_speedometer_3_measure**. Augmented slices for Speedometer measurements. These are the intervals of time Speedometer uses to compute the final score. There are two intervals that are measured for every test: sync and async.

<br />

TABLE
Augmented slices for Speedometer measurements.
These are the intervals of time Speedometer uses to compute the final score.
There are two intervals that are measured for every test: sync and async.

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the measure slice |
| dur | INT | Duration of the measure slice |
| name | STRING | Full measure name |
| iteration | INT | Speedometer iteration the slice belongs to. |
| suite_name | STRING | Suite name |
| test_name | STRING | Test name |
| measure_type | STRING | Type of the measure (sync or async) |

<br />

<br />

<br />

**chrome_speedometer_3_iteration**. Slice that covers one Speedometer iteration. The metrics associated are the same ones Speedometer would output, but note we use ns precision (Speedometer uses \~100us) so the actual values might differ a bit.

<br />

TABLE
Slice that covers one Speedometer iteration.
The metrics associated are the same ones
Speedometer would output, but note we use ns precision (Speedometer uses
\~100us) so the actual values might differ a bit.

| Column | Type | Description |
|---|---|---|
| ts | INT | Start timestamp of the iteration |
| dur | INT | Duration of the iteration |
| name | STRING | Iteration name |
| iteration | INT | Iteration number |
| geomean | DOUBLE | Geometric mean of the suite durations for this iteration. |
| score | DOUBLE | Speedometer score for this iteration (The total score for a run in the average of all iteration scores). |

<br />

<br />

#### Functions

<br />

**chrome_speedometer_3_score** -\> DOUBLE. Returns the Speedometer 3 score for all iterations in the trace

<br />

<br />

<br />

Returns DOUBLE: Speedometer 3 score

<br />

<br />

<br />

**chrome_speedometer_3_renderer_main_utid** -\> INT. Returns the utid for the main thread that ran Speedometer 3

<br />

<br />

<br />

Returns INT: Renderer main utid

<br />

<br />

### chrome.startups

#### Views/Tables

<br />

**chrome_startups**. Chrome startups, including launch cause.

<br />

TABLE

| Column | Type | Description |
|---|---|---|
| id | INT | Unique ID |
| activity_id | INT | Chrome Activity event id of the launch. |
| name | STRING | Name of the launch start event. |
| startup_begin_ts | INT | Timestamp that the startup occurred. |
| first_visible_content_ts | INT | Timestamp to the first visible content. |
| launch_cause | STRING | Launch cause. See Startup.LaunchCauseType in chrome_track_event.proto. |
| browser_upid | INT | Process ID of the Browser where the startup occurred. |

<br />

<br />

### chrome.tasks

#### Views/Tables

<br />

**chrome_java_views**. A list of slices corresponding to operations on interesting (non-generic) Chrome Java views

<br />

VIEW
A list of slices corresponding to operations on interesting (non-generic)
Chrome Java views. The view is considered interested if it's not a system
(ContentFrameLayout) or generic library (CompositorViewHolder) views.

TODO(altimin): Add "columns_from slice" annotation.
TODO(altimin): convert this to EXTEND_TABLE when it becomes available.

| Column | Type | Description |
|---|---|---|
| filtered_name | STRING | Name of the view. |
| is_software_screenshot | BOOL | Whether this slice is a part of non-accelerated capture toolbar screenshot. |
| is_hardware_screenshot | BOOL | Whether this slice is a part of accelerated capture toolbar screenshot. |
| slice_id | INT | Slice id. |

<br />

<br />

<br />

**chrome_scheduler_tasks**. A list of tasks executed by Chrome scheduler.

<br />

VIEW

| Column | Type | Description |
|---|---|---|
| id | INT | Slice id. |
| type | STRING | Type. |
| name | STRING | Name of the task. |
| ts | INT | Timestamp. |
| dur | INT | Duration. |
| utid | INT | Utid of the thread this task run on. |
| thread_name | STRING | Name of the thread this task run on. |
| upid | INT | Upid of the process of this task. |
| process_name | STRING | Name of the process of this task. |
| track_id | INT | Same as slice.track_id. |
| category | STRING | Same as slice.category. |
| depth | INT | Same as slice.depth. |
| parent_id | INT | Same as slice.parent_id. |
| arg_set_id | INT | Same as slice.arg_set_id. |
| thread_ts | INT | Same as slice.thread_ts. |
| thread_dur | INT | Same as slice.thread_dur. |
| posted_from | STRING | Source location where the PostTask was called. |

<br />

<br />

<br />

**chrome_tasks**. A list of "Chrome tasks": top-level execution units (e.g

<br />

VIEW
A list of "Chrome tasks": top-level execution units (e.g. scheduler tasks /
IPCs / system callbacks) run by Chrome. For a given thread, the slices
corresponding to these tasks will not intersect.

| Column | Type | Description |
|---|---|---|
| id | INT | Id for the given task, also the id of the slice this task corresponds to. |
| name | STRING | Name for the given task. |
| task_type | STRING | Type of the task (e.g. "scheduler"). |
| thread_name | STRING | Thread name. |
| utid | INT | Utid. |
| process_name | STRING | Process name. |
| upid | INT | Upid. |
| ts | INT | Alias of \|slice.ts\|. |
| dur | INT | Alias of \|slice.dur\|. |
| track_id | INT | Alias of \|slice.track_id\|. |
| category | STRING | Alias of \|slice.category\|. |
| arg_set_id | INT | Alias of \|slice.arg_set_id\|. |
| thread_ts | INT | Alias of \|slice.thread_ts\|. |
| thread_dur | INT | Alias of \|slice.thread_dur\|. |
| full_name | STRING | STRING Legacy alias for \|name\|. |

<br />

<br />

### chrome.vsync_intervals

#### Views/Tables

<br />

**chrome_vsync_intervals**. A simple table that checks the time between VSync (this can be used to determine if we're refreshing at 90 FPS or 60 FPS). Note: In traces without the "Java" category there will be no VSync TraceEvents and this table will be empty.

<br />

TABLE
A simple table that checks the time between VSync (this can be used to
determine if we're refreshing at 90 FPS or 60 FPS).

> [!NOTE]
> **Note:** In traces without the "Java" category there will be no VSync TraceEvents and this table will be empty.

| Column | Type | Description |
|---|---|---|
| slice_id | INT | Slice id of the vsync slice. |
| ts | INT | Timestamp of the vsync slice. |
| dur | INT | Duration of the vsync slice. |
| track_id | INT | Track id of the vsync slice. |
| time_to_next_vsync | INT | Duration until next vsync arrives. |

<br />

<br />

#### Functions

<br />

**chrome_calculate_avg_vsync_interval** -\> FLOAT. Function: compute the average Vysnc interval of the gesture (hopefully this would be either 60 FPS for the whole gesture or 90 FPS but that isnt always the case) on the given time segment. If the trace doesnt contain the VSync TraceEvent we just fall back on assuming its 60 FPS (this is the 1.6e+7 in the COALESCE which corresponds to 16 ms or 60 FPS).

<br />

<br />

<br />

Function: compute the average Vysnc interval of the
gesture (hopefully this would be either 60 FPS for the whole gesture or 90
FPS but that isnt always the case) on the given time segment.
If the trace doesnt contain the VSync TraceEvent we just fall back on
assuming its 60 FPS (this is the 1.6e+7 in the COALESCE which
corresponds to 16 ms or 60 FPS).
Returns FLOAT: The average vsync interval on this time segment or 1.6e+7, if trace doesn't contain the VSync TraceEvent.

| Argument | Type | Description |
|---|---|---|
| begin_ts | LONG | Interval start time. |
| end_ts | LONG | Interval end time. |

<br />

<br />

### chrome.web_content_interactions

#### Views/Tables

<br />

**chrome_web_content_interactions**. Chrome web content interactions (InteractionToFirstPaint), including associated high-level metrics and properties. Multiple events may occur for the same interaction; each row in this table represents the primary (longest) event for the interaction. Web content interactions are discrete, as opposed to sustained (e.g. scrolling); and only occur with the web content itself, as opposed to other parts of Chrome (e.g

<br />

TABLE
Chrome web content interactions (InteractionToFirstPaint), including
associated high-level metrics and properties.

Multiple events may occur for the same interaction; each row in this table
represents the primary (longest) event for the interaction.

Web content interactions are discrete, as opposed to sustained (e.g.
scrolling); and only occur with the web content itself, as opposed to other
parts of Chrome (e.g. omnibox). Interaction events include taps, clicks,
keyboard input (typing), and drags.

| Column | Type | Description |
|---|---|---|
| id | INT | Unique id for this interaction. |
| ts | INT | Start timestamp of the event. Because multiple events may occur for the same interaction, this is the start timestamp of the longest event. |
| dur | INT | Duration of the event. Because multiple events may occur for the same interaction, this is the duration of the longest event. |
| interaction_type | STRING | The interaction type. |
| total_duration_ms | INT | The total duration of all events that occurred for the same interaction. |
| renderer_upid | INT | The process id this event occurred on. |

<br />

<br />

## Package: counters

### counters.intervals

#### Macros

<br />

**counter_leading_intervals** . For a given counter timeline (e.g

<br />

<br />

<br />

For a given counter timeline (e.g. a single counter track), returns
intervals of time where the counter has the same value.

Intervals are computed in a "forward-looking" way. That is, if a counter
changes value at some timestamp, it's assumed it *just* reached that
value and it should continue to have that value until the next
value change. The final value is assumed to hold until the very end of
the trace.

For example, suppose we have the following data:
`ts=0, value=10, track_id=1
ts=0, value=10, track_id=2
ts=10, value=10, track_id=1
ts=10, value=20, track_id=2
ts=20, value=30, track_id=1
[end of trace at ts = 40]`

Then this macro will generate the following intervals:
`ts=0, dur=20, value=10, track_id=1
ts=20, dur=10, value=30, track_id=1
ts=0, dur=10, value=10, track_id=2
ts=10, dur=30, value=20, track_id=2`
Returns: TableOrSubquery, Table with the schema (id UINT32, ts UINT64, dur UINT64, track_id UINT64, value DOUBLE, next_value DOUBLE, delta_value DOUBLE).

| Argument | Type | Description |
|---|---|---|
| counter_table | TableOrSubquery | A table/view/subquery corresponding to a "counter-like" table. This table must have the columns "id" and "ts" and "track_id" and "value" corresponding to an id, timestamp, counter track_id and associated counter value. |

<br />

<br />

## Package: graphs

### graphs.dominator_tree

#### Macros

<br />

**graph_dominator_tree** . Given a table containing a directed flow-graph and an entry node, computes the "dominator tree" for the graph

<br />

<br />

<br />

Given a table containing a directed flow-graph and an entry node, computes
the "dominator tree" for the graph. See \[1\] for an explanation of what a
dominator tree is.

\[1\] https://en.wikipedia.org/wiki/Dominator_(graph_theory)

Example usage on traces containing heap graphs:
\`\`\`
CREATE PERFETTO VIEW dominator_compatible_heap_graph AS
-- Extract the edges from the heap graph which correspond to references
-- between objects.
SELECT
owner_id AS source_node_id,
owned_id as dest_node_id
FROM heap_graph_reference
JOIN heap_graph_object owner on heap_graph_reference.owner_id = owner.id
WHERE owned_id IS NOT NULL AND owner.reachable
UNION ALL
-- Since a Java heap graph is a "forest" structure, we need to add a dummy
-- "root" node which connects all the roots of the forest into a single
-- connected component.
SELECT
(SELECT max(id) + 1 FROM heap_graph_object) as source_node_id,
id
FROM heap_graph_object
WHERE root_type IS NOT NULL;

SELECT \*
FROM graph_dominator_tree!(
dominator_compatible_heap_graph,
(SELECT max(id) + 1 FROM heap_graph_object)
);
\`\`\`
Returns: TableOrSubquery, The returned table has the schema (node_id UINT32, dominator_node_id UINT32). \|node_id\| is the id of the node from the input graph and \|dominator_node_id\| is the id of the node in the input flow-graph which is the "dominator" of \|node_id\|.

| Argument | Type | Description |
|---|---|---|
| graph_table | TableOrSubquery | A table/view/subquery corresponding to a directed flow-graph on which the dominator tree should be computed. This table must have the columns "source_node_id" and "dest_node_id" corresponding to the two nodes on either end of the edges in the graph. Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. Note: this means that the graph *must* be a single fully connected component with \|root_node_id\| (see below) being the "entry node" for this component. Specifically, all nodes *must* be reachable by following paths from the root node. Failing to adhere to this property will result in undefined behaviour. If working with a "forest"-like structure, a dummy node should be added which links all the roots of the forest together into a single component; an example of this can be found in the heap graph example query above. |
| root_node_id | Expr | The entry node to \|graph_table\| which will be the root of the dominator tree. |

<br />

<br />

### graphs.partition

#### Macros

<br />

**tree_structural_partition_by_group** . Partitions a tree into a forest of trees based on a given grouping key in a structure-preserving way. Specifically, for each tree in the output forest, all the nodes in that tree have the same ancestors and descendants as in the original tree *iff* that ancestor/descendent belonged to the same group. Example: Input id \| parent_id \| group_key ---\|---\|--- 1 \| NULL \| 1 2 \| 1 \| 1 3 \| NULL \| 2 4 \| NULL \| 2 5 \| 2 \| 1 6 \| NULL \| 3 7 \| 4 \| 2 8 \| 4 \| 1 Or as a graph: `1 (1) / 2 (1) / \ 3 (2) 4 (2) / \ 5 (1) 8 (1) / \ 6 (3) 7 (2)` Possible output (order of rows is implementation-defined) id \| parent_id \| group_key ---\|---\|--- 1 \| NULL \| 1 2 \| 1 \| 1 3 \| NULL \| 2 4 \| NULL \| 2 5 \| 2 \| 1 6 \| NULL \| 3 7 \| 4 \| 2 8 \| 2 \| 1 Or as a forest: `1 (1) 3 (2) 4 (2) 6 (3) | | 2 (1) 7 (2) / \ 5 (1) 8 (1)`

<br />

<br />

<br />

Partitions a tree into a forest of trees based on a given grouping key
in a structure-preserving way.

Specifically, for each tree in the output forest, all the nodes in that tree
have the same ancestors and descendants as in the original tree *iff* that
ancestor/descendent belonged to the same group.

Example:
Input

| id | parent_id | group_key |
|---|---|---|
| 1 | NULL | 1 |
| 2 | 1 | 1 |
| 3 | NULL | 2 |
| 4 | NULL | 2 |
| 5 | 2 | 1 |
| 6 | NULL | 3 |
| 7 | 4 | 2 |
| 8 | 4 | 1 |

Or as a graph:
`1 (1)
/
2 (1)
/ \
3 (2) 4 (2)
/ \
5 (1) 8 (1)
/ \
6 (3) 7 (2)`
Possible output (order of rows is implementation-defined)

| id | parent_id | group_key |
|---|---|---|
| 1 | NULL | 1 |
| 2 | 1 | 1 |
| 3 | NULL | 2 |
| 4 | NULL | 2 |
| 5 | 2 | 1 |
| 6 | NULL | 3 |
| 7 | 4 | 2 |
| 8 | 2 | 1 |

Or as a forest:
`1 (1) 3 (2) 4 (2) 6 (3)
| |
2 (1) 7 (2)
/ \
5 (1) 8 (1)`
Returns: TableOrSubquery, The returned table has the schema (id UINT32, parent_id UINT32, group_key UINT32).

| Argument | Type | Description |
|---|---|---|
| tree_table | TableOrSubquery | A table/view/subquery corresponding to a tree which should be partitioned. This table must have the columns "id", "parent_id" and "group_key". Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. |

<br />

<br />

### graphs.search

#### Macros

<br />

**graph_reachable_dfs** . Computes the "reachable" set of nodes in a directed graph from a given set of starting nodes by performing a depth-first search on the graph

<br />

<br />

<br />

Computes the "reachable" set of nodes in a directed graph from a given set
of starting nodes by performing a depth-first search on the graph. The
returned nodes are structured as a tree with parent-child relationships
corresponding to the order in which nodes were encountered by the DFS.

While this macro can be used directly by end users (hence being public),
it is primarily intended as a lower-level building block upon which higher
level functions/macros in the standard library can be built.

Example usage on traces containing heap graphs:
`-- Compute the reachable nodes from the first heap root.
SELECT *
FROM graph_reachable_dfs!(
(
SELECT
owner_id AS source_node_id,
owned_id as dest_node_id
FROM heap_graph_reference
WHERE owned_id IS NOT NULL
),
(SELECT id FROM heap_graph_object WHERE root_type IS NOT NULL)
);`
Returns: TableOrSubquery, The returned table has the schema (node_id UINT32, parent_node_id UINT32). \|node_id\| is the id of the node from the input graph and \|parent_node_id\| is the id of the node which was the first encountered predecessor in a DFS search of the graph.

| Argument | Type | Description |
|---|---|---|
| graph_table | TableOrSubquery | A table/view/subquery corresponding to a directed graph on which the reachability search should be performed. This table must have the columns "source_node_id" and "dest_node_id" corresponding to the two nodes on either end of the edges in the graph. Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. |
| start_nodes | TableOrSubquery | A table/view/subquery corresponding to the list of start nodes for the BFS. This table must have a single column "node_id". |

<br />

<br />

<br />

**graph_reachable_bfs** . Computes the "reachable" set of nodes in a directed graph from a given starting node by performing a breadth-first search on the graph

<br />

<br />

<br />

Computes the "reachable" set of nodes in a directed graph from a given
starting node by performing a breadth-first search on the graph. The returned
nodes are structured as a tree with parent-child relationships corresponding
to the order in which nodes were encountered by the BFS.

While this macro can be used directly by end users (hence being public),
it is primarily intended as a lower-level building block upon which higher
level functions/macros in the standard library can be built.

Example usage on traces containing heap graphs:
`-- Compute the reachable nodes from all heap roots.
SELECT *
FROM graph_reachable_bfs!(
(
SELECT
owner_id AS source_node_id,
owned_id as dest_node_id
FROM heap_graph_reference
WHERE owned_id IS NOT NULL
),
(SELECT id FROM heap_graph_object WHERE root_type IS NOT NULL)
);`
Returns: TableOrSubquery, The returned table has the schema (node_id UINT32, parent_node_id UINT32). \|node_id\| is the id of the node from the input graph and \|parent_node_id\| is the id of the node which was the first encountered predecessor in a BFS search of the graph.

| Argument | Type | Description |
|---|---|---|
| graph_table | TableOrSubquery | A table/view/subquery corresponding to a directed graph on which the reachability search should be performed. This table must have the columns "source_node_id" and "dest_node_id" corresponding to the two nodes on either end of the edges in the graph. Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. |
| start_nodes | TableOrSubquery | A table/view/subquery corresponding to the list of start nodes for the BFS. This table must have a single column "node_id". |

<br />

<br />

<br />

**graph_next_sibling** . Computes the next sibling node in a directed graph

<br />

<br />

<br />

Computes the next sibling node in a directed graph. The next node under a parent node
is determined by on the \|sort_key\|, which should be unique for every node under a parent.
The order of the next sibling is undefined if the \|sort_key\| is not unique.

Example usage:
`-- Compute the next sibling:
SELECT *
FROM graph_next_sibling!(
(
SELECT
id AS node_id,
parent_id AS node_parent_id,
ts AS sort_key
FROM slice
)
);`
Returns: TableOrSubquery, The returned table has the schema (node_id UINT32, next_node_id UINT32). \|node_id\| is the id of the node from the input graph and \|next_node_id\| is the id of the node which is its next sibling.

| Argument | Type | Description |
|---|---|---|
| graph_table | TableOrSubquery | A table/view/subquery corresponding to a directed graph for which to find the next sibling. This table must have the columns "node_id", "node_parent_id" and "sort_key". |

<br />

<br />

<br />

**graph_reachable_weight_bounded_dfs** . Computes the "reachable" set of nodes in a directed graph from a set of starting (root) nodes by performing a depth-first search from each root node on the graph. The search is bounded by the sum of edge weights on the path and the root node specifies the max weight (inclusive) allowed before stopping the search. The returned nodes are structured as a tree with parent-child relationships corresponding to the order in which nodes were encountered by the DFS

<br />

<br />

<br />

Computes the "reachable" set of nodes in a directed graph from a set of
starting (root) nodes by performing a depth-first search from each root node on the graph.
The search is bounded by the sum of edge weights on the path and the root node specifies the
max weight (inclusive) allowed before stopping the search.
The returned nodes are structured as a tree with parent-child relationships corresponding
to the order in which nodes were encountered by the DFS. Each row also has the root node from
which where the edge was encountered.

While this macro can be used directly by end users (hence being public),
it is primarily intended as a lower-level building block upon which higher
level functions/macros in the standard library can be built.

Example usage on traces with sched info:
\`\`\`
-- Compute the reachable nodes from a sched wakeup chain
INCLUDE PERFETTO MODULE sched.thread_executing_spans;

SELECT \*
FROM
graph_reachable_dfs_bounded
!(
(
SELECT
id AS source_node_id,
COALESCE(parent_id, id) AS dest_node_id,
id - COALESCE(parent_id, id) AS edge_weight
FROM _wakeup_chain
),
(
SELECT
id AS root_node_id,
id - COALESCE(prev_id, id) AS root_target_weight
FROM _wakeup_chain
));
\`\`\`
Returns: TableOrSubquery, The returned table has the schema (root_node_id, node_id UINT32, parent_node_id UINT32). \|root_node_id\| is the id of the starting node under which this edge was encountered. \|node_id\| is the id of the node from the input graph and \|parent_node_id\| is the id of the node which was the first encountered predecessor in a DFS search of the graph.

| Argument | Type | Description |
|---|---|---|
| graph_table | TableOrSubquery | A table/view/subquery corresponding to a directed graph on which the reachability search should be performed. This table must have the columns "source_node_id" and "dest_node_id" corresponding to the two nodes on either end of the edges in the graph and an "edge_weight" corresponding to the weight of the edge between the node. Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. |
| root_table | TableOrSubquery | A table/view/subquery corresponding to start nodes to \|graph_table\| which will be the roots of the reachability trees. This table must have the columns "root_node_id" and "root_target_weight" corresponding to the starting node id and the max weight allowed on the tree. Note: the columns must contain uint32 similar to ids in trace processor tables (i.e. the values should be relatively dense and close to zero). The implementation makes assumptions on this for performance reasons and, if this criteria is not, can lead to enormous amounts of memory being allocated. |
| is_target_weight_floor | Expr | Whether the target_weight is a floor weight or ceiling weight. If it's floor, the search stops right after we exceed the target weight, and we include the node that pushed just passed the target. If ceiling, the search stops right before the target weight and the node that would have pushed us passed the target is not included. |

<br />

<br />

## Package: export

### export.to_firefox_profile

#### Functions

<br />

**export_to_firefox_profile** -\> STRING. Dumps all trace data as a Firefox profile json string See `Profile` in https://github.com/firefox-devtools/profiler/blob/main/src/types/profile.js Also https://firefox-source-docs.mozilla.org/tools/profiler/code-overview.html You would probably want to download the generated json and then open at https://https://profiler.firefox.com You can easily do this from the UI via the following SQL `SELECT CAST(export_to_firefox_profile() AS BLOB) AS profile;` The result will have a link for you to download this json as a file.

<br />

<br />

<br />

Dumps all trace data as a Firefox profile json string
See `Profile` in
https://github.com/firefox-devtools/profiler/blob/main/src/types/profile.js
Also
https://firefox-source-docs.mozilla.org/tools/profiler/code-overview.html

You would probably want to download the generated json and then open at
https://https://profiler.firefox.com
You can easily do this from the UI via the following SQL
`SELECT CAST(export_to_firefox_profile() AS BLOB) AS profile;`
The result will have a link for you to download this json as a file.
Returns STRING: Json profile

<br />

<br />