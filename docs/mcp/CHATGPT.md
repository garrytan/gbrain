# 将 PMBrain 连接到 ChatGPT

PMBrain 推荐通过 OpenAI Secure MCP Tunnel 接入 ChatGPT。Tunnel Client 从本机主动连接 OpenAI，PMBrain 继续只监听 `127.0.0.1`，不需要公网域名、端口映射、Cloudflare 或 ngrok。

调用链：

```text
ChatGPT → OpenAI Secure MCP Tunnel → tunnel-client → 127.0.0.1:3131/mcp
```

## 准备工作

1. 在 [OpenAI Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)创建 Tunnel，并关联当前个人 ChatGPT 对应的 Platform 组织。
2. 创建具备 Tunnels `Read + Use` 权限的 Runtime API Key。
3. 下载适用于当前系统的 `tunnel-client`。
4. 启动 PMBrain HTTP 服务并打开 `http://localhost:3131/admin`。

## 在 Admin Console 配置

进入 **MCP 接入 → ChatGPT Secure MCP Tunnel**：

1. 确认 `tunnel-client` 路径。
2. 填入 `tunnel_...` 格式的 Tunnel ID。
3. 首次配置时填入 Runtime API Key。
4. 点击 **生成安全配置**。
5. 运行 **Doctor**，通过后点击 **启动 Tunnel**。

Admin Console 会自动：

- 创建只允许 `read` 的 PMBrain Token；
- 把 Runtime API Key 和本地 Authorization Header 分别写入用户私有目录；
- 生成独立 `pmbrain-chatgpt.yaml`，其中只保存 `file:` 引用，不写明文密钥；
- 给普通 MCP 请求和 discovery 请求注入同一个本地 Authorization Header；
- 将 tunnel-client 健康页面限制在 `127.0.0.1:8080`。
- Windows 已启用系统代理时，自动把代理地址写入 profile 的 `control_plane.http_proxy`；仅 OpenAI control-plane 走代理，本地 MCP 保持直连。

旧的 `pmbrain.yaml` 和 `pmbrain-noauth.yaml` 不会被覆盖。

## 在 ChatGPT 中连接

1. 打开 ChatGPT **设置 → Apps & Connectors**。
2. 创建自定义 App。
3. 连接方式选择 **Tunnel**。
4. 选择配置好的 Tunnel ID。
5. 身份验证选择 **无身份验证**。

这里的“无身份验证”仅表示 ChatGPT 不再运行第二套浏览器 OAuth。Tunnel 到本地 PMBrain 的请求仍携带只读 Bearer Token，而且 Token 只存在本机，ChatGPT 无法读取。

## 权限边界

- ChatGPT 默认只会发现 `get_brain_identity`、`search`、`query`、`list_pages`、`get_page`、`get_chunks`、`recall` 这些只读工具。
- `write`、`admin` 工具不会出现在 `tools/list` 中。
- 即使直接构造写操作，PMBrain 仍会返回 `insufficient_scope`。
- 历史 API Key 未显式配置 scopes 时继续保持原有权限，现有 CodeBuddy、Cursor、Claude Code 接入不受影响。
- Tunnel Client 仅通过出站 HTTPS 访问 OpenAI；PMBrain 不开放公网监听。

## 日常启停

先启动 PMBrain，再进入 Admin Console 手动启动 Tunnel。停止时点击 **停止**。本功能不会创建 Windows 服务、计划任务或开机启动项。

## 故障排查

**Doctor 提示 Runtime API Key 缺失**

重新生成配置并填写 Runtime API Key。密钥只在首次保存或主动轮换时需要输入。

**Tunnel 在 ChatGPT 中不可见**

确认 Tunnel 已关联个人 ChatGPT 对应的 Platform 组织，并确认 Runtime Key 具有 Tunnels `Read + Use` 权限。

**main channel 显示 Unauthorized**

重新生成安全配置以轮换本地只读 Token，然后再次运行 Doctor。不要继续使用名称为 `pmbrain-noauth` 的旧 profile；它并没有为本地 PMBrain 注入认证 Header。

**Health 正常但 Ready 未就绪**

确认 PMBrain 服务端口与页面显示的本地 MCP URL 一致。开发分支默认使用 `3132`，合并后的主服务使用 `3131`。

## 参考

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI MCP 与 Connectors](https://developers.openai.com/api/docs/mcp)
- [DEPLOY.md](DEPLOY.md) — 公开 HTTPS + OAuth 部署方式；不适用于本页的私有 Tunnel 推荐路径
