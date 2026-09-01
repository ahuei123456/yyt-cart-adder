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
  const messages = {
    ready: "Ready",
    partial: `Requested ${row.requestedQuantity}; adding ${row.plannedQuantity}`,
    "sold-out": "Exact normal-condition card is sold out",
    missing: "No exact card found",
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

  function showInput(saved = "") {
    adding = false;
    cancelRequested = false;
    const input = el("textarea", { id: "yyt-card-list", placeholder: "Kka/W102-005SEC 1\nKka/W102-006 2" });
    input.value = saved;
    const errorBox = el("div", { className: "error", hidden: true });
    const resolveButton = el("button", { className: "primary", type: "button", text: "Resolve cards" });
    resolveButton.addEventListener("click", async () => {
      let parsed;
      try { parsed = parse(input.value); }
      catch (error) { errorBox.hidden = false; errorBox.textContent = error.message || "Could not parse input."; return; }
      if (!parsed.requests.length) {
        errorBox.hidden = false;
        errorBox.textContent = parsed.invalid.length ? parsed.invalid.map((x) => `Line ${x.lineNumber}: ${x.reason}`).join("\n") : "Enter at least one card ID.";
        return;
      }
      await showResolving(parsed, input.value);
    });
    setView(
      el("p", { className: "warning", text: "Quantities below will be added to anything already in your cart." }),
      el("p", { className: "hint", text: "One exact printed card ID per line; quantity defaults to 1. Normal-condition cards only. Lines beginning with # are ignored." }),
      el("label", { for: "yyt-card-list", text: "Card IDs and quantities" }, input),
      errorBox,
      el("div", { className: "actions" }, resolveButton),
    );
    input.focus();
  }

  async function showResolving(parsed, source) {
    lookupController = new AbortController();
    const message = el("p", { text: `Resolving ${parsed.requests.length} distinct card IDs…` });
    const cancel = el("button", { type: "button", text: "Cancel", onClick: () => { lookupController.abort(); showInput(source); } });
    setView(el("h3", { text: "Resolving" }), message, el("progress", { className: "progress" }), el("div", { className: "actions" }, cancel));
    try {
      const rows = await resolve(parsed.requests, { signal: lookupController.signal, onProgress: (text) => { message.textContent = text; } });
      const invalidRows = parsed.invalid.map((item) => ({ ...item, status: "invalid", requestedId: item.original || "—", requestedQuantity: 0, plannedQuantity: 0 }));
      showReview([...rows, ...invalidRows], source);
    } catch (error) {
      if (error.name === "AbortError" || error.cause?.name === "AbortError") return;
      setView(el("h3", { text: "Lookup stopped" }), el("div", { className: "error", text: error.message || "Unable to resolve cards." }),
        el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source) })));
    }
  }

  function showReview(rows, source) {
    const selectable = rows.filter((r) => r.status === "ready" || r.status === "partial");
    for (const row of rows) row.selected = selectable.includes(row);
    const tbody = el("tbody");
    const countText = el("strong");
    const totalText = el("span");
    const submit = el("button", { className: "primary", type: "button" });

    const update = () => {
      const chosen = selectable.filter((r) => r.selected);
      const cards = chosen.reduce((n, r) => n + r.plannedQuantity, 0);
      const total = chosen.reduce((n, r) => n + (r.priceYen || 0) * r.plannedQuantity, 0);
      countText.textContent = `${chosen.length} distinct products / ${cards} cards`;
      totalText.textContent = `Estimated selected total: ${yen.format(total)}`;
      submit.textContent = `Add ${cards} cards from ${chosen.length} products`;
      submit.disabled = !chosen.length;
    };

    for (const row of rows) {
      const checkbox = el("input", { type: "checkbox", "aria-label": `Select ${row.requestedId || row.printedId || "card"}` });
      checkbox.checked = row.selected;
      checkbox.disabled = !selectable.includes(row);
      checkbox.addEventListener("change", () => { row.selected = checkbox.checked; update(); });
      tbody.append(el("tr", { className: row.status === "partial" ? "partial" : selectable.includes(row) ? "" : "unavailable" },
        el("td", {}, checkbox),
        el("td", { text: row.requestedId || row.originalIds?.[0] || "—" }),
        el("td", { text: row.printedId || "—" }),
        el("td", { text: row.name || "—" }),
        el("td", { className: "num", text: Number.isFinite(row.priceYen) ? yen.format(row.priceYen) : "—" }),
        el("td", { className: "num", text: String(row.requestedQuantity || "—") }),
        el("td", { className: "num", text: Number.isFinite(row.stock) ? String(row.stock) : "—" }),
        el("td", { className: "num", text: row.plannedQuantity ? String(row.plannedQuantity) : "—" }),
        el("td", { className: "status", text: statusReason(row) }),
      ));
    }
    const table = el("table", {},
      el("thead", {}, el("tr", {}, ...["Use", "Requested ID", "YYT ID", "Name", "Price", "Requested", "Stock", "Adding", "Status"].map((x) => el("th", { text: x })))), tbody);
    submit.addEventListener("click", async () => {
      if (adding) return;
      const chosen = selectable.filter((r) => r.selected);
      if (chosen.length) await runBatch(rows, chosen);
    });
    update();
    setView(
      el("h3", { text: "Review exact matches" }),
      el("p", { className: "warning", text: "Quantities will be added to the existing cart. Search data is an estimate and does not reserve inventory." }),
      el("div", { className: "table-wrap" }, table),
      el("div", { className: "summary" }, countText, totalText),
      el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source) }), submit),
    );
    submit.focus();
  }

  async function runBatch(allRows, chosen) {
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
      showResults(allRows, chosen, [{ outcome: "failed", message: error.message || "Could not obtain a CSRF token." }]);
      return;
    }
    for (let index = 0; index < chosen.length; index += 1) {
      const row = chosen[index];
      if (cancelRequested) {
        for (const pending of chosen.slice(index)) results.push({ row: pending, outcome: "skipped", message: "Cancelled before request" });
        break;
      }
      current.textContent = `Adding ${row.printedId} (${index + 1} of ${chosen.length})…`;
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
      for (const result of matches) list.append(el("li", { text: `${result.row?.printedId || result.row?.requestedId || "Batch"}: ${result.message || key}` }));
      return el("section", { className: "result-group" }, el("h3", { text: `${label} (${matches.length})` }), list);
    }).filter(Boolean);
    const hasUnknown = combined.some((r) => r.outcome === "unknown");
    const report = groups.flatMap(([key, label]) => combined.filter((r) => r.outcome === key).map((r) => `${label}: ${r.row?.printedId || r.row?.requestedId || "Batch"} — ${r.message || key}`)).join("\n");
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
