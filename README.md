# QuaySync

Local-first data for React Native and the web. Your app reads and writes on the device, and it works offline. QuaySync syncs with your own server in the background and merges edits from many devices without losing any.

- **Offline first:** reads and writes never wait for the network.
- **Field-level merge:** two devices editing different fields of the same record both keep their edits. On the same field, the later write wins, ordered by a hybrid logical clock (so device clock drift doesn't matter).
- **Your server, your data:** a single `POST /sync` endpoint. Ships with in-memory and Cloudflare D1 backends, and the backend interface is two methods.
- **Any storage:** AsyncStorage, MMKV, localStorage, or anything with `getItem` / `setItem` / `removeItem`.
- **Small:** no native code, so it works in Expo Go.

## Packages

| Package | What it does |
|---|---|
| `@quaysync/core` | Store, collections, sync engine, HTTP transport |
| `@quaysync/react` | `QuayProvider`, `useQuery`, `useDoc`, `useSyncStatus` |
| `@quaysync/server` | Fetch-API sync handler with memory and D1 backends |

## Client

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createQuay, httpTransport } from '@quaysync/core';

export const db = createQuay({
  storage: AsyncStorage,
  transport: httpTransport({
    url: 'https://api.example.com/sync',
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  }),
});
```

```tsx
import { QuayProvider, useQuery, useCollection, useSyncStatus } from '@quaysync/react';

type Todo = { title: string; done: boolean };

function Todos() {
  const todos = useCollection<Todo>('todos');
  const open = useQuery<Todo>('todos', (t) => !t.done, (a, b) => a.title.localeCompare(b.title));
  const { state, pending } = useSyncStatus();
  // todos.insert({ title, done: false }); todos.update(id, { done: true }); todos.delete(id);
}

export default () => (
  <QuayProvider db={db} fallback={<Splash />}>
    <Todos />
  </QuayProvider>
);
```

## Server (Cloudflare Worker + D1)

```ts
import { createSyncHandler, d1Backend } from '@quaysync/server';

export default {
  fetch(request: Request, env: Env) {
    const sync = createSyncHandler({
      backend: d1Backend(env.DB),
      authorize: async (req) => verifyUser(req.headers.get('authorization')), // returns user id or null
    });
    return sync(request);
  },
};
```

Create the table once with `D1_SCHEMA`. `authorize` decides which scope (user or team) the data belongs to. Each scope only ever sees its own changes.

## How it works

Every write becomes a field-level change `{collection, id, field, value, hlc}`. The client applies it locally, queues it, and on sync sends the queue and receives every change since its cursor. Merge is per-field last-writer-wins by HLC stamp. That makes it commutative and idempotent, so devices converge whatever order changes arrive in. A delete is a tombstone, and an edit made after a delete brings the record back.

The server checks that every stamp belongs to the device sending it, so one device cannot forge another's writes.

## Limits (v0.1)

- Each collection is kept in memory and saved as one JSON value. That suits up to tens of thousands of records per collection. A SQLite storage adapter is planned for larger data.
- The server log grows without bound. Compaction is planned.
- Queries are in-memory filters, with no indexes.

## Develop

```bash
npm install
npm test
npm run typecheck
```

MIT licence.

## Example app

An Expo todo app in `examples/expo-todo` syncs through a local server.

```bash
npm run example:server
```

```bash
npm run example
```

On web, open `?device=a` and `?device=b` to get two separate devices in one browser. On a real phone, set `EXPO_PUBLIC_SYNC_URL=http://<your-mac-ip>:8911/sync`.
