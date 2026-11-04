// Operación Nini · Worker de Cloudflare
//   /              → el juego (archivos estáticos del repositorio)
//   /api/ping      → comprobación: el juego detecta solo que está en Cloudflare
//   /api/top       → GET  ?mode=story|survival · diez mejores puntuaciones
//   /api/score     → POST publica una puntuación
//   /ws/<código>   → sala del modo cooperativo (WebSocket)
// La clasificación y las salas usan Durable Objects (capa gratuita, sin KV que configurar).
import { DurableObject } from 'cloudflare:workers';

const MAX_TOP = 25;
const MODES = ['story', 'survival'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function cleanName(s) {
  return String(s || '').replace(/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñü _-]/g, '').trim().slice(0, 14);
}
// Filtro de sentido común: evita números imposibles. No es un antitrampas real.
function plausible(s) {
  const maxScore = s.kills * 2600 + s.round * 1500 + 2000;
  return s.kills >= 0 && s.round >= 1 && s.round <= 1000 && s.score <= maxScore;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ping') return json({ nini: true });
    if (url.pathname === '/api/top' || url.pathname === '/api/score') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return env.BOARD.get(env.BOARD.idFromName('global')).fetch(request);
    }
    const room = url.pathname.match(/^\/ws\/([a-z0-9]{3,6})$/);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Se esperaba un WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

/* Clasificación: una sola instancia guarda las dos listas */
export class NiniBoard extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/top' && request.method === 'GET') {
      const asked = url.searchParams.get('mode');
      const mode = MODES.includes(asked) ? asked : 'story';
      const list = (await this.ctx.storage.get('lb:' + mode)) || [];
      return json({ top: list.slice(0, 10) });
    }
    if (url.pathname === '/api/score' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'json' }, 400); }
      const s = {
        name: cleanName(body.name),
        score: Math.floor(Number(body.score)),
        kills: Math.floor(Number(body.kills)),
        round: Math.floor(Number(body.round)),
        mode: MODES.includes(body.mode) ? body.mode : null,
      };
      const ok = s.name && s.mode && Number.isFinite(s.score) && Number.isFinite(s.kills) &&
                 Number.isFinite(s.round) && s.score > 0 && plausible(s);
      if (!ok) return json({ error: 'invalid' }, 400);
      const key = 'lb:' + s.mode;
      const list = (await this.ctx.storage.get(key)) || [];
      // Una entrada por nombre: se queda la mejor
      const old = list.findIndex((r) => r.name.toLowerCase() === s.name.toLowerCase());
      if (old >= 0 && list[old].score >= s.score) return json({ ok: true, best: true });
      if (old >= 0) list.splice(old, 1);
      list.push({ name: s.name, score: s.score, round: s.round, date: Date.now() });
      list.sort((a, b) => b.score - a.score);
      await this.ctx.storage.put(key, list.slice(0, MAX_TOP));
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  }
}

/* Sala del cooperativo: reenvía mensajes y guarda la "presencia" (posición, personaje...) de cada jugador.
   Usa la API de hibernación: la sala no consume nada mientras nadie habla. */
export class NiniRoom extends DurableObject {
  async fetch() {
    if (this.ctx.getWebSockets().length >= 8) return new Response('Sala llena', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peer = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer, presence: {} });
    server.send(JSON.stringify({ t: 'hello', peer, peers: this.list() }));
    this.broadcast({ t: 'pres', peer, presence: {} }, server);
    return new Response(null, { status: 101, webSocket: client });
  }
  list() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) out.push({ peer: a.peer, presence: a.presence });
    }
    return out;
  }
  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch (e) { /* conexión cerrándose */ }
    }
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 6000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m || typeof m !== 'object') return;
    if (m.t === 'emit' && typeof m.topic === 'string' && /^[a-z][a-z0-9_.-]{0,47}$/.test(m.topic)) {
      this.broadcast({ t: 'msg', topic: m.topic, data: m.data, peer: a.peer });
    } else if (m.t === 'presence' && m.p && typeof m.p === 'object' && !Array.isArray(m.p)) {
      const next = { ...a.presence };
      for (const k of Object.keys(m.p)) { if (m.p[k] === null) delete next[k]; else next[k] = m.p[k]; }
      if (JSON.stringify(next).length > 1500) return;
      a.presence = next;
      ws.serializeAttachment(a);
      this.broadcast({ t: 'pres', peer: a.peer, presence: next });
    }
  }
  async webSocketClose(ws) { this.gone(ws); }
  async webSocketError(ws) { this.gone(ws); }
  gone(ws) {
    const a = ws.deserializeAttachment();
    try { ws.close(1000, 'adios'); } catch (e) { /* ya cerrada */ }
    if (a) this.broadcast({ t: 'left', peer: a.peer }, ws);
  }
}
