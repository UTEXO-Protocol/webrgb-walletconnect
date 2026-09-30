import type { RgbEvent, RgbMethod, RgbProvider } from "@utexo/webrgb";

/** Structural SDK interfaces: each application owns initialization and storage. */
export interface WalletConnectSession {
  topic: string;
  expiry: number;
  namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }>;
  sessionProperties?: Record<string, string>;
  peer: { metadata: { name: string; url: string; description?: string; icons?: string[] } };
}
export interface WalletConnectNamespace {
  chains?: string[];
  methods: string[];
  events: string[];
}
export type WalletConnectEvent =
  | "session_proposal"
  | "session_request"
  | "session_event"
  | "session_delete"
  | "session_expire"
  | "session_update";
export interface WalletConnectClient {
  session: { get(topic: string): WalletConnectSession; getAll(): WalletConnectSession[] };
  on(event: WalletConnectEvent, listener: (event: any) => void): unknown;
  off(event: WalletConnectEvent, listener: (event: any) => void): unknown;
  connect(args: {
    requiredNamespaces: Record<string, WalletConnectNamespace>;
    optionalNamespaces: Record<string, WalletConnectNamespace>;
    sessionProperties: Record<string, string>;
  }): Promise<{ uri?: string; approval(): Promise<WalletConnectSession> }>;
  request<T>(args: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown[] };
  }): Promise<T>;
  disconnect(args: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  core: { pairing: { disconnect(args: { topic: string }): Promise<void> } };
}

/** Official WalletKit wallet API; no dApp-only SignClient methods are required. */
export interface WalletConnectWalletClient {
  getActiveSessions(): Record<string, WalletConnectSession>;
  on(
    event:
      | "session_proposal"
      | "session_request"
      | "session_delete"
      | "proposal_expire"
      | "session_request_expire",
    listener: (event: any) => void,
  ): unknown;
  off(
    event:
      | "session_proposal"
      | "session_request"
      | "session_delete"
      | "proposal_expire"
      | "session_request_expire",
    listener: (event: any) => void,
  ): unknown;
  pair(args: { uri: string }): Promise<void>;
  approveSession(args: {
    id: number;
    namespaces: WalletConnectSession["namespaces"];
    sessionProperties: Record<string, string>;
  }): Promise<WalletConnectSession>;
  rejectSession(args: { id: number; reason: { code: number; message: string } }): Promise<void>;
  respondSessionRequest(args: {
    topic: string;
    response:
      | { id: number; jsonrpc: "2.0"; result: any }
      | { id: number; jsonrpc: "2.0"; error: { code: number; message: string; data?: string } };
  }): Promise<void>;
  emitSessionEvent(args: {
    topic: string;
    chainId: string;
    event: { name: string; data: unknown };
  }): Promise<void>;
  disconnectSession(args: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void>;
  core: {
    expirer: {
      on(event: "expirer_expired", listener: (event: { target: string }) => void): unknown;
      off(event: "expirer_expired", listener: (event: { target: string }) => void): unknown;
    };
  };
}

/** Experimental UTEXO binding; both peers must implement this profile. */
export declare const RGB_WALLETCONNECT_PROFILE: "webrgb:1";
export declare const RGB_WALLETCONNECT_METHODS: readonly RgbMethod[];
export declare const CONSIGNMENT_CHUNK_BYTES: number;
export declare const MAX_CONSIGNMENT_BYTES: number;

export interface WalletConnectProvider extends RgbProvider {
  readonly topic: string;
  readonly chainId: string;
  disconnect(): Promise<void>;
  /** Remove this adapter's listeners; leave the session available for restoration. */
  dispose(): void;
}
export interface WalletConnectProviderOptions {
  client: WalletConnectClient;
  topic: string;
  network: string;
}
/** Reattach to a stored session. Call enable() before using wallet methods. */
export declare function createWalletConnectProvider(
  options: WalletConnectProviderOptions,
): WalletConnectProvider;

export interface ConnectWalletConnectOptions {
  client: WalletConnectClient;
  network: string;
  /** WebRGB names without rgb_. enable/getInfo are always required. */
  methods?: RgbMethod[];
  /** Additional methods requested only when explicitly listed; defaults to none. */
  optionalMethods?: RgbMethod[];
  /** Optional event subscriptions; defaults to none. */
  events?: RgbEvent[];
}
export interface WalletConnectConnection {
  uri?: string;
  /** Resolves once the user approves; does not call enable() or move funds. */
  approval(): Promise<WalletConnectProvider>;
  cancel(): Promise<void>;
}
export declare function connectWalletConnect(
  options: ConnectWalletConnectOptions,
): Promise<WalletConnectConnection>;

export interface WalletConnectApproval {
  origin: string;
  name: string;
  network: string;
  methods: RgbMethod[];
  events: RgbEvent[];
  /** UNKNOWN must be shown as unverified. INVALID/scam proposals are rejected. */
  verification: "VALID" | "UNKNOWN";
  /** Close the connection prompt when this proposal expires. */
  signal: AbortSignal;
}
export interface WalletConnectWalletContext {
  origin: string;
  topic: string;
  network: string;
  signal: AbortSignal;
  /** Capture inside a provider method; aborts when that request expires. */
  readonly requestSignal: AbortSignal;
  /** Recheck after a wallet prompt and before committing a native operation. */
  assertAuthorized(): void;
}
export type WalletConnectBackend = Partial<RgbProvider> & Pick<RgbProvider, "enable" | "getInfo">;
export interface WalletConnectWalletOptions {
  client: WalletConnectWalletClient;
  network: string;
  /** Public wallet identity, without the rgb:<network>: prefix. */
  account: string;
  methods: RgbMethod[];
  events?: RgbEvent[];
  approveSession(proposal: WalletConnectApproval): Promise<boolean>;
  /** One origin-scoped provider per session; it owns validation and per-call consent. */
  getProvider(
    context: WalletConnectWalletContext,
  ): WalletConnectBackend | Promise<WalletConnectBackend>;
  /** Called only after WalletKit confirms session settlement. */
  onSessionConnected?(session: WalletConnectSession): void;
  /** Delivery failures and asynchronous adapter errors. The app owns logging. */
  onError?(error: Error): void;
}
export interface WalletConnectWallet {
  pair(uri: string): Promise<void>;
  disconnect(topic: string): Promise<void>;
  /** Stop handling requests and abort the session contexts; does not stop the client. */
  dispose(): void;
}
/** Attach once to an initialized WalletKit. Existing matching sessions are usable. */
export declare function createWalletConnectWallet(
  options: WalletConnectWalletOptions,
): WalletConnectWallet;
