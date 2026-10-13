# Changelog

All notable changes to `@utexo/webrgb-walletconnect` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Use published `@utexo/webrgb@0.1.3` and check burn recipient namespaces in
  the integration example. Payout addresses and capabilities pass through unchanged.

### Added

- `rgb_witnessReceive` support for witness invoice requests.
- Support for the optional `signMessage` method.
- WebRGB WalletConnect adapters for dApps using SignClient and wallets using
  WalletKit, with app-owned SDK initialization and storage.
- Session permissions, expiry signals, events and bounded consignment transfer.
- Integration examples, wire documentation and runtime/type/package tests.
