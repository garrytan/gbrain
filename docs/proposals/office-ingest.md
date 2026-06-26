# PRD + Spec: Office-Format Ingest for GBrain

| | |
|---|---|
| **Status** | Draft（pre-development，探索固化稿） |
| **Owner** | （待定） |
| **Created** | 2026-06-23 |
| **Version** | 0.1.0 |
| **Scope** | 把 GBrain 的 Sources/Ingest 从"仅文本"扩展到 DOCX / PPTX / PDF / Excel / 图片 |
| **Related** | `docs/architecture/KEY_FILES.md`、`docs/architecture/RETRIEVAL.md`、`src/core/import-file.ts`、`src/core/ai/gateway.ts` |

> **文档约定**:散文用中文（便于评审）；所有标识符、类型、SQL、接口、文件名用英文（直接对应代码）。
> 本文上半部分是 **PRD/RFC**（为什么这么设计、决策与取舍），下半部分是 **冻结的 Spec**（契约、Schema、验收）。

---

## 0. TL;DR

GBrain 当前 Ingest 只一等支持 Markdown/代码/图片。本提案新增一个**格式适配层**：用 **Docling（Python，常驻 FastAPI sidecar，gbrain 监督）** 把办公文档归一化成 **DocIR**（统一块流 + 精确定位），再经一个新的 `importOfficeFile` adapter 汇入**现有管线**（chunk → embed → 抽边 → FTS）。下游（Brain store / Hybrid search / Synthesis / Dream cycle）**零改动**。表格走 **LLM 摘要 + 行块 + 条件 Facts**；视觉块走**选择性多模态嵌入**；全程带 **`source_locator` jsonb** 精确引用（p.X / Slide Y / Sheet!B4:D9）。

---

# PART I — PRD / RFC（设计意图）

## 1. 问题与动机

- **现状**：`importFromFile`（`src/core/import-file.ts:906`）只分发到 `importFromContent`（markdown）、`importCodeFile`、`importImageFile`。**PDF / DOCX / PPTX / XLSX 无原生解析**（依赖里无 PDF/Office 库）。
- **痛点**：用户的知识大量以办公格式存在（合同、提案、报表、幻灯片）。无法 ingest = 这部分知识对 brain 不可见，检索与合成都够不到。
- **机会**：下游（仓库/检索/合成/做梦）**对格式无感**，只认"文字 + 向量 + 边 + locator"。因此只需扩展**最前面一层**，投入可控、收益广。

## 2. Goals / Non-Goals

**Goals**
- G1：DOCX / PPTX / PDF（有文本层）→ 入库可检索（M0）。
- G2：每个 chunk 带**精确 provenance**（页/张/单元格），让 Synthesis 引用可定位。
- G3：复用现有 chunk → embed → 抽边 → FTS，下游不改。
- G4：扫描件 OCR、表格策略、视觉多模态分阶段补齐（M1–M4）。
- G5：本地优先、隐私优先（Docling 本地跑，文件不出机器）。

**Non-Goals**
- N1：不在 M0 解决扫描件 OCR（M1）、复杂表格（M2）、视觉嵌入（M3）。
- N2：不支持云解析服务（如 LlamaParse）——违反隐私优先。
- N3：不改下游检索/合成算法。
- N4：不做办公文档的**写出/编辑**（只读 ingest）。

## 3. Personas / 用例

- **个人知识库用户**：把 Notion/导出的 PDF、会议 PPT、报表 Excel 灌进 brain，事后语义检索 + 合成。
- **团队 brain**：合同/提案/内部文档作为 source，按人 scope 检索。
- **核心用例**：`gbrain import ~/docs`（混合格式）→ `gbrain query "Q3 收入结论"` → 合成答案引用到 **"report.pdf p.12"**。

## 4. 决策记录（已锁定 + 理由）

| # | 决策 | 选择 | 理由 / 取舍 |
|---|---|---|---|
| D1 | 解析位置 | **Python sidecar** | 最强解析器（Docling）是 Python；与用户已运行的 ollama 同形态（常驻本地服务） |
| D2 | 框架 | **Docling** | 版式/表格结构 + page/bbox provenance 最强，契合 G2 |
| D3 | sidecar 形态 | **自写 FastAPI** | 可控、可裁剪输出契约，优于官方 docling-serve |
| D4 | 分块尺寸 | **办公文档单独调** | 办公文档结构与 prose 不同，独立 `ingest.office.chunk_tokens` |
| D5 | 表格 | **LLM 摘要 + 行块 + 条件 Facts** | 摘要管召回、行块管精确、Facts 管结构化查询 |
| D6 | 多模态 | **选择性默认 + 开关 + spend 闸门** | 控成本，纯文字文档不浪费 |
| D7 | provenance | **`source_locator` jsonb** | 一列吃所有格式、免迁移；引用主要用于显示而非过滤 |
| D8 | sidecar 生命周期 | **gbrain 监督** | 拉起/健康检查/重启统一管理，像 minion |
| D9 | 表摘要生成 | **LLM 生成** | 质量高于模板；**带降级链**（无 key/超预算 → 模板） |

> ⚠️ **D9 的连带影响（全局）**：在此之前 **Ingest 仅依赖嵌入模型**；D9 让 Ingest **首次引入 chat-LLM 依赖 + 花费**。必须过 spend 闸门并提供降级，详见 §11、§14。

## 5. 架构总览

```
                            ┌──────────────────────────────┐
 office file ──HTTP POST──▶ │ Docling sidecar (FastAPI,    │
 (pdf/docx/pptx/xlsx/img)   │ 常驻、模型预热、gbrain 监督)  │
                            │ 解析 → DocIR (JSON)          │
                            └───────────────┬──────────────┘
                                            │ DocIR
 gbrain (Bun/TS)                            ▼
 importFromFile (dispatch) ───────▶ importOfficeFile (NEW adapter)
                                            │
        ┌───────────────┬───────────────────┼──────────────────┬───────────────┐
        ▼               ▼                   ▼                  ▼               ▼
 doc-block chunker   table.ts          multimodal.ts      link/NER 抽边    source_locator
 (结构感知,带 locator) 摘要(LLM)+行块+Facts  选择性图嵌入       (复用,零 LLM)     (jsonb)
        └───────────────┴───────────────────┴──────────────────┴───────────────┘
                                            ▼
        现有 Brain store（content_chunks: embedding / embedding_image / search_vector / + source_locator）
                                            ▼
        下游零改动：Hybrid search（含 cross-modal both/RRF）→ Synthesis（引用带 locator）→ Dream cycle
```

**接入原则**：`importOfficeFile` 是 `importCodeFile` / `importImageFile` 的**同级兄弟**，挂在 `importFromFile` 分发器；产出带 `source_locator` 的 `ChunkInput[]` + 可选图片资产，下游一律复用。

---

# PART II — SPEC（冻结契约 / Schema / 验收）

## 6. DocIR Contract v1（sidecar ↔ gbrain 权威合同）

> 版本化：`docir_version: "1.0"`。任何字段语义变更须升版本，sidecar 与 adapter 同步校验。

```jsonc
// POST /parse 的响应体
{
  "docir_version": "1.0",
  "doc": {
    "format": "pdf" | "docx" | "pptx" | "xlsx" | "image",
    "page_count": 12,                     // pdf=页, pptx=张, xlsx=sheet 数, docx=null
    "content_hash": "sha256:…",           // sidecar 对原字节算; gbrain 二次校验
    "parser": "docling@<ver>"
  },
  "blocks": [
    {
      "id": "b1",                          // 文档内稳定 id
      "type": "heading"|"paragraph"|"list"|"table"|"figure"|"code",
      "level": 1,                          // 仅 heading
      "markdown": "## Q3 Results",         // 归一化文字（gbrain 入库的主体）
      "text": "Q3 Results",                // 纯文本（FTS / 抽边用）
      "order": 7,                          // 文档内全局顺序
      "locator": {                         // 精确定位（→ source_locator）
        "page": 3,                         // 1-based; 无则 null
        "slide": null,                     // pptx 张号
        "sheet": null,                     // xlsx sheet 名（多 sheet：每 sheet 独立块组）
        "cell_range": null,                // 仅 xlsx，A1 记法如 "Sheet1!B4:D9"
        "table_id": null,                  // 表/行块所属 table block 的 id
        "row_range": null,                 // [startRow,endRow] 0-based 表内行（PDF/DOCX/PPTX 表的精确定位）
        "bbox": [x0, y0, x1, y1]           // 可选，页内坐标
      },
      "table": {                           // 仅 type=table
        "header_rows": 1,
        "n_rows": 40,
        "n_cols": 5,
        "columns": ["Quarter","Revenue","…"],
        "rows": [["Q1","$1.2M","…"], …]    // 规整二维数组
      },
      "asset_ref": "a1"                    // 仅视觉块；指向 assets[].id
    }
  ],
  "assets": [
    {
      "id": "a1",
      "kind": "image",
      "mime": "image/png",
      "data_b64": "…",                     // 提取或渲染出的图
      "is_rendered_page": false,           // true=整页渲染图（OCR/视觉用）
      "locator": { "page": 5, … }
    }
  ],
  "warnings": ["LOW_CONFIDENCE_TABLE:b9"]  // 低置信度等信号 → 影响 Facts 抽取
}
```

**契约不变式**
- C1：`blocks` 按 `order` 升序、互不重叠。
- C2：`type=table` 必带 `table`；`type=figure` 必带 `asset_ref`。
- C3：`locator.page` 1-based；不可用维度填 `null`，不可省略键。
- C4：`content_hash` 是去重主键来源（gbrain 复用现有 content_hash 路径）。

**Excel / XLSX 规范**
- `doc.page_count` = sheet 数；**每个 sheet 是一个独立块组**，`blocks` 顺序 = sheet 顺序 → sheet 内行顺序。
- 每个 sheet 的 used range → 一个 `type=table` 块（再由 adapter 切成行块）；`locator.sheet` = sheet 名。
- **公式取计算值**（不是公式字符串）；**合并单元格**的值落在其锚点单元格。
- 行块 `locator.cell_range` 用真实 A1 记法（如 `"Q3!B4:D9"`）——这是 XLSX 独有的精确定位，区别于 PDF 表的 `row_range`。

## 7. Sidecar API（FastAPI）

```
POST /parse
  Content-Type: multipart/form-data
  fields: file (bytes, required),
          want_page_images: bool = false,
          format_hint: string = null
  200 → DocIR v1
  413 → file too large（见 §13 大小上限）
  422 → unparseable
  503 → models not loaded yet

GET /health
  200 → { "ok": true, "models_loaded": true, "docir_version": "1.0", "version": "…" }
```

骨架（草稿，非实现）：
```python
from fastapi import FastAPI, UploadFile
from docling.document_converter import DocumentConverter
app = FastAPI()
conv = DocumentConverter()                          # 启动预热（常驻服务的意义）

@app.get("/health")
def health(): return {"ok": True, "models_loaded": True, "docir_version": "1.0"}

@app.post("/parse")
async def parse(file: UploadFile, want_page_images: bool = False):
    doc = conv.convert(file.file).document           # DoclingDocument（带 page+bbox）
    return to_docir(doc, want_page_images)           # → DocIR v1
```

## 8. gbrain Adapter：`importOfficeFile` 流程（规范）

```
importOfficeFile(engine, relativePath, bytes, opts):
  1. content_hash 命中未变 → skip（复用现有去重）
  2. POST sidecar /parse(want_page_images = needsImagesFor(format, opts)) → DocIR
  3. 校验 docir_version == "1.0"，否则 fail 明确报错
  4. doc-block chunker：连续文字块合并到 ingest.office.chunk_tokens，
     生成 ChunkInput{ chunk_text, chunk_source:'doc_block', source_locator(合并页范围) }
  5. 每个 type=table：
       a. 摘要 chunk（LLM；降级链见 §11）→ chunk_source:'table_summary'
       b. 行块 chunk（每 N 行）→ chunk_source:'table_rows', locator{page, cell_range}
       c. 条件 Facts：仅当(检测=实体-属性-随时间) 且 (无 LOW_CONFIDENCE_TABLE) → 抽进 Facts fence
  6. 视觉块（figure / 视觉密集 slide）& ingest.office.multimodal!='off'：
       渲染/取 asset → spend 闸门 → gateway.embedMultimodal → 写 embedding_image
  7. 抽边：对所有文字 chunk 跑 link-extraction + extract-ner（零 LLM，复用）
  8. 经 engine 落库（chunks + source_locator + image embeddings），progress.ts 报心跳
```

## 9. 数据模型 / Schema 变更

```sql
-- src/core/migrate.ts 的 MIGRATIONS 数组新增一条；两引擎同步（engine parity）
ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS source_locator JSONB;
-- src/schema.sql 同步加列（新装路径）
-- 暂不建索引：provenance 用于显示/引用而非过滤。将来若常按页过滤 → 加 page_number INTEGER 专用列 + CREATE INDEX CONCURRENTLY
```

- 新 `chunk_source` 取值（additive，不破坏现有）：`doc_block` / `table_summary` / `table_rows`。
- **Schema 不变式**：
  - 列加入 **bootstrap probe set**（`test/schema-bootstrap-coverage.test.ts`）。
  - `source_locator` 写入**必须** `executeRawJsonb`，禁止 `JSON.stringify` 进 `::jsonb`（`scripts/check-jsonb-pattern.sh` 守护）。
  - DDL 同时落 `pglite-engine.ts` 与 `postgres-engine.ts`（`test/e2e/engine-parity.test.ts` 钉死）。

## 10. 配置键（冻结）

```
ingest.docling.enabled              bool      默认 false（opt-in）
ingest.docling.url                  string    http://127.0.0.1:<port>
ingest.docling.python               string    受管 venv 的 python 路径
ingest.docling.max_concurrency      int       默认 2（gbrain 侧在途 /parse 上限，§21.3）
ingest.office.chunk_tokens          int       默认 512（D4，独立于 markdown 分块）
ingest.office.table_summary.model   string    chat 模型别名（D9）
ingest.office.table_summary.enabled bool      默认 true；false → 总是模板摘要
ingest.office.multimodal            enum      'selective'(默认) | 'all' | 'off'（D6）
ingest.office.max_file_mb           int       默认 50（§13）
```

## 11. LLM 表摘要 + 降级链（D9 规范）

```
对每张 table：
  if ingest.office.table_summary.enabled 且 chat provider 可用 且 spend 未超闸门：
     summary = gateway.chat(model=ingest.office.table_summary.model, prompt=表结构+样本行)
  else:
     summary = 模板摘要("Table on p.{page}: {n_rows}×{n_cols}, columns: {columns}")
  → 永不让导入因表摘要失败
```
- 计价纳入 spend 统计；`gbrain stats` 暴露"本次导入表摘要花费"。
- 低置信度表（`warnings: LOW_CONFIDENCE_TABLE`）**不抽 Facts**，且摘要标注"未校验"。

## 12. Sidecar 监督（D8 规范）

新增 `src/core/docling-supervisor.ts`，仿 `process-watchdog.ts` / minion 监督：
1. **拉起**：在受管 venv 内 `uvicorn app:app --port <p>`。
2. **健康轮询**：周期打 `/health`；连续失败 N 次触发重启。
3. **退避重启**：jittered backoff，避免风暴；崩溃**不拖垮导入**（导入侧捕获 + 明确错误）。
4. **随 gbrain 退出关闭**：防僵尸进程。
5. **首装**：`gbrain ingest setup-docling` → 建 venv + `pip install docling`（一次性下 ML 模型，提示用户体积）。
6. **doctor**：新增 `docling_service` 检查（仿 ollama 健康检查）。

## 13. 性能 / 成本 / 上限

- **大文件**：逐页流式处理 + 有界并发 + `progress.ts` 心跳；`ingest.office.max_file_mb` 闸门（默认 50MB，仿 transcription 的 25MB 模式）。M0 先搭骨架，M1 OCR 时补满逐页渲染。
- **多模态成本**：选择性默认（仅 figure + 视觉密集 slide）；过 spend 闸门；量级参考 embedding-pricing（千图量级 ≈ 数元，一次性）。
- **表摘要成本**：chat 调用，受 spend 控制 + 降级链兜底。

## 14. 必须遵守的 GBrain 不变式

| 不变式 | 落点 |
|---|---|
| 引擎对等（pglite + postgres lockstep） | `source_locator` 列、chunk 插入路径 |
| JSONB（executeRawJsonb，禁 stringify 进 ::jsonb） | 写 `source_locator` |
| Contract-first（operations.ts 生成 CLI+MCP） | M0 多半无需新 op（`import` 已存在）；仅扩 dispatch + config |
| 迁移（MIGRATIONS 数组 + bootstrap probe） | §9 |
| 进度上报（progress.ts，写 stderr） | bulk 导入心跳 |
| content_hash 去重 | adapter 第 1 步 |
| Trust boundary（remote/MCP vs local） | 抽边在本地 CLI 路径正常；远程写入沿用现有 skip 语义 |
| spend controls | 表摘要 chat + 多模态 embed |

## 15. 测试策略（映射不变式）

- `engine-parity`：`source_locator` 两引擎一致。
- `schema-bootstrap-coverage`：新列进 probe set。
- `doc-block` 分块器单测：合并到目标尺寸 + locator 页范围正确。
- adapter 集成（**mock sidecar** 返 DocIR）：chunks/locator/图嵌入正确。
- table 处理：摘要降级链、行块切分、Facts 条件触发与低置信度抑制。
- JSONB 写入：`source_locator` 经 `executeRawJsonb`，无双编码。
- supervisor：拉起/健康失败重启/退出清理。

## 16. 验收标准（Definition of Done · M0）

以 Given/When/Then 断言：

- **AC1**：Given 已 `gbrain ingest setup-docling`，When `gbrain doctor`，Then `docling_service: ok`。
- **AC2**：Given 一个含 DOCX/PPTX/有文本层 PDF 的目录，When `gbrain import <dir>`，Then 三类文件均入库且每 chunk 的 `source_locator` 非空、含正确 `page|slide`。
- **AC3**：Given 已导入，When `gbrain query "<文中关键句>"`，Then 命中目标 chunk 且结果可显示 "p.X / Slide Y"。
- **AC4**：Given 一份含表格的文档，When 导入，Then 存在 `table_summary` + `table_rows` chunk；Given 无 chat key，Then 摘要自动降级为模板且导入成功。
- **AC5**：Given 任意改动，When CI（含 engine-parity / schema-bootstrap / jsonb 守护），Then 全绿；pglite 与 postgres 行为一致。

**实现状态（M0 已落地，分支 `feature/office-ingest-m0`）**：DocIR 契约 v1 + types；
doc-block chunker；`source_locator` 迁移(v120) + 跨引擎 JSONB 写入(`upsertChunkLocators`，
pglite/postgres 对等)；表格 handler（LLM 摘要 + 无 key 时模板降级 + 行块）；
`importOfficeFile` + import-file 分发；office config keys；FastAPI sidecar；
选择性多模态嵌入（选择启发式已单测；待 sidecar 出图时生效）；sidecar 监督
(`src/core/docling-supervisor.ts`，抖动退避重启) + 导入时分离式自动拉起
(`ensureSidecarUp`，复用热进程) + `gbrain ingest setup-docling|start` 命令 +
doctor `docling_service` 健康检查。**验证**：20 个单测通过、typecheck 干净、CLI 命令
端到端可用。**仍待**：真实 Docling 全链 e2e（装好依赖跑一遍）、Postgres engine-parity
e2e、OCR(M1)/条件 Facts(M4)。

## 17. 分期路线

| 阶段 | 范围 | 出口 |
|---|---|---|
| **M0** | sidecar(常驻+监督) + `importOfficeFile` + doc-block chunker + `source_locator` 迁移；DOCX/PPTX/PDF(文本层) | AC1–AC5 |
| M1 | OCR：扫描 PDF → 渲染页图 → 复用 `importImageFile` OCR 路径 | 扫描件可检索 |
| M2 | 表格落地：LLM 摘要 + 行块 + 公式取值/多 sheet（Excel） | 表格可检索 |
| M3 | 多模态：PPT/图表选择性嵌入 + cross-modal `both` 检索验证 | 视觉搜索 |
| M4 | 条件 Facts 抽取（接 Dream cycle `extract_facts`） | 结构化查询 |

## 18. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Python sidecar 部署 + 序列化开销 | 破坏 zero-config；大文件内存翻倍；崩溃楔住导入 | 与 ollama 同形态（用户已接受）；流式；每文件超时+杀；监督重启 |
| 大 PDF/PPT 内存 + 渲染慢 | OOM / 导入像卡死 | 逐页流式 + 有界并发 + 仅按需渲染 + 进度心跳 + 大小闸门 + 可断点 |
| 复杂表格质量（合并/跨页/表为图） | 错表 → 自信错答（尤其错入 Facts） | 结构感知解析(Docling) + 保留表渲染图兜底 + 低置信度标记 + 不自动抽 Facts |
| 引擎对等 + 迁移工作量 | CI 守护严，易卡壳 | 一次迁移批量加完 + 照现有迁移模板 + 早跑 parity/bootstrap 测试 + 只做 additive |
| Ingest 新增 chat 依赖（D9） | 花费 + 可用性耦合 | 降级链 + spend 闸门 + 计费暴露 |

## 19. 安全与隐私

- Docling **本地运行**，文件**不出机器**（区别于 LlamaParse 云方案）—— 符合 GBrain 隐私优先。
- sidecar 仅绑 `127.0.0.1`。
- 抽边/写入沿用现有 trust boundary：本地 CLI 路径 trusted；远程 MCP 写入维持现有 skip 语义。

## 20. 兼容性 / 回滚

- 全部 **additive**：新列、新 chunk_source、新 adapter，**不改现有行为**。
- `ingest.docling.enabled=false`（默认）→ 现有用户**零影响**。
- 回滚 = 关配置；`source_locator` 列对旧 chunk 为 NULL，无害。

## 21. 设计细化（原 Open Questions，已定稿）

### 21.1 doc-block chunker 边界规则（原 Q1 → 定）
- **硬边界**：`table` / `figure` / `code` 块**自成 chunk**，前后 flush——**绝不**与 prose 合并、也不被切散（避免把表头/图与正文混切）。
- **软边界**：`heading` 触发 flush（新 chunk 从标题起），且**标题文本前置注入下一个 chunk** 作为上下文（contextual retrieval，利召回）。
- `paragraph` / `list` 合并到 `ingest.office.chunk_tokens` 即 flush。
- 默认**无重叠**（与现有 markdown chunker 一致，避免行为分叉）。
- chunk 的 `source_locator` = 所含块 locator 的并集（`page`: min→max；单页则该页）。

### 21.2 表格定位：cell_range vs row_range（原 Q2 → 定）
- **XLSX**：用真实 `sheet` + `cell_range`（A1 记法，如 `"Q3!B4:D9"`）。
- **PDF / DOCX / PPTX 表**：无真实单元格坐标 → `cell_range = null`，改用 `table_id` + `row_range`（表内 0-based 行区间）。
- 引用渲染：XLSX → `"book.xlsx Q3!B4:D9"`；PDF 表 → `"report.pdf p.3, table rows 11–20"`。
- 已在 §6 `locator` 增 `table_id` / `row_range` 两字段。

### 21.3 sidecar 并发（原 Q3 → 定）
- sidecar `uvicorn workers=1`：**单模型副本**，省内存、防大文档 OOM。
- 并发控制放 **gbrain 侧信号量** `ingest.docling.max_concurrency`（默认 2）限制在途 `/parse` 数（仿 `db-pacer` 的 concurrency-cap 思路）；批量导入多文件在 gbrain 侧排队，不冲垮 sidecar。
- 大文件给更长超时（§13）。

### 21.4 视觉密集判定启发式（原 Q4 → 定）
- `figure` 块：**总是**多模态嵌入（本身就是图）。
- `slide` / `page`：算视觉密度，满足任一即嵌入整页渲染图：
  - `image_area_ratio ≥ 0.30`（图像占页面积比），**或**
  - `n_figures ≥ 1 且 text_char_count < 280`（稀疏文字 + 有图），**或**
  - `text_char_count < 50`（近无文字 = 多半是图/图表）。
- 阈值为 M0 内置默认（后续可调）；`ingest.office.multimodal`：`'all'` 全嵌 / `'off'` 全不嵌 / `'selective'`(默认) 用此启发式。

## 附录 A — 受影响文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `sidecar/docling-service/{app,docir,render}.py` | NEW | FastAPI + Docling + DocIR 映射 |
| `src/core/ingest/office/{types,adapter,table,multimodal}.ts` | NEW | adapter 主体 |
| `src/core/chunkers/doc-block.ts` | NEW | 结构感知分块器 |
| `src/core/docling-supervisor.ts` | NEW | sidecar 监督（D8） |
| `src/core/import-file.ts` | EDIT | dispatch + `isOfficeFilePath` |
| `src/core/migrate.ts` | EDIT | `source_locator` 迁移 |
| `src/schema.sql` | EDIT | content_chunks 加列 |
| `src/core/pglite-engine.ts` / `postgres-engine.ts` | EDIT | chunk 插入携带 locator |
| `src/core/config.ts` | EDIT | §10 配置键 |
| doctor 命令 | EDIT | `docling_service` 检查 |

## 附录 B — 术语

- **DocIR**：Document Intermediate Representation，sidecar 与 gbrain 间的归一化中间表示。
- **source_locator**：chunk 在原文档中的精确定位（page/slide/sheet/cell/bbox）。
- **sidecar**：与主进程协作的辅助进程（此处 = Docling FastAPI 服务）。
