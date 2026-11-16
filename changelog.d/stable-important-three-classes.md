**Stable moves within a day only for security, data-loss and stable-regression fixes; everything else waits for the weekly move.**

### Changed
- An important fix, the kind that moves the stable channel early, is now only a security fix, a data-loss fix or a fix for a regression in a release that is on stable. A fix that unblocks one setup, or a regression only alpha releases have, rides the weekly move unless a maintainer promotes by hand. `gbrain upgrade --help`, docs/STABILITY.md, docs/RELEASING.md ("Daily stable check") and changelog.d/README.md say so.
- `scripts/build-behavior-changes.ts` (in `check:regen-all`) refuses a changelog fragment whose `important:` class is anything but `security`, `regression` or `data-loss`, naming the three and docs/RELEASING.md#daily-stable-check, the same way it refuses a `bump:` other than `patch`. A `# comment` after a front-matter value is no longer read as part of it.
- Tests: `test/scripts/build-behavior-changes.test.ts` covers the refused and accepted `important:` values.

<!-- behavior-change: stable_important_three_classes_gst2818 -->
