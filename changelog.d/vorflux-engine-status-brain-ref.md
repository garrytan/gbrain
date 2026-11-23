**New: `gbrain engine status --probe` prints `brain_ref`, a one-way reference to your brain, also while `gbrain serve` holds it.**

### Added
- `brain_ref` is a 16-character digest of the brain's persistence identity. A reviewed policy, such as a dated override of the engine swap's shadowing rule, can name one brain with it. It cannot be turned back into the identity, and gbrain never prints the identity itself.
- A PGLite brain that a running `gbrain serve` holds still reports its `brain_ref`: the serve records it at start in a private file next to the brain, and the probe trusts that file only while that same serve holds the brain.

<!-- behavior-change: engine_status_brain_ref -->
