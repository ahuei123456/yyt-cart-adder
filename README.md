# YYT Weiss Schwarz Cart Adder

A personal-use Tampermonkey userscript for resolving exact Weiss Schwarz printed card IDs on Yuyu-tei, reviewing current price and stock, and adding explicitly selected quantities to the existing sales cart.

The script is intentionally conservative: it accepts only exact normal-condition matches, never substitutes cards, never clears the cart, never retries an uncertain cart mutation, and never proceeds into checkout. Quantities mean **add this many more copies**; they are not final-cart targets.

## Install

1. Install Tampermonkey in a Chromium-based browser.
2. Open `dist/yyt-cart-adder.user.js` and install it in Tampermonkey.
3. Visit `https://yuyu-tei.jp` and select **Bulk add WS cards**.

No runtime dependencies, external scripts, analytics, or persistent storage are used.

## Input

Enter one card per line. Quantity defaults to 1:

```text
Kka/W102-005SEC 1
Kka/W102-005SEC,1
Kka/W102-005SEC	1
Kka/W102-005SEC
# comments and blank lines are ignored
```

Quantities must be integers from 1 through 99. Duplicate IDs are combined case-insensitively. Review every resolved line before adding it.

## Development

```text
npm install
npm test
npm run build
```

Development dependencies are used only to build the single installable userscript. The committed `dist` file does not require a local build.

## Safety notes

- Search results and estimated totals reflect current lookup data; inventory is not reserved by placing it in the cart.
- Additions occur sequentially. Cancel stops before the next product and does not undo prior successes.
- A lost/aborted mutation response is reported as an unknown outcome and stops the batch. Inspect the cart before deciding whether to try that item again.
- The tool ends at `/cart/sell`; checkout, login, payment, delivery, and order submission remain entirely manual.

## Uninstall

Open the Tampermonkey dashboard and remove or disable **YYT Weiss Schwarz Cart Adder**. This does not alter the current YYT cart.
