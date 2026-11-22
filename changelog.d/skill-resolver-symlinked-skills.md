**The skill resolver now finds skills that installers symlink into a skills folder, such as a gstack install.**

<!-- behavior-change: skill_resolver_symlinked_skills_gst3459 -->

### Fixed
- `gbrain skills index build --dir` skipped every symlink whose target left the folder it was reading. gstack installs its skills as links into its own checkout, so on a machine with gstack the resolver indexed 2 of its 65 Claude Code skills and none of its Codex skills. A symlink that leaves the folder is now followed when it points at a skill folder (a directory holding SKILL.md) or at a SKILL.md file, and the skill is indexed under the link's path, so its plugin namespace and the path in the block stay the ones the harness sees. Any other symlink that leaves the folder is still skipped as `symlink_outside_root`, and loops are still cut by real path.
