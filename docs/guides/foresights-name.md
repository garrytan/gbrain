# The Foresights name

This brain is called Foresights. The command is `foresights`:

```bash
foresights doctor
foresights query "what did we decide about pricing?"
```

**Say to your agent:** *"Check my Foresights brain is healthy."* (your agent runs `foresights doctor`)

## Nothing you set up before changes

The old `gbrain` command still works and runs the same program, so scripts,
cron jobs, hooks and services installed earlier keep running. You never have to
edit them.

Names that are saved outside the program keep their old spelling, because
renaming them would cut you off from what is already there:

| Kept as is | Why |
|---|---|
| The `~/.gbrain` folder | Your brain's database, locks and backups record this path |
| `GBRAIN_*` settings (`GBRAIN_HOME`, `GBRAIN_DATABASE_URL`, ...) | They live in your shell profile, `.env` files, services and agent hooks |
| Markers inside your notes and agent files (`gbrain:facts:begin`, ...) | Your existing pages and agent instructions contain them |
| Schema pack names (`gbrain-base`, ...), plugin and skill names | Your brain and your agent apps store them |
| The `gbrain` MCP server entry in your agent's settings | Your agent's config file names it |

## Settings with the new name

Every `GBRAIN_*` setting also answers to `FORESIGHTS_*`. `FORESIGHTS_HOME=/data`
works the same as `GBRAIN_HOME=/data`. If both are set, the `GBRAIN_*` one wins,
so an existing setup never changes behaviour.

## Installing and upgrading

Install from this project's repository:

```bash
bun add -g github:aimonk2025/gbrain
```

That gives you both the `foresights` and `gbrain` commands. `foresights upgrade`
pulls new versions from the same repository.
