import { useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createQuay, httpTransport } from '@quaysync/core';
import { QuayProvider, useCollection, useQuery, useQuay, useSyncStatus } from '@quaysync/react';

type Todo = { title: string; done: boolean; createdAt: number };

// Android emulator reaches the Mac at 10.0.2.2. On a real phone, use the Mac's LAN IP.
const HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
const SYNC_URL = process.env.EXPO_PUBLIC_SYNC_URL ?? `http://${HOST}:8911/sync`;

// On web, `?device=b` gives a second, separate local database in the same browser.
const device =
  Platform.OS === 'web' && typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('device') ?? 'a'
    : 'phone';

const db = createQuay({
  name: device,
  storage: AsyncStorage,
  transport: httpTransport({ url: SYNC_URL }),
});

export default function App() {
  return (
    <QuayProvider db={db} autoSync={3000} fallback={<ActivityIndicator style={{ flex: 1 }} />}>
      <TodoScreen />
      <StatusBar style="dark" />
    </QuayProvider>
  );
}

function TodoScreen() {
  const todos = useCollection<Todo>('todos');
  const list = useQuery<Todo>('todos', undefined, (a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  const [text, setText] = useState('');

  const add = () => {
    const title = text.trim();
    if (!title) return;
    todos.insert({ title, done: false, createdAt: Date.now() });
    setText('');
  };

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Text style={s.title}>Todos</Text>
        <Text style={s.device}>device {device}</Text>
      </View>
      <SyncBar />
      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          onSubmitEditing={add}
          placeholder="Add a todo"
          returnKeyType="done"
        />
        <Pressable style={s.addBtn} onPress={add} accessibilityRole="button">
          <Text style={s.addText}>Add</Text>
        </Pressable>
      </View>
      <FlatList
        data={list}
        keyExtractor={(t) => t.id}
        ListEmptyComponent={<Text style={s.empty}>Nothing yet. Add one, then open another device.</Text>}
        renderItem={({ item }) => (
          <View style={s.row}>
            <Pressable
              style={[s.check, item.done && s.checkOn]}
              onPress={() => todos.update(item.id, { done: !item.done })}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.done }}
            />
            <Text style={[s.rowText, item.done && s.rowDone]}>{item.title}</Text>
            <Pressable onPress={() => todos.delete(item.id)} hitSlop={10} accessibilityLabel="Delete">
              <Text style={s.del}>✕</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

function SyncBar() {
  const db = useQuay();
  const { state, pending, lastSyncedAt } = useSyncStatus();
  const label =
    state === 'syncing' ? 'Syncing…'
    : state === 'offline' ? `Offline · ${pending} waiting`
    : state === 'error' ? 'Sync error'
    : pending ? `${pending} waiting`
    : lastSyncedAt ? `Synced ${new Date(lastSyncedAt).toLocaleTimeString()}`
    : 'Not synced yet';
  const color = state === 'offline' || state === 'error' ? '#b45309' : '#047857';
  return (
    <Pressable style={s.sync} onPress={() => db.sync().catch(() => {})}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={s.syncText}>{label}</Text>
      <Text style={s.syncNow}>Sync now</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f7f5', paddingTop: 64, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 32, fontWeight: '700', color: '#111' },
  device: { fontSize: 13, color: '#666' },
  sync: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 16, gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  syncText: { flex: 1, color: '#444', fontSize: 13 },
  syncNow: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: { flex: 1, backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: '#e5e5e5' },
  addBtn: { backgroundColor: '#111', borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  addText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 14, borderRadius: 10, marginBottom: 8, gap: 12 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#999' },
  checkOn: { backgroundColor: '#047857', borderColor: '#047857' },
  rowText: { flex: 1, fontSize: 16, color: '#111' },
  rowDone: { color: '#999', textDecorationLine: 'line-through' },
  del: { color: '#999', fontSize: 16 },
  empty: { textAlign: 'center', color: '#888', marginTop: 40 },
});
