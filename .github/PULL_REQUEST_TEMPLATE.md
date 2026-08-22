<!-- Title format (IRON RULE): vMAJOR.MINOR.PATCH.MICRO <type>(<scope>): <summary> (#issue) -->

## What

<!-- One paragraph: the user-visible behavior change and the issue it fixes. -->

## Why

<!-- The failure mode this closes. Link the issue. -->

## Discrimination test (required for every fix — #3665)

<!--
A fix's test is only worth anything if it FAILS without the fix. Fill in the
one-line result of actually checking that. The helper does it in one command:

    bash scripts/check-test-discriminates.sh <test-file> <source-file> [...]

It reverts the source file(s) to the pre-fix state, runs the test file,
requires >=1 executed test to FAIL (a crash/missing-file non-zero exit does
not count — see the script's exit-code contract), restores, and prints the
line below for you. Tests that pass both ways are worse than no test: they
inflate reviewer confidence, cost CI time forever, and keep passing after a
future refactor breaks the behavior.

Delete this section ONLY for pure-docs / pure-refactor PRs with no behavior
change to pin.
-->

Discrimination test: reverted `<source file(s)>` to `<ref>`, ran `<test file>` → `N pass / M fail`. Restored → all pass.

## Verification

<!--
If any message/doc this PR adds tells the user to run a command to verify
something, paste the output of that verification against a system in the
BROKEN state (the #3697 class: remediation text that lies). Otherwise delete.
-->

## Tests

<!-- Test files touched/added, and the local run result (redirect to a file, check the exit code — never pipe through tail). -->
