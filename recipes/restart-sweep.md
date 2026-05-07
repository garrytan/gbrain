---
id: restart-sweep
name: Restart Sweep
version: 0.1.0
description: Detect Telegram messages dropped during OpenClaw gateway restarts. Reads OpenClaw session state, alerts on aborted-mid-run sessions and (opt-in) suspicious silence gaps. Cooldown-gated so repeat detections don't spam.
category: reflex
requires: []
secrets:
  - name: OPENCLAW_OWNER_IDS
    description: Comma-separated user IDs that own this brain instance
    where: openclaw config — your own user IDs from the platforms you connect
  - name: OPENCLAW_TELEGRAM_GROUP
    description: Target Telegram group ID for restart alerts (negative number for groups)
    where: forward a message from the group to @userinfobot, copy the chat.id
health_checks:
  - type: env_exists
    name: OPENCLAW_OWNER_IDS
    label: Owner IDs configured
  - type: env_exists
    name: OPENCLAW_TELEGRAM_GROUP
    label: Telegram group configured
  - type: command
    argv: [openclaw, sessions, --json]
    label: OpenClaw CLI reachable
setup_time: 10 min
cost_estimate: "$0 (no per-call cost; runs locally on cron)"
---

# Restart Sweep: Detect Dropped Messages After Gateway Restarts

When the OpenClaw gateway restarts, webhook-delivered Telegram messages
that haven't been processed yet get dropped permanently. Long-poll bots
can replay missed updates via `getUpdates`. Webhook bots cannot. This
recipe detects the gap by reading OpenClaw's session state and alerting
when a session was active just before a restart but silent afterward.

## IMPORTANT: Instructions for the Agent

**You are the installer.** This recipe is written for YOU (the AI agent)
to execute on behalf of the user. Follow these steps precisely.

**Stop points (MUST pause and verify before continuing):**
- After Step 1: prerequisites pass? If not, fix before proceeding.
- After Step 4: dry run produces sensible output? If not, debug before
  wiring cron.
- After Step 5: cron entry created and visible in `crontab -l`? If not,
  cron isn't installed.

**When something fails:** Tell the user EXACTLY what failed, what it
means, and what to try. Never say "something went wrong."

## What this does

1. Reads `/tmp/bootstrap-services.log` (or `$OPENCLAW_BOOTSTRAP_LOG`)
   to find when the gateway last restarted. Falls back to `now() - 30
   minutes` if the log isn't readable.
2. Runs `openclaw sessions --json` to enumerate all live sessions.
3. Filters to Telegram group sessions matching `$OPENCLAW_TELEGRAM_GROUP`.
4. Flags sessions with `abortedLastRun: true` (strong signal of a
   dropped message). Optionally flags sessions that were active in the
   5 minutes before restart but silent in the 10 minutes after — gated
   behind `OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1` because the timing
   heuristic produces false positives during quiet periods.
5. Cooldown layer: each sessionKey alerted gets stamped with a
   `lastAlertedAt` timestamp. Re-alerting on the same sessionKey is
   suppressed for 6 hours regardless of whether the synthesized restart
   time matches. This prevents the "missing bootstrap log →
   re-alert-every-5-minutes-forever" failure mode.
6. Sends one alert per cycle to Telegram (or stdout if no Telegram
   config), then records the alert in
   `~/.gbrain/integrations/restart-sweep/alerted.json`.

## Prerequisites

- OpenClaw running with Telegram in webhook mode (long-poll mode
  doesn't need this — `getUpdates` recovers missed messages on restart)
- The `openclaw` CLI on PATH (or you'll provide an absolute path in
  Step 5)
- Telegram bot token already configured in OpenClaw, group ID and
  optional topic ID known
- Cron available on the host (this recipe schedules a 5-minute job;
  systemd timers, launchd, or any other scheduler also work — adapt
  Step 5 accordingly)

## Step 1: Verify prerequisites

```bash
openclaw sessions --json | head -40
```

Should print JSON with a `sessions` array. If it errors, fix
`openclaw` reachability before continuing.

Decide a host-repo install path. The recipe assumes
`~/openclaw/scripts/restart-sweep.mjs` and the user's `.env` lives at
`~/openclaw/.env`. Adapt to your repo layout.

## Step 2: Collect the secrets

Confirm with the user:

- `OPENCLAW_OWNER_IDS` — comma-separated user IDs (e.g. `123456789,987654321`)
- `OPENCLAW_TELEGRAM_GROUP` — the target group ID (negative number for
  group chats, e.g. `-1001234567890`). Forward a message from the
  group to `@userinfobot` to get it.
- `OPENCLAW_ALERT_TOPIC` — optional, the topic/thread ID for forum
  groups. Open the topic in Telegram, the URL ends with the thread ID.

Add these three lines to the host's `.env` (or wherever the host loads
env from):

```bash
OPENCLAW_OWNER_IDS=...
OPENCLAW_TELEGRAM_GROUP=...
OPENCLAW_ALERT_TOPIC=...
```

Optional tuning:

```bash
# Set to 1 to enable the timing-based heuristic (active before restart,
# silent after). Off by default because it false-positives during quiet
# periods.
OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1

# Override the bootstrap log path (default /tmp/bootstrap-services.log)
OPENCLAW_BOOTSTRAP_LOG=/var/log/openclaw/bootstrap.log
```

## Step 3: Write the script to the host repo

Write the script content from the next section to
`~/openclaw/scripts/restart-sweep.mjs` (or wherever the user picks).
The script is self-contained — no npm install needed, just Node 18+
or Bun.

<!-- restart-sweep:script -->
```javascript
#!/usr/bin/env node

/**
 * Restart Message Sweep Script
 *
 * Detects Telegram messages dropped during OpenClaw gateway restarts.
 * Webhook-delivered messages can't be replayed via getUpdates, so we
 * read OpenClaw's session state and look for sessions that show signs
 * of dropped processing.
 *
 * Runs under Node 18+ or Bun. Copy this file into your host repo and
 * wire it to a 5-minute cron.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

// Module-level constants (no env reads here — env is read at construct time)
const RESTART_THRESHOLD_MINUTES = 30;  // Fallback restart-time window when bootstrap log is missing
const COOLDOWN_HOURS = 6;              // Re-alert suppression per sessionKey
const STALE_DAYS = 30;                 // Prune alerted.json entries older than this
const PRE_RESTART_WINDOW_MS = 5 * 60 * 1000;
const POST_RESTART_WINDOW_MS = 10 * 60 * 1000;

class MessageSweepDetector {
    /**
     * @param {{ execFile?: typeof execFile, runOpenclawSessions?: () => Promise<any[]> }} [deps]
     *   Optional dependency injection for tests. Production: leave undefined.
     */
    constructor(deps = {}) {
        // Constructor-time env reads (C2): tests can mutate process.env per construction
        const ownerEnv = process.env.OPENCLAW_OWNER_IDS ?? '';
        this.OWNER_IDS = ownerEnv.split(',').map(s => s.trim()).filter(Boolean);
        this.TELEGRAM_GROUP_ID = process.env.OPENCLAW_TELEGRAM_GROUP ?? '';
        this.ALERT_TOPIC = process.env.OPENCLAW_ALERT_TOPIC ?? '';
        this.AGGRESSIVE = process.env.OPENCLAW_RESTART_SWEEP_AGGRESSIVE === '1';

        const gbrainHome = process.env.GBRAIN_HOME ?? path.join(os.homedir(), '.gbrain');
        this.STATE_DIR = path.join(gbrainHome, 'integrations', 'restart-sweep');
        this.LOG_PATH = path.join(this.STATE_DIR, 'sweep.log.jsonl');
        this.ALERTED_PATH = path.join(this.STATE_DIR, 'alerted.json');
        this.BOOTSTRAP_LOG = process.env.OPENCLAW_BOOTSTRAP_LOG ?? '/tmp/bootstrap-services.log';

        // DI hooks (default to real implementations)
        this._execFile = deps.execFile ?? execFile;
        this._runOpenclawSessions = deps.runOpenclawSessions ?? null;

        this.sessions = null;
        this.restartTime = null;
        this.alertMode = this.determineAlertMode();
        this.alerted = new Map();  // populated in run() / loadAlerted()
    }

    determineAlertMode() {
        if (this.TELEGRAM_GROUP_ID && this.ALERT_TOPIC) return 'telegram';
        if (this.TELEGRAM_GROUP_ID) return 'telegram_stdout';
        return 'stdout';
    }

    async run() {
        try {
            console.log('🔍 Starting restart message sweep detection...');

            if (this.OWNER_IDS.length === 0) {
                console.warn('⚠️  No OPENCLAW_OWNER_IDS configured. Set this environment variable.');
            }
            if (!this.TELEGRAM_GROUP_ID) {
                console.warn('⚠️  No OPENCLAW_TELEGRAM_GROUP configured. Alerts will only go to stdout.');
            }

            fs.mkdirSync(this.STATE_DIR, { recursive: true });
            this.alerted = await this.loadAlerted();

            this.restartTime = await this.getLastRestartTime();
            console.log(`📅 Last restart detected at: ${new Date(this.restartTime).toISOString()}`);

            this.sessions = await this.getSessionState();
            console.log(`📊 Found ${this.sessions.length} total sessions`);

            const telegramSessions = this.filterTelegramSessions(this.sessions);
            console.log(`📱 Found ${telegramSessions.length} Telegram sessions`);

            const droppedMessages = await this.detectDroppedMessages(telegramSessions);
            const newDrops = droppedMessages.filter(m => !this.isInCooldown(m.sessionKey));
            const suppressedCount = droppedMessages.length - newDrops.length;

            if (newDrops.length > 0) {
                const tail = suppressedCount > 0 ? ` (${suppressedCount} suppressed by cooldown)` : '';
                console.log(`⚠️  Found ${newDrops.length} potentially dropped message(s)${tail}`);
                await this.recordAndAlert(newDrops);
            } else if (suppressedCount > 0) {
                console.log(`✅ All ${suppressedCount} candidate(s) suppressed by cooldown`);
            } else {
                console.log('✅ No dropped messages detected');
            }

            await this.logResults(droppedMessages);

        } catch (error) {
            console.error('❌ Error in message sweep:', error);
            await this.logError(error);
        }
    }

    async getLastRestartTime() {
        try {
            const logContent = await fsp.readFile(this.BOOTSTRAP_LOG, 'utf8');
            const gatewayLines = logContent.split('\n')
                .filter(line => line.includes('Gateway token synced') || line.includes('✅ OpenClaw gateway'))
                .reverse();
            if (gatewayLines.length > 0) {
                const match = gatewayLines[0].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                if (match) {
                    return new Date(match[1] + ' UTC').getTime();
                }
            }
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
        } catch (error) {
            console.warn('⚠️  Could not determine restart time from logs, using fallback');
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
        }
    }

    async getSessionState() {
        if (this._runOpenclawSessions) {
            return await this._runOpenclawSessions();
        }
        try {
            const { stdout } = await execP('openclaw sessions --json');
            const sessionData = JSON.parse(stdout);
            return sessionData.sessions || [];
        } catch (error) {
            console.error('❌ Failed to get session state:', error);
            throw error;
        }
    }

    filterTelegramSessions(sessions) {
        if (!this.TELEGRAM_GROUP_ID) return [];
        return sessions.filter(session => {
            return session.key &&
                   session.key.includes('telegram:group:' + this.TELEGRAM_GROUP_ID) &&
                   session.kind === 'group';
        });
    }

    async detectDroppedMessages(telegramSessions) {
        const droppedMessages = [];
        const recentRestartWindow = this.restartTime - PRE_RESTART_WINDOW_MS;
        const afterRestartWindow = this.restartTime + POST_RESTART_WINDOW_MS;

        for (const session of telegramSessions) {
            try {
                const sessionUpdated = session.updatedAt;

                // Primary: aborted last run is the strong signal
                if (session.abortedLastRun) {
                    const topic = this._extractTopic(session.key);
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        sessionId: session.sessionId,
                        abortedLastRun: true,
                        reason: 'Session aborted on last run',
                    });
                    continue;
                }

                // Secondary: timing-based gap detection — opt-in only (false-positive prone)
                if (!this.AGGRESSIVE) continue;

                if (sessionUpdated >= recentRestartWindow &&
                    sessionUpdated < this.restartTime &&
                    Date.now() > afterRestartWindow) {
                    const topic = this._extractTopic(session.key);
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        timeSinceUpdate: Math.floor((Date.now() - sessionUpdated) / 1000 / 60),
                        sessionId: session.sessionId,
                        suspiciousGap: true,
                        reason: 'Active before restart, silent after',
                    });
                }
            } catch (error) {
                console.warn(`⚠️  Error analyzing session ${session.key}:`, error);
            }
        }
        return droppedMessages;
    }

    _extractTopic(sessionKey) {
        const m = sessionKey?.match(/:topic:(\d+)/);
        return m ? m[1] : 'unknown';
    }

    /**
     * Cooldown layer (C1): suppresses re-alerts on the same sessionKey
     * for COOLDOWN_HOURS, regardless of whether the synthesized
     * restartTime matches. Cooldown wins when the bootstrap log is
     * missing and restartTime is unstable.
     */
    isInCooldown(sessionKey) {
        const entry = this.alerted.get(sessionKey);
        if (!entry || !entry.lastAlertedAt) return false;
        const ageMs = Date.now() - new Date(entry.lastAlertedAt).getTime();
        return ageMs < COOLDOWN_HOURS * 60 * 60 * 1000;
    }

    async loadAlerted() {
        try {
            const content = await fsp.readFile(this.ALERTED_PATH, 'utf8');
            const parsed = JSON.parse(content);
            const map = new Map();
            const cutoffMs = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
            for (const [key, entry] of Object.entries(parsed || {})) {
                if (entry && entry.lastAlertedAt) {
                    const ts = new Date(entry.lastAlertedAt).getTime();
                    if (Number.isFinite(ts) && ts >= cutoffMs) {
                        map.set(key, entry);
                    }
                }
            }
            return map;
        } catch (err) {
            if (err && err.code === 'ENOENT') return new Map();
            console.warn(`⚠️  Failed to load ${this.ALERTED_PATH}: ${err && err.message}; starting with empty state`);
            return new Map();
        }
    }

    async saveAlerted() {
        const obj = Object.fromEntries(this.alerted);
        const json = JSON.stringify(obj, null, 2);
        const tmp = this.ALERTED_PATH + '.tmp';
        // Atomic on POSIX: write tmp, then rename. Note: this prevents
        // file corruption only — concurrent cron runs can still both
        // read old state, both decide to alert, both rename. Given
        // 5-min cadence and 2-5s runtime, overlap is rare and a
        // duplicate alert is preferable to a missed one.
        await fsp.writeFile(tmp, json);
        await fsp.rename(tmp, this.ALERTED_PATH);
    }

    async recordAndAlert(droppedMessages) {
        let alertSent = false;
        try {
            await this.alertOnDroppedMessages(droppedMessages);
            alertSent = true;
        } catch (err) {
            console.error('❌ Failed to send alert (will retry next cycle):', err && err.message);
        }
        if (!alertSent) return;

        const nowIso = new Date().toISOString();
        const restartIso = new Date(this.restartTime).toISOString();
        for (const msg of droppedMessages) {
            this.alerted.set(msg.sessionKey, {
                lastAlertedAt: nowIso,
                restartTime: restartIso,
            });
        }
        try {
            await this.saveAlerted();
        } catch (err) {
            console.warn('⚠️  Failed to save alerted state:', err && err.message);
        }
    }

    async alertOnDroppedMessages(droppedMessages) {
        let alertText = `⚠️ Found ${droppedMessages.length} unprocessed message(s) after restart:\n\n`;
        for (const msg of droppedMessages.slice(0, 10)) {
            alertText += `• Topic ${msg.topic}: ${msg.reason} (last update: ${msg.lastUpdate})\n`;
            if (msg.timeSinceUpdate) {
                alertText += `  ${msg.timeSinceUpdate} minutes ago\n`;
            }
        }
        if (droppedMessages.length > 10) {
            alertText += `\n... and ${droppedMessages.length - 10} more`;
        }

        switch (this.alertMode) {
            case 'telegram':
                await this.sendTelegramAlert(alertText);
                break;
            case 'telegram_stdout':
                console.log('📢 Would send Telegram alert, but no topic configured:');
                console.log(alertText);
                break;
            default:
                console.log('📢 Alert:');
                console.log(alertText);
        }
    }

    async sendTelegramAlert(alertText) {
        // execFile (not exec): argv array, no shell interpretation,
        // shell metachars in env vars cannot inject commands.
        const argv = [
            'message', 'send',
            '--channel', 'telegram',
            '--target', this.TELEGRAM_GROUP_ID,
            '--thread-id', this.ALERT_TOPIC,
            '--message', alertText,
        ];
        await new Promise((resolve, reject) => {
            this._execFile('openclaw', argv, (err, _stdout, stderr) => {
                if (err) {
                    err.stderr = stderr;
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        console.log('📢 Alert sent to Telegram');
    }

    async logResults(droppedMessages) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            restartTime: new Date(this.restartTime).toISOString(),
            droppedMessageCount: droppedMessages.length,
            droppedMessages,
        };
        try {
            await fsp.appendFile(this.LOG_PATH, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.warn('⚠️  Failed to write log file:', error && error.message);
        }
    }

    async logError(error) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            error: error && error.message,
            stack: error && error.stack,
        };
        try {
            await fsp.appendFile(this.LOG_PATH, 'ERROR: ' + JSON.stringify(errorEntry) + '\n');
        } catch (logError) {
            console.error('Failed to log error:', logError && logError.message);
        }
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const detector = new MessageSweepDetector();
    detector.run().catch(console.error);
}

export default MessageSweepDetector;
```

## Step 4: Dry-run

Run the script once manually with the env loaded, before wiring cron:

```bash
set -a; source ~/openclaw/.env; set +a
node ~/openclaw/scripts/restart-sweep.mjs
```

Expected output (no drops):

```
🔍 Starting restart message sweep detection...
📅 Last restart detected at: 2026-05-06T12:53:45.000Z
📊 Found 48 total sessions
📱 Found 39 Telegram sessions
✅ No dropped messages detected
```

If you want to see the alert path, manually edit a session in OpenClaw
to set `abortedLastRun: true` and re-run. After the alert fires, check
`~/.gbrain/integrations/restart-sweep/alerted.json` — the sessionKey
should be there with a `lastAlertedAt` timestamp. Re-running within 6
hours suppresses the alert.

## Step 5: Wire 5-minute cron

Cron does NOT inherit your shell environment. `openclaw` and `node` may
not be on cron's stripped PATH. `.env` files don't auto-load. Use the
wrapper-script pattern below to handle both.

Create `~/openclaw/scripts/restart-sweep-wrapper.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a
source ~/openclaw/.env
set +a
exec /usr/local/bin/node ~/openclaw/scripts/restart-sweep.mjs
```

```bash
chmod +x ~/openclaw/scripts/restart-sweep-wrapper.sh
```

Adjust `/usr/local/bin/node` to wherever your `node` actually lives
(`which node` to find it). Same for `openclaw` if the wrapper needs to
add it to PATH explicitly:

```bash
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
```

Add to crontab via `crontab -e`:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * /bin/bash ~/openclaw/scripts/restart-sweep-wrapper.sh >> ~/.gbrain/integrations/restart-sweep/cron.log 2>&1
```

Verify with `crontab -l`. Wait 5 minutes, then check the cron log to
confirm it ran:

```bash
tail -20 ~/.gbrain/integrations/restart-sweep/cron.log
```

## Step 6: Verification

1. `gbrain integrations doctor restart-sweep` — should pass all three
   health checks
2. `~/.gbrain/integrations/restart-sweep/sweep.log.jsonl` exists and
   gets a new entry every 5 minutes
3. `~/.gbrain/integrations/restart-sweep/cron.log` shows successful
   invocations (no PATH errors, no `command not found`)
4. After a real OpenClaw restart with a stuck session, the Telegram
   alert fires once, then the cooldown layer suppresses repeats for 6h

## Tuning

`OPENCLAW_RESTART_SWEEP_AGGRESSIVE=1` — enables the secondary
"active-before-restart, silent-after" heuristic. Off by default because
during normal quiet periods (overnight, weekends) it false-positives.
Enable if you want maximum sensitivity AND you've established that your
group is consistently active.

The cooldown threshold (6 hours) is a constant in the script. Edit
`COOLDOWN_HOURS` if you need different behavior — e.g. 24 hours if your
group's normal cadence is daily.

## Troubleshooting

### Alerts firing repeatedly on the same session

Check `~/.gbrain/integrations/restart-sweep/alerted.json`. If the
sessionKey is missing or `lastAlertedAt` is recent, the cooldown should
suppress. If it's not suppressing:

- The state file may not be writable. Check `ls -ld
  ~/.gbrain/integrations/restart-sweep/`.
- `GBRAIN_HOME` may be set to a different path under cron than under
  your shell. Check the wrapper script's env loading.
- The script's `STATE_DIR` resolution prints in stderr if mkdir fails.
  Check the cron log.

### Telegram alert fails silently

The script logs `❌ Failed to send alert (will retry next cycle)` to
stderr when `openclaw message send` returns non-zero. Common causes:

- `openclaw` not on cron's PATH (use absolute path in the wrapper)
- Telegram bot token expired or rate-limited
- Wrong group/topic ID (try `openclaw message send --channel telegram
  --target $OPENCLAW_TELEGRAM_GROUP --message test` manually)

When the send fails, state is NOT updated, so next cycle retries.

### Bootstrap log missing

If `/tmp/bootstrap-services.log` (or `$OPENCLAW_BOOTSTRAP_LOG`) doesn't
exist, the script falls back to `now() - 30 minutes` for restartTime.
The cooldown layer keeps this from spamming. If you want a stable
restart anchor, point `OPENCLAW_BOOTSTRAP_LOG` at OpenClaw's actual
startup log (whatever your deployment uses).

### Cron environment

The wrapper script in Step 5 handles 80% of cron-day-one failures, but
two more knobs:

- **Locale:** if your script ever interpolates user-provided text into
  log lines, set `LANG=en_US.UTF-8` in the cron entry to avoid mojibake.
- **Working directory:** cron starts in `$HOME` by default. The script
  uses absolute paths everywhere, so this shouldn't matter, but if you
  ever add a relative-path dependency, `cd ~/openclaw` in the wrapper.

## Future upgrade path

This recipe is the v1 shape: a script copied into the host repo and
wired to cron. The v2 shape is a plugin Minion handler registered in
the OpenClaw repo against `gbrain/minions` (see
`docs/guides/plugin-handlers.md`). Plugin-handler advantages:

- Built-in queue idempotency (no cooldown layer needed)
- Submit via `gbrain jobs submit restart-sweep` from any cron / agent /
  manual trigger
- Centralized retry / backoff / lock management
- One less host script to maintain

When this becomes the right tradeoff (multiple deployments, multiple
cron schedules, or just enough complexity to justify the move), promote
to the plugin-handler shape and deprecate this recipe.
