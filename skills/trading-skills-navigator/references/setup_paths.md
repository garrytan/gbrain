# Setup Paths

After the recommender returns a result, walk the user through installing the
**`setup_bundle`** — the recommender already computed the exact install set for
you. Pick the path for the user's environment.

## Which skills to install — read `setup_bundle`

The recommender JSON has a top-level **`setup_bundle`** object — the
deterministic install union over the primary skillset **and every secondary
workflow** (so a multi-workflow recommendation never drops a secondary
workflow's skills). Use it directly; do not re-derive from `primary_workflow`.

- `setup_bundle.required` — must install all of these.
- `setup_bundle.recommended` — install for the full value of the recommended
  skillset.
- `setup_bundle.optional` — nice-to-have; install if the user wants the
  optional steps.
- `setup_bundle.sources` — explains where each part came from (e.g.
  `skillset:market-regime`, `workflow:swing-opportunity-daily`); use it to tell
  the user *why* each skill is in the list.
- A skill never appears in two tiers (required wins over recommended over
  optional), so install top-down without de-duping.

`skillset.manifest` (when `manifest_status: active`) is the **description of
the recommended skillset** — its `display_name` and curated
required/recommended/optional + `related_workflows` (how the bundle is run).
Narrate it as "what this sleeve is"; it is *not* the install list — that is
`setup_bundle` (which also covers the secondary workflows).

On an **honest gap** (`primary_workflow: null`, `skillset.manifest: null`,
`setup_bundle` all empty), there is no workflow/skillset to set up; install the
individual `suggested_skills` instead.

Always tell the user which of those skills need a **paid API key** (check each
skill's row in the repo's API Requirements matrix / `CLAUDE.md`). If the
recommendation was made with `--no-api`, none of the required skills need paid
keys by construction.

## Path A — Claude Web App (`.skill` upload)

The Web App cannot clone the repo. Each skill is uploaded as a `.skill`
package.

1. Get the packaged skills from `skill-packages/` in this repository
   (e.g. `skill-packages/<skill-name>.skill`). For the Navigator itself:
   `skill-packages/trading-skills-navigator.skill`.
2. In the Claude Web App, open **Settings → Capabilities → Skills** (or the
   skill upload entry point) and upload each required `.skill` file.
3. Upload `trading-skills-navigator.skill` too if the user wants the router
   itself in the Web App — it ships with `assets/metadata_snapshot.json`, so
   recommendations work without the repo present.
4. For skills that need API keys, set them as instructed in that skill's
   `SKILL.md` (environment variable or in-conversation argument).
5. Invoke by describing the goal in natural language; the skill triggers from
   its `description`.

> The Navigator's recommender uses the bundled snapshot in this environment,
> so its output is identical to Claude Code.

## Path B — Claude Code (folder copy / clone)

1. Clone or pull this repository.
2. The skills live under `skills/<skill-name>/`. In Claude Code they are
   discovered from the repo automatically; to use one globally, symlink it:

   ```bash
   ln -sfn "$(pwd)/skills/<skill-name>" ~/.claude/skills/<skill-name>
   ```

3. Set any required API keys as environment variables (see `CLAUDE.md` →
   *API Key Management*), e.g.:

   ```bash
   export FMP_API_KEY=...        # FMP-backed skills
   export FINVIZ_API_KEY=...     # FINVIZ Elite (optional accelerator)
   export ALPACA_API_KEY=...     # portfolio-manager (Alpaca)
   export ALPACA_SECRET_KEY=...
   ```

4. Run the recommended workflow's skills in the order the workflow manifest
   (`workflows/<id>.yaml`) lists them. The Navigator's recommender reads the
   repo-root SSoT directly here (no snapshot needed).

## No-API starting path (recommended for new users)

If the user has no paid keys, the safe starting path is **`market-regime-daily`**
(`api_profile: no-api-basic`): `market-breadth-analyzer` → `uptrend-analyzer`
→ `exposure-coach`. Add the journaling loop (`trade-memory-loop`,
`monthly-performance-review`, both no-API) to close the
Plan → Trade → Record → Review → Improve loop. Upgrade to FMP/Alpaca-backed
workflows (`swing-opportunity-daily`, `core-portfolio-weekly`) only when the
user is ready to add paid data.
