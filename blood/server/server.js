import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GAME_FILE = path.join(ROOT, 'public', 'index.html');
const PORT = Number(process.env.PORT || 2567);
const MAX_PLAYERS = 8;
const TRACK_LENGTH = 750;
const TICK_MS = 50;
const STATS = [
  { hp: 50, speed: 12, damage: 12 },
  { hp: 200, speed: 8.6, damage: 18 },
  { hp: 20, speed: 11, damage: 10 },
  { hp: 35, speed: 14, damage: 9 },
  { hp: 15, speed: 12, damage: 8 },
  { hp: 100, speed: 13, damage: 16 },
  { hp: 150, speed: 10, damage: 22 },
];
const SKILL_CD = [6, 0, 5, 0.5, 0, 0, 0];
const rooms = new Map();
const socketPlayers = new Map();

const randomChar = () => Math.floor(Math.random() * STATS.length);
const randomId = (n = 6) => crypto.randomBytes(8).toString('base64url').slice(0, n).toUpperCase();
const hashPassword = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const cleanName = (s, fallback) => String(s || fallback).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || fallback;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (url.pathname === '/health') return json(res, 200, { ok: true, game: 'blood-pressure-marathon', players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0), rooms: rooms.size });
  if (url.pathname === '/api/rooms') return json(res, 200, { rooms: [...rooms.values()].filter(r => r.phase === 'waiting' && !r.closed).map(roomSummary) });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(GAME_FILE).pipe(res);
    return;
  }
  json(res, 404, { error: 'Not found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function reply(ws, requestId, ok, result = {}, error = '') {
  send(ws, { type: 'reply', requestId, ok, result, error: error || undefined });
}
function emit(room, type, data = {}) {
  for (const p of room.players.values()) send(p.ws, { type, ...data });
}
function roomSummary(room) {
  return {
    roomId: room.id,
    name: room.name,
    maxPlayers: room.maxPlayers,
    humans: room.players.size,
    phase: room.phase,
    passwordProtected: Boolean(room.passwordHash),
    hostName: room.players.get(room.hostId)?.nick || '방장',
    bots: room.phase === 'racing' ? room.bots.length : 0,
  };
}
function makePlayer(ws, nick, x, isHost = false, laneIndex = 0) {
  const charId = randomChar();
  const stat = STATS[charId];
  return {
    id: crypto.randomUUID(), ws, nick, charId, hp: stat.hp, maxHp: stat.hp,
    x, spawnX: x, laneIndex, dist: 0, lap: 1, ready: isHost, isHost,
    forward: 0, side: 0, yaw: 0, pitch: 0, jumpQueued: false,
    jumpTime: 0, jumpHeight: 0, attackCd: 0, skillCd: 0,
    frozen: 0, confused: 0, stun: 0, pushX: 0, pushDist: 0, pushTime: 0,
    dead: false, deathTimer: 0, finished: false,
  };
}
function findPlayer(room, ws) {
  for (const p of room.players.values()) if (p.ws === ws) return p;
  return null;
}
function roomForSocket(ws) {
  const entry = socketPlayers.get(ws);
  return entry ? rooms.get(entry.roomId) : null;
}
function getEntity(room, id) {
  if (room.players.has(id)) return room.players.get(id);
  return room.bots.find(b => b.id === id) || null;
}
function allEntities(room) {
  return [...room.players.values(), ...room.bots];
}
function snapshot(room, forPlayerId = '') {
  room.snapshotSeq = (room.snapshotSeq || 0) + 1;
  return {
    snapshotSeq: room.snapshotSeq,
    room: roomSummary(room),
    selfId: forPlayerId,
    phase: room.phase,
    winnerId: room.winnerId || '',
    players: [...room.players.values()].map(p => ({
      id: p.id, nick: p.nick, charId: p.charId, hp: p.hp, maxHp: p.maxHp,
      x: p.x, dist: p.dist, lap: p.lap, yaw: p.yaw, ready: p.ready, isHost: p.isHost,
      dead: p.dead, jumpHeight: p.jumpHeight, frozen: p.frozen, confused: p.confused,
      stun: p.stun, pushTime: p.pushTime, skillCd: p.skillCd, finished: p.finished,
    })),
    bots: room.bots.map(b => ({
      id: b.id, nick: b.nick, charId: b.charId, hp: b.hp, maxHp: b.maxHp,
      x: b.x, dist: b.dist, lap: b.lap, yaw: 0, dead: b.dead, jumpHeight: b.jumpHeight,
      frozen: b.frozen, confused: b.confused, stun: b.stun, pushTime: b.pushTime,
      skillCd: b.skillCd, finished: b.finished,
    })),
    turrets: room.turrets.map(t => ({ id: t.id, ownerId: t.ownerId, x: t.x, dist: t.dist, hp: t.hp, maxHp: t.maxHp })),
  };
}
function broadcastSnapshot(room) {
  for (const p of room.players.values()) send(p.ws, { type: 'room:snapshot', snapshot: snapshot(room, p.id) });
}
function startRace(room) {
  room.phase = 'racing';
  room.startedAt = Date.now();
  room.bots = [];
  room.nextBotId = 0;
  room.turrets = [];
  room.players.forEach((p, i) => {
    p.charId = randomChar();
    p.ready = true;
    // Center the human-only group in the track; empty slots stay empty.
    p.laneIndex = i;
    p.x = (i - (room.players.size - 1) / 2) * 2.2;
    p.spawnX = p.x; p.dist = 0; p.lap = 1; p.finished = false; p.dead = false;
    p.hp = p.maxHp = STATS[p.charId].hp;
    p.forward = p.side = 0; p.jumpHeight = p.jumpTime = 0;
  });
  // Online races are human-only. Empty slots remain empty; no AI fillers are spawned.
  emit(room, 'race:started', { snapshot: snapshot(room) });
  broadcastSnapshot(room);
}
function leaveRoom(ws) {
  const entry = socketPlayers.get(ws);
  socketPlayers.delete(ws);
  if (!entry) return;
  const room = rooms.get(entry.roomId);
  if (!room) return;
  const player = room.players.get(entry.playerId);
  if (player) room.players.delete(entry.playerId);
  // A player leaving does not create an AI replacement.
  if (room.players.size === 0) {
    room.closed = true;
    rooms.delete(room.id);
    return;
  }
  if (room.hostId === entry.playerId) {
    const next = room.players.values().next().value;
    room.hostId = next.id;
    next.isHost = true;
  }
  emit(room, 'room:notice', { message: `${player?.nick || '플레이어'} 님이 나갔습니다.` });
  broadcastSnapshot(room);
}

function applyDamage(room, target, damage, sourceId) {
  if (!target || target.dead || target.charId === 4 || target.finished) return false;
  target.hp = Math.max(0, target.hp - damage);
  if (target.hp <= 0) {
    target.dead = true;
    target.deathTimer = 3;
    target.forward = target.side = 0;
    emit(room, 'game:event', { event: 'death', targetId: target.id, sourceId });
  }
  return true;
}
function applyKnockback(target, dirX, dirZ, force = 15, seconds = 0.72) {
  target.frozen = 0;
  target.pushX = dirX;
  target.pushDist = -dirZ;
  target.pushTime = seconds;
  target.pushSpeed = force;
  target.stun = Math.max(target.stun || 0, 0.68);
}
function targetsInCone(room, source, yaw, range, width) {
  const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw);
  const targets = allEntities(room).filter(e => e.id !== source.id && e.charId !== 4 && !e.dead && !e.finished);
  return targets.filter(t => {
    const dx = t.x - source.x;
    const dzWorld = -(t.dist - source.dist);
    const forward = dx * dirX + dzWorld * dirZ;
    const lateral = Math.abs(dx * dirZ - dzWorld * dirX);
    return forward > 0.15 && forward < range && lateral < width;
  });
}
function damageEnemyTurrets(room, player, yaw, range, width, damage) {
  const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw);
  for (let i = room.turrets.length - 1; i >= 0; i--) {
    const turret = room.turrets[i];
    if (turret.ownerId === player.id) continue;
    const dx = turret.x - player.x;
    const dzWorld = -(turret.dist - player.dist);
    const forward = dx * dirX + dzWorld * dirZ;
    const lateral = Math.abs(dx * dirZ - dzWorld * dirX);
    if (forward > 0 && forward < range && lateral < width) {
      turret.hp = Math.max(0, turret.hp - damage);
      emit(room, 'game:event', { event: 'turret-hit', turretId: turret.id, hp: turret.hp });
      if (turret.hp <= 0) {
        room.turrets.splice(i, 1);
        emit(room, 'game:event', { event: 'turret-destroy', turretId: turret.id });
      }
      return true;
    }
  }
  return false;
}

function handleAction(room, player, action, msg) {
  if (room.phase !== 'racing' || player.dead || player.finished || player.frozen > 0 || player.stun > 0) return;
  const charId = player.charId;
  const st = STATS[charId];
  const yaw = clamp(Number(msg.yaw), -Math.PI * 4, Math.PI * 4);
  const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw);

  if (action === 'attack') {
    if (player.attackCd > 0) return;
    player.attackCd = 0.34;
    if (charId === 6) {
      damageEnemyTurrets(room, player, yaw, 4.6, 2.0, st.damage);
      const hits = targetsInCone(room, player, yaw, 4.6, 2.0);
      for (const target of hits) {
        applyKnockback(target, dirX, dirZ, 15, 0.72);
        applyDamage(room, target, st.damage, player.id);
      }
      emit(room, 'game:event', { event: 'bash', sourceId: player.id, x: player.x, dist: player.dist, yaw, hits: hits.length });
    } else {
      damageEnemyTurrets(room, player, yaw, 30, 1.7, st.damage);
      const hits = targetsInCone(room, player, yaw, 30, 1.7);
      if (hits.length) {
        const target = hits.sort((a, b) => Math.hypot(a.x - player.x, a.dist - player.dist) - Math.hypot(b.x - player.x, b.dist - player.dist))[0];
        applyDamage(room, target, st.damage, player.id);
      }
      emit(room, 'game:event', { event: 'shot', sourceId: player.id, x: player.x, dist: player.dist, yaw, hitCount: hits.length });
    }
    return;
  }

  if (action !== 'skill' || player.skillCd > 0) return;
  if (charId === 1 || charId === 4) return;
  player.skillCd = SKILL_CD[charId] || 0;
  if (charId === 3) {
    const own = room.turrets.filter(t => t.ownerId === player.id);
    if (own.length >= 5) { player.skillCd = 0; emit(room, 'game:event', { event: 'notice', targetId: player.id, message: '포탑은 최대 5개까지 설치할 수 있어요.' }); return; }
    room.turrets.push({ id: crypto.randomUUID(), ownerId: player.id, x: clamp(player.x + dirX * 2.2, -13, 13), dist: Math.max(0, player.dist - dirZ * 2.2), hp: 30, maxHp: 30, cd: 0.2 });
    emit(room, 'game:event', { event: 'turret-place', sourceId: player.id });
  } else if (charId === 6) {
    damageEnemyTurrets(room, player, yaw, 4.6, 2.0, 8);
    const hits = targetsInCone(room, player, yaw, 4.6, 2.0);
    for (const target of hits) { applyKnockback(target, dirX, dirZ, 15, 0.72); applyDamage(room, target, 8, player.id); }
    emit(room, 'game:event', { event: 'bash', sourceId: player.id, x: player.x, dist: player.dist, yaw, hits: hits.length });
  } else if (charId === 0) {
    for (const target of allEntities(room)) if (target.id !== player.id && target.charId !== 4 && !target.dead && Math.hypot(target.x - player.x, target.dist - player.dist) <= 16) target.confused = 4;
    emit(room, 'game:event', { event: 'rage', sourceId: player.id, x: player.x, dist: player.dist });
  } else if (charId === 2) {
    for (const target of allEntities(room)) if (target.id !== player.id && target.charId !== 4 && !target.dead && Math.hypot(target.x - player.x, target.dist - player.dist) <= 5.5) target.frozen = 3;
    emit(room, 'game:event', { event: 'ice', sourceId: player.id, x: player.x, dist: player.dist });
  } else if (charId === 5) {
    for (const target of allEntities(room)) if (target.id !== player.id && target.charId !== 4 && !target.dead && Math.abs(target.dist - player.dist) < 20) target.stun = 2;
    emit(room, 'game:event', { event: 'royal', sourceId: player.id, x: player.x, dist: player.dist });
  }
}

function updateEntity(room, e, dt, isBot = false) {
  if (e.dead) {
    e.deathTimer -= dt;
    if (e.deathTimer <= 0) {
      e.dead = false; e.deathTimer = 0; e.dist = 0; e.lap = 1; e.x = e.spawnX;
      e.hp = e.maxHp; e.frozen = e.confused = e.stun = e.pushTime = 0;
      e.pushX = e.pushDist = 0; e.jumpHeight = e.jumpTime = 0; e.finished = false;
      emit(room, 'game:event', { event: 'respawn', targetId: e.id });
    }
    return;
  }
  if (e.finished) return;
  e.attackCd = Math.max(0, (e.attackCd || 0) - dt);
  e.skillCd = Math.max(0, (e.skillCd || 0) - dt);
  e.frozen = Math.max(0, (e.frozen || 0) - dt);
  e.confused = Math.max(0, (e.confused || 0) - dt);
  e.stun = Math.max(0, (e.stun || 0) - dt);
  let forward = isBot ? 0.82 : e.forward;
  let side = isBot ? Math.sin(Date.now() / 1400 + (e.phase || 0)) * 0.34 : e.side;
  if (e.frozen > 0 || e.stun > 0) { forward = 0; side = 0; }
  if (e.confused > 0) { forward *= -1; side *= -1; }
  if (e.pushTime > 0) {
    const pushStep = Math.min(dt, e.pushTime);
    const force = e.pushSpeed || 15;
    e.x = clamp(e.x + e.pushX * force * pushStep, -15, 15);
    e.dist = Math.max(0, e.dist + e.pushDist * force * pushStep);
    e.pushTime = Math.max(0, e.pushTime - dt);
  }
  const speed = isBot ? (e.speed || 9) : STATS[e.charId].speed;
  const yaw = isBot ? 0 : e.yaw;
  const moveX = -Math.sin(yaw) * forward + Math.cos(yaw) * side;
  const moveForward = Math.cos(yaw) * forward + Math.sin(yaw) * side;
  if (e.frozen <= 0 && e.stun <= 0 && e.pushTime <= 0) {
    e.x = clamp(e.x + moveX * speed * dt * 1.25, -14, 14);
    e.dist = Math.max(0, e.dist + moveForward * speed * dt * 2.2);
  }
  if (e.jumpTime > 0) {
    e.jumpTime = Math.max(0, e.jumpTime - dt);
    const elapsed = 0.72 - e.jumpTime;
    e.jumpHeight = Math.max(0, 7 * elapsed - 9 * elapsed * elapsed);
  } else e.jumpHeight = 0;
  if (e.dist >= TRACK_LENGTH) {
    e.dist -= TRACK_LENGTH;
    e.lap++;
    if (e.lap > 15) {
      e.finished = true;
      if (!room.winnerId && !isBot) room.winnerId = e.id;
      emit(room, 'game:event', { event: 'finish', targetId: e.id, nick: e.nick });
    } else {
      e.charId = randomChar();
      e.maxHp = STATS[e.charId].hp;
      e.hp = e.maxHp;
      e.skillCd = 0;
      emit(room, 'game:event', { event: 'lap', targetId: e.id, lap: e.lap, charId: e.charId });
    }
  }
}
function updateTurrets(room, dt) {
  for (let i = room.turrets.length - 1; i >= 0; i--) {
    const turret = room.turrets[i];
    turret.cd -= dt;
    if (turret.cd > 0) continue;
    const targets = allEntities(room).filter(e => e.id !== turret.ownerId && e.charId !== 4 && !e.dead && !e.finished);
    let target = null, minD = 24;
    for (const e of targets) {
      const d = Math.hypot(e.x - turret.x, e.dist - turret.dist);
      if (d < minD) { minD = d; target = e; }
    }
    if (target) {
      turret.cd = 0.55;
      applyDamage(room, target, 7, turret.ownerId);
      emit(room, 'game:event', { event: 'turret-shot', turretId: turret.id, targetId: target.id });
    } else turret.cd = 0.12;
  }
}

function handleMessage(ws, msg) {
  const requestId = msg.requestId;
  const entry = socketPlayers.get(ws);
  if (msg.type === 'room:heartbeat') return;
  if (msg.type === 'rooms:list') {
    return reply(ws, requestId, true, { rooms: [...rooms.values()].filter(r => r.phase === 'waiting' && !r.closed).map(roomSummary) });
  }
  if (msg.type === 'room:create') {
    if (entry) return reply(ws, requestId, false, {}, '이미 방에 참가 중입니다.');
    const id = randomId(6);
    const room = {
      id, name: cleanName(msg.name, '새 레이스 방'), maxPlayers: MAX_PLAYERS,
      passwordHash: String(msg.password || '').trim() ? hashPassword(String(msg.password).slice(0, 32)) : '',
      phase: 'waiting', players: new Map(), bots: [], turrets: [], nextBotId: 0, hostId: '', winnerId: '', lastSnapshot: 0, closed: false,
    };
    const p = makePlayer(ws, cleanName(msg.nick, '플레이어'), 0, true, 0);
    room.hostId = p.id; room.players.set(p.id, p); rooms.set(id, room);
    socketPlayers.set(ws, { roomId: id, playerId: p.id });
    reply(ws, requestId, true, { roomId: id, playerId: p.id, host: true });
    broadcastSnapshot(room);
    return;
  }
  if (msg.type === 'room:join') {
    if (entry) return reply(ws, requestId, false, {}, '이미 다른 방에 참가 중입니다.');
    const room = rooms.get(String(msg.roomId || '').toUpperCase());
    if (!room || room.closed || room.phase !== 'waiting') return reply(ws, requestId, false, {}, '입장할 수 없는 방입니다.');
    if (room.players.size >= room.maxPlayers) return reply(ws, requestId, false, {}, '방이 가득 찼습니다.');
    const pass = String(msg.password || '').trim();
    if (room.passwordHash && hashPassword(pass) !== room.passwordHash) return reply(ws, requestId, false, {}, '비밀번호가 올바르지 않습니다.');
    const idx = room.players.size;
    const p = makePlayer(ws, cleanName(msg.nick, '플레이어'), (idx - 3.5) * 2.2, false, idx);
    room.players.set(p.id, p); socketPlayers.set(ws, { roomId: room.id, playerId: p.id });
    reply(ws, requestId, true, { roomId: room.id, playerId: p.id, host: false });
    emit(room, 'room:notice', { message: `${p.nick} 님이 참가했습니다.` });
    broadcastSnapshot(room);
    return;
  }
  if (msg.type === 'room:ready') {
    const room = roomForSocket(ws); const p = room && findPlayer(room, ws);
    if (!room || !p || room.phase !== 'waiting') return reply(ws, requestId, false, {}, '대기 중인 방에서만 준비할 수 있습니다.');
    p.ready = Boolean(msg.ready);
    reply(ws, requestId, true, { ready: p.ready }); broadcastSnapshot(room); return;
  }
  if (msg.type === 'room:start') {
    const room = roomForSocket(ws); const p = room && findPlayer(room, ws);
    if (!room || !p || room.hostId !== p.id) return reply(ws, requestId, false, {}, '방장만 시작할 수 있습니다.');
    if (room.phase !== 'waiting') return reply(ws, requestId, false, {}, '이미 시작된 방입니다.');
    if (room.players.size < 2) return reply(ws, requestId, false, {}, '실제 플레이어가 2명 이상 있어야 시작할 수 있습니다.');
    if ([...room.players.values()].some(x => !x.ready)) return reply(ws, requestId, false, {}, '모든 참가자가 준비해야 시작할 수 있습니다.');
    reply(ws, requestId, true, { started: true }); startRace(room); return;
  }
  if (msg.type === 'room:leave') {
    leaveRoom(ws); reply(ws, requestId, true, {}); return;
  }
  if (msg.type === 'input') {
    const room = roomForSocket(ws); const p = room && findPlayer(room, ws);
    if (!room || !p || room.phase !== 'racing' || p.dead || p.finished) return;
    const now = Date.now();
    if (p.lastInputAt && now - p.lastInputAt < 12) return;
    p.lastInputAt = now;
    p.forward = clamp(Number(msg.forward), -1, 1); p.side = clamp(Number(msg.side), -1, 1);
    p.yaw = clamp(Number(msg.yaw), -Math.PI * 4, Math.PI * 4); p.pitch = clamp(Number(msg.pitch), -1, 1);
    if (msg.jump) p.jumpTime = 0.72;
    return;
  }
  if (msg.type === 'action') {
    const room = roomForSocket(ws); const p = room && findPlayer(room, ws);
    if (!room || !p) return;
    handleAction(room, p, String(msg.action || ''), msg);
    return;
  }
  if (msg.type === 'room:quick') {
    if (entry) return reply(ws, requestId, false, {}, '이미 방에 참가 중입니다.');
    let room = [...rooms.values()].find(r => r.phase === 'waiting' && !r.passwordHash && r.players.size < r.maxPlayers);
    if (room) {
      const idx = room.players.size;
      const p = makePlayer(ws, cleanName(msg.nick, '플레이어'), (idx - 3.5) * 2.2, false, idx);
      room.players.set(p.id, p); socketPlayers.set(ws, { roomId: room.id, playerId: p.id });
      reply(ws, requestId, true, { roomId: room.id, playerId: p.id, host: false });
      broadcastSnapshot(room);
    } else {
      const id = randomId(6);
      room = { id, name: '빠른 매치', maxPlayers: MAX_PLAYERS, passwordHash: '', phase: 'waiting', players: new Map(), bots: [], turrets: [], nextBotId: 0, hostId: '', winnerId: '', lastSnapshot: 0, closed: false };
      const p = makePlayer(ws, cleanName(msg.nick, '플레이어'), 0, true, 0); room.hostId = p.id;
      room.players.set(p.id, p); rooms.set(id, room); socketPlayers.set(ws, { roomId: id, playerId: p.id });
      reply(ws, requestId, true, { roomId: id, playerId: p.id, host: true }); broadcastSnapshot(room);
    }
    return;
  }
  if (requestId) reply(ws, requestId, false, {}, '지원하지 않는 요청입니다.');
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try { handleMessage(ws, msg); } catch (error) {
      console.error('message handler error', error);
      if (msg.requestId) reply(ws, msg.requestId, false, {}, '서버에서 요청을 처리하지 못했습니다.');
    }
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
  send(ws, { type: 'server:hello', protocol: 1, maxPlayers: MAX_PLAYERS });
});

setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const room of rooms.values()) {
    if (room.phase === 'racing') {
      for (const p of room.players.values()) updateEntity(room, p, dt, false);
      for (const b of room.bots) updateEntity(room, b, dt, true);
      updateTurrets(room, dt);
      const humans = [...room.players.values()];
      if (humans.length && humans.every(p => p.finished)) {
        room.phase = 'finished';
        emit(room, 'race:finished', { winnerId: room.winnerId });
      }
      broadcastSnapshot(room);
    }
  }
}, TICK_MS);

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Blood Pressure Marathon server listening on :${PORT}`);
});
