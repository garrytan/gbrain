**Contributors: two pull requests that each add an error code no longer conflict in the export-surface golden.**

### Changed
- The export-surface golden test now lists every registered error code in its own file, `test/fixtures/goldens/exports/error-codes.json`, sorted and one code per line. Before, all codes sat on one long line of `test/fixtures/goldens/exports/types.json`, so every pull request that added a code changed that line and conflicted with every other one. The type surface now shows that list as `RegistryCode`.
- The test still fails when an error code or a public export is removed or renamed. After you add a code, regenerate with `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/export-surface-golden.test.ts`; the diff is one added line.
