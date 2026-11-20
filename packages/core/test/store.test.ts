import { describe, expect, it } from 'vitest';
import { createQuay, memoryStorage, type Transport, type SyncRequest } from '@quaysync/core';
import { createSyncHandler, memoryBackend } from '../../server/src/index';

type Todo = { title: string; done: boolean; note?: string };

function server() {
  const handler = createSyncHandler({ backend: memoryBackend(), authorize: () => 'user1' });
  let online = true;
  const transport: Transport = {
    async sync(req: SyncRequest) {
      if (!online) throw new TypeError('Network request failed');
      const res = await handler(new Request('http://x/sync', { method: 'POST', body: JSON.stringify(req) }));
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  };
  return { transport, setOnline: (v: boolean) => (online = v) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('local store', () => {
  it('inserts, updates, deletes', async () => {
    const db = createQuay();
    await db.ready;
    const todos = db.collection<Todo>('todos');
    const id = todos.insert({ title: 'a', done: false });
    todos.update(id, { done: true });
    expect(todos.get(id)).toEqual({ id, title: 'a', done: true });
    todos.delete(id);
    expect(todos.get(id)).toBeUndefined();
    expect(todos.all()).toEqual([]);
  });

  it('survives a restart', async () => {
    const storage = memoryStorage();
    const db1 = createQuay({ storage });
    await db1.ready;
    const id = db1.collection<Todo>('todos').insert({ title: 'keep', done: false });
    await db1.flush();
    const db2 = createQuay({ storage });
    await db2.ready;
    expect(db2.collection<Todo>('todos').get(id)?.title).toBe('keep');
    expect(db2.nodeId).toBe(db1.nodeId);
    expect(db2.status.pending).toBe(3);
  });

  it('notifies subscribers', async () => {
    const db = createQuay();
    await db.ready;
    const todos = db.collection<Todo>('todos');
    let calls = 0;
    todos.subscribe(() => calls++);
    todos.insert({ title: 'x', done: false });
    expect(calls).toBe(1);
  });
});

describe('sync', () => {
  it('two devices converge', async () => {
    const { transport } = server();
    const a = createQuay({ transport });
    const b = createQuay({ transport });
    await Promise.all([a.ready, b.ready]);
    const id = a.collection<Todo>('todos').insert({ title: 'from a', done: false });
    await a.sync();
    await b.sync();
    expect(b.collection<Todo>('todos').get(id)?.title).toBe('from a');
    expect(a.status.pending).toBe(0);
  });

  it('keeps concurrent edits to different fields', async () => {
    const { transport } = server();
    const a = createQuay({ transport });
    const b = createQuay({ transport });
    await Promise.all([a.ready, b.ready]);
    const id = a.collection<Todo>('todos').insert({ title: 't', done: false });
    await a.sync();
    await b.sync();
    a.collection<Todo>('todos').update(id, { done: true });
    b.collection<Todo>('todos').update(id, { note: 'hello' });
    await a.sync();
    await b.sync();
    await a.sync();
    const expected = { id, title: 't', done: true, note: 'hello' };
    expect(a.collection<Todo>('todos').get(id)).toEqual(expected);
    expect(b.collection<Todo>('todos').get(id)).toEqual(expected);
  });

  it('later write wins on the same field', async () => {
    const { transport } = server();
    let t = 1000;
    const a = createQuay({ transport, now: () => t });
    const b = createQuay({ transport, now: () => t });
    await Promise.all([a.ready, b.ready]);
    const id = a.collection<Todo>('todos').insert({ title: 'base', done: false });
    await a.sync();
    await b.sync();
    t = 2000;
    a.collection<Todo>('todos').update(id, { title: 'from a' });
    t = 3000;
    b.collection<Todo>('todos').update(id, { title: 'from b' });
    await b.sync();
    await a.sync();
    await b.sync();
    expect(a.collection<Todo>('todos').get(id)?.title).toBe('from b');
    expect(b.collection<Todo>('todos').get(id)?.title).toBe('from b');
  });

  it('queues writes while offline and sends them later', async () => {
    const { transport, setOnline } = server();
    const a = createQuay({ transport });
    const b = createQuay({ transport });
    await Promise.all([a.ready, b.ready]);
    setOnline(false);
    const id = a.collection<Todo>('todos').insert({ title: 'offline', done: false });
    await expect(a.sync()).rejects.toThrow();
    expect(a.status.state).toBe('offline');
    expect(a.status.pending).toBe(3);
    setOnline(true);
    await a.sync();
    await b.sync();
    expect(b.collection<Todo>('todos').get(id)?.title).toBe('offline');
  });

  it('propagates deletes', async () => {
    const { transport } = server();
    const a = createQuay({ transport });
    const b = createQuay({ transport });
    await Promise.all([a.ready, b.ready]);
    const id = a.collection<Todo>('todos').insert({ title: 'gone', done: false });
    await a.sync();
    await b.sync();
    b.collection<Todo>('todos').delete(id);
    await b.sync();
    await a.sync();
    expect(a.collection<Todo>('todos').get(id)).toBeUndefined();
  });

  it('pages through large histories', async () => {
    const handler = createSyncHandler({ backend: memoryBackend(), authorize: () => 's', pageSize: 7 });
    const transport: Transport = {
      sync: async (req) => (await handler(new Request('http://x', { method: 'POST', body: JSON.stringify(req) }))).json(),
    };
    const a = createQuay({ transport, batchSize: 5 });
    const b = createQuay({ transport });
    await Promise.all([a.ready, b.ready]);
    for (let i = 0; i < 20; i++) a.collection<Todo>('todos').insert({ title: String(i), done: false });
    await a.sync();
    await b.sync();
    expect(b.collection<Todo>('todos').all()).toHaveLength(20);
    await tick();
  });
});
