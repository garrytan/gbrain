/**
 * v0.20.0 Cathedral II Layer 5 — qualified symbol identity.
 *
 * Edge identity across languages needs a shared notion of "the Admin
 * controller's render method" vs "the ViewHelper module's render method".
 * Raw symbol_name ('render') is too ambiguous; a raw parent_symbol_path
 * (['Admin', 'UsersController', 'render']) needs a language-aware join
 * to match the conventions the ecosystem uses.
 *
 * This module builds qualified names from the pieces the chunker already
 * collects:
 *   - language (from detectCodeLanguage)
 *   - symbolType (from normalizeSymbolType: 'function' | 'method' | 'class' | ...)
 *   - symbolName (from extractSymbolName)
 *   - parentSymbolPath (from Layer 6 A3 emitNestedScoped)
 *
 * Output is a single TEXT value stored in content_chunks.symbol_name_qualified
 * and used as the edge-identity key. Examples:
 *
 *   Ruby:   Admin::UsersController#render     (instance method)
 *           Admin::UsersController.find_all   (singleton method)
 *   Python: admin.users_controller.UsersController.render
 *   TS/JS:  BrainEngine.searchKeyword         (class method)
 *           parseInput                        (standalone fn)
 *   Go:     users.Render                      (package-qualified fn)
 *           (*UsersController).Render         (method on pointer receiver)
 *   Rust:   users::UsersController::render    (impl block scoped)
 *   Java:   com.acme.admin.UsersController.render
 *
 * The per-language delimiters + instance/singleton distinction are
 * codified in LANG_CONFIG below. When a language is unknown or symbol
 * name is missing, we return null (edge extractor skips the row).
 */

import type { SupportedCodeLanguage } from './code.ts';

interface QualifiedNameConfig {
  /** Delimiter between namespace segments (e.g. '::' for Ruby, '.' for Python). */
  segmentDelim: string;
  /** Delimiter between class and instance method (Ruby: '#'). */
  methodDelim?: string;
  /** Delimiter between class and singleton / static method. */
  staticDelim?: string;
  /**
   * When true, treat "method" symbol types as instance methods and use
   * `methodDelim`; otherwise fall back to `segmentDelim`.
   */
  distinguishInstanceMethods?: boolean;
}

const LANG_CONFIG: Partial<Record<SupportedCodeLanguage, QualifiedNameConfig>> = {
  typescript: { segmentDelim: '.' },
  tsx:        { segmentDelim: '.' },
  javascript: { segmentDelim: '.' },
  python:     { segmentDelim: '.' },
  go:         { segmentDelim: '.' },
  rust:       { segmentDelim: '::' },
  java:       { segmentDelim: '.' },
  ruby:       {
    segmentDelim: '::',
    methodDelim: '#',
    staticDelim: '.',
    distinguishInstanceMethods: true,
  },
};

/**
 * Build a qualified name from the chunker's per-chunk metadata. Returns
 * null when the inputs aren't enough to form a usable identity — callers
 * skip those chunks for edge extraction.
 */
export function buildQualifiedName(input: {
  language: SupportedCodeLanguage;
  symbolName: string | null;
  symbolType: string;
  parentSymbolPath: string[];
  /** Ruby `def self.m`: a singleton method, qualified with `staticDelim`. */
  singleton?: boolean;
}): string | null {
  if (!input.symbolName) return null;
  const cfg = LANG_CONFIG[input.language];
  if (!cfg) {
    // Unknown language — at least return the raw symbol name so edge
    // matching doesn't lose it entirely. Not ideal for disambiguation
    // but better than dropping the edge on the floor.
    return input.parentSymbolPath.length > 0
      ? `${input.parentSymbolPath.join('.')}.${input.symbolName}`
      : input.symbolName;
  }

  if (input.parentSymbolPath.length === 0) return input.symbolName;

  const parents = input.parentSymbolPath.join(cfg.segmentDelim);

  if (cfg.distinguishInstanceMethods && input.symbolType === 'function') {
    // Ruby: `def m` is an instance method (Class#method) and `def self.m` a
    // singleton method (Class.method). The chunker normalizes both node types
    // to 'function' and passes `singleton` from the node, so the two never
    // share an edge identity (`def self.call` + `def call` is the
    // service-object idiom).
    const delim = input.singleton ? (cfg.staticDelim ?? '.') : (cfg.methodDelim ?? '#');
    return `${parents}${delim}${input.symbolName}`;
  }

  return `${parents}${cfg.segmentDelim}${input.symbolName}`;
}

/** Exported for unit testing the lang-config table directly. */
export const __testing = {
  LANG_CONFIG,
};
