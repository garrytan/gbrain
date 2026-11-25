# Shadow capture: record your brain's real engine calls on your own machine

Shadow capture records every call your brain makes to its storage engine, reads and writes, into private files on
the brain's own machine. It is the first half of shadow replay: a later release replays each night's recording on
private PGLite and Rust copies to find where the Rust engine answers differently. This release only records.
Nothing leaves the machine, and nothing is replayed yet.

**Say to your agent:** *"Turn on shadow capture for my brain."*

**Say to your agent:** *"Is shadow capture on, and how much has it recorded?"*

**Say to your agent:** *"Stop shadow capture and delete what it recorded."*

## What you see

```bash
gbrain engine shadow capture on --yes        # turns capture on and starts a recording
gbrain engine shadow capture status          # on/off, the current recording, recording processes, bytes recorded
gbrain engine shadow capture off             # every recording process stops at its next write; deletes nothing
gbrain engine shadow capture delete --yes    # deletes every recording and lists what it deleted
```

Capture is off by default. A brain that never turned it on loads none of the capture code. After `capture on`,
restart long-running gbrain processes (`gbrain serve`, an MCP server): only engines opened after capture is on
record. `GBRAIN_SHADOW_CAPTURE=off` turns capture off for any process started with it, whatever the setting says.

Answers never change and never wait on capture. A capture fault (a full disk, an unwritable folder) drops records,
counts what it dropped as a gap, and never reaches the brain process.

## What it keeps, and where

Everything lives under `<gbrain home>/shadow/<brain>/capture/`, in owner-only files (mode 0600, folders 0700):

| Path | What it holds |
|---|---|
| `epoch-<id>/<process>.jsonl` | each engine call: the member, its arguments, start and end time, and a SHA-256 of the result (never the result) |
| `recorders/<process>.json` | one file per recording process (its process id) |
| `epoch.json`, `state.json` | the current recording and the on/off setting |

A call's arguments over 1 MiB are recorded only as a gap. A recording stops growing at 4 GiB, or when less than
2 GiB or 5% of the disk is free; what it then drops is counted as a gap. Raw SQL, reserved connections and calls that
take a function are recorded as a gap with the member name only. With no replay yet, a recording only grows (within
those limits) until you delete it or a purge removes it.

## Purge

When you purge a page or fact, gbrain writes a line to its purge log before the purge commits. Any new purge-log
line, or a purge log that cannot be read, deletes every recording at once in the process that purged, whatever state
the recording is in, whether capture is on, off or turned off with `GBRAIN_SHADOW_CAPTURE=off` (as long as the
brain has a capture folder). Other processes check before every write. A record still in memory from before the
purge is dropped, never written into the next recording. Every purge path runs one cleanup function, and a test
checks the source so that a new path cannot skip it. No physical secure-erase is claimed.

## Delete and the replay lock

`capture delete` and `gbrain engine shadow stop --delete` share one delete path. It takes the replay lock first and
refuses with `shadow_replay_busy` while a replay holds it. A lock a crashed run left behind is never taken over
automatically; the error names the file to remove.

## Sealing a recording (for the replay release)

The replay seals a recording before it reads it. Every recording process registers itself at its first call, before
that call's record exists. Sealing marks the recording `sealing` at time T: calls that started before T belong to
it, later calls to the next recording. Each live recording process writes out its calls from before T (it waits for
any still running) and acknowledges. The seal waits for every live process. A process that does not acknowledge in
time is reported, so the replay will say its coverage is incomplete instead of claiming it complete.

## Errors

| Code | Meaning | Fix |
|---|---|---|
| `shadow_capture_off` | the capture command was not understood | use `on --yes`, `off`, `status` or `delete --yes` |
| `shadow_replay_purged` | the purge log cannot be read, so no recording starts | make it a readable file owned by the brain's user |
| `shadow_replay_busy` | a replay holds the lock, or a crashed one left it | wait; for a stale lock remove the file the message names |
