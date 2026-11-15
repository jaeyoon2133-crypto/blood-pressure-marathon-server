'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 10000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
// The game is hosted on itch.io (and may be previewed from another origin).
// No cookies or authenticated browser sessions are used by these endpoints.
app.use(cors({ origin: true, methods: ['GET', 'OPTIONS'] }));

const METERED_DOMAIN = String(process.env.METERED_DOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');
const METERED_TURN_API_KEY = String(process.env.METERED_TURN_API_KEY || '').trim();
const METERED_REGION = String(process.env.METERED_REGION || 'asia').trim() || 'asia';

let iceCache = null;
let iceCacheUntil = 0;
let iceRequestInFlight = null;
const ICE_CACHE_MS = 5 * 60 * 1000;

function turnIsConfigured(iceServers) {
  return Array.isArray(iceServers) && iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url))
      && typeof server.username === 'string' && server.username.length > 0
      && typeof server.credential === 'string' && server.credential.length > 0;
  });
}

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'BEAT BLOOM PeerServer',
    peerPath: '/peerjs',
    turnRelayConfigured: Boolean(METERED_DOMAIN && METERED_TURN_API_KEY),
  });
});

async function loadMeteredIceServers() {
  if (!METERED_DOMAIN || !METERED_TURN_API_KEY) {
    return { configured: false, iceServers: [], message: 'Metered TURN environment variables are not configured.' };
  }

  const now = Date.now();
  if (iceCache && now < iceCacheUntil) return iceCache;
  if (iceRequestInFlight) return iceRequestInFlight;

  iceRequestInFlight = (async () => {
    const url = new URL(`https://${METERED_DOMAIN}/api/v1/turn/credentials`);
    url.searchParams.set('apiKey', METERED_TURN_API_KEY);
    if (METERED_REGION) url.searchParams.set('region', METERED_REGION);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Metered TURN returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      const iceServers = (Array.isArray(payload) ? payload : [])
        .filter((item) => item && item.urls)
        .map((item) => ({
          urls: item.urls,
          ...(item.username ? { username: item.username } : {}),
          ...(item.credential ? { credential: item.credential } : {}),
        }))
        .filter((item) => {
          const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
          return urls.some((value) => typeof value === 'string' && /^(stun|turn|turns):/i.test(value));
        });

      const configured = turnIsConfigured(iceServers);
      const result = {
        configured,
        iceServers,
        ...(configured ? {} : { message: 'Metered responded, but no authenticated TURN URL was returned.' }),
      };
      if (configured) {
        iceCache = result;
        iceCacheUntil = Date.now() + ICE_CACHE_MS;
      }
      return result;
    } finally {
      clearTimeout(timeout);
      iceRequestInFlight = null;
    }
  })();

  return iceRequestInFlight;
}

app.get('/ice-config', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await loadMeteredIceServers();
    res.json({
      ok: true,
      configured: result.configured,
      iceServers: result.iceServers,
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (error) {
    console.error('[BEAT BLOOM] Could not load Metered TURN credentials:', error.message);
    // Keep signaling available even when TURN credentials are temporarily unavailable.
    res.status(200).json({
      ok: true,
      configured: false,
      iceServers: [],
      message: 'TURN credentials could not be loaded. Check Render environment variables and Metered status.',
    });
  }
});

// PeerServer only brokers signaling. The actual WebRTC media/data path can use
// Metered TURN when the peers cannot establish a direct P2P connection.
const peerServer = ExpressPeerServer(server, {
  path: '/',
  proxied: true,
  allow_discovery: false,
  debug: process.env.PEER_DEBUG === 'true',
});
app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[BEAT BLOOM] Peer connected: ${client.getId()}`);
});
peerServer.on('disconnect', (client) => {
  console.log(`[BEAT BLOOM] Peer disconnected: ${client.getId()}`);
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('BEAT BLOOM multiplayer server is running.');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[BEAT BLOOM] Server listening on ${port}; PeerJS path /peerjs`);
  console.log(`[BEAT BLOOM] Metered TURN ${METERED_DOMAIN && METERED_TURN_API_KEY ? 'environment configured' : 'not configured yet'}`);
});

function shutdown(signal) {
  console.log(`[BEAT BLOOM] ${signal} received; shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
