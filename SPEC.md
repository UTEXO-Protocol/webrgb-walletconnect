# WebRGB over WalletConnect

This adapter uses SignClient in the dApp and
[WalletKit](https://docs.walletconnect.com/wallets/react-native/usage) in the
wallet. The SDKs own pairing, encryption, relay connections and session
storage. WebRGB supplies the method mapping and wallet consent boundaries.
See [INTEGRATION.md](./INTEGRATION.md) for usage.

The `rgb` namespace, profile tag and consignment chunks are WebRGB binding
choices, not WalletConnect standards. Both ends must
implement this binding; a wallet can use any backend for [WebRGB](https://github.com/UTEXO-Protocol/webrgb).

## 1. Session

| Field | Value |
|-------|-------|
| Namespace | `rgb` |
| Chain | `rgb:<network>`, e.g. `rgb:regtest` |
| Account | `rgb:<network>:<public-wallet-id>` |
| Session property | `webrgb: "webrgb:1"` |
| RPC method | `rgb_<method>`, e.g. `rgb_blindReceive` |
| RPC params | Positional array, e.g. `[{ assetId, amount }]` |
| Events | `rgb_transferReceived`, `rgb_transferSettled`; data is `RgbTransfer` |

Both peers MUST use this profile. Existing authorized sessions MAY be restored
with their original grants. The profile does not negotiate method payload
versions: both peers must support the requested burn contract. Legacy or mixed
burn payloads MUST reject with `INVALID_PARAMS` before delegation; no fallback
is allowed. New methods require a negotiated grant.

Only `enable` and `getInfo` are requested by default. dApps explicitly list
additional required methods, optional methods and events. The wallet uses
WalletConnect's `buildApprovedNamespaces` to negotiate them according to the
[namespace specification](https://specs.walletconnect.com/2.0/specs/clients/sign/namespaces).
`getInfo().methods` reports that intersection. `on` and `off` subscribe locally
to approved events; they are not RPC calls. This adapter binds one wallet
account and one RGB network per session.

The wallet adapter rejects invalid or scam verification results and
mismatched verified origins, reporting the failure through `onError`. An
unknown origin is shown as unverified for the user to decide. Session approval
grants access; each method retains its own consent rules. The wallet's provider must validate arguments and return WebRGB errors.
RPC errors use JSON-RPC or WalletConnect numeric codes and carry the WebRGB
code in `error.data` as a string; the dApp restores it as `error.code`.

`signMessage(message)` maps to `rgb_signMessage` with params `[message]` and
result `{ signature }`. The adapter forwards both unchanged; the wallet
obtains user approval for each signing request.

`witnessReceive(args?)` maps to `rgb_witnessReceive` with params `[args]`,
or `[]` when omitted. Arguments and the invoice result pass through unchanged.

`burnAsset(args)` maps to `rgb_burnAsset` with one positional argument.
Requests and results carry `burnDestination: { version: 1, chainId, address, dstEid }`.
Both adapters MUST reject missing or unsupported request versions with
`INVALID_PARAMS` before delegation; no default or downgrade is allowed.
They check the request shape and network, reject legacy/mixed fields, and match
the result's asset, exact amount and destination (including version) to the request.
The wallet validates native addresses, route support and the commitment before
confirmation. The transport does not infer endpoints or compute commitments.
`getInfo().burnRecipientNamespaces` passes through unchanged; payout chains
remain method arguments and the session still uses `rgb:<network>`.

An invalid result uses `INTERNAL_ERROR`, not a pre-burn rejection. Its message
retains a valid transaction ID when available for recovery. Neither a malformed
result nor a timeout permits automatic resubmission.

### Optional wallet methods

| Method | Positional params | Result |
| --- | --- | --- |
| `createUtxos` | `[]` or `[{ num?, size?, feeRate? }]` | `RgbCreateUtxosResult` |
| `getBtcBalance` | `[]` | `RgbBtcBalance` |
| `refresh` | `[]` or `[assetId]` | `{ refreshed: boolean }` |
| `getAssetMetadata` | `[assetId]` | `RgbAssetMetadata` |

Each uses the `rgb_` RPC prefix and requires a negotiated grant plus a wallet
implementation. Values and WebRGB errors, including `NO_AVAILABLE_UTXOS`, pass
through unchanged. Wallets preserve exact string-valued `issuedSupply` and
propagate per-transfer refresh failures. `createUtxos` requires confirmation
and shares the burn policy: no automatic replay and deduplication by RPC ID.
The other three methods join the bounded read-resumption allowlist.

### Received mint

`getReceivedMint({ invoice })` maps to `rgb_getReceivedMint` with params
`[{ invoice }]`. This optional method must be in the approved namespace and
advertised in `getInfo().methods`. The dApp checks that the provider implements
the method before calling it. The full, unchanged invoice is the only argument.
Recipient-only queries and caller-supplied asset or settlement fields are invalid.
Any-asset invoices are allowed, as in WebRGB 0.1.7: the wallet takes `assetId`
from the validated consignment or rejects the invoice with `INVALID_PARAMS`.
Invoice decoding and proof-to-asset binding remain wallet checks; the transport
does not compare `assetId` with the invoice. The dApp compares it with its
selected asset before paying.

After `enable()`, polling an invoice owned by the active wallet account MUST
require no additional consent prompt. The wallet must still verify invoice
ownership and binding, and enforce the current origin, account, network and
session permissions. Transport checks do not validate proof contents.

The result is `RgbReceivedMint` from WebRGB, or explicit `null` while no validated
mint is ready. Validation and authorization failures return errors. The
`invoice` and `network` fields must match the request and session exactly,
respectively. A wallet using a network alias validates the native network and
projects the result to the same alias as `getInfo()`.
`txid` is optional: a checked mint can be returned before the lock is paid,
when transfer history may not yet name its witness transaction. If supplied,
`txid` must be lowercase 64-character hex; `null` or malformed values reject.
An omitted `txid` stays omitted on both sides of the JSON transport and does
not make the entire result pending. The required `lockId` commits to it.

Existing sessions keep their approved method set after a software upgrade.
Neither `enable()` nor automatic read recovery adds `rgb_getReceivedMint` to it.
A missing permission requires a newly approved session or an explicitly approved
WalletConnect namespace update; the adapter does not initiate such an update.

The method refreshes incoming state and can progress delivery of an already
signed incoming transaction. It may return a previously validated receipt.
The result does not establish a fresh check of every time-dependent rule or
current EVM connectivity. It cannot create an invoice, initiate or replay an
outgoing send or burn, or approve or pay an EVM deposit.

The adapter uses the bounded read deadline and may recover one `NOT_ENABLED`
read through an enable handshake, preserving the exact invoice. A timeout,
validation failure or revocation is not retried. See
[INTEGRATION.md](./INTEGRATION.md#checking-a-prepared-mint) for payment checks.

## 2. Consignment transfer

`provider.getConsignment({ assetId, txid })` returns the complete
`RgbGetConsignmentResult`. The adapter splits it on the wire to keep relay
messages bounded. Only the wire call has `offset` and `length`:

```js
// rgb_getConsignment params
[{ assetId, txid, offset: 0, length: 49152 }]

// result
({
  assetId, txid, encoding: "base64", data: chunkBase64,
  byteLength: totalBytes,
  digest: { algorithm: "keccak256", value: fullFileDigest },
  offset: 0,
  nextOffset: 49152, // null on the last chunk
})
```

Offsets and lengths count decoded bytes. This binding chooses a 48 KiB chunk
limit and a 16 MiB file limit to bound message size and memory use; these are
this adapter's limits, not relay guarantees. The wallet obtains sharing consent when
reading the proof and keeps the bytes for the remaining chunks. The dApp verifies the
identity, length, offsets and full-file digest before returning Base64 to its
caller. Session revocation stops the transfer and clears the cached proof.
This integrity check does not validate the RGB proof itself; the recipient does.

## 3. Lifecycle

Initialize the SDKs once at app startup with stable persistent storage;
random storage prefixes lose sessions on reload. Attach one wallet adapter
per WalletKit instance. Keep existing non-RGB handlers in the app: the adapter
ignores proposals without an RGB namespace and requests outside this profile.
A dApp can save `provider.topic` and restore it after SignClient loads storage:

```ts
import { createWalletConnectProvider } from "@utexo/webrgb-walletconnect";

const provider = createWalletConnectProvider({ client, topic, network });
await provider.enable();
```

`provider.dispose()` removes local listeners and keeps the session;
`provider.disconnect()` revokes it. `wallet.dispose()` removes the wallet's
handlers and aborts provider contexts; `wallet.disconnect(topic)` also ends
the session. Deletion and expiry revoke access. Compatible session updates
keep the connection, and each call checks the current granted methods and
account; removing the required network or base methods disables the provider.
WalletKit's `getActiveSessions()` is the source of wallet session state.

Following the [wallet best practices](https://github.com/WalletConnect/walletconnect-docs/blob/main/docs/walletkit/best-practices.mdx),
proposal and request expiry abort their UI signals. Provider methods must
check `context.assertAuthorized()` after confirmation and before an operation.
Expiry cannot undo a transaction already broadcast. `onSessionConnected`
runs after WalletKit confirms settlement; failures reach `onError`.
On app restart, reconcile pending funds-moving requests with wallet history
before allowing another execution.

The adapter never automatically retries a funds-moving call. Duplicate
JSON-RPC IDs with unchanged arguments reuse the result while that wallet
adapter is alive and the request has not expired. This is not a guarantee
across restarts: reconcile a timed-out burn using wallet history. No separate
`requestId` field is added to `burnAsset`.


## Runtime resumption and authorization availability

A stored WalletConnect topic authorizes neither an awake runtime nor a financial
operation. The dApp adapter MUST send a real `rgb_enable` handshake for explicit
`enable()` calls, coalescing concurrent handshakes for that provider. The wallet
MUST revalidate its current durable grant on every enable, even if that runtime
has already enabled the session.

A previously enabled provider MAY recover one `NOT_ENABLED` read with one enable
and one repeated read. Only the documented read allowlist is eligible. It MUST
NOT replay financial operations, address/invoice allocation or message signing;
interrupted financial calls retain their original identities and require the
wallet's journal/recovery flow. A timeout is not proof that a mutation failed.

`NOT_ENABLED` keeps the existing numeric JSON-RPC code and string `error.data`.
Wallets MAY attach `error.authorization: "SUSPENDED" | "REVOKED"`. SUSPENDED
means temporary runtime/lock availability; REVOKED is reserved for a definite
invalid durable grant/session. A malformed individual request MUST NOT turn a
valid session into a permanently revoked grant. Unclassified NOT_ENABLED errors
MUST NOT be assumed permanent. Read recovery MUST stop on explicit REVOKED.

Adapters MUST reject stale enable/read callbacks after disposal, identity change
or authorization revision replacement. Local account, network, profile, expiry,
origin and per-method namespace checks remain mandatory before and after RPCs.
Core relay disconnect/stall/close events invalidate cached availability; a relay
reconnect may perform one coalesced enable/info check, with no financial RPC.
Readiness responses and deadlines from an earlier relay generation MUST NOT
authorize or overwrite readiness for the current connection. Known-offline
adapters MUST NOT queue new handshakes/reads. Relay availability is separate from
session authority: an already dispatched financial request keeps its original
identity/result and MUST NOT be replayed merely because the relay reconnects.
Availability observers receive readiness only from validated getInfo responses;
they MUST NOT create a recursive polling/retry loop.
