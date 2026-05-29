# Cortex Admin Design

The Cortex admin console is the operating surface for a hosted company-brain
tenant. It manages org setup, team invites, brains, sources, agent clients,
skills, integrations, billing state, runtime manifests, and quality checks.

## Direction

- Dense developer-infrastructure console.
- Dark, restrained, shadcn-based UI.
- Useful first screen, not a product tour.
- Data and actions over decoration.
- Every page should help an operator or agent complete a real setup task.

## Navigation

Keep the sidebar focused on operational areas:

- Overview
- Team
- Brains
- Sources
- Agents
- Skills
- Integrations
- Invites
- Activity
- Runtime
- Quality
- Settings

Use clear labels. Avoid icon-only navigation for primary sections.

## Components

Use existing shadcn components before custom markup:

- Cards for compact summary panels and repeated records.
- Tables for members, clients, invites, sources, and jobs.
- Badges for status, role, scope, plan, and enforcement.
- Dialogs for creation and editing.
- Alert dialogs for destructive actions.
- Tabs for closely related subviews.
- Tooltips for icon buttons.

Do not nest cards inside cards. Keep section layouts unframed unless the content
is a repeated item, modal, or genuinely framed tool.

## Typography

- Interface text: Geist or system sans.
- Commands, ids, URLs, timestamps, secrets, and JSON: monospace.
- Compact panel headings should stay compact.
- Hero-scale type belongs on the marketing page, not the console.
- Letter spacing should be neutral except for tiny table labels when needed.

## Color

Color should communicate state:

- Green: ready, sent, healthy.
- Amber: queued, warning, pending setup.
- Red: failed, revoked, destructive.
- Blue or neutral accent: links, active navigation, selected controls.

Avoid decorative gradients and multicolor dashboards. The console should not read
as a single-hue theme.

## Page Requirements

Every page should answer:

1. What tenant state am I looking at?
2. What can I do from here?
3. What would an agent call to do the same thing?
4. What is unhealthy, missing, queued, or blocked?

The Runtime page must expose the public manifest and client setup commands.
The Integrations page must make ingestion provider status and webhook setup clear.
The Skills page must show policy status and enforcement scope.
The Team and Invites pages must show onboarding links without leaking secrets.

## Verification

For meaningful admin changes:

```bash
bun run build:admin
bun run check:cortex-public-copy
bun run tsc --noEmit --pretty false
```

Then run a rendered flow through signup, onboarding, admin login, team invite,
agent client creation, integrations, runtime, and quality gates.
