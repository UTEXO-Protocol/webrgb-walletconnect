// Resolve the public exports as a NodeNext consumer, against the real SDKs.
import "../consumer.js";
import type { WalletKit } from "@reown/walletkit";
import type SignClient from "@walletconnect/sign-client";
import type { RgbProvider } from "@utexo/webrgb";
import { connectWalletConnect, createWalletConnectWallet } from "@utexo/webrgb-walletconnect";
import type { WalletConnectClient, WalletConnectWalletClient } from "@utexo/webrgb-walletconnect";

async function useOfficialSdks(
  client: SignClient,
  walletKit: Awaited<ReturnType<typeof WalletKit.init>>,
  provider: RgbProvider,
): Promise<void> {
  const dappClient: WalletConnectClient = client;
  const walletClient: WalletConnectWalletClient = walletKit;
  await connectWalletConnect({ client: dappClient, network: "regtest" });
  createWalletConnectWallet({
    client: walletClient,
    network: "regtest",
    account: "public-wallet-id",
    methods: ["enable", "getInfo"],
    approveSession: async () => true,
    getProvider: () => provider,
  }).dispose();
}
void useOfficialSdks;
