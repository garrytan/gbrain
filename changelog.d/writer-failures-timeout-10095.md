**Writer failure reports can use a longer read timeout.**

### Fixed
- `gbrain sources writer failures` accepts `--timeout-ms` for large receipt histories. The command includes the chosen budget in pagination and group drill-down commands. (#10095)

<!-- behavior-change: writer_failures_timeout_10095 -->
