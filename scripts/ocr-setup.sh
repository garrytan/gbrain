#!/usr/bin/env bash
# ocr-setup.sh — 首次環境驗證 + 模型預下載
# 用法：bash scripts/ocr-setup.sh
set -euo pipefail

echo "=== PaddleOCR 環境設定 ==="

# 1. 確認 uv
if ! command -v uv &>/dev/null; then
  echo "error: uv 未安裝。請執行 curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

echo "✓ uv $(uv --version)"

# 2. 確認 poppler（pdf2image 需要）
if ! command -v pdftoppm &>/dev/null; then
  echo "Installing poppler via Homebrew…"
  brew install poppler
else
  echo "✓ poppler (pdftoppm 已安裝)"
fi

# 3. 預熱環境（uv 會在 .venv 下建立隔離環境，自動安裝所有套件）
echo ""
echo "=== 預熱 Python 環境（首次需下載 ~500MB 模型）==="
echo "語言：繁體中文（chinese_cht）"
echo ""

uv run --python 3.11 scripts/ocr-batch.py --help

echo ""
echo "=== 模型預下載 ==="
# 觸發一次 OCR 初始化讓模型快取下來（用空白圖片）
python3 -c "
from PIL import Image
import tempfile, pathlib
tmp = pathlib.Path(tempfile.mktemp(suffix='.png'))
Image.new('RGB', (100, 30), color='white').save(tmp)
print(f'Warm-up image: {tmp}')
" 2>/dev/null | tee /tmp/ocr_warmup_path.txt || true

WARMUP_IMG=$(cat /tmp/ocr_warmup_path.txt 2>/dev/null | grep -o '/tmp/.*\.png' | head -1)
if [ -n "$WARMUP_IMG" ]; then
  echo "Running OCR warm-up (downloads models if needed)…"
  uv run --python 3.11 scripts/ocr-batch.py "$WARMUP_IMG" \
    --lang cht --skip-llm --dry-run 2>&1 | tail -5
  rm -f "$WARMUP_IMG"
fi

echo ""
echo "=== 完成 ==="
echo ""
echo "使用範例："
echo "  uv run --python 3.11 scripts/ocr-batch.py scan.jpg"
echo "  uv run --python 3.11 scripts/ocr-batch.py scans/ --out-dir wiki/scans --gbrain-sync"
echo "  uv run --python 3.11 scripts/ocr-batch.py doc.pdf --lang cht --skip-llm"
echo ""
echo "環境變數："
echo "  ANTHROPIC_API_KEY — LLM 校對用（未設定則跳過 LLM 步驟）"
