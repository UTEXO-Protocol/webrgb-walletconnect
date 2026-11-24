// Compile-only consumer: check the public exports with Bundler resolution.
import { supports, type RgbBurnAssetArgs, type RgbGetConsignmentResult, type RgbProvider, type RgbSignMessageResult } from "@utexo/webrgb";
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
    methods: ["blindReceive", "witnessReceive"],
    optionalMethods: ["signMessage", "getReceivedMint"],
  });
  const remote: WalletConnectProvider = await connection.approval();
  await remote.enable();
  await remote.blindReceive();
  const { invoice } = await remote.witnessReceive({ assetId: "rgb:a", amount: 5 });
  invoice.toUpperCase();
  await remote.witnessReceive();
  if (supports(await remote.getInfo(), "getReceivedMint") && remote.getReceivedMint) {
    const mint = await remote.getReceivedMint({ invoice });
    if (mint !== null) {
      BigInt(mint.amount);
      mint.txid?.toUpperCase();
      // @ts-expect-error a checked mint may not have a witness transaction ID yet
      mint.txid.toUpperCase();
    }
    // @ts-expect-error recipient-only lookup is not the invoice-scoped method
    await remote.getReceivedMint({ recipientId: "utxob:seal" });
  }
  if ((await remote.getInfo()).methods.includes("signMessage") && remote.signMessage) {
    const signed: RgbSignMessageResult = await remote.signMessage("  test message\n");
    signed.signature.toUpperCase();
  }
  remote.dispose();
  createWalletConnectProvider({ client, network: "regtest", topic: "stored-topic" }).dispose();
  const host = createWalletConnectWallet({
    client: walletKit,
    network: "regtest",
    account: "public-wallet-id",
    methods: ["enable", "getInfo", "signMessage"],
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
  const info = await provider.getInfo();
  if (!supports(info, "burnAsset") || !supports(info, "getConsignment")) return;
  const namespace = args.burnDestination.chainId.split(":")[0];
  if (!(info.burnRecipientNamespaces ?? ["eip155"]).includes(namespace)) return;
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

async function updatedContract(provider: WalletConnectProvider) {
  const args: RgbBurnAssetArgs = {
    network: "regtest", assetId: "rgb:asset", amount: "9007199254740993",
    burnDestination: { version: 1, chainId: "eip155:137", address: "0x" + "11".repeat(20), dstEid: 30109 },
  };
  if (provider.burnAsset) {
    const result = await provider.burnAsset(args);
    const destination: RgbBurnAssetArgs["burnDestination"] = result.burnDestination;
    const version: 1 = destination.version;
    void version;
    destination.dstEid.toFixed();
    // @ts-expect-error the old duplicate recipient is not part of the contract
    result.burnRecipient;
    // @ts-expect-error dstEid is required
    await provider.burnAsset({ ...args, burnDestination: { version: 1, chainId: "eip155:137", address: "0x1234" } });
    // @ts-expect-error version is required at the public transport boundary
    await provider.burnAsset({ ...args, burnDestination: { chainId: "eip155:137", address: "0x1234", dstEid: 30109 } });
    // @ts-expect-error unknown versions must not be accepted
    await provider.burnAsset({ ...args, burnDestination: { ...args.burnDestination, version: 2 } });
    // @ts-expect-error version must be a number, not a string
    await provider.burnAsset({ ...args, burnDestination: { ...args.burnDestination, version: "1" } });
    // @ts-expect-error legacy requests must not be accepted by the new burn contract
    await provider.burnAsset({ network: "regtest", assetId: "rgb:asset", amount: "1", burnRecipient: args.burnDestination });
  }
  const info = await provider.getInfo();
  if (supports(info, "createUtxos")) (await provider.createUtxos({ num: 2 })).created.toFixed();
  if (supports(info, "getBtcBalance")) (await provider.getBtcBalance()).vanilla.spendable.toFixed();
  if (supports(info, "refresh")) {
    const changed: boolean = (await provider.refresh()).refreshed;
    void changed;
  }
  if (supports(info, "getAssetMetadata")) {
    const supply: string = (await provider.getAssetMetadata(args.assetId)).issuedSupply;
    void supply;
  }
  if (supports(info, "cancelReceive")) {
    const cancelled: boolean = (await provider.cancelReceive("utxob:abc")).cancelled;
    void cancelled;
  }
  if (supports(info, "signPsbt")) {
    const signed: number = (await provider.signPsbt("cHNidP8=", { finalize: true })).signedInputs;
    void signed;
  }
}
void updatedContract;
