# Integrating WebRGB over WalletConnect

This package connects a dApp's `RgbProvider` to a remote wallet. The wallet
implements WebRGB using its own RGB backend and handles user consent.

## For dApp developers

For a remote wallet, this adapter uses an initialized SignClient in the dApp.
Create it once with your project ID, accurate app metadata and persistent
storage. `client` below is that instance; `showQr` is your connection UI.
Request only the methods and events your dApp needs:

```ts
import { connectWalletConnect } from "@utexo/webrgb-walletconnect";

const connection = await connectWalletConnect({
  client,
  network: "regtest",
  methods: ["blindReceive"],
  optionalMethods: ["burnAsset", "getConsignment", "getTransferStatus", "signMessage"],
});
if (connection.uri) showQr(connection.uri);
const provider = await connection.approval();
await provider.enable();
```

The user scans the QR in their wallet and approves the connection. Calls on
this provider go to the phone; no extension or `window.rgb` is needed.
Call `connection.cancel()` if the user closes the connection dialog.

To request an invoice for mint:

```ts
const { invoice } = await provider.blindReceive({ assetId, amount: 5 });
```

The wallet asks for confirmation, creates the invoice and returns it. Put it
in the mint form and submit it to the bridge or faucet. `issueAsset()` creates
a new asset; it is not used to receive an existing bridge asset.

For burn, check capabilities before calling the optional methods:

```ts
import { supports } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
    !provider.burnAsset || !provider.getConsignment) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const burn = await provider.burnAsset(args); // RgbBurnAssetArgs
await saveBurn(burn); // persist the result in your dApp
const proof = await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
```

With consent, share `proof.data` (Base64) with a third party to verify the burn
proof. The receiving service handles Bitcoin confirmations, proof verification and
any payout. Proof retrieval can be retried using the saved txid. If a
burn times out, check wallet history before requesting another burn.

To sign a message, include `signMessage` in `optionalMethods` and check support:

```ts
if (supports(await provider.getInfo(), "signMessage") && provider.signMessage) {
  const { signature } = await provider.signMessage(message);
}
```

## For wallet developers

Implement the methods in [WebRGB specification](https://github.com/UTEXO-Protocol/webrgb/blob/c4669a7e99b27e8819568c10e6cafc12ec1376ef/SPEC.md) in your wallet app. For example,
`blindReceive` validates the request, asks the user to confirm, creates an
invoice through your wallet backend and returns `RgbBlindReceiveResult`.
Your backend can be native, WASM or a node API; dApps do not call it directly.

A mobile wallet uses the official
[WalletKit API](https://docs.walletconnect.com/wallets/react-native/usage).
Initialize WalletKit once at app startup, then attach your provider:

```ts
import "@walletconnect/react-native-compat"; // first import in the RN entrypoint
import { Core } from "@walletconnect/core";
import { WalletKit } from "@reown/walletkit";
import { createWalletConnectWallet } from "@utexo/webrgb-walletconnect";
import { createRgbProvider } from "./provider.js"; // your wallet implementation

const core = new Core({ projectId });
const walletKit = await WalletKit.init({ core, metadata: walletMetadata });
const wallet = createWalletConnectWallet({
  client: walletKit,
  network: "regtest",
  account: "public-wallet-id", // stable public identifier, never a secret
  methods: ["enable", "getInfo", "blindReceive", "burnAsset", "getConsignment", "signMessage"],
  approveSession: showConnectionPrompt, // your UI returns Promise<boolean>
  getProvider: (context) => createRgbProvider(context),
});
await wallet.pair(scannedUri); // a WalletConnect URI, not an RGB invoice
```

`createRgbProvider` belongs to your app. It returns a provider scoped to
`context.origin`. Show that origin and the verification status in the
connection prompt; connection approval does not approve a burn, proof
sharing or message signing. After a per-call prompt, call
`context.assertAuthorized()` before performing the operation. Capture
`context.requestSignal` inside each method
and close its prompt on abort; `context.signal` covers session revocation.
The connection prompt receives its own `signal`. `enable()` should reuse
the connection approval.

`onSessionConnected` reports confirmed settlement; `onError` reports failures.
Show loading, success and failure states. Handle deep links in the app, then
pass the extracted `wc:` URI to `pair()`. A scanned QR must not trigger an
automatic redirect using the dApp's metadata. See
[mobile linking](https://docs.walletconnect.com/wallets/react-native/mobile-linking)
and [SPEC.md](./SPEC.md) for lifecycle and transport details.
