import type { Change, SyncRequest, SyncResponse } from '@quaysync/core';

/**
 * Where the server keeps the change log. Each change gets an increasing
 * sequence number; clients pull everything after the last one they saw.
 * `scope` partitions data, normally one scope per user or per team.
 */
export interface SyncBackend {
  append(scope: string, node: string, changes: Change[]): Promise<void>;
  read(scope: string, after: number, excludeNode: string, limit: number): Promise<{ rows: Change[]; last: number; more: boolean }>;
}

export interface SyncHandlerOptions {
  backend: SyncBackend;
  /**
   * Decide who is calling. Return the scope their data lives in, or null to
   * reject with 401. Required: there is no anonymous default.
   */
  authorize: (request: Request) => Promise<string | null> | string | null;
  /** Reject a change before it is stored, e.g. to keep users out of admin collections. */
  allowChange?: (scope: string, change: Change) => boolean;
  /** Most changes returned per response. */
  pageSize?: number;
  /** Most changes accepted per request. */
  maxPush?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Fetch-API handler: works in Cloudflare Workers, Hono, Bun, Deno, Next.js routes. */
export function createSyncHandler(options: SyncHandlerOptions): (request: Request) => Promise<Response> {
  const pageSize = options.pageSize ?? 1000;
  const maxPush = options.maxPush ?? 5000;

  return async (request) => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const scope = await options.authorize(request);
    if (!scope) return json({ error: 'Unauthorized' }, 401);

    let body: SyncRequest;
    try {
      body = (await request.json()) as SyncRequest;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }
    const problem = validate(body, maxPush);
    if (problem) return json({ error: problem }, 400);

    if (options.allowChange) {
      const denied = body.changes.find((c) => !options.allowChange!(scope, c));
      if (denied) return json({ error: `Change to ${denied.collection} not allowed` }, 403);
    }

    if (body.changes.length) await options.backend.append(scope, body.node, body.changes);
    const after = body.cursor ? Number(body.cursor) : 0;
    const { rows, last, more } = await options.backend.read(scope, after, body.node, pageSize);
    const res: SyncResponse = { cursor: String(last), changes: rows, more };
    return json(res);
  };
}

function validate(body: SyncRequest, maxPush: number): string | null {
  if (!body || typeof body !== 'object') return 'Body must be an object';
  if (typeof body.node !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(body.node)) return 'Bad node id';
  if (body.cursor !== null && !/^\d+$/.test(String(body.cursor))) return 'Bad cursor';
  if (!Array.isArray(body.changes)) return 'changes must be an array';
  if (body.changes.length > maxPush) return `At most ${maxPush} changes per request`;
  for (const c of body.changes) {
    if (typeof c.collection !== 'string' || typeof c.id !== 'string' || typeof c.field !== 'string' || typeof c.hlc !== 'string') {
      return 'Malformed change';
    }
    // A stamp must belong to the node sending it, so one device cannot forge another's writes.
    if (!c.hlc.endsWith('-' + body.node)) return 'Change stamp does not match node';
  }
  return null;
}

/** In-memory backend for tests and prototypes. */
export function memoryBackend(): SyncBackend {
  const log: { seq: number; scope: string; node: string; change: Change }[] = [];
  return {
    async append(scope, node, changes) {
      for (const change of changes) log.push({ seq: log.length + 1, scope, node, change });
    },
    async read(scope, after, excludeNode, limit) {
      const rows: Change[] = [];
      let last = after;
      let more = false;
      for (const row of log) {
        if (row.seq <= after) continue;
        if (row.scope !== scope) continue;
        if (rows.length === limit) {
          more = true;
          break;
        }
        last = row.seq;
        if (row.node !== excludeNode) rows.push(row.change);
      }
      return { rows, last, more };
    },
  };
}

/** Minimal slice of the Cloudflare D1 API this backend uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

/** Run once to create the table. */
export const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS quay_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  node TEXT NOT NULL,
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  hlc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quay_changes_scope_seq ON quay_changes (scope, seq);
`;

/** Cloudflare D1 backend. */
export function d1Backend(db: D1Like): SyncBackend {
  return {
    async append(scope, node, changes) {
      const stmt = db.prepare(
        'INSERT INTO quay_changes (scope, node, collection, doc_id, field, value, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      // D1 batches run in one transaction.
      await db.batch(
        changes.map((c) =>
          stmt.bind(scope, node, c.collection, c.id, c.field, c.value === undefined ? null : JSON.stringify(c.value), c.hlc),
        ),
      );
    },
    async read(scope, after, excludeNode, limit) {
      const { results } = await db
        .prepare('SELECT seq, node, collection, doc_id, field, value, hlc FROM quay_changes WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(scope, after, limit + 1)
        .all<{ seq: number; node: string; collection: string; doc_id: string; field: string; value: string | null; hlc: string }>();
      const more = results.length > limit;
      const page = more ? results.slice(0, limit) : results;
      const rows = page
        .filter((r) => r.node !== excludeNode)
        .map((r) => ({
          collection: r.collection,
          id: r.doc_id,
          field: r.field,
          value: r.value === null ? undefined : JSON.parse(r.value),
          hlc: r.hlc,
        }));
      return { rows, last: page.length ? page[page.length - 1].seq : after, more };
    },
  };
}
