# YYT Weiss Schwarz Cart Adder — MVP Handoff

> Historical: the original MVP plan, kept for its research into YYT's pages and
> cart endpoint. The script has since moved past it (it handles damaged copies
> and rarities, for example); the README describes current behavior.

Status: implementation-ready plan  
Research date: 2026-09-02 (Asia/Tokyo)  
Target: Tampermonkey userscript for `https://yuyu-tei.jp`

## 1. Objective

Build a personal-use Tampermonkey userscript that accepts a list of Weiss Schwarz printed card IDs and quantities, resolves each printed ID to YYT's internal product identifiers, presents a review screen, and adds the selected quantities to the user's existing YYT sales cart.

The MVP must be conservative: exact card matches only, normal-condition cards only, no silent substitutions, no automatic checkout, and no automatic retry of a cart mutation whose outcome is uncertain.

## 2. Confirmed live-site behavior

These findings were verified against the live site on 2026-09-02. Treat the APIs as private implementation details that may change.

### 2.1 Printed-ID lookup

YYT's global Weiss Schwarz sales search accepts printed card IDs and ID prefixes:

```text
GET https://yuyu-tei.jp/sell/ws/s/search?search_word=<URL-encoded query>
```

Verified exact query:

```text
https://yuyu-tei.jp/sell/ws/s/search?search_word=Kka%2FW102-005SEC
```

It returned exactly `Kka/W102-005SEC`, even though the product belongs to YYT's combined `key2.0` set page. This means the implementation must not maintain a set-code-to-page table.

Searching the shared prefix `Kka/W102` returned all 26 matching products in one response. The recommended lookup strategy is therefore:

1. Group input IDs by their prefix before the first `-`, for example `Kka/W102`.
2. Search once per distinct prefix.
3. Match returned products against requested IDs exactly.
4. For every requested ID not found in its prefix response, perform one exact-ID fallback search.

The fallback is required in case a prefix result is truncated, paginated, or an unusual card number cannot be grouped safely.

### 2.2 Product data exposed in search HTML

Each result is represented by a `.card-product` element. Within it, the current site exposes:

```text
.cart_gid       game ID
.cart_ver       YYT set/version slug
.cart_cid       YYT product/card ID
.cart_kizu      condition flag (0 = normal)
.cart_limit     amount currently addable
.cart_active    current stock before additions made on that page
.cart_add       amount added from that rendered page
```

The result also contains:

- Printed card ID in a bordered `<span>` and in the card image `alt` text.
- Card name in an `<h4>`.
- Price in a `<strong>`.
- Product detail URL shaped like `/sell/ws/card/<ver>/<cid>`.
- A `.sold-out` class and/or zero stock for unavailable items.

Verified mapping for the example at research time:

```text
printedId: Kka/W102-005SEC
gid:       7
ver:       key2.0
cid:       10190
kizu:      0
stock:     1
price:     12,800 JPY
```

Do not hard-code any of those values; always resolve them from current search HTML.

### 2.3 Live add-to-cart request

A real click on YYT's `カートへ` button was captured with Playwright. The current site uses a CSRF-protected `POST`:

```http
POST https://yuyu-tei.jp/api/cart_order_edit
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: application/json, text/javascript, */*; q=0.01
X-CSRF-TOKEN: <meta csrf token>
X-Requested-With: XMLHttpRequest
```

Verified request body:

```text
gid=7&ver=key2.0&cid=10190&mode=add&type=sell&counter=1&kizu=0&time=<ISO timestamp>
```

The `time` value was produced by `new Date().toISOString()`.

Verified response:

```http
HTTP 200
Content-Type: text/html; charset=UTF-8

{"status":"SUCCESS"}
```

Despite the response's `text/html` content type, the body is JSON. Read it as text and parse it with `JSON.parse`; do not rely on the MIME type.

The CSRF token is available from:

```js
document.querySelector('meta[name="csrf-token"]')?.content
```

The test product appeared in `/cart/sell` with quantity 1 and the expected price. The isolated test cart was then cleared and verified empty.

Important correction: an older public userscript used a `GET` request. That behavior is obsolete. The MVP must use the verified `POST` contract above.

### 2.4 Cart clearing (research cleanup only)

The site's empty-cart button used:

```http
POST /api/cart_service

mode=clear&status=sell
```

Do not expose or call this in the MVP. The cart adder must never clear an existing user cart.

## 3. MVP product decisions

### 3.1 Platform

Use a Tampermonkey userscript, not a standalone Chrome extension.

Suggested metadata:

```js
// ==UserScript==
// @name         YYT Weiss Schwarz Cart Adder
// @namespace    local.yyt-cart-adder
// @version      0.1.0
// @description  Resolve Weiss Schwarz card IDs and add reviewed quantities to a YYT cart.
// @match        https://yuyu-tei.jp/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
```

`@grant none` is deliberate. All requests are same-origin and should use the page's existing cookies and CSRF token. No credentials, cookies, or session identifiers may be read, displayed, logged, or stored explicitly.

### 3.2 Quantity semantics

Input quantities mean **add this many more copies**. They are not target final-cart quantities.

State this prominently in the review UI:

> Quantities below will be added to anything already in your cart.

Never clear or replace existing cart contents.

### 3.3 Condition policy

MVP supports normal-condition inventory only:

```text
kizu = 0
```

If normal stock is unavailable, mark the line unavailable. Do not look up or substitute damaged inventory. Damaged-card support is a post-MVP feature.

### 3.4 Matching policy

- Match printed IDs case-insensitively after trimming surrounding whitespace.
- Preserve and display the user's original spelling.
- Require equality of the complete printed ID, including rarity/suffix.
- Never use substring matching to select a product.
- Never substitute a base rarity, parallel rarity, reprint, or similarly numbered card.
- If more than one product has the same normalized printed ID, separate them by rarity (see below); if they cannot be separated, mark the ID `ambiguous` and skip it.
- Some sets (for example RZ/SE35) sell every ID as a base rarity and an `S-` holo parallel with the same printed ID. The requested quantity goes to the first listed rarity that can fill it; each other rarity appears as a zero-quantity `option` row to raise in review. A rarity typed in the input (`RZ/SE35-01 2 S-RR`) restricts matching to that rarity.

### 3.5 Stock policy

For each resolved card calculate:

```text
plannedQuantity = min(requestedQuantity, currentStock)
```

Review states:

- `ready`: stock satisfies the full request.
- `partial`: some stock is available but less than requested.
- `sold-out`: exact card exists but stock is zero.
- `missing`: no exact result after prefix and exact fallback searches.
- `ambiguous`: multiple exact results.
- `invalid`: malformed line or quantity.

Partial lines should be selected by default for their available quantity, but must be visually prominent, for example `Requested 4; adding 2`. Let the user uncheck any ready or partial row before submission.

Immediately before adding each item, use the resolved `cart_limit`/`cart_active` data as the maximum. The server remains authoritative; stock may change after lookup.

### 3.6 Checkout boundary

The script may add items and link to `/cart/sell`. It must not:

- Open or advance the checkout confirmation flow automatically.
- Submit address, payment, delivery, member-login, or order forms.
- Place an order.
- Reserve or claim that stock is reserved. YYT explicitly says cart insertion does not reserve inventory.

## 4. User experience

### 4.1 Launcher and panel

Inject a fixed `Bulk add WS cards` launcher on YYT pages. Use a Shadow DOM root so YYT's Bootstrap and global styles do not accidentally restyle the tool.

The panel should work on desktop and mobile and contain these views:

1. Input
2. Resolving
3. Review
4. Adding/progress
5. Results

Use real buttons, labels, a dialog heading, keyboard-focus management, and an obvious close/cancel action. Dynamic remote text must be inserted with `textContent`, never interpolated into `innerHTML`.

### 4.2 Accepted input

One card per line. Support these forms:

```text
Kka/W102-005SEC 1
Kka/W102-005SEC,1
Kka/W102-005SEC<TAB>1
Kka/W102-005SEC
```

A missing quantity defaults to 1. Ignore blank lines and lines whose first non-whitespace character is `#`.

Parsing requirements:

- Card ID must contain no whitespace and should contain `/` and `-`.
- Quantity must be an integer from 1 through 99.
- Reject extra non-separator tokens rather than guessing.
- Aggregate duplicate normalized IDs by summing quantities.
- If an aggregate exceeds 99, mark it invalid.
- Report line numbers for invalid input.

Do not attempt Deck Log, EncoreDeck, clipboard, or file-import integrations in the MVP.

### 4.3 Review table

Display, at minimum:

- Selection checkbox
- Requested printed ID
- Canonical printed ID from YYT
- Card name
- Unit price
- Requested quantity
- Available stock
- Planned quantity
- Status/reason

Show an estimated selected total, but label it as an estimate based on current search results. The review action should say exactly how many distinct products and total cards will be added.

Disable submission if no rows are selected or if the CSRF token cannot be obtained.

### 4.4 Progress and final results

Add products strictly one at a time. Show current item, completed count, and per-line status.

The cancel button stops before the next item; it cannot undo already successful additions.

Final result groups:

- Successfully added
- Skipped before submission
- Failed with a definite server response
- Unknown outcome (network interruption after request dispatch)

Offer these final actions:

- `Open cart` → `/cart/sell`
- `Copy report`
- `Close`

Do not offer a one-click `Retry all`. Retrying all can duplicate successful additions.

## 5. Technical architecture

### 5.1 Recommended repository layout

The repository is currently empty and is not initialized as Git. A reasonable structure is:

```text
README.md
package.json
scripts/
  build.mjs
src/
  metadata.txt
  main.js
  core/
    input.js
    lookup.js
    parser.js
    cart.js
    errors.js
  ui/
    app.js
    styles.js
dist/
  yyt-cart-adder.user.js
tests/
  input.test.js
  parser.test.js
  cart.test.js
  fixtures/
    search-exact.html
    search-prefix.html
    search-sold-out.html
```

Use vanilla JavaScript and browser APIs at runtime. A small build step with esbuild is acceptable to produce one installable userscript. Do not include runtime CDN dependencies or YYT's jQuery. Keep sanitized, minimal HTML fixtures rather than copying entire YYT pages or card images.

If adding dependencies, keep them development-only and document exact build/test commands. Commit or otherwise produce `dist/yyt-cart-adder.user.js` so installation does not require a local build.

### 5.2 Core data shapes

Suggested internal representations:

```js
// Parsed and aggregated user request
{
  originalIds: ["Kka/W102-005SEC"],
  normalizedId: "kka/w102-005sec",
  requestedQuantity: 1,
  sourceLines: [1]
}

// Resolved YYT product
{
  printedId: "Kka/W102-005SEC",
  normalizedId: "kka/w102-005sec",
  name: "小さな奇跡の物語 あゆ(サイン入り)",
  gid: "7",
  ver: "key2.0",
  cid: "10190",
  kizu: "0",
  stock: 1,
  limit: 1,
  priceYen: 12800,
  detailUrl: "/sell/ws/card/key2.0/10190"
}

// Per-item add result
{
  normalizedId: "kka/w102-005sec",
  attemptedQuantity: 1,
  outcome: "success", // success | failed | unknown | skipped
  message: "Added 1",
  responseStatus: 200
}
```

Keep all IDs as strings. Only quantities, stock, limits, and parsed yen amounts should become numbers.

### 5.3 Input normalization and grouping

Recommended normalization:

```js
function normalizePrintedId(value) {
  return value.trim().toLocaleLowerCase("en-US");
}
```

Do not remove punctuation or rarity suffixes.

For ordinary IDs, use the substring before the first `-` as the group query, for example `Kka/W102`. If there is no usable prefix, put that card directly into the exact-search fallback path.

### 5.4 Search request

Use same-origin `fetch`:

```js
const url = new URL("/sell/ws/s/search", location.origin);
url.searchParams.set("search_word", query);

const response = await fetch(url, {
  method: "GET",
  credentials: "same-origin",
  headers: { Accept: "text/html" },
  signal,
});
```

Parse with:

```js
const document = new DOMParser().parseFromString(html, "text/html");
```

Process prefix queries sequentially with a short delay (suggested 200–300 ms). Safe GET lookups may be retried up to two times for network errors, `429`, and `5xx`, with exponential backoff and `Retry-After` support.

### 5.5 Defensive product parsing

For each `.card-product`:

1. Require `.cart_gid`, `.cart_ver`, `.cart_cid`, and `.cart_kizu`.
2. Extract candidate printed ID from a descendant span matching a conservative Weiss ID shape; fall back to the leading token of `img.card[alt]`.
3. Extract integers from `.cart_active` and `.cart_limit`. Invalid numeric values make the candidate unusable.
4. Extract price by removing commas, spaces, and `円` from the relevant `<strong>`.
5. Resolve the detail URL from `a[href*="/sell/ws/card/"]`.
6. Treat `.sold-out`, zero `cart_active`, or zero `cart_limit` as unavailable.
7. Reject any result where `kizu !== "0"` in the MVP.

Do not rely on card list headings or rarity labels to establish identity. The complete printed ID is authoritative. The rarity (the token after the ID in the image alt, else the `… Card List` heading) is used only to separate products that already share an exact printed ID.

If the page returns HTTP 200 but required product structure is absent for every expected exact result, show a site-structure error rather than reporting every card as casually missing. This distinction will make site breakages diagnosable.

### 5.6 CSRF acquisition

First read the current page:

```js
document.querySelector('meta[name="csrf-token"]')?.content
```

If absent, perform a same-origin GET of `/top/ws`, parse its HTML, and extract the token. Keep the token only in memory. Never log it.

If the first cart request receives a definite CSRF/authentication failure, stop the batch. It is acceptable to refresh the token once before any later cart mutation, but do not automatically replay a mutation unless the server clearly rejected it before processing.

### 5.7 Cart request implementation

Construct a fresh body and timestamp for every item:

```js
const body = new URLSearchParams({
  gid: product.gid,
  ver: product.ver,
  cid: product.cid,
  mode: "add",
  type: "sell",
  counter: String(plannedQuantity),
  kizu: "0",
  time: new Date().toISOString(),
});

const response = await fetch("/api/cart_order_edit", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-CSRF-TOKEN": csrfToken,
    "X-Requested-With": "XMLHttpRequest",
  },
  body,
  signal,
});
```

Success requires both:

```text
response.ok === true
parsedBody.status === "SUCCESS"
```

Read the response via `await response.text()` and parse JSON manually. Keep a short, sanitized copy of an unexpected response for the on-screen report, but never include headers, cookies, CSRF tokens, or full HTML pages.

Wait approximately 750 ms between successful cart mutations. The exact delay should be a named constant.

### 5.8 Mutation retry rule

Cart POSTs require stricter behavior than GET lookups:

- Do not automatically retry a timed-out, aborted, disconnected, or otherwise ambiguous cart request. The server may have applied it even though the response was lost.
- Mark such a result `unknown`, stop the batch by default, and tell the user to inspect `/cart/sell`.
- A definite non-success JSON response can be marked `failed` and processing may continue only when it is clearly item-specific.
- Authentication, CSRF, rate-limit, or broad server failures should stop the batch.
- Never retry all prior lines after a partial batch.

This rule is necessary to prevent accidental duplicate additions.

## 6. Error taxonomy

Use stable internal codes so UI text and tests do not depend on arbitrary thrown strings:

```text
INPUT_INVALID
LOOKUP_NETWORK
LOOKUP_HTTP
LOOKUP_SITE_CHANGED
PRODUCT_MISSING
PRODUCT_AMBIGUOUS
PRODUCT_SOLD_OUT
PRODUCT_PARTIAL_STOCK
CSRF_MISSING
CART_REJECTED
CART_AUTH
CART_RATE_LIMIT
CART_SERVER
CART_RESPONSE_INVALID
CART_OUTCOME_UNKNOWN
CANCELLED
```

User messages should say what happened and what action is safe. For `CART_OUTCOME_UNKNOWN`, explicitly instruct the user not to retry until checking the cart.

## 7. Security and privacy requirements

- No analytics, telemetry, remote logging, or external APIs.
- No remote scripts, fonts, or styles.
- No storage of credentials, cookies, CSRF tokens, or cart contents.
- Do not expose secrets in console logging or copied reports.
- Use same-origin relative URLs and HTTPS only.
- Use `textContent` for all input-derived and YYT-derived display values.
- Validate every quantity immediately before constructing a request.
- Do not execute scripts from fetched HTML; `DOMParser` is for inert parsing only.
- Avoid persistent storage in MVP. A draft-saving feature can be added later with explicit UI.

## 8. Testing plan

### 8.1 Unit tests

At minimum cover:

#### Input parsing

- Space, comma, tab, and omitted-quantity forms.
- Blank lines and comments.
- Invalid zero, negative, decimal, nonnumeric, and over-99 quantities.
- Duplicate aggregation and source line tracking.
- Case-insensitive normalization without removing suffixes.

#### Lookup grouping

- Multiple cards sharing one prefix generate one prefix query.
- Different prefixes generate separate queries.
- Unusual/unparseable IDs go directly to exact fallback.
- Missing cards after prefix lookup generate exact fallback requests.

#### HTML parsing

- Exact available example fixture.
- Sold-out result.
- Partial stock.
- Multiple exact candidates become ambiguous.
- Missing required hidden fields are rejected.
- Malformed stock/price fields are handled.
- A wholesale selector/structure break becomes `LOOKUP_SITE_CHANGED`.

#### Cart request

- All verified form fields are present.
- `counter` is the planned quantity.
- `kizu` is always `0`.
- Timestamp is ISO formatted.
- Required headers are set.
- `{"status":"SUCCESS"}` succeeds despite `text/html` MIME type.
- Invalid JSON, non-success status, `403`, `419` if used, `429`, and `5xx` map correctly.
- Ambiguous network failure is not retried.

### 8.2 Manual browser tests

Use a fresh, isolated Playwright browser context or a disposable anonymous session. Do not run destructive cleanup against a user's existing cart.

Required manual scenarios:

1. Resolve `Kka/W102-005SEC` and confirm the canonical product data displayed by the tool matches YYT.
2. Resolve at least two IDs sharing a prefix and confirm only one prefix search is sent, plus exact fallbacks only if needed.
3. Resolve a nonexistent ID and confirm it cannot be selected.
4. Resolve a sold-out card and confirm it cannot be added.
5. Add one inexpensive/in-stock card in an isolated cart and verify:
   - one `POST /api/cart_order_edit` request,
   - correct form data and headers,
   - `{"status":"SUCCESS"}` handling,
   - item appears in `/cart/sell`.
6. Double-click the add button and confirm the batch starts only once.
7. Cancel between two items and confirm completed additions remain reported while later items are untouched.
8. Simulate an ambiguous network failure and confirm there is no automatic mutation retry.
9. Verify launcher/panel behavior at desktop and mobile viewport sizes.

Never advance beyond the cart page during testing.

## 9. Implementation milestones

### Milestone 1: project skeleton and pure core

- Add build/test tooling and metadata.
- Implement input parsing, normalization, aggregation, and prefix grouping.
- Add unit tests.

Exit condition: parsing and grouping tests pass; a single installable userscript can be built.

### Milestone 2: lookup and review

- Implement search fetching, retry/backoff, DOM parsing, exact matching, and exact fallback.
- Implement launcher, input view, resolving progress, and review table.
- Add sanitized fixtures and parser tests.

Exit condition: the userscript resolves real card lists without performing cart mutations and clearly reports ready/partial/missing/sold-out/ambiguous states.

### Milestone 3: cart mutation and result reporting

- Implement CSRF acquisition and verified POST request.
- Implement strict sequential processing, delays, cancellation, and unknown-outcome handling.
- Add final report and cart link.
- Add request/response unit tests.

Exit condition: one explicitly confirmed item can be added in an isolated live session and appears in the cart.

### Milestone 4: hardening and documentation

- Run all manual scenarios.
- Confirm responsive UI and keyboard usage.
- Document install, input formats, safety semantics, known limitations, and uninstall steps.
- Ensure the built userscript has no remote dependencies and no debug secrets/logging.

Exit condition: all acceptance criteria below are met.

## 10. MVP acceptance criteria

The MVP is complete only when all of the following are true:

- A user can install one `.user.js` file in Tampermonkey.
- The launcher appears on YYT without breaking native page behavior.
- The tool parses documented input formats and reports invalid lines.
- Duplicate IDs are aggregated deterministically.
- Lookups use grouped prefix searches with exact fallback.
- Only complete, exact printed-ID matches can be added.
- Normal condition is enforced and damaged products are never substituted.
- Review shows identity, name, price, requested amount, stock, planned amount, and status.
- Partial-stock behavior is explicit before submission.
- Cart additions use the verified CSRF-protected POST contract.
- Success is based on HTTP success plus `status === "SUCCESS"`.
- Cart mutations are sequential and protected from double submission.
- Ambiguous mutation outcomes are never automatically retried.
- The user can cancel future additions without any claim of rolling back completed ones.
- Existing cart contents are never cleared or replaced.
- The script never navigates through or submits checkout.
- No credentials, cookies, tokens, analytics, or remote dependencies are introduced.
- Unit tests pass and the documented isolated live smoke test passes.
- The final cart is left for manual user review.

## 11. Explicit non-goals for MVP

- Chrome Web Store extension packaging.
- Firefox/Safari support guarantees.
- Damaged-card inventory.
- Buying supplies, sealed products, or non-Weiss games.
- Deck-site integrations or remote list imports.
- Price caps, budgets, or price-change alerts.
- Automatic cart reconciliation or target-final-quantity mode.
- Persistent history/drafts.
- Automatic checkout, login, payment, or order placement.

## 12. Likely post-MVP work

After the MVP is stable, consider:

- A target-final-cart-quantity mode that safely parses existing cart quantities.
- Optional damaged-card selection.
- CSV/file import and Deck Log adapters.
- Price ceilings and total budget checks.
- Local draft/history storage with privacy controls.
- Selector health checks and versioned fixtures.
- Packaging the same core as a Manifest V3 extension if wider distribution becomes necessary.

## 13. Notes for the implementing agent

- Reconfirm the live add request once before finalizing; this is a private endpoint.
- Do not trust the older GET-based GreasyFork example.
- Do not call cart-clearing APIs while developing against a non-isolated browser profile.
- Keep lookup and cart mutation logic separate so most development and testing can run in dry-run mode.
- Prefer a correct, reviewable dry-run over silently adding a questionable match.
- If YYT's live structure materially differs from this handoff, stop mutations, document the new capture, and update fixtures and this contract before proceeding.
