---
kind: external_dependency
name: Azure OpenAI — 企业合规部署
slug: azure-openai
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Azure OpenAI
- 角色：企业级 OpenAI 能力，数据驻留 + 私网端点，满足合规要求。
- 认证：`AZURE_OPENAI_API_KEY`（使用 `api-key:` header 而非 `Authorization: Bearer`）、`AZURE_OPENAI_ENDPOINT`（如 `https://my-resource.openai.azure.com`）、`AZURE_OPENAI_DEPLOYMENT`（Azure 门户中的部署名）、可选 `AZURE_OPENAI_API_VERSION`（默认 `2024-10-21`）。
- 模型：`text-embedding-3-large`、`text-embedding-3-small`、`text-embedding-ada-002`（需在 Azure 门户中部署对应模型）。