### Cursor can keep a project's pinned skills in front of the agent

**`gbrain setup cursor --skill-loading resolve`, run in a project, gives Cursor the skills you pin for that project on every request.** Cursor gets no per-turn suggestions: none of its hooks can add text to the model's request.

- Setup builds a catalog for the project from the skill folders Cursor loads there (`.agents`, `.cursor`, `.claude` and `.codex` skills in the project and your home directory) and prints its name. `gbrain skills pin add <id> --catalog <name>` checks the id against that catalog.
- The pins go in their own always-applied rule, `.cursor/rules/gbrain-pinned-skills.mdc`, with each skill's SKILL.md path. In a git repository its path goes in `.git/info/exclude`, so it is never committed. Your own rules are never touched, and with no pins there is no file.
- `gbrain doctor` reports Cursor as partial: pinned only, no per-turn hook, unverified. Nothing on this machine can see Cursor's request to confirm the rule reaches the model.
- The pins sit beside the skills index that `--skill-loading spring` writes into gbrain's brain-first rule: on Cursor, resolve leaves that index in place, and `--skill-loading spring` leaves the pinned-skills rule in place.
- `gbrain setup cursor --skill-loading off` removes the rule and its exclude line; the pins stay in config.json. Nothing opens a brain, so a keyless or brainless install stays as it is.
