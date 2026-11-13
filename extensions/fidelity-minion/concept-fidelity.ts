import { createHash } from 'node:crypto';

type ApprovedExcerpt = { atom: string; sha256: string };
type Excerpt = ApprovedExcerpt & { text: string };
type FidelityGroup = { atomSlugs: string[]; atomBodies: string[] };

/** A source-level, operator-supplied map from concept stems to pinned member excerpts. */
export function parseFidelityContracts(raw: string | null): Map<string, ApprovedExcerpt[]> {
  const result = new Map<string, ApprovedExcerpt[]>();
  if (raw == null) return result;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Concept fidelity config must be an object keyed by concept stem');
  }
  for (const [stem, members] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stem) || !Array.isArray(members) || !members.length || members.length > 16) {
      throw new Error('Invalid concept fidelity stem or excerpt count');
    }
    const atoms = new Set<string>();
    for (const member of members) {
      if (!member || typeof member.atom !== 'string' || !/^atoms\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(member.atom)
        || typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.sha256) || atoms.has(member.atom)) {
        throw new Error('Concept fidelity requires unique atom slugs and lowercase SHA-256 hashes');
      }
      atoms.add(member.atom);
    }
    result.set(stem, members.map(({ atom, sha256 }) => ({ atom, sha256 })));
  }
  return result;
}

/** Pin the full atom narrative and publish its first paragraph as an excerpt. */
export function prepareFidelityExcerpts(members: ApprovedExcerpt[], group: FidelityGroup): Excerpt[] {
  if (members.length !== group.atomSlugs.length) throw new Error('Fidelity approval must cover every member atom');
  return members.map((member) => {
    const index = group.atomSlugs.indexOf(member.atom);
    if (index < 0) throw new Error(`Approved fidelity member missing: ${member.atom}`);
    const body = group.atomBodies[index]!.trim();
    const text = body.split(/\r?\n[\t ]*\r?\n/, 1)[0]!;
    const digest = createHash('sha256').update(body).digest('hex');
    if (!text || text.length > 1200 || digest !== member.sha256) {
      throw new Error(`Approved fidelity excerpt changed or exceeds its limit: ${member.atom}`);
    }
    // Canonical publication preserves reserved sections separately from prose.
    if (/^[#<>`~+-]|[\r\n]/.test(text)) throw new Error(`Approved fidelity excerpt must be plain paragraph text: ${member.atom}`);
    return { ...member, text };
  });
}

export function renderFidelityNarrative(order: unknown, excerpts: Excerpt[]): string | null {
  if (!Array.isArray(order) || order.length !== excerpts.length || new Set(order).size !== excerpts.length) return null;
  const bySlug = new Map(excerpts.map((excerpt) => [excerpt.atom, excerpt.text]));
  const paragraphs: string[] = [];
  for (const slug of order) {
    if (typeof slug !== 'string') return null;
    const text = bySlug.get(slug);
    if (text === undefined) return null;
    paragraphs.push(`${text}\n\n[[${slug}]]`);
  }
  return paragraphs.join('\n\n');
}
