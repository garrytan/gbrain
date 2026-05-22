# Claw-test brief — upgrade-from-v0.18

You inherit a gbrain v0.18 brain (the harness has already replayed a seed SQL dump into a PGLite database). Walk through the upgrade path:

1. **Run `gbrain doctor --json`** first. Note any warnings or fix-hints.
2. **Run `gbrain init --pglite`** with the existing database path. The migration chain should detect the old `schema_version` and walk forward to the latest.
3. **Run `gbrain doctor --json` again.** The `status` field should be `"ok"`.
4. **Verify queries still work:** `gbrain query "alice"` should return results from the seeded brain.

## Friction protocol

If anything is confusing, missing, surprising, or wrong (especially around the migration steps — these are the highest-historical-pain regression points), run:

```
gbrain friction log --severity {confused|error|blocker|nit} --phase <which-step> --message "<what-happened>" [--hint "<what-could-be-better>"]
```

Common upgrade-flow friction patterns to watch for:

- The migration chain failed at a specific schema version (capture the version + error)
- Doctor flagged an issue but the fix-hint wasn't actionable
- `gbrain init --pglite` didn't recognize the existing brain
- Manual SQL was needed to unblock something

If something just worked, log a delight. We're tuning the upgrade flow toward zero-friction.
