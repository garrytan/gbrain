# Source Pre-Commit Hooks

Cortex can validate source frontmatter before content reaches a hosted tenant.
This is useful for repos that feed a tenant source.

## Install

```bash
cortex frontmatter install-hook
cortex frontmatter install-hook --source <source-id>
```

The hook validates staged markdown and blocks commits that would break source
ingestion.

## Hosted Runtime Notes

For hosted Cortex, the hook belongs in the source repo, not in the runtime
package. Agents can suggest installing it, but source owners decide whether to
enforce it.

## Uninstall

```bash
cortex frontmatter install-hook --uninstall
```
