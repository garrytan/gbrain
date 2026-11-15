**A first install prints no Bun error and ends with memory connected, on every agent harness.**

### Changed
- gbrain no longer ships a postinstall script, so `bun install -g github:garrytan/gbrain#stable` no longer ends with "Blocked 1 postinstall", and a clone's `bun install` no longer prints "postinstall skipped". The script did nothing on a fresh install; migrations already run in `gbrain setup`, `gbrain upgrade` and on the first command.
- After reinstalling over an older brain, commands print a `migrations_pending` notice naming the upgrade migrations still to run, with `gbrain apply-migrations --yes` as the fix.
- `gbrain init` treats connecting the agent as an install step (its own `harness_wiring` notice), not a setting awaiting approval. The first-run settings are reported as in effect, with how to change them, and no "Reply 'defaults'" question; automatic saving shows as off (recommended salient) instead of "default: salient".
- The install docs no longer tell agents to stop and ask about search mode: connect first, then report the settings and the cost matrix in the install reply.

<!-- behavior-change: install_no_postinstall_gst2732 -->
<!-- behavior-change: first_run_connects_then_reports_gst2732 -->
