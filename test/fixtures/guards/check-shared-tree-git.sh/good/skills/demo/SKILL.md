# Demo skill

Commit with `scripts/brain-commit-push.sh "<msg>" people/alice-example.md`.

```bash
gbrain git commit-push -m "people: add alice-example" -- people/alice-example.md
git add -A -- people/alice-example.md
git push --dry-run origin HEAD:main
git stash store -m "rescued" "$(cat .git/rebase-merge/autostash)"
git push --force origin main  # gbrain-allow-shared-tree-git: confirmed purge of a private clone
```

<!-- gbrain-allow-shared-tree-git: names what never to run -->
Never run `git pull --rebase` in a shared checkout.

<!-- gbrain-allow-shared-tree-git-begin: the forbidden list -->
- `git stash`
- `git reset --hard`
<!-- gbrain-allow-shared-tree-git-end -->

A git push in plain prose, outside a code span, is not an instruction.
