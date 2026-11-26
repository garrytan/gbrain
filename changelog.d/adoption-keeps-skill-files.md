**Re-adopting a shared-skill pack after you accept a reviewed `SKILL.md` edit no longer deletes that skill's other files from your checkout or makes a private skill visible again.**

### Fixed
- When the v0.53.0 shared-content migration re-adopted a pack after a reviewed inventory edit, it rebuilt each skill from its `SKILL.md` alone. A reference or asset file the skill had published was deleted from the content checkout, and a skill published with `private: true` became visible to readers. Adoption now keeps each sealed skill's private flag, its `SKILL.md` dependencies, and every other file still in the checkout. A file you removed from the checkout stays removed.
