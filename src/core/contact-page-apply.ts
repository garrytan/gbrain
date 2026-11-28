/**
 * One contact applied to the pages a contacts source owns, shared by the Google contacts sweep
 * (google/people-calendar-sweep.ts) and the apple-contacts source (apple-contacts/apple-contacts-source.ts). Each page
 * carries its contact id in frontmatter; ownership is decided on that id, never on the path alone:
 *
 *   - the page a contact owns is found by its id first, in any directory, because a deletion carries only the id, a
 *     renamed contact derives a different slug and a changed contacts directory moves every page;
 *   - a deletion retires only the page this contact owns (found by id, else among its slug candidates);
 *   - a page another contact owns at the same slug (two "Alice Example"s) is neither rewritten nor deleted: the
 *     contact gets a disambiguated slug; a hand-authored page at the slug (no id) is skipped, body and frontmatter;
 *   - the path finally rendered is checked again: one another contact still owns refuses the contact before anything
 *     is written or retired (#10450);
 *   - a rename lands the new page first, then retires the one it owned at the old path, so a run that dies in
 *     between leaves the contact with a page rather than none.
 */
import { opError } from './ops/contract.ts';

export interface ContactPageIO {
  /** The source_path of the live page this contact owns, or null. */
  existingPath(): Promise<string | null>;
  /** Who owns the page at relPath: a contact id, 'hand-authored', or null when there is no page. */
  owner(relPath: string): Promise<string | null>;
  /** The contact's base slug (no disambiguation), or null when it has none. */
  baseSlug(): string | null;
  /** Slugs a deleted contact may own when no page is found by id. */
  tombstoneSlugs(): Array<string | null>;
  render(disambiguate: boolean): { relPath: string; markdown: string } | null;
  write(relPath: string, markdown: string): Promise<void>;
  remove(relPath: string): Promise<void>;
  skippedHandAuthored(relPath: string): void;
  applied(): void;
}

export async function applyContactPage(contactId: string, deleted: boolean, io: ContactPageIO): Promise<void> {
  const existingPath = await io.existingPath();
  if (deleted) {
    if (existingPath && await io.owner(existingPath) === contactId) {
      await io.remove(existingPath);
    } else {
      for (const slug of io.tombstoneSlugs()) {
        if (slug && await io.owner(`${slug}.md`) === contactId) await io.remove(`${slug}.md`);
      }
    }
    return;
  }
  const baseSlug = io.baseSlug();
  if (!baseSlug) return;
  const baseOwner = await io.owner(`${baseSlug}.md`);
  const collides = baseOwner !== null && baseOwner !== 'hand-authored' && baseOwner !== contactId;
  const rendered = io.render(collides);
  if (!rendered) return;
  const owner = await io.owner(rendered.relPath);
  if (owner === 'hand-authored') {
    io.skippedHandAuthored(rendered.relPath);
    return;
  }
  if (owner !== null && owner !== contactId) {
    throw opError('contact_page_owned', `Contact page ${rendered.relPath} belongs to another contact.`,
      `Contact ${contactId} was not written and its existing page was kept; it is retried on the next sync and held after repeated refusals. Rename one of the two contacts, or remove the other page, to clear it.`);
  }
  await io.write(rendered.relPath, rendered.markdown);
  if (existingPath && existingPath !== rendered.relPath && await io.owner(existingPath) === contactId) {
    await io.remove(existingPath);
  }
  io.applied();
}
