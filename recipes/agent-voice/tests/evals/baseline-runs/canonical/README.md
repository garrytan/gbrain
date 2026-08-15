# Canonical baselines (synthetic exemplars)

This directory is reserved for **agent-authored synthetic exemplars** — what a passing eval verdict looks like. Exemplars must contain NO real model output, NO real persona responses, NO operator-specific brain content: PII-impossible by construction. **None are committed yet**; whoever lands the first ones must also fix the parent `.gitignore` (its `!canonical/` pattern doesn't unignore files inside the directory — it needs `!canonical/*.json`).

Once landed, use them as:
1. **Code-review reference** — when reviewing changes to `judge.mjs` or the persona prompts, eyeball these to see what the receipt schema looks like.
2. **Onboarding** — new contributors can read these to understand what the eval suite produces without spending API tokens.
3. **Schema documentation** — the field shape is the contract that live receipts must match.

**Never commit live receipts here.** Live receipts go in `../` (gitignored). The canonical/ subdirectory is the ONLY committed eval output in the entire bundle.

If the eval harness changes its receipt schema, regenerate exemplars by authoring the JSON to match the new schema — do NOT generate them by running the harness against the real personas.
