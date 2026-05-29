# Cortex Design System

Cortex is a company-brain SaaS for operators and agents. The interface should
feel precise, calm, and capable: a control plane for configuring knowledge,
access, ingestion, and runtime connectivity across a tenant.

## Product Surfaces

- **Marketing page**: the first-viewport product promise and signup path.
- **Signup and onboarding**: org creation, default company brain, owner client,
  onboarding URL, and connect command.
- **Admin console**: tenant operations for teams, brains, sources, agents,
  skills, integrations, billing, runtime, and quality gates.
- **Agent runtime pages**: setup payloads, manifests, OAuth/MCP metadata, and
  verification commands.

## Voice

Cortex copy is direct and operator-grade.

- Say what happened and what the user can do next.
- Use Cortex-branded commands and labels.
- Prefer concrete nouns: org, brain, source, invite, client, scope, manifest.
- Keep status copy short.
- Do not explain obvious UI mechanics inside the app.
- Do not frame the product as a solo recall tool.

Good:

```text
Invite queued
Owner onboarding link created
Runtime manifest ready
Skill policy enforced
```

Avoid:

```text
Here is how this button helps you use the app
Your private recall store is ready
```

## Visual Direction

Cortex uses a dark, dense, shadcn-based product UI. It should feel closer to a
developer infrastructure console than a marketing dashboard.

- Dark background with restrained contrast.
- Semantic status color only.
- Geist or system sans for UI text.
- Monospace for ids, secrets, commands, JSON, and timestamps.
- Cards only for repeated items, compact panels, modals, and framed tools.
- No decorative blobs, oversized hero cards, or gradient-only sections.
- Keep radius modest and consistent.

## Layout

- Admin pages use a persistent sidebar and content shell.
- Main content should be scannable at a glance.
- Tables are preferred for dense records.
- Forms should group related fields with clear submit actions.
- Onboarding and auth pages can use focused panels, but should still expose the
  product outcome: org, brain, client, invite, or runtime setup.
- Mobile layouts should preserve task completion over decorative stacking.

## Components

Prefer shadcn primitives before custom controls:

- `Button` for commands.
- `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, and `Slider` for forms.
- `Tabs` for adjacent views.
- `Table` for records.
- `Dialog` for focused creation/editing.
- `AlertDialog` for destructive confirmation.
- `Badge` for status, role, plan, scope, and health.
- `Tooltip` for unfamiliar icon buttons.
- `Sheet` for mobile navigation or side editing.

Use lucide icons for compact actions when an icon is clearer than text.

## Status Language

Use consistent states across the console:

- `ready`: usable now.
- `queued`: waiting for a worker.
- `sending`: provider job in progress.
- `sent`: provider accepted delivery.
- `failed`: action needs attention.
- `revoked`: credential or invite can no longer be used.
- `draft`: policy exists but should not be enforced.
- `enforced`: policy is active.

## Runtime And Agent Setup

Runtime pages should show:

- hosted MCP URL
- token URL
- runtime manifest URL
- CLI install command
- client-specific config snippets
- verification command
- last smoke status when available

Never place one-time secrets in public manifests, screenshots, or docs. Show
secrets once in the creation result, next to the connect command.

## Quality Bar

Before declaring a UI change ready:

1. Build the admin export.
2. Open the changed page in a browser.
3. Check console errors.
4. Test the happy path and one failure path.
5. Confirm copy is Cortex-branded.
6. Confirm text fits on mobile and desktop.
7. Confirm the matching agent/API path exists.

The console earns trust by making the tenant state obvious and actionable.
