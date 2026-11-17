// Runtime behaviour across a JSON-serialized dApp/wallet boundary.
// The declarations are checked separately by tsc; no live relay is required.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { formatJsonRpcError } from "@walletconnect/jsonrpc-utils";
import {
  connectWalletConnect,
  createWalletConnectProvider,
  createWalletConnectWallet,
  CONSIGNMENT_CHUNK_BYTES,
  MAX_CONSIGNMENT_BYTES,
  RGB_WALLETCONNECT_PROFILE,
  RGB_WALLETCONNECT_METHODS,
} from "@utexo/webrgb-walletconnect";
import { receiveProof, validateProof } from "../walletconnect-proof.js";

const network = "regtest";
const assetId = "rgb:test-asset";
const txid = "ab".repeat(32);
const uri = `wc:${"12".repeat(32)}@2?relay-protocol=irn&symKey=${"34".repeat(32)}`;
const origin = "https://mint.example";
const verified = { verified: { validation: "VALID", origin } };
const burnArgs = {
  network,
  assetId,
  amount: "5",
  burnDestination: { chainId: "eip155:1", address: `0x${"56".repeat(20)}`, dstEid: 30101 },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function proofFixture(size = CONSIGNMENT_CHUNK_BYTES * 2 + 7) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  return {
    assetId,
    txid,
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
    byteLength: size,
    digest: {
      algorithm: "keccak256",
      value: `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`,
    },
  };
}

// A SignClient-to-WalletKit boundary: each request/response is JSON-serialized just
// as it is on the relay. No relay credentials, native wallet or funds involved.
function transport() {
  const accepted = deferred();
  const pending = new Map();
  const calls = [],
    responses = [];
  let nextId = 100,
    proposal;
  const dapp = client(),
    wallet = client();
  function client() {
    const emitter = new EventEmitter(),
      expirer = new EventEmitter(),
      sessions = new Map();
    return {
      emitter,
      sessions,
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      session: {
        get(topic) {
          if (!sessions.has(topic)) throw new Error("Missing session");
          return sessions.get(topic);
        },
        getAll: () => [...sessions.values()],
      },
      core: { expirer, relayer: new EventEmitter(), pairing: { async disconnect() {} } },
      async disconnect({ topic }) {
        for (const c of [dapp, wallet]) {
          c.sessions.delete(topic);
          c.emitter.emit("session_delete", { topic });
        }
      },
    };
  }
  dapp.connect = async (args) => {
    proposal = {
      id: 1,
      verifyContext: verified,
      params: {
        ...args,
        expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
        proposer: { metadata: { name: "Mint", url: `${origin}/mint` } },
      },
    };
    return { uri, approval: () => accepted.promise };
  };
  dapp.request = async (args) => {
    const id = ++nextId,
      result = deferred();
    pending.set(id, result);
    const event = JSON.parse(
      JSON.stringify({
        id,
        topic: args.topic,
        verifyContext: verified,
        params: {
          chainId: args.chainId,
          request: { ...args.request, expiryTimestamp: Math.floor(Date.now() / 1000) + 300 },
        },
      }),
    );
    calls.push(event);
    wallet.emitter.emit("session_request", event);
    return result.promise;
  };
  wallet.pair = async () => wallet.emitter.emit("session_proposal", proposal);
  wallet.approveSession = async (args) => {
    const common = {
      topic: "session",
      expiry: Math.floor(Date.now() / 1000) + 3600,
      namespaces: args.namespaces,
      sessionProperties: args.sessionProperties,
    };
    const session = {
      ...common,
      peer: { metadata: { name: "Wallet", url: "https://wallet.example" } },
    };
    dapp.sessions.set(common.topic, session);
    wallet.sessions.set(common.topic, { ...common, peer: proposal.params.proposer });
    accepted.resolve(session);
    return wallet.session.get(common.topic);
  };
  wallet.getActiveSessions = () => Object.fromEntries(wallet.sessions);
  wallet.disconnectSession = wallet.disconnect;
  wallet.rejectSession = async ({ reason }) => accepted.reject(reason);
  wallet.respondSessionRequest = async ({ response }) => {
    response = JSON.parse(JSON.stringify(response));
    responses.push(response);
    const request = pending.get(response.id);
    if (request) {
      pending.delete(response.id);
      response.error ? request.reject(response.error) : request.resolve(response.result);
    }
  };
  wallet.emitSessionEvent = async ({ topic, chainId, event }) =>
    dapp.emitter.emit("session_event", { topic, params: { chainId, event } });
  return {
    dapp,
    wallet,
    calls,
    responses,
    get proposal() {
      return proposal;
    },
  };
}
async function fixture(t, overrides = {}, connectOptions = {}) {
  const bus = transport(),
    backendEvents = new EventEmitter();
  const counts = { enable: 0, receive: 0, burn: 0, proof: 0 };
  const proof = proofFixture();
  let context, approval;
  const backend = {
    async enable() {
      counts.enable++;
    },
    async getInfo() {
      return {
        ready: true,
        network,
        protocol: "RGB_L1",
        methods: Object.keys(backend).filter((m) => typeof backend[m] === "function"),
      };
    },
    async blindReceive(args) {
      counts.receive++;
      return { invoice: "rgb:invoice", recipientId: "utxob:seal", minConfirmations: 3, ...args };
    },
    async witnessReceive(args) {
      counts.receive++;
      return { invoice: "rgb:witness", recipientId: "wvout:script", minConfirmations: 3, ...args };
    },
    async burnAsset(args) {
      counts.burn++;
      return { ...args, txid, transferId: 10, status: "WaitingConfirmations", minConfirmations: 3 };
    },
    async getConsignment() {
      counts.proof++;
      return proof;
    },
    async listAssets() {
      return [{ id: assetId, balance: 10 }];
    },
    async listTransfers() {
      return [];
    },
    on: backendEvents.on.bind(backendEvents),
    off: backendEvents.off.bind(backendEvents),
  };
  const options = {
    client: bus.wallet,
    network,
    account: "public-wallet-id",
    methods: [
      "enable",
      "getInfo",
      "blindReceive",
      "witnessReceive",
      "burnAsset",
      "getConsignment",
      "getReceivedMint",
      "listAssets",
      "listTransfers",
    ],
    events: ["transferReceived", "transferSettled"],
    approveSession: async (value) => {
      approval = value;
      return true;
    },
    getProvider: (value) => {
      context = value;
      return backend;
    },
    ...overrides,
  };
  const host = createWalletConnectWallet(options);
  const connection = await connectWalletConnect({
    client: bus.dapp,
    network,
    optionalMethods: options.methods,
    events: options.events,
    ...connectOptions,
  });
  t.after(() => {
    host.dispose();
    for (const name of bus.dapp.emitter.eventNames()) bus.dapp.emitter.removeAllListeners(name);
  });
  async function connect() {
    await host.pair(connection.uri);
    return connection.approval();
  }
  return {
    bus,
    host,
    connection,
    backend,
    backendEvents,
    counts,
    proof,
    options,
    connect,
    get context() {
      return context;
    },
    get approval() {
      return approval;
    },
  };
}
const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  return true;
};

describe("message signing", () => {
  const methods = ["enable", "getInfo", "signMessage"];

  it("passes messages and signatures unchanged across the JSON boundary", async (t) => {
    const f = await fixture(t, { methods }), seen = [], result = { signature: "mock-signature" };
    f.backend.signMessage = async (message) => { seen.push(message); return result; };
    const provider = await f.connect();
    await provider.enable();
    assert.deepEqual(seen, []);
    assert.ok((await provider.getInfo()).methods.includes("signMessage"));
    const messages = ["  Test message e\u0301\r\n", ""];
    for (const message of messages) {
      assert.deepEqual(await provider.signMessage(message), result);
      assert.equal(f.bus.calls.at(-1).params.request.method, "rgb_signMessage");
      assert.deepEqual(f.bus.calls.at(-1).params.request.params, [message]);
    }
    assert.deepEqual(seen, messages);
  });

  it("requires signing permission in the session", async (t) => {
    const f = await fixture(t, { methods }, { optionalMethods: [] });
    f.backend.signMessage = async () => { throw new Error("signer must not run"); };
    const provider = await f.connect();
    await provider.enable();
    assert.equal((await provider.getInfo()).methods.includes("signMessage"), false);
    await assert.rejects(provider.signMessage("hello"), code("METHOD_NOT_SUPPORTED"));
  });

  it("validates arguments and forwards user rejection", async (t) => {
    const f = await fixture(t, { methods });
    let prompts = 0;
    f.backend.signMessage = async () => {
      prompts++;
      throw Object.assign(new Error("Signing declined"), { code: "USER_REJECTED" });
    };
    const provider = await f.connect();
    await provider.enable();
    for (const message of [undefined, null, 1, "\ud800"]) {
      await assert.rejects(provider.signMessage(message), code("INVALID_PARAMS"));
    }
    assert.equal(prompts, 0);
    await assert.rejects(provider.signMessage("hello"), code("USER_REJECTED"));
    assert.equal(prompts, 1);
  });
});

describe("WalletConnect transport", () => {
  it("dApp connects, enables and receives an invoice through the wallet", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    assert.equal(f.connection.uri, uri);
    assert.equal(f.counts.enable, 0);
    await assert.rejects(provider.listAssets(), code("NOT_ENABLED"));
    await Promise.all([provider.enable(), provider.enable()]);
    assert.equal(f.counts.enable, 1);
    assert.equal(f.context.origin, origin);
    assert.equal(f.approval.verification, "VALID");
    const invoice = await provider.blindReceive({ assetId, amount: 5 });
    assert.equal(invoice.assetId, assetId);
    assert.equal(invoice.amount, 5);
    await provider.blindReceive(undefined);
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, []);
    assert.deepEqual(await provider.listAssets(), [{ id: assetId, balance: 10 }]);
    assert.ok((await provider.getInfo()).methods.includes("burnAsset"));
    await assert.rejects(provider.payLnInvoice({ invoice: "ln:x" }), code("METHOD_NOT_SUPPORTED"));
  });

  it("serves witness invoices with optional arguments and deduplicates requests", async (t) => {
    const f = await fixture(t, {}, { methods: ["witnessReceive"], optionalMethods: [] }),
      provider = await f.connect();
    await assert.rejects(provider.witnessReceive(), code("NOT_ENABLED"));
    await provider.enable();
    assert.ok((await provider.getInfo()).methods.includes("witnessReceive"));
    const args = { assetId, amount: 5, durationSeconds: 900, minConfirmations: 6 };
    const invoice = await provider.witnessReceive(args);
    assert.deepEqual(invoice, { invoice: "rgb:witness", recipientId: "wvout:script", ...args });
    const event = f.bus.calls.at(-1);
    assert.equal(event.params.request.method, "rgb_witnessReceive");
    assert.deepEqual(event.params.request.params, [args]);
    f.bus.wallet.emitter.emit("session_request", event);
    await tick();
    assert.equal(f.counts.receive, 1);
    assert.deepEqual(f.bus.responses.at(-1).result, invoice);
    await provider.witnessReceive();
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, []);
    await provider.witnessReceive(undefined);
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, []);
  });

  it("burn arguments pass unchanged; proof chunks reconstruct the exact bytes", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    assert.equal((await provider.getInfo()).burnRecipientNamespaces, undefined);
    const burn = await provider.burnAsset(burnArgs);
    assert.equal(burn.txid, txid);
    assert.equal(f.counts.burn, 1);
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, [burnArgs]);
    const proof = await provider.getConsignment({ assetId, txid });
    assert.deepEqual(proof, f.proof);
    assert.equal(f.counts.proof, 1);
    const chunks = f.bus.calls.filter((e) => e.params.request.method === "rgb_getConsignment");
    assert.deepEqual(
      chunks.map((e) => e.params.request.params[0].offset),
      [0, CONSIGNMENT_CHUNK_BYTES, CONSIGNMENT_CHUNK_BYTES * 2],
    );
    assert.ok(
      f.bus.responses
        .filter((e) => e.result?.encoding)
        .every((e) => e.result.data.length <= (CONSIGNMENT_CHUNK_BYTES / 3) * 4),
    );
  });

  it("preserves burn destinations and namespace capabilities on RGB sessions", async (t) => {
    const f = await fixture(t);
    const getInfo = f.backend.getInfo;
    const namespaces = ["eip155", "tron", "cosmos"];
    f.backend.getInfo = async () => ({ ...await getInfo(), burnRecipientNamespaces: namespaces });
    const provider = await f.connect();
    await provider.enable();
    assert.deepEqual((await provider.getInfo()).burnRecipientNamespaces, namespaces);
    assert.deepEqual(Object.keys(f.bus.dapp.session.get(provider.topic).namespaces), ["rgb"]);
    const recipients = [
      burnArgs.burnDestination,
      { chainId: "tron:728126428", address: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL", dstEid: 30420 },
      { chainId: "cosmos:cosmoshub-4", address: "cosmos1t2uflqwqe0fsj0shcfkrvpukewcw40yjj6hdc0", dstEid: 1 },
    ];
    for (const burnDestination of recipients) {
      const args = { ...burnArgs, burnDestination };
      const burn = await provider.burnAsset(args);
      assert.deepEqual(burn.burnDestination, burnDestination);
      const event = f.bus.calls.at(-1);
      assert.equal(event.params.chainId, "rgb:regtest");
      assert.equal(event.params.request.method, "rgb_burnAsset");
      assert.deepEqual(event.params.request.params, [args]);
    }
    assert.equal(f.counts.burn, recipients.length);
  });

  it("optional capabilities are filtered by session grants", async (t) => {
    const f = await fixture(t, {}, { methods: ["blindReceive"], optionalMethods: [], events: [] });
    const provider = await f.connect();
    await provider.enable();
    assert.deepEqual((await provider.getInfo()).methods.sort(), [
      "blindReceive",
      "enable",
      "getInfo",
    ]);
    await assert.rejects(provider.burnAsset(burnArgs), code("METHOD_NOT_SUPPORTED"));
    assert.equal(f.counts.burn, 0);
    assert.throws(() => provider.on("transferSettled", () => {}), code("METHOD_NOT_SUPPORTED"));
  });

  it("wallet rejection and WebRGB error codes reach the dApp", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    for (const errorCode of ["USER_REJECTED", "INVALID_PARAMS", "ASSET_NOT_FOUND"]) {
      f.backend.burnAsset = async () => {
        throw Object.assign(new Error("declined"), { code: errorCode });
      };
      await assert.rejects(provider.burnAsset(burnArgs), code(errorCode));
      if (errorCode === "USER_REJECTED") assert.equal(f.bus.responses.at(-1).error.code, 5000);
      if (errorCode === "INVALID_PARAMS") assert.equal(f.bus.responses.at(-1).error.code, -32602);
    }
    assert.equal(f.bus.responses.at(-1).error.data, "ASSET_NOT_FOUND");
    assert.equal(f.bus.calls.filter((e) => e.params.request.method === "rgb_burnAsset").length, 3);
  });

  for (const problem of [
    "declined",
    "invalid",
    "scam",
    "origin",
    "network",
    "method",
    "profile",
    "expired",
  ]) {
    it(`connection rejects ${problem} before provider construction`, async (t) => {
      let constructed = false;
      const f = await fixture(t, {
        approveSession: async () => problem !== "declined",
        getProvider: () => {
          constructed = true;
          throw new Error("unexpected");
        },
      });
      const proposal = f.bus.proposal;
      if (problem === "invalid")
        proposal.verifyContext = { verified: { validation: "INVALID", origin } };
      if (problem === "scam")
        proposal.verifyContext = { verified: { validation: "UNKNOWN", isScam: true } };
      if (problem === "origin")
        proposal.verifyContext = {
          verified: { validation: "VALID", origin: "https://different.example" },
        };
      if (problem === "network") proposal.params.requiredNamespaces.rgb.chains = ["rgb:signet"];
      if (problem === "method") proposal.params.requiredNamespaces.rgb.methods.push("rgb_missing");
      if (problem === "profile") proposal.params.sessionProperties = {};
      if (problem === "expired") proposal.params.expiryTimestamp = 1;
      await assert.rejects(f.connect());
      assert.equal(constructed, false);
      assert.equal(f.bus.wallet.sessions.size, 0);
    });
  }

  it("unknown verification is visible to the wallet's approval UI", async (t) => {
    const f = await fixture(t);
    f.bus.proposal.verifyContext = undefined;
    await f.connect();
    assert.equal(f.approval.verification, "UNKNOWN");
  });

  it("cancel rejects locally and disconnects a late approval", async (t) => {
    const prompt = deferred(),
      entered = deferred();
    const f = await fixture(t, {
      approveSession: async () => {
        entered.resolve();
        return prompt.promise;
      },
    });
    await f.host.pair(uri);
    await entered.promise;
    await f.connection.cancel();
    await assert.rejects(f.connection.approval(), code("USER_REJECTED"));
    prompt.resolve(true);
    await tick();
    assert.equal(f.bus.dapp.sessions.size, 0);
  });

  it("events stop on disposal; a stored session can be restored", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    const seen = [],
      listener = (event) => seen.push(event);
    provider.on("transferSettled", listener);
    f.backendEvents.emit("transferSettled", { transferId: 1 });
    assert.deepEqual(seen, [{ transferId: 1 }]);
    provider.off("transferSettled", listener);
    f.backendEvents.emit("transferSettled", { transferId: 2 });
    assert.equal(seen.length, 1);
    provider.dispose();
    assert.equal(f.bus.dapp.emitter.listenerCount("session_event"), 0);
    const restored = createWalletConnectProvider({
      client: f.bus.dapp,
      topic: provider.topic,
      network,
    });
    t.after(() => restored.dispose());
    await assert.rejects(restored.getInfo(), code("NOT_ENABLED"));
    await restored.enable();
    assert.equal(f.counts.enable, 2);
    await restored.disconnect();
    assert.equal(f.context.signal.aborted, true);
    assert.equal(f.backendEvents.listenerCount("transferSettled"), 0);
  });

  for (const event of ["session_delete", "session_expire"]) {
    it(`${event} revokes dApp and wallet access`, async (t) => {
      const f = await fixture(t),
        provider = await f.connect();
      await provider.enable();
      f.bus.dapp.emitter.emit(event, { topic: provider.topic });
      if (event === "session_delete") f.bus.wallet.emitter.emit(event, { topic: provider.topic });
      else f.bus.wallet.core.expirer.emit("expirer_expired", { target: `topic:${provider.topic}` });
      assert.equal(provider.enabled, false);
      assert.equal(f.context.signal.aborted, true);
      await assert.rejects(provider.burnAsset(burnArgs), code("NOT_ENABLED"));
      assert.equal(f.counts.burn, 0);
    });
  }

  it("stored expiry and account are checked even without a lifecycle event", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    f.bus.wallet.session.get(provider.topic).namespaces.rgb.accounts = [
      "rgb:regtest:another-wallet",
    ];
    await assert.rejects(provider.burnAsset(burnArgs), code("NOT_ENABLED"));
    f.bus.dapp.session.get(provider.topic).expiry = 1;
    await assert.rejects(provider.getInfo(), code("NOT_ENABLED"));
    assert.equal(f.counts.burn, 0);
  });

  it("duplicate JSON-RPC delivery executes a burn once and rejects changed args", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    const pending = provider.burnAsset(burnArgs),
      event = f.bus.calls.at(-1);
    f.bus.wallet.emitter.emit("session_request", event);
    await pending;
    await tick();
    f.bus.wallet.emitter.emit("session_request", event);
    await tick();
    assert.equal(f.counts.burn, 1);
    assert.equal(f.bus.responses.filter((r) => r.id === event.id).length, 3);
    f.bus.wallet.emitter.emit("session_request", {
      ...event,
      params: {
        ...event.params,
        request: { ...event.params.request, params: [{ ...burnArgs, amount: "9" }] },
      },
    });
    await tick();
    assert.equal(f.bus.responses.at(-1).error.data, "INVALID_PARAMS");
    assert.equal(f.counts.burn, 1);
  });

  it("failed delivery retains the burn result without retrying the native call", async (t) => {
    const reported = [],
      f = await fixture(t, { onError: (error) => reported.push(error) });
    const provider = await f.connect();
    await provider.enable();
    const respond = f.bus.wallet.respondSessionRequest;
    f.bus.wallet.respondSessionRequest = async () => {
      throw new Error("relay unavailable");
    };
    const result = provider.burnAsset(burnArgs),
      event = f.bus.calls.at(-1);
    await tick();
    assert.equal(reported.length, 1);
    assert.equal(f.counts.burn, 1);
    f.bus.wallet.respondSessionRequest = respond;
    f.bus.wallet.emitter.emit("session_request", event);
    assert.equal((await result).txid, txid);
    assert.equal(f.counts.burn, 1);
  });

  it("wallet can recheck authorization after a confirmation prompt", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    const prompt = deferred(),
      entered = deferred();
    f.backend.burnAsset = async () => {
      entered.resolve();
      await prompt.promise;
      f.context.assertAuthorized();
      f.counts.burn++;
    };
    const result = provider.burnAsset(burnArgs);
    await entered.promise;
    f.bus.wallet.session.get(provider.topic).expiry = 1;
    prompt.resolve();
    await assert.rejects(result, code("NOT_ENABLED"));
    assert.equal(f.counts.burn, 0);
  });

  it("raw requests cannot bypass enable, network, origin, expiry or grants", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    const raw = (method, params = []) =>
      f.bus.dapp.request({
        topic: provider.topic,
        chainId: "rgb:regtest",
        request: { method, params },
      });
    await assert.rejects(raw("rgb_burnAsset", [burnArgs]), (e) => e.data === "NOT_ENABLED");
    await provider.enable();
    await assert.rejects(raw("rgb_missing"), (e) => e.data === "METHOD_NOT_SUPPORTED");
    await assert.rejects(raw("rgb_listAssets", [{}]), (e) => e.data === "INVALID_PARAMS");
    await assert.rejects(
      raw("rgb_getConsignment", [
        { assetId, txid, offset: 0, length: CONSIGNMENT_CHUNK_BYTES + 1 },
      ]),
      (e) => e.data === "INVALID_PARAMS",
    );
    await assert.rejects(
      f.bus.dapp.request({
        topic: provider.topic,
        chainId: "rgb:signet",
        request: { method: "rgb_burnAsset", params: [burnArgs] },
      }),
      (e) => e.data === "NOT_ENABLED",
    );
    const base = {
      id: 999,
      topic: provider.topic,
      params: { chainId: "rgb:regtest", request: { method: "rgb_burnAsset", params: [burnArgs] } },
    };
    f.bus.wallet.emitter.emit("session_request", {
      ...base,
      verifyContext: { verified: { validation: "INVALID" } },
    });
    await tick();
    assert.equal(f.bus.responses.at(-1).error.data, "NOT_ENABLED");
    f.bus.wallet.emitter.emit("session_request", {
      ...base,
      params: { ...base.params, request: { ...base.params.request, expiryTimestamp: 1 } },
    });
    await tick();
    assert.equal(f.bus.responses.at(-1).error.data, "INVALID_PARAMS");
    assert.equal(f.counts.burn, 0);
    assert.equal(f.counts.proof, 0);
  });

  it("one wallet host per client and strict pairing URI parsing", async (t) => {
    const f = await fixture(t);
    assert.throws(() => createWalletConnectWallet(f.options), code("INVALID_PARAMS"));
    for (const invalid of [
      "rgb:invoice",
      "wc:x@2",
      uri + "&symKey=" + "ab".repeat(32),
      uri + "&expiryTimestamp=1",
    ]) {
      await assert.rejects(f.host.pair(invalid), code("INVALID_PARAMS"));
    }
    await assert.rejects(
      f.host.pair(`mywallet://connect?uri=${encodeURIComponent(uri)}`),
      code("INVALID_PARAMS"),
    );
    await f.host.pair(uri);
    await f.connection.approval();
    f.host.dispose();
    assert.equal(f.bus.wallet.emitter.listenerCount("session_request"), 0);
    createWalletConnectWallet(f.options).dispose();
  });

  for (const corruption of ["identity", "size", "offset", "range", "base64", "digest", "changed"]) {
    it(`proof reception rejects ${corruption} corruption`, async () => {
      const proof = proofFixture(),
        bytes = Buffer.from(proof.data, "base64");
      await assert.rejects(
        receiveProof({ assetId, txid }, async ({ offset, length }) => {
          const end = Math.min(offset + length, bytes.length);
          const part = {
            ...proof,
            data: bytes.subarray(offset, end).toString("base64"),
            offset,
            nextOffset: end === bytes.length ? null : end,
          };
          if (corruption === "identity") part.txid = "cd".repeat(32);
          if (corruption === "size") part.byteLength = MAX_CONSIGNMENT_BYTES + 1;
          if (corruption === "offset") part.offset++;
          if (corruption === "range") part.nextOffset = 0;
          if (corruption === "base64") part.data = "!!!!";
          if (corruption === "digest" || (corruption === "changed" && offset > 0))
            part.digest = { algorithm: "keccak256", value: "0x" + "00".repeat(32) };
          return part;
        }),
        code("INTERNAL_ERROR"),
      );
    });
  }

  it("proof validation handles large Base64 and rejects noncanonical padding", () => {
    const proof = proofFixture(2 * 1024 * 1024 + 1);
    assert.equal(validateProof(proof, { assetId, txid }).length, proof.byteLength);
    const one = proofFixture(1);
    assert.throws(
      () => validateProof({ ...one, data: "AB==" }, { assetId, txid }),
      code("INTERNAL_ERROR"),
    );
  });

  it("a transient provider initialization failure can be retried", async (t) => {
    let attempts = 0;
    const f = await fixture(t, {
      getProvider: () => {
        if (++attempts === 1) throw new Error("wallet locked");
        return f.backend;
      },
    });
    const provider = await f.connect();
    await assert.rejects(provider.enable(), code("INTERNAL_ERROR"));
    await provider.enable();
    assert.equal(attempts, 2);
    assert.equal(f.counts.enable, 1);
  });

  it("can be enabled again when the wallet loses its enabled state", async (t) => {
    const f = await fixture(t),
      provider = await f.connect(),
      request = f.bus.dapp.request.bind(f.bus.dapp);
    let walletEnabled = true;
    f.bus.dapp.request = async (args) => {
      if (args.request.method === "rgb_enable") walletEnabled = true;
      else if (!walletEnabled) throw { code: 3001, message: "Call enable() first" };
      return request(args);
    };

    await provider.enable();
    walletEnabled = false;
    assert.equal((await provider.getInfo()).ready, true);
    assert.equal(provider.enabled, true);
    assert.equal(walletEnabled, true);
    assert.equal(f.bus.calls.filter((call) => call.params.request.method === "rgb_enable").length, 2);
  });

  it("resumes a real stored wallet adapter without manual enable or new pairing", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    f.host.dispose();
    const resumed = createWalletConnectWallet(f.options);
    t.after(() => resumed.dispose());
    assert.equal(provider.enabled, true); // Browser cannot see a runtime replacement yet.
    assert.equal((await provider.getInfo()).ready, true);
    assert.equal(f.counts.enable, 2);
    assert.equal(f.bus.responses.find((response) => response.error)?.error.authorization, "SUSPENDED");
    assert.equal(f.bus.dapp.sessions.size, 1);
    assert.deepEqual(f.bus.calls.slice(-3).map((e) => e.params.request.method),
      ["rgb_getInfo", "rgb_enable", "rgb_getInfo"]);
  });

  it("coalesces concurrent recovery handshakes and bounds a rejected read to one retry", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const raw = f.bus.dapp.request.bind(f.bus.dapp), pending = deferred();
    let enabled = false, handshakes = 0, reads = 0;
    f.bus.dapp.request = async (args) => {
      if (args.request.method === "rgb_enable") { handshakes++; await pending.promise; enabled = true; }
      if (args.request.method === "rgb_getInfo") { reads++; if (!enabled) throw { code: 3001 }; }
      return raw(args);
    };
    const a = provider.getInfo(), b = provider.getInfo();
    await tick();
    assert.equal(handshakes, 1);
    pending.resolve();
    await Promise.all([a, b]);
    assert.equal(reads, 4);
    assert.equal(handshakes, 1);
    f.bus.dapp.request = async ({ request }) => {
      if (request.method === "rgb_getInfo") { reads++; throw { code: 3001 }; }
      handshakes++;
      return null;
    };
    const beforeReads = reads, beforeHandshakes = handshakes;
    await assert.rejects(provider.getInfo(), code("NOT_ENABLED"));
    assert.equal(reads - beforeReads, 2);
    assert.equal(handshakes - beforeHandshakes, 1);
    assert.equal(provider.enabled, false);
  });

  it("does not replay mutating methods, even when the wallet reports NOT_ENABLED", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const raw = f.bus.dapp.request.bind(f.bus.dapp);
    for (const [method, args] of [["burnAsset", [burnArgs]], ["blindReceive", []], ["witnessReceive", []]]) {
      await provider.enable();
      let calls = 0, enables = 0;
      f.bus.dapp.request = async (request) => {
        if (request.request.method === `rgb_${method}`) { calls++; throw { code: 3001 }; }
        enables++;
        return raw(request);
      };
      await assert.rejects(provider[method](...args), code("NOT_ENABLED"));
      assert.equal(calls, 1);
      assert.equal(enables, 0);
      assert.equal(provider.enabled, false);
      f.bus.dapp.request = raw;
    }
    assert.equal(f.counts.burn, 0);
    assert.equal(f.counts.receive, 0);
  });

  it("does not recover relay errors or permanently rejected enable by repeating a read", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const raw = f.bus.dapp.request.bind(f.bus.dapp);
    let calls = 0;
    f.bus.dapp.request = async () => { calls++; throw new Error("Relay offline"); };
    await assert.rejects(provider.getInfo(), /Relay offline/);
    assert.equal(calls, 1);
    f.bus.dapp.request = raw;
    f.host.dispose();
    const resumed = createWalletConnectWallet({ ...f.options, getProvider: () => ({
      ...f.backend, enable: async () => { throw Object.assign(new Error("Grant revoked"), { code: "NOT_ENABLED" }); },
    }) });
    t.after(() => resumed.dispose());
    const start = f.bus.calls.length;
    await assert.rejects(provider.getInfo(), code("NOT_ENABLED"));
    assert.deepEqual(f.bus.calls.slice(start).map((e) => e.params.request.method), ["rgb_getInfo", "rgb_enable"]);
    assert.equal(provider.enabled, false);
  });

  it("enable always revalidates the wallet grant, while simultaneous callers share one handshake", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    await Promise.all([provider.enable(), provider.enable(), provider.enable()]);
    assert.equal(f.counts.enable, 2);
    f.backend.enable = async () => { throw Object.assign(new Error("Grant expired"), { code: "NOT_ENABLED" }); };
    await assert.rejects(provider.enable(), code("NOT_ENABLED"));
    assert.equal(provider.enabled, false);
  });

  for (const change of ["account", "origin", "expiry"]) it(`rejects ${change} changes before recovery`, async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const session = f.bus.dapp.session.get(provider.topic), calls = f.bus.calls.length;
    if (change === "account") session.namespaces.rgb.accounts = ["rgb:regtest:other-wallet"];
    if (change === "origin") session.peer.metadata.url = "https://other.example";
    if (change === "expiry") session.expiry = 1;
    await assert.rejects(provider.enable(), code("NOT_ENABLED"));
    assert.equal(f.bus.calls.length, calls);
    assert.equal(provider.enabled, false);
  });

  for (const lifecycle of ["dispose", "session_update"]) it(`ignores late enable success after ${lifecycle}`, async (t) => {
    const f = await fixture(t), provider = await f.connect();
    const pending = deferred();
    f.bus.dapp.request = () => pending.promise;
    const enabling = provider.enable();
    if (lifecycle === "dispose") provider.dispose();
    else f.bus.dapp.emitter.emit("session_update", { topic: provider.topic });
    pending.resolve(null);
    await assert.rejects(enabling, code("NOT_ENABLED"));
    assert.equal(provider.enabled, false);
  });

  it("reports temporary authorization loss and recovery without disconnecting the durable session", async (t) => {
    const f = await fixture(t), provider = await f.connect(), availability = [];
    const unsubscribe = provider.subscribeAvailability(({ enabled, info }) => { if (!info) availability.push(enabled); });
    await provider.enable();
    f.host.dispose();
    const resumed = createWalletConnectWallet(f.options);
    t.after(() => resumed.dispose());
    await provider.getInfo();
    assert.deepEqual(availability, [true, false, true]);
    assert.equal(f.bus.dapp.sessions.size, 1);
    unsubscribe();
    provider.dispose();
    assert.deepEqual(availability, [true, false, true]);
  });

  it("retains an explicit terminal authorization reason without retrying a read", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const before = f.bus.calls.length;
    f.backend.getInfo = async () => { throw Object.assign(new Error("Grant revoked"), {
      code: "NOT_ENABLED", authorization: "REVOKED",
    }); };
    await assert.rejects(provider.getInfo(), (error) => error.code === "NOT_ENABLED" && error.authorization === "REVOKED");
    assert.equal(f.bus.calls.length - before, 1);
    assert.equal(f.bus.responses.at(-1).error.data, "NOT_ENABLED");
    assert.equal(f.bus.responses.at(-1).error.authorization, "REVOKED");
    assert.equal(provider.enabled, false);
  });

  it("bounds a silent handshake and ignores its late success without deleting the session", async (t) => {
    const f = await fixture(t), old = await f.connect();
    old.dispose();
    const provider = createWalletConnectProvider({ client: f.bus.dapp, topic: old.topic, network, requestTimeoutMs: 5 });
    t.after(() => provider.dispose());
    const response = deferred();
    f.bus.dapp.request = () => response.promise;
    await assert.rejects(provider.enable(), /did not respond/);
    response.resolve(null);
    await tick();
    assert.equal(provider.enabled, false);
    assert.equal(f.bus.dapp.sessions.size, 1);
  });

  it("publishes readiness only from validated info without issuing observer RPCs", async (t) => {
    const f = await fixture(t), provider = await f.connect(), seen = [];
    provider.subscribeAvailability((state) => seen.push(state));
    await provider.enable();
    const before = f.bus.calls.length;
    await provider.getInfo();
    assert.equal(f.bus.calls.length - before, 1);
    assert.equal(seen.at(-1).info.ready, true);
    f.backend.getInfo = async () => ({ ready: true, network: "wrong", methods: [] });
    const length = seen.length;
    await assert.rejects(provider.getInfo(), code("INTERNAL_ERROR"));
    assert.equal(seen.length, length);
  });

  it("never applies the read deadline as a retry or financial request timeout", async (t) => {
    const f = await fixture(t), old = await f.connect();
    old.dispose();
    const provider = createWalletConnectProvider({ client: f.bus.dapp, topic: old.topic, network, requestTimeoutMs: 5 });
    t.after(() => provider.dispose());
    await provider.enable();
    const pending = deferred(), original = f.backend.burnAsset;
    let settled = false;
    f.backend.burnAsset = async (args) => { await pending.promise; return original(args); };
    const burn = provider.burnAsset(burnArgs).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(settled, false);
    pending.resolve();
    await burn;
    assert.equal(f.counts.burn, 1);
    assert.equal(f.bus.calls.filter((call) => call.params.request.method === "rgb_burnAsset").length, 1);
  });

  it("waits for interactive proof approval beyond the automatic-read deadline", async (t) => {
    const f = await fixture(t), old = await f.connect();
    old.dispose();
    const provider = createWalletConnectProvider({ client: f.bus.dapp, topic: old.topic, network, requestTimeoutMs: 20 });
    t.after(() => provider.dispose());
    await provider.enable();
    const approval = deferred(), entered = deferred(), original = f.backend.getConsignment;
    f.backend.getConsignment = async () => { entered.resolve(); await approval.promise; return original(); };
    let outcome;
    const pending = provider.getConsignment({ assetId, txid }).then(
      (value) => { outcome = { value }; }, (error) => { outcome = { error }; },
    );
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const whileAwaitingApproval = outcome;
    const enabledWhileAwaitingApproval = provider.enabled;
    approval.resolve();
    await pending;
    assert.equal(whileAwaitingApproval, undefined, "a privacy prompt is not an automatic readiness read");
    assert.equal(enabledWhileAwaitingApproval, true);
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome.value, f.proof);
    assert.equal(f.counts.proof, 1);
    assert.equal(f.counts.enable, 1, "waiting for privacy approval must not queue another enable");
    assert.equal((await provider.getInfo()).ready, true);
  });

  it("marks relay loss temporary and rechecks readiness once on reconnect without replaying work", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const states = [];
    provider.subscribeAvailability((state) => states.push(state));
    const start = f.bus.calls.length;
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    assert.equal(provider.enabled, false);
    assert.equal(states.at(-1).authorization, "SUSPENDED");
    assert.equal(f.bus.dapp.sessions.size, 1);
    f.bus.dapp.core.relayer.emit("relayer_connect");
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await tick();
    assert.equal(provider.enabled, true);
    assert.equal(states.at(-1).info.ready, true);
    assert.deepEqual(f.bus.calls.slice(start).map((event) => event.params.request.method), ["rgb_enable", "rgb_getInfo"]);
    assert.equal(f.counts.burn, 0);
    assert.equal(f.counts.receive, 0);
    provider.dispose();
    assert.equal(f.bus.dapp.core.relayer.listenerCount("relayer_disconnect"), 0);
    assert.equal(f.bus.dapp.core.relayer.listenerCount("relayer_connect"), 0);
  });

  for (const event of ["relayer_disconnect", "relayer_transport_closed", "relayer_connection_stalled"])
    it(`does not accept a pre-${event} enable reply or queue new offline handshakes`, async (t) => {
      const f = await fixture(t), provider = await f.connect(), arrived = deferred(), release = deferred();
      const raw = f.bus.dapp.request.bind(f.bus.dapp), states = [];
      provider.subscribeAvailability((state) => states.push(state));
      f.bus.dapp.request = async (args) => {
        const result = await raw(args);
        arrived.resolve();
        await release.promise;
        return result;
      };
      const enabling = provider.enable();
      await arrived.promise;
      f.bus.dapp.core.relayer.emit(event);
      const before = f.bus.calls.length;
      await assert.rejects(provider.enable(), (error) => error.code === "NOT_ENABLED" && error.authorization === "SUSPENDED");
      await assert.rejects(provider.getInfo(), code("NOT_ENABLED"));
      assert.equal(f.bus.calls.length, before);
      release.resolve();
      await assert.rejects(enabling, (error) => error.authorization === "SUSPENDED");
      assert.equal(provider.enabled, false);
      assert.deepEqual(states, [{ enabled: false, authorization: "SUSPENDED" }]);
      assert.equal(f.bus.dapp.sessions.size, 1);
      f.bus.dapp.request = raw;
      f.bus.dapp.core.relayer.emit("relayer_connect");
      await provider.enable();
      assert.equal(provider.enabled, true);
      assert.equal(f.counts.enable, 2);
    });

  for (const outcome of ["success", "revoked"])
    it(`ignores a pre-disconnect getInfo ${outcome} without publishing stale readiness or terminal state`, async (t) => {
      const f = await fixture(t), provider = await f.connect(), arrived = deferred(), release = deferred();
      await provider.enable();
      const raw = f.bus.dapp.request.bind(f.bus.dapp), states = [];
      provider.subscribeAvailability((state) => states.push(state));
      f.bus.dapp.request = async (args) => {
        const result = await raw(args);
        arrived.resolve();
        await release.promise;
        if (outcome === "revoked") throw { code: 3001, data: "NOT_ENABLED", authorization: "REVOKED" };
        return result;
      };
      const info = provider.getInfo();
      await arrived.promise;
      f.bus.dapp.core.relayer.emit("relayer_disconnect");
      const before = f.bus.calls.length;
      release.resolve();
      await assert.rejects(info, (error) => error.code === "NOT_ENABLED" && error.authorization === "SUSPENDED");
      assert.equal(f.bus.calls.length, before);
      assert.equal(provider.enabled, false);
      assert.deepEqual(states, [{ enabled: false, authorization: "SUSPENDED" }]);
      f.bus.dapp.request = raw;
      f.bus.dapp.core.relayer.emit("relayer_connect");
      await tick();
      assert.equal(provider.enabled, true);
      assert.equal(states.at(-1).info.ready, true);
      assert.deepEqual(f.bus.calls.slice(before).map((call) => call.params.request.method), ["rgb_enable", "rgb_getInfo"]);
      assert.equal(f.bus.dapp.sessions.size, 1);
    });

  it("reconnects a flapping relay without waiting for or accepting an earlier enable response", async (t) => {
    const f = await fixture(t), provider = await f.connect(), arrived = deferred(), release = deferred();
    await provider.enable();
    const raw = f.bus.dapp.request.bind(f.bus.dapp), states = [];
    let hold = true;
    provider.subscribeAvailability((state) => states.push(state));
    f.bus.dapp.request = async (args) => {
      const result = await raw(args);
      if (hold && args.request.method === "rgb_enable") {
        hold = false;
        arrived.resolve();
        await release.promise;
      }
      return result;
    };
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await arrived.promise;
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await tick();
    assert.equal(provider.enabled, true);
    assert.equal(states.at(-1).info.ready, true);
    const before = states.length;
    release.resolve();
    await tick();
    assert.equal(provider.enabled, true);
    assert.equal(states.length, before);
    assert.equal(f.counts.enable, 3);
    assert.equal(f.bus.calls.filter((call) => call.params.request.method === "rgb_getInfo").length, 1);
  });

  it("does not let a same-tick offline enable absorb the reconnect handshake", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const before = f.bus.calls.length;
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    const offline = provider.enable();
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await assert.rejects(offline, (error) => error.authorization === "SUSPENDED");
    await tick();
    assert.equal(provider.enabled, true);
    assert.deepEqual(f.bus.calls.slice(before).map((call) => call.params.request.method), ["rgb_enable", "rgb_getInfo"]);
  });

  it("does not let an old relay handshake deadline clear newer validated readiness", async (t) => {
    const f = await fixture(t), old = await f.connect(), arrived = deferred(), release = deferred();
    old.dispose();
    const provider = createWalletConnectProvider({ client: f.bus.dapp, topic: old.topic, network, requestTimeoutMs: 50 });
    t.after(() => provider.dispose());
    await provider.enable();
    const raw = f.bus.dapp.request.bind(f.bus.dapp), states = [];
    let hold = true;
    provider.subscribeAvailability((state) => states.push(state));
    f.bus.dapp.request = async (args) => {
      const result = await raw(args);
      if (hold && args.request.method === "rgb_enable") {
        hold = false;
        arrived.resolve();
        await release.promise;
      }
      return result;
    };
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await arrived.promise;
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await tick();
    assert.equal(states.at(-1).info.ready, true);
    const before = states.length;
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(provider.enabled, true);
    assert.equal(states.length, before);
    release.resolve();
    await tick();
    assert.equal(states.length, before);
  });

  it("retains the original in-flight burn result across relay loss without replaying it", async (t) => {
    const f = await fixture(t), provider = await f.connect(), started = deferred(), release = deferred();
    await provider.enable();
    const original = f.backend.burnAsset;
    f.backend.burnAsset = async (args) => {
      started.resolve();
      await release.promise;
      return original(args);
    };
    const burn = provider.burnAsset(burnArgs);
    await started.promise;
    const requestId = f.bus.calls.at(-1).id;
    f.bus.dapp.core.relayer.emit("relayer_disconnect");
    await assert.rejects(provider.burnAsset(burnArgs), code("NOT_ENABLED"));
    release.resolve();
    assert.equal((await burn).txid, txid);
    assert.equal(provider.enabled, false);
    f.bus.dapp.core.relayer.emit("relayer_connect");
    await tick();
    assert.equal(provider.enabled, true);
    assert.deepEqual(f.bus.calls.filter((call) => call.params.request.method === "rgb_burnAsset").map((call) => call.id), [requestId]);
    assert.equal(f.counts.burn, 1);
    assert.equal(f.counts.receive, 0);
    assert.equal(f.bus.calls.filter((call) => call.params.request.method === "rgb_enable").length, 2);
  });

  it("classifies locally revoked adapter sessions even when relay disconnect fails", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    f.bus.wallet.disconnectSession = async () => { throw new Error("Relay offline"); };
    await assert.rejects(f.host.disconnect(provider.topic), /Relay offline/);
    const before = f.bus.calls.length;
    await assert.rejects(provider.getInfo(), (error) => error.code === "NOT_ENABLED" && error.authorization === "REVOKED");
    assert.equal(f.bus.calls.length - before, 1);
    assert.equal(f.bus.dapp.sessions.size, 1); // Terminal grant and relay topic are distinct.
    assert.equal(f.counts.burn, 0);
  });

  it("reports definite local identity expiry once without recursive availability callbacks", async (t) => {
    const f = await fixture(t), provider = await f.connect(), seen = [];
    await provider.enable();
    provider.subscribeAvailability((state) => {
      seen.push(state);
      assert.equal(provider.enabled, false);
    });
    f.bus.dapp.session.get(provider.topic).expiry = 1;
    await assert.rejects(provider.getInfo(), (error) => error.authorization === "REVOKED");
    assert.deepEqual(seen, [{ enabled: false, authorization: "REVOKED" }]);
  });

  it("does not classify an invalid individual request as durable permission revocation", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    await assert.rejects(f.bus.dapp.request({ topic: provider.topic, chainId: "rgb:wrong", request: { method: "rgb_getInfo", params: [] } }),
      (error) => error.data === "NOT_ENABLED" && error.authorization === undefined);
    assert.equal((await provider.getInfo()).ready, true);
    assert.equal(f.counts.burn, 0);
  });

  for (const authorization of ["REVOKED", "SUSPENDED"]) it(`preserves ${authorization} through the official SDK error formatter and JSON response rejection`, async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const respond = f.bus.wallet.respondSessionRequest;
    let formatted;
    f.bus.wallet.respondSessionRequest = (args) => {
      if (args.response.error) {
        // WalletConnect SignClient's sendError uses this actual formatter. Its
        // response handler rejects the decoded response.error bag unchanged.
        formatted = JSON.parse(JSON.stringify(formatJsonRpcError(args.response.id, args.response.error)));
        return respond({ ...args, response: formatted });
      }
      return respond(args);
    };
    f.backend.getInfo = async () => { throw Object.assign(new Error("Wallet unavailable"), { code: "NOT_ENABLED", authorization }); };
    await assert.rejects(provider.getInfo(), (error) => error.code === "NOT_ENABLED" && error.authorization === authorization);
    assert.equal(formatted.error.code, 3001);
    assert.equal(formatted.error.data, "NOT_ENABLED");
    assert.equal(formatted.error.authorization, authorization);
    assert.equal(f.counts.burn, 0);
  });

  it("dApp verifies required grants even if a wallet approves a subset", async (t) => {
    const f = await fixture(t, {}, { methods: ["blindReceive"] });
    const approve = f.bus.wallet.approveSession;
    f.bus.wallet.approveSession = (args) => {
      args.namespaces.rgb.methods = args.namespaces.rgb.methods.filter(
        (m) => m !== "rgb_blindReceive",
      );
      return approve(args);
    };
    await assert.rejects(f.connect(), code("METHOD_NOT_SUPPORTED"));
    assert.equal(f.bus.dapp.sessions.size, 0);
  });

  it("wallet validates full proof before sharing and dApp rejects wrong network info", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    f.backend.getConsignment = async () => ({
      ...f.proof,
      digest: { algorithm: "keccak256", value: "0x" + "00".repeat(32) },
    });
    await assert.rejects(provider.getConsignment({ assetId, txid }), code("INTERNAL_ERROR"));
    assert.equal(f.bus.responses.at(-1).result, undefined);
    f.backend.getInfo = async () => ({ ready: true, network: "signet", methods: ["getInfo"] });
    await assert.rejects(provider.getInfo(), code("INTERNAL_ERROR"));
  });

  it("default connection requests only enable/getInfo and no events", async (t) => {
    const f = await fixture(t, {}, { optionalMethods: undefined, events: undefined });
    const requested = f.bus.proposal.params;
    assert.deepEqual(requested.requiredNamespaces.rgb.methods, ["rgb_enable", "rgb_getInfo"]);
    assert.deepEqual(requested.optionalNamespaces.rgb.methods, []);
    assert.deepEqual(requested.optionalNamespaces.rgb.events, []);
    const provider = await f.connect();
    await provider.enable();
    assert.deepEqual((await provider.getInfo()).methods, ["enable", "getInfo"]);
    await assert.rejects(provider.burnAsset(burnArgs), code("METHOD_NOT_SUPPORTED"));
  });

  it("official namespace builder handles chain-scoped namespaces", async (t) => {
    const f = await fixture(t, {}, { methods: ["blindReceive"] });
    const ns = f.bus.proposal.params.requiredNamespaces.rgb;
    f.bus.proposal.params.requiredNamespaces = {
      "rgb:regtest": { methods: ns.methods, events: [] },
    };
    const provider = await f.connect();
    await provider.enable();
    assert.equal((await provider.blindReceive()).invoice, "rgb:invoice");
  });

  it("compatible session updates preserve connection and apply current grants", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    f.bus.dapp.emitter.emit("session_update", { topic: provider.topic });
    assert.equal(provider.enabled, true);
    assert.equal(f.context.signal.aborted, false);
    const session = f.bus.dapp.session.get(provider.topic);
    session.namespaces.rgb.methods = session.namespaces.rgb.methods.filter(
      (m) => m !== "rgb_burnAsset",
    );
    f.bus.dapp.emitter.emit("session_update", { topic: provider.topic });
    await assert.rejects(provider.burnAsset(burnArgs), code("METHOD_NOT_SUPPORTED"));
    assert.equal(provider.enabled, true);
    assert.equal((await provider.getInfo()).methods.includes("burnAsset"), false);
    assert.equal(f.counts.enable, 1);
  });

  it("method permission is rechecked after the wallet prompt", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    const prompt = deferred(),
      entered = deferred();
    f.backend.burnAsset = async () => {
      entered.resolve();
      await prompt.promise;
      f.context.assertAuthorized();
      f.counts.burn++;
    };
    const result = provider.burnAsset(burnArgs);
    await entered.promise;
    const session = f.bus.wallet.session.get(provider.topic);
    session.namespaces.rgb.methods = session.namespaces.rgb.methods.filter(
      (m) => m !== "rgb_burnAsset",
    );
    prompt.resolve();
    await assert.rejects(result, code("NOT_ENABLED"));
    assert.equal(f.counts.burn, 0);
  });

  it("expired proposal aborts its UI and cannot later approve a connection", async (t) => {
    const prompt = deferred(),
      entered = deferred();
    let signal;
    const f = await fixture(t, {
      approveSession: async (proposal) => {
        signal = proposal.signal;
        entered.resolve();
        return prompt.promise;
      },
    });
    await f.host.pair(uri);
    await entered.promise;
    f.bus.wallet.emitter.emit("proposal_expire", { id: f.bus.proposal.id });
    assert.equal(signal.aborted, true);
    prompt.resolve(true);
    await tick();
    assert.equal(f.bus.wallet.sessions.size, 0);
    await f.connection.cancel();
    await assert.rejects(f.connection.approval(), code("USER_REJECTED"));
  });

  it("request expiry closes its prompt, blocks burn and leaves session usable", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
    const entered = deferred();
    let signal;
    f.backend.burnAsset = async () => {
      signal = f.context.requestSignal;
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      f.context.assertAuthorized();
      f.counts.burn++;
    };
    const request = {
      id: 990,
      topic: provider.topic,
      verifyContext: verified,
      params: {
        chainId: "rgb:regtest",
        request: {
          method: "rgb_burnAsset",
          params: [burnArgs],
          expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
        },
      },
    };
    f.bus.wallet.emitter.emit("session_request", request);
    await entered.promise;
    // A duplicated delivery before expiry must not release its response later.
    f.bus.wallet.emitter.emit("session_request", request);
    f.bus.wallet.emitter.emit("session_request_expire", { id: request.id });
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(f.context.signal.aborted, false);
    assert.equal(f.counts.burn, 0);
    assert.equal(
      f.bus.responses.some((response) => response.id === request.id),
      false,
    );
    assert.equal((await provider.getInfo()).ready, true);
  });

  it("wallet success callback follows confirmed settlement", async (t) => {
    const confirmed = [],
      acknowledged = deferred();
    const f = await fixture(t, { onSessionConnected: (session) => confirmed.push(session.topic) });
    const approve = f.bus.wallet.approveSession;
    f.bus.wallet.approveSession = async (args) => {
      const session = await approve(args);
      await acknowledged.promise;
      return session;
    };
    await f.connect();
    assert.deepEqual(confirmed, []);
    acknowledged.resolve();
    await tick();
    assert.deepEqual(confirmed, ["session"]);
  });

  it("other chain proposals remain available to the app's WalletKit handlers", async (t) => {
    const f = await fixture(t);
    let rejects = 0;
    f.bus.wallet.rejectSession = async () => {
      rejects++;
    };
    f.bus.proposal.params.requiredNamespaces = {
      eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] },
    };
    f.bus.proposal.params.optionalNamespaces = {};
    await f.host.pair(uri);
    await tick();
    assert.equal(rejects, 0);
    assert.equal(f.approval, undefined);
    await f.connection.cancel();
    await assert.rejects(f.connection.approval(), code("USER_REJECTED"));
  });
});


const mintInvoice = "rgb:owned-invoice?pk=abc&expiry=2000000000";
const mintResult = {
  invoice: mintInvoice, recipientId: "utxob:owned", assetId, network, txid,
  opid: "12".repeat(32), lockId: "34".repeat(32), amount: "9007199254740993",
  beforeBlock: "20000000", evmChainId: "42161", bridgeContract: `0x${"56".repeat(20)}`,
};

describe("invoice-scoped received mint", () => {
  it("returns a checked mint without txid across both JSON peers before payment", async (t) => {
    const f = await fixture(t);
    const beforePayment = { ...mintResult };
    delete beforePayment.txid;
    let received = beforePayment;
    f.backend.getReceivedMint = async () => received;
    const provider = await f.connect();
    await provider.enable();

    const checked = await provider.getReceivedMint({ invoice: mintInvoice });
    assert.deepEqual(checked, beforePayment);
    assert.equal(Object.hasOwn(checked, "txid"), false);
    assert.equal(Object.hasOwn(f.bus.responses.at(-1).result, "txid"), false);
    assert.equal(checked.lockId, mintResult.lockId);
    assert.equal(BigInt(checked.amount), 9007199254740993n);

    // Native JS providers may explicitly return undefined; omit it on the wire too.
    received = { ...beforePayment, txid: undefined };
    assert.deepEqual(await provider.getReceivedMint({ invoice: mintInvoice }), beforePayment);
    received = mintResult;
    assert.deepEqual(await provider.getReceivedMint({ invoice: mintInvoice }), mintResult);
    assert.equal(f.counts.burn, 0);
    assert.equal(f.counts.receive, 0);
  });

  it("rejects a supplied malformed txid on both sides of the transport", async (t) => {
    const f = await fixture(t);
    let received = mintResult;
    f.backend.getReceivedMint = async () => received;
    const provider = await f.connect();
    await provider.enable();
    const invalid = [null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64),
      "0x" + txid, 1, {}, []];
    for (const value of invalid) {
      received = { ...mintResult, txid: value };
      await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
    }
    // A raw peer bypassing the wallet adapter is still checked by the dApp adapter.
    f.bus.dapp.request = async () => received;
    for (const value of invalid) {
      received = { ...mintResult, txid: value };
      await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
    }
  });

  it("polls an owned invoice without another approval and preserves exact commitment integers", async (t) => {
    let approvals = 0;
    const f = await fixture(t, { approveSession: async () => { approvals++; return true; } });
    let received = null;
    f.backend.getReceivedMint = async (args) => {
      f.context.assertAuthorized();
      assert.deepEqual(args, { invoice: mintInvoice });
      return received;
    };
    const provider = await f.connect();
    await provider.enable();
    assert.ok((await provider.getInfo()).methods.includes("getReceivedMint"));
    assert.equal(await provider.getReceivedMint({ invoice: mintInvoice }), null);
    received = { ...mintResult, internalProofPath: "/private/wallet/proof", diagnostic: "not wire data" };
    assert.deepEqual(await provider.getReceivedMint({ invoice: mintInvoice }), mintResult);
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, [{ invoice: mintInvoice }]);
    assert.equal(approvals, 1);
    assert.equal(f.counts.enable, 1);
    assert.equal(f.counts.burn, 0);
    assert.equal(f.counts.receive, 0);
  });

  it("rejects recipient-only and ambiguous inputs before requesting native work", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.backend.getReceivedMint = async () => { calls++; return mintResult; };
    const provider = await f.connect();
    await provider.enable();
    for (const args of [null, mintInvoice, {}, [], { recipientId: "utxob:owned" },
      { invoice: mintInvoice, assetId }, { invoice: "rgb:" }, { invoice: "rgb:space test" },
      { invoice: `rgb:${"x".repeat(8192)}` }]) {
      await assert.rejects(provider.getReceivedMint(args), code("INVALID_PARAMS"));
      await assert.rejects(f.bus.dapp.request({ topic: provider.topic, chainId: provider.chainId,
        request: { method: "rgb_getReceivedMint", params: [args] } }), (error) => error.data === "INVALID_PARAMS");
    }
    for (const params of [[], [{ invoice: mintInvoice }, {}]]) {
      await assert.rejects(f.bus.dapp.request({ topic: provider.topic, chainId: provider.chainId,
        request: { method: "rgb_getReceivedMint", params } }), (error) => error.data === "INVALID_PARAMS");
    }
    assert.equal(calls, 0);
  });

  it("rejects malformed, mismatched and missing results instead of treating them as pending", async (t) => {
    const f = await fixture(t);
    let value;
    f.backend.getReceivedMint = async () => value;
    const provider = await f.connect();
    await provider.enable();
    for (value of [undefined, {}, { ...mintResult, invoice: "rgb:foreign" },
      { ...mintResult, network: "signet" }, { ...mintResult, assetId: "" },
      { ...mintResult, recipientId: "" }, { ...mintResult, txid: "wrong" },
      { ...mintResult, lockId: "0x" + mintResult.lockId }, { ...mintResult, opid: null },
      { ...mintResult, amount: 9007199254740992 }, { ...mintResult, amount: "01" },
      { ...mintResult, amount: "18446744073709551616" }, { ...mintResult, amount: "0" },
      { ...mintResult, beforeBlock: "-1" }, { ...mintResult, evmChainId: "0" },
      { ...mintResult, bridgeContract: "0x00" }]) {
      await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
    }
    // A malformed peer cannot bypass the wallet adapter's checks by writing a raw response.
    f.bus.dapp.request = async () => ({ ...mintResult, invoice: "rgb:other" });
    await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
  });

  it("preserves validation and authorization errors without pending fallback or retries", async (t) => {
    const f = await fixture(t);
    let calls = 0, failure;
    f.backend.getReceivedMint = async () => { calls++; throw failure; };
    const provider = await f.connect();
    await provider.enable();
    for (const error of ["INVALID_PARAMS", "ASSET_NOT_FOUND", "INTERNAL_ERROR", "USER_REJECTED"]) {
      failure = Object.assign(new Error("Wallet rejected mint"), { code: error });
      const before = calls;
      await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code(error));
      assert.equal(calls, before + 1);
    }
    failure = Object.assign(new Error("Revoked"), { code: "NOT_ENABLED", authorization: "REVOKED" });
    const before = calls, enables = f.counts.enable;
    await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), (error) => error.authorization === "REVOKED");
    assert.equal(calls, before + 1);
    assert.equal(f.counts.enable, enables);
  });

  it("resumes the real wallet adapter once without creating invoices or replaying burns", async (t) => {
    const f = await fixture(t);
    const beforePayment = { ...mintResult };
    delete beforePayment.txid;
    let reads = 0;
    f.backend.getReceivedMint = async () => { reads++; return beforePayment; };
    const provider = await f.connect();
    await provider.enable();
    f.host.dispose();
    const resumed = createWalletConnectWallet(f.options);
    t.after(() => resumed.dispose());
    assert.deepEqual(await provider.getReceivedMint({ invoice: mintInvoice }), beforePayment);
    assert.equal(reads, 1);
    assert.deepEqual(f.bus.calls.slice(-3).map((event) => event.params.request.method),
      ["rgb_getReceivedMint", "rgb_enable", "rgb_getReceivedMint"]);
    assert.equal(f.counts.receive, 0);
    assert.equal(f.counts.burn, 0);
  });

  it("does not advertise a missing backend or serve a method outside the approved grant", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    assert.equal((await provider.getInfo()).methods.includes("getReceivedMint"), false);
    await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("METHOD_NOT_SUPPORTED"));
    f.backend.getReceivedMint = async () => mintResult;
    for (const client of [f.bus.dapp, f.bus.wallet]) {
      const session = client.session.get(provider.topic);
      for (const namespace of Object.values(session.namespaces)) {
        namespace.methods = namespace.methods.filter((method) => method !== "rgb_getReceivedMint");
      }
    }
    await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("METHOD_NOT_SUPPORTED"));
  });

  it("captures the original invoice and rejects a response after account replacement", async (t) => {
    const f = await fixture(t), pending = deferred();
    f.backend.getReceivedMint = async (args) => { assert.equal(args.invoice, mintInvoice); await pending.promise; return mintResult; };
    const provider = await f.connect();
    await provider.enable();
    const args = { invoice: mintInvoice }, result = provider.getReceivedMint(args);
    args.invoice = "rgb:changed";
    await tick();
    f.bus.dapp.session.get(provider.topic).namespaces.rgb.accounts = [`rgb:${network}:different-wallet`];
    pending.resolve();
    await assert.rejects(result, code("NOT_ENABLED"));
  });

  it("bounds a slow mint read without replaying it or converting its timeout to null", async (t) => {
    const f = await fixture(t), pending = deferred();
    let calls = 0;
    f.backend.getReceivedMint = async () => { calls++; await pending.promise; return mintResult; };
    const old = await f.connect();
    old.dispose();
    const provider = createWalletConnectProvider({ client: f.bus.dapp, topic: old.topic, network, requestTimeoutMs: 5 });
    t.after(() => provider.dispose());
    await provider.enable();
    await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
    assert.equal(calls, 1);
    pending.resolve();
    await tick();
    assert.equal(calls, 1);
    assert.equal(provider.enabled, false);
  });
});


it("requires the configured transport network on received mint results, including utexo aliases", async (t) => {
  const f = await fixture(t, { network: "utexo" }, { network: "utexo" });
  let projectAlias = true;
  f.backend.getInfo = async () => ({ ready: true, network: "utexo", protocol: "RGB_L1",
    methods: ["enable", "getInfo", "getReceivedMint"] });
  // The application validates its native Signet profile before projecting only
  // the network label. Generic transport never aliases arbitrary peer results.
  f.backend.getReceivedMint = async () => ({ ...mintResult, network: projectAlias ? "utexo" : "signet" });
  const provider = await f.connect();
  await provider.enable();
  assert.equal((await provider.getReceivedMint({ invoice: mintInvoice })).network, "utexo");
  projectAlias = false;
  await assert.rejects(provider.getReceivedMint({ invoice: mintInvoice }), code("INTERNAL_ERROR"));
});

describe("single-destination burn profile", () => {
  it("negotiates the new profile and rejects old proposals and stored sessions before enable", async (t) => {
    assert.equal(RGB_WALLETCONNECT_PROFILE, "webrgb:2");
    const old = await fixture(t);
    old.bus.proposal.params.sessionProperties = { webrgb: "webrgb:1" };
    await assert.rejects(old.connect(), code("METHOD_NOT_SUPPORTED"));
    assert.equal(old.counts.enable, 0);
    assert.equal(old.counts.burn, 0);
    const f = await fixture(t), provider = await f.connect();
    const session = f.bus.dapp.session.get(provider.topic);
    assert.equal(session.sessionProperties.webrgb, RGB_WALLETCONNECT_PROFILE);
    session.sessionProperties = { webrgb: "webrgb:1" };
    assert.throws(() => createWalletConnectProvider({ client: f.bus.dapp, topic: provider.topic, network }), code("NOT_ENABLED"));
    await assert.rejects(provider.enable(), code("NOT_ENABLED"));
    assert.equal(f.counts.enable, 0);
  });

  it("rejects old, mixed and malformed burn requests at both boundaries before delegation", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const { burnDestination, ...base } = burnArgs;
    const malformed = [
      null, [], base, { ...base, burnRecipient: burnDestination },
      { ...burnArgs, burnRecipient: burnDestination }, { ...burnArgs, network: "signet" },
      { ...burnArgs, assetId: "" }, { ...burnArgs, amount: 1 }, { ...burnArgs, amount: "01" },
      { ...burnArgs, amount: "0" }, { ...burnArgs, amount: "18446744073709551616" },
      { ...burnArgs, feeRate: 0.5 }, { ...burnArgs, feeRate: 0 },
      { ...burnArgs, minConfirmations: 0 }, { ...burnArgs, minConfirmations: 256 },
      ...[
        { dstEid: undefined }, { dstEid: -1 }, { dstEid: 2 ** 32 }, { dstEid: 1.5 },
        { chainId: "eip155" }, { address: "" }, { version: 1 },
        { destinationChainId: 1 }, { recipient: "0x1234" },
      ].map((patch) => ({ ...burnArgs, burnDestination: { ...burnDestination, ...patch } })),
    ];
    for (const args of malformed) {
      const requests = f.bus.calls.length;
      await assert.rejects(provider.burnAsset(args), code("INVALID_PARAMS"));
      assert.equal(f.bus.calls.length, requests, "invalid input must not reach the relay");
      await assert.rejects(f.bus.dapp.request({ topic: provider.topic, chainId: `rgb:${network}`,
        request: { method: "rgb_burnAsset", params: [args] } }), (error) => error.data === "INVALID_PARAMS");
    }
    for (const params of [[], [burnArgs, burnArgs]]) {
      await assert.rejects(f.bus.dapp.request({ topic: provider.topic, chainId: `rgb:${network}`,
        request: { method: "rgb_burnAsset", params } }), (error) => error.data === "INVALID_PARAMS");
    }
    assert.equal(f.counts.burn, 0);
    assert.equal((await provider.getInfo()).ready, true);
  });

  it("snapshots the caller's destination and preserves exact u64 amounts and direct payouts", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const args = { ...burnArgs, amount: "18446744073709551615",
      burnDestination: { ...burnArgs.burnDestination, chainId: "eip155:42161", dstEid: 0 } };
    const expected = structuredClone(args), pending = provider.burnAsset(args);
    args.amount = "1";
    args.burnDestination.dstEid = 30110;
    const result = await pending;
    assert.equal(result.amount, expected.amount);
    assert.deepEqual(result.burnDestination, expected.burnDestination);
    assert.deepEqual(f.bus.calls.at(-1).params.request.params, [expected]);
    assert.equal(Object.hasOwn(result, "burnRecipient"), false);
  });

  it("checks a wallet response against the original request even if the backend mutates its input", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    f.backend.burnAsset = async (args) => {
      f.counts.burn++;
      args.burnDestination.dstEid = 999;
      return { ...args, txid, transferId: 1, status: "WaitingConfirmations", minConfirmations: 3 };
    };
    await assert.rejects(provider.burnAsset(burnArgs), (error) => {
      assert.equal(error.code, "INTERNAL_ERROR");
      assert.ok(error.message.includes(txid));
      assert.match(error.message, /do not burn again/);
      return true;
    });
    assert.equal(f.counts.burn, 1);
    assert.equal(f.bus.calls.filter((call) => call.params.request.method === "rgb_burnAsset").length, 1);
  });

  it("rejects malformed or mismatched results from either peer without retrying the burn", async (t) => {
    const f = await fixture(t), provider = await f.connect();
    await provider.enable();
    const valid = { ...burnArgs, txid, transferId: 1, status: "WaitingConfirmations", minConfirmations: 3 };
    const invalid = [
      null, { ...valid, txid: "" }, { ...valid, assetId: "rgb:other" }, { ...valid, amount: "6" },
      { ...valid, transferId: undefined }, { ...valid, status: undefined }, { ...valid, minConfirmations: 0 },
      { ...valid, burnDestination: undefined }, { ...valid, burnRecipient: burnArgs.burnDestination },
      ...[{ dstEid: 999 }, { chainId: "eip155:137" }, { address: "0x" + "77".repeat(20) }, { version: 1 }]
        .map((patch) => ({ ...valid, burnDestination: { ...burnArgs.burnDestination, ...patch } })),
    ];
    const raw = f.bus.dapp.request.bind(f.bus.dapp);
    for (const result of invalid) {
      let invoked = 0;
      f.backend.burnAsset = async () => { invoked++; return result; };
      await assert.rejects(provider.burnAsset(burnArgs), code("INTERNAL_ERROR"));
      assert.equal(invoked, 1);
      // Independently test a remote implementation that bypasses the wallet adapter.
      let requests = 0;
      f.bus.dapp.request = async () => { requests++; return result; };
      await assert.rejects(provider.burnAsset(burnArgs), code("INTERNAL_ERROR"));
      assert.equal(requests, 1);
      f.bus.dapp.request = raw;
    }
    f.backend.burnAsset = async () => valid;
    await assert.rejects(provider.burnAsset({ ...burnArgs, minConfirmations: 6 }), code("INTERNAL_ERROR"));
  });
});

describe("optional wallet maintenance methods", () => {
  const added = ["createUtxos", "getBtcBalance", "refresh", "getAssetMetadata"];
  const methods = ["enable", "getInfo", ...added];
  async function setup(t, connectOptions = {}) {
    const f = await fixture(t, { methods }, connectOptions);
    const seen = [];
    const balance = { vanilla: { settled: 1000, future: 1000, spendable: 1000 },
      colored: { settled: 0, future: 0, spendable: 0 }, freeColorableUtxos: null };
    const metadata = { assetId, schema: "bfa", name: "BFA", ticker: null, details: null,
      precision: 6, issuedSupply: "18446744073709551615", timestamp: 1, media: null };
    f.backend.createUtxos = async (...args) => { seen.push(["createUtxos", args]); return { created: args[0]?.num ?? 3, size: 3000, feeRate: 2 }; };
    f.backend.getBtcBalance = async (...args) => { seen.push(["getBtcBalance", args]); return balance; };
    f.backend.refresh = async (...args) => { seen.push(["refresh", args]); return { refreshed: false }; };
    f.backend.getAssetMetadata = async (...args) => { seen.push(["getAssetMetadata", args]); return metadata; };
    const provider = await f.connect();
    await provider.enable();
    return { ...f, provider, seen, balance, metadata };
  }

  it("negotiates optional methods and preserves native values and optional arguments", async (t) => {
    const f = await setup(t), { provider } = f;
    for (const method of added) {
      assert.ok(RGB_WALLETCONNECT_METHODS.includes(method));
      assert.ok((await provider.getInfo()).methods.includes(method));
    }
    assert.equal(RGB_WALLETCONNECT_METHODS.includes("cancelReceive"), false);
    assert.equal(RGB_WALLETCONNECT_METHODS.includes("signPsbt"), false);
    assert.deepEqual(await provider.getBtcBalance(), f.balance);
    assert.deepEqual(await provider.getAssetMetadata(assetId), f.metadata);
    assert.deepEqual(await provider.refresh(), { refreshed: false });
    assert.deepEqual(await provider.refresh(assetId), { refreshed: false });
    assert.equal((await provider.createUtxos()).created, 3);
    assert.equal((await provider.createUtxos(undefined)).created, 3);
    assert.equal((await provider.createUtxos({ num: 2, size: 3000, feeRate: 2 })).created, 2);
    assert.deepEqual(f.seen, [
      ["getBtcBalance", []], ["getAssetMetadata", [assetId]], ["refresh", []], ["refresh", [assetId]],
      ["createUtxos", []], ["createUtxos", []], ["createUtxos", [{ num: 2, size: 3000, feeRate: 2 }]],
    ]);
  });

  it("requires both session grants and an implemented backend method", async (t) => {
    const f = await setup(t, { optionalMethods: [] });
    for (const [method, args] of [["createUtxos", []], ["getBtcBalance", []], ["refresh", []], ["getAssetMetadata", [assetId]]]) {
      assert.equal((await f.provider.getInfo()).methods.includes(method), false);
      await assert.rejects(f.provider[method](...args), code("METHOD_NOT_SUPPORTED"));
    }
    assert.equal(f.seen.length, 0);
    const missing = await fixture(t, { methods }), provider = await missing.connect();
    await provider.enable();
    for (const method of added) assert.equal((await provider.getInfo()).methods.includes(method), false);
    await assert.rejects(provider.createUtxos(), code("METHOD_NOT_SUPPORTED"));
  });

  it("validates positional arity before the wallet operation", async (t) => {
    const f = await setup(t);
    for (const [method, params] of [["getBtcBalance", [{}]], ["getAssetMetadata", []],
      ["createUtxos", [{}, {}]], ["refresh", [assetId, assetId]]]) {
      await assert.rejects(f.bus.dapp.request({ topic: f.provider.topic, chainId: `rgb:${network}`,
        request: { method: `rgb_${method}`, params } }), (error) => error.data === "INVALID_PARAMS");
    }
    assert.equal(f.seen.length, 0);
  });

  it("propagates allocation and refresh failures without converting them to success", async (t) => {
    const f = await setup(t);
    f.backend.createUtxos = async () => { throw Object.assign(new Error("No allocation slot"), { code: "NO_AVAILABLE_UTXOS" }); };
    await assert.rejects(f.provider.createUtxos(), code("NO_AVAILABLE_UTXOS"));
    f.backend.refresh = async () => { throw Object.assign(new Error("Receive refresh failed"), { code: "INTERNAL_ERROR" }); };
    await assert.rejects(f.provider.refresh(), code("INTERNAL_ERROR"));
  });

  for (const [method, params] of [["getBtcBalance", []], ["refresh", [assetId]], ["getAssetMetadata", [assetId]]]) {
    it(`resumes ${method} once after runtime replacement without creating UTXOs`, async (t) => {
      const f = await setup(t);
      f.host.dispose();
      const resumed = createWalletConnectWallet(f.options);
      t.after(() => resumed.dispose());
      const before = f.bus.calls.length;
      await f.provider[method](...params);
      assert.deepEqual(f.bus.calls.slice(before).map((call) => call.params.request.method),
        [`rgb_${method}`, "rgb_enable", `rgb_${method}`]);
      assert.deepEqual(f.seen.map(([name]) => name), [method]);
    });
  }

  it("never resumes or automatically retries createUtxos", async (t) => {
    const f = await setup(t);
    f.backend.createUtxos = async () => {
      f.seen.push(["createUtxos", []]);
      throw Object.assign(new Error("Wallet locked"), { code: "NOT_ENABLED" });
    };
    const before = f.bus.calls.length;
    await assert.rejects(f.provider.createUtxos(), code("NOT_ENABLED"));
    assert.deepEqual(f.bus.calls.slice(before).map((call) => call.params.request.method), ["rgb_createUtxos"]);
    assert.equal(f.seen.length, 1);
  });

  it("deduplicates repeated createUtxos RPC IDs without spending again", async (t) => {
    const f = await setup(t);
    const result = await f.provider.createUtxos({ num: 2 });
    const event = f.bus.calls.at(-1);
    f.bus.wallet.emitter.emit("session_request", structuredClone(event));
    await tick();
    assert.equal(f.seen.filter(([name]) => name === "createUtxos").length, 1);
    const replies = f.bus.responses.filter((reply) => reply.id === event.id);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0].result, result);
    assert.deepEqual(replies[1].result, result);
  });
});
