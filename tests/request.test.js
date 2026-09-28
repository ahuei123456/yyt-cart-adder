import test from "node:test";
import assert from "node:assert/strict";

import { notify, responseOk, responseStatus, wait, withRequestDeadline } from "../src/core/request.js";

/** An AbortSignal stand-in that counts its abort listeners. */
function trackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { listeners += 1; add(...args); };
  signal.removeEventListener = (...args) => { listeners -= 1; remove(...args); };
  return { controller, signal, listeners: () => listeners };
}

test("withRequestDeadline returns the result and releases the parent signal", async () => {
  const parent = trackedSignal();
  let inner;
  const value = await withRequestDeadline(async (signal) => {
    inner = signal;
    return "done";
  }, { signal: parent.signal, timeoutMs: 1_000 });
  assert.equal(value, "done");
  assert.equal(inner.aborted, false);
  assert.equal(parent.listeners(), 0);
});

test("withRequestDeadline times out even when the work ignores its signal", async () => {
  let inner;
  const started = Date.now();
  await assert.rejects(
    withRequestDeadline((signal) => {
      inner = signal;
      return new Promise(() => {});
    }, { timeoutMs: 10 }),
    (error) => error.name === "TimeoutError",
  );
  assert.equal(inner.aborted, true);
  assert.ok(Date.now() - started < 1_000);
});

test("withRequestDeadline passes a parent abort and its reason through", async () => {
  const parent = trackedSignal();
  const reason = new DOMException("stop", "AbortError");
  let inner;
  const run = withRequestDeadline((signal) => {
    inner = signal;
    return new Promise(() => {});
  }, { signal: parent.signal, timeoutMs: 60_000 });
  parent.controller.abort(reason);
  await assert.rejects(run, (error) => error === reason);
  assert.equal(inner.aborted, true);
  assert.equal(parent.listeners(), 0);
});

test("withRequestDeadline does not start work for an already aborted signal", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));
  let started = false;
  await assert.rejects(
    withRequestDeadline(async () => { started = true; }, { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(started, false);
});

test("withRequestDeadline rethrows the work's own error", async () => {
  const failure = new TypeError("connection lost");
  await assert.rejects(withRequestDeadline(async () => { throw failure; }), (error) => error === failure);
});

test("responseStatus and responseOk read real and partial responses", () => {
  assert.equal(responseStatus({ status: 404 }), 404);
  assert.equal(responseStatus({}), null);
  assert.equal(responseOk({ ok: false, status: 200 }), false);
  assert.equal(responseOk({ status: 204 }), true);
  assert.equal(responseOk({ status: 302 }), false);
  assert.equal(responseOk({}), false);
});

test("wait ends early when its signal aborts", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = wait(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1_000);
  await wait(60_000, controller.signal);
});

test("notify swallows callback errors and ignores a missing callback", () => {
  const seen = [];
  notify((value) => { seen.push(value); throw new Error("ignored"); }, 1);
  notify(undefined, 2);
  assert.deepEqual(seen, [1]);
});
