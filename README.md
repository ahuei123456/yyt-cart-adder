# YYT Weiss Schwarz Cart Adder

A personal-use Tampermonkey userscript for resolving exact Weiss Schwarz printed card IDs on Yuyu-tei, reviewing current price and stock, and adding explicitly selected quantities to the existing sales cart.

The script is intentionally conservative: it accepts only exact matches, never substitutes different cards, never clears the cart, never retries an uncertain cart mutation, and never proceeds into checkout. Quantities mean **add this many more copies**; they are not final-cart targets.

## Install

1. Install Tampermonkey in a Chromium-based browser.
2. Open `dist/yyt-cart-adder.user.js` and install it in Tampermonkey.
3. Visit `https://yuyu-tei.jp` and select **Bulk add WS cards**.

No runtime dependencies, external scripts, analytics, or persistent storage are used.

## Input & Condition Selection

Enter one card per line. Quantity defaults to 1. An optional condition (`damaged` / `1` or `normal` / `0`) can be specified:

```text
Kka/W102-005SEC 1
Kka/W102-005SEC,1
Kka/W102-005SEC 2 damaged
Kka/W102-005SEC,1,damaged
Kka/W102-005SEC 1 1
Kka/W102-005SEC 1,damaged
Kka/W102-005SEC damaged
# comments and blank lines are ignored
```

### Condition

The **Condition for lines without one** setting on the input screen applies only to lines that don't name a condition:

- **Normal first, damaged if not enough stock** (default): fills from normal copies and takes the rest from damaged only if normal stock runs short.
- **Damaged first, normal if not enough stock**: the same, starting with damaged copies.
- **Normal only** / **Damaged only**: uses only that condition.

A condition on the line (`damaged`/`1` or `normal`/`0`) always overrides the setting. With a condition on the line or an "only" setting, nothing is taken automatically from the other condition. If the ID also has copies in the other condition, they appear in the review table at quantity 0 so you can take them there instead.

### Rarity

Some sets list two products under one printed ID. On RZ/SE35, for example, `RZ/SE35-01` is sold as both RR and the S-RR holo. You don't need to say which one you want:

- The quantity goes to the first rarity YYT lists that has stock (normally the base rarity).
- Every other rarity for that ID shows in the review table with quantity 0. Raise it there to add copies of that rarity instead of, or as well as, the first one.
- To choose up front, add the rarity in uppercase: `RZ/SE35-01 2 S-RR` or `RZ/SE35-01,1,damaged,RR`. Only that rarity is then matched.

Quantities must be integers from 1 through 99. Duplicate lines for the same card, condition and rarity are aggregated. Review every resolved line before adding it.

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
