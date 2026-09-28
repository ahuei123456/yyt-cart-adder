import test from "node:test";
import assert from "node:assert/strict";

import {
  CART_ERROR_CODES,
  DEFAULT_CART_DELAY_MS,
  addCartItem,
  addCartItems,
  buildCartRequest,
  extractCsrfToken,
  extractCsrfTokenFromHtml,
  getCsrfToken,
} from "../src/core/cart.js";

function response(status, body, { ok = status >= 200 && status < 300 } = {}) {
  return {
    status,
    ok,
    text: async () => body,
  };
}

function product(overrides = {}) {
  return {
    printedId: "Kka/W102-005SEC",
    normalizedId: "kka/w102-005sec",
    name: "Test card",
    gid: "7",
    ver: "key2.0",
    cid: "10190",
    kizu: "0",
    stock: 5,
    limit: 5,
    priceYen: 12800,
    detailUrl: "/sell/ws/card/key2.0/10190",
    ...overrides,
  };
}

function requestCalls(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

test("extracts a CSRF token from the current document", () => {
  const documentRef = {
    querySelector(selector) {
      assert.equal(selector, 'meta[name="csrf-token"]');
      return { getAttribute: (name) => name === "content" ? "  token-123  " : null };
    },
  };

  assert.equal(extractCsrfToken(documentRef), "token-123");
});

test("gets a CSRF token from /top/ws when the current page has none", async () => {
  const { calls, fetchImpl } = requestCalls([
    response(200, '<meta name="csrf-token" content="fallback-token">'),
  ]);

  const token = await getCsrfToken({
    documentRef: { querySelector: () => null },
    fetch: fetchImpl,
  });

  assert.equal(token, "fallback-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/top/ws");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers.Accept, "text/html");
});

test("extractCsrfTokenFromHtml tolerates single quotes and attribute order", () => {
  assert.equal(
    extractCsrfTokenFromHtml("<meta content='html-token' name='csrf-token'>"),
    "html-token",
  );
});

test("builds the verified form-encoded POST contract", () => {
  const request = buildCartRequest(
    product(),
    3,
    "csrf-456",
    { now: () => new Date("2026-09-02T00:00:00.000Z") },
  );

  assert.equal(request.url, "/api/cart_order_edit");
  assert.equal(request.method, "POST");
  assert.equal(request.credentials, "same-origin");
  assert.equal(request.headers.Accept, "application/json, text/javascript, */*; q=0.01");
  assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(request.headers["X-CSRF-TOKEN"], "csrf-456");
  assert.equal(request.headers["X-Requested-With"], "XMLHttpRequest");

  const fields = new URLSearchParams(request.body);
  assert.deepEqual(Object.fromEntries(fields), {
    gid: "7",
    ver: "key2.0",
    cid: "10190",
    mode: "add",
    type: "sell",
    counter: "3",
    kizu: "0",
    time: "2026-09-02T00:00:00.000Z",
  });
});

test("caps a just-before-dispatch quantity to current stock and limit", () => {
  const request = buildCartRequest(product({ stock: 2, limit: 4 }), 4, "csrf", {
    now: new Date("2026-09-02T00:00:00.000Z"),
  });
  assert.equal(request.quantity, 2);
  assert.equal(new URLSearchParams(request.body).get("counter"), "2");
});

test("handles SUCCESS JSON even when the MIME type is text/html", async () => {
  const { calls, fetchImpl } = requestCalls([response(200, '{"status":"SUCCESS"}')]);
  const result = await addCartItem(product(), 1, { csrfToken: "csrf", fetch: fetchImpl });

  assert.equal(result.outcome, "success");
  assert.equal(result.attemptedQuantity, 1);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.message, "Added 1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/cart_order_edit");
  assert.equal(calls[0].init.body instanceof URLSearchParams, true);
  assert.equal(calls[0].init.body.get("counter"), "1");
  assert.equal(calls[0].init.body.get("kizu"), "0");
  assert.equal("quantity" in calls[0].init, false);
});

test("handles damaged card addition with kizu 1", async () => {
  const { calls, fetchImpl } = requestCalls([response(200, '{"status":"SUCCESS"}')]);
  const result = await addCartItem(product({ kizu: "1", condition: "damaged" }), 2, {
    csrfToken: "csrf",
    fetch: fetchImpl,
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.attemptedQuantity, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body.get("counter"), "2");
  assert.equal(calls[0].init.body.get("kizu"), "1");
});

test("treats invalid success-response JSON as an unknown outcome", async () => {
  const { fetchImpl } = requestCalls([response(200, "not-json")]);
  const result = await addCartItem(product(), 1, { csrfToken: "csrf", fetch: fetchImpl });

  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, CART_ERROR_CODES.CART_OUTCOME_UNKNOWN);
  assert.equal(result.stopBatch, true);
});

test("classifies auth and rate-limit responses as batch-stopping", async () => {
  for (const [status, code] of [
    [403, CART_ERROR_CODES.CART_AUTH],
    [419, CART_ERROR_CODES.CART_AUTH],
    [429, CART_ERROR_CODES.CART_RATE_LIMIT],
  ]) {
    const { fetchImpl } = requestCalls([response(status, '{"status":"ERROR"}', { ok: false })]);
    const result = await addCartItem(product(), 1, { csrfToken: "csrf", fetch: fetchImpl });
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, code);
    assert.equal(result.stopBatch, true);
  }
});

test("a definite item-specific rejection can continue", async () => {
  const { fetchImpl } = requestCalls([
    response(400, '{"status":"ERROR","message":"out of stock"}', { ok: false }),
  ]);
  const result = await addCartItem(product(), 1, { csrfToken: "csrf", fetch: fetchImpl });

  assert.equal(result.outcome, "failed");
  assert.equal(result.code, CART_ERROR_CODES.CART_REJECTED);
  assert.equal(result.stopBatch, false);
  assert.equal(result.message, "out of stock");
});

test("a fetch rejection is unknown and is never retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("connection lost");
  };
  const result = await addCartItem(product(), 1, { csrfToken: "csrf", fetch: fetchImpl });

  assert.equal(calls, 1);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.code, CART_ERROR_CODES.CART_OUTCOME_UNKNOWN);
  assert.match(result.message, /inspect \/cart\/sell/i);
});

test("batch mutation is sequential, applies the delay, and uses fresh timestamps", async () => {
  const { calls, fetchImpl } = requestCalls([
    response(200, '{"status":"SUCCESS"}'),
    response(200, '{"status":"SUCCESS"}'),
  ]);
  const delays = [];
  const result = await addCartItems([
    { product: product({ cid: "1" }), plannedQuantity: 1 },
    { product: product({ cid: "2" }), plannedQuantity: 2 },
  ], {
    csrfToken: "csrf",
    fetch: fetchImpl,
    now: (() => {
      let n = 0;
      return () => new Date(`2026-09-02T00:00:0${n++}.000Z`);
    })(),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((item) => item.outcome), ["success", "success"]);
  assert.deepEqual(delays, [DEFAULT_CART_DELAY_MS]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body.get("counter"), "1");
  assert.equal(calls[1].init.body.get("counter"), "2");
  assert.notEqual(calls[0].init.body.get("time"), calls[1].init.body.get("time"));
});

test("batch stops after an unknown outcome and never sends a later mutation", async () => {
  const { calls, fetchImpl } = requestCalls([
    new TypeError("connection lost"),
    response(200, '{"status":"SUCCESS"}'),
  ]);
  const result = await addCartItems([
    { product: product({ cid: "1" }), plannedQuantity: 1 },
    { product: product({ cid: "2" }), plannedQuantity: 1 },
  ], { csrfToken: "csrf", fetch: fetchImpl, delayMs: 0 });

  assert.equal(calls.length, 1);
  assert.deepEqual(result.results.map((item) => item.outcome), ["unknown", "skipped"]);
  assert.equal(result.stopped, true);
  assert.equal(result.stopCode, CART_ERROR_CODES.CART_OUTCOME_UNKNOWN);
});

test("batch cancellation skips future items without undoing a success", async () => {
  const { calls, fetchImpl } = requestCalls([
    response(200, '{"status":"SUCCESS"}'),
    response(200, '{"status":"SUCCESS"}'),
  ]);
  const controller = new AbortController();
  const result = await addCartItems([
    { product: product({ cid: "1" }), plannedQuantity: 1 },
    { product: product({ cid: "2" }), plannedQuantity: 1 },
  ], {
    csrfToken: "csrf",
    fetch: fetchImpl,
    delayMs: 0,
    cancelSignal: controller.signal,
    onProgress: ({ result: itemResult }) => {
      if (itemResult.outcome === "success") controller.abort();
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result.results.map((item) => item.outcome), ["success", "skipped"]);
  assert.equal(result.results[1].code, CART_ERROR_CODES.CANCELLED);
});

test("cancelSignal ends the delay between items and is never passed to fetch", async () => {
  const { calls, fetchImpl } = requestCalls([
    response(200, '{"status":"SUCCESS"}'),
    response(200, '{"status":"SUCCESS"}'),
  ]);
  const controller = new AbortController();
  const started = Date.now();
  const result = await addCartItems([
    { product: product({ cid: "1" }), plannedQuantity: 1 },
    { product: product({ cid: "2" }), plannedQuantity: 1 },
  ], {
    csrfToken: "csrf",
    fetch: fetchImpl,
    delayMs: 60_000,
    cancelSignal: controller.signal,
    // Cancel while the batch is waiting between the two items.
    onProgress: () => { setTimeout(() => controller.abort(), 0); },
  });

  assert.ok(Date.now() - started < 5_000);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.signal.aborted, false, "batch cancellation must not abort the request signal");
  assert.deepEqual(result.results.map((item) => item.outcome), ["success", "skipped"]);
  assert.equal(result.results[1].code, CART_ERROR_CODES.CANCELLED);
});

test("missing CSRF token prevents every cart mutation", async () => {
  const { calls } = requestCalls([]);
  const result = await addCartItems([
    { product: product(), plannedQuantity: 1 },
  ], {
    documentRef: { querySelector: () => null },
    fetch: async (...args) => {
      calls.push(args);
      return response(200, "<html>no token</html>");
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/top/ws");
  assert.equal(result.results[0].outcome, "skipped");
  assert.equal(result.results[0].code, CART_ERROR_CODES.CSRF_MISSING);
});

for (const [status, body] of [[200, '{}'], [200, 'null'], [200, '{"status":""}'], [200, '<html>error</html>'], [500, '{"status":"ERROR"}'], [503, 'unavailable']]) {
  test('uncertain cart response stops the batch: ' + status + ' ' + body, async () => {
    const { calls, fetchImpl } = requestCalls([response(status, body)]);
    const result = await addCartItems([
      { product: product(), plannedQuantity: 1 },
      { product: product({ cid: '2' }), plannedQuantity: 1 },
    ], { csrfToken: 'csrf', fetch: fetchImpl });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.results.map((r) => r.outcome), ['unknown', 'skipped']);
    assert.match(result.results[0].message, /inspect/);
  });
}

for (const phase of ['headers', 'body']) {
  test('cart timeout during ' + phase + ' stops without retrying', async () => {
    let calls = 0;
    let requestSignal;
    const result = await addCartItems([
      { product: product(), plannedQuantity: 1 },
      { product: product({ cid: '2' }), plannedQuantity: 1 },
    ], {
      csrfToken: 'csrf', timeoutMs: 10,
      fetch: async (_url, init) => {
        calls++;
        requestSignal = init.signal;
        if (phase === 'headers') return new Promise(() => {});
        return { status: 200, ok: true, text: () => new Promise(() => {}) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(result.results.map((r) => r.outcome), ['unknown', 'skipped']);
  });
}

test('CSRF body timeout prevents cart mutations', async () => {
  const urls = [];
  const result = await addCartItems([{ product: product(), plannedQuantity: 1 }], {
    documentRef: { querySelector: () => null }, timeoutMs: 10,
    fetch: async (url) => {
      urls.push(url);
      return { status: 200, ok: true, text: () => new Promise(() => {}) };
    },
  });
  assert.deepEqual(urls, ['/top/ws']);
  assert.equal(result.results[0].outcome, 'skipped');
  assert.equal(result.stopCode, CART_ERROR_CODES.CSRF_MISSING);
});
