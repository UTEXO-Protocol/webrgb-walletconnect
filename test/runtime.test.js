// Runtime behaviour across a JSON-serialized dApp/wallet boundary.
// The declarations are checked separately by tsc; no live relay is required.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  connectWalletConnect,
  createWalletConnectProvider,
  createWalletConnectWallet,
  CONSIGNMENT_CHUNK_BYTES,
  MAX_CONSIGNMENT_BYTES,
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
  burnRecipient: { chainId: "eip155:1", address: `0x${"56".repeat(20)}` },
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
      core: { expirer, pairing: { async disconnect() {} } },
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
      "burnAsset",
      "getConsignment",
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
    const messages = ["  Підпис 🟠 e\u0301\r\n", ""];
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

  it("burn arguments pass unchanged; proof chunks reconstruct the exact bytes", async (t) => {
    const f = await fixture(t),
      provider = await f.connect();
    await provider.enable();
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
    assert.equal(f.counts.enable, 1);
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
