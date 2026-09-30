# WebRGB over WalletConnect

This adapter uses SignClient in the dApp and
[WalletKit](https://docs.walletconnect.com/wallets/react-native/usage) in the
wallet. The SDKs own pairing, encryption, relay connections and session
storage. WebRGB supplies the method mapping and wallet consent boundaries.
See [INTEGRATION.md](./INTEGRATION.md) for usage.

The `rgb` namespace, profile tag and consignment chunks below are experimental
UTEXO protocol choices. They are not WalletConnect standards. Both ends must
implement this binding; a wallet can use any backend for [WebRGB](https://github.com/bandrivskiy/webrgb/blob/1eaebebfa594fe7b9133b878237b36ddd8ebd0a8/SPEC.md).

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
