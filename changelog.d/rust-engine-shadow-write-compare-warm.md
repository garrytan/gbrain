**Shadow mode now compares page writes made on the warm single-write lane too.**

### Changed
- The persistence consumer lends a reserved connection's own transaction to single writes. A sampled page write in it was never sampled before. It now follows the same rules as a write in an ordinary transaction: the rows it touches are read after the transaction's first statement, in a savepoint that is rolled back, and the comparison runs after the commit. A first statement sent ahead of BEGIN's answer stays first. A write that is not alone on its transaction is counted uncomparable (`in_transaction_busy`), so the savepoint never rolls back another call's statements. A rolled-back transaction is never compared.
- The swap report's criterion 5 sentence no longer lists the warm single-write path among the write types that are not compared. Reads, follow and writer evidence for that lane are unchanged.
