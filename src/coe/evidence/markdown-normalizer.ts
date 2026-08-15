import { canonicalizeJson, sha256Bytes } from "../contracts/index.ts";
import type { DocumentNormalizer, NormalizationBlock, NormalizerOutput } from "./types.ts";
import { decodeUtf8, normalizeUnicodeText } from "./utf8.ts";

const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function cleanInlineMarkdown(input: string): string {
  return normalizeUnicodeText(input)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?:\*\*|__)(.*?)(?:\*\*|__)/g, "$1")
    .replace(/(?:\*|_)(.*?)(?:\*|_)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cleanInlineMarkdown(cell.replace(/\\\|/g, "|")));
}

export class MarkdownDocumentNormalizer implements DocumentNormalizer {
  readonly descriptor = {
    name: "coe-markdown-lines",
    version: "1.0.0",
    config_hash: sha256Bytes(canonicalizeJson({
      offsets: "utf8-bytes",
      paragraph_join: "space",
      tables: "pipe-table-cells-v1",
      fences: "commonmark-fences-v1",
    })),
  } as const;

  supports(mediaType: string): boolean {
    const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
    return normalized === "text/markdown" || normalized === "text/x-markdown" || normalized === "text/plain";
  }

  async normalize({ bytes }: Parameters<DocumentNormalizer["normalize"]>[0]): Promise<NormalizerOutput> {
    const lines = normalizeUnicodeText(decodeUtf8(bytes)).split("\n");
    const blocks: NormalizationBlock[] = [];
    const warnings: NormalizerOutput["warnings"] = [];
    let tableNumber = 0;
    let index = 0;

    if (lines[0]?.trim() === "---") {
      const closing = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.trim() === "---");
      if (closing > 0) {
        for (let lineIndex = 1; lineIndex < closing; lineIndex += 1) {
          const raw = lines[lineIndex]!;
          if (!raw.trim()) continue;
          blocks.push({
            block_id: `md:frontmatter:${lineIndex + 1}`,
            kind: "metadata",
            text: cleanInlineMarkdown(raw),
            raw_text: raw,
            raw_locator: { kind: "line_range", start_line: lineIndex + 1, end_line: lineIndex + 1 },
          });
        }
        index = closing + 1;
      }
    }

    while (index < lines.length) {
      const raw = lines[index]!;
      if (!raw.trim()) {
        index += 1;
        continue;
      }

      const fence = raw.match(FENCE);
      if (fence) {
        const marker = fence[1]!;
        const startLine = index + 1;
        const content: string[] = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index]!)) {
          content.push(lines[index]!);
          index += 1;
        }
        const closed = index < lines.length;
        const endLine = closed ? index + 1 : lines.length;
        if (closed) index += 1;
        else warnings.push({
          code: "markdown_unclosed_fence",
          message: "A fenced code block reaches end-of-document without a closing fence.",
          severity: "blocking",
          locator: { kind: "line_range", start_line: startLine, end_line: endLine },
        });
        const text = normalizeUnicodeText(content.join("\n")).trim();
        if (text) {
          blocks.push({
            block_id: `md:code:${startLine}-${endLine}`,
            kind: "code_block",
            text,
            raw_text: content.join("\n"),
            raw_locator: { kind: "line_range", start_line: startLine, end_line: endLine },
          });
        }
        continue;
      }

      const heading = raw.match(HEADING);
      if (heading) {
        blocks.push({
          block_id: `md:heading:${index + 1}`,
          kind: "heading",
          text: cleanInlineMarkdown(heading[2]!),
          raw_text: raw,
          heading_level: heading[1]!.length,
          raw_locator: { kind: "line_range", start_line: index + 1, end_line: index + 1 },
        });
        index += 1;
        continue;
      }

      if (raw.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
        tableNumber += 1;
        const tableId = `markdown-table-${tableNumber}`;
        let row = 0;
        let lineIndex = index;
        while (lineIndex < lines.length) {
          if (lineIndex === index + 1) {
            lineIndex += 1;
            continue;
          }
          const tableLine = lines[lineIndex]!;
          if (!tableLine.includes("|") || !tableLine.trim()) break;
          for (const [column, cell] of splitTableCells(tableLine).entries()) {
            if (!cell) continue;
            blocks.push({
              block_id: `md:table:${tableNumber}:${row}:${column}`,
              kind: "table_cell",
              text: cell,
              raw_text: tableLine,
              raw_locator: { kind: "table_cell", table_id: tableId, row, column },
            });
          }
          row += 1;
          lineIndex += 1;
        }
        index = lineIndex;
        continue;
      }

      const startLine = index + 1;
      const paragraph: string[] = [];
      while (index < lines.length) {
        const line = lines[index]!;
        if (!line.trim()) break;
        if (index !== startLine - 1 && (HEADING.test(line) || FENCE.test(line))) break;
        paragraph.push(line);
        index += 1;
      }
      const endLine = startLine + paragraph.length - 1;
      const rawText = paragraph.join("\n");
      const isQuote = paragraph.every((line) => /^\s*>/.test(line));
      const isList = paragraph.every((line) => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line));
      const text = cleanInlineMarkdown(rawText
        .replace(/^\s*>\s?/gm, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, ""));
      if (text) {
        blocks.push({
          block_id: `md:block:${startLine}-${endLine}`,
          kind: isQuote ? "quote" : isList ? "list_item" : "paragraph",
          text,
          raw_text: rawText,
          raw_locator: { kind: "line_range", start_line: startLine, end_line: endLine },
        });
      }
    }

    return { blocks, warnings };
  }
}
