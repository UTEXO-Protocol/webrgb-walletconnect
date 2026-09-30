import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

export const CHUNK_BYTES = 48 * 1024;
export const MAX_BYTES = 16 * 1024 * 1024;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message), { code: "INTERNAL_ERROR" });
}

/** @param {Uint8Array} bytes */
export function encode(bytes) {
  const parts = [];
  let block = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    block +=
      alphabet[n >>> 18] +
      alphabet[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : "=") +
      (i + 2 < bytes.length ? alphabet[n & 63] : "=");
    if (block.length >= 8192) {
      parts.push(block);
      block = "";
    }
  }
  parts.push(block);
  return parts.join("");
}

/** @param {unknown} value @param {number} limit */
function decode(value, limit) {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(limit / 3) * 4
  ) {
    throw invalid("Invalid consignment Base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding)))
    throw invalid("Invalid consignment Base64");
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  for (let i = 0, j = 0; i < value.length; i += 4) {
    const n =
      (alphabet.indexOf(value[i]) << 18) |
      (alphabet.indexOf(value[i + 1]) << 12) |
      (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) |
      Math.max(0, alphabet.indexOf(value[i + 3]));
    bytes[j++] = n >>> 16;
    if (j < bytes.length) bytes[j++] = (n >>> 8) & 255;
    if (j < bytes.length) bytes[j++] = n & 255;
  }
  if (!bytes.length || bytes.length > limit || encode(bytes) !== value)
    throw invalid("Invalid consignment encoding");
  return bytes;
}

/** @param {Uint8Array} bytes */
export function digest(bytes) {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** @param {any} proof @param {{assetId: string, txid: string}} args */
function metadata(proof, args) {
  if (
    !proof ||
    proof.assetId !== args.assetId ||
    proof.txid !== args.txid ||
    proof.encoding !== "base64" ||
    !Number.isSafeInteger(proof.byteLength) ||
    proof.byteLength < 1 ||
    proof.byteLength > MAX_BYTES ||
    proof.digest?.algorithm !== "keccak256" ||
    !/^0x[0-9a-f]{64}$/i.test(proof.digest.value)
  ) {
    throw invalid("Invalid consignment metadata");
  }
}

/** @param {any} proof @param {{assetId: string, txid: string}} args */
export function validateProof(proof, args) {
  metadata(proof, args);
  const bytes = decode(proof.data, MAX_BYTES);
  if (bytes.length !== proof.byteLength || digest(bytes) !== proof.digest.value.toLowerCase()) {
    throw invalid("Consignment digest or length mismatch");
  }
  return bytes;
}

/**
 * @param {{assetId: string, txid: string}} args
 * @param {(args: {assetId: string, txid: string, offset: number, length: number}) => Promise<any>} request
 * @returns {Promise<import("@utexo/webrgb").RgbGetConsignmentResult>}
 */
export async function receiveProof(args, request) {
  let offset = 0;
  /** @type {Uint8Array | undefined} */
  let bytes;
  let hash = "";
  for (;;) {
    const part = await request({ ...args, offset, length: CHUNK_BYTES });
    metadata(part, args);
    if (part.offset !== offset) throw invalid("Invalid consignment offset");
    if (!bytes) {
      bytes = new Uint8Array(part.byteLength);
      hash = part.digest.value.toLowerCase();
    }
    if (part.byteLength !== bytes.length || part.digest.value.toLowerCase() !== hash)
      throw invalid("Consignment changed during transfer");
    const chunk = decode(part.data, CHUNK_BYTES);
    const end = offset + chunk.length;
    if (end > bytes.length || part.nextOffset !== (end === bytes.length ? null : end)) {
      throw invalid("Invalid consignment chunk range");
    }
    bytes.set(chunk, offset);
    if (part.nextOffset === null) {
      if (digest(bytes) !== hash) throw invalid("Consignment digest mismatch");
      return {
        ...args,
        encoding: "base64",
        data: encode(bytes),
        byteLength: bytes.length,
        digest: { algorithm: "keccak256", value: /** @type {`0x${string}`} */ (hash) },
      };
    }
    offset = end;
  }
}
