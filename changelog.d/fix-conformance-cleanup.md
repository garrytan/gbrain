**`gbrain protocol conformance` no longer leaves a synthetic `people/conformance-run-<uuid>` page behind.**

### Fixed
- After its cases, the conformance runner forgets the world fact it still holds and soft-deletes the `people/conformance-<marker>` page it seeded (restorable for the usual recovery window, then purged). Before, every run left one synthetic person page in the target brain, and they rose to the top of `gbrain salience`. Cleanup is best-effort and never changes the verdict; the report gains a `cleanup` field, and the CLI prints a line when the page could not be deleted. The private fence-test fact is left in place, because a remote caller may not forget a private fact.
