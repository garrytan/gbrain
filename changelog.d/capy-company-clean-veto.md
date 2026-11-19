**Two companies that share a LinkedIn page and a name but list different domains are no longer joined by a bulk confirm.**

### Fixed
- `gbrain dedupe --preview` no longer marks a pair `clean` when two of its pages list different domains, so a US company and its UK namesake on one group LinkedIn page wait on the confirm list instead of being joined by `gbrain dedupe confirm --clean`.
- A run of single letters in a company name now folds as one word, so "Iselwood, L.L.C." and "Iselwood LLC" are found as the same company.
- On a brain whose default source has a repository, `gbrain dedupe confirm` and `reject` no longer refuse every cross-source group as `restricted_page` while the brain holds an owner-only source; a group is refused only when one of its own pages is owner-only or restricted.
- `gbrain dedupe reject` and the related messages say "different people or companies" instead of "different people".
