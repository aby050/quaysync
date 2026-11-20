/** A single field write. The unit that travels over the wire. */
export interface Change {
  collection: string;
  id: string;
  /** Field name, or `DELETED` for a tombstone. */
  field: string;
  value: unknown;
  /** HLC stamp of the write. */
  hlc: string;
}

/** Field name used for deletes. */
export const DELETED = '$deleted';

/** A document as it is kept on disk: values plus the stamp of each field. */
export interface StoredDoc {
  values: Record<string, unknown>;
  stamps: Record<string, string>;
}

export type Doc<T> = T & { id: string };

/** AsyncStorage-compatible key-value store. MMKV, AsyncStorage and localStorage all fit. */
export interface KVStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface SyncRequest {
  /** Client node id, so the server can leave out the client's own changes. */
  node: string;
  cursor: string | null;
  changes: Change[];
}

export interface SyncResponse {
  cursor: string;
  changes: Change[];
  /** True when the server has more changes after `cursor`. */
  more?: boolean;
}

/** How the client reaches a server. Use `httpTransport` or write your own. */
export interface Transport {
  sync(request: SyncRequest): Promise<SyncResponse>;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** Local writes not yet accepted by the server. */
  pending: number;
  lastSyncedAt: number | null;
  error: Error | null;
}
