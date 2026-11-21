**The fixture privacy guard now scans `skills/` for real people, companies, funds and private agent names.**

### Fixed
- `scripts/check-fixture-privacy.sh` covered test fixtures, `evals/` and `docs/test-audit/` but not the bundled skills, which ship in every install; `skillpack-harvest` once named a real downstream agent there. `skills/` is now scanned with the real-entity token list (product names such as OpenClaw stay allowed), with a test for both arms.
