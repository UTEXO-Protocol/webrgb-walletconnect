## Unreleased

- Revalidate explicit enable handshakes and recover one rejected read after a
  wallet runtime resumes, without replaying transactions or invoice creation.
- Guard late responses with session identity/revision checks and expose
  authorization availability subscriptions to connection UI.
- Revalidate wallet backend grants on every enable handshake.
- Reject stale relay-generation readiness and offline handshakes while retaining
  the original result of an already dispatched financial request.

# Changelog

All notable changes to `@utexo/webrgb-walletconnect` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
