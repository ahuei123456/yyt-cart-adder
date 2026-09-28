export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Cover both response headers and body reads, and always release the timer.
export async function withRequestDeadline(run, options = {}) {
  const controller = new AbortController();
  const parent = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let timer;
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", stop, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", stop);
  }
}

/** A response's HTTP status, or null when it has none. */
export function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status > 0 ? status : null;
}

export function responseOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  const status = responseStatus(response);
  return status !== null && status >= 200 && status < 300;
}

/** Resolve after `milliseconds`, or as soon as `signal` aborts. */
export function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Call a progress callback; a UI callback must never interrupt the caller. */
export function notify(callback, value) {
  if (typeof callback !== "function") return;
  try {
    callback(value);
  } catch {
    // Ignored on purpose.
  }
}
