# R1 — 管线激活 Spec（出图 + OCR）

> 路线图:`docs/proposals/office-ingest-roadmap.md` §4 R1。母 Spec:`office-ingest.md`。
> 一句话:**给 Docling converter 通电**——打开页/图渲染 + 扫描 PDF OCR,让 M0 已写好但
> 休眠的多模态嵌入路径与扫描件文本同时生效。**不改 DocIR 契约**(v1.0 的 assets 已定义)。

## 1. 范围

**做**
- `docling_runtime.py`:把裸 `DocumentConverter()` 换成按 format 配 `PdfPipelineOptions`
  的 converter(出图 + OCR + 表结构)。
- `adapter.ts`:解析时传 `wantPageImages = cfg.multimodal !== 'off'`。
- `config.ts`:新增 `ingest.docling.ocr`(默认 `auto`)、`ingest.docling.images_scale`(默认 1.5)。
- 验证:扫描 PDF → OCR 文本可检索;含图 PPTX → `image_asset` chunk + `search_by_image` 命中。

**不做**(留后续)
- 表格硬化(R2)、Facts(R3)。
- 视觉 embedder 的**接入**本身(属基建/账户配置,非本里程碑代码;R1 只保证"配了就生效")。

## 2. 契约 / 接口改动

- **DocIR**:无改动。`assets[]`、`is_rendered_page`、`asset_ref` 在 v1.0 已定义;R1 只是让它们
  **非空**。`DOCIR_VERSION` 不变(纯产出量变化,非结构变化)。
- **sidecar `/parse`**:`want_page_images` 表单字段已存在;R1 让 gbrain 端真传 `true`。
- **新增 config key**:`ingest.docling.ocr`(`auto|on|off`)、`ingest.docling.images_scale`(float)。

## 3. converter 配置（R1 心脏）

`docling_runtime.py` 按 format 建 converter(PDF 走 OCR+渲染;office 格式走嵌入图提取):

```python
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions

def _build_converter(images_scale: float, do_ocr: bool) -> DocumentConverter:
    pdf = PdfPipelineOptions()
    pdf.generate_page_images = True       # 整页渲染(多模态页 + 扫描兜底)
    pdf.generate_picture_images = True    # 抽图(figure 资产)
    pdf.images_scale = images_scale       # 内存/质量权衡(默认 1.5)
    pdf.do_ocr = do_ocr                   # 扫描 PDF 文本
    pdf.do_table_structure = True
    return DocumentConverter(
        format_options={ InputFormat.PDF: PdfFormatOption(pipeline_options=pdf) },
        # DOCX/PPTX/XLSX:嵌入图由各自 backend 提取,默认即可;按需补 format_options。
    )
```

**注意点**(开干时逐条验证,标 `# DOCLING-API`):
- `generate_picture_images` / `generate_page_images` 是 **PDF pipeline** 选项;PPTX/DOCX 的嵌入
  图走各自 backend——R1 需实测 office 格式下 `picture.get_image(doc)`(`render.py:asset_from_picture`)
  是否拿得到 pil。拿不到则该格式的 figure 资产 R1 暂缺(记 warning,后续补)。
- `do_ocr` 仅对扫描 PDF 有意义;DOCX/PPTX/XLSX 原生有文本,不触发 OCR。
- converter 单例当前**无参**;R1 的 `images_scale`/`do_ocr` 来自 config → 单例 key 需带这俩参数
  (不同配置不同实例),或进程级固定(R1 取后者:启动时按 config 建一次)。

## 4. wantPageImages 流向

```
adapter.ts: parseViaSidecar(url, rel, bytes, { wantPageImages: cfg.multimodal !== 'off' })
  → sidecar-client.ts: form.append('want_page_images', 'true')   (已实现)
  → app.py /parse: want_page_images=True                          (已实现)
  → docir.py: document_to_docir(want_page_images=True)            (已实现)
      → figure 资产循环 + 整页渲染循环填 assets[]                 (已实现)
  → multimodal.ts: multimodalChunks 消费 assets → image chunk     (已实现)
```

∴ gbrain 侧 R1 实改 = **adapter 一行**(传 flag)。其余是 sidecar 的 converter 配置。

## 5. 视觉 embedder 约束（必须显式说明）

`multimodalChunks` 调 `embedMultimodal`,需**多模态嵌入 provider**:
- 用户当前 ollama `nomic-embed-text` = **纯文本** → 图像嵌入失败,best-effort 跳过(import 不挂)。
- 真正生效需配视觉 embedder(如 Voyage `voyage-multimodal-3` → `embedding_image` 列)。
- **∴ R1 分两臂验证**:
  - **OCR 臂(文本)**:扫描 PDF → OCR block → 文本嵌入(ollama 即可)→ **可端到端验**。
  - **多模态臂(图像)**:含图 PPTX → image chunk → 需视觉 embedder → 配了才验;未配时
    断言"assets 已产出且 multimodalChunks 优雅跳过"。

## 6. 验收标准（DoD · Given/When/Then）

- **AC1**:Given converter 已配出图,When 解析含图 PPTX(`wantPageImages=true`),Then
  `DocIR.assets` 非空且含 `is_rendered_page` 与/或 figure 资产。
- **AC2**:Given 扫描版(无文本层)PDF + `do_ocr=on`,When `gbrain import`,Then 抽出 OCR 文本 block
  且 `gbrain query "<图中文字>"` 命中。
- **AC3**:Given 已配视觉 embedder,When 导入含图文档,Then 产生 `image_asset` chunk(带 `embedding_image`)
  且 `search_by_image` 命中其页/图。
- **AC4**:Given **未**配视觉 embedder(ollama),When 导入含图文档,Then 导入成功、文本可检索、
  图像 chunk 优雅跳过(不报错、不挂)。
- **AC5**:Given `ingest.docling.multimodal=off`,When 导入,Then `wantPageImages=false`、不渲染、
  零额外内存/成本(纯文本路径,与 M0 同)。
- **AC6**:typecheck + 现有 office/supervisor 单测全绿;新增多模态选择/OCR 单测通过。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 整页渲染使大 PDF 内存翻倍 | `images_scale` 默认 1.5(非 2+)+ 现有 `max_file_mb` 闸门 + 逐页 |
| OCR 慢(扫描件每页跑模型) | 仅无文本层 PDF 触发(`do_ocr=auto` 探测)+ 进度心跳 + 每文件超时 |
| 图像嵌入真实 $ 成本 | 默认 `selective` 限流 + spend 闸门 + `off` 总开关(AC5) |
| 无视觉 embedder 时静默"看起来没做事" | AC4 显式断言优雅跳过 + 一行 stderr 提示"图像未嵌入:未配多模态 provider" |
| Docling 各 format 的出图 API 差异 | `# DOCLING-API` 标注 + best-effort 返回 None(降级,不挂)+ 实测每 format |

## 8. 测试计划

- **单测**:多模态选择启发式已覆盖;补 converter-config 的纯函数(若有)、`wantPageImages` 解析。
- **真实烟雾**(对标 M0 的 `tmp-import-smoke`):
  - 造一个扫描版 PDF(渲染一张含文字的图为 PDF)→ 验 OCR 文本可检索(ollama)。
  - 造一个含图 PPTX → 验 assets 非空 + (配 embedder 时)image chunk 落库。
- **不碰** `~/.gbrain`:一次性临时 brain。

## 9. 阶段内顺序

R1a **OCR 臂**先(ollama 可全验,价值立得)→ R1b **多模态臂**(配视觉 embedder 后验)。
两者共享 converter 配置一次落地;验证分两批。
