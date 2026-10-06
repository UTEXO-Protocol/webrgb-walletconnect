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
  methods: ["enable", "getInfo", "blindReceive", "burnAsset", "getConsignment", "signMessage"],
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
[WebRGB](https://github.com/UTEXO-Protocol/webrgb/blob/eb15f3615c81bde96499bb99eaf66956e6178fe6/SPEC.md).

The application supplies `@utexo/webrgb` 0.2.x as a peer dependency, so both packages
share one contract. Development pins core to a Git commit until its npm release.
For local integration, install the core and adapter tarballs together.

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
