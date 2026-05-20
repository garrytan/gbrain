# 上游同步流程（LB-arcanum）

## 規則

- 本 repo 是 `garrytan/gbrain` 的品牌化 fork
- **永不**反向 PR 回上游
- 只做單向同步：`upstream` → `origin`
- `upstream` 已設定 push DISABLED 防呆

## 日常同步指令

```bash
# 1. 抓上游最新
git fetch upstream

# 2. 看上游有什麼新動作
git log --oneline master..upstream/master

# 3a. 全部合進來（簡單但可能有衝突）
git checkout master
git merge upstream/master

# 3b. 只挑特定 commit（推薦）
git cherry-pick <commit-sha>

# 4. 推回自己的 fork
git push origin master
```

## Remote 結構

```
origin   https://github.com/RYN6666999/LB-arcanum.git  (fetch)
origin   https://github.com/RYN6666999/LB-arcanum.git  (push)
upstream https://github.com/garrytan/gbrain.git         (fetch)
upstream DISABLED                                        (push)
```

設定指令（首次 clone 後執行）：

```bash
git remote add upstream https://github.com/garrytan/gbrain.git
git remote set-url --push upstream DISABLED
```

## 如果 GitHub 跳出「Compare & pull request」按鈕

**永遠不要按**。那是要把你的改動推回上游，不是你要的方向。

如要在 fork 內部開 PR，手動把 base repository 切回 `RYN6666999/LB-arcanum`。
