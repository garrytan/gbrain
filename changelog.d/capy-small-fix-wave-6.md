**`gbrain frontmatter validate` checks every path you give it, and doctor, `gbrain serve --http`, the update check and the agent-session repair each get a small fix.**

### Fixed
- `gbrain frontmatter validate a.md b.md` validated only the last path and could report ok for a bad file named earlier. It now checks every path, walks each directory, checks a file named twice once, refuses before checking anything when a path is missing, and lists the paths as `targets` in `--json` when there is more than one.
- Doctor no longer tells you to run `gbrain sync` for a gbrain-owned content folder on a brain with persistence off, which sync refuses. The check still fails, and it now names the `gbrain import` command that works for that folder.
- `gbrain transcripts archive status` says when `maintenance.auto` is false, because free upkeep then doesn't archive conversations by itself (an installed autopilot still does). The line names `gbrain transcripts archive run`.
- `gbrain serve --http` no longer treats a request refused for a missing or wrong token as activity, so unauthenticated traffic can't keep idle upkeep from running (#9484).
- If your computer's clock moved backwards, the update check no longer goes quiet. A saved answer stamped more than 5 minutes in the future counts as stale and is replaced, so a notice that your version was withdrawn still reaches you (#8795, also reported in #9157).
- `gbrain repair agent-session-facts` reads only the listed sources' facts when it looks up takes, so its cost follows the source instead of the whole brain.

<!-- behavior-change: frontmatter_validate_every_path -->
<!-- behavior-change: serve_http_refused_not_activity_9484 -->
<!-- behavior-change: update_cache_future_stamp_8795 -->
