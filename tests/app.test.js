import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

import { parseInput } from "../src/core/input.js";
import { mountApp } from "../src/ui/app.js";

/**
 * Install a fresh happy-dom window as the globals app.js uses, and remove it
 * afterwards.  Tests share one process (--test-isolation=none), so leaving
 * `document` behind would change how the cart and parser tests behave.
 */
function withDom(t) {
  const window = new Window({ url: "https://yuyu-tei.jp/top/ws" });
  const clipboard = { text: null, async writeText(text) { this.text = text; } };
  Object.defineProperty(window.navigator, "clipboard", { value: clipboard, configurable: true });
  const saved = {};
  for (const [name, value] of Object.entries({ document: window.document, navigator: window.navigator })) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(async () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await window.happyDOM.close();
  });
  return { window, clipboard };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0));
};

function readyRow(overrides = {}) {
  return {
    requestedId: "Kka/W102-005SEC",
    printedId: "Kka/W102-005SEC",
    rarity: "SEC",
    condition: "normal",
    name: "Test card",
    priceYen: 1200,
    requestedQuantity: 2,
    plannedQuantity: 2,
    stock: 5,
    status: "ready",
    selected: true,
    inputIndex: 0,
    product: { ver: "v", cid: "1", kizu: "0" },
    ...overrides,
  };
}

function mount(window, { resolve, addItems }) {
  const app = mountApp({
    parse: parseInput,
    resolve: resolve ?? (async () => [readyRow()]),
    addItems: addItems ?? (async (rows) => ({ results: rows.map(() => ({ outcome: "success", message: "Added" })) })),
  });
  const { root } = app;
  const button = (text) => [...root.querySelectorAll("button")].find((b) => b.textContent.startsWith(text));
  const heading = () => root.querySelector(".view h3")?.textContent ?? null;
  const pressKey = (key, init = {}) =>
    root.querySelector(".panel").dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, composed: true, ...init }));
  const resolveInput = async (text = "Kka/W102-005SEC 2") => {
    root.querySelector("#yyt-card-list").value = text;
    button("Resolve cards").click();
    await flush();
  };
  return { ...app, button, heading, pressKey, resolveInput, backdrop: root.querySelector(".backdrop") };
}

test("closing during a batch leaves it running, reopening shows its progress, then its results", async (t) => {
  const { window } = withDom(t);
  const batch = deferred();
  let batchOptions;
  const ui = mount(window, {
    addItems: (rows, options) => {
      batchOptions = options;
      return batch.promise;
    },
  });

  ui.button("Bulk add WS cards").click();
  await ui.resolveInput();
  ui.button("Add 2 cards").click();
  await flush();
  assert.equal(ui.heading(), "Adding products one at a time");

  ui.pressKey("Escape");
  assert.equal(ui.backdrop.hidden, true);
  assert.equal(batchOptions.cancelSignal.aborted, false, "closing must not cancel the batch");

  ui.button("Bulk add WS cards").click();
  assert.equal(ui.heading(), "Adding products one at a time", "reopening must not reset to the input view");

  ui.pressKey("Escape");
  batch.resolve({ results: [{ outcome: "success", message: "Added 2" }] });
  await flush();

  ui.button("Bulk add WS cards").click();
  assert.equal(ui.heading(), "Results");
  assert.match(ui.root.textContent, /Successfully added \(1\)/);

  // Once the results have been seen, the next open starts a fresh input.
  ui.pressKey("Escape");
  ui.button("Bulk add WS cards").click();
  assert.equal(ui.root.querySelector("#yyt-card-list").value, "");
});

test("closing and reopening keeps the typed list and the review", async (t) => {
  const { window } = withDom(t);
  const ui = mount(window, {});
  ui.button("Bulk add WS cards").click();
  ui.root.querySelector("#yyt-card-list").value = "Kka/W102-005SEC 2";
  ui.pressKey("Escape");
  ui.button("Bulk add WS cards").click();
  assert.equal(ui.root.querySelector("#yyt-card-list").value, "Kka/W102-005SEC 2");

  await ui.resolveInput();
  ui.pressKey("Escape");
  ui.button("Bulk add WS cards").click();
  assert.equal(ui.heading(), "Review matches & allocate quantities");
});

test("rows for the same product are added as one request and may not exceed its stock", async (t) => {
  const { window } = withDom(t);
  let sent;
  const ui = mount(window, {
    resolve: async () => [
      readyRow({ plannedQuantity: 3, requestedQuantity: 3 }),
      readyRow({ plannedQuantity: 3, requestedQuantity: 3, inputIndex: 1 }),
    ],
    addItems: async (items) => {
      sent = items;
      return { results: items.map(() => ({ outcome: "success", message: "Added" })) };
    },
  });
  ui.button("Bulk add WS cards").click();
  await ui.resolveInput("Kka/W102-005SEC 3\nKka/W102-005SEC 3 normal");

  assert.equal(ui.button("Add ").disabled, true, "6 copies of a product with 5 in stock");
  assert.match(ui.root.textContent, /More than YYT has in stock/);

  const quantity = ui.root.querySelectorAll(".qty-input")[1];
  quantity.value = "2";
  quantity.dispatchEvent(new window.Event("input"));
  assert.equal(ui.button("Add ").disabled, false);

  ui.button("Add ").click();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].plannedQuantity, 5);
});

test("Copy report writes the report and updates the button", async (t) => {
  const { window, clipboard } = withDom(t);
  const ui = mount(window, {});
  ui.button("Bulk add WS cards").click();
  await ui.resolveInput();
  ui.button("Add 2 cards").click();
  await flush();

  ui.button("Copy report").click();
  await flush();
  assert.equal(ui.button("Copied")?.textContent, "Copied");
  assert.match(clipboard.text, /^Successfully added: Kka\/W102-005SEC \[SEC\] \[normal\]/);
});

test("lookup progress is shown while resolving", async (t) => {
  const { window } = withDom(t);
  const lookup = deferred();
  const ui = mount(window, {
    resolve: async (_requests, options) => {
      options.onProgress({ type: "prefix", query: "Kka/W102", index: 0, total: 2 });
      await lookup.promise;
      return [readyRow()];
    },
  });
  ui.button("Bulk add WS cards").click();
  await ui.resolveInput();
  assert.match(ui.root.textContent, /Searching Kka\/W102 \(1 of 2\)…/);
  lookup.resolve();
  await flush();
  assert.equal(ui.heading(), "Review matches & allocate quantities");
});

test("a row whose search failed is shown but cannot be selected", async (t) => {
  const { window } = withDom(t);
  const ui = mount(window, {
    resolve: async () => [
      readyRow(),
      readyRow({
        requestedId: "SMP/W99-001R",
        printedId: null,
        status: "error",
        reason: "LOOKUP_HTTP",
        errorMessage: "YYT search returned HTTP 503",
        plannedQuantity: 0,
        selected: false,
        stock: 0,
        product: null,
        inputIndex: 1,
      }),
    ],
  });
  ui.button("Bulk add WS cards").click();
  await ui.resolveInput("Kka/W102-005SEC 2\nSMP/W99-001R");

  const rows = [...ui.root.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 2);
  assert.equal(rows[1].querySelector("input[type=checkbox]").disabled, true);
  assert.match(rows[1].textContent, /Search failed \(YYT search returned HTTP 503\)/);
  assert.equal(ui.button("Add ").textContent, "Add 2 cards from 1 product");
});

test("Tab and Shift+Tab wrap focus inside the dialog", async (t) => {
  const { window } = withDom(t);
  const ui = mount(window, {});
  ui.button("Bulk add WS cards").click();
  const first = ui.root.querySelector(".close");
  const last = ui.button("Resolve cards");

  last.focus();
  ui.pressKey("Tab");
  assert.equal(ui.root.activeElement, first);

  first.focus();
  ui.pressKey("Tab", { shiftKey: true });
  assert.equal(ui.root.activeElement, last);
});

test('review quantities stay synchronized and respect the cart limit', async (t) => {
  const { window } = withDom(t);
  let sent;
  const ui = mount(window, {
    resolve: async () => [readyRow({ stock: 200 })],
    addItems: async (items) => { sent = items; return { results: [] }; },
  });
  ui.open();
  await ui.resolveInput();
  const quantity = ui.root.querySelector('.qty-input');
  for (const [typed, expected] of [['1.5', '0'], ['-1', '0'], ['', '0'], ['150', '99']]) {
    quantity.value = typed;
    quantity.dispatchEvent(new window.Event('input'));
    assert.equal(quantity.value, expected);
    assert.equal(ui.button('Add ').disabled, expected === '0');
  }
  ui.button('Add ').click();
  await flush();
  assert.equal(sent[0].plannedQuantity, 99);
});

test('merged review rows cannot exceed 99 copies even with enough stock', async (t) => {
  const { window } = withDom(t);
  const ui = mount(window, {
    resolve: async () => [
      readyRow({ stock: 200, plannedQuantity: 60 }),
      readyRow({ stock: 200, plannedQuantity: 40, inputIndex: 1 }),
    ],
  });
  ui.open();
  await ui.resolveInput();
  assert.equal(ui.button('Add ').disabled, true);
  const quantity = ui.root.querySelectorAll('.qty-input')[1];
  quantity.value = '39';
  quantity.dispatchEvent(new window.Event('input'));
  assert.equal(ui.button('Add ').disabled, false);
});
