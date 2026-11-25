**`gbrain doctor` now warns when Claude Code, Codex or Hermes turns keep missing the skill resolver's deadline, as it already did for OpenClaw.**

### Fixed
- The `skill_resolver` check listed the hook lane's recent error codes but stayed `ok` however many turns timed out, so a host losing a third of its skill suggestions looked healthy. It now warns with `skill_resolve_timeout` when one harness misses the deadline on more than 5% of at least 20 recent turns it ranked, the bar the OpenClaw plugin already uses. A miss is either the lane's own timeout or the resolver running out of time; prompts the lane never ranked (resolver off, a blank prompt, no catalog) and SessionStart deliveries are left out of the rate.
