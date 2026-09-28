# Changelog

Each version here is what Tampermonkey installs from `dist/`. CI requires an
entry for every version bump.

## 0.3.2

- Lines whose first token is not a card ID (`UnusualCard`, `W102-005`,
  `4 Kka/W102-005`) are reported as input errors instead of being searched for.
- Lookup and batch progress are announced to screen readers.
- The weekly site check also parses every card on two prefix pages and checks
  that an ID sold in two rarities still reads as two.
- Internal: shared request helpers, one row shape from lookup to UI, and the
  review totals and warnings moved into tested pure functions.

## 0.3.1

- A lost, timed-out, malformed or server-error response to a cart request is
  reported as an unknown outcome and stops the batch.
- Requests time out after 30 seconds, including reading the response body.
- The review never allows more than 99 copies of one product.

## 0.3.0

- Closing the dialog only hides it: the card list, review and a running batch
  are kept; only Cancel stops a batch.
- Rows for one product are added in a single request, and the review blocks
  adding more than YYT has in stock.

## 0.2.0

- A failed or unreadable search marks only its own cards as failed; other
  searches' results stay usable.
- Cancelling stops before the next cart item and never aborts one in flight.
- Auto-update from the committed `dist` file.

## 0.1.0

- First version: resolve exact Weiss Schwarz IDs on YYT, review price and
  stock, and add selected quantities to the cart.
