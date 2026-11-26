**Shadow mode no longer loses sampled writes when a command exits, and no longer sheds a burst of edits that fits.**

### Fixed
- A command such as `gbrain sync` hands its sampled writes to the shadow worker through a pipe and exits. Bun drops what the pipe has not delivered at exit, and nothing counted those samples (in a real run only 76 to 127 of 160 arrived). The command now waits up to 2 seconds for the pipe to flush before it exits and writes down how many samples it sent; the worker counts any it never received as `uncomparable` (`pipe_unflushed`), exactly once.
- The shadow worker waited to replay at most 16 sampled writes at a time, so a burst of edits (28 saved pages) shed 12 as `queue_full`. It now holds up to 256 (and at most 16 MiB of sample text); anything past that is still counted `queue_full`.
- A shadow worker started while the previous one still owned the store threw its results away without a count. They are now counted `uncomparable` as `no_epoch`.

### Changed
- A command that sends samples may wait up to 2 seconds longer at exit when the shadow worker is behind; with nothing in the pipe there is no wait.
- `gbrain engine shadow status` shows two new `uncomparable` reasons, `pipe_unflushed` and `no_epoch`. Neither is a worker crash.
- Nothing about what counts as `comparable` changes, and a lost or shed sample is never counted as compared.

### Known limits
- The worker still records each result with one durable write, so a very large burst can still outrun it and be counted `queue_full` or `child_exit_deadline`; batching those writes is the next step.
