# Filing modes: where new pages go

Each source picks one way to file its NEW pages. The mode only decides where a
new page is suggested to go. It never moves a page you already have, so you can
switch modes at any time.

| Mode | Where a new page goes | Good for |
|---|---|---|
| `generic` (default) | By page type, in the folder the schema pack gives that type: `people/`, `companies/`, `concepts/` ... | A brain about people, companies and deals |
| `para` | By how actionable it is: `projects/<project>/`, `areas/<area>/`, `resources/<type>/`, `archives/...` | Work tied to goals and deadlines |
| `lyt` | One idea per page, flat in `notes/`; maps of content (pages that link a topic's notes) in `maps/` | Building linked ideas over time |
| `zettelkasten` | Flat in `zettel/`, each note named by a time id (`202611170905-spaced-repetition`) that never changes | Permanent notes whose links must never break |

```bash
foresights filing                                   # this source's mode, and the four choices
foresights filing set para                          # file new pages by PARA from now on
foresights filing route note "Launch checklist" --project "Q1 launch"
foresights filing route concept "Flywheel effect" --source notes --json
```

**Say to your agent:** *"File my new notes the PARA way."* (your agent runs `foresights filing set para`)
**Say to your agent:** *"Where should a new note about the pricing test go?"* (your agent runs `foresights filing route`)

## What `route` gives back

The slug the new page should get, one sentence on why, and the frontmatter
fields the page should carry under that mode:

| Mode | Frontmatter |
|---|---|
| `para` | `para: project` and `project: <name>`, or `para: area` / `resource` / `archive` |
| `lyt` | `methodology_role: moc` for a map of content, `atomic` for a note |
| `zettelkasten` | `zettel_id: <YYYYMMDDHHmm>` and `methodology_role: zettel` |

If a page already has that slug in the source, `route` adds `-2`, `-3` and so
on. A page with the same slug in another source does not count.

PARA needs to know what the page is for: give `--project <name>` when it serves
a project with a goal and an end, `--area <name>` for an ongoing responsibility,
and `--archived` when it is finished. With none of them it is reference
material in `resources/`. In LYT, the types `moc`, `map`, `map-of-content`,
`hub` and `index` count as maps of content. The zettel id is the current minute
in UTC.

## Where the mode is kept

In the source's own settings (`sources.config.filing_mode`). Each source has its
own; a source with no mode set files the generic way. `--source` picks the
source; without it the command uses the current source, the same way other
commands do (`foresights sources current`).
