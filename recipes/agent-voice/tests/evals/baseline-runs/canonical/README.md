# Canonical baselines (synthetic exemplars)

These JSON files are **agent-authored synthetic exemplars** — what a passing eval verdict looks like. They contain NO real model output, NO real persona responses, NO operator-specific brain content. PII-impossible by construction.

Use them as:
1. **Code-review reference** — when reviewing changes to `judge.mjs` or the persona prompts, eyeball these to see what the receipt schema looks like.
2. **Onboarding** — new contributors can read these to understand what the eval suite produces without spending API tokens.
3. **Schema documentation** — the field shape is the contract that live receipts must match.

**Never commit live receipts here.** Live receipts go in `../` (gitignored). The canonical/ subdirectory is the ONLY committed eval output in the entire bundle.

If the eval harness changes its receipt schema, regenerate these by hand-editing the JSON to match — do NOT generate them by running the harness against the real personas.
