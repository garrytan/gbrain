---
status: accepted
---

# Concept labels follow the Исходный язык

The dream cycle used to ask for Concept labels as English kebab-case, so a
Russian transcript produced English Concept pages (`concepts/<label>`, title
taken from the label). We now write labels in the Исходный язык, the same
language as the page prose. The Slug grammar has accepted letters of every
script since ADR-0001, so a Cyrillic label is a valid Slug. The price: one
topic discussed in two languages lands on two Concept pages. We accept that
because a personal Brain's inputs are usually in one language, and a Concept
page whose title does not match its body defeats the point of the page.

## Considered Options

- **Labels in the Исходный язык** (chosen). Title, Slug and body all match the
  input, and the only change is the prompt plus the label check.
- **A stable English key with a Russian title and body.** Clustering would not
  split by language, but the title would need its own field, since today it is
  derived from the label, and a mixed-language group would still force a
  choice of page language.
- **Keep English labels, translate only the body.** The Slug and title would
  stay English, which meets only half the goal.

## Consequences

- A label is never an Entity or product name. A technical topic gets a
  descriptive label in the Исходный язык ("очереди-сообщений") even when the
  text uses the English term.
- Existing English Concept pages are neither renamed nor backfilled.
- If cross-language inputs ever appear, merging the two Concept pages is the
  job of a separate layer, in the manner of **Alias**. It does not bring the
  English key back.
