/**
 * Chinese Semantic Chunker
 *
 * 为中文文档优化的语义切块器。recursive.ts 用英文单词数 + 英文标点切，
 * 中文场景下会把整段几千字打包成一个 chunk。
 *
 * 切块原则：
 * 1. 优先按 Markdown 结构（## 标题、列表项、表格行、blockquote）
 * 2. 然后按中文句子（。！？\n）
 * 3. 然后按中文短句（，；：）
 * 4. 目标 chunk 大小 400-800 字符（中文场景）
 * 5. 每两个相邻 chunk 之间有 100 字符 overlap，保证上下文连贯
 *
 * 使用方式：
 *   import { chunkChineseText } from './chunkers/chinese-semantic.ts';
 *   const chunks = chunkChineseText(text, { targetSize: 500 });
 */

export interface ChineseChunkOptions {
  /** 目标 chunk 大小（字符数）。默认 500 */
  targetSize?: number;
  /** 最大 chunk 大小（字符数），超过则强制切。默认 1000 */
  maxSize?: number;
  /** 相邻 chunk overlap 字符数。默认 100 */
  overlap?: number;
}

export interface ChineseTextChunk {
  text: string;
  start: number;
  end: number;
}

const DEFAULT_OPTS: Required<ChineseChunkOptions> = {
  targetSize: 500,
  maxSize: 1000,
  overlap: 100,
};

/**
 * 主入口：把中文长文本切成语义友好的小块。
 */
export function chunkChineseText(
  text: string,
  opts: ChineseChunkOptions = {},
): ChineseTextChunk[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!text || text.trim().length === 0) return [];

  // 1. 先按 Markdown 块结构切（标题、列表、表格、代码块、blockquote）
  const blocks = splitByMarkdownBlocks(text);

  // 2. 把过大的块再用中文句子切；过小的块合并
  const chunks: ChineseTextChunk[] = [];
  let buffer = '';
  let bufferStart = 0;

  for (const block of blocks) {
    // 如果当前块本身就大于 maxSize，单独按句子切
    if (block.text.length > o.maxSize) {
      // flush 当前 buffer
      if (buffer.length > 0) {
        chunks.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
        buffer = '';
      }
      // 大块按中文句子切
      const subChunks = splitLargeBlock(block.text, block.start, o);
      chunks.push(...subChunks);
      bufferStart = block.start + block.text.length;
      continue;
    }

    // 如果 buffer + block 不超过 targetSize，合并
    if (buffer.length + block.text.length <= o.targetSize) {
      if (buffer.length === 0) bufferStart = block.start;
      buffer += (buffer.length > 0 ? '\n\n' : '') + block.text;
    } else {
      // flush 当前 buffer，开始新 chunk
      if (buffer.length > 0) {
        chunks.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
      }
      buffer = block.text;
      bufferStart = block.start;
    }
  }
  if (buffer.length > 0) {
    chunks.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
  }

  // 3. 添加 overlap（每个 chunk 末尾追加下一个 chunk 的前 N 字）
  return addOverlap(chunks, o.overlap);
}

/**
 * 按 Markdown 块结构切：标题段、列表段、表格、代码块、blockquote 段、普通段落
 */
function splitByMarkdownBlocks(text: string): ChineseTextChunk[] {
  const blocks: ChineseTextChunk[] = [];
  const lines = text.split('\n');

  let currentBlock: string[] = [];
  let blockStart = 0;
  let charPos = 0;
  let currentType: 'normal' | 'list' | 'table' | 'code' | 'quote' | 'heading' = 'normal';

  const flushBlock = () => {
    const blockText = currentBlock.join('\n').trim();
    if (blockText.length > 0) {
      blocks.push({ text: blockText, start: blockStart, end: blockStart + blockText.length });
    }
    currentBlock = [];
    blockStart = charPos;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测块类型
    const isHeading = /^#{1,6}\s/.test(trimmed);
    const isList = /^[-*+]\s|^\d+\.\s/.test(trimmed);
    const isTable = trimmed.startsWith('|') && trimmed.endsWith('|');
    const isCodeFence = trimmed.startsWith('```');
    const isQuote = trimmed.startsWith('>');
    const isEmpty = trimmed.length === 0;

    let lineType: typeof currentType = 'normal';
    if (isHeading) lineType = 'heading';
    else if (isList) lineType = 'list';
    else if (isTable) lineType = 'table';
    else if (isCodeFence) lineType = 'code';
    else if (isQuote) lineType = 'quote';

    // 标题永远是新块的起点
    if (isHeading) {
      flushBlock();
      currentBlock.push(line);
      currentType = 'heading';
    }
    // 空行：当前块结束（除非在代码块内）
    else if (isEmpty && currentType !== 'code') {
      flushBlock();
      currentType = 'normal';
    }
    // 类型切换（如普通段落 → 列表）：新块
    else if (currentBlock.length > 0 && lineType !== currentType && lineType !== 'normal') {
      flushBlock();
      currentBlock.push(line);
      currentType = lineType;
    } else {
      currentBlock.push(line);
      if (currentBlock.length === 1) currentType = lineType;
    }

    charPos += line.length + 1; // +1 for \n
  }
  flushBlock();
  return blocks;
}

/**
 * 大块按中文标点切，目标接近 targetSize
 */
function splitLargeBlock(
  text: string,
  offset: number,
  opts: Required<ChineseChunkOptions>,
): ChineseTextChunk[] {
  // 中文 + 英文句末标点
  const sentenceRegex = /[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g;
  const sentences: string[] = text.match(sentenceRegex) || [text];

  const chunks: ChineseTextChunk[] = [];
  let buffer = '';
  let chunkStart = offset;
  let pos = 0;

  for (const sent of sentences) {
    // 单个句子比 maxSize 还大，强制按字符切
    if (sent.length > opts.maxSize) {
      if (buffer.length > 0) {
        chunks.push({ text: buffer, start: chunkStart, end: chunkStart + buffer.length });
        buffer = '';
        chunkStart = offset + pos;
      }
      let remaining = sent;
      while (remaining.length > opts.maxSize) {
        const chunk = remaining.slice(0, opts.maxSize);
        chunks.push({ text: chunk, start: chunkStart, end: chunkStart + chunk.length });
        chunkStart += chunk.length;
        remaining = remaining.slice(opts.maxSize);
      }
      if (remaining.length > 0) {
        buffer = remaining;
      }
      pos += sent.length;
      continue;
    }

    // 累加到 buffer
    if (buffer.length + sent.length > opts.targetSize && buffer.length > 0) {
      chunks.push({ text: buffer, start: chunkStart, end: chunkStart + buffer.length });
      buffer = sent;
      chunkStart = offset + pos;
    } else {
      if (buffer.length === 0) chunkStart = offset + pos;
      buffer += sent;
    }
    pos += sent.length;
  }
  if (buffer.length > 0) {
    chunks.push({ text: buffer, start: chunkStart, end: chunkStart + buffer.length });
  }
  return chunks;
}

/**
 * 给每个 chunk 末尾追加下一个 chunk 的前 N 字符，作为 overlap
 */
function addOverlap(chunks: ChineseTextChunk[], overlap: number): ChineseTextChunk[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  return chunks.map((chunk, i) => {
    if (i === chunks.length - 1) return chunk;
    const next = chunks[i + 1];
    const tail = next.text.slice(0, overlap);
    return {
      ...chunk,
      text: chunk.text + (chunk.text.endsWith('\n') ? '' : '\n') + tail,
      end: chunk.end + tail.length,
    };
  });
}
