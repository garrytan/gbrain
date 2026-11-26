**Eleven small fixes from outside reports: doctor, sync timing, dream previews, the nightly probe and four test helpers.**

### Fixed
- The nightly quality probe's chat calls now carry `phase:nightly_quality_probe` in the usage ledger, so they can be told apart from other calls to the same model. An enclosing job's phase still wins. (#10425; reported and first fixed by @Kkkkkuro)
- `gbrain doctor`'s extraction health names halt reasons from the same UTC 7-day window as its halt totals, so near midnight it no longer names a reason from an expired day. (#10397, @Kkkkkuro)
- `gbrain doctor --index-audit` keeps listing a unique index whose concurrent build failed before it was ready for writes; built unique and primary-key indexes stay off the list. (#10413, @Kkkkkuro)
- An interrupted PostgreSQL data-file read now points agents at the database host instead of `gbrain db-repair`, whose connection probe reports healthy during that fault. (#10408, @Kkkkkuro)
- One torn or non-event line in the agent-contract log no longer hides every other event from `gbrain doctor`. (#10447, @Kkkkkuro)
- Managed sync measures pass durations with a monotonic clock, so a system clock change no longer creates or hides a slow-pass warning. (#10441, @Kkkkkuro)
- `gbrain dream --phase synthesize --dry-run` no longer deletes expired verdict-cache rows. (#10448, @Kkkkkuro)

### Tests
- The legacy-slug test checks exact filenames, so it passes on case-insensitive macOS volumes. (#10406, @Kkkkkuro)
- The pooled graduation E2E case creates its target database on the server behind the pooler. (#10430, @Kkkkkuro)
- The doctor golden normalizes a disconnect caller frame cut off at 200 characters. (#10431, @Kkkkkuro)
- The previous-release golden keeps a fixture URL's query string in its redacted form. (#10437, @Kkkkkuro)
