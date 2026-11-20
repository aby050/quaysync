import { describe, expect, it } from 'vitest';
import { createSyncHandler, memoryBackend } from '../src/index';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/sync', { method: 'POST', body: JSON.stringify(body), headers });

describe('sync handler', () => {
  const handler = createSyncHandler({
    backend: memoryBackend(),
    authorize: (r) => r.headers.get('x-user'),
    allowChange: (_s, c) => c.collection !== 'admin',
  });
  const change = { collection: 'todos', id: '1', field: 'title', value: 'x', hlc: '0000000000001-0000-dev1' };

  it('rejects anonymous calls', async () => {
    expect((await handler(post({ node: 'dev1', cursor: null, changes: [] }))).status).toBe(401);
  });
  it('rejects forged stamps', async () => {
    const res = await handler(post({ node: 'dev2', cursor: null, changes: [change] }, { 'x-user': 'u' }));
    expect(res.status).toBe(400);
  });
  it('applies allowChange', async () => {
    const res = await handler(post({ node: 'dev1', cursor: null, changes: [{ ...change, collection: 'admin' }] }, { 'x-user': 'u' }));
    expect(res.status).toBe(403);
  });
  it('keeps scopes apart', async () => {
    await handler(post({ node: 'dev1', cursor: null, changes: [change] }, { 'x-user': 'alice' }));
    const bob = await (await handler(post({ node: 'dev9', cursor: null, changes: [] }, { 'x-user': 'bob' }))).json();
    expect(bob.changes).toEqual([]);
    const alice = await (await handler(post({ node: 'dev9', cursor: null, changes: [] }, { 'x-user': 'alice' }))).json();
    expect(alice.changes).toHaveLength(1);
  });
});
