import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function client(url) {
  const ws = new WebSocket(url);
  const history = [];
  const pending = new Map();
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    history.push(message);
    if (message.type === 'reply' && message.requestId && pending.has(message.requestId)) {
      const entry = pending.get(message.requestId);
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });
  return {
    ws, history,
    async open() {
      if (ws.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    },
    request(type, data = {}) {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timeout waiting for ${type}`));
        }, 5000);
        pending.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ type, requestId, ...data }));
      });
    },
    async waitFor(predicate, timeoutMs = 5000) {
      const existing = history.find(predicate);
      if (existing) return existing;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.off('message', onMessage);
          reject(new Error('Timed out waiting for server event'));
        }, timeoutMs);
        const onMessage = raw => {
          let message;
          try { message = JSON.parse(raw.toString()); } catch { return; }
          if (predicate(message)) {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(message);
          }
        };
        ws.on('message', onMessage);
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', b => serverOutput += b.toString());
server.stderr.on('data', b => serverOutput += b.toString());
const clients = [];

try {
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok && (await response.json()).ok) { healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, `Server failed to start. ${serverOutput}`);

  const a = client(wsUrl); const b = client(wsUrl);
  clients.push(a, b);
  await Promise.all([a.open(), b.open()]);

  const created = await a.request('room:create', { name: '연결 테스트 방', password: '1234', nick: '호스트' });
  assert.equal(created.ok, true, created.error);
  const roomId = created.result.roomId;

  const blockedStart = await a.request('room:start');
  assert.equal(blockedStart.ok, false, 'A room with one human must not start');

  const wrongPass = await b.request('room:join', { roomId, password: '0000', nick: '게스트' });
  assert.equal(wrongPass.ok, false, 'Wrong room password should be rejected');
  const joined = await b.request('room:join', { roomId, password: '1234', nick: '게스트' });
  assert.equal(joined.ok, true, joined.error);

  const rooms = await a.request('rooms:list');
  assert.equal(rooms.ok, true);
  assert.ok(rooms.result.rooms.some(room => room.roomId === roomId && room.passwordProtected));

  const ready = await b.request('room:ready', { ready: true });
  assert.equal(ready.ok, true, ready.error);
  const started = await a.request('room:start');
  assert.equal(started.ok, true, started.error);

  const running = await a.waitFor(m => m.type === 'room:snapshot' && m.snapshot?.phase === 'racing');
  const state = running.snapshot;
  assert.equal(state.players.length, 2, 'Race should contain two human players');
  assert.equal(state.bots.length, 0, 'Online race must not auto-fill empty slots with AI');
  assert.equal(state.players.length, 2, 'Only the two joined human players should race');

  a.ws.send(JSON.stringify({ type: 'input', forward: 1, side: 0, yaw: 0, pitch: 0, jump: false }));
  await new Promise(resolve => setTimeout(resolve, 250));
  const moved = [...a.history].reverse().find(m => m.type === 'room:snapshot' && m.snapshot?.phase === 'racing');
  assert.ok(moved?.snapshot?.players?.some(p => p.id === created.result.playerId && p.dist > 0), 'Server should advance the player from accepted input');

  console.log('Online smoke test OK: password room, join, ready/start, 2 humans only (no AI fill), server movement.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  server.kill('SIGTERM');
}
