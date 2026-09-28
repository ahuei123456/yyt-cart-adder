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
