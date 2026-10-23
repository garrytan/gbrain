# Key files: Derived generations

[Subsystem index](../KEY_FILES.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/generations/{contract,plan,publish,proofs,config,repair,ledger-scrub}.ts` + `adapters/{page,atoms,index}.ts` (GBRA-161) — the generation primitive: one ledger row per derived key generation (`derived_generations`, items and bounded preimages in `derived_generation_items`); `publishGeneration` holds a shrunk, oversize, unproven-empty, valve or segmented result and otherwise writes, completes, rechecks, retires (versioned, stamped) and activates in one transaction. `gbrain repair generations` restores or releases from previews; doctor `generation_retirements` / `generation_held`. Reference: [generations](../generations.md). Tests: `test/pathological/g1-generations.test.ts`, `test/pathological/g1-atom-generations.test.ts`.
