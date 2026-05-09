# Calendar-to-Brain (local minimal collector)

Collecteur local, déterministe et safe pour importer une petite fenêtre Google Calendar via ClawVisor vers `~/brain`.

## Ce qu’il fait

- lit **uniquement** `google.calendar` / `list_events`
- utilise un `task_id` ClawVisor existant **ou** crée une tâche courte avec `--create-task`
- défauts safe : **dry-run**, fenêtre **aujourd’hui + demain**, `--max-results 3`
- n’affiche pas le contenu perso brut sur stdout : seulement counts / jours / event ids
- si `--write`, écrit du markdown dans `~/brain/sources/google-calendar/YYYY/YYYY-MM-DD.md`
- garde un state local hors repo : `~/.gbrain/integrations/calendar-to-brain/state.json` (mode `600`)

## Emplacement brain choisi

Faute d’emplacement canonique pré-existant, la sortie va dans :

- `~/brain/sources/google-calendar/YYYY/YYYY-MM-DD.md`

Pourquoi : selon `~/brain/RESOLVER.md`, il s’agit d’un **import source** brut et daté ; le dossier `sources/` est donc le plus minimal et le moins ambigu.

## Pré-requis

- `CLAWVISOR_URL` et `CLAWVISOR_AGENT_TOKEN` disponibles **via ClawVisor seulement**
- lancer les commandes avec :

```bash
op run --env-file "$HOME/.gbrain/gbrain-op.env" -- node integrations/calendar-to-brain/collector.mjs ...
```

Ne jamais afficher les secrets en clair.

## Workflow ClawVisor

### Option A — réutiliser une tâche existante

Le script lit par défaut `~/.gbrain/integrations/clawvisor/smoke-state.json` pour récupérer :

- `task_id`
- `google.calendar:<account>`

Si la tâche est encore `pending_approval`, le script s’arrête proprement et explique qu’une approbation est nécessaire.

### Option B — créer une tâche courte

```bash
op run --env-file "$HOME/.gbrain/gbrain-op.env" -- \
  node integrations/calendar-to-brain/collector.mjs --create-task --dry-run
```

La tâche créée :

- n’autorise que `list_events`
- a une durée courte (`expires_in_seconds: 1800`)
- pré-enregistre un planned call sur la plage demandée

Si ClawVisor renvoie `pending_approval`, approuver puis relancer avec `--task-id <id>`.

## Commandes utiles

### Smoke local sans ClawVisor

```bash
node integrations/calendar-to-brain/collector.mjs --mock --dry-run
```

### Dry-run réel, fenêtre courte par défaut

```bash
op run --env-file "$HOME/.gbrain/gbrain-op.env" -- \
  node integrations/calendar-to-brain/collector.mjs --task-id <task-id> --dry-run
```

### Write réel sur une petite plage

```bash
op run --env-file "$HOME/.gbrain/gbrain-op.env" -- \
  node integrations/calendar-to-brain/collector.mjs \
  --task-id <task-id> \
  --write \
  --from 2026-05-09 \
  --to 2026-05-10 \
  --max-results 3
```

### Si la tâche ClawVisor est standing

Ajouter un `session_id` :

```bash
op run --env-file "$HOME/.gbrain/gbrain-op.env" -- \
  node integrations/calendar-to-brain/collector.mjs \
  --task-id <task-id> \
  --session-id 550e8400-e29b-41d4-a716-446655440000 \
  --dry-run
```

## Sortie stdout

Le script résume seulement :

- mode (`dry-run` / `write`)
- task id / status
- nombre de jours
- nombre d’événements
- ids des événements par jour
- chemins écrits si `--write`

Pas de titres, descriptions, emails ni corps détaillés sur stdout.

## Fichiers écrits

Exemple :

- `~/brain/sources/google-calendar/2026/2026-05-10.md`
- `~/brain/sources/google-calendar/2026/2026-05-11.md`

Chaque page contient :

- frontmatter minimal
- source explicite : `ClawVisor Google Calendar`
- horaires, titre, lieu, attendees **sans emails**
- event id
- horodatage de collecte

## Test minimal

Fixture locale :

- `integrations/calendar-to-brain/fixtures/mock-response.json`

Test Bun :

```bash
bun test test/calendar-to-brain.test.js
```

## Notes

- pas de backfill massif
- pas de cron
- pas de Gmail
- pas de secrets dans les logs
