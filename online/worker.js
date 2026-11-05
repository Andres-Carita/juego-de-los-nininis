// Operación Nini · Worker de Cloudflare
//   /              → el juego (archivos estáticos del repositorio)
//   /api/ping      → comprobación: el juego detecta solo que está en Cloudflare
//   /api/top       → GET  ?mode=story|survival · diez mejores puntuaciones
//   /api/score     → POST publica una puntuación
//   /ws/<código>   → sala del modo cooperativo (WebSocket)
//   /fotos         → página para enviar una foto (archivo estático)
//   /fotos/ver     → galería privada; sus datos piden la clave PHOTOS_KEY
//   /api/fotos     → POST envía una foto · GET lista (con clave)
//   /api/fotos/<id> → GET descarga · DELETE borra (con clave)
//   /api/fotos/terminos → GET términos vigentes (público)
//   /api/fotos/<id>/documento → GET documento de consentimiento (con clave)
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
    if (url.pathname === '/api/fotos' || url.pathname.startsWith('/api/fotos/')) {
      return env.PHOTOS.get(env.PHOTOS.idFromName('global')).fetch(request);
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

/* Buzón de fotos privado. Enviar es abierto (con límites); ver, descargar y borrar exige PHOTOS_KEY.
   Sin la clave configurada, la parte privada queda cerrada. */
const TERMS_VERSION = '1 (5 de noviembre de 2026)';
const TERMS_TEXT = `TÉRMINOS DE USO DE TU IMAGEN · OPERACIÓN NINI

1. Quién lo organiza. Operación Nini es un juego gratuito y sin ánimo de lucro, hecho por Heverton Marques y un grupo de amigos. El responsable de tus datos es Heverton Marques. Para cualquier petición, escríbele directamente por el mismo medio por el que recibiste este enlace.

2. Qué autorizas. Autorizas a usar tu imagen y el nombre o apodo que indiques para crear un personaje del juego, tanto en el juego como en capturas, imágenes y vídeos que lo muestren o lo den a conocer. La autorización es gratuita y nadie recibirá dinero por ella. Si algún día se quisiera ganar dinero con el juego, se te pedirá un permiso nuevo.

3. Qué podemos hacer con la foto. Recortarla, retocarla, animarla, ponerla sobre un cuerpo dibujado y dar al personaje un nombre inventado, un papel, habilidades y frases de humor.

4. Qué no haremos. No la usaremos en contenido sexual ni para humillarte por tu origen, religión, físico, género u orientación. No la venderemos ni la usaremos para otros proyectos.

5. Dónde estará. La foto enviada se guarda de forma privada en Cloudflare y solo la ven los organizadores. Si se usa en el juego, será pública: cualquiera podrá verla o copiarla, y las imágenes del juego también se guardan en un repositorio público de GitHub. Estos servicios pueden tratar datos fuera de la Unión Europea.

6. Qué confirmas. Que eres la persona que aparece en la foto, que no aparece nadie más y que tienes 18 años o más.

7. Cómo retirar el permiso. Puedes retirarlo cuando quieras, gratis y sin dar explicaciones. Quitaremos tu imagen del juego y borraremos tu foto lo antes posible, en un máximo de 30 días. Esto no afecta al uso anterior a tu petición, y no podemos borrar las copias que otras personas hayan hecho.

8. Tus derechos. La base para usar tus datos es tu consentimiento. Puedes pedir acceso, corrección, borrado, limitación u oposición, y la portabilidad de tus datos. También puedes reclamar ante la Agencia Española de Protección de Datos (aepd.es).

9. Qué guardamos como prueba. Guardamos tu nombre y apellidos, tu apodo, la fecha y hora, la versión de estos términos y una huella de la foto, para poder demostrar que diste tu permiso. Este documento no incluye tu dirección IP. Lo conservaremos hasta 3 años después de borrar la foto. Si tu foto no se usa, la borraremos cuando ya no haga falta.`;
const PHOTO_MAX_BYTES = 1800000; // una fila de SQLite admite 2 MB
const PHOTO_MAX_COUNT = 300;
const PHOTO_MAX_PER_HOUR = 20;
const PHOTO_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
function photoJson(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...PHOTO_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function cleanText(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Se mira el contenido real del archivo, no lo que diga el navegador
function photoType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
async function sameKey(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const x = await hash(a), y = await hash(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function consentDocument(c) {
  const lines = [
    'DOCUMENTO DE CONSENTIMIENTO · OPERACIÓN NINI',
    '',
    'Referencia: ' + c.id,
    'Fecha y hora (UTC): ' + new Date(c.accepted_at).toISOString(),
    'Nombre y apellidos: ' + c.full_name,
    'Apodo: ' + (c.nickname || '(ninguno)'),
    'Versión de los términos: ' + c.terms_version,
    'Huella SHA-256 de la foto: ' + c.photo_sha256,
    '',
    'La persona indicada escribió su nombre, marcó estas casillas y pulsó ENVIAR FOTO:',
    '[x] Soy la persona que aparece en la foto, no aparece nadie más y tengo 18 años o más.',
    '[x] He leído los términos y autorizo el uso de mi imagen en las condiciones indicadas.',
  ];
  if (c.deleted_at) lines.push('', 'Foto borrada el (UTC): ' + new Date(c.deleted_at).toISOString());
  lines.push('', '------------------------------------------------------------', '', c.terms_text, '');
  return lines.join('\n');
}
async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class NiniPhotos extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, created INTEGER NOT NULL, data BLOB NOT NULL)`);
    // El documento se conserva aunque se borre la foto: es la prueba del permiso
    this.sql.exec(`CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, nickname TEXT NOT NULL, terms_version TEXT NOT NULL,
      terms_text TEXT NOT NULL, photo_sha256 TEXT NOT NULL, accepted_at INTEGER NOT NULL, deleted_at INTEGER)`);
    this.hits = new Map(); // solo en memoria: no se guarda ninguna IP
  }
  async authorized(request) {
    const key = this.env.PHOTOS_KEY;
    const auth = request.headers.get('Authorization') || '';
    return !!key && auth.startsWith('Bearer ') && (await sameKey(auth.slice(7), key));
  }
  limited(request) {
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const now = Date.now();
    const recent = (this.hits.get(ip) || []).filter((t) => now - t < 3600000);
    if (recent.length >= PHOTO_MAX_PER_HOUR) return true;
    recent.push(now);
    this.hits.set(ip, recent);
    return false;
  }
  async upload(request, url) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return photoJson({ error: 'origin' }, 403);
    const length = Number(request.headers.get('Content-Length'));
    if (!length) return photoJson({ error: 'length' }, 411);
    if (length > PHOTO_MAX_BYTES + 4096) return photoJson({ error: 'too_big' }, 413);
    if (this.limited(request)) return photoJson({ error: 'too_many' }, 429);
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM photos').one().n;
    if (count >= PHOTO_MAX_COUNT) return photoJson({ error: 'full' }, 507);
    let form;
    try { form = await request.formData(); } catch (e) { return photoJson({ error: 'form' }, 400); }
    const fullName = cleanText(form.get('fullname'), 80);
    const nickname = cleanText(form.get('name'), 30);
    const note = cleanText(form.get('note'), 200);
    const file = form.get('photo');
    if (fullName.split(' ').length < 2) return photoJson({ error: 'fullname' }, 400);
    if (form.get('terms') !== TERMS_VERSION) return photoJson({ error: 'terms_changed' }, 409);
    if (form.get('identity') !== 'yes' || form.get('consent') !== 'yes') return photoJson({ error: 'consent' }, 400);
    if (!file || typeof file === 'string') return photoJson({ error: 'photo' }, 400);
    if (file.size > PHOTO_MAX_BYTES) return photoJson({ error: 'too_big' }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = photoType(bytes);
    if (!mime) return photoJson({ error: 'type' }, 415);
    const id = crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
    const consent = {
      id, full_name: fullName, nickname, terms_version: TERMS_VERSION, terms_text: TERMS_TEXT,
      photo_sha256: await sha256Hex(bytes), accepted_at: now, deleted_at: null,
    };
    // Sin await entre los dos INSERT: se guardan juntos o no se guarda ninguno
    this.sql.exec('INSERT INTO photos (id, name, note, mime, size, created, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, nickname || fullName, note, mime, bytes.length, now, bytes.buffer);
    this.sql.exec('INSERT INTO consents (id, full_name, nickname, terms_version, terms_text, photo_sha256, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      consent.id, consent.full_name, consent.nickname, consent.terms_version, consent.terms_text, consent.photo_sha256, consent.accepted_at);
    return photoJson({ ok: true, document: consentDocument(consent) }, 201);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const one = url.pathname.match(/^\/api\/fotos\/([a-f0-9]{32})$/);
    const doc = url.pathname.match(/^\/api\/fotos\/([a-f0-9]{32})\/documento$/);
    if (url.pathname === '/api/fotos/terminos' && request.method === 'GET') {
      return photoJson({ version: TERMS_VERSION, text: TERMS_TEXT });
    }
    if (url.pathname === '/api/fotos' && request.method === 'POST') return this.upload(request, url);
    if (!this.env.PHOTOS_KEY) return photoJson({ error: 'not_configured' }, 503);
    if (!(await this.authorized(request))) return photoJson({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/fotos' && request.method === 'GET') {
      const photos = this.sql.exec(`SELECT p.id, p.name, p.note, p.mime, p.size, p.created, c.full_name, c.terms_version
        FROM photos p LEFT JOIN consents c ON c.id = p.id ORDER BY p.created DESC`).toArray();
      const removed = this.sql.exec('SELECT id, full_name, nickname, accepted_at, deleted_at FROM consents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').toArray();
      return photoJson({ photos, removed, max: PHOTO_MAX_COUNT });
    }
    if (doc && request.method === 'GET') {
      const rows = this.sql.exec('SELECT * FROM consents WHERE id = ?', doc[1]).toArray();
      if (!rows.length) return photoJson({ error: 'not_found' }, 404);
      return new Response(consentDocument(rows[0]), { headers: { ...PHOTO_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (one && request.method === 'GET') {
      const rows = this.sql.exec('SELECT mime, data FROM photos WHERE id = ?', one[1]).toArray();
      if (!rows.length) return photoJson({ error: 'not_found' }, 404);
      return new Response(rows[0].data, { headers: { ...PHOTO_HEADERS, 'Content-Type': rows[0].mime } });
    }
    if (one && request.method === 'DELETE') {
      this.sql.exec('DELETE FROM photos WHERE id = ?', one[1]);
      this.sql.exec('UPDATE consents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), one[1]);
      return photoJson({ ok: true });
    }
    return photoJson({ error: 'not_found' }, 404);
  }
}
