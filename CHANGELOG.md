# Changelog

All notable changes to `@utexo/webrgb-walletconnect` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- Use the single `burnDestination` contract from WebRGB. Keep session profile
  `webrgb:1` and existing grants; reject legacy/mixed burn payloads before
  delegation. Prepare `1.0.0-next.0` with the corresponding core peer dependency.
- Require `burnDestination.version: 1` in requests and results. Reject missing
  or unsupported request versions before delegation; invalid result versions
  retain transaction IDs for recovery and never trigger another burn.

### Added

- Validate burn requests and responses at both transport boundaries; preserve
  usable transaction IDs in invalid-result errors for recovery without replay.
- Support optional `createUtxos`, `getBtcBalance`, `refresh` and `getAssetMetadata`.
  Resume only the three reads; deduplicate UTXO creation without retrying it.

## [0.1.5]

### Fixed

- Accept a checked `getReceivedMint` result without `txid` before lock payment;
  validate it when present and preserve its absence through JSON and resumption.

### Changed

- Require `@utexo/webrgb@^0.1.5` for the optional witness transaction ID contract.
  Use published `@utexo/webrgb@0.1.5` for development and package validation.

### Added

- Add optional invoice-scoped received mint reads with exact JSON commitments,
  live grants, strict request/result checks and bounded read-only resumption.
- Revalidate explicit enable handshakes and recover one rejected read after a
  wallet runtime resumes, without replaying transactions or invoice creation.
- Guard late responses with session identity/revision checks and expose
  authorization availability subscriptions to connection UI.
- Revalidate wallet backend grants on every enable handshake.
- Reject stale relay-generation readiness and offline handshakes while retaining
  the original result of an already dispatched financial request.
- Keep privacy-approved consignment disclosure on the WalletConnect request
  lifetime, so a short automatic-read deadline cannot abandon its live prompt.

## [0.1.4] - 2026-11-17

### Changed

- Require `@utexo/webrgb@^0.1.4` as a peer and use `0.1.4` for development.

## [0.1.3]

### Changed

- Use published `@utexo/webrgb@0.1.3` and check burn recipient namespaces in
  the integration example. Payout addresses and capabilities pass through unchanged.

### Fixed

- Allow dApps to call `enable()` again when a wallet reports that its enabled
  state was lost, such as after a wallet restart.

### Added

- `rgb_witnessReceive` support for witness invoice requests.
- Support for the optional `signMessage` method.
- WebRGB WalletConnect adapters for dApps using SignClient and wallets using
  WalletKit, with app-owned SDK initialization and storage.
- Session permissions, expiry signals, events and bounded consignment transfer.
- Integration examples, wire documentation and runtime/type/package tests.
