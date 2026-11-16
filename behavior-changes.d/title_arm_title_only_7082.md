---
kind: fix
---
Local searches (the CLI and gbrain serve's local callers) now use the same title arm that remote callers already used: a page is a title hit only when its title holds the query's words. Before, a local search's title arm also matched and ranked the page's timeline, so a page whose timeline, but not its title, held the words could come back as a title hit, and a very common word made the title arm read every timeline that held it. Such a page is still found through keyword search, which searches timeline text, so on a normal search it stays in the results; it is missing only when the keyword step itself fails or times out. Remote callers' results do not change.
