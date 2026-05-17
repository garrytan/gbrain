# Upgrades and Auto-Update Notifications

## Goal

Users get notified of new GBrain features conversationally, and the agent walks them through upgrading with post-upgrade migrations that make the new version actually work.

## What the User Gets

Without this: GBrain ships updates but nobody knows. The user stays on an old
version with stale skills and missing features. Or worse, someone runs
`gbrain upgrade` but skips the post-upgrade steps, leaving new code with old
agent behavior.

With this: the agent checks for updates daily, sells the upgrade with punchy
benefit-focused bullets, waits for explicit permission, then runs the full
upgrade flow including re-reading skills, running migrations, and syncing
schema. The user gets new capabilities automatically.

## Implementation

### The Check (cron-initiated)

```
check_for_update():
  result = run("gbrain check-update --json")

  if not result.update_available:
    exit_silently()  // do NOT message the user

  // Sell the upgrade — lead with what they can DO, not what changed
  message = compose_upgrade_message(
    current: result.current_version,
    latest: result.latest_version,
    changelog: result.changelog
  )
  send_to_user(message, respect_quiet_hours=true)
```

### The Upgrade Message

Sell the upgrade. The user should feel "hell yeah, I want that." Lead with
what they can DO now that they couldn't before, not what files changed.

```
> **GBrain v0.5.0 is available** (you're on v0.4.0)
>
> What's new:
> - Your brain never falls behind. Live sync keeps the vector DB current
>   automatically, so edits show up in search within minutes
> - New verification runbook catches silent failures before they bite you
> - New installs set up live sync automatically. No more manual setup step
>
> Want me to upgrade? I'll update everything and refresh my playbook.
>
> (Reply **yes** to upgrade, **not now** to skip, **weekly** to check
> less often, or **stop** to turn off update checks)
```

### Handling Responses

| User says | Action |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | Run the full upgrade flow (below) |
| not now / later / skip / snooze | Acknowledge, check again next cycle |
| weekly | Store preference, switch cron to weekly |
| daily | Store preference, switch cron back to daily |
| stop / unsubscribe / no more | Disable the cron. Tell user how to resume |

**Never auto-upgrade.** Always wait for explicit confirmation.

### The Full Upgrade Flow (after user says yes)

```
full_upgrade():
  // Step 1: Update the binary/package
  run("gbrain upgrade")

  // Step 2: Re-read all updated skills
  for skill in find("skills/*/SKILL.md"):
    read_and_internalize(skill)  // updated skills = better agent behavior

  // Step 3: Re-read production reference docs
  read("docs/GBRAIN_SKILLPACK.md")
  read("docs/GBRAIN_RECOMMENDED_SCHEMA.md")

  // Step 4: Check for version-specific migration directives
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists:
      read_and_execute(migration)  // in order, don't skip

  // Step 5: Schema sync — suggest new, respect declined
  state = read("~/.gbrain/update-state.json")
  for recommendation in new_schema_recommendations:
    if recommendation not in state.declined:
      suggest_to_user(recommendation)
  update(state, new_choices)

  // Step 6: Report what changed
  summarize_to_user(actions_taken)
```

### Migration Files

Migration files live at `skills/migrations/vX.Y.Z.md`. They contain agent
instructions (not scripts) for post-upgrade actions that make the new version
work for existing users. Example: v0.5.0 migration sets up live sync and
runs the verification runbook.

The agent reads migration files in version order and executes them step by
step. Without migrations, the agent has new code but the user's environment
hasn't changed.

### Cron Registration

```
Name: gbrain-update-check
Default schedule: 0 9 * * * (daily 9 AM)
Weekly schedule: 0 9 * * 1 (Monday 9 AM)
Prompt: "Run gbrain check-update --json. If update_available is true,
  summarize the changelog and message me asking if I'd like to upgrade.
  If false, stay silent."
```

### Frequency Preferences

Default: daily. Store in agent memory as `gbrain_update_frequency: daily|weekly|off`.
Also persist in `~/.gbrain/update-state.json` so it survives agent context resets.

### Standalone Skillpack Users

If you loaded this SKILLPACK directly (copied or read from GitHub) without
installing gbrain, you can still stay current. Both GBRAIN_SKILLPACK.md and
GBRAIN_RECOMMENDED_SCHEMA.md have version markers:

```bash
curl -s https://raw.githubusercontent.com/yongchand/gbrain-company/base/docs/GBRAIN_SKILLPACK.md | head -1
# Returns: <!-- skillpack-version: X.Y.Z -->
```

If the remote version is newer, fetch the full file and replace your local
copy. Set up a weekly cron to check automatically.

## Tricky Spots

1. **Never auto-install.** The upgrade must always wait for the user's explicit
   "yes." Even if the cron detects an update at 9 AM and the changelog looks
   great, the agent messages the user and waits. Auto-installing can break
   workflows, introduce breaking changes, or interrupt work in progress.

2. **Migration files are agent instructions, not scripts.** They tell the agent
   what to do step by step in plain language. They are NOT bash scripts to
   execute blindly. The agent reads them, understands the context, and adapts
   to the user's specific environment (e.g., skip a step if the user already
   has live sync configured).

3. **check-update should run on a daily cron.** Don't rely on the user
   remembering to check for updates. The cron runs `gbrain check-update --json`
   daily at 9 AM (respecting quiet hours). If there's nothing new, it stays
   completely silent. The user only hears about updates when there IS something
   worth upgrading to.

## How to Verify

1. **Run check-update and verify detection.** Execute
   `gbrain check-update --json`. Verify it returns the current version and
   correctly reports whether an update is available. If `update_available`
   is false, verify the version matches the latest release on GitHub.

2. **Verify migration files are readable.** List `skills/migrations/` and
   check that each file follows the naming convention `vX.Y.Z.md`. Open one
   and verify it contains step-by-step agent instructions, not raw scripts.
   The agent should be able to read and execute each step.

3. **Test the full upgrade flow end-to-end.** If an update is available, say
   "yes" and watch the agent execute the full flow: upgrade, re-read skills,
   run migrations, sync schema, report. Verify each step completes and the
   agent reports what changed.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
