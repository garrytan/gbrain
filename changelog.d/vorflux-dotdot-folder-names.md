**Files in a folder whose name starts with two dots, such as `..drafts` or `...`, are no longer refused or reported as outside the brain by sync, git commit-push, doctor, frontmatter, skills and the other checks listed below.**

<!-- behavior-change: dotdot_folder_names_inside -->

### Fixed
- Many path checks asked "does this path start with two dots?" to catch a path that goes up and out of a folder. That question also matched a normal folder named `..drafts`, `..x` or `...`, so a file inside the brain was refused, skipped or called "outside". All of these checks now look at the first folder name exactly, through one shared helper. Remote file uploads into such a folder are still refused; a separate fix covers that check.
- `gbrain git commit-push -- ..drafts/a.md` commits the file instead of failing with "outside the checkout", and a `gbrain.sourceRoot` of `..drafts` now scopes the commit to that folder instead of being dropped (which scoped it to the whole checkout).
- Sync markers no longer report a file that was never committed as committed when the source sits in a `..` folder of its repository.
- Skill packs and the skills catalog (`get_skill`, `list_skills`) read a `SKILL.md` that sits in, or is linked to, an in-pack `..shared` folder.
- `gbrain frontmatter` expects the slug `..drafts/note` for `..drafts/note.md`, as for any other folder, instead of reporting a false slug mismatch; its backups of two `note.md` files in different `..` folders no longer overwrite each other.
- Doctor's git-writer and foreign-writer checks, brain-repo hardening (including a `core.hooksPath` of `..hooks`), the first-turn brain rule, extract-benchmark, extract-atoms transcript labels, skillpack update bases, sync applicability, fence-write and reconcile path states, and the LongMemEval call plan treat such folders as inside.
- Real escapes stay refused with the same messages as before: `../x`, an absolute path elsewhere, a sibling folder that shares the root's name prefix, a symlinked parent that points outside, and another Windows drive.

### Added
- `bun run verify` runs `check:relative-dotdot`, which refuses a new `.startsWith('..')` containment check in `src/` and points at `relativeEscapesRoot` in `src/core/path-confine.ts`.
