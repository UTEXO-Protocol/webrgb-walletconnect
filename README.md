# @utexo/webrgb-walletconnect

WalletConnect transport for WebRGB dApps and wallets. The dApp receives a
`RgbProvider`; the wallet serves it using any RGB backend. Supports invoice
requests, optional message signing, BFA burns and consented consignment sharing.

Applications supply an initialized SignClient (dApp) or WalletKit (wallet).
This package handles WebRGB RPC mapping, session permissions, expiry, events
and consignment chunks. Applications own QR/deep-link UI, SDK initialization,
storage, backend validation and user confirmations.

## Contract compatibility

Uses the published `@utexo/webrgb@0.1.7` contract.
The `webrgb:1` session profile is unchanged. Burn now requires
`burnDestination: { version: 1, chainId, address, dstEid }`; upgrade both peers
for this contract. Existing session grants remain unchanged, and legacy burn
payloads reject with `INVALID_PARAMS` before delegation.

`createUtxos`, `getBtcBalance`, `refresh` and `getAssetMetadata` are optional.
Request only needed methods and check the negotiated `getInfo().methods`.

## Install

```bash
npm install @utexo/webrgb @utexo/webrgb-walletconnect
```

Install SignClient or WalletKit separately in the app; they are development
dependencies here. See [INTEGRATION.md](./INTEGRATION.md) for the full dApp and
wallet flow, including React Native setup.

## Usage

### dApp

```ts
import { connectWalletConnect } from "@utexo/webrgb-walletconnect";

// client: your initialized SignClient; showQr: your connection UI.
const connection = await connectWalletConnect({
  client,
  network: "regtest",
  methods: ["blindReceive"],
  optionalMethods: ["burnAsset", "getConsignment", "getTransferStatus", "signMessage"],
});
if (connection.uri) showQr(connection.uri);
const provider = await connection.approval();
await provider.enable();
const { invoice } = await provider.blindReceive({ assetId, amount: 5 });
```

Cancel a dismissed connection with `connection.cancel()`. Save `provider.topic`
to restore an approved session with `createWalletConnectProvider()`.

### Wallet

```ts
import { createWalletConnectWallet } from "@utexo/webrgb-walletconnect";

const wallet = createWalletConnectWallet({
  client: walletKit, // your initialized WalletKit
  network: "regtest",
  account: "public-wallet-id",
  methods: ["enable", "getInfo", "blindReceive", "witnessReceive", "burnAsset", "getConsignment", "signMessage"],
  approveSession: showConnectionPrompt, // your UI: Promise<boolean>
  getProvider: createRgbProvider, // your origin-scoped WebRGB implementation
});
await wallet.pair(scannedUri);
```

Connection approval grants access. The wallet follows WebRGB's per-method consent
rules and checks `context.assertAuthorized()` after any confirmation.
The adapter does not depend on `rgb-sdk-rn` or any particular wallet backend.

## Protocol and core dependency

[SPEC.md](./SPEC.md) defines the experimental WebRGB `rgb`
namespace and wire binding. Both peers must implement it; this is not an
official WalletConnect RGB standard. The common method contract remains in
[WebRGB](https://github.com/UTEXO-Protocol/webrgb).

The application supplies `@utexo/webrgb@^0.1.7` as a peer dependency.
The received-mint contract accepts any-asset invoices and keeps its optional `txid`.

### Received-mint reads and existing sessions

To request `getReceivedMint({ invoice })`, include `"getReceivedMint"` in
`optionalMethods` when connecting. After approval, call `enable()` and check that
`getInfo().methods` includes it and that the function exists on the provider.
Polling an owned invoice needs no additional consent prompt. A `null` result
means the proof is still pending. A checked receipt may omit `txid` before
payment; do not treat its absence as pending. Prefer an asset-specific invoice;
use an any-asset invoice only when the wallet rejects that with `ASSET_NOT_FOUND`,
and compare the receipt's `assetId` with the selected asset before paying.
Validation and authorization errors reject.
See [the mint integration guide](./INTEGRATION.md#checking-a-prepared-mint) for
the checks a dApp must make before paying the deposit.

An application or wallet upgrade does not add permissions to an existing session.
If its approved namespace lacks `rgb_getReceivedMint`, request a new session and
obtain the user's approval. Applications that implement WalletConnect session
updates can instead obtain explicit approval for the additional permission before
updating the namespace. This adapter does not expand grants during `enable()` or
read recovery. Both the session grant and the wallet capability must allow the
method. Reconnecting must not automatically resubmit a deposit, send or burn.

## Development

```bash
npm ci
npm test
npm run test:package
npm run test:packed
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the project layout and checks.
Runtime tests exercise the dApp/wallet boundary without a relay. Live relay
and mobile testing are still pending.


### Resuming a wallet runtime

`enable()` performs a real, coalesced wallet authorization handshake every time it
is explicitly called. Call it before starting a new transaction or allocating a
receive invoice. A cached `enabled` value does not prove that the wallet is awake,
unlocked or connected to the relay.

After a previously enabled wallet runtime restarts, read-only calls can recover
one `NOT_ENABLED` reply with one enable handshake and one repeated read. The
allowlist is `getInfo`, `listAssets`, `getAssetBalance`, `listTransfers`,
`getTransferStatus`, `decodeRgbInvoice`, `getReceivedMint`, `getConsignment`,
`getBtcBalance`, `refresh` and `getAssetMetadata`. Every handshake and
request rechecks the current topic, expiry, profile, network, accounts, origin
and method permissions. An account or wallet-origin change requires a new
provider; late callbacks cannot enable a disposed/replaced provider.

No UTXO/address/invoice creation, message signature, issuance, send, payment or burn
is automatically replayed, including after a timeout or lost response. Retain
financial request identities and use the wallet's operation/proof recovery flow
when its outcome is uncertain. This transport does not add durable burn recovery
across wallet process crashes.

`subscribeAvailability(listener)` observes `{ enabled, info?, authorization? }`.
`info` is emitted only after a validated `getInfo` response; observers do not
trigger any additional request. `authorization: "REVOKED"` is an explicit terminal
wallet classification, while `"SUSPENDED"` is temporary. Generic `NOT_ENABLED`
errors do not imply revocation. The JSON-RPC numeric code and `data` string remain
backwards compatible; `authorization` is an optional error extension.

Automatic reads and enable calls have a 30-second local wait deadline
(`requestTimeoutMs`, maximum 120 seconds). A timeout invalidates cached
availability and does not retry or cancel the remote call. WalletConnect's
request expiry still bounds that call. `getConsignment` may require a privacy
approval, so it retains the interactive request lifetime instead of the short
read deadline. Lock, session expiry and revocation still invalidate authorization.
Financial requests retain their original transport lifetime and are never replayed.

Relay loss invalidates replies and deadlines from earlier readiness handshakes
and reads. New handshakes/reads fail while the relay is known offline; retry after
reconnection. This does not discard an already dispatched financial
result or create another transaction.

Availability notifications describe authorization availability.
A false value can mean temporary wallet suspension; it does not revoke the
WalletConnect pairing. Keep a valid stored topic through temporary offline/locked
states and retry a bounded read-only handshake when the user returns. Delete it
on genuine session expiry/deletion, explicit disconnect or incompatible identity.
