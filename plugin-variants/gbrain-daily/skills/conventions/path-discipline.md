# Path Discipline Convention

A display string is not a path. Never pass a link-formatted reference to a file tool.

## The Two Types

Replies format paths for humans: markdown links, full URLs, backticks, bold.
Tools need bare filesystem paths. These are different types, and context blurs
them — a `[label](url)` rendered in one turn gets pattern-completed into the
path argument of the next tool call.

- Bare path (tool input): `people/alice-example.md`
- Display forms (reply output only): `[people/alice-example.md](https://github.com/acme-example/brain/blob/main/people/alice-example.md)`, the raw URL, any backticked or bolded wrapping of either

Before any read/write/edit/grep/shell call: the path argument must contain no
`[`, `](`, or `http`. If an error shows `https:/` with a single slash, path
normalization collapsed a URL — you passed a display string to a filesystem API.

## Writes Lie

Reads and shell calls fail loudly on a poisoned path (`ENOENT`, `Syntax error:
"(" unexpected`). Writes do not: the tool creates a junk directory literally
named after the link markup, nests the content inside, and reports
`Successfully wrote N bytes`. The file "lands" somewhere nobody will find it,
and the success message backs a false "done" claim.

So: a write success message is not evidence the file landed. If the path
argument contained link markup, treat the call as FAILED regardless of the
return. After any write that matters, `ls` the bare path before claiming done.

## Retry Discipline + Recovery

- A malformed argument is not a flaky tool. Retrying the identical string never
  works — fix the argument after the FIRST failure; don't reissue.
- If the transcript is saturated with linked path forms, stop emitting literal
  paths in tool arguments; build each path from shell variables
  (`D="$BASE/people/alice-example"; D="$D.md"`) so no complete path string
  appears in generated text for pattern-completion to corrupt.
- Content stranded by a lying write is intact inside the junk tree (a top-level
  directory whose name starts with `[`). Find it, copy it to the real
  destination, delete the junk.

## Anti-Patterns

- Copying a path out of your own formatted reply into a tool call
- Trusting `Successfully wrote N bytes` on a path that contained `](`
- Retrying the same poisoned string because the error "looks flaky"
- Claiming captured/committed/done without an `ls` of the bare path
