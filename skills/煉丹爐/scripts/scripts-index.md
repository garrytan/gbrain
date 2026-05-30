# 腳本 — 煉丹爐

> 把煉丹爐流程中的機械步驟自動化。

## 腳本清單

| 腳本 | 說明 | 狀態 |
|------|------|------|
| `scaffold.sh` | 建立新 skill 的目錄結構（SKILL.md + 三資料夾 README） | [PRIMARY] |
| `verify.sh` | 本地守門：guard:assets/refs/scripts + 五節 + manifest + RESOLVER | utility |

## 用法

```bash
# 一行建好新 skill 的骨架
bash skills/煉丹爐/scripts/scaffold.sh <skill-name>

# 驗證一個 skill 是否通過所有守門
bash skills/煉丹爐/scripts/verify.sh <skill-name>
```

## 依賴

- **工具：** `bun`、standard POSIX shell
- **Env var：** 無
- **執行位置：** repo root（`/Users/ryan/gbrain`）
