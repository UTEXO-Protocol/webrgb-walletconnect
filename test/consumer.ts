// Compile-only consumer: check the public exports with Bundler resolution.
import type { RgbBurnAssetArgs, RgbGetConsignmentResult, RgbProvider } from "@utexo/webrgb";
import {
  connectWalletConnect,
  createWalletConnectProvider,
  createWalletConnectWallet,
} from "@utexo/webrgb-walletconnect";
import type {
  WalletConnectClient,
  WalletConnectProvider,
  WalletConnectWalletClient,
} from "@utexo/webrgb-walletconnect";

async function useWalletConnect(
  client: WalletConnectClient,
  walletKit: WalletConnectWalletClient,
  localProvider: RgbProvider,
): Promise<void> {
  const connection = await connectWalletConnect({
    client,
    network: "regtest",
    methods: ["blindReceive"],
  });
  const remote: WalletConnectProvider = await connection.approval();
  await remote.enable();
  await remote.blindReceive();
  remote.dispose();
  createWalletConnectProvider({ client, network: "regtest", topic: "stored-topic" }).dispose();
  const host = createWalletConnectWallet({
    client: walletKit,
    network: "regtest",
    account: "public-wallet-id",
    methods: ["enable", "getInfo"],
    approveSession: async ({ verification }) => verification === "VALID",
    getProvider: ({ assertAuthorized, signal }) => {
      assertAuthorized();
      signal.aborted;
      return localProvider;
    },
  });
  host.dispose();
}
void useWalletConnect;

async function burnAndGetProof(
  provider: WalletConnectProvider,
  args: RgbBurnAssetArgs,
): Promise<RgbGetConsignmentResult | undefined> {
  if (!provider.burnAsset || !provider.getConsignment) return;
  const burn = await provider.burnAsset(args);
  return provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
}
void burnAndGetProof;

declare const client: WalletConnectClient;
// @ts-expect-error Capability names must be strings.
void connectWalletConnect({ client, network: "regtest", methods: [123] });
// @ts-expect-error A dApp client is not a wallet client.
const walletClient: WalletConnectWalletClient = client;
void walletClient;
