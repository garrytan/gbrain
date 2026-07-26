import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import type { BrainEngine } from './engine.ts';
import {
  importFromContent,
  type ImportResult,
  type ParentSectionInput,
} from './import-file.ts';
import { isOfficeFilePath, slugifyPath } from './sync.ts';

export const SUPPORTED_OFFICE_EXTS = ['.docx', '.doc', '.wps', '.pptx', '.ppt', '.pdf', '.xlsx', '.xlsm', '.xls', '.csv'] as const;

const MAX_OFFICE_BYTES = 50 * 1024 * 1024;
const OFFICE_XML_TEXT_NODES = new Set(['w:t', 'a:t']);
export { isOfficeFilePath };

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split extracted Office text into structural parents. Retrieval indexes
 * smaller child chunks, while every child carries its document/section
 * locator so the caller can return to the full parent page.
 */
export function buildOfficeParentSections(
  text: string,
  documentTitle: string,
): ParentSectionInput[] {
  const heading = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length > 0) {
    return matches.flatMap((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const body = normalizeText(text.slice(start, end));
      if (!body) return [];
      const title = match[1].trim();
      return [{ title, locator: title, text: body }];
    });
  }

  const paragraphs = text.split(/\n{2,}/).map(normalizeText).filter(Boolean);
  const sections: ParentSectionInput[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const flush = () => {
    if (current.length === 0) return;
    const index = sections.length + 1;
    sections.push({
      title: sections.length === 0 ? documentTitle : `${documentTitle} - Part ${index}`,
      locator: `part-${index}`,
      text: current.join('\n\n'),
    });
    current = [];
    currentLength = 0;
  };
  for (const paragraph of paragraphs) {
    if (currentLength > 0 && currentLength + paragraph.length > 3_000) flush();
    current.push(paragraph);
    currentLength += paragraph.length;
  }
  flush();
  return sections;
}

function collectTextFromNode(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTextFromNode(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (OFFICE_XML_TEXT_NODES.has(key)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' || typeof item === 'number') out.push(String(item));
        }
      } else if (typeof value === 'string' || typeof value === 'number') {
        out.push(String(value));
      }
      continue;
    }
    collectTextFromNode(value, out);
  }
}

function extractParagraphTexts(parsedXml: unknown): string[] {
  const paragraphs: string[] = [];

  function visit(node: unknown): void {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'w:p') {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          const textParts: string[] = [];
          collectTextFromNode(item, textParts);
          const text = textParts.join('').trim();
          if (text) paragraphs.push(text);
        }
      } else {
        visit(value);
      }
    }
  }

  visit(parsedXml);
  return paragraphs;
}

async function readDocxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) {
    throw new Error('DOCX is missing word/document.xml');
  }

  const parser = new XMLParser({
    ignoreAttributes: true,
    processEntities: true,
    trimValues: false,
  });
  const parsed = parser.parse(await documentXml.async('text'));
  const paragraphs = extractParagraphTexts(parsed);
  return normalizeText(paragraphs.join('\n\n'));
}

async function readPptxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, trimValues: false });
  const slideFiles = Object.keys(zip.files)
    .map(name => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/i) }))
    .filter((item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match))
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  if (slideFiles.length === 0) throw new Error('PPTX contains no slides.');

  const sections: string[] = [];
  for (const [index, slideFile] of slideFiles.entries()) {
    const entry = zip.file(slideFile.name);
    if (!entry) continue;
    const parts: string[] = [];
    collectTextFromNode(parser.parse(await entry.async('text')), parts);
    const body = normalizeText(parts.join('\n'));
    if (body) sections.push(`## Slide ${index + 1}\n\n${body}`);
  }
  return normalizeText(sections.join('\n\n'));
}

async function readPdfText(filePath: string): Promise<string> {
  const parser = new PDFParse({ data: readFileSync(filePath) });
  try {
    const result = await parser.getText();
    return normalizeText(result.text);
  } finally {
    await parser.destroy();
  }
}

function markdownEscapeCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function renderRowsAsMarkdownTable(rows: unknown[][]): string {
  const nonEmptyRows = rows
    .map(row => row.map(cell => markdownEscapeCell(cell)))
    .filter(row => row.some(cell => cell.length > 0));
  if (nonEmptyRows.length === 0) return '';

  const width = Math.max(...nonEmptyRows.map(row => row.length));
  const normalizedRows = nonEmptyRows.map(row => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });

  const first = normalizedRows[0] ?? [];
  const header = first.some(cell => cell.length > 0)
    ? first
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const body = normalizedRows.slice(1);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function readSpreadsheetText(filePath: string): string {
  const workbook = XLSX.readFile(filePath, { cellDates: true, dense: false });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const table = renderRowsAsMarkdownTable(rows);
    if (!table) continue;
    sections.push([`## Sheet: ${sheetName}`, '', table].join('\n'));
  }

  return normalizeText(sections.join('\n\n'));
}

function findOfficeCommand(): string | null {
  const candidates = ['soffice', 'libreoffice'];
  for (const name of candidates) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (out) return out;
    } catch {
      // Try the next command name.
    }
  }
  if (process.platform === 'win32') {
    const knownPaths = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];
    for (const p of knownPaths) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function convertLegacyWordToDocx(filePath: string, officeCommand: string, outDir: string): string | null {
  execFileSync(officeCommand, [
    '--headless',
    '--convert-to',
    'docx',
    '--outdir',
    outDir,
    filePath,
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

  const expected = join(outDir, `${basename(filePath, extname(filePath))}.docx`);
  if (existsSync(expected)) return expected;

  return null;
}

function convertLegacyPresentationToPptx(filePath: string, officeCommand: string, outDir: string): string | null {
  execFileSync(officeCommand, ['--headless', '--convert-to', 'pptx', '--outdir', outDir, filePath], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const expected = join(outDir, `${basename(filePath, extname(filePath))}.pptx`);
  return existsSync(expected) ? expected : null;
}

async function readLegacyPresentationText(filePath: string): Promise<string> {
  const officeCommand = findOfficeCommand();
  if (officeCommand) {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-office-'));
    try {
      const converted = convertLegacyPresentationToPptx(filePath, officeCommand, tmp);
      if (!converted) throw new Error('LibreOffice conversion did not produce a .pptx file.');
      return readPptxText(converted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (process.platform === 'win32') return readLegacyPresentationTextViaPowerPointCom(filePath);
  throw new Error('Legacy PowerPoint import requires LibreOffice/soffice, or Microsoft PowerPoint on Windows.');
}

async function readLegacyWordText(filePath: string): Promise<string> {
  const officeCommand = findOfficeCommand();
  if (officeCommand) {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-office-'));
    try {
      const converted = convertLegacyWordToDocx(filePath, officeCommand, tmp);
      if (!converted) {
        throw new Error('LibreOffice conversion did not produce a .docx file.');
      }
      return readDocxText(converted);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (process.platform === 'win32') {
    return readLegacyWordTextViaWordCom(filePath);
  }

  throw new Error('Legacy Word import requires LibreOffice/soffice, or Microsoft Word on Windows.');
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function readLegacyWordTextViaWordCom(filePath: string): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_OFFICE_FILE
$word = $null
$doc = $null
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $confirmConversions = $false
  $readOnly = $true
  $addToRecentFiles = $false
  $doc = $word.Documents.Open($path, $confirmConversions, $readOnly, $addToRecentFiles)
  [Console]::Write($doc.Content.Text)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
} finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null } catch {}
  }
  if ($word -ne $null) {
    try { $word.Quit() | Out-Null } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
  }
}
`;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(script),
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GBRAIN_OFFICE_FILE: filePath },
    });
    return normalizeText(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Legacy Word import requires LibreOffice/soffice, or Microsoft Word on Windows. ' +
      `Word COM extraction failed: ${message}`,
    );
  }
}

function readLegacyPresentationTextViaPowerPointCom(filePath: string): string {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:GBRAIN_OFFICE_FILE
$powerPoint = $null
$presentation = $null
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($path, $true, $true, $false)
  $sections = New-Object System.Collections.Generic.List[string]
  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($shape in $presentation.Slides.Item($slideIndex).Shapes) {
      try {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $value = $shape.TextFrame.TextRange.Text.Trim()
          if ($value) { $lines.Add($value) }
        }
      } catch {}
    }
    if ($lines.Count -gt 0) { $sections.Add("## Slide $slideIndex" + [Environment]::NewLine + [Environment]::NewLine + ($lines -join [Environment]::NewLine)) }
  }
  [Console]::Write($sections -join ([Environment]::NewLine + [Environment]::NewLine))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
} finally {
  if ($presentation -ne $null) {
    try { $presentation.Close() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) | Out-Null } catch {}
  }
  if ($powerPoint -ne $null) {
    try { $powerPoint.Quit() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) | Out-Null } catch {}
  }
}
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_OFFICE_FILE: filePath },
    });
    return normalizeText(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Legacy PowerPoint import failed: ${message}`);
  }
}

export async function extractOfficeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.docx') return readDocxText(filePath);
  if (ext === '.doc' || ext === '.wps') return readLegacyWordText(filePath);
  if (ext === '.pptx') return readPptxText(filePath);
  if (ext === '.ppt') return readLegacyPresentationText(filePath);
  if (ext === '.pdf') return readPdfText(filePath);
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls' || ext === '.csv') return readSpreadsheetText(filePath);
  throw new Error(`Unsupported document file type: ${ext}`);
}

export async function importOfficeFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: {
    noEmbed?: boolean;
    sourceId?: string;
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  } = {},
): Promise<ImportResult> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }

  const stat = statSync(filePath);
  if (stat.size > MAX_OFFICE_BYTES) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Document file too large (${stat.size} bytes, max ${MAX_OFFICE_BYTES})`,
    };
  }

  const rawBytes = readFileSync(filePath);
  const rawHash = createHash('sha256').update(rawBytes).digest('hex');
  const text = await extractOfficeText(filePath);
  if (!text.trim()) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `No extractable text found in document file: ${relativePath}`,
    };
  }

  const title = basename(relativePath, extname(relativePath));
  const ext = extname(relativePath).toLowerCase().slice(1);
  const slug = slugifyPath(relativePath);
  const parentSections = buildOfficeParentSections(text, title);
  const content = [
    '---',
    'type: source',
    `title: ${yamlScalar(title)}`,
    `id: ${yamlScalar(`office:${rawHash}`)}`,
    `source_format: ${yamlScalar(ext)}`,
    `original_path: ${yamlScalar(relativePath.replace(/\\/g, '/'))}`,
    `raw_sha256: ${yamlScalar(rawHash)}`,
    `file_size_bytes: ${stat.size}`,
    'retrieval_mode: office_parent_child',
    '---',
    '',
    `# ${title}`,
    '',
    text,
    '',
  ].join('\n');

  return importFromContent(engine, slug, content, {
    noEmbed: opts.noEmbed,
    sourceId: opts.sourceId,
    activePack: opts.activePack,
    filename: basename(relativePath, extname(relativePath)),
    sourcePath: relativePath,
    source_kind: 'document_file',
    source_uri: relativePath.replace(/\\/g, '/'),
    ingested_via: 'gbrain:import',
    parentSections,
  });
}
