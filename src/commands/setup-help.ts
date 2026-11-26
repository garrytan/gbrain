export const SETUP_HELP = `gbrain setup <harness> — give an agent harness memory in one command

Usage: gbrain setup claude-code [flags]
       gbrain setup codex [flags]
       gbrain setup hermes [flags]   (registers MCP through hermes mcp add, then the rule and hook)
       gbrain setup openclaw|opencode|cursor [flags]   (after the harness's own
         MCP registration: writes the brain-first rule and per-turn hook; without it
         agents in a new session seldom call gbrain)

Resolves the brain, source, transport, launcher and registration owner first and
prints them; refuses before writing anything when another owner holds the target.
With no brain configured it creates a keyless local one (gbrain init --pglite
--no-embedding). It then writes the MCP entry and hooks into the harness's own
config and verifies them with the harness_wiring smoke. Codex: [mcp_servers.<name>]
and the hook trust entries in $CODEX_HOME/config.toml, the hooks in hooks.json.

Flags:
  --dry-run            Print the target and every step; write nothing.
  --json               One JSON document on stdout (target, decisions, steps, states).
  --surface S          MCP tool surface: verbs, starter or full, listed in full; pins the
                       entry (default: GBRAIN_SURFACE, then the surface already registered,
                       then the harness default. Claude Code and Hermes: starter with only the
                       memory verbs and request_tools listed (serve --surface starter
                       --advertise verbs). Codex: full, because Codex does not reload its tool
                       list; a Codex entry that follows the default moves with it on a re-run,
                       a pinned one stays. config mcp.default_surface_<harness> full|starter
                       turns a harness's default).
  --advertise A        With --surface: list only A's tools (verbs, starter or full, no wider
                       than the surface). --surface starter --advertise verbs pins the
                       starter registration exactly (claude-code, codex).
  --scope user|project Wiring scope: every Claude Code session (user, default) or only
                       sessions in this directory (project: ~/.claude.json projects
                       entry + .claude/settings.local.json). Codex: user only.
  --no-hooks           Register MCP only; install no hooks (GBRAIN_HOOKS=0 does the same).
  --capture            Accept automatic capture: also install the capture hooks
                       (Claude Code: Stop and SessionEnd; Codex: SessionEnd).
  --no-capture         Decline automatic capture (the default).
  --providers          Accept provider use: a new brain is created with embeddings.
  --no-providers       Decline provider use (the default: keyless, no paid calls).
  --name NAME          MCP server name (default gbrain); one name per install.
  --source ID          Pin the source the MCP server and hooks use.
  --gbrain-bin PATH    Absolute gbrain launcher (default: the gbrain on PATH).
  --serves one|several Whom the brain serves (default one: nothing changes). several labels each
                       person: config access.serves = several, a member, a folder rule
                       people/<member>/ only that member reads and one key bound to that member
                       (a 0600 file under <config>/member-keys/), then one bound read per member
                       proves it. A one-person setup on a brain that already serves several
                       people (2+ enabled members) refuses rather than write a connection bound
                       to nobody, unless this harness's entry or config mcp.stdio_member binds it.
  --members IDS        The people of --serves several, comma-separated (e.g. alice-example,bob-example).
  --labelled-only      With --serves several or --template team: each member's key reads only pages labelled for
                       that member (readable_by or a rule), never the owner's. Opt-in.
  --open-history       With --serves several or --template team on a brain that serves one person and already holds
                       pages: let the members read them. Without it or --labelled-only, setup
                       refuses (setup_history_choice_required) and writes nothing.
  --members-file PATH  The same, one id per line.
  --owner ID           With --serves several, --shape household or --template team: the brain owner, added as a member and named with
                       gbrain access owner set when the brain has none (default: your login name
                       as a member id). An existing owner is kept. No key is rebound: setup lists
                       the keys bound to no member with the auth rescope command for each.
  --stdio-member ID    claude-code or codex: write serve --stdio-member ID into this harness's
                       MCP entry, so only its sessions read as ID (an enabled member, or one
                       of --members). Other harnesses on this host are unchanged. Use it for a
                       harness only ID uses; refused where OpenClaw or Hermes is installed
                       (give each person their own HTTP key there). A re-run keeps the entry's
                       member. With --serves several and --shape company or both, an entry
                       with no member is tied to the brain owner.
  --no-stdio-member    Remove --stdio-member from this harness's entry, or leave it unbound.
  --history WHAT       claude-code or codex, a brain this setup created: none (skip for this run),
                       decline (never offer again), latest (the newest session) or 1-30 (days).
                       Unset, a new brain offers the newest session first and the rest of the
                       last 30 days on a second yes; off a terminal the offer is a decision
                       (accept: --history-decision ID). Private archive source only, no model.
  --history-dir DIR    Read DIR/claude-code, DIR/codex and DIR/openclaw instead of the harness folders.
  --no-extract         Import without deriving links.
  --no-suggestion      claude-code or codex: turn the first-session suggestion off for this
                       install (the agent's offer of one thing it found, then one more import,
                       in the first 3 sessions). Later: gbrain onboarding off.

  --remove             Remove exactly what setup wrote (unchanged entries only), the
                       brain-first instruction block included. The brain and your
                       notes stay. Combine with --dry-run to preview.
  --no-instructions    Opt out of the brain-first instruction block (see below); an
                       existing block is removed and the opt-out is remembered.
                       GBRAIN_AGENT_INSTRUCTIONS=0 does the same.
  --instructions       Opt back in after an earlier --no-instructions.
  --instructions-only  Manage only the brain-first block (on OpenClaw and Hermes, with
                       its per-turn hook): no brain, MCP or other hook changes.
                       Works for a hosted connection too, and for any harness below.
  --workspace DIR      OpenClaw: the agent workspace whose AGENTS.md gets the block
                       (default: agents.defaults.workspace, then ~/.openclaw/workspace).
  --skill-loading M    off (default), spring or resolve. spring adds a compact index of
                       gbrain's bundled skills beside the brain-first block (about
                       1.5k tokens) and loads a skill's full text only when a task
                       matches (gbrain bundled-skill <name>, from this gbrain).
                       resolve (claude-code, codex, hermes) indexes the harness's own
                       skills (~/.claude/skills; Codex: ~/.agents/skills,
                       CODEX_HOME/skills; Hermes: $HERMES_HOME/skills) and adds a
                       separate per-turn hook that names the few skills that fit
                       each prompt (word match; nothing leaves the machine).
                       gbrain setup pi --skill-loading resolve does the same for
                       Pi with an extension in $PI_CODING_AGENT_DIR/extensions.
                       gbrain setup cursor --skill-loading resolve, run in a project,
                       gives Cursor that project's pinned skills only (gbrain skills
                       pin) in .cursor/rules/gbrain-pinned-skills.mdc, kept out of
                       commits; Cursor has no per-turn hook gbrain can use.
                       off removes what an earlier run wrote. The
                       choice is remembered; GBRAIN_SKILL_LOADING sets it too.
  --wakeshift          OpenClaw: install Wakeshift's OpenClaw plugin (@wakeshift/openclaw, pinned)
                       so gbrain can wake an OpenClaw session when a job finishes. Asks
                       consent (--yes), runs OpenClaw's own installer, changes nothing else.
  --shape personal     claude-code, codex: give the brain a personal shape. Writes three
                       empty starter pages, create-only (me/facts, me/voice,
                       me/how-i-decide, each marked status: stub; nothing about you is
                       invented) and a short block beside the brain-first block that
                       tells the agent to read them. A brand-new brain set up without
                       --shape asks (at a terminal) or returns the brain_shape decision
                       (agents); nothing is written until it is answered.
  --shape company      Adds a company source (in default search only when the brain
                       serves one person) with empty pages for company facts,
                       decisions, pricing, customers, calls and playbooks, and the
                       matching lines in that block. --shape both does personal too.
  --shape household    claude-code, codex: set the brain up for a household. Preview first;
                       --yes applies: the owner, another adult, a labelled-only helper and
                       family chat (an audience member), the household groups, one folder
                       rule per household folder (each naming the owner), and one key per
                       member in a 0600 file under <config>/member-keys/ (never printed;
                       children get none), plus a household block in the instructions.
                       --household-members adult:ID,helper:ID,chat:ID or none changes who.
                       --status [--receipt ID] prints the run's receipt and what each key
                       reads; --resume ID --yes finishes a stopped run.
                       Guide: docs/tutorials/household-brain.md.
  --template team      claude-code, codex: set the brain up for a team (--shape company, or
                       both). Needs --members ID,ID (the owner is in the team already).
                       Preview first; --yes applies: each member with a folder only they
                       read and one key in a 0600 file under <config>/member-keys/ (never
                       printed), the team-members group (--team-group ID names another),
                       and company/ and rules/team/ readable by the owner and that group.
                       --guests KIND:ID,... adds the guest source with those writers. A
                       group or rule it did not make is never changed (BLOCKED instead).
                       A brain that serves one person and holds other pages needs
                       --labelled-only or --open-history first (BLOCKED without).
                       --status [--receipt ID] and --resume ID --yes as for household.
                       Guide: docs/tutorials/company-brain.md.
  --shape none         Remove that block; the pages stay.
  --notes DIR          With --shape personal or both: import a notes folder (absolute or
                       ~/), read only, then check keyless search finds a note in it. Over
                       500 markdown files, setup prints the import command instead.
  --docs DIR           With --shape company or both: import a company docs folder into
                       the company source the same way, read only.
  --transcripts DIR    With --shape company or both (not --team): import exported call
                       transcripts (.txt, .md) once each as company/calls/<date>-<title>
                       pages in the company source: words kept, credentials redacted,
                       keyword-only, readable by whoever reads that source. Setup says
                       who that is. Not the conversation archive (conversations/).
  --team | --solo      With a company shape: --team prints where a team's shared company
                       brain lives and creates nothing for it; --solo (the default) makes
                       the company part on this brain.
  --skills-index-only  Refresh every skills index recorded for this harness (its
                       file, launcher and skill set as recorded) and change
                       nothing else; with --skill-loading off, remove them.

Brain-first instructions: registering MCP is not enough; agents use a brain they
are told about. By default setup also writes one short marked block into the
harness's own instruction file (before answering any turn, search the brain
first, read the hit, fill gaps with other tools, apply your own access rules,
finish the task). Text outside the markers is never touched; a re-run upgrades
the block in place. The same rule rides each turn where the harness has a per-turn
hook: Claude Code and Codex get it from setup's UserPromptSubmit hook, OpenClaw
from a hook-only plugin (before_prompt_build) setup installs with the openclaw
CLI, Hermes from a marked pre_llm_call hook setup adds to $HERMES_HOME/config.yaml;
Cursor's rule is always applied.
  claude-code  ~/.claude/CLAUDE.md (project scope: ./CLAUDE.local.md)
  codex        $CODEX_HOME/AGENTS.md (a non-empty AGENTS.override.md instead)
  opencode     ~/.config/opencode/AGENTS.md
  openclaw     <workspace>/AGENTS.md
  hermes       $HERMES_HOME/SOUL.md, after the identity text (never created: an
               empty SOUL.md would replace Hermes's default identity)
  cursor       ./.cursor/rules/gbrain-brain-first.mdc (project rule)
  Other clients (Claude Desktop, ChatGPT, Perplexity, Grok, Muse): --instructions-only
  prints the block to paste into the client's custom instructions.

States: configured (entries written), connection-verified (the smoke answered),
native-pending (no observed push into a native session yet), native-verified (an
observed push is on record for this harness and setup wired and trusted that event;
Codex: UserPromptSubmit, codex-cli 0.162.1).

Refusals: setup never starts a second owner or a second brain. A hosted brain is
wired with gbrain connect <url> --harness <harness> --install; a running
serve --http owner with gbrain bootstrap harness --harness <harness> --yes.

Supported harnesses: claude-code, codex (MCP, hooks and instructions). hermes: setup
registers MCP through Hermes's own hermes mcp add and writes the instruction block
and hook. opencode, openclaw and cursor: setup writes the instruction block and
prints the MCP registration step from their guide.
setup and onboard differ: setup wires a harness to a brain; onboard (post-connect)
improves an existing brain's content.
`;
