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
    option: `Same ID in another rarity${also}; set a quantity to add`,
    partial: `Requested ${row.requestedQuantity}; adding ${row.plannedQuantity}`,
    "sold-out": `Card is sold out in ${cond} condition`,
    missing: row.reason === "PRODUCT_RARITY_MISSING" ? `No ${row.rarity} product for this ID` : "No exact card found",
    ambiguous: "Multiple exact products found; skipped",
    invalid: row.reason || "Invalid input",
  };
  return messages[row.status] || row.reason || row.status;
}

export function mountApp({ parse, resolve, getCsrfToken, addItem, mutationDelayMs = 750 }) {
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
  let addController = null;
  let cancelRequested = false;
  let adding = false;

  const setView = (...nodes) => body.replaceChildren(el("div", { className: "view" }, ...nodes));
  const close = () => {
    if (adding && !cancelRequested) cancelRequested = true;
    lookupController?.abort();
    backdrop.hidden = true;
    previousFocus?.focus?.();
  };
  const open = () => {
    previousFocus = document.activeElement;
    backdrop.hidden = false;
    showInput();
  };

  launcher.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab" && !backdrop.hidden) {
      const focusable = [...panel.querySelectorAll("button:not(:disabled), textarea, input:not(:disabled), a[href]")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  function showInput(saved = "", savedPref = "prefer-damaged") {
    adding = false;
    cancelRequested = false;
    const input = el("textarea", { id: "yyt-card-list", placeholder: "Kka/W102-005SEC 1\nKka/W102-006 2 damaged\nRZ/SE35-01 1 S-RR" });
    input.value = saved;
    const prefSelect = el("select", { id: "yyt-condition-preference", className: "select-pref" },
      el("option", { value: "prefer-damaged", text: "Prefer damaged, fall back to normal" }),
      el("option", { value: "prefer-normal", text: "Prefer normal, fall back to damaged" }),
      el("option", { value: "normal-only", text: "Normal condition only" }),
      el("option", { value: "damaged-only", text: "Damaged condition only" }),
    );
    prefSelect.value = savedPref;
    const errorBox = el("div", { className: "error", hidden: true });
    const resolveButton = el("button", { className: "primary", type: "button", text: "Resolve cards" });
    resolveButton.addEventListener("click", async () => {
      let parsed;
      try { parsed = parse(input.value); }
      catch (error) { errorBox.hidden = false; errorBox.textContent = error.message || "Could not parse input."; return; }
      if (!parsed.requests.length) {
        const errList = parsed.invalid || parsed.errors || [];
        errorBox.hidden = false;
        errorBox.textContent = errList.length ? errList.map((x) => `Line ${x.lineNumber}: ${x.reason || x.message}`).join("\n") : "Enter at least one card ID.";
        return;
      }
      await showResolving(parsed, input.value, prefSelect.value);
    });
    setView(
      el("p", { className: "warning", text: "Quantities below will be added to anything already in your cart." }),
      el("p", { className: "hint", text: "One exact printed card ID per line; quantity defaults to 1. Append 'damaged' (or 1) for damaged copies, and a rarity such as RR or S-RR when an ID is sold in more than one. Lines beginning with # are ignored." }),
      el("label", { for: "yyt-condition-preference", text: "Condition preference" }, prefSelect),
      el("label", { for: "yyt-card-list", text: "Card IDs and quantities" }, input),
      errorBox,
      el("div", { className: "actions" }, resolveButton),
    );
    input.focus();
  }

  async function showResolving(parsed, source, conditionPreference = "prefer-damaged") {
    lookupController = new AbortController();
    const message = el("p", { text: `Resolving ${parsed.requests.length} distinct card requests…` });
    const cancel = el("button", { type: "button", text: "Cancel", onClick: () => { lookupController.abort(); showInput(source, conditionPreference); } });
    setView(el("h3", { text: "Resolving" }), message, el("progress", { className: "progress" }), el("div", { className: "actions" }, cancel));
    try {
      const rows = await resolve(parsed.requests, {
        signal: lookupController.signal,
        conditionPreference,
        onProgress: (text) => { message.textContent = text; },
      });
      const invalidRows = (parsed.invalid || parsed.errors || []).map((item) => ({
        ...item,
        status: "invalid",
        requestedId: item.original || "—",
        requestedQuantity: 0,
        plannedQuantity: 0,
      }));
      showReview([...rows, ...invalidRows], source, conditionPreference);
    } catch (error) {
      if (error.name === "AbortError" || error.cause?.name === "AbortError") return;
      setView(el("h3", { text: "Lookup stopped" }), el("div", { className: "error", text: error.message || "Unable to resolve cards." }),
        el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) })));
    }
  }

  function showReview(rows, source, conditionPreference = "prefer-damaged") {
    const isRowSelectable = (r) => (r.status === "ready" || r.status === "partial" || r.status === "option") && (r.stock ?? r.availableStock ?? 0) > 0;
    for (const row of rows) {
      if (typeof row.selected !== "boolean") {
        row.selected = isRowSelectable(row) && row.plannedQuantity > 0;
      }
    }
    const tbody = el("tbody");
    const countText = el("strong");
    const totalText = el("span");
    const submit = el("button", { className: "primary", type: "button" });

    const update = () => {
      const chosen = rows.filter((r) => r.selected && r.plannedQuantity > 0);
      const totalCards = chosen.reduce((n, r) => n + r.plannedQuantity, 0);
      const normalCards = chosen.filter((r) => r.condition !== "damaged").reduce((n, r) => n + r.plannedQuantity, 0);
      const damagedCards = chosen.filter((r) => r.condition === "damaged").reduce((n, r) => n + r.plannedQuantity, 0);
      const total = chosen.reduce((n, r) => n + (r.priceYen || 0) * r.plannedQuantity, 0);

      let desc = `${chosen.length} product${chosen.length === 1 ? "" : "s"} / ${totalCards} card${totalCards === 1 ? "" : "s"}`;
      if (damagedCards > 0 && normalCards > 0) {
        desc += ` (${normalCards} normal, ${damagedCards} damaged)`;
      } else if (damagedCards > 0) {
        desc += ` (all ${damagedCards} damaged)`;
      }
      countText.textContent = desc;
      totalText.textContent = `Estimated selected total: ${yen.format(total)}`;
      submit.textContent = `Add ${totalCards} cards from ${chosen.length} products`;
      submit.disabled = !chosen.length;
    };

    for (const row of rows) {
      const stock = row.stock ?? row.availableStock ?? 0;
      const selectable = isRowSelectable(row);
      const checkbox = el("input", {
        type: "checkbox",
        "aria-label": `Select ${row.requestedId || row.printedId || "card"}`,
      });
      checkbox.checked = Boolean(row.selected && row.plannedQuantity > 0);
      checkbox.disabled = !selectable;

      let addingCell;
      if (selectable) {
        const qtyInput = el("input", {
          type: "number",
          className: "qty-input",
          min: 0,
          max: stock,
          value: String(row.plannedQuantity ?? 0),
          "aria-label": `Quantity for ${row.printedId || row.requestedId}`,
        });
        qtyInput.addEventListener("input", () => {
          let val = parseInt(qtyInput.value, 10);
          if (isNaN(val) || val < 0) val = 0;
          if (val > stock) val = stock;
          row.plannedQuantity = val;
          row.selected = val > 0;
          checkbox.checked = row.selected;
          update();
        });
        checkbox.addEventListener("change", () => {
          row.selected = checkbox.checked;
          if (row.selected && row.plannedQuantity === 0) {
            row.plannedQuantity = Math.min(row.requestedQuantity || 1, stock);
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

      tbody.append(
        el("tr", { className: row.status === "partial" ? "partial" : selectable ? "" : "unavailable" },
          el("td", {}, checkbox),
          el("td", { text: row.requestedId || row.originalIds?.[0] || "—" }),
          el("td", { text: row.printedId || "—" }),
          el("td", { text: row.rarity || "—" }),
          el("td", {}, condBadge),
          el("td", { text: row.name || "—" }),
          el("td", { className: "num", text: Number.isFinite(row.priceYen) ? yen.format(row.priceYen) : "—" }),
          el("td", { className: "num", text: String(row.requestedQuantity || "—") }),
          el("td", { className: "num", text: Number.isFinite(stock) ? String(stock) : "—" }),
          addingCell,
          el("td", { className: "status", text: statusReason(row) }),
        )
      );
    }

    const table = el("table", {},
      el("thead", {}, el("tr", {}, ...["Use", "Requested ID", "YYT ID", "Rarity", "Cond.", "Name", "Price", "Requested", "Stock", "Adding", "Status"].map((x) => el("th", { text: x })))), tbody);
    submit.addEventListener("click", async () => {
      if (adding) return;
      const chosen = rows.filter((r) => r.selected && r.plannedQuantity > 0);
      if (chosen.length) await runBatch(rows, chosen, source, conditionPreference);
    });
    update();
    setView(
      el("h3", { text: "Review matches & allocate quantities" }),
      el("p", { className: "warning", text: "Quantities will be added to the existing cart. Adjust quantities across conditions and rarities as desired." }),
      el("div", { className: "table-wrap" }, table),
      el("div", { className: "summary" }, countText, totalText),
      el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) }), submit),
    );
    submit.focus();
  }

  async function runBatch(allRows, chosen, source, conditionPreference) {
    adding = true;
    cancelRequested = false;
    addController = new AbortController();
    const results = [];
    const current = el("p", { text: "Preparing…" });
    const progress = el("progress", { className: "progress", max: chosen.length, value: 0 });
    const cancel = el("button", { className: "danger", type: "button", text: "Cancel before next item" });
    cancel.addEventListener("click", () => { cancelRequested = true; cancel.disabled = true; current.textContent = "Cancellation requested; finishing the current request…"; });
    setView(el("h3", { text: "Adding products one at a time" }), current, progress,
      el("p", { className: "hint", text: "Cancel affects only products not yet started. It cannot undo additions already completed." }), el("div", { className: "actions" }, cancel));

    let token;
    try { token = await getCsrfToken({ signal: addController.signal }); }
    catch (error) {
      adding = false;
      showResults(allRows, chosen, [{ outcome: "failed", message: error.message || "Could not obtain a CSRF token." }], source, conditionPreference);
      return;
    }
    for (let index = 0; index < chosen.length; index += 1) {
      const row = chosen[index];
      if (cancelRequested) {
        for (const pending of chosen.slice(index)) results.push({ row: pending, outcome: "skipped", message: "Cancelled before request" });
        break;
      }
      current.textContent = `Adding ${row.printedId}${row.rarity ? ` ${row.rarity}` : ""} (${index + 1} of ${chosen.length})…`;
      let result;
      try { result = await addItem(row, token, { signal: addController.signal }); }
      catch (error) { result = { outcome: "unknown", message: error.message || "Response was lost; inspect the cart before retrying." }; }
      results.push({ row, ...result });
      progress.value = index + 1;
      if (result.stopBatch || result.outcome === "unknown") {
        for (const pending of chosen.slice(index + 1)) results.push({ row: pending, outcome: "skipped", message: "Batch stopped before request" });
        break;
      }
      if (result.outcome === "success" && index < chosen.length - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, mutationDelayMs));
    }
    adding = false;
    showResults(allRows, chosen, results, source, conditionPreference);
  }

  function showResults(allRows, chosen, results, source, conditionPreference) {
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
        list.append(el("li", { text: `${result.row?.printedId || result.row?.requestedId || "Batch"}${cond}: ${result.message || key}` }));
      }
      return el("section", { className: "result-group" }, el("h3", { text: `${label} (${matches.length})` }), list);
    }).filter(Boolean);
    const hasUnknown = combined.some((r) => r.outcome === "unknown");
    const report = groups.flatMap(([key, label]) => combined.filter((r) => r.outcome === key).map((r) => {
      const cond = [r.row?.rarity, r.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
      return `${label}: ${r.row?.printedId || r.row?.requestedId || "Batch"}${cond} — ${r.message || key}`;
    })).join("\n");
    const copy = el("button", { type: "button", text: "Copy report", onClick: async (event) => {
      try { await navigator.clipboard.writeText(report); event.currentTarget.textContent = "Copied"; }
      catch { event.currentTarget.textContent = "Copy failed"; }
    } });
    setView(el("h3", { text: "Results" }),
      hasUnknown ? el("div", { className: "error", text: "A cart request has an unknown outcome. Do not retry it until you inspect the cart." }) : null,
      ...nodes,
      el("div", { className: "actions" },
        el("button", { type: "button", text: "Open cart", className: "primary", onClick: () => { location.href = "/cart/sell"; } }), copy,
        el("button", { type: "button", text: "Close", onClick: close })),
    );
  }

  return { open, close };
}
