**`gbrain skillpack harvest` now harvests a skill whose paired file sits in a folder that starts with the skill's name, such as `skills/foo-extra/` next to `skills/foo/`.**

### Fixed
- A paired source in a sibling folder whose name starts with the skill's name was treated as a file of the skill folder, so the harvest stopped with `path_traversal` and copied nothing. The harvest now copies it to the same path as any other paired source. Symlinks and files outside the repo are still refused.
- A harvest that refuses a paired source now stops before it writes anything. Before, it could copy the skill folder first and leave it behind, so a second try stopped with `slug_collision`.
