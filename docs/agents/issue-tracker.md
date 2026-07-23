# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue: `gh issue create --title "issue title" --body "issue body"`
- Read an issue: `gh issue view <number> --comments`
- List issues: `gh issue list --state open --json number,title,body,labels,comments`
- Comment on an issue: `gh issue comment 123 --body "comment body"`
- Apply or remove labels: `gh issue edit 123 --add-label "label-name"` or `--remove-label "label-name"`
- Close an issue: `gh issue close 123 --comment "closing reason"`

Before editing labels, use the existing mapping in
[`triage-labels.md`](triage-labels.md). Generic workflow role names are not
automatically valid GitHub labels; do not create or apply an unlisted name.
