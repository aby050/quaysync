# QuaySync launch posts

## Reddit (r/reactnative, r/expo)

**Title:** I built QuaySync: offline-first storage + sync for React Native, on your own backend

I ship a lot of React Native apps for clients (gym management, vet clinics, POS, kids' learning), and every one needed the same thing: work fully offline, then sync across a user's devices without losing edits. I kept rewriting that layer, so I pulled it into a library.

**QuaySync** is:

- **Offline first:** reads and writes hit local storage instantly (AsyncStorage, MMKV, localStorage). The network is never in the way.
- **Field-level merge:** if one phone changes a todo's title and another marks it done, both edits survive. On the same field, the later write wins, ordered by a hybrid logical clock, so wrong device clocks don't corrupt data.
- **Your own server:** one `POST /sync` endpoint. It ships with a Cloudflare Workers + D1 backend, and you can plug in any database with two methods.
- **No native code:** it works in Expo Go.
- **React hooks:** `useQuery`, `useDoc`, `useSyncStatus`.

```tsx
const todos = useCollection<Todo>('todos');
const open = useQuery<Todo>('todos', (t) => !t.done);
todos.insert({ title: 'Ship it', done: false }); // works offline, syncs later
```

There's an Expo example app in the repo: open two "devices" in the browser and watch them sync.

It's v0.1 and MIT-licensed. I'd love feedback, especially on what you'd need before using it in production (SQLite storage and log compaction are next).

GitHub: https://github.com/aby050/quaysync

---

## X / Twitter thread

1/ Every React Native app I build ends up needing the same thing: work offline, sync across devices, never lose an edit.

So I open-sourced the layer I kept rewriting: QuaySync 🧵
https://github.com/aby050/quaysync

2/ Writes go to the device first. Instant UI, works on a plane. Sync runs in the background and resumes when the network comes back.

3/ Merging is per field. Phone A renames a task while phone B ticks it done, and both changes survive. A hybrid logical clock orders writes, so a phone with the wrong time can't win unfairly.

4/ It runs on your backend: one endpoint, with a Cloudflare D1 adapter included. No vendor lock-in and no per-seat pricing.

5/ No native modules, so it works in Expo Go. Hooks: useQuery, useDoc, useSyncStatus.

v0.1, MIT. Stars and issues are very welcome ⭐

---

## dev.to article outline

**Title:** How I built offline sync for React Native with hybrid logical clocks

1. The problem: four client apps, four hand-rolled sync layers
2. Why not Firebase, Realm (deprecated) or WatermelonDB
3. The data model: every write becomes a field-level change
4. Hybrid logical clocks in 40 lines
5. Last-writer-wins per field, and why deletes are tombstones
6. The server: an append-only log with a cursor
7. Demo: two devices, one offline
8. What's next: SQLite adapter, compaction
