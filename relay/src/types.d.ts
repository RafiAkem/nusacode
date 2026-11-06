// Just the parts of Cloudflare's runtime that the relay uses, so it builds and tests without
// pulling in the platform's type packages.

export interface RelaySocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(socket: RelaySocket, tags?: string[]): void;
  getWebSockets(tag?: string): RelaySocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface Env {
  ROOMS: DurableObjectNamespace;
}
