// "Wer bin ich?": Spielablauf. Phasen: lobby -> pick -> write -> play
const ANIMALS = ['🐼', '🐨', '🦊', '🐯', '🦁', '🐸', '🐵', '🐰', '🐶', '🐱', '🐷', '🐮', '🐧', '🐙', '🐢', '🦉'];
const FALLBACK = ['Albert Einstein', 'Cleopatra', 'Sherlock Holmes', 'Der Weihnachtsmann', 'Napoleon', 'Pinocchio', 'Dracula', 'Robin Hood', 'Marie Curie', 'Der Osterhase', 'Mozart', 'Zorro', 'Rotkäppchen', 'Aschenputtel', 'Leonardo da Vinci', 'Kolumbus'];

const rooms = {};
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const getRoom = id => rooms[id] || (rooms[id] = { id, ph: 'lobby', P: {}, seq: [], host: null, endsAt: null, timer: null });
const list = r => r.seq.map(i => r.P[i]).filter(Boolean);

function push(r) {
  const all = list(r), left = r.endsAt ? Math.max(0, r.endsAt - Date.now()) : null;
  for (const me of all) {
    send(me.ws, {
      ph: r.ph, you: me.id, host: r.host, left, order: r.ph === 'play' ? r.order : null,
      myTarget: me.target || null,
      myText: r.ph === 'write' && me.target ? (r.P[me.target].char || '') : '',
      players: all.map(p => ({
        id: p.id, name: p.name, animal: p.animal, on: !!p.ws,
        picked: !!p.target, taken: all.some(x => x.target === p.id), done: !!p.done, guessed: !!p.guessed,
        place: p.place || null, tries: p.tries || 0, wrong: p.wrong || '',
        // Den eigenen Charakter sieht man erst, wenn man ihn erraten hat
        char: r.ph === 'done' || (r.ph === 'play' && (p.id !== me.id || p.guessed)) ? p.char : null
      }))
    });
  }
}

// Tipp prüfen: Groß/Kleinschreibung, Akzente, Satzzeichen und Artikel egal, kleine Tippfehler erlaubt.
// Bei Namen mit mehreren Wörtern zählt auch der hintere Teil allein (z. B. "Einstein" oder "da Vinci").
const norm = t => String(t).toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(der|die|das|ein|eine|the) /, '');
function lev(a, b) { // Abstand mit Buchstabendreher (Damerau)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function matches(guess, answer) {
  const a = norm(guess), b = norm(answer); if (!a) return false;
  const words = b.split(' '), cands = [b];
  for (let i = 1; i < words.length; i++) { const suf = words.slice(i).join(' '); if (suf.length >= 4) cands.push(suf); } // Nachname bzw. hinterer Namensteil
  return cands.some(c => lev(a, c) <= (c.length >= 10 ? 2 : c.length >= 5 ? 1 : 0));
}

// Jeder wählt genau einen anderen Spieler, jeder Spieler darf nur einmal gewählt werden.
// Blockiert wird nur eine Wahl, nach der der letzte Wählende nur noch sich selbst übrig hätte.
function canPick(r, me, target) {
  const all = list(r);
  if (me.target || target === me.id || !r.P[target]) return 'Das geht nicht.';
  if (all.some(p => p.target === target)) return 'Dieser Spieler wurde schon gewählt.';
  const choosers = all.filter(p => !p.target && p.id !== me.id);
  const free = all.filter(p => p.id !== target && !all.some(x => x.target === p.id));
  if (choosers.length === 1 && free.length === 1 && choosers[0].id === free[0].id) return 'Diese Wahl würde das Spiel blockieren. Nimm jemand anderen.';
  return null;
}

function toWrite(r) {
  r.ph = 'write'; r.endsAt = Date.now() + 60000;
  clearTimeout(r.timer); r.timer = setTimeout(() => { if (r.ph === 'write') { finishWrite(r); push(r); } }, 60000);
}
function finishWrite(r) {
  clearTimeout(r.timer); r.endsAt = null;
  list(r).forEach(p => { if (!p.char) p.char = FALLBACK[Math.floor(Math.random() * FALLBACK.length)]; });
  // Zufällige Reihenfolge, wer mit dem Fragen anfängt
  const o = list(r).map(p => p.id);
  for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  r.order = o;
  r.ph = 'play';
}

function attach(wss) {
  wss.on('connection', ws => {
    const id = Math.random().toString(36).slice(2, 10); let r = null;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join' && !r) {
        const rm = getRoom(String(m.room || 'main').slice(0, 40));
        if (rm.ph !== 'lobby') return send(ws, { err: 'In diesem Raum läuft schon eine Runde.' });
        if (list(rm).length >= 12) return send(ws, { err: 'Raum ist voll (max. 12).' });
        r = rm; r.P[id] = { id, name: String(m.name || 'Spieler').slice(0, 20), animal: null, ws };
        r.seq.push(id); if (!r.host) r.host = id;
        return push(r);
      }
      if (!r) return;
      const me = r.P[id], host = id === r.host;
      if (m.t === 'avatar' && r.ph === 'lobby' && ANIMALS.includes(m.animal) && !list(r).some(p => p.animal === m.animal && p.id !== id)) me.animal = m.animal;
      else if (m.t === 'start' && host && r.ph === 'lobby' && list(r).length >= 2 && list(r).every(p => p.animal)) r.ph = 'pick';
      else if (m.t === 'pick' && r.ph === 'pick') {
        const e = canPick(r, me, m.target); if (e) return send(ws, { info: e });
        me.target = m.target; if (list(r).every(p => p.target)) toWrite(r);
      }
      else if (m.t === 'write' && r.ph === 'write' && me.target) {
        const t = String(m.text || '').trim().slice(0, 40); if (!t) return send(ws, { info: 'Bitte einen Charakter eintragen.' });
        r.P[me.target].char = t; me.done = true; if (list(r).every(p => p.done)) finishWrite(r);
      }
      else if (m.t === 'guess' && r.ph === 'play' && !me.guessed) {
        const g = String(m.text || '').trim().slice(0, 60); if (!g) return send(ws, { info: 'Bitte zuerst deinen Tipp eintippen.' });
        me.tries = (me.tries || 0) + 1;
        if (matches(g, me.char)) {
          me.guessed = true; me.place = list(r).filter(p => p.guessed).length;
          send(ws, { info: 'Richtig! 🎉 Du bist Platz ' + me.place + '.' });
          if (list(r).every(p => p.guessed)) r.ph = 'done';
        } else { me.wrong = g; send(ws, { info: 'Leider falsch. Frag weiter!' }); }
      }
      else if (m.t === 'finish' && host && r.ph === 'play') r.ph = 'done';
      else if (m.t === 'reset' && host && r.ph !== 'lobby') {
        clearTimeout(r.timer); r.endsAt = null; r.ph = 'lobby'; r.order = null;
        list(r).forEach(p => { p.target = null; p.char = null; p.done = false; p.guessed = false; p.place = null; p.tries = 0; p.wrong = ''; });
      }
      push(r);
    });
    ws.on('close', () => {
      if (!r || !r.P[id]) return;
      if (r.ph === 'lobby') { delete r.P[id]; r.seq = r.seq.filter(i => i !== id); } else r.P[id].ws = null;
      if (!list(r).some(p => p.ws)) { clearTimeout(r.timer); delete rooms[r.id]; return; }
      if (!r.P[r.host] || !r.P[r.host].ws) r.host = list(r).find(p => p.ws).id;
      push(r);
    });
  });
}
module.exports = attach;
module.exports._test = { canPick, getRoom, list, matches };
