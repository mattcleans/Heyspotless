# Crew lead replacement

Office users need to resolve a client-declined lead without undoing teammates’ accepted work. Contractors need an exact offer they can decline; clients need a fresh decision for the actual replacement assignment.

Design pass one: use the existing system font, navy #245478, ocean #075e7b, ground #f6f9fb, white #ffffff, line #d6e2ea and sunshine #fae47a. Left-align labels, names and money; use tabular figures for pay. Keep the page to one column on phones with touch-sized actions and visible keyboard focus.

```text
Client declined this lead · work cannot start
Visit time · client price
Retained crew: names and accepted pay
Replacement [eligible cleaner]
[Review replacement]
  Old lead → proposed lead
  Contractor visit pay / employee hourly terms
  Other assignments stay intact
  [Send offer] or [Assign employee]
Waiting for cleaner → waiting for client → ready to start
```

Review against the brief: replacement affects one assignment only. No promotion of an existing teammate, new visit price, automatic charge, or inherited client approval. Employee scheduling uses hourly terms rather than the outgoing contractor’s fee. Network recovery must repeat the same reviewed action or show its saved receipt.

Design pass two: implement the review and receipt states in the existing visit components. Candidate names and pay are content, not decoration. Distinguish a pending offer from an assignment, and an assignment from approval to start. A stale review directs the office to review again; a lost response keeps the exact action available for retry. Validate the database outcome before showing success.
