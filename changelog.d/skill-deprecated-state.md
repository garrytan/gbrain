**A skill can now be marked deprecated: it still loads when you name it, but the skill resolver stops suggesting it.**

### Added
- Put `deprecated: true` in a skill's SKILL.md frontmatter (optionally with `replaced_by: <skill>`) and `gbrain skills resolve` no longer suggests it from a word match or offers it to the model picker. Naming it in the turn (`use the reports skill`, `/reports`) still loads it, and the suggestion's reason says it is deprecated and which skill to use instead. A JSON catalog entry takes `"deprecated": true` and `"replaced_by"` the same way.
- A deprecated skill also leaves the trigger index: `gbrain check-resolvable` and the routing eval drop its frontmatter triggers and its RESOLVER.md rows, and do not report it as unreachable.
