#!/usr/bin/env node
// Turn TagPro replay recordings (.ndjson or .ndjson.gz) into readable CSV files.
//   node extract.js <replay or folder>... [--out <folder>] [--single]
// Default: <out>/<replay name>/events.csv, keypresses.csv, positions.csv.
// --single: one file <out>/<replay name>.csv holding the three tables, each under a "# name" line.
//
// seconds = game time (0 = play starts, negative = countdown). x, y = tiles from the map's top-left;
// speeds in tiles/s; angle in degrees, spin in degrees/s. Rejoins are merged by the server's session id.
// Recording facts relied on: records are [ms, type, payload]; "p" updates send only changed fields;
// rx/ry/lx/ly are in 100 px (tiles = x 2.5); s-* are running stat totals (restored onto a rejoiner's
// new id, so an id's first update is not an event); keys are signed counts (+ pressed, - released);
// s-prevent ticks once a second while preventing; s-support goes up 1 for a button and 2 for a block, each
// credited at the end of a 5 s window; sounds are sent for the player who caused them ("burst" boost, "teleport" portal, "powerup" pup).
// Tiles: 5 boost, 14/15 red/blue boost, 10 bomb, 13 portal (x.1 = used), 6.1-6.3 pup live, 6 empty,
// 9 gate (9 off, .1 green, .2 red, .3 blue).
const fs = require('fs'), zlib = require('zlib'), path = require('path');
// a replay is a file path, or (in the browser) { name, text }
const replayName = file => (typeof file === 'string' ? path.basename(file) : file.name).split('.')[0];

const TEAM = { 1: 'red', 2: 'blue' }, FLAG = { 1: 'red flag', 2: 'blue flag', 3: 'yellow flag' };
const PUPS = { tagpro: 'tagpro', bomb: 'rolling bomb', grip: 'juke juice' };
const PUP_TILE = { 1: 'juke juice', 2: 'rolling bomb', 3: 'tagpro', 4: 'top speed' };
const TILE = { 5: ['boost', 'burst'], 14: ['red boost', 'burst'], 15: ['blue boost', 'burst'],
  13: ['portal', 'teleport'], 10: ['bomb', 'explosion'] };
const GATE = ['off', 'green', 'red', 'blue'], KEYS = ['up', 'down', 'left', 'right'];
const STATS = { grabs: 'grab', captures: 'cap', returns: 'return', tags: 'tag', pops: 'pop', drops: 'drop',
  powerups: 'pup', handoffs: 'handoff', goodHandoffs: 'good handoff', flaccids: 'flaccid' };
const COLS = { events: ['seconds', 'event', 'player', 'team', 'x', 'y', 'details'],
  keypresses: ['seconds', 'player', 'key', 'action', 'key_change_number'],
  positions: ['seconds', 'player', 'x', 'y', 'vx', 'vy', 'angle', 'spin', 'alive', 'flag', 'powerups'] };
const r3 = v => v == null ? '' : Math.round(v * 1000) / 1000;
const r2 = v => Math.round(v * 100) / 100;

function extract(file) {
  let text = typeof file === 'string' ? fs.readFileSync(file) : file.text;
  if (typeof file === 'string' && file.endsWith('.gz')) text = zlib.gunzipSync(text);
  const recs = [];
  for (const line of text.toString().split('\n')) {
    try { const r = JSON.parse(line); if (Array.isArray(r) && r.length >= 3) recs.push(r); } catch { }
  }
  const meta = (recs.find(r => r[1] === 'recorder-metadata') || [])[2] || {};
  const start = (recs.find(r => r[1] === 'time' && r[2] && r[2].state === 1) || [0])[0];
  const sec = ms => Math.round(ms - start) / 1000;
  const ids = {}, person = {}, names = {}, sounds = [], pending = [], splats = [];
  const events = [], keypresses = [], positions = [];
  const name = id => names[person[id]] ?? `id ${id}`;
  const ev = (ms, event, id, x, y, details = '') => {
    const s = ids[id] || {};
    events.push({ ms, event, player: id == null ? '' : name(id), team: TEAM[s.team] || '',
      x: r3(x ?? s.x), y: r3(y ?? s.y), details });
  };
  const nearest = (x, y, only) => {
    let best = null;
    for (const [id, s] of Object.entries(ids)) {
      if (s.x == null || !s.present || (only && !only.has(+id))) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (!best || d < best[0]) best = [d, +id];
    }
    return best && best[1];
  };
  // a tile change belongs to whoever its sound was sent for, else to the nearest ball
  const credit = (ms, sound, x, y) => {
    const heard = new Set(sounds.filter(s => s[1] === sound && Math.abs(s[0] - ms) <= 150).map(s => s[2]));
    return heard.size ? [nearest(x, y, heard), 'sound'] : [nearest(x, y), 'nearest ball'];
  };
  for (const [t, n, p] of recs)
    if (n === 'replayPlayerMessage' && p && p.type === 'sound') sounds.push([t, p.data && p.data.s, p.for]);

  const kind = meta.ranked ? 'ranked' : meta.private ? 'private group' : 'public';
  let tiles = null, startTiles = null, score = null, teamNames = '', endMs = recs[recs.length - 1][0];
  const stands = [];
  for (const [t, n, p] of recs) {
    if (n === 'map') {
      tiles = p.tiles.map(col => col.map(Number));
      startTiles = tiles.map(col => [...col]);
      tiles.forEach((col, x) => col.forEach((v, y) => { if ([3, 4, 16].includes(v)) stands.push(`${FLAG[v === 16 ? 3 : v - 2]} at ${x + 0.5},${y + 0.5}`); }));
    }
    else if (n === 'teamNames') teamNames = `; red team ${p.redTeamName}; blue team ${p.blueTeamName}`;
    else if (n === 'time' && p && p.state === 1) ev(t, 'game start', null, null, null,
      `map ${meta.mapName}; ${meta.mapType}; ${kind}; ${meta.serverName}; length ${Math.round(p.time / 1000)} s${teamNames}; ${stands.join('; ')}; replay ${meta.uuid}`);
    else if (n === 'time' && p && p.state === 5) ev(t, 'overtime');
    else if (n === 'end') { ev(t, 'game end', null, null, null, `winner ${p.winner}`); endMs = t; break; }   // nothing after the end counts
    else if (n === 'score' && p) {
      const now = `red ${p.r || 0} - blue ${p.b || 0}`;
      if (score !== null && now !== score) ev(t, 'score', null, null, null, now);
      score = now;
    } else if (n === 'chat' && p) {
      if (ids[p.from]) ev(t, 'chat', p.from, null, null, `to ${p.to}: ${p.message}`);
      else if (!/ has (joined|left) the /.test(p.message)) ev(t, 'message', null, null, null, p.message);
    } else if (n === 'playerLeft' && ids[p]) { ev(t, 'leave', p); ids[p].present = false; }
    else if (n === 'splat' && p) splats.push({ ms: t, team: p.t, x: p.x / 40, y: p.y / 40 });
    else if (n === 'bomb' && p && p.type === 1) ev(t, 'explosion', null, p.x / 40, p.y / 40);
    else if (n === 'mapupdate' && tiles) mapUpdate(t, Array.isArray(p) ? p : [p]);
    else if (n === 'p') for (const u of Array.isArray(p) ? p : (p && p.u) || [p]) if (u && u.id != null) update(t, u);
  }

  function update(t, u) {
    const id = u.id, first = !ids[id];
    const s = ids[id] ??= { team: null, x: null, y: null, vx: 0, vy: 0, angle: 0, spin: 0, dead: true, flag: 0,
      pups: new Set(), keys: new Set(), present: true, stats: {} };
    if ((u.name || u.sessionId) && person[id] == null) {
      const key = u.sessionId || u.name, back = key in names;
      person[id] = key; names[key] ??= u.name;
      if (u.team) s.team = u.team;
      ev(t, back ? 'rejoin' : 'join', id);
    } else if (u.name) names[person[id]] = u.name;
    if (u.team && u.team !== s.team) { if (s.team) ev(t, 'switch team', id, null, null, `now ${TEAM[u.team]}`); s.team = u.team; }
    let moved = false;
    for (const [f, k, m] of [['rx', 'x', 2.5], ['ry', 'y', 2.5], ['lx', 'vx', 2.5], ['ly', 'vy', 2.5],
      ['a', 'angle', 180 / Math.PI], ['ra', 'spin', 180 / Math.PI]])
      if (u[f] != null) { s[k] = u[f] * m; moved = true; }
    const counted = [];
    for (const [f, v] of Object.entries(u)) {
      const stat = f.slice(2);
      if (!f.startsWith('s-') || typeof v !== 'number') continue;
      const gain = first ? 0 : v - (s.stats[stat] || 0);
      if (gain > 0 && STATS[stat]) counted.push(STATS[stat]);
      if (gain > 0 && stat === 'prevent') (s.prevent ??= []).push([t, s.x, s.y]);
      if (gain > 0 && stat === 'support') {
        if (gain % 2) (s.button ??= []).push([t, s.x, s.y]);
        if (gain > 1) (s.block ??= []).push([t, s.x, s.y]);
      }
      s.stats[stat] = v;
    }
    for (const k of ['score', 'points']) if (typeof u[k] === 'number') s.stats[k] = u[k];
    if (u.auth != null) s.auth = !!u.auth;
    if (u.dead != null && !!u.dead !== s.dead) { s.dead = !!u.dead; if (!first) ev(t, s.dead ? 'pop' : 'respawn', id); }
    let grabbed = false;
    const flagBefore = s.flag;
    if (u.flag !== undefined && (u.flag || 0) !== s.flag) {
      s.flag = u.flag || 0;
      if (s.flag) { ev(t, 'grab', id, null, null, FLAG[s.flag]); grabbed = true; }
    }
    for (const [f, word] of Object.entries(PUPS)) {
      if (u[f] == null || !!u[f] === s.pups.has(word)) continue;
      if (u[f]) { s.pups.add(word); ev(t, 'pup pickup', id, null, null, word); }
      else { s.pups.delete(word); ev(t, 'pup ended', id, null, null, word); }
    }
    const changes = [];
    for (const k of KEYS) {
      const v = u[k];
      if (v == null) continue;
      const down = typeof v === 'boolean' ? v : v > 0;
      if (down !== s.keys.has(k)) changes.push([typeof v === 'boolean' ? '' : Math.abs(v), k, down]);
    }
    for (const [n, k, down] of changes.sort((a, b) => a[0] - b[0])) {
      s.keys[down ? 'add' : 'delete'](k);
      keypresses.push({ ms: t, player: name(id), key: k, action: down ? 'pressed' : 'released', key_change_number: n });
    }
    // a grab the server counted without the flag field changing: either a cap and an instant regrab
    // (still holding after the update) or a grab and cap inside one server update (not holding)
    const flagName = FLAG[s.flag || flagBefore] || (meta.mapType === 'nf' ? 'yellow flag' : 'flag');
    const quiet = counted.includes('grab') && !grabbed, capped = counted.includes('cap');
    if (quiet && capped && !s.flag) ev(t, 'grab', id, null, null, `${flagName}; ` + (counted.includes('return')
      ? 'returned the carrier, grabbed and capped in the same server update' : 'grabbed and capped in the same server update'));
    if (capped) ev(t, 'cap', id, null, null, flagName + (counted.includes('pop') || (u.dead && !first)
      ? '; capped and popped at the same moment (known bug: touching the cap and getting tagged at once)' : ''));
    if (quiet && (s.flag || !capped)) ev(t, 'grab', id, null, null, `${flagName}; ` + (capped
      ? 'picked up again right after the cap (standing on the flag tile)' : 'counted by the server, flag never left the player'));
    for (const word of counted) {
      if (['handoff', 'good handoff', 'flaccid'].includes(word)) ev(t, word, id);
      else if (!['grab', 'cap'].includes(word)) pending.push({ t, word, id, x: s.x, y: s.y });
    }
    if (moved && s.x != null) positions.push({ ms: t, player: name(id), x: r3(s.x), y: r3(s.y), vx: r3(s.vx),
      vy: r3(s.vy), angle: r2(s.angle), spin: r2(s.spin), alive: s.dead ? 'no' : 'yes', flag: FLAG[s.flag] || '',
      powerups: [...s.pups].sort().join(' + ') });
  }

  function mapUpdate(t, updates) {
    const gates = {};
    for (const { x, y, v: raw } of updates) {
      const v = Number(raw), old = tiles[x] && tiles[x][y];
      if (old === undefined || old === v) continue;
      tiles[x][y] = v;
      const base = Math.floor(v), frac = Math.round((v - base) * 1000), cx = x + 0.5, cy = y + 0.5;
      if (TILE[base]) {
        const [label, sound] = TILE[base];
        if (frac === 100) { const [id, how] = credit(t, sound, cx, cy); ev(t, `${label} used`, id, cx, cy, how === 'sound' ? '' : 'credited to nearest ball'); }
        else if (frac === 0) ev(t, `${label} ready`, null, cx, cy);
      } else if (base === 6 && [100, 200, 300, 400].includes(frac)) ev(t, 'pup spawn', null, cx, cy, PUP_TILE[frac / 100]);
      else if (base === 6 && frac === 0 && [100, 200, 300].includes(Math.round((old - 6) * 1000)))
        ev(t, 'pup taken', null, cx, cy, PUP_TILE[Math.round((old - 6) * 10)]);
      else if (base === 9) (gates[GATE[Math.round(frac / 100)]] ??= []).push([cx, cy]);
    }
    for (const [colour, cells] of Object.entries(gates))
      ev(t, 'gate change', null, cells.reduce((a, c) => a + c[0], 0) / cells.length,
        cells.reduce((a, c) => a + c[1], 0) / cells.length, `${cells.length} tile${cells.length > 1 ? 's' : ''} turned ${colour}`);
  }

  // merge the return / tag / drop / pup counters into the pop and pickup rows, and add regrab context
  const used = new Set();
  const take = (t, word, test) => {
    let best = -1;
    pending.forEach((c, i) => {
      if (!used.has(i) && c.word === word && Math.abs(c.t - t) <= 400 && test(c) &&
        (best < 0 || Math.abs(c.t - t) < Math.abs(pending[best].t - t))) best = i;
    });
    if (best < 0) return null;
    used.add(best);
    return pending[best].id;
  };
  const teamOf = {};
  for (const [id, s] of Object.entries(ids)) teamOf[name(id)] = s.team;
  const holding = {}, lost = {};
  events.sort((a, b) => a.ms - b.ms);
  for (const e of events) {
    const me = c => name(c.id) === e.player, enemy = c => ids[c.id].team !== teamOf[e.player];
    if (e.event === 'grab') {
      const flag = e.details.split(';')[0];
      holding[e.player] = flag;
      if (lost[flag]) { e.details += `; previous carrier ${lost[flag][0]} popped ${((e.ms - lost[flag][1]) / 1000).toFixed(2)} s earlier`; delete lost[flag]; }
    } else if (e.event === 'cap') { delete lost[holding[e.player]]; delete holding[e.player]; }
    else if (e.event === 'pop') {
      const flag = holding[e.player];
      delete holding[e.player];
      take(e.ms, 'pop', me);
      const sp = splats.find(p => !p.used && p.team === teamOf[e.player] && Math.abs(p.ms - e.ms) <= 100);
      if (sp) sp.used = true;
      const splat = sp ? `; splat at ${r3(sp.x)},${r3(sp.y)}` : '';
      if (flag) {
        lost[flag] = [e.player, e.ms];
        take(e.ms, 'drop', me);
        const by = take(e.ms, 'return', enemy);
        take(e.ms, 'tag', enemy);
        e.details = `carrying ${flag}; ` + (by != null ? `returned by ${name(by)}` : 'no enemy credited (spike, gate or self)') + splat;
      } else {
        const by = take(e.ms, 'tag', enemy);
        e.details = (by != null ? `tagged by ${name(by)}` : 'no enemy credited (spike, gate, explosion or self)') + splat;
      }
    } else if (e.event === 'pup pickup') take(e.ms, 'pup', me);
  }
  pending.forEach((c, i) => {
    if (used.has(i)) return;
    if (c.word === 'pup') ev(c.t, 'pup pickup', c.id, c.x, c.y, 'a pup the player already had (counted by the server)');
    else ev(c.t, c.word, c.id, c.x, c.y, 'counted by the server only');
  });
  // where a player was at an earlier moment (for stretches whose start is only known afterwards)
  const at = (id, ms) => {
    let best = null;
    for (const p of positions) { if (p.ms > ms) break; if (p.player === name(id)) best = p; }
    return best ? [best.x, best.y] : [null, null];
  };
  // button and block: each s-support step is credited at the end of a 5 s window, so a stretch is the
  // union of [step - 5 s, step] (this reproduces tagpro.eu's start and stop times)
  for (const [id, s] of Object.entries(ids)) for (const kind of ['button', 'block']) {
    const steps = s[kind] || [];
    for (let i = 0; i < steps.length;) {
      let j = i;
      while (j + 1 < steps.length && steps[j + 1][0] - 5000 <= steps[j][0]) j++;
      ev(steps[i][0] - 5000, `${kind} start`, +id, ...at(id, steps[i][0] - 5000));
      ev(steps[j][0], `${kind} stop`, +id, steps[j][1], steps[j][2], `${((steps[j][0] - steps[i][0]) / 1000 + 5).toFixed(2)} s`);
      i = j + 1;
    }
  }
  // prevent: s-prevent ticks a second apart are one stretch; it began up to a second before the first tick
  for (const [id, s] of Object.entries(ids)) {
    let from = null, last = null;
    for (const tick of [...(s.prevent || []), [Infinity]]) {
      if (last !== null && tick[0] - last[0] > 1500) {
        ev(from[0] - 1000, 'prevent start', +id, ...at(id, from[0] - 1000), 'up to 1 s before the first counted second');
        ev(last[0], 'prevent stop', +id, last[1], last[2], `${Math.round((last[0] - from[0]) / 1000) + 1} s counted`);
        from = null;
      }
      if (from === null) from = tick;
      last = tick;
    }
  }

  const totals = {};
  for (const [id, s] of Object.entries(ids)) {
    if (!(s.team in TEAM) || person[id] == null) continue;
    const row = totals[person[id]] ??= { id, st: {} };
    row.id = id;
    for (const [k, v] of Object.entries(s.stats)) row.st[k] = Math.max(row.st[k] || 0, v);
  }
  for (const { id, st } of Object.values(totals)) ev(endMs, 'final stats', id, null, null,
    `${ids[id].auth ? 'registered' : 'guest'}, ` + ['grabs', 'captures', 'hold', 'returns', 'tags', 'pops', 'prevent', 'powerups', 'handoffs', 'flaccids', 'score', 'points']
      .map(k => `${k === 'captures' ? 'caps' : k === 'powerups' ? 'pups' : k} ${st[k] || 0}`).join(', '));
  events.sort((a, b) => a.ms - b.ms);
  for (const rows of [events, keypresses, positions]) for (const r of rows) r.seconds = sec(r.ms);
  return { events, keypresses, positions, meta, tiles: startTiles };   // tiles: the map at load, tiles[x][y]
}

const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const csv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c] ?? '')).join(','))].join('\n') + '\n';
// the replays named on the command line; a folder means every replay inside it (and its subfolders)
const replayFiles = names => names.flatMap(n => fs.statSync(n).isDirectory()
  ? fs.readdirSync(n, { recursive: true }).map(f => path.join(n, f)).filter(f => /\.ndjson(\.gz)?$/.test(f)).sort() : [n]);
module.exports = { extract, replayName, replayFiles, COLS, csv };
if (require.main !== module) return;

const args = process.argv.slice(2), single = args.includes('--single');
const outAt = args.indexOf('--out'), out = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, 'games');
const files = replayFiles(args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)));
if (!files.length) { console.error('usage: node extract.js <replay or folder>... [--out <folder>] [--single]'); process.exit(1); }
for (const file of files) {
  const tables = extract(file), base = replayName(file);
  fs.mkdirSync(single ? out : path.join(out, base), { recursive: true });
  if (single) fs.writeFileSync(path.join(out, base + '.csv'),
    Object.keys(COLS).map(k => `# ${k}\n` + csv(COLS[k], tables[k])).join(''));
  else for (const k of Object.keys(COLS)) fs.writeFileSync(path.join(out, base, k + '.csv'), csv(COLS[k], tables[k]));
  console.log(`${base}: ${tables.events.length} events, ${tables.keypresses.length} key presses, ${tables.positions.length} positions`);
}
