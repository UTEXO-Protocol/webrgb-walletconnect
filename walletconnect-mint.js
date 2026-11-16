/** Wire checks only. Native proof validation and invoice ownership belong to the wallet. */

/** @param {string} message @param {"INVALID_PARAMS" | "INTERNAL_ERROR"} code */
const fail = (message, code) => Object.assign(new Error(message), { code });

/** @param {unknown} value @returns {import("@utexo/webrgb").RgbGetReceivedMintArgs} */
export function receivedMintArgs(value) {
  const args = /** @type {Record<string, unknown> | null} */ (value);
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).length !== 1 || typeof args.invoice !== "string" ||
      !args.invoice.startsWith("rgb:") || args.invoice.length <= 4 || args.invoice.length > 8192 ||
      /\s|[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(args.invoice)) {
    throw fail("getReceivedMint requires the complete invoice", "INVALID_PARAMS");
  }
  // Capture once: changing the caller's object during an enable handshake must
  // not change which invoice this request authorizes or validates on return.
  return Object.freeze({ invoice: args.invoice });
}

/** @param {unknown} value */
function decimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
}

/**
 * @param {any} value
 * @param {import("@utexo/webrgb").RgbGetReceivedMintArgs} args
 * @param {string} network
 * @returns {import("@utexo/webrgb").RgbReceivedMint | null}
 */
export function receivedMintResult(value, args, network) {
  if (value === null) return null;
  const hex = /^[0-9a-f]{64}$/;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.invoice !== args.invoice || value.network !== network ||
      typeof value.recipientId !== "string" || !value.recipientId || value.recipientId.length > 1024 ||
      typeof value.assetId !== "string" || !value.assetId.startsWith("rgb:") ||
      value.assetId.length <= 4 || value.assetId.length > 512 ||
      ![value.txid, value.opid, value.lockId].every((id) => typeof id === "string" && hex.test(id)) ||
      ![value.amount, value.beforeBlock, value.evmChainId].every(decimal) ||
      value.amount === "0" || value.beforeBlock === "0" || value.evmChainId === "0" ||
      typeof value.bridgeContract !== "string" || !/^0x[0-9a-f]{40}$/.test(value.bridgeContract)) {
    throw fail("Wallet returned an invalid received mint commitment", "INTERNAL_ERROR");
  }
  return value;
}
