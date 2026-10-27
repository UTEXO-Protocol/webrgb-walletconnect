# @utexo/webrgb-walletconnect

WalletConnect transport for WebRGB dApps and wallets. The dApp receives a
`RgbProvider`; the wallet serves it using any RGB backend. Supports invoice
requests, optional message signing, BFA burns and consented consignment sharing.

Applications supply an initialized SignClient (dApp) or WalletKit (wallet).
This package handles WebRGB RPC mapping, session permissions, expiry, events
and consignment chunks. Applications own QR/deep-link UI, SDK initialization,
storage, argument validation and user confirmations.

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

Connection approval grants access. The wallet still confirms each operation
according to WebRGB and checks `context.assertAuthorized()` after confirmation.
The adapter does not depend on `rgb-sdk-rn` or any particular wallet backend.

## Protocol and core dependency

[SPEC.md](./SPEC.md) defines the experimental UTEXO `rgb`
namespace and wire binding. Both peers must implement it; this is not an
official WalletConnect RGB standard. The common method contract remains in
[WebRGB](https://github.com/UTEXO-Protocol/webrgb/blob/4b04e78f55e9808ee491ef2510fd9eb8c006cbe5/SPEC.md).

The application supplies `@utexo/webrgb` (^0.1.3) as a peer dependency, so both packages
share one contract. Development uses the published `0.1.3` package.

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
`getTransferStatus`, `decodeRgbInvoice`, and `getConsignment`. Every handshake and
request rechecks the current topic, expiry, profile, network, accounts, origin
and method permissions. An account or wallet-origin change requires a new
provider; late callbacks cannot enable a disposed/replaced provider.

No address/invoice allocation, message signature, issuance, send, payment or burn
is automatically replayed, including after a timeout or lost response. Retain
financial request identities and use the wallet's operation/proof recovery flow
when its outcome is uncertain. This transport does not add durable burn recovery
across wallet process crashes.

`subscribeAvailability(listener)` observes changes to authorization availability.
A false value can mean temporary wallet suspension; it does not revoke the
WalletConnect pairing. Keep a valid stored topic through temporary offline/locked
states and retry a bounded read-only handshake when the user returns. Delete it
on genuine session expiry/deletion, explicit disconnect or incompatible identity.
