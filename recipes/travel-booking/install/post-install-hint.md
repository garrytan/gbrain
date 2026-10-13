# Post-install hint

When `gbrain integrations install travel-booking --target <repo>` completes,
print this to stdout (or to the install agent's conversation surface) so the
operator knows what to do next.

---

✓ Travel-booking skill installed to `<target-repo>/skills/travel-booking/`.

**Three follow-up steps:**

### 1. Confirm the Jinko MCP server is connected

The skill calls the Jinko travel tools (`flight_search`, `hotel_search`,
`trip`, `checkout`, …). They come from the MCP server added in Step 2 of
`recipes/travel-booking.md`, not from gbrain. List the agent's tools and
check that `flight_search` is there.

### 2. Review the appended resolver row

This install appended one row to your `<target>/RESOLVER.md` (or `AGENTS.md`):

```
travel-booking | the user wants to find, price, book, change, refund or cancel a flight, hotel or rental car; ...
```

### 3. Update later

When gbrain ships a new version of the skill, refresh your local copy:

```bash
gbrain integrations install travel-booking --target <target-repo> --refresh
```

Local edits are preserved by default; pass `--auto take-theirs` to take
upstream everywhere, or `--dry-run` to preview.
