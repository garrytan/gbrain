# Post-install hint

When `gbrain integrations install travel-booking --target <repo>` completes,
print this to stdout (or to the install agent's conversation surface) so the
operator knows what to do next.

---

✓ Travel-booking skill installed to `<target-repo>/skills/travel-booking/`.

**Four follow-up steps:**

### 1. Confirm the travel tools are reachable

The skill calls the Jinko travel tools (`flight_search`, `hotel_search`,
`trip`, `checkout`, …). They come from Step 2 of `recipes/travel-booking.md`,
not from gbrain. Check the path you set up there:

- **MCP:** list the agent's tools and check that `flight_search` is there.
- **CLI** (OpenClaw and other harnesses without a remote-MCP client):
  `jinko --version` is 3.3.0 or later (an older CLI cancels a hotel at once
  instead of previewing the refund), `jinko auth status` reports a key taken
  from `JINKO_API_KEY`, and
  `jinko flight-search --help` prints the flags. The CLI adds no tools to the
  agent's tool list.

### 2. Review the appended resolver row

This install appended one row to your `<target>/RESOLVER.md` (or `AGENTS.md`):

```
travel-booking | the user wants to find, price, book, change, refund or cancel a flight, hotel or rental car; ...
```

### 3. Reload and check the skill is picked up

If the harness loads `AGENTS.md`, `RESOLVER.md` or skills only at startup,
restart it. Then, in a new conversation, ask "What do flights from <home
airport> to Lisbon cost next month?": the agent should read the brain for the
home airport and call `flight_calendar` or `find_dates`. Step 4 of
`recipes/travel-booking.md` has the full check.

### 4. Update later

When gbrain ships a new version of the skill, refresh your local copy:

```bash
gbrain integrations install travel-booking --target <target-repo> --refresh
```

Local edits are preserved by default; pass `--auto take-theirs` to take
upstream everywhere, or `--dry-run` to preview.
