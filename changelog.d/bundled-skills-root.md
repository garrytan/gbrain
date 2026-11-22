**`gbrain bundled-skill --json` now prints the skills folder of the installed gbrain, so tools built on gbrain's skills can find it without guessing.**

<!-- behavior-change: bundled_skill_json_skills_root -->

### Added
- `gbrain bundled-skill --json` (with no skill name) has a new `skills_root` field: the absolute path of the `skills/` folder this gbrain was installed with, found from the running gbrain rather than the current directory, so another gbrain checkout in the working directory never answers. It is `null` for a single-file binary, whose skills live only inside it; read those with `gbrain bundled-skill <name> --asset <path>`.
