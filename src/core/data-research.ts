/**
 * Data research utilities: recipe loading/validation, field extraction,
 * deduplication, tracker page parsing, date windowing, HTML stripping.
 *
 * Used by the data-research skill and supporting agent workflows.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchRecipe {
  name: string;
  source_queries: {
    gmail?: string[];
    brain?: string[];
    web?: string[];
    date_windowing?: 'quarterly' | 'monthly';
  };
  classification: {
    include_patterns?: string[];
    exclude_patterns?: string[];
    receipt_indicators?: string[];
    marketing_indicators?: string[];
  };
  extraction_schema: Record<string, string>;
  tracker_page: string;
  tracker_format: {
    group_by: string;
    columns: string[];
    sort?: string;
    totals?: string[];
  };
  schedule?: {
    cron: string;
    notify?: boolean;
    quiet_hours?: boolean;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface TrackerEntry {
  [key: string]: string | number | string[];
}

export interface DedupConfig {
  amountTolerance?: number;    // e.g., 5 for $5 tolerance
  dateExact?: boolean;         // exact date match required
  entityFuzzy?: boolean;       // fuzzy entity name matching
}

export interface DedupResult {
  isDuplicate: boolean;
  type: 'exact' | 'fuzzy' | 'different_amount' | 'new';
  matchedEntry?: TrackerEntry;
}

export interface DateWindow {
  start: string;  // YYYY/MM/DD
  end: string;
  label: string;  // e.g., "Q1 2026"
}

// ---------------------------------------------------------------------------
// Recipe loading and validation
// ---------------------------------------------------------------------------

/** Validate a research recipe has required fields and valid patterns. */
export function validateRecipe(recipe: Partial<ResearchRecipe>): ValidationResult {
  const errors: string[] = [];

  if (!recipe.name) errors.push('Missing required field: name');
  if (!recipe.source_queries) errors.push('Missing required field: source_queries');
  if (!recipe.extraction_schema) errors.push('Missing required field: extraction_schema');
  if (!recipe.tracker_page) errors.push('Missing required field: tracker_page');
  if (!recipe.tracker_format) errors.push('Missing required field: tracker_format');

  if (recipe.tracker_format) {
    if (!recipe.tracker_format.group_by) errors.push('tracker_format missing group_by');
    if (!recipe.tracker_format.columns || recipe.tracker_format.columns.length === 0) {
      errors.push('tracker_format missing columns');
    }
  }

  if (recipe.source_queries) {
    const sq = recipe.source_queries;
    if (!sq.gmail && !sq.brain && !sq.web) {
      errors.push('source_queries must have at least one of: gmail, brain, web');
    }
  }

  // Validate regex patterns are compilable
  const patternArrays = [
    recipe.classification?.include_patterns,
    recipe.classification?.exclude_patterns,
    recipe.classification?.receipt_indicators,
    recipe.classification?.marketing_indicators,
  ].filter(Boolean);

  for (const patterns of patternArrays) {
    for (const p of patterns!) {
      try {
        // Patterns are stored as strings like "/regex/flags"
        const match = p.match(/^\/(.+)\/([gimsuy]*)$/);
        if (match) new RegExp(match[1], match[2]);
      } catch (e: any) {
        errors.push(`Invalid regex pattern '${p}': ${e.message}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** Common financial metric regex patterns. */
const METRIC_PATTERNS: Record<string, RegExp[]> = {
  mrr: [
    /MRR[:\s]+(?:of\s+)?\$?([\d,]+\.?\d*\s*[KkMm]?)/i,
    /MRR\s+(?:hit|is|at|reached|now|of)\s+\$?([\d,]+\.?\d*\s*[KkMm]?)/i,
    /\$([\d,]+\.?\d*\s*[KkMm])\s*MRR/i,
  ],
  arr: [
    /ARR[:\s]+(?:of\s+)?\$?([\d,]+\.?\d*\s*[KkMmBb]?)/i,
    /ARR\s+(?:hit|is|at|reached|now|of)\s+\$?([\d,]+\.?\d*\s*[KkMmBb]?)/i,
    /\$([\d,]+\.?\d*\s*[KkMmBb])\s*ARR/i,
  ],
  growth_mom: [
    /(\+?-?\d+\.?\d*%)\s*(?:MoM|month[ -]over[ -]month)/i,
    /(?:grew|growth|increased|up)\s+(?:by\s+)?(\+?\d+\.?\d*%)/i,
  ],
  runway_months: [
    /runway[:\s]+(?:of\s+)?(?:about\s+)?(\d+)\s*(?:months?|mo)/i,
    /(\d+)\s*(?:months?|mo)\s*(?:of\s+)?runway/i,
  ],
  headcount: [
    /(\d+)\s*(?:employees?|team members?|people|headcount|FTEs?)/i,
    /team\s+(?:of|size[:\s]+)\s*(\d+)/i,
  ],
  customers: [
    /(\d[\d,]*)\s*(?:customers?|clients?|users?|accounts?)/i,
  ],
  amount: [
    /Total Charged\s*\n?\s*\$([\d,]+\.\d{2})/i,
    /receipt for your \$([\d,]+\.\d{2})/i,
    /\$([\d,]+(?:\.\d{1,2})?)/g,
  ],
};

/** Extract structured fields from raw text using regex patterns. */
export function extractFields(
  rawText: string,
  schema: Record<string, string>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {};

  for (const [field, type] of Object.entries(schema)) {
    // Check if we have built-in patterns for this field
    const patterns = METRIC_PATTERNS[field];
    if (patterns) {
      let matched = false;
      for (const pattern of patterns) {
        const match = rawText.match(pattern);
        if (match && match[1]) {
          result[field] = match[1].trim();
          matched = true;
          break;
        }
      }
      if (!matched) result[field] = null;
    } else if (type === 'date') {
      // Extract dates in common formats
      const dateMatch = rawText.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
      result[field] = dateMatch ? dateMatch[1] : null;
    } else {
      result[field] = null; // No built-in pattern, needs LLM or custom regex
    }
  }

  return result;
}

/** Verify extracted fields match what was saved to file (extraction integrity). */
export function verifyExtraction(
  savedFields: Record<string, any>,
  reportedFields: Record<string, any>,
): { verified: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const [key, savedValue] of Object.entries(savedFields)) {
    const reported = reportedFields[key];
    if (reported !== undefined && String(reported) !== String(savedValue)) {
      mismatches.push(`${key}: saved="${savedValue}" reported="${reported}"`);
    }
  }
  return { verified: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** Check if an entry duplicates an existing tracker entry. */
export function isDuplicate(
  existing: TrackerEntry[],
  candidate: TrackerEntry,
  keyFields: string[],
  config?: DedupConfig,
): DedupResult {
  const tolerance = config?.amountTolerance || 0;

  for (const entry of existing) {
    // Check if all key fields match
    let allMatch = true;
    let nonAmountFieldsMatch = true;
    let amountDiffers = false;

    for (const key of keyFields) {
      const existingVal = String(entry[key] || '');
      const candidateVal = String(candidate[key] || '');

      if (key === 'amount') {
        const existingNum = parseFloat(existingVal.replace(/[$,]/g, ''));
        const candidateNum = parseFloat(candidateVal.replace(/[$,]/g, ''));
        if (tolerance > 0 && Math.abs(existingNum - candidateNum) > tolerance) {
          amountDiffers = true;
          allMatch = false;
        } else if (existingVal.toLowerCase() !== candidateVal.toLowerCase()) {
          amountDiffers = true;
          allMatch = false;
        }
      } else if (config?.entityFuzzy && (key === 'recipient' || key === 'company')) {
        if (existingVal.slice(0, 15).toLowerCase() !== candidateVal.slice(0, 15).toLowerCase()) {
          allMatch = false;
          nonAmountFieldsMatch = false;
        }
      } else {
        if (existingVal.toLowerCase() !== candidateVal.toLowerCase()) {
          allMatch = false;
          nonAmountFieldsMatch = false;
        }
      }
    }

    if (allMatch) {
      return { isDuplicate: true, type: 'exact', matchedEntry: entry };
    }
    if (amountDiffers && nonAmountFieldsMatch) {
      return { isDuplicate: false, type: 'different_amount', matchedEntry: entry };
    }
  }

  return { isDuplicate: false, type: 'new' };
}

// ---------------------------------------------------------------------------
// Tracker page parsing
// ---------------------------------------------------------------------------

/** Parse a markdown table into structured entries. */
export function parseTrackerPage(markdown: string, columns: string[]): TrackerEntry[] {
  const entries: TrackerEntry[] = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    // Skip header row
    if (cells.length >= columns.length && cells[0] !== columns[0]) {
      const entry: TrackerEntry = {};
      for (let i = 0; i < columns.length && i < cells.length; i++) {
        entry[columns[i]] = cells[i];
      }
      entries.push(entry);
    }
  }

  return entries;
}

/** Append entries to a tracker page's markdown table. */
export function appendToTracker(
  markdown: string,
  entries: TrackerEntry[],
  columns: string[],
  section?: string,
): string {
  const newRows = entries.map(entry => {
    const cells = columns.map(col => String(entry[col] || ''));
    return `| ${cells.join(' | ')} |`;
  }).join('\n');

  if (section) {
    // Find the section and append before the next section or end
    const sectionPattern = new RegExp(`(### ${section}[\\s\\S]*?)(\\n### |$)`);
    const match = markdown.match(sectionPattern);
    if (match) {
      const insertPoint = match.index! + match[1].length;
      return markdown.slice(0, insertPoint) + '\n' + newRows + '\n' + markdown.slice(insertPoint);
    }
  }

  // Append to end
  return markdown + '\n' + newRows + '\n';
}

/** Compute running totals for specified columns. */
export function computeTotals(
  entries: TrackerEntry[],
  totalColumns: string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const col of totalColumns) {
    totals[col] = 0;
    for (const entry of entries) {
      const val = String(entry[col] || '0').replace(/[$,]/g, '');
      const num = parseFloat(val);
      if (!isNaN(num)) totals[col] += num;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Date windowing
// ---------------------------------------------------------------------------

/** Build quarterly or monthly date windows for Gmail queries. */
export function buildDateWindows(
  startYear: number,
  endYear: number,
  granularity: 'quarterly' | 'monthly' = 'quarterly',
): DateWindow[] {
  if (endYear < startYear) {
    throw new Error(`endYear (${endYear}) must be >= startYear (${startYear})`);
  }

  const windows: DateWindow[] = [];

  for (let year = startYear; year <= endYear; year++) {
    if (granularity === 'quarterly') {
      windows.push(
        { start: `${year}/01/01`, end: `${year}/04/01`, label: `Q1 ${year}` },
        { start: `${year}/04/01`, end: `${year}/07/01`, label: `Q2 ${year}` },
        { start: `${year}/07/01`, end: `${year}/10/01`, label: `Q3 ${year}` },
        { start: `${year}/10/01`, end: `${year + 1}/01/01`, label: `Q4 ${year}` },
      );
    } else {
      for (let month = 1; month <= 12; month++) {
        const nextMonth = month === 12 ? 1 : month + 1;
        const nextYear = month === 12 ? year + 1 : year;
        windows.push({
          start: `${year}/${String(month).padStart(2, '0')}/01`,
          end: `${nextYear}/${String(nextMonth).padStart(2, '0')}/01`,
          label: `${year}-${String(month).padStart(2, '0')}`,
        });
      }
    }
  }

  return windows;
}

// ---------------------------------------------------------------------------
// HTML email stripping (6-phase pipeline)
// ---------------------------------------------------------------------------

const MAX_HTML_SIZE = 500 * 1024; // 500KB cap (ReDoS prevention)

/** Strip HTML from email bodies. 6-phase pipeline with input size cap. */
export function stripEmailHtml(html: string): string {
  // Phase 0: Size cap (ReDoS prevention)
  let text = html;
  if (text.length > MAX_HTML_SIZE) {
    text = text.slice(0, MAX_HTML_SIZE) + '\n...[truncated]';
  }

  // Phase 1: Remove <style> and <script> blocks entirely
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Phase 2: Convert block elements to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');

  // Phase 3: Strip remaining HTML tags (non-greedy)
  text = text.replace(/<[^>]*?>/g, '');

  // Phase 4: Strip inline CSS artifacts (skip on large inputs for performance)
  if (text.length < 100000) {
    text = text.replace(/@media[^{]*\{[^}]*\}/g, '');
    text = text.replace(/\.[a-zA-Z][\w-]*\s*\{[^}]*\}/g, '');
    text = text.replace(/#[a-zA-Z][\w-]*\s*\{[^}]*\}/g, '');
  }

  // Phase 5: Decode HTML entities
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

  // Phase 6: Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}
