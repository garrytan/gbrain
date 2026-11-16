**Doctor previews preserve pending migrations, and remote selections identify checks that were not measured.**

### Fixed

- `gbrain doctor --remediate --dry-run` now connects without applying startup migrations. Applying remediation still completes startup only after consent. Diagnostic scans may still update their checkpoints.
- `run_doctor` reports requested checks missing from its focused report as unknown warnings, while preserving measured findings and the caller's source scope.
- An explicit `tier: "ops"` rejects selections outside that tier instead of reporting skipped checks as healthy. Connection checks that run at every tier remain available, and selecting checks without an explicit tier keeps its existing routing.
