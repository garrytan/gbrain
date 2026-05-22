/**
 * Barrel export + convenience installer for the four built-in validators.
 */

import type { BrainWriter } from '../writer.ts';
import { citationValidator } from './citation.ts';
import { linkValidator } from './link.ts';
import { backLinkValidator } from './back-link.ts';
import { tripleHrValidator } from './triple-hr.ts';

export { citationValidator, linkValidator, backLinkValidator, tripleHrValidator };

/** Register all four built-in validators on a BrainWriter instance. */
export function registerBuiltinValidators(writer: BrainWriter): void {
  writer.register(citationValidator);
  writer.register(linkValidator);
  writer.register(backLinkValidator);
  writer.register(tripleHrValidator);
}
