const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const app = express(); app.use(express.static('public'));
const srv = http.createServer(app);
const wss = new WebSocketServer({ noServer: true }), wss2 = new WebSocketServer({ noServer: true });
require('./werbinich.js')(wss2);
srv.on('upgrade', (req, sock, head) => {
  const p = req.url.split('?')[0], w = p === '/ws' ? wss : p === '/ws2' ? wss2 : null;
  if (!w) return sock.destroy();
  w.handleUpgrade(req, sock, head, ws => w.emit('connection', ws, req));
});

const Q = require('./questions.js').concat(require('./questions2.js'));

const rooms = {};
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const getRoom = id => rooms[id] || (rooms[id] = { id, ph: 'lobby', P: {}, host: null, pool: [], votes: {}, fin: null, seq: [], cur: null });
const alive = r => Object.values(r.P).filter(p => p.h > 0 && p.id !== r.host); // Moderator spielt nicht mit
// Reihum: nächster lebender Spieler (ohne Moderator) bekommt die nächste Frage
function nextAsked(r) {
  const ids = r.seq.filter(i => r.P[i]), ok = i => alive(r).some(p => p.id === i), from = ids.indexOf(r.cur);
  for (let k = 1; k <= ids.length; k++) { const i = ids[(from + k + ids.length) % ids.length]; if (ok(i)) { r.cur = i; return; } }
}
const nq = r => { if (!r.pool.length) r.pool = Q.map((_, i) => i).sort(() => Math.random() - .5); return Q[r.pool.pop()]; };

function push(r) {
  const all = Object.values(r.P);
  for (const p of all) {
    const isHost = p.id === r.host;
    send(p.ws, {
      ph: r.ph, asked: r.ph === 'round' ? r.cur : null, you: p.id, host: r.host, show: r.show, endsAt: r.endsAt, res: r.res, winner: r.winner,
      players: all.map(x => ({ id: x.id, name: x.name, h: x.h, on: !!x.ws, voted: x.id in r.votes })),
      q: r.ph === 'finale' && r.fin && !r.fin.wait && r.fin.turn === 0 && r.fin.pl[1].id === p.id ? null : r.q && r.q[0], a: r.q && (isHost || r.show) ? r.q[1] : null,
      myVote: r.votes[p.id] || null,
      fin: r.fin && { pl: r.fin.pl, turn: r.fin.turn, n: r.fin.n, len: r.fin.len, wait: r.fin.wait, s: (isHost || r.ph === 'end' || r.ph === 'tie') ? r.fin.s : null }
    });
  }
}
function startRound(r) {
  r.ph = 'round'; r.q = nq(r); r.show = false; r.votes = {}; r.res = null; nextAsked(r);
  r.endsAt = Date.now() + 60000;
  clearTimeout(r.timer); r.timer = setTimeout(() => r.ph === 'round' && toVote(r), 60000);
}
function toVote(r) { clearTimeout(r.timer); r.ph = 'vote'; r.votes = {}; r.endsAt = null; }
function checkVotes(r) {
  const voters = alive(r).filter(p => p.ws);
  if (!voters.length || !voters.every(p => p.id in r.votes)) return;
  const counts = {}; alive(r).forEach(p => counts[p.id] = 0);
  Object.values(r.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
  const max = Math.max(...Object.values(counts));
  const tied = alive(r).filter(p => counts[p.id] === max);
  const loser = tied[Math.floor(Math.random() * tied.length)];
  loser.h--;
  r.res = { counts, loser: loser.name, tie: tied.length > 1, out: loser.h === 0 };
  r.ph = 'result';
}
function startFinale(r) {
  const a = alive(r);
  if (a.length < 2) { r.ph = 'end'; r.winner = a[0] ? a[0].name : '?'; return; }
  r.fin = { pl: a.slice(0, 2).map(p => ({ id: p.id, name: p.name })), s: [0, 0], turn: 0, n: 0, len: 10, wait: false };
  r.fin.qs = Array.from({ length: 10 }, () => nq(r));
  r.ph = 'finale'; r.q = r.fin.qs[0]; r.show = false;
}

wss.on('connection', ws => {
  const id = Math.random().toString(36).slice(2, 10); let r = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !r) {
      const room = getRoom(String(m.room || 'main').slice(0, 40));
      if (room.ph !== 'lobby') return send(ws, { err: 'Das Spiel in diesem Raum läuft schon.' });
      if (Object.keys(room.P).length >= 8) return send(ws, { err: 'Raum ist voll (max. 8).' });
      r = room; r.P[id] = { id, name: String(m.name || 'Spieler').slice(0, 20), h: 3, ws };
      r.seq.push(id);
      if (!r.host) r.host = id;
      return push(r);
    }
    if (!r) return;
    const host = id === r.host;
    if (m.t === 'start' && host && r.ph === 'lobby' && Object.keys(r.P).length >= 3) alive(r).length === 2 ? startFinale(r) : startRound(r);
    else if (m.t === 'reveal' && host) r.show = true;
    else if (m.t === 'next' && host && (r.ph === 'round' || r.ph === 'finale') && r.ph === 'round') { r.q = nq(r); r.show = false; nextAsked(r); }
    else if (m.t === 'toVote' && host && r.ph === 'round') toVote(r);
    else if (m.t === 'vote' && r.ph === 'vote' && alive(r).some(p => p.id === id) && alive(r).some(p => p.id === m.target) && m.target !== id) { r.votes[id] = m.target; checkVotes(r); }
    else if (m.t === 'cont' && host && r.ph === 'result') alive(r).length <= 2 ? startFinale(r) : startRound(r);
    else if (m.t === 'judge' && host && r.ph === 'finale' && !r.fin.wait) {
      const f = r.fin; if (m.w === 1) f.s[f.turn]++;
      f.n++;
      if (f.n >= f.len) { if (f.turn === 0) f.wait = true; else r.ph = 'done'; }
      else { r.q = f.qs[f.n]; r.show = false; }
    }
    else if (m.t === 'cont' && host && r.ph === 'finale' && r.fin.wait) { r.fin.wait = false; r.fin.turn = 1; r.fin.n = 0; r.q = r.fin.qs[0]; r.show = false; }
    else if (m.t === 'resolve' && host && r.ph === 'done') {
      const f = r.fin;
      if (f.s[0] === f.s[1]) r.ph = 'tie'; else { r.ph = 'end'; r.winner = f.pl[f.s[0] > f.s[1] ? 0 : 1].name; }
    }
    else if (m.t === 'tiebreak' && host && r.ph === 'tie') {
      Object.assign(r.fin, { s: [0, 0], turn: 0, n: 0, len: 1, wait: false, qs: [nq(r)] }); r.ph = 'finale'; r.q = r.fin.qs[0]; r.show = false;
    }
    else if (m.t === 'restart' && host && r.ph === 'end') {
      Object.values(r.P).forEach(p => p.h = 3); r.ph = 'lobby'; r.fin = null; r.q = null; r.winner = null; r.votes = {}; r.cur = null;
    }
    push(r);
  });
  ws.on('close', () => {
    if (!r) return;
    if (r.ph === 'lobby') delete r.P[id]; else if (r.P[id]) r.P[id].ws = null;
    if (!Object.values(r.P).some(p => p.ws)) { clearTimeout(r.timer); delete rooms[r.id]; return; }
    if (!r.P[r.host] || !r.P[r.host].ws) r.host = Object.values(r.P).find(p => p.ws).id;
    if (r.ph === 'vote') checkVotes(r);
    push(r);
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('Läuft auf Port ' + (process.env.PORT || 3000)));
