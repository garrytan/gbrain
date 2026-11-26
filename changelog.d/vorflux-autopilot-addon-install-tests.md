**Tests now prove the automatic upgrade installs the Rust engine addon only after the upgrade is settled, and that a failed addon install never marks a good upgrade as failed.**

### Tests
- The automatic-upgrade test checks that `gbrain engine install rust` runs after the swap is settled (its receipt is gone), not inside the swap's own time limit.
- A new test makes the addon install fail on a Rust brain and checks that autopilot still relaunches the new version and records nothing as a failed version.
- A unit test pins the install's own 2-minute limit.

No behavior changes.
