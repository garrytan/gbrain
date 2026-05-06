# Restart Message Sweep

Detects messages dropped during OpenClaw gateway restarts by analyzing session state patterns.

## Problem

When OpenClaw gateway restarts, webhook-delivered messages that haven't been processed yet get dropped permanently. Unlike long-polling, webhooks can't be "replayed" to recover missed messages. This creates gaps in message handling that can go unnoticed.

## Solution

This tool analyzes OpenClaw's session state to identify patterns indicating dropped messages:

1. **Sessions with `abortedLastRun` flag** - Direct indicator of incomplete processing
2. **Suspicious timing gaps** - Sessions active just before restart but silent afterward

## Setup

### Environment Variables

```bash
# Required: Comma-separated user IDs that own the brain instance
OPENCLAW_OWNER_IDS="123456789,987654321"

# Required for Telegram alerts: Target Telegram group ID
OPENCLAW_TELEGRAM_GROUP="-1001234567890"

# Optional: Specific topic/thread ID for alerts (if using forum groups)
OPENCLAW_ALERT_TOPIC="12345"
```

### Detection Logic

**Primary heuristic:** Sessions with `abortedLastRun: true`
- Strongest signal of dropped message
- Session was processing when gateway stopped

**Secondary heuristic:** Timing-based gap detection
- Session updated within 5 minutes before restart
- Session silent for 10+ minutes after restart
- Indicates message received but not processed

## Usage

```bash
# Basic usage
node restart-sweep.mjs

# With environment configuration
OPENCLAW_OWNER_IDS="123,456" OPENCLAW_TELEGRAM_GROUP="-1001234" node restart-sweep.mjs
```

## Alert Modes

1. **Telegram** (`OPENCLAW_TELEGRAM_GROUP` + `OPENCLAW_ALERT_TOPIC` set)
   - Sends structured alert to specific Telegram topic
   
2. **Telegram stdout** (`OPENCLAW_TELEGRAM_GROUP` set, no topic)
   - Shows what would be sent to Telegram but outputs to console
   
3. **Stdout only** (no Telegram config)
   - All alerts go to console output

## Output

### Console Output
```
🔍 Starting restart message sweep detection...
📅 Last restart detected at: 2026-05-06T12:53:45.000Z
📊 Found 48 total sessions
📱 Found 39 Telegram sessions
⚠️ Found 2 potentially dropped messages
📢 Alert sent to Telegram
📝 Results logged to /tmp/restart-sweep.log
```

### Alert Format
```
⚠️ Found 2 unprocessed message(s) after restart:

• Topic 12345: Session aborted on last run (last update: 2026-05-06T12:52:30Z)
• Topic 12345: Active before restart, silent after (last update: 2026-05-06T12:51:45Z)
  18 minutes ago
```

### Log File
Results are logged to `/tmp/restart-sweep.log` in JSON format:

```json
{
  "timestamp": "2026-05-06T13:05:22Z",
  "restartTime": "2026-05-06T12:53:45Z", 
  "droppedMessageCount": 2,
  "droppedMessages": [
    {
      "sessionKey": "agent:main:telegram:group:-1001234567890:topic:12345",
      "topic": "12345",
      "lastUpdate": "2026-05-06T12:52:30Z",
      "sessionId": "abc123",
      "abortedLastRun": true,
      "reason": "Session aborted on last run"
    }
  ]
}
```

## Error Handling

- **Missing environment config**: Warns but continues with limited functionality
- **No restart log**: Falls back to 30-minute time window
- **OpenClaw CLI failure**: Throws error and stops
- **Telegram alert failure**: Logs error but continues processing
- **Malformed sessions**: Skips with warning, continues with others

## Performance

- **Runtime**: 2-5 seconds typical
- **Memory usage**: <10MB
- **API calls**: 1 OpenClaw CLI query + optional 1 Telegram alert
- **Safe frequency**: Every 5 minutes

## Limitations

- Requires access to OpenClaw CLI and bootstrap logs
- Only detects Telegram message drops (webhook-based platforms)
- Cannot recover dropped messages, only detect them
- Time-based heuristics may produce false positives during normal quiet periods
- Restart time detection depends on log format consistency

## Testing

```bash
npm test
# or
npx vitest test/restart-sweep.test.ts
```

The test suite covers:
- Session filtering logic
- Drop detection algorithms  
- Environment configuration handling
- Log parsing patterns
- Edge cases and error conditions