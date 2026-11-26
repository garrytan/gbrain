**Managed sync reports elapsed time accurately when the system clock changes.**

### Fixed

- Managed sync measures pass and preparation times with a monotonic clock, so system clock adjustments cannot create or hide a slow-pass warning.

<!-- behavior-change: sync_pass_monotonic_duration -->
