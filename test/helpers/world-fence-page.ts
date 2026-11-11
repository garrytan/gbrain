/** A world page whose facts fence holds one world and one private row and whose takes fence holds one row (synthetic names only). */
export const PRIVATE_ROW = 'Alice-example keeps the source-a renewal terms at canaryprivaterow7781';
export const HIDDEN_TAKE_ROW = 'Acme-example will move the launch to canarytakerow4410';
export const WORLD_ROW = 'Acme-example ships the launch checklist every quarter';
const PROSE = 'The launch review found that the team measures every launch against clear exit criteria. '.repeat(10);

export const FENCES = `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${WORLD_ROW} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |
| 2 | ${PRIVATE_ROW} | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->

## Takes

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |
<!--- gbrain:takes:end -->
`;

export const WORLD_PAGE_BODY = `# Launch review\n\n${PROSE}\n\n${FENCES}`;
