---
kind: external_dependency
name: Bun — JavaScript 运行时
slug: bun
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Bun
- 构建：`bun build --compile --outfile bin/gbrain src/cli.ts` 编译为二进制。
- 测试：`bun run test` 并行单元测试，`bun run verify` 预推送门禁，`bun run ci:local` 完整 Docker-backed CI 栈。