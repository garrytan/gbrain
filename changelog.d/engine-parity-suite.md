**A new test suite now checks that the PGLite and Postgres engines give the same answers, method by method, on every CI run.**

### Tests
- `test/engine-parity/` runs one scenario on every engine arm and fails when the arms disagree. PGLite runs in every unit lane, with no skip. Postgres runs wherever `DATABASE_URL` is set, including the `unit-postgres-arms` lane, which now lists each parity file. A future engine joins through `test/engine-parity/harness.ts` with no change to the cases.
- `test/engine-parity/coverage.tsv` is a generated list of every BrainEngine method and whether a parity case calls it on every arm. It currently covers 192 of 197 methods. Regenerate it with `bun test/engine-parity/coverage.ts --write`; `test/engine-parity/coverage.test.ts` fails when the list is stale.
- Each case must call every method it declares, so the coverage number cannot claim a method that no case actually calls.
- `rewriteLinks` left the shrink-only uncalled list in `test/engine-surface-coverage.test.ts`, because a parity case now calls it. Its smoke stays as a shape pin.
