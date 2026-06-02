---
title: "0=1 vs 0.9=1 Proof"
type: note
created: 2026-05-05
updated: 2026-05-05
source: chatgpt-export
conversation_id: 69fa6dcb-a4dc-83e8-9568-8627266beb17
message_count: 2
tags: [chatgpt, import]
---
# 0=1 vs 0.9=1 Proof

> Conversation ID: 69fa6dcb-a4dc-83e8-9568-8627266beb17
> Created: 2026-05-05T22:23:08Z
> Updated: 2026-05-05T22:23:54Z
> Messages: 2

---

## User

is the 0=1 proof the same as the .9=1 proof?

---

## Assistant

Mr. White, **no**.

**`0 = 1` proofs** are fake proofs. They always hide an invalid move, usually **dividing by zero**, taking an invalid square root step, or assuming the conclusion.

Example flaw:

\[
a=b
\]

Then:

\[
(a-b)(a+b)=b(a-b)
\]

Cancel \(a-b\):

\[
a+b=b
\]

The cancellation is illegal because \(a-b=0\). That is the trick.

**\(0.999\ldots = 1\)** is a valid statement in standard real-number arithmetic. The repeating decimal means an infinite sum:

\[
0.999\ldots = \frac{9}{10}+\frac{9}{100}+\frac{9}{1000}+\cdots
\]

That geometric series equals:

\[
\frac{9/10}{1-1/10}=\frac{9/10}{9/10}=1
\]

The common algebra proof is also valid:

\[
x=0.999\ldots
\]

\[
10x=9.999\ldots
\]

Subtract:

\[
10x-x=9.999\ldots-0.999\ldots
\]

\[
9x=9
\]

\[
x=1
\]

So:

\[
0.999\ldots=1
\]

Important distinction: **\(0.9 \neq 1\)**. Only **\(0.999\ldots\)** with infinitely many 9s equals 1.
