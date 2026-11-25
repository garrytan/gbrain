**Dream checks that the selected phase can use your transcript file.**

### Fixed
- `gbrain dream --input` now reports a usage error when the selected phases omit synthesis. Previously the command could ignore the chosen file and proceed with another phase over its usual inputs.

<!-- behavior-change: dream_input_requires_synthesis -->
