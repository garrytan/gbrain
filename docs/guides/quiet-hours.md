# Quiet Hours and Timezone-Aware Delivery

## Goal

Hold all notifications during sleep hours, merge held messages into the morning briefing, and adjust automatically when the user travels.

## What the User Gets

Without this: 3 AM pings from cron jobs. One bad notification and the user
disables the entire system.

With this: the brain works overnight (dream cycle, collectors, enrichment)
but notifications are held until morning. Travel to Tokyo? The system adjusts
automatically from your calendar, no config change needed.

## Implementation

### Quiet Hours Gate

Every cron job that sends notifications must check quiet hours FIRST.

```
QUIET_START = 23  // 11 PM local time
QUIET_END = 8     // 8 AM local time

is_quiet(local_hour):
  return local_hour >= QUIET_START OR local_hour < QUIET_END
```

**Before sending any notification:**
1. Determine user's current timezone (from config or heartbeat state)
2. Convert current UTC time to local time
3. If quiet hours: hold the message, don't send

### Held Messages

During quiet hours, output goes to a held directory instead of being sent:

```
if is_quiet():
  mkdir -p /tmp/cron-held/
  write("/tmp/cron-held/{job-name}.md", output)
  exit  // don't send
else:
  send(output)
```

The morning briefing picks up held messages:

```
morning_briefing():
  held_files = list("/tmp/cron-held/*.md")
  if held_files:
    briefing += "## Overnight Updates\n\n"
    for file in held_files:
      briefing += read(file)
      delete(file)
```

This way nothing is lost. Overnight cron results get folded into the
first thing the user sees in the morning.

### Timezone Awareness

The agent should know what timezone the user is in. Store it in
the agent's operational state:

```json
{
  "currentLocation": {
    "timezone": "US/Pacific",
    "city": "San Francisco"
  }
}
```

**Update the timezone when:**
- Calendar shows the user flying somewhere (check for airline/hotel events)
- User mentions being in a different city
- User's active hours shift (they're responding at 3 AM PT = they're probably traveling)

**All times shown to the user should be in their LOCAL timezone.** Never
show UTC or a timezone the user isn't in.

### Shell Implementation

```bash
#!/bin/bash
# quiet-hours-gate.sh — run before any notification

TIMEZONE="${USER_TIMEZONE:-US/Pacific}"
LOCAL_HOUR=$(TZ="$TIMEZONE" date +%H)

if [ "$LOCAL_HOUR" -ge 23 ] || [ "$LOCAL_HOUR" -lt 8 ]; then
  echo "QUIET_HOURS=true"
  exit 1  # don't send
fi

echo "QUIET_HOURS=false"
exit 0  # ok to send
```

**In cron job scripts:**
```bash
# Check quiet hours first
if ! bash scripts/quiet-hours-gate.sh; then
  mkdir -p /tmp/cron-held
  echo "$OUTPUT" > /tmp/cron-held/$(basename "$0" .sh).md
  exit 0
fi

# Not quiet hours — send normally
send_notification "$OUTPUT"
```

### Configurable Hours

Some users want different quiet hours. Store the config:

```json
{
  "quiet_hours": {
    "start": 23,
    "end": 8,
    "enabled": true
  }
}
```

Set `enabled: false` to disable quiet hours entirely (e.g., for 24/7 monitoring).

## Tricky Spots

1. **Gate on EVERY job.** The quiet hours check must run before every single
   cron job that produces notifications. If even one job skips the gate, the
   user gets a 3 AM ping and loses trust in the entire system. No exceptions.

2. **Held messages MUST be picked up.** If the morning briefing doesn't read
   `/tmp/cron-held/`, overnight results vanish silently. Verify the briefing
   skill reads and clears the held directory. Orphaned held files mean the
   pickup integration is broken.

3. **Timezone auto-detection is fragile.** Calendar-based timezone detection
   relies on the user having airline/hotel events with location data. If the
   user books travel without calendar entries, the system won't detect the
   move. Fall back to activity-hour analysis (responding at 3 AM PT = probably
   not in PT anymore) and ask the user if uncertain.

## How to Verify

1. **Set quiet hours to the current hour.** Temporarily set `QUIET_START` to
   one hour before now and `QUIET_END` to one hour after. Trigger a cron job.
   Verify the output goes to `/tmp/cron-held/` instead of being sent.

2. **Check held message pickup.** After step 1, run or simulate the morning
   briefing. Verify the held message appears in the "Overnight Updates"
   section and the file is deleted from `/tmp/cron-held/`.

3. **Verify timezone adjustment.** Change the timezone config to a zone where
   it's currently quiet hours. Trigger a notification. Verify it's held. Change
   back to your real timezone during active hours. Trigger again. Verify it sends.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
