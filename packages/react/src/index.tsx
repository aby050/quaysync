import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Collection, Doc, Quay, SyncStatus } from '@quaysync/core';

const QuayContext = createContext<Quay | null>(null);

export interface QuayProviderProps {
  db: Quay;
  /** Start background sync. Pass a number to set the interval in ms. */
  autoSync?: boolean | number;
  /** Shown until local data has loaded from disk. */
  fallback?: ReactNode;
  children: ReactNode;
}

export function QuayProvider({ db, autoSync = true, fallback = null, children }: QuayProviderProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void db.ready.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [db]);
  useEffect(() => {
    if (!ready || !autoSync) return;
    return db.startAutoSync(typeof autoSync === 'number' ? autoSync : undefined);
  }, [db, ready, autoSync]);
  if (!ready) return <>{fallback}</>;
  return <QuayContext.Provider value={db}>{children}</QuayContext.Provider>;
}

export function useQuay(): Quay {
  const db = useContext(QuayContext);
  if (!db) throw new Error('useQuay must be used inside <QuayProvider>');
  return db;
}

export function useCollection<T extends object>(name: string): Collection<T> {
  const db = useQuay();
  const ref = useRef<Collection<T> | null>(null);
  if (!ref.current || ref.current.name !== name) ref.current = db.collection<T>(name);
  return ref.current;
}

/**
 * Live list of documents. Re-renders when the collection changes, locally or from sync.
 * Pass `deps` when `filter`/`sort` close over changing values.
 */
export function useQuery<T extends object>(
  name: string,
  filter?: (doc: Doc<T>) => boolean,
  sort?: (a: Doc<T>, b: Doc<T>) => number,
  deps: unknown[] = [],
): Doc<T>[] {
  const collection = useCollection<T>(name);
  const cache = useRef<{ version: number; key: unknown[]; value: Doc<T>[] }>({ version: -1, key: [], value: [] });
  const version = useRef(0);

  const subscribe = (cb: () => void) =>
    collection.subscribe(() => {
      version.current++;
      cb();
    });
  const getSnapshot = () => {
    const c = cache.current;
    if (c.version === version.current && sameDeps(c.key, deps)) return c.value;
    const list = collection.all(filter);
    if (sort) list.sort(sort);
    cache.current = { version: version.current, key: deps, value: list };
    return list;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One document by id, live. */
export function useDoc<T extends object>(name: string, id: string | undefined): Doc<T> | undefined {
  const collection = useCollection<T>(name);
  const cache = useRef<{ version: number; id?: string; value?: Doc<T> }>({ version: -1 });
  const version = useRef(0);
  return useSyncExternalStore(
    (cb) =>
      collection.subscribe(() => {
        version.current++;
        cb();
      }),
    () => {
      const c = cache.current;
      if (c.version === version.current && c.id === id) return c.value;
      const value = id ? collection.get(id) : undefined;
      cache.current = { version: version.current, id, value };
      return value;
    },
  );
}

export function useSyncStatus(): SyncStatus {
  const db = useQuay();
  return useSyncExternalStore(
    (cb) => db.onStatus(cb),
    () => db.status,
    () => db.status,
  );
}

function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
