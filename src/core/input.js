import { ERROR_CODES } from "./errors.js";
import { normalizePrintedId } from "./parser.js";

const INTEGER_PATTERN = /^\d+$/u;
const CARD_TOKEN_PATTERN = /^\S+$/u;

function makeInputError({ lineNumber, raw, message, lineNumbers = [lineNumber], normalizedId, original }) {
  // Keep parse errors plain-data friendly for the UI and for serialization.
  // The `code` property remains the stable discriminator.
  return {
    code: ERROR_CODES.INPUT_INVALID,
    message,
    reason: message,
    lineNumber,
    lineNumbers,
    raw,
    ...(original ? { original } : {}),
    ...(normalizedId ? { normalizedId } : {}),
  };
}

function parseConditionToken(token) {
  if (typeof token !== "string") return null;
  const lower = token.trim().toLowerCase();
  if (lower === "damaged" || lower === "damage" || lower === "kizu" || lower === "1") {
    return "damaged";
  }
  if (lower === "normal" || lower === "0") {
    return "normal";
  }
  return null;
}

// Rarity labels exactly as printed: `RR`, `S-RR`, `SP`, `SEC+`.  Requiring
// uppercase keeps a misspelled word (`nope`, `damagd`) an input error instead
// of an unknown rarity.
const RARITY_TOKEN_PATTERN = /^(?:[A-Z]{1,2}-)?[A-Z]{1,4}\+?$/u;

function parseRarityToken(token) {
  if (typeof token !== "string" || !RARITY_TOKEN_PATTERN.test(token)) return null;
  return token;
}

function parseLine(raw, lineNumber) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return { kind: "ignored" };
  }

  // Capture the ID as the first non-whitespace/non-comma token. The rest of
  // the line is parsed separately so `ID 1 extra`, `ID,,1`, and similar input
  // cannot be silently guessed at.
  const idMatch = /^([^\s,]+)([\s,].*)?$/u.exec(trimmed);
  if (!idMatch) {
    return {
      kind: "error",
      error: makeInputError({
        lineNumber,
        raw,
        message: "Card ID is required and may not contain whitespace.",
      }),
    };
  }

  const originalId = idMatch[1];
  const normalizedId = normalizePrintedId(originalId);
  if (!normalizedId || !CARD_TOKEN_PATTERN.test(originalId)) {
    return {
      kind: "error",
      error: makeInputError({
        lineNumber,
        raw,
        message: "Card ID is required and may not contain whitespace.",
      }),
    };
  }

  const remainder = idMatch[2]?.trim() ?? "";
  if (!remainder) {
    return {
      kind: "request",
      request: { originalId, normalizedId, quantity: 1, lineNumber },
    };
  }

  if (remainder.includes(",,") || remainder.endsWith(",")) {
    return {
      kind: "error",
      error: makeInputError({
        lineNumber,
        raw,
        original: originalId,
        normalizedId,
        message: "Quantity must be a whole number from 1 through 99.",
      }),
    };
  }

  const tokens = remainder.split(/[\s,]+/u).filter(Boolean);
  const tokenError = (message) => ({
    kind: "error",
    error: makeInputError({ lineNumber, raw, original: originalId, normalizedId, message }),
  });
  if (tokens.length > 3) {
    return tokenError("Unexpected extra tokens on line.");
  }

  // Grammar: ID [quantity] [condition] [rarity], where condition and rarity
  // may come in either order.  A leading integer is always the quantity, so
  // `ID 1 1` stays "one damaged copy".
  let quantity = 1;
  let condition = null;
  let rarity = null;
  let rest = tokens;
  if (INTEGER_PATTERN.test(rest[0])) {
    const parsedQty = Number(rest[0]);
    if (!Number.isSafeInteger(parsedQty) || parsedQty < 1 || parsedQty > 99) {
      return tokenError("Quantity must be a whole number from 1 through 99.");
    }
    quantity = parsedQty;
    rest = rest.slice(1);
  }

  for (const token of rest) {
    const parsedCondition = parseConditionToken(token);
    if (parsedCondition && !condition) {
      condition = parsedCondition;
      continue;
    }
    const parsedRarity = parseRarityToken(token);
    if (parsedRarity && !rarity) {
      rarity = parsedRarity;
      continue;
    }
    return tokenError(
      token === tokens[0]
        ? "Quantity must be a whole number from 1 through 99."
        : "Expected a condition ('damaged'/1 or 'normal'/0) or a rarity such as RR or S-RR.",
    );
  }

  const request = { originalId, normalizedId, quantity, lineNumber };
  if (condition) {
    request.condition = condition;
  }
  if (rarity) {
    request.rarity = rarity;
  }
  return {
    kind: "request",
    request,
  };
}

/**
 * Parse one-card-per-line input and aggregate duplicate IDs.
 *
 * @returns {{requests: Array<object>, errors: Array<object>}}
 *   `requests` use the handoff shape:
 *   `{ originalIds, normalizedId, requestedQuantity, sourceLines }`.
 *   Invalid rows are returned in `errors`, with stable `code` and source line
 *   information. Blank and comment lines are intentionally omitted.
 */
export function parseInput(input) {
  if (typeof input !== "string") {
    throw new TypeError("Input must be a string.");
  }

  const requestsById = new Map();
  const errors = [];

  input.split(/\r?\n/u).forEach((raw, index) => {
    const lineNumber = index + 1;
    const parsed = parseLine(raw, lineNumber);
    if (parsed.kind === "ignored") {
      return;
    }
    if (parsed.kind === "error") {
      errors.push(parsed.error);
      return;
    }

    const { originalId, normalizedId, quantity, condition, rarity, lineNumber: sourceLine } = parsed.request;
    const key = `${normalizedId}:${condition ?? ""}:${rarity ?? ""}`;
    const existing = requestsById.get(key);
    if (existing) {
      existing.originalIds.push(originalId);
      existing.sourceLines.push(sourceLine);
      existing.requestedQuantity += quantity;
      return;
    }

    const item = {
      originalIds: [originalId],
      normalizedId,
      requestedQuantity: quantity,
      sourceLines: [sourceLine],
    };
    if (condition) {
      item.condition = condition;
    }
    if (rarity) {
      item.rarity = rarity;
    }
    requestsById.set(key, item);
  });

  // Aggregation overflow is reported as one invalid logical line with all
  // contributing source lines, and is excluded from requests so it cannot be
  // selected accidentally by the lookup or cart layers.
  for (const [key, request] of requestsById) {
    if (request.requestedQuantity <= 99) {
      continue;
    }

    errors.push(
      makeInputError({
        lineNumber: request.sourceLines[0],
        lineNumbers: [...request.sourceLines],
        raw: request.originalIds.join(", "),
        original: request.originalIds[0],
        normalizedId: request.normalizedId,
        message: `Combined quantity for ${request.originalIds[0]} exceeds the maximum of 99.`,
      }),
    );
    requestsById.delete(key);
  }

  errors.sort((left, right) => left.lineNumber - right.lineNumber);

  return {
    requests: [...requestsById.values()],
    errors,
  };
}
