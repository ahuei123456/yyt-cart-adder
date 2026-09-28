import { ERROR_CODES } from "../core/errors.js";
import { MAX_COPIES, isSelectable, mergeByProduct, summarizeReview } from "./review.js";
import { styles } from "./styles.js";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

function statusReason(row) {
  const cond = row.condition === "damaged" ? "damaged" : "normal";
  const also = row.otherRarities?.length ? ` (also sold as ${row.otherRarities.join(", ")})` : "";
  const messages = {
    ready: `Ready${also}`,
    option: row.reason === ERROR_CODES.PRODUCT_OTHER_CONDITION
      ? `${cond === "damaged" ? "Damaged" : "Normal"} copy; set a quantity to add`
      : row.reason === ERROR_CODES.PRODUCT_VARIANT
        ? `One of ${row.variantCount} versions of this ID (see name); requested ${row.requestedQuantity}, set quantities to add`
        : `Same ID in another rarity${also}; set a quantity to add`,
    partial: `Requested ${row.requestedQuantity}; adding ${row.plannedQuantity}`,
    "sold-out": `Card is sold out in ${cond} condition`,
    missing: row.reason === ERROR_CODES.PRODUCT_RARITY_MISSING
      ? `No ${row.rarity} product for this ID`
      : row.reason === ERROR_CODES.PRODUCT_CONDITION_MISSING
        ? `No ${cond} copy for this ID`
        : "No exact card found",
    error: row.reason === ERROR_CODES.LOOKUP_SITE_CHANGED
      ? "YYT's search page could not be read; skipped"
      : `Search failed (${row.errorMessage || row.reason}); skipped`,
    invalid: row.reason || "Invalid input",
  };
  return messages[row.status] || row.reason || row.status;
}

export function mountApp({ parse, resolve, addItems }) {
  const host = document.createElement("div");
  host.id = "yyt-cart-adder-host";
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  root.append(el("style", { text: styles }));

  const launcher = el("button", { className: "launcher", type: "button", text: "Bulk add WS cards" });
  const title = el("h2", { id: "yyt-bulk-title", text: "YYT Weiss Schwarz cart adder" });
  const closeButton = el("button", { className: "close", type: "button", text: "×", "aria-label": "Close" });
  const body = el("div", { className: "body" });
  const panel = el("section", { className: "panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "yyt-bulk-title" },
    el("header", { className: "header" }, title, closeButton), body);
  const backdrop = el("div", { className: "backdrop", hidden: true }, panel);
  root.append(launcher, backdrop);

  let previousFocus = null;
  let lookupController = null;
  let adding = false;
  let showingResults = false;
  // A batch that finishes while the dialog is closed leaves its results in
  // place for the next open instead of being replaced by a blank input view.
  let resultsUnseen = false;

  const setView = (...nodes) => {
    showingResults = false;
    body.replaceChildren(el("div", { className: "view" }, ...nodes));
  };
  // Closing only hides the dialog: a running batch carries on (its Cancel
  // button is the one way to stop it) and the input or review is kept.
  const close = () => {
    lookupController?.abort();
    backdrop.hidden = true;
    previousFocus?.focus?.();
  };
  const open = () => {
    previousFocus = document.activeElement;
    backdrop.hidden = false;
    if (!body.firstChild || (showingResults && !resultsUnseen)) showInput();
    else body.querySelector("textarea, button.primary")?.focus();
    resultsUnseen = false;
  };

  launcher.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab" && !backdrop.hidden) {
      const focusable = [...panel.querySelectorAll("button:not(:disabled), textarea, select:not(:disabled), input:not(:disabled), a[href]")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  function showInput(saved = "", savedPref = "prefer-normal") {
    const input = el("textarea", { id: "yyt-card-list", placeholder: "Kka/W102-005SEC 1\nKka/W102-006 2 damaged\nRZ/SE35-01 1 S-RR" });
    input.value = saved;
    const prefSelect = el("select", { id: "yyt-condition-preference", className: "select-pref" },
      el("option", { value: "prefer-normal", text: "Normal first, damaged if not enough stock" }),
      el("option", { value: "prefer-damaged", text: "Damaged first, normal if not enough stock" }),
      el("option", { value: "normal-only", text: "Normal only" }),
      el("option", { value: "damaged-only", text: "Damaged only" }),
    );
    prefSelect.value = savedPref;
    const errorBox = el("div", { className: "error", hidden: true });
    const resolveButton = el("button", { className: "primary", type: "button", text: "Resolve cards" });
    resolveButton.addEventListener("click", async () => {
      let parsed;
      try { parsed = parse(input.value); }
      catch (error) { errorBox.hidden = false; errorBox.textContent = error.message || "Could not parse input."; return; }
      if (!parsed.requests.length) {
        const errList = parsed.errors;
        errorBox.hidden = false;
        errorBox.textContent = errList.length ? errList.map((x) => `Line ${x.lineNumber}: ${x.reason || x.message}`).join("\n") : "Enter at least one card ID.";
        return;
      }
      await showResolving(parsed, input.value, prefSelect.value);
    });
    setView(
      el("p", { className: "warning", text: "Quantities below will be added to anything already in your cart." }),
      el("p", { className: "hint", text: "One exact printed card ID per line; quantity defaults to 1. Append 'damaged'/1 or 'normal'/0 to fix a line's condition (this overrides the setting above), and a rarity such as RR, S-RR or SR** (for SR★★) when an ID is sold in more than one. Lines beginning with # are ignored." }),
      el("label", { for: "yyt-condition-preference", text: "Condition for lines without one" }, prefSelect),
      el("label", { for: "yyt-card-list", text: "Card IDs and quantities" }, input),
      errorBox,
      el("div", { className: "actions" }, resolveButton),
    );
    input.focus();
  }

  async function showResolving(parsed, source, conditionPreference = "prefer-normal") {
    lookupController = new AbortController();
    const message = el("p", { role: "status", text: `Resolving ${parsed.requests.length} distinct card requests…` });
    const cancel = el("button", { type: "button", text: "Cancel", onClick: () => lookupController.abort() });
    setView(el("h3", { text: "Resolving" }), message, el("progress", { className: "progress" }), el("div", { className: "actions" }, cancel));
    const { signal } = lookupController;
    try {
      const rows = await resolve(parsed.requests, {
        signal,
        conditionPreference,
        onProgress: ({ type, query, condition, index, total }) => {
          const copies = condition === "damaged" ? " damaged copies" : "";
          message.textContent = type === "exact"
            ? `Searching individually for ${query}${copies} (${index + 1} of ${total})…`
            : `Searching ${query}${copies} (${index + 1} of ${total})…`;
        },
      });
      const invalidRows = parsed.errors.map((item) => ({
        ...item,
        status: "invalid",
        originalId: item.original || "—",
        requestedQuantity: 0,
        plannedQuantity: 0,
      }));
      if (signal.aborted) showInput(source, conditionPreference);
      else showReview([...rows, ...invalidRows], source, conditionPreference);
    } catch (error) {
      // Cancel and closing the dialog both abort; go back to the input.
      if (signal.aborted) return showInput(source, conditionPreference);
      setView(el("h3", { text: "Lookup stopped" }), el("div", { className: "error", text: error.message || "Unable to resolve cards." }),
        el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) })));
    }
  }

  function showReview(rows, source, conditionPreference = "prefer-normal") {
    for (const row of rows) {
      if (typeof row.selected !== "boolean") {
        row.selected = isSelectable(row) && row.plannedQuantity > 0;
      }
    }
    const tbody = el("tbody");
    const countText = el("strong");
    const overWarning = el("div", { className: "warning", hidden: true });
    const rowElements = new Map();
    const totalText = el("span");
    const submit = el("button", { className: "primary", type: "button" });

    const update = () => {
      const summary = summarizeReview(rows);
      const { totalCards, normalCards, damagedCards, productCount } = summary;
      let desc = `${productCount} product${productCount === 1 ? "" : "s"} / ${totalCards} card${totalCards === 1 ? "" : "s"}`;
      if (damagedCards > 0 && normalCards > 0) {
        desc += ` (${normalCards} normal, ${damagedCards} damaged)`;
      } else if (damagedCards > 0) {
        desc += ` (all ${damagedCards} damaged)`;
      }
      countText.textContent = desc;

      for (const tr of rowElements.values()) tr.classList.remove("over");
      for (const group of [...summary.overRequested, ...summary.overStock]) {
        for (const r of group.rows) rowElements.get(r)?.classList.add("over");
      }
      const over = summary.overRequested.map(({ rows: [first], adding, requested }) =>
        `${first.originalId}: adding ${adding}, requested ${requested}`);
      const overStock = summary.overStock.map(({ rows: [first], adding, max }) =>
        `${first.printedId} (${first.condition}): adding ${adding} across lines, maximum ${max} allowed`);
      const messages = [
        over.length ? `More copies than requested:\n${over.join("\n")}` : "",
        overStock.length ? `More than YYT has in stock or the 99-copy limit; lower a quantity to continue:\n${overStock.join("\n")}` : "",
      ].filter(Boolean);
      overWarning.hidden = !messages.length;
      overWarning.textContent = messages.join("\n\n");
      totalText.textContent = `Estimated selected total: ${yen.format(summary.totalYen)}`;
      submit.textContent = `Add ${totalCards} card${totalCards === 1 ? "" : "s"} from ${productCount} product${productCount === 1 ? "" : "s"}`;
      submit.disabled = !summary.chosen.length || overStock.length > 0;
    };

    for (const row of rows) {
      const stock = row.stock ?? 0;
      const quantityLimit = Math.min(stock, MAX_COPIES);
      const selectable = isSelectable(row);
      const checkbox = el("input", {
        type: "checkbox",
        "aria-label": `Select ${row.originalId || row.printedId || "card"}`,
      });
      checkbox.checked = Boolean(row.selected && row.plannedQuantity > 0);
      checkbox.disabled = !selectable;

      let addingCell;
      if (selectable) {
        const qtyInput = el("input", {
          type: "number",
          className: "qty-input",
          min: 0,
          max: quantityLimit,
          value: String(row.plannedQuantity ?? 0),
          "aria-label": `Quantity for ${row.printedId || row.originalId}`,
        });
        qtyInput.addEventListener("input", () => {
          let val = Number(qtyInput.value);
          if (!Number.isSafeInteger(val) || val < 0) val = 0;
          if (val > quantityLimit) val = quantityLimit;
          qtyInput.value = String(val);
          row.plannedQuantity = val;
          row.selected = val > 0;
          checkbox.checked = row.selected;
          update();
        });
        checkbox.addEventListener("change", () => {
          row.selected = checkbox.checked;
          if (row.selected && row.plannedQuantity === 0) {
            row.plannedQuantity = Math.min(row.requestedQuantity || 1, quantityLimit);
            qtyInput.value = String(row.plannedQuantity);
          } else if (!row.selected) {
            row.plannedQuantity = 0;
            qtyInput.value = "0";
          }
          update();
        });
        addingCell = el("td", { className: "num" }, qtyInput);
      } else {
        checkbox.addEventListener("change", () => {
          row.selected = checkbox.checked;
          update();
        });
        addingCell = el("td", { className: "num", text: "0" });
      }

      const condBadge = row.condition
        ? el("span", {
            className: `badge badge-${row.condition}`,
            text: row.condition === "damaged" ? "Damaged" : "Normal",
          })
        : el("span", { text: "—" });

      const isOption = row.status === "option";
      const tr = el("tr", { className: [row.status === "partial" ? "partial" : selectable ? "" : "unavailable", isOption ? "alt" : ""].filter(Boolean).join(" ") },
        el("td", {}, checkbox),
        el("td", { text: row.originalId || "—" }),
        el("td", { text: row.printedId || "—" }),
        el("td", { className: "rarity", text: row.rarity ? `${isOption ? "↳ " : ""}${row.rarity}` : "—" }),
        el("td", {}, condBadge),
        el("td", { text: row.name || "—" }),
        el("td", { className: "num", text: Number.isFinite(row.priceYen) ? yen.format(row.priceYen) : "—" }),
        // The requested quantity belongs to the primary row; repeating it on
        // another-rarity rows would read as a second request.
        el("td", { className: "num", text: isOption ? "—" : String(row.requestedQuantity || "—") }),
        el("td", { className: "num", text: Number.isFinite(stock) ? String(stock) : "—" }),
        addingCell,
        el("td", { className: "status", text: statusReason(row) }),
      );
      rowElements.set(row, tr);
      tbody.append(tr);
    }

    const table = el("table", {},
      el("thead", {}, el("tr", {}, ...["Use", "Requested ID", "YYT ID", "Rarity", "Cond.", "Name", "Price", "Requested", "Stock", "Adding", "Status"].map((x) => el("th", { text: x })))), tbody);
    submit.addEventListener("click", async () => {
      if (adding) return;
      const { chosen } = summarizeReview(rows);
      if (chosen.length) await runBatch(rows, chosen);
    });
    update();
    setView(
      el("h3", { text: "Review matches & allocate quantities" }),
      el("p", { className: "warning", text: "Quantities will be added to the existing cart. Adjust quantities across conditions and rarities as desired." }),
      el("div", { className: "table-wrap" }, table),
      overWarning,
      el("div", { className: "summary" }, countText, totalText),
      el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) }), submit),
    );
    submit.focus();
  }

  async function runBatch(allRows, chosen) {
    adding = true;
    // Lines that resolve to the same product go to the cart as one request.
    const items = mergeByProduct(chosen);
    const cancelController = new AbortController();
    const describe = (row, index) =>
      `Adding ${row.printedId}${row.rarity ? ` ${row.rarity}` : ""} (${index + 1} of ${items.length})…`;
    const current = el("p", { role: "status", text: describe(items[0], 0) });
    const progress = el("progress", { className: "progress", max: items.length, value: 0 });
    const cancel = el("button", { className: "danger", type: "button", text: "Cancel before next item", onClick: () => {
      cancelController.abort();
      cancel.disabled = true;
      current.textContent = "Cancellation requested; finishing the current request…";
    } });
    setView(el("h3", { text: "Adding products one at a time" }), current, progress,
      el("p", { className: "hint", text: "Cancel affects only products not yet started. It cannot undo additions already completed." }), el("div", { className: "actions" }, cancel));

    let results;
    try {
      const batch = await addItems(items, {
        cancelSignal: cancelController.signal,
        onProgress: ({ completedCount }) => {
          progress.value = completedCount;
          if (!cancelController.signal.aborted && completedCount < items.length) {
            current.textContent = describe(items[completedCount], completedCount);
          }
        },
      });
      results = batch.results.map((result, index) => ({ row: items[index], ...result }));
    } catch (error) {
      // addItems reports every per-item outcome itself; a throw means the
      // batch runner failed and it is not known what reached the cart.
      results = [{ outcome: "unknown", message: error.message || "The batch stopped unexpectedly; inspect the cart before retrying." }];
    }
    adding = false;
    if (backdrop.hidden) resultsUnseen = true;
    showResults(allRows, chosen, results);
  }

  function showResults(allRows, chosen, results) {
    const selected = new Set(chosen);
    const skippedReview = allRows.filter((r) => !selected.has(r)).map((row) => ({ row, outcome: "skipped", message: statusReason(row) }));
    const combined = [...results, ...skippedReview];
    const groups = [
      ["success", "Successfully added"], ["skipped", "Skipped before submission"], ["failed", "Failed with a definite response"], ["unknown", "Unknown outcome"],
    ];
    const nodes = groups.map(([key, label]) => {
      const matches = combined.filter((r) => r.outcome === key);
      if (!matches.length) return null;
      const list = el("ul");
      for (const result of matches) {
        const cond = [result.row?.rarity, result.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
        list.append(el("li", { text: `${result.row?.printedId || result.row?.originalId || "Batch"}${cond}: ${result.message || key}` }));
      }
      return el("section", { className: "result-group" }, el("h3", { text: `${label} (${matches.length})` }), list);
    }).filter(Boolean);
    const hasUnknown = combined.some((r) => r.outcome === "unknown");
    const report = groups.flatMap(([key, label]) => combined.filter((r) => r.outcome === key).map((r) => {
      const cond = [r.row?.rarity, r.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
      return `${label}: ${r.row?.printedId || r.row?.originalId || "Batch"}${cond} — ${r.message || key}`;
    })).join("\n");
    // Refer to the button directly: event.currentTarget is null once the
    // handler resumes after the clipboard await.
    const copy = el("button", { type: "button", text: "Copy report", onClick: async () => {
      try { await navigator.clipboard.writeText(report); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
    } });
    setView(el("h3", { text: "Results" }),
      hasUnknown ? el("div", { className: "error", text: "A cart request has an unknown outcome. Do not retry it until you inspect the cart." }) : null,
      ...nodes,
      el("div", { className: "actions" },
        el("button", { type: "button", text: "Open cart", className: "primary", onClick: () => { location.href = "/cart/sell"; } }), copy,
        el("button", { type: "button", text: "Close", onClick: close })),
    );
    showingResults = true;
  }

  // `root` is returned for tests; the shadow root is closed to page scripts.
  return { open, close, root };
}
