import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "webrgb-walletconnect-packed-"));
try {
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const core = JSON.parse(execFileSync("npm", ["pack", "./node_modules/@utexo/webrgb", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8" }));
  const files = new Set(result[0].files.map((file) => file.path));
  for (const name of [
    "index.js",
    "index.d.ts",
    "walletconnect-proof.js",
    "walletconnect-mint.js",
    "INTEGRATION.md",
    "SPEC.md",
    "LICENSE",
  ]) {
    assert.ok(files.has(name), `${name} missing from tarball`);
  }
  assert.ok(![...files].some((name) => name.startsWith("test/")), "Tests must not ship");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "adapter-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(dir, result[0].filename), join(dir, core[0].filename)],
    { cwd: dir, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    const adapter = await import("@utexo/webrgb-walletconnect");
    for (const name of ["connectWalletConnect", "createWalletConnectProvider", "createWalletConnectWallet"]) {
      assert.equal(typeof adapter[name], "function", name);
    }
    const core = await import("@utexo/webrgb");
    assert.ok(core.RGB_ERROR_CODES.includes("NOT_ENABLED"));
    assert.ok(adapter.RGB_WALLETCONNECT_METHODS.includes("signMessage"));
    assert.ok(adapter.RGB_WALLETCONNECT_METHODS.includes("getReceivedMint"));
    const receipt = {
      invoice: "rgb:asset/~/bcrt:utxob:owned", recipientId: "bcrt:utxob:owned",
      assetId: "rgb:asset", network: "regtest", opid: "a".repeat(64),
      lockId: "b".repeat(64), amount: "9007199254740993", beforeBlock: "20000000",
      evmChainId: "42161", bridgeContract: "0x" + "c".repeat(40),
    };
    const session = {
      topic: "mint", expiry: Math.floor(Date.now() / 1000) + 600,
      sessionProperties: { webrgb: adapter.RGB_WALLETCONNECT_PROFILE },
      namespaces: { rgb: { accounts: ["rgb:regtest:wallet"],
        methods: ["rgb_enable", "rgb_getReceivedMint"], events: [] } },
      peer: { metadata: { url: "https://wallet.example" } },
    };
    const client = {
      core: {}, session: { get: () => session }, on() {}, off() {},
      request: async ({ request }) => request.method === "rgb_enable" ? null : receipt,
    };
    const provider = adapter.createWalletConnectProvider({ client, topic: "mint", network: "regtest" });
    try {
      await provider.enable();
      const checked = await provider.getReceivedMint({ invoice: receipt.invoice });
      assert.deepEqual(checked, receipt);
      assert.equal(Object.hasOwn(checked, "txid"), false);
    } finally { provider.dispose(); }
  `,
    ],
    { cwd: dir, stdio: "inherit" },
  );
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  for (const name of ["@walletconnect/sign-client", "@walletconnect/core", "@reown/walletkit"]) {
    assert.ok(
      !Object.keys(lock.packages).some((key) => key.endsWith(`node_modules/${name}`)),
      `${name} must be app-owned`,
    );
  }
  console.log("Packed imports, core dependency, files and SDK dependency isolation passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
