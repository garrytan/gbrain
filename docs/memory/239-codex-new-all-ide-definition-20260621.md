# 239-codex-new: 用户“全 IDE”定义 - updated 2026-06-22

用户纠正：以后“全 IDE”固定指以下 8 个 IDE/agent surface：

1. Kimi Code
2. GLM ZCode
3. MiniMax Code
4. WorkBuddy
5. OpenCode
6. Claude
7. Codex
8. Hermes Agent

后续涉及 SP、OS、Comet、ECC、comet-ecc、skills、hooks、doctor、安装、更新、检查时，默认按这 8 个判断覆盖率。官方工具若没有对应 adapter 或路径映射，必须明确写出 blocker，不得以“官方所有平台 pass”替代“用户全 IDE pass”。

CodeBuddy、OpenSpec、Superpowers、Comet 等不自动计入用户“全 IDE”，除非用户单独指定。
