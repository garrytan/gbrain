# 239-codex-new gbrain auto capture/recall lock lesson

Recorded: 2026-06-20 China time
Owner/prefix: `239-codex-new-`

## Rule

- Auto recall fallback must not leave a persistent `gbrain serve` process. If the hook starts serve to satisfy IPC recall, clean up that started process tree after the request.
- Auto capture judge must deterministically save durable standing rules, including Chinese `以后/必须/不要再` rules and English `always/never again/standing rule/durable rule` rules.
- Do not use `gbrain dream --break-lock` as a casual pure lock cleanup command on this machine; current behavior can enter the full dream cycle.
- Multiple `gbrain-serve.cmd` MCP clients against PGLite are a lock/IO contention risk. Prefer IPC capture/recall through the active serve and avoid launching additional direct CLI writers while serve owns the PGLite lock.

## Evidence

- Recall hook E2E returned pointer `projects/tiktok-erp-samgu`.
- Capture judge E2E saved durable page `inbox/2026-06-19-008045f3` with title `gbrain 自动捕获规则`.
- External Claude bash was observed killing `.gbrain-lock` then running `bun src/cli.ts dream`, causing PGLite lock and disk I/O pressure.
