**The swap report now prints one line for each kind of write that criterion 5 does not compare.**

### Changed
- Under criterion 5, `gbrain engine swap --to rust --plan` lists chunks, tags, aliases, timeline entries, takes, facts, fact withdrawals, open loops, sources, owner-only marks and the decide store, each with how many writes of that kind the shadow run sampled, or "not sampled". One more line lists every other kind of write that was sampled, so no count is hidden. In `--json` the same lines are a new `lines` list on the criterion 5 row; the other fields are unchanged.
- Fact withdrawals has no count of its own, so its line says so and shows the `pages:updateSlug` count, which is where those writes are counted.
- Nothing about pass or fail changes, and nothing new is compared.

### Known limits
- The last line names a gap. Page and link writes other than `put_page`, `delete_page` and the link writes (for example a soft delete) are also not compared, and a write that touches several tables is counted under its first table only. A criterion 5 pass still covers page and link writes only.
