# deprecations.d

One file per planned removal or rename of something stable promises to keep
(see [What stays the same on stable](../docs/STABILITY.md#what-stays-the-same-on-stable)):
a command, a documented flag, an MCP tool or parameter, a documented config
key, a page-format rule, an exit code or a top-level `--json` field.

## Before you remove or rename something

1. Keep the old name or behaviour working, and make it print a warning that
   names the replacement.
2. Add `deprecations.d/<id>.md`, with an id in the same form as a
   behaviour-change id (lowercase letters, digits and `_`, starting with a
   letter), for example `old_name_flag_1234`:

   ```markdown
   ---
   surface: cli-flag
   name: gbrain <command> --old-name
   replacement: gbrain <command> --new-name
   owner: <who removes it>
   remove_after: 2026-12-07
   ---
   One plain paragraph for users: what changes, what to use instead, and what
   happens if they do nothing.
   ```

   `surface` is one of `cli-command`, `cli-flag`, `mcp-tool`, `mcp-param`,
   `config-key`, `page-format`, `exit-code` or `json-field`.
   `remove_after` is at least 14 days after the stable release that first
   carries the announcement. `bun run check:public-surface` refuses a new
   record whose date is less than 14 days after the day it is added; the
   stable-release part is checked in review.
3. Announce it in the same pull request: add a behaviour-change row with the
   same id (`behavior-changes.d/<id>.md`, see its README) so the upgrade
   notice carries it, and say it in your changelog fragment
   (`changelog.d/<slug>.md`) so the release notes carry it.

## Removing it

The removal is a separate pull request, made after `remove_after` and once
the announcement has been in at least two stable releases. It deletes the old
name and the warning, keeps this file (the history of what was removed and
when) and adds a second behaviour-change row, with an id of its own, saying the
old name is gone. That row's front matter is `kind: breaking` and
`deprecation: <id>`, naming this record. Until `remove_after` has passed, the
check refuses a pull request that drops a command, flag, MCP tool or
parameter, config key or exit code this record names. A page-format rule or
`--json` field is not on the check's list, so its removal is checked in
review.

## Security and data-loss fixes

A fix for a security hole or for something that loses data may change
behaviour at once, with no record here. Its behaviour-change row has
`kind: breaking` and `exception: security` or `exception: data-loss`, and
says what users need to do.
