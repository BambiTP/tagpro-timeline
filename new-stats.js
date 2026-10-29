#!/usr/bin/env node
// Advanced stats from replays, rewritten from the ideas in fly's tagpro-analytics: where returns
// happen, carries, pulls, threats, defense, grab types, snipes, pup fights, last stands and defensive
// states. Same ideas and thresholds as his, simpler rules (notes on each family say where it differs).
//   node new-stats.js <replay or folder>... [--out new-stats.csv]
// Built on extract.js, so it reads what the events and positions files say: times in game seconds,
// positions in tiles, one person per player (rejoins merged), credited boosts, bombs and pops.
// Helpers (things many stats use) come first, then one stat function per family. Everything travels
// in the game object g; each stat returns a Map from player name to its columns.
const fs = require('fs');
const { extract, replayName, replayFiles } = require('./extract.js');

// ================================================================ helpers

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TEAMS = { red: 1, blue: 2 }, other = t => 3 - t;

// the game object: people with their tracks, the event lists, holds, bases
function buildGame(file) {
  const { events, positions, meta, tiles } = extract(file);
  const end = (events.find(e => e.event === 'game end') || events[events.length - 1]).seconds;
  const start = events.find(e => e.event === 'game start') || { details: '' };
  const g = { id: replayName(file), meta, tiles, end, people: new Map(), flags: {},
    grabs: [], caps: [], pops: [], boosts: [], bombs: [], explosions: [], spawns: [], pickups: [], pupEnds: [], flaccids: [] };
  for (const [, f, x, y] of start.details.matchAll(/(red|blue) flag at ([\d.]+),([\d.]+)/g)) g.flags[TEAMS[f]] = [+x, +y];
  if (!g.flags[1] || !g.flags[2]) throw new Error('not a red flag vs blue flag map');
  const person = name => {
    if (!g.people.has(name)) g.people.set(name, { name, teamTime: { 1: 0, 2: 0 }, field: [], tracks: [] });
    return g.people.get(name);
  };
  // on the field: from (re)joining to leaving, on one team (team switches start a new stretch)
  const open = new Map();
  const leave = (p, t) => { const o = open.get(p.name); if (o) { p.field.push({ from: o.from, to: t, team: o.team }); p.teamTime[o.team] += t - o.from; open.delete(p.name); } };
  const at = (e, k) => e[k] === '' ? null : +e[k];
  for (const e of events) {
    if (!e.player && !['explosion', 'pup spawn'].includes(e.event)) continue;
    const t = Math.max(0, e.seconds), p = e.player ? person(e.player) : null, pos = [at(e, 'x'), at(e, 'y')];
    if (e.event === 'join' || e.event === 'rejoin') { leave(p, t); open.set(p.name, { from: t, team: TEAMS[e.team] }); }
    else if (e.event === 'switch team') { leave(p, t); open.set(p.name, { from: t, team: TEAMS[e.details.replace('now ', '')] }); }
    else if (e.event === 'leave') leave(p, t);
    if (e.seconds < 0) continue;
    const team = TEAMS[e.team], d = e.details;
    if (e.event === 'grab') g.grabs.push({ t, who: p.name, team, pos });
    else if (e.event === 'cap') g.caps.push({ t, who: p.name, team });
    else if (e.event === 'pop') {
      const by = d.match(/(returned|tagged) by ([^;]+)/), sp = d.match(/splat at ([\d.]+),([\d.]+)/);
      g.pops.push({ t, who: p.name, team, carrying: d.startsWith('carrying'), by: by ? by[2] : null, returned: !!by && by[1] === 'returned',
        spike: d.includes('no enemy credited'), pos: sp ? [+sp[1], +sp[2]] : pos });
    } else if (/^(red |blue )?boost used$/.test(e.event)) g.boosts.push({ t, who: p.name, pos });
    else if (e.event === 'bomb used') g.bombs.push({ t, who: p.name, pos });
    else if (e.event === 'explosion') g.explosions.push({ t, pos });
    else if (e.event === 'pup spawn') g.spawns.push({ t, type: d, pos });
    else if (e.event === 'pup pickup' && !d.startsWith('a pup')) g.pickups.push({ t, who: p.name, team, type: d });
    else if (e.event === 'pup ended') g.pupEnds.push({ t, who: p.name, team, type: d });
    else if (e.event === 'flaccid') g.flaccids.push({ t, who: p.name, team });
  }
  for (const p of g.people.values()) { leave(p, end); p.team = p.teamTime[1] >= p.teamTime[2] ? 1 : 2; }
  for (const r of positions) if (r.seconds >= 0 && g.people.has(r.player)) g.people.get(r.player).tracks.push({ t: r.seconds, x: r.x, y: r.y,
    vx: r.vx, vy: r.vy, alive: r.alive === 'yes', flag: r.flag !== '', pups: r.powerups });
  for (const p of [...g.people.values()]) if (!p.field.length) g.people.delete(p.name);   // never played
  addHolds(g);
  addBases(g);
  return g;
}

// where a person was at time t: their last position update, if they were on the field
function where(p, t) {
  if (!p.field.some(f => f.from <= t && t <= f.to)) return null;
  let lo = 0, hi = p.tracks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (p.tracks[m].t <= t) lo = m + 1; else hi = m; }
  return lo ? p.tracks[lo - 1] : null;
}
const xy = s => [s.x, s.y];
const speed = s => Math.hypot(s.vx, s.vy);
// alive people of a team (or not of a team) at a time, with their positions
function alive(g, t, test) {
  const out = [];
  for (const p of g.people.values()) { if (!test(p)) continue; const s = where(p, t); if (s && s.alive) out.push([p, s]); }
  return out;
}
const enemiesOf = (g, team, t) => alive(g, t, p => p.team !== team);
const teammatesOf = (g, team, t, except) => alive(g, t, p => p.team === team && p.name !== except);
const onField = (g, p, t) => p.field.some(f => f.from <= t && t <= f.to);

// every hold: grab -> that player's cap, pop while carrying, or the end. A grab within REGRAB_S of a
// teammate's pop while carrying is a regrab (the chain kept the flag out).
const REGRAB_S = 2;
function addHolds(g) {
  g.holds = g.grabs.map(gr => {
    const cap = g.caps.find(c => c.who === gr.who && c.t >= gr.t), drop = g.pops.find(d => d.who === gr.who && d.carrying && d.t >= gr.t);
    const endT = Math.min(cap ? cap.t : Infinity, drop ? drop.t : Infinity, g.end);
    const outcome = cap && cap.t === endT ? 'cap' : drop && drop.t === endT ? 'drop' : 'kept';
    const regrab = g.pops.some(d => d.team === gr.team && d.who !== gr.who && d.carrying && gr.t - d.t >= 0 && gr.t - d.t <= REGRAB_S);
    return { who: gr.who, team: gr.team, start: gr.t, end: endT, outcome, regrab, dropPop: outcome === 'drop' ? drop : null };
  });
}
// is team's own flag out (an enemy holding it) at time t?
const flagOut = (g, team, t) => g.holds.some(h => h.team !== team && h.start <= t && t < h.end);
// the hold that continues this dropped one: a teammate's grab within REGRAB_S of the pop
const chained = (g, h) => g.holds.find(n => n.team === h.team && n.who !== h.who && n.start >= h.end && n.start - h.end <= REGRAB_S);

// bases, simpler than fly's chokepoint masks: the open tiles reachable from the flag within a third of
// the flag-to-flag walking distance, plus everything behind the flag (farther from the enemy flag than
// the flag itself is)
const BASE_FRACTION = 1 / 3;
function addBases(g) {
  const W = g.tiles.length, H = g.tiles[0].length, open = (x, y) => x >= 0 && y >= 0 && x < W && y < H && ![0, 1, 7].includes(Math.trunc(g.tiles[x][y]));
  const walk = ([sx, sy]) => {
    const d = new Map([[`${sx},${sy}`, 0]]), q = [[sx, sy]];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (open(nx, ny) && !d.has(`${nx},${ny}`)) { d.set(`${nx},${ny}`, d.get(`${x},${y}`) + 1); q.push([nx, ny]); }
    }
    return d;
  };
  const tileOf = f => [Math.floor(f[0]), Math.floor(f[1])], from = { 1: walk(tileOf(g.flags[1])), 2: walk(tileOf(g.flags[2])) };
  g.bases = {};
  for (const team of [1, 2]) {
    const own = from[team], enemy = from[other(team)], span = own.get(tileOf(g.flags[other(team)]).join(',')), home = enemy.get(tileOf(g.flags[team]).join(','));
    g.bases[team] = new Set([...own.keys()].filter(k => own.get(k) <= span * BASE_FRACTION || (enemy.get(k) ?? Infinity) >= home));
  }
}
const inBase = (g, team, pos) => !!pos && pos[0] !== null && g.bases[team].has(`${Math.floor(pos[0])},${Math.floor(pos[1])}`);

// ================================================================ stats

// Time on the field, distance (steps over 6 tiles or a second are respawns or gaps), % time nearer the
// enemy flag, regrabs and caps off them, seconds your flag was out while you played, pup share, kept flag.
function presence(g) {
  const out = new Map();
  for (const p of g.people.values()) {
    let distance = 0, holdDist = 0, off = 0, on = 0;
    for (let i = 0; i + 1 < p.tracks.length; i++) {
      const a = p.tracks[i], b = p.tracks[i + 1], dt = b.t - a.t, step = dist(xy(a), xy(b));
      if (!a.alive || !b.alive) continue;
      if (dt <= 1 && step <= 6) { distance += step; if (a.flag) holdDist += step; }
      if (dt <= 2) { on += dt; if (dist(xy(a), g.flags[other(p.team)]) < dist(xy(a), g.flags[p.team])) off += dt; }
    }
    const mine = g.holds.filter(h => h.who === p.name);
    let against = 0;
    for (const f of p.field) for (const h of g.holds) if (h.team !== f.team) against += Math.max(0, Math.min(h.end, f.to) - Math.max(h.start, f.from));
    const seen = g.spawns.filter(s => onField(g, p, s.t)).length, taken = g.pickups.filter(k => k.who === p.name).length;
    out.set(p.name, { play_time_s: p.field.reduce((a, f) => a + f.to - f.from, 0), distance_tiles: distance, hold_distance_tiles: holdDist,
      pct_time_offense: on ? 100 * off / on : null, regrabs: mine.filter(h => h.regrab).length, caps_off_regrab: mine.filter(h => h.regrab && h.outcome === 'cap').length,
      hold_against_s: against, pup_spawns_while_on: seen, pup_pct: seen ? 100 * taken / seen : null, kept_flag: mine.some(h => h.outcome === 'kept') ? 1 : 0 });
  }
  return out;
}

// Returns: key returns (your team had a live hold at the time that capped within 8 s), where the
// carrier was popped (their splat: in their base = enemy base, in yours = own base, else open field),
// solo (no teammate within 4 tiles of the carrier) or supported.
const KEY_RETURN_S = 8, ASSIST_TILES = 4;
function returns(g) {
  const out = new Map();
  for (const pop of g.pops) {
    if (!pop.returned) continue;
    const by = g.people.get(pop.by);
    if (!by) continue;
    if (!out.has(by.name)) out.set(by.name, { key_returns: 0, returns_enemy_base: 0, returns_own_base: 0, returns_open_field: 0, solo_returns: 0, supported_returns: 0 });
    const d = out.get(by.name);
    if (g.holds.some(h => h.team === by.team && h.start <= pop.t && pop.t <= h.end && h.outcome === 'cap' && h.end - pop.t <= KEY_RETURN_S)) d.key_returns++;
    d[inBase(g, pop.team, pop.pos) ? 'returns_enemy_base' : inBase(g, by.team, pop.pos) ? 'returns_own_base' : 'returns_open_field']++;
    const helped = teammatesOf(g, by.team, pop.t, by.name).some(([, s]) => dist(xy(s), pop.pos) <= ASSIST_TILES);
    d[helped ? 'supported_returns' : 'solo_returns']++;
  }
  return out;
}

// Carries, per hold: deepest point from the flag's home, path walked, progress toward your own flag,
// nearest enemy at the grab (and the hold that pressure usually gets, from fly's s39 medians), enemies
// within 6 tiles at the pop, and breakouts (a grab inside the enemy base whose flag got out of it,
// by this carrier or a regrab chain).
const ENGAGE_TILES = 6, PRESSURE_HOLD = [[2, 2.6], [4, 4.6], [8, 5.8], [Infinity, 8.1]];
function carries(g) {
  const out = new Map(), gotOut = new Map();
  const left = h => {
    if (gotOut.has(h)) return gotOut.get(h);
    const p = g.people.get(h.who), out_ = p.tracks.some(s => s.t >= h.start && s.t <= h.end && s.alive && !inBase(g, other(h.team), xy(s)));
    const next = h.outcome === 'drop' ? chained(g, h) : null, v = out_ || (!!next && left(next));
    gotOut.set(h, v);
    return v;
  };
  for (const h of g.holds) {
    const p = g.people.get(h.who), live = p.tracks.filter(s => s.t >= h.start && s.t <= h.end && s.alive);
    if (!out.has(h.who)) out.set(h.who, { holds_n: 0, carry_depth_sum_tiles: 0, path_tiles_sum: 0, progress_tiles_sum: 0, grab_pressure_sum_tiles: 0,
      grabs_measured: 0, hold_expected_sum_s: 0, deaths_vs_1: 0, deaths_vs_2: 0, deaths_vs_3plus: 0, breakouts: 0, grabs_in_base: 0 });
    const d = out.get(h.who);
    if (!live.length) continue;
    const home = g.flags[other(h.team)], cap = g.flags[h.team], first = live[0], last = live[live.length - 1];
    d.holds_n++;
    d.carry_depth_sum_tiles += Math.max(...live.map(s => dist(xy(s), home)));
    for (let i = 0; i + 1 < live.length; i++) { const step = dist(xy(live[i]), xy(live[i + 1])); if (live[i + 1].t - live[i].t <= 1 && step <= 6) d.path_tiles_sum += step; }
    d.progress_tiles_sum += dist(xy(first), cap) - dist(xy(last), cap);
    const near = enemiesOf(g, h.team, h.start).map(([, s]) => dist(xy(s), xy(first)));
    if (near.length) {
      const pressure = Math.min(...near);
      d.grab_pressure_sum_tiles += pressure; d.grabs_measured++;
      d.hold_expected_sum_s += PRESSURE_HOLD.find(([hi]) => pressure < hi)[1];
    }
    if (h.outcome === 'drop') {
      const n = enemiesOf(g, h.team, h.end).filter(([, s]) => dist(xy(s), xy(last)) <= ENGAGE_TILES).length;
      if (n === 1) d.deaths_vs_1++; else if (n === 2) d.deaths_vs_2++; else if (n >= 3) d.deaths_vs_3plus++;
    }
    if (inBase(g, other(h.team), xy(first))) { d.grabs_in_base++; if (left(h)) d.breakouts++; }
  }
  return out;
}

// Pulls ("gravity"): a carrier popped inside the enemy base with a teammate regrabbing within 2 s.
// How far from the flag they got, enemies within 6 tiles of them, and the space the regrabber had.
function pulls(g) {
  const out = new Map();
  for (const h of g.holds) {
    if (h.outcome !== 'drop' || !inBase(g, other(h.team), h.dropPop.pos)) continue;
    const next = chained(g, h);
    if (!next) continue;
    if (!out.has(h.who)) out.set(h.who, { pulls: 0, pull_distance_sum: 0, defenders_committed_sum: 0, regrab_space_sum: 0, regrab_space_n: 0 });
    const d = out.get(h.who), at = h.dropPop.pos;
    d.pulls++;
    d.pull_distance_sum += dist(at, g.flags[other(h.team)]);
    d.defenders_committed_sum += enemiesOf(g, h.team, h.end).filter(([, s]) => dist(xy(s), at) <= ENGAGE_TILES).length;
    const rg = where(g.people.get(next.who), next.start), space = rg ? enemiesOf(g, h.team, next.start).map(([, s]) => dist(xy(s), xy(rg))) : [];
    if (space.length) { d.regrab_space_sum += Math.min(...space); d.regrab_space_n++; }
  }
  return out;
}

// Threats: holds that came within 5 tiles of your own flag (where you cap); how many capped; threat
// assists (a dropped threat whose regrab chain capped within 10 s of the drop).
const THREAT_TILES = 5, THREAT_ASSIST_S = 10;
function threats(g) {
  const out = new Map();
  for (const h of g.holds) {
    const near = g.people.get(h.who).tracks.some(s => s.t >= h.start && s.t <= h.end && s.alive && dist(xy(s), g.flags[h.team]) <= THREAT_TILES);
    if (!near) continue;
    if (!out.has(h.who)) out.set(h.who, { threats: 0, threat_conversions: 0, threat_assists: 0 });
    const d = out.get(h.who), next = h.outcome === 'drop' ? chained(g, h) : null;
    d.threats++;
    if (h.outcome === 'cap') d.threat_conversions++;
    if (next && next.outcome === 'cap' && next.end - h.end <= THREAT_ASSIST_S) d.threat_assists++;
  }
  return out;
}

// Defense: containment assists (teammates within 4 tiles of the carrier at a return), seconds within
// 4 tiles of an enemy carrier, forced spike deaths (a carrier popped on a spike with you within 4 tiles),
// rolling bombs defused (an enemy's rolling bomb went off with you the nearest enemy, within 2 tiles;
// clean if no teammate of yours was within 3 tiles of the blast).
const CONTAIN_TILES = 4, SPIKE_TILES = 1.3, DEFUSE_TILES = 2, BLAST_TILES = 3;
function defense(g) {
  const out = new Map(), of = n => { if (!out.has(n)) out.set(n, { assists: 0, containment_s: 0, spike_deaths_forced: 0, defuses: 0, clean_defuses: 0 }); return out.get(n); };
  const spikes = [];
  g.tiles.forEach((col, x) => col.forEach((v, y) => { if (Math.trunc(v) === 7) spikes.push([x + 0.5, y + 0.5]); }));
  for (const pop of g.pops) {
    if (pop.returned && g.people.has(pop.by)) for (const [p, s] of teammatesOf(g, g.people.get(pop.by).team, pop.t, pop.by)) if (dist(xy(s), pop.pos) <= ASSIST_TILES) of(p.name).assists++;
    if (pop.carrying && pop.spike && spikes.some(k => dist(k, pop.pos) <= SPIKE_TILES))
      for (const [p, s] of enemiesOf(g, pop.team, pop.t)) if (dist(xy(s), pop.pos) <= CONTAIN_TILES) of(p.name).spike_deaths_forced++;
  }
  for (const p of g.people.values()) for (let i = 0; i < p.tracks.length; i++) {
    const s = p.tracks[i];
    if (!s.flag || !s.alive) continue;
    const dt = Math.min(0.5, (p.tracks[i + 1] ? p.tracks[i + 1].t : s.t + 0.25) - s.t);
    for (const [q, e] of enemiesOf(g, p.team, s.t)) if (dist(xy(e), xy(s)) <= CONTAIN_TILES) of(q.name).containment_s += dt;
  }
  for (const e of g.pupEnds) {
    if (e.type !== 'rolling bomb') continue;
    const blast = g.explosions.find(x => Math.abs(x.t - e.t) <= 0.3), carrier = where(g.people.get(e.who), e.t);
    if (!blast || !carrier || g.pops.some(p => p.who === e.who && Math.abs(p.t - e.t) <= 0.3)) continue;
    const near = enemiesOf(g, e.team, e.t).map(([p, s]) => [dist(xy(s), xy(carrier)), p]).sort((a, b) => a[0] - b[0])[0];
    if (!near || near[0] > DEFUSE_TILES) continue;
    of(near[1].name).defuses++;
    if (!teammatesOf(g, near[1].team, e.t, near[1].name).some(([, s]) => dist(xy(s), xy(carrier)) <= BLAST_TILES)) of(near[1].name).clean_defuses++;
  }
  return out;
}

// Grab types, by speed at the grab: standing (under 2 tiles/s), rolling (under 7), boosted.
function grabTypes(g) {
  const out = new Map();
  for (const gr of g.grabs) {
    const s = where(g.people.get(gr.who), gr.t);
    if (!s) continue;
    if (!out.has(gr.who)) out.set(gr.who, { grab_standing: 0, grab_rolling: 0, grab_boosted: 0 });
    const v = speed(s);
    out.get(gr.who)[v < 2 ? 'grab_standing' : v < 7 ? 'grab_rolling' : 'grab_boosted']++;
  }
  return out;
}

// Snipes: a boost or bomb you used (not carrying) that sends you to 8+ tiles/s within a second, aimed
// within 40 degrees at an enemy carrier up to 14 tiles away (or ending in your tag); a hit if you
// return or tag someone within 2.2 s.
const SNIPE_SPEED = 8, AIM_DEG = 40, AIM_TILES = 14, SNIPE_HIT_S = 2.2;
function snipes(g) {
  const out = new Map();
  for (const [src, list] of [['boost', g.boosts], ['bomb', g.bombs]]) for (const use of list) {
    const p = g.people.get(use.who), here = where(p, use.t);
    if (!p || !here || here.flag) continue;
    const launch = p.tracks.find(s => s.t >= use.t && s.t <= use.t + 1 && s.alive && speed(s) >= SNIPE_SPEED);
    if (!launch) continue;
    const hit = g.pops.some(x => x.by === p.name && x.t >= use.t && x.t - use.t <= SNIPE_HIT_S);
    const aimed = enemiesOf(g, p.team, launch.t).some(([, e]) => {
      if (!e.flag) return false;
      const dx = e.x - launch.x, dy = e.y - launch.y, d = Math.hypot(dx, dy);
      if (d > AIM_TILES || d < 0.3) return false;
      const cos = (launch.vx * dx + launch.vy * dy) / (speed(launch) * d);
      return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI <= AIM_DEG;
    });
    if (!hit && !aimed) continue;
    if (!out.has(p.name)) out.set(p.name, { snipe_attempts: 0, snipe_hits: 0, snipe_attempts_boost: 0, snipe_attempts_bomb: 0, snipe_hits_boost: 0, snipe_hits_bomb: 0 });
    const d = out.get(p.name);
    d.snipe_attempts++; d[`snipe_attempts_${src}`]++;
    if (hit) { d.snipe_hits++; d[`snipe_hits_${src}`]++; }
  }
  return out;
}

// Pup fights. A fight runs from 3 s before a pup goes live to its pickup; fighters are alive players
// within 4 tiles of it then. Combatants: the taker, anyone within 2 tiles of an opposing fighter for
// 0.75 s+, or within 2 tiles of the pup at the pickup. Per player: arrival vs the spawn (combatants),
// pickups contested (an opposing combatant within 4 tiles at the pickup) or not, fights skipped to
// hold base (in your base with an enemy there when it went live), caps conceded / scored while the
// other / your team had a live tagpro or rolling bomb (20 s), the taker's team's caps minus the
// other's in those 20 s, and grabs within 5 s of a spawn (flaccid: lost within 2 s; capped).
const FIGHT_TILES = 4, FIGHT_WARNING_S = 3, ENGAGE_FIGHT_TILES = 2, ENGAGE_FIGHT_S = 0.75, PUP_S = 20, GRAB_LINK_S = 5, FLACCID_S = 2;
function pupFights(g) {
  const out = new Map(), of = n => { if (!out.has(n)) out.set(n, { ca_pups: 0, cf_pups: 0, pup_plus_minus: 0, caps_from_pup_grabs: 0, grabs_around_pups: 0,
    flaccids_around_pups: 0, held_base_during_fights: 0, takes_contested: 0, takes_uncontested: 0, pup_arrival_sum_s: 0, pup_arrivals_n: 0 }); return out.get(n); };
  const used = new Set();
  for (const sp of g.spawns) {
    const pick = g.pickups.filter(k => !used.has(k) && k.type === sp.type && k.t >= sp.t).map(k => [k, where(g.people.get(k.who), k.t)])
      .filter(([, s]) => s && dist(xy(s), sp.pos) <= 2).sort((a, b) => a[0].t - b[0].t)[0];
    const taken = pick ? pick[0] : null;
    if (taken) used.add(taken);
    const from = sp.t - FIGHT_WARNING_S, to = taken ? taken.t : sp.t + 3;
    const fighters = [];
    for (const p of g.people.values()) {
      const near = p.tracks.filter(s => s.t >= from && s.t <= to && s.alive && dist(xy(s), sp.pos) <= FIGHT_TILES);
      if (near.length) fighters.push({ p, arrival: near[0].t - sp.t });
    }
    const engaged = (f) => {
      let secs = 0;
      const tr = f.p.tracks.filter(s => s.t >= from && s.t <= to && s.alive);
      for (let i = 0; i + 1 < tr.length; i++) if (fighters.some(o => o.p.team !== f.p.team && (() => { const e = where(o.p, tr[i].t); return e && e.alive && dist(xy(e), xy(tr[i])) <= ENGAGE_FIGHT_TILES; })())) secs += tr[i + 1].t - tr[i].t;
      return secs;
    };
    const combatants = fighters.filter(f => (taken && f.p.name === taken.who) || engaged(f) >= ENGAGE_FIGHT_S
      || (() => { const s = where(f.p, to); return s && s.alive && dist(xy(s), sp.pos) <= ENGAGE_FIGHT_TILES; })());
    for (const f of combatants) { of(f.p.name).pup_arrival_sum_s += f.arrival; of(f.p.name).pup_arrivals_n++; }
    if (taken) {
      const contested = combatants.some(f => f.p.team !== taken.team && (() => { const s = where(f.p, taken.t); return s && s.alive && dist(xy(s), sp.pos) <= FIGHT_TILES; })());
      of(taken.who)[contested ? 'takes_contested' : 'takes_uncontested']++;
      const caps = g.caps.filter(c => c.t >= taken.t && c.t <= taken.t + PUP_S);
      of(taken.who).pup_plus_minus += caps.filter(c => c.team === taken.team).length - caps.filter(c => c.team !== taken.team).length;
    }
    const inFight = new Set(fighters.map(f => f.p.name));
    for (const [p, s] of alive(g, sp.t, p => !inFight.has(p.name)))
      if (inBase(g, p.team, xy(s)) && enemiesOf(g, p.team, sp.t).some(([, e]) => inBase(g, p.team, xy(e)))) of(p.name).held_base_during_fights++;
  }
  // caps during a live tagpro or rolling bomb of the scoring team
  for (const c of g.caps) {
    if (!g.pickups.some(k => k.team === c.team && ['tagpro', 'rolling bomb'].includes(k.type) && c.t >= k.t && c.t <= k.t + PUP_S)) continue;
    for (const p of g.people.values()) if (onField(g, p, c.t)) of(p.name)[p.team === c.team ? 'cf_pups' : 'ca_pups']++;
  }
  // grabs within 5 s of a spawn
  for (const gr of g.grabs) {
    if (!g.spawns.some(s => Math.abs(gr.t - s.t) <= GRAB_LINK_S)) continue;
    const h = g.holds.find(x => x.who === gr.who && x.start === gr.t), d = of(gr.who);
    d.grabs_around_pups++;
    if (h && h.outcome === 'cap') d.caps_from_pup_grabs++;
    else if (h && h.outcome === 'drop' && h.end - h.start <= FLACCID_S) d.flaccids_around_pups++;
  }
  return out;
}

// Last stands: an enemy carrier with exactly one of you goal-side (nearer the carrier's cap than the
// carrier), for 0.75 s+. Per defender: episodes, caps conceded within 8 s of it ending, saves (the hold
// ended in your return within 8 s), backup arriving (a second defender got goal-side) and stalls
// (backup arrived and no cap), the carrier's speed toward the cap meanwhile (sum and count, for an
// average), defensive grabs (grabbing while you're goal-side of an enemy carrier) and those with no
// cap by that carrier within 8 s.
const STAND_MIN_S = 0.75, STAND_WINDOW_S = 8;
function lastStands(g) {
  const out = new Map(), of = n => { if (!out.has(n)) out.set(n, { last_stand_episodes: 0, last_stand_conceded: 0, saves: 0, last_stand_backup_arrived: 0,
    last_stand_stall_success: 0, last_stand_def_grabs: 0, last_stand_ldg_ok: 0, last_stand_fc_rate_sum: 0, last_stand_fc_rate_n: 0 }); return out.get(n); };
  const goalSide = (team, t, at) => enemiesOf(g, team, t).filter(([, s]) => dist(xy(s), g.flags[team]) < dist(at, g.flags[team])).map(([p]) => p.name);
  for (const h of g.holds) {
    const p = g.people.get(h.who), samples = p.tracks.filter(s => s.t >= h.start && s.t <= h.end && s.alive && s.flag);
    let ep = null;
    const close = (backup) => {
      if (!ep) return;
      const e = ep; ep = null;
      if (e.last.t - e.first.t < STAND_MIN_S) return;
      const d = of(e.def), conceded = h.outcome === 'cap' && h.end - e.last.t <= STAND_WINDOW_S;
      d.last_stand_episodes++;
      if (conceded) d.last_stand_conceded++;
      if (h.outcome === 'drop' && h.end - e.last.t <= STAND_WINDOW_S && h.dropPop.by === e.def && h.dropPop.returned) d.saves++;
      if (backup) { d.last_stand_backup_arrived++; if (!conceded) d.last_stand_stall_success++; }
      const capA = dist(xy(e.first), g.flags[h.team]), capB = dist(xy(e.last), g.flags[h.team]);
      if (e.last.t > e.first.t) { d.last_stand_fc_rate_sum += (capA - capB) / (e.last.t - e.first.t); d.last_stand_fc_rate_n++; }
    };
    for (const s of samples) {
      const gs = goalSide(h.team, s.t, xy(s));
      if (gs.length === 1) { if (ep && ep.def === gs[0]) ep.last = s; else { close(false); ep = { def: gs[0], first: s, last: s }; } }
      else close(gs.length >= 2 && !!ep && gs.includes(ep.def));
    }
    close(false);
  }
  for (const gr of g.grabs) {
    const fc = g.holds.find(h => h.team !== gr.team && h.start <= gr.t && gr.t < h.end), me = where(g.people.get(gr.who), gr.t);
    const fcAt = fc ? where(g.people.get(fc.who), gr.t) : null;
    if (!fc || !me || !fcAt || !(dist(xy(me), g.flags[fc.team]) < dist(xy(fcAt), g.flags[fc.team]))) continue;
    of(gr.who).last_stand_def_grabs++;
    if (!g.caps.some(c => c.who === fc.who && c.t >= gr.t && c.t - gr.t <= STAND_WINDOW_S)) of(gr.who).last_stand_ldg_ok++;
  }
  return out;
}

// Defensive states, every 0.25 s: breached (your flag is out), threatened (more enemies than your own
// players alive in your base) or contained (+ "empty" if none of yours is home). Per team: seconds in
// each and sustained resets (back to contained for 5 s). Per player: breach-ending returns (the flag
// came home within 1 s of your return) that led to 5 s contained before the next breach, the same
// after enemy holds of 10 s+, and quick returns (the server credited the carrier a flaccid).
const TICK_S = 0.25, DWELL_S = 5, RETURN_LINK_S = 1, LONG_HOLD_S = 10;
function defStates(g) {
  const ticks = [];
  for (let t = 0; t <= g.end; t += TICK_S) {
    const st = {};
    for (const team of [1, 2]) {
      let own = 0, foe = 0;
      for (const [p, s] of alive(g, t, () => true)) if (inBase(g, team, xy(s))) { if (p.team === team) own++; else foe++; }
      st[team] = flagOut(g, team, t) ? 'breached' : foe > own ? 'threatened' : own ? 'contained' : 'empty';
    }
    ticks.push([t, st]);
  }
  const need = DWELL_S / TICK_S, team = {}, contained = s => s === 'contained' || s === 'empty';
  for (const side of [1, 2]) {
    const secs = { breached: 0, threatened: 0, contained: 0, empty: 0 };
    let run = 0, resets = 0;
    ticks.forEach(([, st], i) => {
      secs[st[side]] += TICK_S;
      if (contained(st[side])) { run++; if (run === need && i + 1 > need) resets++; } else run = 0;
    });
    team[side] = { breached_s: secs.breached, threatened_s: secs.threatened, contained_s: secs.contained + secs.empty, contained_empty_s: secs.empty, sustained_resets: resets };
  }
  for (const side of [1, 2]) team[side].sustained_resets_suffered = team[other(side)].sustained_resets;
  const players = new Map(), of = n => { if (!players.has(n)) players.set(n, { returns_to_sustained_reset: 0, returns_to_sustained_reset_opportunities: 0,
    returns_to_sustained_reset_10s: 0, returns_to_sustained_reset_10s_opportunities: 0, quick_returns: 0 }); return players.get(n); };
  for (const side of [1, 2]) for (let i = 1; i < ticks.length; i++) {
    if (ticks[i - 1][1][side] !== 'breached' || ticks[i][1][side] === 'breached') continue;
    const t = ticks[i][0], ret = g.pops.filter(p => p.returned && p.team !== side && Math.abs(p.t - t) <= RETURN_LINK_S).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (!ret || !g.people.has(ret.by)) continue;
    let run = 0, ok = false;
    for (let j = i; j < ticks.length && ticks[j][1][side] !== 'breached'; j++) { run = contained(ticks[j][1][side]) ? run + 1 : 0; if (run >= need) { ok = true; break; } }
    const hold = g.holds.find(h => h.who === ret.who && h.end === ret.t), d = of(ret.by);
    d.returns_to_sustained_reset_opportunities++; if (ok) d.returns_to_sustained_reset++;
    if (hold && hold.end - hold.start >= LONG_HOLD_S) { d.returns_to_sustained_reset_10s_opportunities++; if (ok) d.returns_to_sustained_reset_10s++; }
  }
  for (const pop of g.pops) if (pop.returned && g.people.has(pop.by) && g.flaccids.some(f => f.who === pop.who && f.t >= pop.t && f.t - pop.t <= 3)) of(pop.by).quick_returns++;
  return { players, team };
}

// ================================================================ running it

const STATS = [presence, returns, carries, pulls, threats, defense, grabTypes, snipes, pupFights, lastStands];
const TEAM_COLUMNS = ['breached_s', 'threatened_s', 'contained_s', 'contained_empty_s', 'sustained_resets', 'sustained_resets_suffered'];

function gameStats(file) {
  const g = buildGame(file), maps = STATS.map(f => f(g)), states = defStates(g), rows = [];
  for (const p of g.people.values()) {
    const r = { match_id: g.id, map: g.meta.mapName, player: p.name, team: p.team === 1 ? 'red' : 'blue' };
    for (const m of [...maps, states.players]) Object.assign(r, m.get(p.name));
    for (const c of TEAM_COLUMNS) r['team_' + c] = states.team[p.team][c];
    rows.push(r);
  }
  return rows;
}

if (require.main === module) {
  const args = process.argv.slice(2), outAt = args.indexOf('--out'), outFile = outAt >= 0 ? args[outAt + 1] : 'new-stats.csv';
  const files = replayFiles(args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)));
  if (!files.length) { console.error('usage: node new-stats.js <replay or folder>... [--out new-stats.csv]'); process.exit(1); }
  const all = [];
  for (const file of files) {
    try { all.push(...gameStats(file)); } catch (e) { console.error(`${replayName(file)}: skipped (${e.message})`); }
  }
  // columns: every one any row has, in first-seen order; numbers to 2 decimals
  const cols = [...new Set(all.flatMap(r => Object.keys(r)))];
  const cell = v => v === undefined || v === null ? (v === null ? '' : 0) : typeof v === 'number' ? String(Math.round(v * 100) / 100)
    : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  fs.writeFileSync(outFile, [cols.join(','), ...all.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n');
  console.log(`${new Set(all.map(r => r.match_id)).size} game(s), ${all.length} player rows -> ${outFile}`);
}
module.exports = { gameStats };
