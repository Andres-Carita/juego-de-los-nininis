// Operación Nini · API de clasificación online
// Cloudflare Worker + KV (capa gratuita). Rutas:
//   GET  /api/top?mode=story|survival   → diez mejores puntuaciones
//   POST /api/score                     → publica una puntuación

const MAX_TOP = 25;
const MODES = ['story', 'survival'];

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors(env) });
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
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (url.pathname === '/api/top' && request.method === 'GET') {
      const asked = url.searchParams.get('mode');
      const mode = MODES.includes(asked) ? asked : 'story';
      const list = (await env.SCORES.get('lb:' + mode, 'json')) || [];
      return json(env, { top: list.slice(0, 10) });
    }

    if (url.pathname === '/api/score' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json(env, { error: 'json' }, 400); }
      const s = {
        name: cleanName(body.name),
        score: Math.floor(Number(body.score)),
        kills: Math.floor(Number(body.kills)),
        round: Math.floor(Number(body.round)),
        mode: MODES.includes(body.mode) ? body.mode : null,
      };
      const ok = s.name && s.mode && Number.isFinite(s.score) && Number.isFinite(s.kills) &&
                 Number.isFinite(s.round) && s.score > 0 && plausible(s);
      if (!ok) return json(env, { error: 'invalid' }, 400);

      const key = 'lb:' + s.mode;
      const list = (await env.SCORES.get(key, 'json')) || [];
      list.push({ name: s.name, score: s.score, round: s.round, date: Date.now() });
      list.sort((a, b) => b.score - a.score);
      await env.SCORES.put(key, JSON.stringify(list.slice(0, MAX_TOP)));
      return json(env, { ok: true });
    }

    return json(env, { error: 'not_found' }, 404);
  },
};
