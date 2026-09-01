/**
 * Stable error codes shared by the pure core, lookup, cart, and UI layers.
 *
 * Keeping the codes separate from user-facing text lets the UI and tests make
 * decisions without depending on a particular translation or message string.
 */
export const ERROR_CODES = Object.freeze({
  INPUT_INVALID: "INPUT_INVALID",
  LOOKUP_NETWORK: "LOOKUP_NETWORK",
  LOOKUP_HTTP: "LOOKUP_HTTP",
  LOOKUP_SITE_CHANGED: "LOOKUP_SITE_CHANGED",
  PRODUCT_MISSING: "PRODUCT_MISSING",
  PRODUCT_AMBIGUOUS: "PRODUCT_AMBIGUOUS",
  PRODUCT_SOLD_OUT: "PRODUCT_SOLD_OUT",
  PRODUCT_PARTIAL_STOCK: "PRODUCT_PARTIAL_STOCK",
  CSRF_MISSING: "CSRF_MISSING",
  CART_REJECTED: "CART_REJECTED",
  CART_AUTH: "CART_AUTH",
  CART_RATE_LIMIT: "CART_RATE_LIMIT",
  CART_SERVER: "CART_SERVER",
  CART_RESPONSE_INVALID: "CART_RESPONSE_INVALID",
  CART_OUTCOME_UNKNOWN: "CART_OUTCOME_UNKNOWN",
  CANCELLED: "CANCELLED",
});

// A singular alias reads naturally at call sites while ERROR_CODES remains
// the canonical export used by the rest of the application.
export const ErrorCode = ERROR_CODES;

/**
 * Error carrying one of the stable application error codes.
 */
export class YytError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "YytError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * Construct a typed application error without exposing implementation-specific
 * error strings to callers that only need to inspect the code.
 */
export function createYytError(code, message, details = undefined) {
  return new YytError(code, message, details);
}

export function isYytError(value) {
  return value instanceof YytError;
}
