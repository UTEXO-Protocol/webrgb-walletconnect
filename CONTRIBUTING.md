# Contributing to webrgb-walletconnect

Bug reports, fixes and proposals for the transport binding are welcome.

## Development

```bash
npm ci
npm test
npm run test:package
npm run test:packed
```

There is no build step: the JavaScript files and `index.d.ts` ship as they are.
Tests use `node:test`, strict TypeScript with Bundler and NodeNext resolution,
and the same package checks as `@utexo/webrgb`.

## What lives here

- `index.js` — dApp provider and wallet adapter.
- `index.d.ts` — adapter types, using the common WebRGB types from core.
- `walletconnect-proof.js` — bounded consignment transfer and integrity checks.
- `test/runtime.test.js` — connection, permissions, expiry, requests and proofs
  across fake SignClient/WalletKit clients; no relay or wallet funds required.
- `test/consumer.ts` and `test/nodenext/consumer.ts` — compile-only consumers,
  including compatibility with the real SignClient and WalletKit declarations.
- `test/packed.mjs` — install the tarball in a bare project and check imports,
  shipped files and SDK dependency isolation.
- `SPEC.md` — wire binding. The common method contract lives in core.

## Changing the surface

Keep the WebRGB method signatures in `@utexo/webrgb`. Changes here should
concern transport, session lifecycle or adapter options. Keep SDK instances
app-owned, and retain explicit connection and per-operation consent.

Extend runtime tests for changed behaviour and type tests for changed
signatures. Record changes under `Unreleased` in `CHANGELOG.md`.

## Workflow

1. Branch from `main`.
2. Keep the checks above green; CI runs them on Node 20 and 22.
3. Open a pull request with a short rationale and relevant validation.

Live relay and mobile checks require application configuration and remain
separate from the local test suite. Do not commit project credentials or
pairing URIs.
