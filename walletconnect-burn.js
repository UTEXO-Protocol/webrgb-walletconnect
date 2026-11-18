/** Wire shape checks only; route policy, native addresses and commitments belong to the wallet. */

/** @param {string} message @param {"INVALID_PARAMS" | "INTERNAL_ERROR"} code */
const fail = (message, code) => Object.assign(new Error(message), { code });
/** @param {any} value */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {any} value */
const text = (value) => typeof value === "string" && value.trim().length > 0;
/** @param {any} value */
const confirmations = (value) => Number.isInteger(value) && value >= 1 && value <= 255;

/** @param {Record<string, unknown>} value */
function hasLegacyDestination(value) {
  return "burnRecipient" in value || "destinationChainId" in value || "recipient" in value;
}

/** @param {any} value @returns {import("@utexo/webrgb").RgbBurnDestination} */
function destination(value) {
  if (!object(value) || value.version !== 1 || typeof value.chainId !== "string" ||
      !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value.chainId) || !text(value.address) ||
      !Number.isInteger(value.dstEid) || value.dstEid < 0 || value.dstEid > 0xffffffff ||
      Object.keys(value).some((key) => !["version", "chainId", "address", "dstEid"].includes(key))) {
    throw fail("burnDestination requires version 1, chainId, native address and a u32 dstEid", "INVALID_PARAMS");
  }
  return { version: value.version, chainId: value.chainId, address: value.address, dstEid: value.dstEid };
}

/**
 * @param {any} value
 * @param {string} network
 * @returns {import("@utexo/webrgb").RgbBurnAssetArgs}
 */
export function burnAssetArgs(value, network) {
  if (!object(value) || hasLegacyDestination(value) || value.network !== network || !text(value.assetId) ||
      typeof value.amount !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.amount) ||
      BigInt(value.amount) > 18446744073709551615n ||
      (value.feeRate !== undefined && (!Number.isSafeInteger(value.feeRate) || value.feeRate < 1)) ||
      (value.minConfirmations !== undefined && !confirmations(value.minConfirmations))) {
    throw fail("Invalid burnAsset arguments for this RGB network", "INVALID_PARAMS");
  }
  // Snapshot before any asynchronous work; never forward a legacy destination.
  return {
    network, assetId: value.assetId, amount: value.amount,
    burnDestination: destination(value.burnDestination),
    ...(value.feeRate !== undefined ? { feeRate: value.feeRate } : {}),
    ...(value.minConfirmations !== undefined ? { minConfirmations: value.minConfirmations } : {}),
  };
}

/**
 * @param {any} value
 * @param {import("@utexo/webrgb").RgbBurnAssetArgs} args
 * @returns {import("@utexo/webrgb").RgbBurnAssetResult}
 */
export function burnAssetResult(value, args) {
  try {
    if (!object(value) || hasLegacyDestination(value) || value.assetId !== args.assetId || value.amount !== args.amount ||
        typeof value.txid !== "string" || !/^[0-9a-f]{64}$/i.test(value.txid) ||
        !(text(value.transferId) || (Number.isSafeInteger(value.transferId) && value.transferId >= 0)) ||
        !text(value.status) || !confirmations(value.minConfirmations) ||
        value.minConfirmations < (args.minConfirmations ?? 1)) throw new Error();
    const actual = destination(value.burnDestination), expected = args.burnDestination;
    // EVM hex casing does not change the account. Other native addresses remain case-sensitive.
    const sameAddress = actual.address === expected.address ||
      (expected.chainId.startsWith("eip155:") && /^0x[0-9a-f]{40}$/i.test(expected.address) &&
        actual.address.toLowerCase() === expected.address.toLowerCase());
    if (actual.version !== expected.version || actual.chainId !== expected.chainId ||
        actual.dstEid !== expected.dstEid || !sameAddress) throw new Error();
    return {
      transferId: value.transferId, txid: value.txid, assetId: value.assetId, amount: value.amount,
      burnDestination: actual, status: value.status, minConfirmations: value.minConfirmations,
    };
  } catch {
    // A result error is not a pre-burn rejection. Retain any usable txid for recovery.
    const tx = typeof value?.txid === "string" && /^[0-9a-f]{64}$/i.test(value.txid)
      ? ` (transaction ${value.txid})` : "";
    throw fail(`Wallet returned an invalid burn result${tx}. The burn may already be broadcast; recover it from wallet history and do not burn again.`, "INTERNAL_ERROR");
  }
}
