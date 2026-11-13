### Hermes can turn on the skill resolver with one setup command

**`gbrain setup hermes --skill-loading resolve` now wires the skill resolver into Hermes the way it already does for Claude Code and Codex.** Before, Hermes users built the catalog, edited `config.json` and pasted the hook by hand.

- Setup builds the `hermes-user` catalog from `$HERMES_HOME/skills` (nested category folders included) and adds the resolver's `pre_llm_call` entry to gbrain's marked `hooks:` block in `$HERMES_HOME/config.yaml`, approving it in Hermes's `shell-hooks-allowlist.json`. The block also carries the brain-first turn rule. Each feature adds and removes only its own entry: `--no-instructions` keeps the resolver, `--skill-loading off` keeps the turn rule, and the block goes when its last entry does. An existing install's turn-rule block is left byte for byte as it was.
- The command runs without a shell, the way Hermes runs hooks: `/usr/bin/env GBRAIN_HOOK_LANE=skill-resolver <launcher> <gbrain> hook user-prompt --harness hermes`.
- If your config.yaml already has its own `hooks:` section, setup refuses and prints the entry to paste under it. Once you paste it, the next run approves and keeps it. `--skill-loading off` withdraws that approval but leaves your own section alone, so delete the pasted entry yourself. A Hermes with no SOUL.md still gets the resolver.
- Hermes compacts conversations in place and tells hooks nothing about it. The lane now starts a session's dedupe fresh on a first turn, or when the conversation history is shorter than it was on the last turn, so skills offered before a compaction can be offered again. It reads the history's length in the same streaming pass, so a large history still costs about one JSON parse.
- `gbrain config set skills.resolver.per_harness.hermes.owner_sender_ids <id>,<id>` limits suggestions to turns from those senders, using the same rule as the OpenClaw plugin. A turn from anyone else, or with no sender, gets no block.
- Pinned skills for Hermes (`gbrain skills pin add <id> --catalog hermes-user`) go in a marked block in `$HERMES_HOME/SOUL.md` while the resolver is on. With no pins there is no block, and SOUL.md is never created.
- `gbrain doctor`'s `skill_resolver` check now covers Hermes, and warns when Hermes's allowlist no longer approves the hook.

### The OpenClaw skill resolver no longer suggests skills the agent cannot use

**`gbrain setup openclaw --skill-loading resolve` now leaves out of each agent's suggestions the skills OpenClaw hides from that agent's model.** Before, the catalog came from the agent's skill folders alone, so a suggestion could name a skill that is not eligible on the host, that the agent's skill filter excludes, or that OpenClaw dropped at load, and the model could not open it.

- Setup reads `openclaw skills list --json --agent <id>` for each agent and adds every catalog skill it does not show the model (`modelVisible` false, or not listed) to that agent's `exclude_ids`. It names those skills, and tags the ones OpenClaw did not list with `skill_resolver_host_load_cut`.
- When the command fails, or lists none of the catalog's skills, nothing is filtered and setup says why. With no openclaw on PATH nothing changes.
- Run setup again after changing which skills an agent can use; the plugin reads the new list from its state file without a gateway reload.

### Pi can turn on the skill resolver with one setup command

**`gbrain setup pi --skill-loading resolve` installs a Pi extension that names the few installed skills that fit each request.** Pi lists every skill in its system prompt; with many skills the model picks from a long list, and now it also gets a short ranked one.

- Setup builds the `pi-user` catalog from `$PI_CODING_AGENT_DIR/skills` and `~/.agents/skills`, and writes the extension to `$PI_CODING_AGENT_DIR/extensions/gbrain-skill-resolver/`. It runs one turn through the extension under Node and, when `pi` is on PATH, checks that `pi --help` lists `--gbrain-skill-resolver`; if Pi does not load it, setup exits 3 with `skill_resolver_plugin_not_installed`.
- Before each user run, up to 3 suggestions go to the model as one hidden message with each skill's SKILL.md path. A skill already suggested in the session is not offered again until Pi compacts the conversation, also across `pi -p -c` runs. Pinned skills (`gbrain skills pin add <id> --catalog pi-user`) go in a system prompt section that stays the same from run to run. A pinned skill, or one Pi does not show the model, is never suggested.
- With Pi 1.5.2 and a fake model server, a cold `pi -p` run waited 70 to 100 ms for suggestions (the budget is 150 ms on a cold run and 50 ms after), and a `pi -ne -p` run got nothing.
- Pi started with extensions off (`pi --no-extensions`, or a program that embeds Pi with `noExtensions`, such as QM) gets no suggestions; setup and `gbrain doctor` say so. Project skill folders are not in the catalog.
- `gbrain setup pi --skill-loading off` removes the extension and its state. Nothing opens a brain, so a keyless or brainless install stays as it is.
