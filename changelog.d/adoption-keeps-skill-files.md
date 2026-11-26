**Re-adopting a shared-skill pack after you accept a reviewed `SKILL.md` edit no longer deletes a skill's other files from your checkout or makes a private skill visible; adoption now refuses that skill by name and changes nothing.**

### Fixed
- When the v0.53.0 shared-content migration re-adopted a pack after a reviewed inventory edit, it republished each skill from its `SKILL.md` alone. A skill's reference, asset or script files were deleted from the content checkout, and a skill published with `private: true` became visible to readers. Pack re-adoption now refuses such a skill by name (`local_conflict`), writes nothing and deletes nothing, and names the skill and the `import_skill_proposal` remedy.
- `import_skill_proposal` refuses a change to a published skill's own private flag or routing (requirements, description, triggers), and refuses while `skillpack.json` declares a skill that is not published yet.
- An adoption resumed after an upgrade runs the same loss check before it touches the checkout.
