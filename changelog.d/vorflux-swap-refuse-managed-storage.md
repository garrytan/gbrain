**Fixed: `gbrain engine swap --plan` refuses a brain that uses managed storage instead of showing a plan the swap could not finish.**

### Fixed
- The Rust engine never holds managed storage, so a swap of a managed brain would fail partway, after writes were paused. The swap plan now checks first and refuses with `engine_swap_refused` (reason `managed_storage`, exit 3) and asks you whether the brain should stay on its current engine. Nothing is read past that check and nothing is written.
