import { HLC, randomNodeId, type ClockState } from './hlc.js';
import { applyChange, emptyDoc, isDeleted } from './merge.js';
import {
  DELETED,
  type Change,
  type Doc,
  type KVStorage,
  type StoredDoc,
  type SyncStatus,
  type Transport,
} from './types.js';

export interface QuayOptions {
  /** Where data lives on the device. Defaults to memory (lost on restart). */
  storage?: KVStorage;
  /** How to reach the server. Without one, the store is local-only. */
  transport?: Transport;
  /** Key prefix, so several databases can share one storage. */
  name?: string;
  /** Override the device id. Normally generated once and persisted. */
  nodeId?: string;
  /** Delay before writes are flushed to storage. */
  persistDelayMs?: number;
  /** Most changes sent in one sync request. */
  batchSize?: number;
  now?: () => number;
}

type Listener = () => void;

interface Meta {
  node: string;
  clock: ClockState;
  cursor: string | null;
  collections: string[];
}

export class Quay {
  readonly ready: Promise<void>;

  private storage: KVStorage;
  private transport?: Transport;
  private prefix: string;
  private persistDelayMs: number;
  private batchSize: number;
  private now: () => number;

  private clock!: HLC;
  private cursor: string | null = null;
  private data = new Map<string, Map<string, StoredDoc>>();
  private pending: Change[] = [];
  private dirty = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting: Promise<void> = Promise.resolve();
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<Listener>();
  private syncing: Promise<void> | null = null;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private _status: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };

  constructor(private options: QuayOptions = {}) {
    this.storage = options.storage ?? memoryStorage();
    this.transport = options.transport;
    this.prefix = `quay:${options.name ?? 'default'}:`;
    this.persistDelayMs = options.persistDelayMs ?? 50;
    this.batchSize = options.batchSize ?? 500;
    this.now = options.now ?? Date.now;
    this.ready = this.load();
  }

  collection<T extends object>(name: string): Collection<T> {
    if (name.includes(':')) throw new Error('Collection names cannot contain ":"');
    return new Collection<T>(this, name);
  }

  get status(): SyncStatus {
    return this._status;
  }

  get nodeId(): string {
    return this.clock.node;
  }

  onStatus(listener: Listener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Push local changes and pull remote ones. Concurrent calls share one run. */
  sync(): Promise<void> {
    if (!this.transport) return Promise.resolve();
    if (!this.syncing) {
      this.syncing = this.runSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  /** Sync now, then every `intervalMs`, and soon after each local write. */
  startAutoSync(intervalMs = 15_000): () => void {
    this.stopAutoSync();
    void this.sync().catch(() => {});
    this.autoTimer = setInterval(() => void this.sync().catch(() => {}), intervalMs);
    return () => this.stopAutoSync();
  }

  stopAutoSync(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  /** Wait until every write so far is on disk. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persisting = this.persisting.then(() => this.persist());
    }
    await this.persisting;
  }

  /** Remove everything this database stored on the device. */
  async destroy(): Promise<void> {
    this.stopAutoSync();
    await this.flush();
    for (const name of this.data.keys()) await this.storage.removeItem(this.prefix + 'c:' + name);
    await this.storage.removeItem(this.prefix + 'pending');
    await this.storage.removeItem(this.prefix + 'meta');
    this.data.clear();
    this.pending = [];
  }

  // ---- internals used by Collection ----

  /** @internal */
  docs(collection: string): Map<string, StoredDoc> {
    let docs = this.data.get(collection);
    if (!docs) {
      docs = new Map();
      this.data.set(collection, docs);
    }
    return docs;
  }

  /** @internal */
  write(collection: string, id: string, fields: Record<string, unknown>): void {
    const docs = this.docs(collection);
    const doc = docs.get(id) ?? emptyDoc();
    docs.set(id, doc);
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'id') continue;
      const change: Change = { collection, id, field, value, hlc: this.clock.tick() };
      applyChange(doc, change);
      this.pending.push(change);
    }
    this.changed(collection);
  }

  /** @internal */
  subscribe(collection: string, listener: Listener): () => void {
    let set = this.listeners.get(collection);
    if (!set) {
      set = new Set();
      this.listeners.set(collection, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** @internal */
  assertReady(): void {
    if (!this.clock) throw new Error('Quay is still loading; await db.ready first');
  }

  private changed(collection: string): void {
    this.dirty.add(collection);
    this.schedulePersist();
    this.setStatus({ pending: this.pending.length });
    this.listeners.get(collection)?.forEach((l) => l());
    if (this.autoTimer) queueMicrotask(() => void this.sync().catch(() => {}));
  }

  private async runSync(): Promise<void> {
    await this.ready;
    this.setStatus({ state: 'syncing', error: null });
    try {
      // Loop until both directions are drained.
      for (;;) {
        const batch = this.pending.slice(0, this.batchSize);
        const res = await this.transport!.sync({
          node: this.clock.node,
          cursor: this.cursor,
          changes: batch,
        });
        this.pending.splice(0, batch.length);
        this.cursor = res.cursor;
        this.applyRemote(res.changes);
        this.dirty.add('$meta');
        this.schedulePersist();
        if (this.pending.length === 0 && !res.more) break;
      }
      this.setStatus({ state: 'idle', pending: 0, lastSyncedAt: this.now() });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const offline = error.name === 'TypeError' || /network|fetch/i.test(error.message);
      this.setStatus({ state: offline ? 'offline' : 'error', error, pending: this.pending.length });
      throw error;
    }
  }

  private applyRemote(changes: Change[]): void {
    const touched = new Set<string>();
    for (const change of changes) {
      this.clock.receive(change.hlc);
      const docs = this.docs(change.collection);
      const doc = docs.get(change.id) ?? emptyDoc();
      docs.set(change.id, doc);
      if (applyChange(doc, change)) touched.add(change.collection);
    }
    for (const c of touched) {
      this.dirty.add(c);
      this.listeners.get(c)?.forEach((l) => l());
    }
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this._status = { ...this._status, ...patch };
    this.statusListeners.forEach((l) => l());
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persisting = this.persisting.then(() => this.persist());
    }, this.persistDelayMs);
  }

  private async persist(): Promise<void> {
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const name of dirty) {
      if (name === '$meta') continue;
      const docs = this.data.get(name);
      if (docs) await this.storage.setItem(this.prefix + 'c:' + name, JSON.stringify([...docs]));
    }
    await this.storage.setItem(this.prefix + 'pending', JSON.stringify(this.pending));
    const meta: Meta = {
      node: this.clock.node,
      clock: this.clock.state(),
      cursor: this.cursor,
      collections: [...this.data.keys()],
    };
    await this.storage.setItem(this.prefix + 'meta', JSON.stringify(meta));
  }

  private async load(): Promise<void> {
    const raw = await this.storage.getItem(this.prefix + 'meta');
    const meta: Meta | null = raw ? JSON.parse(raw) : null;
    const node = this.options.nodeId ?? meta?.node ?? randomNodeId();
    this.clock = new HLC(node, this.now, meta?.clock);
    this.cursor = meta?.cursor ?? null;
    for (const name of meta?.collections ?? []) {
      const stored = await this.storage.getItem(this.prefix + 'c:' + name);
      if (stored) this.data.set(name, new Map(JSON.parse(stored)));
    }
    const pending = await this.storage.getItem(this.prefix + 'pending');
    this.pending = pending ? JSON.parse(pending) : [];
    this.setStatus({ pending: this.pending.length });
    if (!meta) this.dirty.add('$meta');
    this.schedulePersist();
  }
}

export class Collection<T extends object> {
  constructor(
    private db: Quay,
    readonly name: string,
  ) {}

  /** Insert a document. Returns its id. */
  insert(doc: T & { id?: string }): string {
    this.db.assertReady();
    const id = doc.id ?? newId();
    this.db.write(this.name, id, { ...doc, [DELETED]: false });
    return id;
  }

  /** Change some fields. Only the fields you pass are written, so edits to other fields on other devices survive. */
  update(id: string, patch: Partial<T>): void {
    this.db.assertReady();
    if (!this.get(id)) throw new Error(`${this.name}/${id} does not exist`);
    this.db.write(this.name, id, patch as Record<string, unknown>);
  }

  /** Insert or overwrite the given fields. */
  upsert(doc: T & { id: string }): void {
    this.db.assertReady();
    this.db.write(this.name, doc.id, { ...doc, [DELETED]: false });
  }

  delete(id: string): void {
    this.db.assertReady();
    this.db.write(this.name, id, { [DELETED]: true });
  }

  get(id: string): Doc<T> | undefined {
    const doc = this.db.docs(this.name).get(id);
    return doc && !isDeleted(doc) ? toDoc<T>(id, doc) : undefined;
  }

  /** All live documents, optionally filtered. */
  all(filter?: (doc: Doc<T>) => boolean): Doc<T>[] {
    const out: Doc<T>[] = [];
    for (const [id, doc] of this.db.docs(this.name)) {
      if (isDeleted(doc)) continue;
      const d = toDoc<T>(id, doc);
      if (!filter || filter(d)) out.push(d);
    }
    return out;
  }

  /** Called after any local or remote change to this collection. */
  subscribe(listener: () => void): () => void {
    return this.db.subscribe(this.name, listener);
  }
}

function toDoc<T>(id: string, doc: StoredDoc): Doc<T> {
  const { [DELETED]: _deleted, ...values } = doc.values;
  return { ...(values as T), id };
}

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function memoryStorage(): KVStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function createQuay(options?: QuayOptions): Quay {
  return new Quay(options);
}
