**Re-adopting a shared-skill pack after you accept a reviewed edit no longer deletes that skill's other files from your checkout, makes a private skill visible again, or drops the tools a skill was limited to.**

### Fixed
- When the v0.53.0 shared-content migration re-adopted a pack after a reviewed inventory edit, it rebuilt each skill from its `SKILL.md` alone. A reference or asset file the skill had published was deleted from the content checkout, a skill published with `private: true` became visible to readers, and requirements declared through `put_skill` were dropped. Adoption now keeps each sealed skill's private flag, its requirements, its `SKILL.md` dependencies, and every other file still in the checkout. A file you removed stays removed; a kept file that nothing reaches any more is refused by name instead of deleted.
- Adoption publishes only the bytes whose hashes you reviewed: a file changed between the review and the publication is refused.
- The migration now publishes an accepted edit to a reference file alone, and an accepted inventory that removes a reference file, instead of reporting the skill as already adopted or refusing.
