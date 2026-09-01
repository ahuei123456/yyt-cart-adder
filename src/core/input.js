import { ERROR_CODES, createYytError } from "./errors.js";

const INTEGER_PATTERN = /^\d+$/u;
const CARD_TOKEN_PATTERN = /^\S+$/u;

/**
 * Normalize a printed card ID for matching while retaining punctuation and
 * rarity suffixes. IDs are intentionally not canonicalized beyond trimming
 * and case folding: `005` and `005SP` must remain different cards.
 */
export function normalizePrintedId(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLocaleLowerCase("en-US");
}

/**
 * Return the part of a printed ID before its first hyphen. A null result means
 * that the value cannot safely be used for a grouped prefix search and should
 * go through the exact-search fallback path.
 *
 * The returned text retains the caller's spelling so a query can be sent in
 * the same form the user supplied. Grouping itself uses a normalized key.
 */
export function getSearchPrefix(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("-");
  if (separatorIndex <= 0) {
    return null;
  }

  const prefix = trimmed.slice(0, separatorIndex);
  if (!prefix || /\s/u.test(prefix) || !prefix.includes("/")) {
    return null;
  }

  return prefix;
}

function makeInputError({ lineNumber, raw, message, lineNumbers = [lineNumber], normalizedId, original }) {
  const error = createYytError(ERROR_CODES.INPUT_INVALID, message, {
    lineNumber,
    lineNumbers,
    raw,
    ...(normalizedId ? { normalizedId } : {}),
  });

  // Keep parse errors plain-data friendly for the UI and for serialization.
  // The `code` property remains the stable discriminator.
  return {
    code: error.code,
    message: error.message,
    reason: error.message,
    lineNumber,
    lineNumbers,
    raw,
    ...(original ? { original } : {}),
    ...(normalizedId ? { normalizedId } : {}),
  };
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

  let quantityText = idMatch[2]?.trim() ?? "";
  if (!quantityText) {
    return {
      kind: "request",
      request: { originalId, normalizedId, quantity: 1, lineNumber },
    };
  }

  // Permit both `ID,1` and `ID , 1`, but only one comma separator. A comma
  // appearing anywhere else remains an invalid extra token.
  if (quantityText.startsWith(",")) {
    quantityText = quantityText.slice(1).trim();
  }

  if (!INTEGER_PATTERN.test(quantityText)) {
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

  const quantity = Number(quantityText);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
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

  return {
    kind: "request",
    request: { originalId, normalizedId, quantity, lineNumber },
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

    const { originalId, normalizedId, quantity, lineNumber: sourceLine } = parsed.request;
    const existing = requestsById.get(normalizedId);
    if (existing) {
      existing.originalIds.push(originalId);
      existing.sourceLines.push(sourceLine);
      existing.requestedQuantity += quantity;
      return;
    }

    requestsById.set(normalizedId, {
      originalIds: [originalId],
      normalizedId,
      requestedQuantity: quantity,
      sourceLines: [sourceLine],
    });
  });

  // Aggregation overflow is reported as one invalid logical line with all
  // contributing source lines, and is excluded from requests so it cannot be
  // selected accidentally by the lookup or cart layers.
  for (const [normalizedId, request] of requestsById) {
    if (request.requestedQuantity <= 99) {
      continue;
    }

    errors.push(
      makeInputError({
        lineNumber: request.sourceLines[0],
        lineNumbers: [...request.sourceLines],
        raw: request.originalIds.join(", "),
        original: request.originalIds[0],
        normalizedId,
        message: `Combined quantity for ${request.originalIds[0]} exceeds the maximum of 99.`,
      }),
    );
    requestsById.delete(normalizedId);
  }

  errors.sort((left, right) => left.lineNumber - right.lineNumber);

  const result = {
    requests: [...requestsById.values()],
    errors,
  };

  // `invalid` was the name used by the first UI integration. Keep it as a
  // non-enumerable alias so existing callers continue to work while the
  // canonical serialized shape remains `{ requests, errors }`.
  Object.defineProperty(result, "invalid", {
    enumerable: false,
    configurable: false,
    get: () => result.errors,
  });

  return result;
}

function requestDisplayId(request) {
  if (request && Array.isArray(request.originalIds) && request.originalIds.length > 0) {
    return request.originalIds[0];
  }
  if (request && typeof request.originalId === "string") {
    return request.originalId;
  }
  if (request && typeof request.normalizedId === "string") {
    return request.normalizedId;
  }
  return "";
}

/**
 * Group parsed requests into one prefix query per distinct prefix.
 *
 * Requests that lack a safe prefix are returned in `exactFallback`. Group
 * order and request order follow the input order, making lookup behavior
 * deterministic and easy to test.
 */
export function groupRequestsByPrefix(requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError("Requests must be an array.");
  }

  const groupsByNormalizedPrefix = new Map();
  const exactFallback = [];

  for (const request of requests) {
    if (!request || typeof request.normalizedId !== "string") {
      // A malformed object cannot be safely grouped. Keep it visible to the
      // exact path, where the lookup layer can classify it as missing.
      exactFallback.push(request);
      continue;
    }

    const rawPrefix = getSearchPrefix(requestDisplayId(request));
    if (!rawPrefix) {
      exactFallback.push(request);
      continue;
    }

    const normalizedPrefix = normalizePrintedId(rawPrefix);
    let group = groupsByNormalizedPrefix.get(normalizedPrefix);
    if (!group) {
      group = {
        prefix: rawPrefix,
        normalizedPrefix,
        query: rawPrefix,
        requests: [],
      };
      groupsByNormalizedPrefix.set(normalizedPrefix, group);
    }
    group.requests.push(request);
  }

  return {
    groups: [...groupsByNormalizedPrefix.values()],
    exactFallback,
  };
}
