# Office Ingest — 后 M0 路线图（全量重规划）

> 配套文档:`docs/proposals/office-ingest.md`（M0 的 PRD/Spec）。本文件在 M0 落地
> **之后**重画里程碑边界——因为 M0 顺手交付了原 M2/M3 的一大块,原 M1→M2→M3→M4
> 的线性顺序已不再成立。规划基于**实际代码状态**(2026-06,分支 `feature/office-ingest-m0`)。

## 1. 为什么要重规划

M0 的目标是"文本层入库",但实现时把后续里程碑的若干件一起做了:

- **表格 LLM 摘要 + 行块**(原 M2 主体)→ 已在 `src/core/office/table.ts`,真实跑通。
- **选择性多模态嵌入**(原 M3 主体)→ 已在 `src/core/office/multimodal.ts`,选择启发式已单测。
- **整条出图管线的"管子"**(sidecar `want_page_images` → DocIR.assets → 多模态嵌入)
  → 端到端接好,只差 converter 配置。

结果:剩余工作不是"造三个大里程碑",而是"**激活已休眠的代码 + 补几处验证/小洞**"。

## 2. 当前真实状态盘点(grounded)

| 组件 | 文件 | 状态 |
|---|---|---|
| 文本层入库(DOCX/PPTX/PDF) | `adapter.ts` + `doc-block.ts` | ✅ 真实跑通 |
| `source_locator` 持久化 | `engine.upsertChunkLocators` (v120) | ✅ 跨引擎,集成测覆盖 page |
| 表格摘要(LLM + 模板降级)+ 行块 | `table.ts` | ✅ 真实跑通(模板降级已验证) |
| 多模态嵌入(选择启发式 + 路由) | `multimodal.ts` | 🟡 gbrain 侧完成;**休眠**(无 assets 喂入) |
| 出图管线(请求 flag → DocIR.assets) | `app.py` / `sidecar-client.ts` / `docir.py` / `render.py` | 🟡 管子全通;**converter 没配出图** |
| 自动拉起 + 监督 + setup CLI + doctor | `sidecar-manage.ts` / `docling-supervisor.ts` / `ingest.ts` | ✅ 完成 |
| **converter 出图/OCR 配置** | `docling_runtime.py` | 🔴 裸 `DocumentConverter()`,无 `PdfPipelineOptions` |
| adapter 传 `wantPageImages` | `adapter.ts` | 🔴 恒默认 false |
| XLSX 多 sheet 归属(`loc.sheet`) | `docir.py:_locator_from_prov` | 🔴 只设 page/slide,从不设 sheet |
| `docir.warnings` 消费(低置信表) | `adapter.ts` | 🔴 warnings 产出了但 gbrain 侧没读 |
| office 内容 → Facts 抽取 | Dream cycle `extract_facts` | ⚪ 理论上自动流入(office 页与普通页同构),未验证 |

## 3. 关键洞察:总开关只是"配置",不是"工程"

原 M1(OCR)和 M3(多模态)都假设是绿地工程。实际:

1. **M3 激活 = 2 处小改**:`docling_runtime.py` 给 converter 配
   `generate_page_images / generate_picture_images`;`adapter.ts` 在
   `cfg.multimodal !== 'off'` 时传 `wantPageImages:true`。然后 assets 自动流 →
   `multimodalChunks` 自动 fire → 图像 chunk 落库。
2. **M1(OCR)塌缩**:Docling 自带 OCR(`PdfPipelineOptions(do_ocr=True)`),
   扫描 PDF 的文本**原生**抽出为普通 block,**不需要**原计划的"渲染页 →
   复用 `importImageFile` OCR 路径"绕路。
3. ∴ M1 与 M3 **同住一个文件**(`docling_runtime.py` 的 pipeline 配置)、强耦合,
   应**合并成一个"管线激活"里程碑**。

## 4. 重画后的里程碑(R1 / R2 / R3)

### R1 — 管线激活(原 M1 + M3 合并)· 杠杆最高

**目标**:打开 converter 的出图 + OCR;让休眠的多模态嵌入路径与扫描 PDF OCR 同时生效。

**具体改动**
- `docling_runtime.py`:用 `PdfPipelineOptions` 配 `generate_page_images=True`、
  `generate_picture_images=True`、`images_scale`、`do_ocr=True`(可配),按 format 建
  `DocumentConverter(format_options=...)`。
- `adapter.ts`:`parseViaSidecar(cfg.url, rel, bytes, { wantPageImages: cfg.multimodal !== 'off' })`。
- 验证:figure-heavy PPTX → `DocIR.assets` 非空 → 图像 chunk(`embedding_image`)落库;
  扫描 PDF → OCR 文本 block 可检索;cross-modal `both` 检索(`search_by_image` /
  双列嵌入)能浮出 office 图。

**DoD**:扫描 PDF 可检索;含图 PPTX 产生 `image_asset` chunk 且 `search_by_image` 命中;
多模态花费走现有 spend 闸门;大 PDF 不 OOM(尊重 size gate + 渲染 scale)。

**风险/约束**
- **多模态嵌入需要视觉 embedder**。用户当前 ollama `nomic-embed-text` **只认文字** →
  `embedMultimodal` 会失败、`multimodalChunks` best-effort 跳过。∴ 多模态臂要真正生效需配
  视觉嵌入 provider(如 Voyage multimodal);**OCR 臂(纯文本)用 ollama 即可验证**。
- 渲染页使大 PDF 内存翻倍 → 渲染 scale + size gate + 逐页。
- 图像嵌入有真实 $ 成本 → 默认 `selective` 已限流,保留 `off` 总开关。

### R2 — 表格硬化(原 M2 残量)· 小

**目标**:把已有的表格能力从"能跑"提到"可信"。

**具体改动**
- XLSX 多 sheet:`docir.py` 给每个 sheet 的 table 设 `loc.sheet`(Docling 暴露 sheet 名时);
  确认 `iterate_items()` 一 sheet 一 table block。
- 公式取值:验证 `export_to_dataframe()` 返回的是**计算值**(预期已是),补一个含公式的 xlsx 测试。
- 复杂/合并/跨页表:质量抽查;确认 `LOW_CONFIDENCE_TABLE` 在烂表上确实触发。

**DoD**:多 sheet xlsx 每 chunk 带正确 `sheet`;公式单元格入库为值;烂表被标低置信。

**实现状态(R2 已落地 + 验证)**:Docling 把每个 sheet 映射为 1-based `page_no`(不暴露 sheet
名),故 `docir.py` 用 openpyxl 把序号 → sheet 名,xlsx 走 `loc.sheet`(page 留空)。`table.ts`
的 `locHint` M0 即支持 sheet,所以 sheet 名同时进 `source_locator` 与可搜摘要文本
(`Table in sheet "Q1Sales": …`)。**真实验证**:双 sheet xlsx → 4 chunk,各带正确 sheet
(Q1Sales / Regions)。**公式**:`export_to_dataframe()` 取 xlsx 的缓存值——真 Excel 文件自带
缓存值则取到值;openpyxl 写的公式无缓存值 → 空(非 bug,记录在案)。**低置信**:
`LOW_CONFIDENCE_TABLE` 在解析失败时触发(已实现),正常表不触发。新增 3 个单测,typecheck
干净、23 个 office 单测过。

### R3 — office → Facts(原 M4)· 小中

**目标**:让 office 内容安全地进入结构化 Facts,且烂表不污染。

**具体改动**
- `adapter.ts` 读 `docir.warnings`:`LOW_CONFIDENCE_TABLE` → 给对应 chunk/page 打标,
  **抑制** Dream cycle 从该表抽 Facts。
- 验证 office 页经 `extract_facts` 正常产 Facts(与普通页同构,预期自动)。

**DoD**:导入含表文档后,Dream cycle 能抽出可查询 Facts;低置信表不产 Facts。

**实现状态(R3 已落地 + 前提修正)**:摸代码发现 gbrain 的 Facts **不是**从页面内容自动抽取的
——两条路都不碰 office 表格:① `## Facts` 围栏(`cycle/extract-facts.ts` 把 `facts` 表从实体
页的人/agent 显式围栏**对账**出来);② 对话 turn 抽取(`facts/extract.ts` Hot Memory,从对话
turn 抽)。∴ "低置信烂表不抽 Facts" 是**伪命题**——office 表格本就不自动产 Facts,无可抑制。
正确做法是写 `## Facts` 围栏时人/agent 自行判断。

可挽救的真实价值:adapter 此前把 `docir.warnings` **直接丢弃**。R3 改为把它**浮出**——进页面
`frontmatter.warnings` + `ImportResult.warnings`,让之后读这页去写围栏的人/agent 看到"这张表
低置信、别轻信"。**验证**:warnings fixture → `res.warnings` + frontmatter 含
`LOW_CONFIDENCE_TABLE`;干净导入无 warnings 字段。+2 单测,typecheck 干净、25 个 office 测试过。

## 5. 依赖图 + 推荐顺序

```
R1 管线激活 ──┬─→ 多模态检索(需视觉 embedder)
              └─→ 扫描 PDF OCR(ollama 即可验证)   ← 杠杆最高,激活最多休眠代码
R2 表格硬化   （独立,可并行；纯增量）
R3 office→Facts（依赖 R2 的低置信信号最完整，但不阻塞）
```

**推荐:R1 先行**——它把 M0 留下的最大一块"已写未通电"代码点亮,且 OCR 臂用现有 ollama
就能端到端验证(多模态臂等配了视觉 embedder 再验)。R2/R3 是增量硬化,随后按需。

## 6. 工作节奏(沿用 M0)

每个 Rx 先出**该里程碑的 Spec**(scope/契约改动/DoD/风险),评审后开干 → typecheck +
单测 + 真实烟雾 → 收口。R1 的 Spec 是下一步建议产出物。
