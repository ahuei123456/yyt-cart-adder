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
  PRODUCT_INVALID: "PRODUCT_INVALID",
  PRODUCT_MISSING: "PRODUCT_MISSING",
  PRODUCT_RARITY_MISSING: "PRODUCT_RARITY_MISSING",
  PRODUCT_CONDITION_MISSING: "PRODUCT_CONDITION_MISSING",
  PRODUCT_VARIANT: "PRODUCT_VARIANT",
  PRODUCT_SOLD_OUT: "PRODUCT_SOLD_OUT",
  PRODUCT_PARTIAL_STOCK: "PRODUCT_PARTIAL_STOCK",
  PRODUCT_OTHER_RARITY: "PRODUCT_OTHER_RARITY",
  PRODUCT_OTHER_CONDITION: "PRODUCT_OTHER_CONDITION",
  CSRF_MISSING: "CSRF_MISSING",
  CART_REJECTED: "CART_REJECTED",
  CART_AUTH: "CART_AUTH",
  CART_RATE_LIMIT: "CART_RATE_LIMIT",
  CART_SERVER: "CART_SERVER",
  CART_RESPONSE_INVALID: "CART_RESPONSE_INVALID",
  CART_OUTCOME_UNKNOWN: "CART_OUTCOME_UNKNOWN",
  CANCELLED: "CANCELLED",
});

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
