---
title: "Revert Github Repository To Commit"
type: note
created: 2023-02-13
updated: 2023-02-13
source: chatgpt-export
conversation_id: 52353aa1-7435-42a7-aa68-d90f9e5f54c7
message_count: 2
tags: [chatgpt, import, code]
---
# Revert Github Repository To Commit

> Conversation ID: 52353aa1-7435-42a7-aa68-d90f9e5f54c7
> Created: 2023-02-13T02:20:35Z
> Updated: 2023-02-13T02:20:35Z
> Messages: 2

---

## User

my github repo needs to be reverted back 2 commits. the commit name i want to reset to is 4b145f0229f37a179c46c5f7c1d8ad50893725b9 and the branch is develop

---

## Assistant

To revert your Github repository back to a specific commit, you can use the `git revert` command. Here's how to do it:

1. Clone the repository to your local machine:
```
git clone https://github.com/<username>/<repository>.git
```

2. Checkout to the branch you want to revert (in this case "develop"):
```
git checkout develop
```

3. Reset the branch to the specified commit using the following command:
```
git reset --hard 4b145f0229f37a179c46c5f7c1d8ad50893725b9
```

4. Push the changes to the remote repository:
```
git push -f origin develop
```

Note: The `-f` flag is necessary because you are "forcing" the push, effectively overwriting the history of the branch on the remote repository. Be cautious when using this flag, as it can permanently destroy data.

After following these steps, your Github repository should be back to the state it was in at the specified commit.


## See Also
- [[chatgpt/chatgpt_allow-claude-biom-github]]
- [[chatgpt/chatgpt_building-a-github-action]]
- [[chatgpt/chatgpt_fastlane-match-github-token]]
- [[chatgpt/chatgpt_force-commit-after-job]]
- [[chatgpt/chatgpt_git-commit-and-push-2]]
