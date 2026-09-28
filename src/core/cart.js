/**
 * Cart mutation primitives for the YYT Weiss Schwarz cart adder.
 *
 * This module deliberately keeps lookup and UI concerns out of the cart
 * implementation.  All network calls use same-origin `fetch`, and the
 * fetch implementation is injectable so the mutation contract can be tested
 * without a browser or a live cart.
 */

import { ERROR_CODES, YytError } from "./errors.js";

export { ERROR_CODES };
export const CART_ERROR_CODES = ERROR_CODES;
export const DEFAULT_CART_DELAY_MS = 750;

const CART_ENDPOINT = "/api/cart_order_edit";
const CSRF_FALLBACK_ENDPOINT = "/top/ws";
const CART_SUCCESS_STATUS = "SUCCESS";
const MAX_REPORT_MESSAGE_LENGTH = 180;

/**
 * Error used for local validation and setup failures.
 *
 * Cart HTTP/network outcomes are returned as a result object instead of
 * being thrown.  This keeps it possible for a caller to render a complete
 * report without accidentally treating an unknown mutation outcome as safe
 * to retry.
 */
export class CartError extends YytError {
  constructor(code, message, details = {}) {
    super(code, message);
    this.name = "CartError";
    this.responseStatus = details.responseStatus ?? null;
    this.stopBatch = details.stopBatch ?? true;
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

function defaultDocument() {
  return typeof document === "undefined" ? null : document;
}

function defaultFetch() {
  if (typeof globalThis === "undefined" || typeof globalThis.fetch !== "function") {
    return null;
  }
  return globalThis.fetch.bind(globalThis);
}

function getFetchImplementation(options = {}) {
  return options.fetch ?? defaultFetch();
}

function cleanToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim();
  return token === "" ? null : token;
}

/**
 * Read a CSRF token from a document's meta element.
 *
 * The function accepts a small document-like object, which makes it useful
 * with a real page document as well as a test double.
 */
export function extractCsrfToken(documentRef = defaultDocument()) {
  if (!documentRef || typeof documentRef.querySelector !== "function") {
    return null;
  }

  let meta;
  try {
    meta = documentRef.querySelector('meta[name="csrf-token"]');
  } catch {
    return null;
  }
  if (!meta) {
    return null;
  }

  let value = null;
  if (typeof meta.getAttribute === "function") {
    value = meta.getAttribute("content");
  }
  if (value == null && "content" in meta) {
    value = meta.content;
  }
  return cleanToken(value);
}

/**
 * Extract a CSRF token from inert HTML returned by `/top/ws`.  DOMParser
 * never runs the fetched page's scripts.
 */
export function extractCsrfTokenFromHtml(html) {
  if (typeof html !== "string" || typeof DOMParser === "undefined") {
    return null;
  }
  return extractCsrfToken(new DOMParser().parseFromString(html, "text/html"));
}

/**
 * Acquire the current page CSRF token, falling back to a same-origin GET of
 * `/top/ws` when the current document does not expose one.
 */
export async function getCsrfToken(options = {}) {
  const documentRef = options.documentRef ?? defaultDocument();
  const fromCurrentPage = extractCsrfToken(documentRef);
  if (fromCurrentPage) {
    return fromCurrentPage;
  }

  const fetchImpl = getFetchImplementation(options);
  if (typeof fetchImpl !== "function") {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "A CSRF token is required before adding items to the cart.",
    );
  }

  const request = {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "text/html" },
  };
  if (options.signal !== undefined) {
    request.signal = options.signal;
  }

  let response;
  try {
    response = await fetchImpl(CSRF_FALLBACK_ENDPOINT, request);
  } catch (error) {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "The CSRF token could not be loaded. Nothing was added to the cart.",
      { cause: error },
    );
  }

  const responseStatus = numericResponseStatus(response);
  if (!responseIsOk(response)) {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "The CSRF token could not be loaded. Nothing was added to the cart.",
      { responseStatus },
    );
  }

  let html;
  try {
    html = await response.text();
  } catch (error) {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "The CSRF token could not be loaded. Nothing was added to the cart.",
      { responseStatus, cause: error },
    );
  }

  const token = extractCsrfTokenFromHtml(String(html));
  if (!token) {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "The page did not expose a usable CSRF token. Nothing was added to the cart.",
      { responseStatus },
    );
  }
  return token;
}

function numericResponseStatus(response) {
  const status = Number(response?.status);
  return Number.isFinite(status) && status > 0 ? status : null;
}

function responseIsOk(response) {
  if (typeof response?.ok === "boolean") {
    return response.ok;
  }
  const status = numericResponseStatus(response);
  return status !== null && status >= 200 && status < 300;
}

function parseInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  let candidate = value;
  if (typeof candidate === "string") {
    candidate = candidate.trim();
    if (!/^\d+$/.test(candidate)) {
      throw new CartError(
        CART_ERROR_CODES.CART_REJECTED,
        `${label} must be an integer.`,
      );
    }
    candidate = Number(candidate);
  }
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < min ||
    candidate > max
  ) {
    throw new CartError(
      CART_ERROR_CODES.CART_REJECTED,
      `${label} must be an integer between ${min} and ${max}.`,
    );
  }
  return candidate;
}

function validateQuantity(value) {
  try {
    return parseInteger(value, "Cart quantity", { min: 1, max: 99 });
  } catch (error) {
    if (error instanceof CartError) {
      error.code = CART_ERROR_CODES.INPUT_INVALID;
    }
    throw error;
  }
}

function productId(product) {
  const value = product?.normalizedId ?? product?.printedId ?? "";
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function resultBase(item, attemptedQuantity = 0) {
  const product = item?.product ?? item ?? {};
  const normalizedId = item?.normalizedId ?? productId(product);
  const requestedQuantity = item?.requestedQuantity ?? product?.requestedQuantity ?? null;
  return {
    normalizedId: typeof normalizedId === "string"
      ? normalizedId.trim().toLocaleLowerCase("en-US")
      : "",
    attemptedQuantity,
    ...(requestedQuantity == null ? {} : { requestedQuantity }),
  };
}

function skippedResult(item, code, message, attemptedQuantity = 0) {
  return {
    ...resultBase(item, attemptedQuantity),
    outcome: "skipped",
    message,
    responseStatus: null,
    code,
    errorCode: code,
    stopBatch: false,
  };
}

function responseMessage(parsed, fallback) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const candidates = [parsed.message, parsed.error, parsed.detail, parsed.reason];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return sanitizeReportMessage(candidate);
      }
    }
  }
  return fallback;
}

function sanitizeReportMessage(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex -- strips control characters on purpose
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:x-)?csrf[-_\s]?token\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/(?:access|refresh)?token\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REPORT_MESSAGE_LENGTH);
}

function itemSpecificResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const status = typeof parsed.status === "string" ? parsed.status.toUpperCase() : "";
  if (!status || status === CART_SUCCESS_STATUS) {
    return false;
  }
  const text = [parsed.status, parsed.code, parsed.message, parsed.error, parsed.reason]
    .filter((value) => typeof value === "string")
    .join(" ");
  return /(stock|sold[ -]?out|inventory|quantity|limit|product|card|商品|在庫|売り切れ|個数)/i.test(text);
}

function classifyHttpFailure(status, parsed, responseOk) {
  if (status === 403 || status === 419) {
    return {
      code: CART_ERROR_CODES.CART_AUTH,
      stopBatch: true,
      message: "The cart request was rejected by authentication or CSRF protection.",
    };
  }
  if (status === 429) {
    return {
      code: CART_ERROR_CODES.CART_RATE_LIMIT,
      stopBatch: true,
      message: "YYT rate-limited the cart request; the batch was stopped.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      code: CART_ERROR_CODES.CART_SERVER,
      stopBatch: true,
      message: "YYT returned a server error; the batch was stopped.",
    };
  }

  const specific = itemSpecificResponse(parsed);
  const structurallyInvalid = responseOk &&
    (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.status !== "string");
  return {
    // A parsed non-success payload is a definite rejection, even when YYT
    // labels it HTTP 200.  `CART_RESPONSE_INVALID` is reserved for malformed
    // or structurally unusable payloads.
    code: structurallyInvalid ? CART_ERROR_CODES.CART_RESPONSE_INVALID : CART_ERROR_CODES.CART_REJECTED,
    stopBatch: !specific,
    message: responseMessage(
      parsed,
      responseOk
        ? "YYT returned an unexpected cart response."
        : "YYT rejected this cart item.",
    ),
  };
}

/**
 * Parse a cart endpoint response.  YYT currently returns JSON while labeling
 * the response as text/html, so this always reads text and parses explicitly.
 */
export async function parseCartResponse(response, item = {}, attemptedQuantity = 0) {
  const responseStatus = numericResponseStatus(response);
  let text;
  try {
    text = await response.text();
  } catch {
    // A non-2xx status is already a definite server-side rejection.  A
    // readable status such as 403/429/5xx therefore remains classifiable even
    // if its body stream is interrupted.  For a 2xx response, however, the
    // server may have accepted the mutation before the body was lost.
    if (!responseIsOk(response)) {
      const classification = classifyHttpFailure(responseStatus, null, false);
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "failed",
        message: classification.message,
        responseStatus,
        code: classification.code,
        errorCode: classification.code,
        stopBatch: classification.stopBatch,
      };
    }
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "unknown",
      message: "The cart response was interrupted; inspect /cart/sell before retrying.",
      responseStatus,
      code: CART_ERROR_CODES.CART_OUTCOME_UNKNOWN,
      errorCode: CART_ERROR_CODES.CART_OUTCOME_UNKNOWN,
      stopBatch: true,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/u, ""));
  } catch {
    const code = responseIsOk(response)
      ? CART_ERROR_CODES.CART_RESPONSE_INVALID
      : classifyHttpFailure(responseStatus, null, responseIsOk(response)).code;
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "failed",
      message: responseIsOk(response)
        ? "YYT returned an invalid cart response."
        : "YYT rejected this cart item with an unreadable response.",
      responseStatus,
      code,
      errorCode: code,
      stopBatch: true,
    };
  }

  if (responseIsOk(response) && parsed?.status === CART_SUCCESS_STATUS) {
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "success",
      message: `Added ${attemptedQuantity}`,
      responseStatus,
      code: null,
      errorCode: null,
      stopBatch: false,
    };
  }

  const classification = classifyHttpFailure(responseStatus, parsed, responseIsOk(response));
  return {
    ...resultBase(item, attemptedQuantity),
    outcome: "failed",
    message: classification.message,
    responseStatus,
    code: classification.code,
    errorCode: classification.code,
    stopBatch: classification.stopBatch,
  };
}

function validateProduct(product) {
  if (!product || typeof product !== "object") {
    throw new CartError(CART_ERROR_CODES.CART_REJECTED, "The resolved product is missing.");
  }
  for (const field of ["gid", "ver", "cid"]) {
    if (product[field] == null || String(product[field]).trim() === "") {
      throw new CartError(
        CART_ERROR_CODES.CART_REJECTED,
        "The resolved product is missing a required cart field.",
      );
    }
  }
  if (product.kizu != null && !/^\d+$/u.test(String(product.kizu).trim())) {
    throw new CartError(
      CART_ERROR_CODES.CART_REJECTED,
      "The resolved product has an invalid condition code.",
    );
  }
}

function availableQuantity(product) {
  const values = [];
  for (const field of ["stock", "limit", "cartActive", "cartLimit"]) {
    if (!(field in product) || product[field] == null || product[field] === "") {
      continue;
    }
    try {
      values.push(parseInteger(product[field], field, { min: 0 }));
    } catch {
      throw new CartError(
        CART_ERROR_CODES.CART_REJECTED,
        "The resolved product has invalid stock information.",
      );
    }
  }
  return values.length === 0 ? null : Math.min(...values);
}

function prepareQuantity(product, plannedQuantity) {
  const requested = validateQuantity(plannedQuantity);
  const available = availableQuantity(product);
  if (available === 0 || product.soldOut === true || product.available === false) {
    throw new CartError(
      CART_ERROR_CODES.PRODUCT_SOLD_OUT,
      `This product is no longer available in ${String(product.kizu ?? "0") === "0" ? "normal" : "damaged"} condition.`,
    );
  }
  return available == null ? requested : Math.min(requested, available, 99);
}

function timestampValue(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CartError(CART_ERROR_CODES.CART_REJECTED, "Unable to create the cart request timestamp.");
  }
  return date.toISOString();
}

/**
 * Build the exact form-encoded POST contract used by YYT.
 */
export function buildCartRequest(product, plannedQuantity, csrfToken, config = {}) {
  validateProduct(product);
  const quantity = prepareQuantity(product, plannedQuantity);
  const token = cleanToken(csrfToken);
  if (!token) {
    throw new CartError(
      CART_ERROR_CODES.CSRF_MISSING,
      "A CSRF token is required before adding items to the cart.",
    );
  }

  const body = new URLSearchParams({
    gid: String(product.gid),
    ver: String(product.ver),
    cid: String(product.cid),
    mode: "add",
    type: "sell",
    counter: String(quantity),
    kizu: String(product.kizu ?? "0"),
    time: timestampValue(config.now),
  });

  const request = {
    url: config.url ?? CART_ENDPOINT,
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-CSRF-TOKEN": token,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
    quantity,
  };
  if (config.signal !== undefined) {
    request.signal = config.signal;
  }
  return request;
}

function unknownResult(item, attemptedQuantity, responseStatus = null) {
  const code = CART_ERROR_CODES.CART_OUTCOME_UNKNOWN;
  return {
    ...resultBase(item, attemptedQuantity),
    outcome: "unknown",
    message: "The cart request outcome is unknown; inspect /cart/sell before retrying.",
    responseStatus,
    code,
    errorCode: code,
    stopBatch: true,
  };
}

function localValidationResult(item, error) {
  const code = error?.code ?? CART_ERROR_CODES.CART_REJECTED;
  const message = error?.message ?? "This item could not be added.";
  return skippedResult(item, code, message);
}

/**
 * Add one resolved product.  A fetch rejection is intentionally classified
 * as `unknown`; this function never retries a cart mutation.
 */
export async function addCartItem(productOrItem, plannedQuantity, options = {}) {
  const item = productOrItem?.product ? productOrItem : { product: productOrItem };
  const product = item.product ?? {};
  const signal = options.signal;
  if (signal?.aborted) {
    return skippedResult(item, CART_ERROR_CODES.CANCELLED, "Cancelled before the cart request was sent.");
  }

  let request;
  try {
    request = buildCartRequest(product, plannedQuantity, options.csrfToken, {
      now: options.now,
      url: options.url,
      signal,
    });
  } catch (error) {
    return localValidationResult(item, error);
  }

  const fetchImpl = getFetchImplementation(options);
  if (typeof fetchImpl !== "function") {
    return unknownResult(item, request.quantity);
  }

  let response;
  try {
    // `quantity` is useful to the caller for result bookkeeping but is not a
    // RequestInit member; keep it out of the object handed to fetch.
    const { quantity: _quantity, ...requestInit } = request;
    response = await fetchImpl(request.url, requestInit);
  } catch {
    return unknownResult(item, request.quantity);
  }

  return parseCartResponse(response, item, request.quantity);
}

function isCancelled(options) {
  return Boolean(options.signal?.aborted || options.cancelSignal?.aborted);
}

function skippedAfterStop(item, code, message) {
  return skippedResult(item, code ?? CART_ERROR_CODES.CART_REJECTED, message);
}

function notifyProgress(callback, value) {
  if (typeof callback !== "function") {
    return;
  }
  try {
    callback(value);
  } catch {
    // A UI callback must never alter cart sequencing or turn a known result
    // into an unknown one.
  }
}

/**
 * Resolve after `milliseconds`, or as soon as `cancelSignal` aborts.
 */
function waitUnlessCancelled(milliseconds, cancelSignal) {
  return new Promise((resolve) => {
    if (cancelSignal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      cancelSignal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    cancelSignal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Add resolved products strictly one at a time.
 *
 * `results` contains one entry for every supplied item, including items that
 * were not attempted because of cancellation, a CSRF/setup failure, or a
 * previous broad failure.  Once a POST is dispatched, its result is never
 * replayed automatically.
 *
 * `cancelSignal` stops the batch before the next item and cuts the delay
 * between items short.  Unlike `signal`, it is never passed to fetch, so
 * cancelling cannot abort a POST that is already in flight and leave its
 * outcome unknown.
 */
export async function addCartItems(items, options = {}) {
  const list = Array.from(items ?? []);
  const results = [];
  if (list.length === 0) {
    return {
      results,
      stopped: false,
      cancelled: false,
      stopCode: null,
      stopMessage: null,
      processedCount: 0,
      successfulCount: 0,
    };
  }

  if (isCancelled(options)) {
    const stopCode = CART_ERROR_CODES.CANCELLED;
    const stopMessage = "Cancelled before the CSRF token was loaded.";
    for (const item of list) {
      results.push(skippedAfterStop(item, stopCode, stopMessage));
    }
    return {
      results,
      stopped: true,
      cancelled: true,
      stopCode,
      stopMessage,
      processedCount: 0,
      successfulCount: 0,
    };
  }

  let csrfToken = cleanToken(options.csrfToken);
  if (!csrfToken) {
    try {
      csrfToken = await getCsrfToken(options);
    } catch (error) {
      const code = error?.code ?? CART_ERROR_CODES.CSRF_MISSING;
      const message = error?.message ?? "A CSRF token could not be obtained.";
      for (const item of list) {
        results.push(skippedAfterStop(item, code, message));
      }
      return {
        results,
        stopped: true,
        cancelled: false,
        stopCode: code,
        stopMessage: message,
        processedCount: 0,
        successfulCount: 0,
      };
    }
  }

  const delayMs = options.delayMs ?? DEFAULT_CART_DELAY_MS;
  const sleep = options.sleep ??
    ((milliseconds) => waitUnlessCancelled(milliseconds, options.cancelSignal));
  let stopped = false;
  let cancelled = false;
  let stopCode = null;
  let stopMessage = null;
  let successfulCount = 0;

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (isCancelled(options)) {
      cancelled = true;
      stopped = true;
      stopCode = CART_ERROR_CODES.CANCELLED;
      stopMessage = "Cancelled before the next cart request.";
      for (let remaining = index; remaining < list.length; remaining += 1) {
        results.push(skippedAfterStop(list[remaining], stopCode, stopMessage));
      }
      break;
    }

    const result = await addCartItem(item, item?.plannedQuantity, {
      ...options,
      csrfToken,
    });
    results.push(result);
    notifyProgress(options.onProgress, {
      index,
      total: list.length,
      item,
      result,
      completedCount: index + 1,
    });

    if (result.outcome === "success") {
      successfulCount += 1;
      if (index < list.length - 1 && !isCancelled(options) && delayMs > 0) {
        try {
          await sleep(delayMs);
        } catch {
          // Delay cancellation does not alter the already-successful result;
          // the next iteration will observe the cancellation state.
        }
      }
      continue;
    }

    if (result.outcome === "skipped" && result.code === CART_ERROR_CODES.CANCELLED) {
      cancelled = true;
      stopped = true;
      stopCode = result.code;
      stopMessage = result.message;
      for (let remaining = index + 1; remaining < list.length; remaining += 1) {
        results.push(skippedAfterStop(list[remaining], stopCode, stopMessage));
      }
      break;
    }

    if (result.outcome === "unknown" || result.stopBatch) {
      stopped = true;
      stopCode = result.code ?? CART_ERROR_CODES.CART_OUTCOME_UNKNOWN;
      stopMessage = result.message;
      for (let remaining = index + 1; remaining < list.length; remaining += 1) {
        results.push(skippedAfterStop(list[remaining], stopCode, "Not attempted because the batch was stopped after the previous cart result."));
      }
      break;
    }
  }

  return {
    results,
    stopped,
    cancelled,
    stopCode,
    stopMessage,
    processedCount: results.filter((result) => result.outcome !== "skipped").length,
    successfulCount,
  };
}
