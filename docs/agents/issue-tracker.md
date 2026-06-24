# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue: `gh issue create --title "..." --body "..."`
- Read an issue: `gh issue view <number> --comments`
- List issues: `gh issue list --state open --json number,title,body,labels,comments`
- Comment on an issue: `gh issue comment <number> --body "..."`
- Apply/remove labels: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`
