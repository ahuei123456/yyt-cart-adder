# YYT Weiss Schwarz Cart Adder

A personal-use Tampermonkey userscript for resolving exact Weiss Schwarz printed card IDs on Yuyu-tei, reviewing current price and stock, and adding explicitly selected quantities to the existing sales cart.

The script is intentionally conservative: it accepts only exact matches, never substitutes different cards, never clears the cart, never retries an uncertain cart mutation, and never proceeds into checkout. Quantities mean **add this many more copies**; they are not final-cart targets.

## Install

1. Install Tampermonkey in a Chromium-based browser.
2. Open [the userscript](https://raw.githubusercontent.com/ahuei123456/yyt-cart-adder/master/dist/yyt-cart-adder.user.js) and install it in Tampermonkey. Tampermonkey checks the same URL for updates.
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

The first token on a line must be a printed card ID such as `Kka/W102-005SEC`; anything else is reported as an input error without being searched. Quantities must be integers from 1 through 99. Duplicate lines for the same card, condition and rarity are aggregated. Review every resolved line before adding it. Lines that end up on the same product are added in one request, and the review won't let their combined quantity exceed YYT's stock.

## Development

```text
npm install
npm run lint
npm test
npm run build
```

Development dependencies are used only to build the single installable userscript and to run tests (the UI tests use happy-dom). The committed `dist` file does not require a local build.

`dist` is committed because it is the install and update URL. Rebuild it with every source change; CI fails if it is out of date. To release, bump `version` in `package.json`, add a matching `## <version>` entry to [`CHANGELOG.md`](CHANGELOG.md), and rebuild. The build writes that version into the userscript header, and Tampermonkey only offers an update when it increases; CI fails if `dist` changes without a version bump, or if the changelog has no entry for the current version.

A weekly workflow (`scripts/site-check.mjs`, also runnable by hand) parses every card on two prefix pages, resolves a known card, checks that an ID sold in two rarities still reads as two, and loads a CSRF token on the live site, so a change to YYT's pages is caught before it breaks a real order. [`docs/MVP_HANDOFF.md`](docs/MVP_HANDOFF.md) holds the original research into YYT's pages and cart endpoint.

## Safety notes

- Search results and estimated totals reflect current lookup data; inventory is not reserved by placing it in the cart.
- If one of YYT's searches fails or returns a page the script can't read, only the cards from that search are marked **Search failed** and skipped. Everything else can still be reviewed and added.
- Additions occur sequentially. Cancel stops before the next product and does not undo prior successes. Closing the dialog only hides it: a batch keeps running, and reopening shows its progress or results. Your card list and review are kept too.
- Requests time out after 30 seconds, including response-body reads. Safe search requests may retry; cart additions never retry automatically.
- A lost, timed-out, malformed success response or server error from a cart mutation is reported as an unknown outcome and stops the batch. Inspect the cart before deciding whether to try that item again.
- The tool ends at `/cart/sell`; checkout, login, payment, delivery, and order submission remain entirely manual.

## Uninstall

Open the Tampermonkey dashboard and remove or disable **YYT Weiss Schwarz Cart Adder**. This does not alter the current YYT cart.
