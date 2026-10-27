/** WebRGB binding over the official SignClient (dApp) and WalletKit (wallet) APIs. */
import {
  buildApprovedNamespaces,
  getSdkError,
  parseUri,
  parseExpirerTarget,
} from "@walletconnect/utils";
import { RGB_ERROR_CODES } from "@utexo/webrgb";
import {
  CHUNK_BYTES,
  MAX_BYTES,
  encode,
  receiveProof,
  validateProof,
} from "./walletconnect-proof.js";

export const RGB_WALLETCONNECT_PROFILE = "webrgb:1";
export const CONSIGNMENT_CHUNK_BYTES = CHUNK_BYTES;
export const MAX_CONSIGNMENT_BYTES = MAX_BYTES;
export const RGB_WALLETCONNECT_METHODS = Object.freeze([
  "enable",
  "getInfo",
  "getAddress",
  "signMessage",
  "blindReceive",
  "witnessReceive",
  "issueAsset",
  "listAssets",
  "getAssetBalance",
  "sendAsset",
  "listTransfers",
  "getTransferStatus",
  "decodeRgbInvoice",
  "makeLnInvoice",
  "payLnInvoice",
  "burnAsset",
  "getConsignment",
]);
const EVENTS = ["transferReceived", "transferSettled"];
// These operations cannot allocate an invoice/address, sign or spend. A single
// NOT_ENABLED reply proves the original read did not run in the old runtime.
const RESUMABLE_READS = new Set([
  "getInfo", "listAssets", "getAssetBalance", "listTransfers",
  "getTransferStatus", "decodeRgbInvoice", "getConsignment",
]);
const PROFILE = { webrgb: RGB_WALLETCONNECT_PROFILE };
const DISCONNECT = getSdkError("USER_DISCONNECTED");
const hosts = new WeakSet();

/** @param {string} message @param {import("@utexo/webrgb").ProviderErrorCode} code */
function fail(message, code = "INTERNAL_ERROR") {
  return Object.assign(new Error(message), { code });
}
/** @param {string} message @param {"REVOKED" | "SUSPENDED"} authorization */
function authorizationFailure(message, authorization) {
  return Object.assign(fail(message, "NOT_ENABLED"), { authorization });
}
/** @param {any} error */
function fromRpc(error) {
  const code = typeof error?.data === "string" ? error.data : error?.data?.code ?? error?.code;
  const mapped = RGB_ERROR_CODES.includes(code)
    ? code
    : [4001, 5000, 5001, 5002, 5003].includes(code)
      ? "USER_REJECTED"
      : [-32601, 5100, 5101, 5102, 5103, 5104, 10001].includes(code)
        ? "METHOD_NOT_SUPPORTED"
        : [-32602].includes(code)
          ? "INVALID_PARAMS"
          : [3001].includes(code)
            ? "NOT_ENABLED"
            : "INTERNAL_ERROR";
  const authorization = error?.authorization ?? error?.data?.authorization;
  return Object.assign(
    fail(typeof error?.message === "string" ? error.message : "Wallet request failed", mapped),
    mapped === "NOT_ENABLED" && ["REVOKED", "SUSPENDED"].includes(authorization) ? { authorization } : {},
  );
}
/** @param {string} network */
function chainFor(network) {
  if (!/^[-_a-zA-Z0-9]{1,32}$/.test(network)) throw fail("Invalid RGB network", "INVALID_PARAMS");
  return `rgb:${network}`;
}
/** @param {string[]} methods */
function methodList(methods) {
  if (!Array.isArray(methods) || methods.some((m) => !RGB_WALLETCONNECT_METHODS.includes(m))) {
    throw fail("Unknown WebRGB RPC method", "INVALID_PARAMS");
  }
  return [...new Set(methods)];
}
/** @param {string[]} events */
function eventList(events) {
  if (!Array.isArray(events) || events.some((e) => !EVENTS.includes(e)))
    throw fail("Unknown WebRGB event", "INVALID_PARAMS");
  return [...new Set(events)];
}
/** @param {string} name */
const wire = (name) => `rgb_${name}`;
/** @param {import("./index.js").WalletConnectSession} session @param {string} chainId */
function grants(session, chainId) {
  if (
    !session ||
    !Number.isSafeInteger(session.expiry) ||
    session.expiry <= Date.now() / 1000 ||
    session.sessionProperties?.webrgb !== RGB_WALLETCONNECT_PROFILE
  ) {
    throw fail("The WebRGB session expired or uses another transport profile", "NOT_ENABLED");
  }
  const namespaces = Object.entries(session.namespaces).filter(
    ([key, ns]) =>
      (key === "rgb" || key === chainId) &&
      ns.accounts.some((a) => a.startsWith(`${chainId}:`) && a.length > chainId.length + 1),
  );
  if (!namespaces.length)
    throw fail("The session does not authorize this RGB network", "NOT_ENABLED");
  return {
    methods: new Set(namespaces.flatMap(([, ns]) => ns.methods)),
    events: new Set(namespaces.flatMap(([, ns]) => ns.events)),
    accounts: new Set(namespaces.flatMap(([, ns]) => ns.accounts)),
  };
}
/** @param {string} url */
function originOf(url) {
  try {
    const value = new URL(url);
    if (!["https:", "http:"].includes(value.protocol) || value.username || value.password)
      throw new Error();
    return value.origin;
  } catch {
    throw fail("Invalid dApp origin", "NOT_ENABLED");
  }
}
/** @param {any} context @param {string} origin @returns {"VALID" | "UNKNOWN"} */
function verification(context, origin) {
  const verified = context?.verified;
  if (
    verified?.isScam ||
    verified?.validation === "INVALID" ||
    (verified?.validation === "VALID" && originOf(verified.origin) !== origin)
  ) {
    throw fail("dApp verification failed", "NOT_ENABLED");
  }
  return verified?.validation === "VALID" ? "VALID" : "UNKNOWN";
}
/** @param {any} info @param {string} network @param {ReturnType<typeof grants>} allowed */
function infoFor(info, network, allowed) {
  if (
    !info ||
    typeof info.ready !== "boolean" ||
    info.network !== network ||
    !Array.isArray(info.methods)
  ) {
    throw fail("Wallet returned invalid network or capability information");
  }
  return {
    ...info,
    methods: info.methods.filter((/** @type {string} */ m) =>
      m === "on" || m === "off" ? allowed.events.size > 0 : allowed.methods.has(wire(m)),
    ),
  };
}

/** @param {import("./index.js").WalletConnectProviderOptions} options */
export function createWalletConnectProvider({ client, topic, network, requestTimeoutMs = 30_000 }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000)
    throw fail("Read/handshake timeout must be between 1 and 120000ms", "INVALID_PARAMS");
  const chainId = chainFor(network);
  const relayer = client.core.relayer;
  const relayUnavailableEvents = ["relayer_disconnect", "relayer_transport_closed", "relayer_connection_stalled"];
  let disposed = false;
  let enabled = false;
  /** @type {"REVOKED" | "SUSPENDED" | undefined} */
  let lastAuthorization;
  let previouslyEnabled = false;
  let revision = 0;
  // Relay availability is separate from session authority. Losing a connection
  // invalidates readiness replies without discarding a financial result that
  // still belongs to its original, authorized request.
  let relayAvailable = true;
  let relayGeneration = 0;
  /** @type {Promise<void> | undefined} */
  let enabling;
  /** @type {Map<string, Set<(transfer: import("@utexo/webrgb").RgbTransfer) => void>>} */
  const listeners = new Map();
  /** @type {Set<(state: import("./index.js").WalletConnectAvailability) => void>} */
  const availabilityListeners = new Set();
  /** @param {boolean} value @param {"REVOKED" | "SUSPENDED" | undefined} [authorization] */
  const setEnabled = (value, authorization) => {
    if (enabled === value && lastAuthorization === authorization) return;
    enabled = value;
    lastAuthorization = authorization;
    for (const listener of availabilityListeners) {
      try { listener({ enabled: value, ...(authorization ? { authorization } : {}) }); } catch { /* Observers do not own authorization. */ }
    }
  };
  const identity = (/** @type {import("./index.js").WalletConnectSession} */ session) => ({
    origin: originOf(session.peer.metadata.url),
    accounts: [...grants(session, chainId).accounts].filter((a) => a.startsWith(`${chainId}:`)).sort().join("\n"),
  });
  const initialIdentity = identity(client.session.get(topic));
  const current = () => {
    if (disposed) throw fail("Provider is disconnected", "NOT_ENABLED");
    try {
      const session = client.session.get(topic);
      const principal = identity(session);
      if (principal.origin !== initialIdentity.origin || principal.accounts !== initialIdentity.accounts)
        throw fail("Session identity changed", "NOT_ENABLED");
      return grants(session, chainId);
    } catch {
      setEnabled(false, "REVOKED");
      throw authorizationFailure("Session is no longer authorized", "REVOKED");
    }
  };
  current();
  /** A late handshake/response cannot authorize a replaced or disposed session. */
  const assertRevision = (/** @type {number} */ expected) => {
    const allowed = current();
    if (expected !== revision) throw fail("Session changed during the request", "NOT_ENABLED");
    return allowed;
  };
  const assertRelay = (/** @type {number} */ expected) => {
    if (!relayAvailable || expected !== relayGeneration)
      throw authorizationFailure("Wallet relay is temporarily unavailable. Reconnect and try again.", "SUSPENDED");
  };
  /** @param {string} method @param {unknown[]} params @param {(result: any) => any} [accept] */
  const dispatch = async (method, params, accept) => {
    const expected = revision;
    const expectedRelay = relayGeneration;
    const readiness = method === "enable" || RESUMABLE_READS.has(method);
    if (!current().methods.has(wire(method)))
      throw fail(`${method} was not approved`, "METHOD_NOT_SUPPORTED");
    try {
      if (readiness) assertRelay(expectedRelay);
      const remote = client.request({ topic, chainId, request: { method: wire(method), params } });
      let timer;
      let result;
      try {
        result = await (method === "enable" || RESUMABLE_READS.has(method)
          ? Promise.race([remote, new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (expectedRelay === relayGeneration) setEnabled(false);
              reject(fail("Wallet did not respond. Open and unlock it, then try again.", "INTERNAL_ERROR"));
            }, requestTimeoutMs);
          })])
          : remote);
      } finally { clearTimeout(timer); }
      if (!assertRevision(expected).methods.has(wire(method)))
        throw fail("Permission was revoked", "NOT_ENABLED");
      if (readiness) assertRelay(expectedRelay);
      // Consume readiness under the same generation check, without an await
      // between accepting this response and publishing its validated info.
      return accept ? accept(result) : result;
    } catch (error) {
      // An old read/handshake must not overwrite availability established by a
      // newer relay connection, even when that old response is an error.
      if (readiness && expectedRelay !== relayGeneration)
        throw authorizationFailure("Wallet relay changed during the request. Try again.", "SUSPENDED");
      const mapped = fromRpc(error);
      if (mapped.code === "NOT_ENABLED") setEnabled(false, mapped.authorization);
      throw mapped;
    }
  };
  // enable is a real, single-flight handshake, never a browser-cache shortcut.
  // The wallet revalidates its durable grant and current lock/runtime boundary.
  const enable = async () => {
    current();
    if (!enabling) {
      const expected = revision;
      const expectedRelay = relayGeneration;
      const pending = dispatch("enable", []).then(() => {
        assertRevision(expected);
        assertRelay(expectedRelay);
        previouslyEnabled = true;
        setEnabled(true);
      });
      enabling = pending;
      void pending.finally(() => { if (enabling === pending) enabling = undefined; }).catch(() => {});
    }
    return enabling;
  };
  /** @param {string} method @param {unknown[]} params @param {(result: any) => any} [accept] */
  const request = async (method, params = [], accept) => {
    params = [...params];
    while (params.length && params.at(-1) === undefined) params.pop();
    current();
    let recovered = false;
    if (!enabled) {
      if (!previouslyEnabled || !RESUMABLE_READS.has(method))
        throw fail("Call enable() first", "NOT_ENABLED");
      recovered = true;
      await enable();
    }
    try {
      return await dispatch(method, params, accept);
    } catch (error) {
      // No generic retry and no replay of invoice/address/sign/send/burn requests.
      // A new authorization handshake may only recover one rejected read.
      if (recovered || fromRpc(error).code !== "NOT_ENABLED" || fromRpc(error).authorization === "REVOKED" || !RESUMABLE_READS.has(method)) throw error;
      current();
      await enable();
      return dispatch(method, params, accept);
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revision++;
    setEnabled(false);
    availabilityListeners.clear();
    listeners.clear();
    for (const event of ["session_delete", "session_expire"])
      client.off(/** @type {any} */ (event), lost);
    client.off("session_event", onEvent);
    client.off("session_update", updated);
    for (const event of relayUnavailableEvents) relayer?.off(event, relayUnavailable);
    relayer?.off("relayer_connect", relayResumed);
  };
  /** @type {Promise<unknown> | undefined} */
  let resuming;
  const relayUnavailable = () => {
    relayAvailable = false;
    relayGeneration++;
    // A reconnect gets its own handshake even if an older relay is still
    // holding an unresolved response. Old finally handlers cannot clear it.
    enabling = undefined;
    resuming = undefined;
    setEnabled(false, "SUSPENDED");
  };
  const relayResumed = () => {
    const wasAvailable = relayAvailable;
    relayAvailable = true;
    if (wasAvailable) return;
    relayGeneration++;
    // A locally rejected offline enable may not have reached its finally yet.
    // It must not absorb the reconnect's first real authorization handshake.
    enabling = undefined;
    if (disposed || !previouslyEnabled || resuming) return;
    // A reconnect resumes authorization/readiness only. Financial requests stay
    // with their existing IDs; no transaction is issued by this callback.
    const pending = enable().then(() => provider.getInfo()).catch(() => {});
    resuming = pending;
    void pending.finally(() => { if (resuming === pending) resuming = undefined; });
  };
  /** @param {{topic: string}} event */
  const lost = (event) => {
    if (event.topic === topic) dispose();
  };
  /** @param {{topic: string}} event */
  const updated = (event) => {
    if (event.topic !== topic) return;
    revision++;
    enabling = undefined;
    try {
      const allowed = current();
      if (!["rgb_enable", "rgb_getInfo"].every((m) => allowed.methods.has(m))) {
        dispose();
        return;
      }
      for (const name of listeners.keys()) if (!allowed.events.has(name)) listeners.delete(name);
    } catch {
      dispose();
    }
  };
  /** @param {any} event */
  const onEvent = (event) => {
    if (event.topic !== topic || event.params?.chainId !== chainId || !enabled) return;
    const { name, data } = event.params.event ?? {};
    try {
      if (!current().events.has(name) || !data || typeof data !== "object") return;
    } catch {
      return;
    }
    for (const listener of listeners.get(name) ?? []) listener(data);
  };
  for (const event of ["session_delete", "session_expire"])
    client.on(/** @type {any} */ (event), lost);
  client.on("session_event", onEvent);
  client.on("session_update", updated);
  for (const event of relayUnavailableEvents) relayer?.on(event, relayUnavailable);
  relayer?.on("relayer_connect", relayResumed);
  /** @type {Record<string, any>} */
  const provider = {
    topic,
    chainId,
    get enabled() {
      try {
        current();
        return enabled;
      } catch {
        return false;
      }
    },
    enable,
    subscribeAvailability(/** @type {(state: import("./index.js").WalletConnectAvailability) => void} */ listener) {
      availabilityListeners.add(listener);
      return () => availabilityListeners.delete(listener);
    },
    getInfo() {
      return request("getInfo", [], (value) => {
        const info = infoFor(value, network, current());
        for (const listener of availabilityListeners) {
          try { listener({ enabled, info }); } catch { /* Readiness observers cannot change the result. */ }
        }
        return info;
      });
    },
    async getConsignment(/** @type {import("@utexo/webrgb").RgbGetConsignmentArgs} */ args) {
      proofArgs(args);
      return receiveProof(args, (part) => request("getConsignment", [part]));
    },
    on(
      /** @type {import("@utexo/webrgb").RgbEvent} */ event,
      /** @type {(t: import("@utexo/webrgb").RgbTransfer) => void} */ listener,
    ) {
      if (!enabled) throw fail("Call enable() first", "NOT_ENABLED");
      if (!EVENTS.includes(event) || !current().events.has(wire(event)))
        throw fail("Event was not approved", "METHOD_NOT_SUPPORTED");
      if (!listeners.has(wire(event))) listeners.set(wire(event), new Set());
      listeners.get(wire(event))?.add(listener);
    },
    off(
      /** @type {import("@utexo/webrgb").RgbEvent} */ event,
      /** @type {(t: import("@utexo/webrgb").RgbTransfer) => void} */ listener,
    ) {
      listeners.get(wire(event))?.delete(listener);
    },
    dispose,
    async disconnect() {
      dispose();
      await client.disconnect({ topic, reason: DISCONNECT });
    },
  };
  for (const method of RGB_WALLETCONNECT_METHODS) {
    if (!(method in provider))
      provider[method] = (.../** @type {unknown[]} */ args) => request(method, args);
  }
  return /** @type {import("./index.js").WalletConnectProvider} */ (
    /** @type {unknown} */ (provider)
  );
}

/** @param {import("./index.js").ConnectWalletConnectOptions} options */
export async function connectWalletConnect({
  client,
  network,
  methods = [],
  optionalMethods = [],
  events = [],
}) {
  const chainId = chainFor(network);
  const required = methodList(["enable", "getInfo", ...methods]);
  const optional = methodList(optionalMethods).filter((m) => !required.includes(m));
  const wantedEvents = eventList(events);
  const connection = await client.connect({
    requiredNamespaces: { rgb: { chains: [chainId], methods: required.map(wire), events: [] } },
    optionalNamespaces: {
      rgb: { chains: [chainId], methods: optional.map(wire), events: wantedEvents.map(wire) },
    },
    sessionProperties: PROFILE,
  });
  let cancelled = false;
  /** @type {import("./index.js").WalletConnectProvider | undefined} */
  let provider;
  /** @type {(error: Error) => void} */
  let rejectCancelled;
  const cancellation = new Promise((_, reject) => {
    rejectCancelled = reject;
  });
  const accepted = connection.approval().then(async (session) => {
    try {
      if (cancelled) throw fail("Connection cancelled", "USER_REJECTED");
      const allowed = grants(session, chainId);
      if (required.some((m) => !allowed.methods.has(wire(m))))
        throw fail("Wallet did not approve the required methods", "METHOD_NOT_SUPPORTED");
      provider = createWalletConnectProvider({ client, network, topic: session.topic });
      return provider;
    } catch (error) {
      await client.disconnect({ topic: session.topic, reason: DISCONNECT }).catch(() => {});
      throw error;
    }
  });
  const approval = Promise.race([accepted, cancellation]).catch((error) => {
    throw fromRpc(error);
  });
  // A UI can display the URI before attaching its own approval handler.
  void approval.catch(() => {});
  return {
    uri: connection.uri,
    approval: () => /** @type {Promise<import("./index.js").WalletConnectProvider>} */ (approval),
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      rejectCancelled(fail("Connection cancelled", "USER_REJECTED"));
      if (provider) await provider.disconnect();
      if (connection.uri) {
        const pairingTopic = /^wc:([^@]+)@/.exec(connection.uri)?.[1];
        if (pairingTopic) await client.core.pairing.disconnect({ topic: pairingTopic });
      }
    },
  };
}

/** @param {any} args */
function proofArgs(args) {
  if (
    !args ||
    typeof args.assetId !== "string" ||
    !args.assetId.startsWith("rgb:") ||
    typeof args.txid !== "string" ||
    !/^[0-9a-f]{64}$/i.test(args.txid)
  ) {
    throw fail("getConsignment requires assetId and a Bitcoin txid", "INVALID_PARAMS");
  }
}

/** @param {string} input */
function pairingUri(input) {
  const uri = typeof input === "string" ? input.trim() : "";
  try {
    if (uri.length > 16384 || !/^wc:[0-9a-f]{64}@2\?/i.test(uri)) throw new Error();
    const parsed = parseUri(uri);
    const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
    if (
      parsed.version !== 2 ||
      !/^[0-9a-f]{64}$/i.test(parsed.topic) ||
      !/^[0-9a-f]{64}$/i.test(parsed.symKey ?? "") ||
      parsed.relay.protocol !== "irn" ||
      params.getAll("symKey").length !== 1 ||
      params.getAll("relay-protocol").length !== 1 ||
      params.getAll("expiryTimestamp").length > 1 ||
      (params.has("expiryTimestamp") &&
        (!/^\d+$/.test(params.get("expiryTimestamp") ?? "") ||
          !Number.isSafeInteger(parsed.expiryTimestamp) ||
          /** @type {number} */ (parsed.expiryTimestamp) <= Date.now() / 1000))
    )
      throw new Error();
    return uri;
  } catch {
    throw fail("Invalid or expired WalletConnect URI", "INVALID_PARAMS");
  }
}

/** A proposal may expire while its UI is awaiting a user decision. */
/** @param {Promise<boolean>} promise @param {AbortSignal} signal */
function approvalUntilExpired(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(fail("Connection proposal expired", "NOT_ENABLED"));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** @param {import("./index.js").WalletConnectWalletOptions} options */
export function createWalletConnectWallet(options) {
  const { client, network, account } = options;
  if (hosts.has(client))
    throw fail("A WebRGB wallet adapter is already attached to this client", "INVALID_PARAMS");
  const chainId = chainFor(network);
  if (!/^[-.%a-zA-Z0-9]{1,128}$/.test(account))
    throw fail("Invalid public wallet identity", "INVALID_PARAMS");
  const methods = methodList(options.methods);
  if (!["enable", "getInfo"].every((m) => methods.includes(m)))
    throw fail("Wallet must serve enable and getInfo", "INVALID_PARAMS");
  const events = eventList(options.events ?? []);
  const walletAccount = `${chainId}:${account}`;
  let disposed = false;
  let queue = Promise.resolve();
  const revoked = new Set();
  /** @type {Map<number, {controller: AbortController, timer: ReturnType<typeof setTimeout>}>} */
  const proposals = new Map();
  /** @type {Map<string, {id: number, controller: AbortController, timer: ReturnType<typeof setTimeout>}>} */
  const activeRequests = new Map();
  /** @type {Map<string, any>} */
  const records = new Map();
  /** @type {Map<string, {fingerprint: string, expiry: number, promise: Promise<any>, controller: AbortController}>} */
  const requests = new Map();
  /** @param {unknown} error */
  const report = (error) => {
    try {
      options.onError?.(fromRpc(error));
    } catch {
      /* App error handlers must not break the queue. */
    }
  };
  /** @param {string} topic */
  const authorize = (topic) => {
    if (disposed) throw authorizationFailure("Wallet runtime is unavailable", "SUSPENDED");
    if (revoked.has(topic)) throw authorizationFailure("Session is no longer authorized", "REVOKED");
    let session;
    try {
      session = client.getActiveSessions()[topic];
    } catch {
      throw authorizationFailure("Unknown session", "REVOKED");
    }
    let allowed;
    try { allowed = grants(session, chainId); }
    catch { throw authorizationFailure("Session is no longer authorized", "REVOKED"); }
    if (!allowed.accounts.has(walletAccount))
      throw authorizationFailure("Session belongs to another wallet", "REVOKED");
    return { session, allowed };
  };
  /** @param {string} topic */
  const forget = (topic) => {
    revoked.add(topic);
    const record = records.get(topic);
    record?.controller.abort();
    for (const [key, pending] of activeRequests) {
      if (key.startsWith(`${topic}:`)) {
        pending.controller.abort();
        clearTimeout(pending.timer);
        activeRequests.delete(key);
      }
    }
    for (const [event, listener] of record?.listeners ?? [])
      record.provider?.off?.(event, listener);
    records.delete(topic);
    for (const key of requests.keys()) if (key.startsWith(`${topic}:`)) requests.delete(key);
  };
  /** @param {any} event */
  const lost = (event) => {
    forget(event.topic);
  };
  /** WalletKit exposes session expiry through its shared Core expirer. */
  /** @param {{target: string}} event */
  const expired = (event) => {
    try {
      const { topic } = parseExpirerTarget(event.target);
      if (topic) forget(topic);
    } catch {
      /* Unrelated Core target. */
    }
  };
  /** @param {{id: number}} event */
  const proposalExpired = (event) => {
    proposals.get(event.id)?.controller.abort();
  };
  /** @param {{id: number}} event */
  const requestExpired = (event) => {
    for (const pending of activeRequests.values())
      if (pending.id === event.id) pending.controller.abort();
  };
  /** @param {string} topic */
  const recordFor = async (topic) => {
    const { session } = authorize(topic);
    if (!records.has(topic)) {
      const controller = new AbortController();
      const context = {
        topic,
        network,
        origin: originOf(session.peer.metadata.url),
        signal: controller.signal,
        get requestSignal() {
          return records.get(topic)?.active?.controller.signal ?? controller.signal;
        },
        assertAuthorized() {
          if (controller.signal.aborted)
            throw authorizationFailure("Wallet runtime was suspended", revoked.has(topic) && !disposed ? "REVOKED" : "SUSPENDED");
          const { allowed, session: currentSession } = authorize(topic);
          if (originOf(currentSession.peer.metadata.url) !== context.origin)
            throw authorizationFailure("Session origin changed", "REVOKED");
          const active = records.get(topic)?.active;
          if (
            active?.controller.signal.aborted ||
            (active?.expiry ?? Infinity) <= Date.now() / 1000
          )
            throw fail("Request expired", "INVALID_PARAMS");
          if (active && !allowed.methods.has(active.method))
            throw fail("Permission was revoked", "NOT_ENABLED");
        },
      };
      const record = {
        controller,
        origin: context.origin,
        enabled: false,
        listeners: [],
        proof: null,
        provider: null,
        active: null,
        pending: Promise.resolve().then(() => options.getProvider(context)),
      };
      records.set(topic, record);
    }
    const record = records.get(topic);
    try {
      record.provider ??= await record.pending;
    } catch (error) {
      if (records.get(topic) === record) records.delete(topic);
      record.controller.abort();
      throw error;
    }
    if (record.controller.signal.aborted)
      throw authorizationFailure("Wallet runtime was suspended", revoked.has(topic) && !disposed ? "REVOKED" : "SUSPENDED");
    if (originOf(authorize(topic).session.peer.metadata.url) !== record.origin)
      throw authorizationFailure("Session origin changed", "REVOKED");
    return record;
  };
  /** @param {string} topic @param {any} record */
  const subscribe = (topic, record) => {
    if (record.listeners.length || !record.provider.on || !record.provider.off) return;
    for (const event of events) {
      const listener = (/** @type {unknown} */ data) => {
        try {
          if (!record.enabled || !authorize(topic).allowed.events.has(wire(event))) return;
          void client
            .emitSessionEvent({ topic, chainId, event: { name: wire(event), data } })
            .catch(report);
        } catch {
          /* A revoked session must stop receiving events. */
        }
      };
      record.provider.on(event, listener);
      record.listeners.push([event, listener]);
    }
  };
  /** @param {any} event */
  const propose = async (event) => {
    try {
      if (disposed) return;
      const proposal = event.params;
      if (proposal.sessionProperties?.webrgb !== RGB_WALLETCONNECT_PROFILE)
        throw fail("Unsupported WebRGB transport profile", "METHOD_NOT_SUPPORTED");
      const namespaces = buildApprovedNamespaces({
        proposal,
        supportedNamespaces: {
          rgb: {
            chains: [chainId],
            accounts: [walletAccount],
            methods: methods.map(wire),
            events: events.map(wire),
          },
        },
      });
      const selectedMethods = [
        ...new Set(Object.values(namespaces).flatMap((ns) => ns.methods)),
      ].map((m) => m.slice(4));
      const selectedEvents = [...new Set(Object.values(namespaces).flatMap((ns) => ns.events))].map(
        (e) => e.slice(4),
      );
      if (!["enable", "getInfo"].every((m) => selectedMethods.includes(m)))
        throw fail("Proposal must request enable and getInfo", "INVALID_PARAMS");
      const state = proposals.get(event.id);
      if (!state || state.controller.signal.aborted) return;
      const origin = originOf(proposal.proposer.metadata.url);
      const verified = verification(event.verifyContext, origin);
      const approval = {
        origin,
        name: proposal.proposer.metadata.name,
        network,
        methods: selectedMethods,
        events: selectedEvents,
        verification: verified,
        signal: state.controller.signal,
      };
      if (!(await approvalUntilExpired(options.approveSession(approval), state.controller.signal)))
        throw fail("Connection declined", "USER_REJECTED");
      if (disposed || (proposal.expiryTimestamp && proposal.expiryTimestamp <= Date.now() / 1000))
        throw fail("Connection proposal expired", "NOT_ENABLED");
      const approved = await client.approveSession({
        id: event.id,
        sessionProperties: PROFILE,
        namespaces,
      });
      if (disposed) {
        await client.disconnectSession({ topic: approved.topic, reason: DISCONNECT });
        return;
      }
      try {
        options.onSessionConnected?.(approved);
      } catch (error) {
        report(error);
      }
    } catch (error) {
      report(error);
      if (proposals.get(event.id)?.controller.signal.aborted) return;
      const mapped = fromRpc(error);
      const reason =
        mapped.code === "USER_REJECTED"
          ? getSdkError("USER_REJECTED")
          : mapped.code === "METHOD_NOT_SUPPORTED"
            ? getSdkError("UNSUPPORTED_METHODS")
            : { code: -32602, message: "Invalid WebRGB session proposal" };
      await client.rejectSession({ id: event.id, reason }).catch(report);
    } finally {
      const state = proposals.get(event.id);
      if (state) clearTimeout(state.timer);
      proposals.delete(event.id);
    }
  };
  /** @param {any} event */
  const onProposal = (event) => {
    // Other chains can be handled by the app's existing WalletKit integration.
    const namespaces = { ...event.params?.requiredNamespaces, ...event.params?.optionalNamespaces };
    if (!Object.keys(namespaces).some((key) => key === "rgb" || key.startsWith("rgb:"))) return;
    if (disposed || !Number.isSafeInteger(event.id) || proposals.has(event.id)) return;
    const expiry = event.params.expiryTimestamp;
    if (!Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000) {
      void client
        .rejectSession({ id: event.id, reason: { code: -32602, message: "Expired proposal" } })
        .catch(report);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(2147483647, Math.max(0, expiry * 1000 - Date.now())),
    );
    /** @type {any} */ (timer).unref?.();
    proposals.set(event.id, { controller, timer });
    queue = queue.then(() => propose(event)).catch(report);
  };

  /** @param {any} event */
  const execute = async (event) => {
    const { topic, params } = event;
    const { session, allowed } = authorize(topic);
    if (params.chainId !== chainId) throw fail("Wrong request network", "NOT_ENABLED");
    verification(event.verifyContext, originOf(session.peer.metadata.url));
    const request = params.request;
    if (
      request.expiryTimestamp !== undefined &&
      (!Number.isSafeInteger(request.expiryTimestamp) ||
        request.expiryTimestamp <= Date.now() / 1000)
    ) {
      throw fail("Request expired", "INVALID_PARAMS");
    }
    const method = request.method?.startsWith("rgb_") ? request.method.slice(4) : "";
    if (!methods.includes(method) || !allowed.methods.has(request.method))
      throw fail("Method was not approved", "METHOD_NOT_SUPPORTED");
    const args = request.params;
    if (!Array.isArray(args)) throw fail("RPC params must be a positional array", "INVALID_PARAMS");
    const zero = ["enable", "getInfo", "getAddress", "listAssets"];
    const optionalArgs = ["blindReceive", "witnessReceive", "listTransfers"];
    const min = zero.includes(method) || optionalArgs.includes(method) ? 0 : 1;
    const max = zero.includes(method) ? 0 : method === "getTransferStatus" ? 2 : 1;
    if (args.length < min || args.length > max)
      throw fail("Invalid argument count", "INVALID_PARAMS");
    if (
      method === "signMessage" &&
      (typeof args[0] !== "string" || /[\uD800-\uDFFF]/u.test(args[0]))
    )
      throw fail("message must be a well-formed Unicode string", "INVALID_PARAMS");
    const record = await recordFor(topic);
    const expiry = Math.min(session.expiry, request.expiryTimestamp ?? session.expiry);
    const pending = activeRequests.get(`${topic}:${event.id}`);
    if (!pending || pending.controller.signal.aborted || expiry <= Date.now() / 1000)
      throw fail("Request expired", "INVALID_PARAMS");
    record.active = { ...pending, expiry, method: request.method };
    const provider = record.provider;
    if (method !== "enable" && !record.enabled)
      throw authorizationFailure("Call enable() first", "SUSPENDED");
    if (typeof provider[method] !== "function")
      throw fail("Wallet does not serve this method", "METHOD_NOT_SUPPORTED");
    // Check again after asynchronous provider construction and before delegating.
    if (!authorize(topic).allowed.methods.has(request.method))
      throw fail("Permission was revoked", "NOT_ENABLED");
    let result;
    if (method === "enable") {
      await provider.enable();
      authorize(topic);
      record.enabled = true;
      subscribe(topic, record);
      result = null;
    } else if (method === "getInfo") {
      const info = await provider.getInfo();
      result = infoFor(info, network, authorize(topic).allowed);
      result.methods = result.methods.filter(
        (/** @type {string} */ m) => typeof provider[m] === "function",
      );
    } else if (method === "getConsignment") {
      const part = args[0];
      proofArgs(part);
      if (
        !Number.isSafeInteger(part.offset) ||
        part.offset < 0 ||
        !Number.isSafeInteger(part.length) ||
        part.length < 1 ||
        part.length > CHUNK_BYTES
      ) {
        throw fail("Invalid consignment chunk range", "INVALID_PARAMS");
      }
      const key = `${part.assetId}:${part.txid}`;
      if (part.offset === 0 || record.proof?.key !== key) {
        const proof = await provider.getConsignment({ assetId: part.assetId, txid: part.txid });
        record.proof = {
          key,
          bytes: validateProof(proof, part),
          digest: { algorithm: "keccak256", value: proof.digest.value.toLowerCase() },
        };
      }
      const { bytes, digest } = record.proof;
      if (part.offset >= bytes.length)
        throw fail("Offset exceeds consignment length", "INVALID_PARAMS");
      const end = Math.min(part.offset + part.length, bytes.length);
      result = {
        assetId: part.assetId,
        txid: part.txid,
        encoding: "base64",
        data: encode(bytes.subarray(part.offset, end)),
        byteLength: bytes.length,
        digest,
        offset: part.offset,
        nextOffset: end === bytes.length ? null : end,
      };
      if (end === bytes.length) record.proof = null;
    } else {
      result = await provider[method](...args);
    }
    authorize(topic);
    return result ?? null;
  };
  /** @param {any} event */
  const onRequest = (event) => {
    if (disposed || !Number.isSafeInteger(event.id) || typeof event.topic !== "string") return;
    if (
      client.getActiveSessions()[event.topic]?.sessionProperties?.webrgb !==
      RGB_WALLETCONNECT_PROFILE
    )
      return;
    const key = `${event.topic}:${event.id}`;
    const respond = (/** @type {any} */ response) =>
      client.respondSessionRequest({ topic: event.topic, response }).catch(report);
    const errorResponse = (/** @type {unknown} */ error) => {
      const mapped = fromRpc(error);
      return {
        id: event.id,
        jsonrpc: "2.0",
        error: {
          code:
            mapped.code === "USER_REJECTED"
              ? getSdkError("USER_REJECTED").code
              : mapped.code === "INVALID_PARAMS"
                ? -32602
                : mapped.code === "METHOD_NOT_SUPPORTED"
                  ? -32601
                  : mapped.code === "NOT_ENABLED"
                    ? getSdkError("UNAUTHORIZED_METHOD").code
                    : mapped.code === "INTERNAL_ERROR"
                      ? -32603
                      : -32000,
          message: mapped.message,
          data: mapped.code,
          ...(mapped.authorization ? { authorization: mapped.authorization } : {}),
        },
      };
    };
    let fingerprint;
    try {
      const { session, allowed } = authorize(event.topic);
      if (!allowed.methods.has(event.params?.request?.method))
        throw fail("Method was not approved", "METHOD_NOT_SUPPORTED");
      if (event.params?.chainId !== chainId) throw fail("Wrong request network", "NOT_ENABLED");
      verification(event.verifyContext, originOf(session.peer.metadata.url));
      const expires = event.params?.request?.expiryTimestamp;
      if (expires !== undefined && (!Number.isSafeInteger(expires) || expires <= Date.now() / 1000))
        throw fail("Request expired", "INVALID_PARAMS");
      fingerprint = JSON.stringify(event.params);
      const existing = requests.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw fail("RPC id was reused with different arguments", "INVALID_PARAMS");
        void existing.promise
          .then(async (response) => {
            authorize(event.topic);
            if (!existing.controller.signal.aborted && existing.expiry > Date.now() / 1000)
              await respond(response);
          })
          .catch(report);
        return;
      }
      for (const [id, pending] of requests)
        if (pending.expiry <= Date.now() / 1000) requests.delete(id);
      if (requests.size >= 512) throw fail("Too many pending wallet requests");
    } catch (error) {
      void respond(errorResponse(error));
      return;
    }
    const controller = new AbortController();
    const expiry = Math.min(
      event.params.request.expiryTimestamp ?? Math.floor(Date.now() / 1000) + 300,
      client.getActiveSessions()[event.topic].expiry,
    );
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(2147483647, Math.max(0, expiry * 1000 - Date.now())),
    );
    /** @type {any} */ (timer).unref?.();
    activeRequests.set(key, { id: event.id, controller, timer });
    const promise = queue.then(async () => {
      try {
        return { id: event.id, jsonrpc: "2.0", result: await execute(event) };
      } catch (error) {
        return errorResponse(error);
      } finally {
        clearTimeout(timer);
        activeRequests.delete(key);
        const record = records.get(event.topic);
        if (record?.active?.id === event.id) record.active = null;
      }
    });
    requests.set(key, { fingerprint, expiry, promise, controller });
    const sensitive = [
      "rgb_blindReceive",
      "rgb_witnessReceive",
      "rgb_burnAsset",
      "rgb_sendAsset",
      "rgb_issueAsset",
      "rgb_makeLnInvoice",
      "rgb_payLnInvoice",
    ];
    queue = promise
      .then(async (response) => {
        if (!sensitive.includes(event.params.request.method)) requests.delete(key);
        if (!disposed && !revoked.has(event.topic) && !controller.signal.aborted)
          await respond(response);
      })
      .catch(report);
  };
  hosts.add(client);
  client.on("session_proposal", onProposal);
  client.on("session_request", onRequest);
  client.on("session_delete", lost);
  client.on("proposal_expire", proposalExpired);
  client.on("session_request_expire", requestExpired);
  client.core.expirer.on("expirer_expired", expired);
  return {
    async pair(/** @type {string} */ uri) {
      if (disposed) throw fail("Wallet adapter is disposed", "NOT_ENABLED");
      await client.pair({ uri: pairingUri(uri) });
    },
    async disconnect(/** @type {string} */ topic) {
      authorize(topic);
      forget(topic);
      await client.disconnectSession({ topic, reason: DISCONNECT });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      client.off("session_proposal", onProposal);
      client.off("session_request", onRequest);
      client.off("session_delete", lost);
      client.off("proposal_expire", proposalExpired);
      client.off("session_request_expire", requestExpired);
      client.core.expirer.off("expirer_expired", expired);
      for (const state of proposals.values()) {
        state.controller.abort();
        clearTimeout(state.timer);
      }
      proposals.clear();
      for (const state of activeRequests.values()) {
        state.controller.abort();
        clearTimeout(state.timer);
      }
      activeRequests.clear();
      for (const topic of records.keys()) forget(topic);
      requests.clear();
      hosts.delete(client);
    },
  };
}
