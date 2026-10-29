#!/usr/bin/env node
// Per player per game stats from replays, using the definitions in ~/tagpro-stats/STAT_DEFINITIONS.md
// (the same columns as fetch-ctf-stats.js, without map author and official, which replays don't have).
//   node eu-stats.js <replay or folder>... [--out eu-stats.csv]
// Helpers (things many stats use) come first, then one stat function per family of columns.
// Every helper and stat takes the game object g (and the rows so far) and hands back what it worked out.
const fs = require('fs');
const { extract, replayName, replayFiles } = require('./extract.js');


// ================================================================ helpers

// Numbers shared by every stat: frames, rounding, safe division.
const FPS = 60;
const frame = seconds => Math.round(seconds * FPS);
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : 0);
const div = (a, b) => (b ? a / b : 0);

// A replay -> the game object every helper and stat works from. Built from extract.js's events, so it
// carries exactly what the events file says. Times are frames from the start of play, like tagpro.eu.
//   g.meta        the replay's own metadata (date, server, map type, final score, ...)
//   g.duration, g.limit, g.timeLimit, g.regEnd   frames (regEnd: end of regulation)
//   g.stands      { 1: [x, y], 2: [x, y] } flag stands in pixels
//   g.people[i]   { name, auth, score, points, team (at the start), events: [{ type, time, team, power }] }
//                 events use tagpro.eu's names: join switch quit end grab capture drop pop return tag
//                 powerup duplicatePowerup startPrevent stopPrevent startButton stopButton startBlock stopBlock
//   g.splats      { time, side, x, y } pixels, side = team of the popped player

const TEAM = { red: 1, blue: 2 }, POWER = { 'juke juice': 1, 'rolling bomb': 2, tagpro: 4, 'top speed': 8 };
const EDGE = { 'prevent start': 'startPrevent', 'prevent stop': 'stopPrevent', 'button start': 'startButton',
  'button stop': 'stopButton', 'block start': 'startBlock', 'block stop': 'stopBlock' };

function buildGame(file) {
  const { events, positions, meta } = extract(file);
  // replay times are when the recorder got each update: the server's 60 ticks a second plus a few ms of
  // delay. Find where the ticks fall (the average offset of all update times from a 60 per second grid)
  // and count frames on that grid, so each event lands on its own server tick like tagpro.eu's
  const P = 1000 / FPS;
  let c = 0, sn = 0;
  for (const r of positions) { const a = 2 * Math.PI * (((r.seconds * 1000) % P + P) % P) / P; c += Math.cos(a); sn += Math.sin(a); }
  const phase = Math.atan2(sn, c) / (2 * Math.PI) * P;
  const frame = seconds => Math.round((seconds * 1000 - phase) / P);
  const start = events.find(e => e.event === 'game start') || { details: '' };
  const end = events.find(e => e.event === 'game end');
  const timeLimit = Math.round((+(start.details.match(/length (\d+) s/) || [])[1] || 0) / 60);
  const g = { meta, timeLimit, limit: timeLimit * 60 * 60, duration: frame(end ? end.seconds : events[events.length - 1].seconds),
    stands: {}, people: [], splats: [] };
  g.regEnd = g.limit && g.duration > g.limit ? g.limit : g.duration;
  for (const [, flag, x, y] of start.details.matchAll(/(red|blue) flag at ([\d.]+),([\d.]+)/g)) g.stands[TEAM[flag]] = [x * 40, y * 40];

  const byName = {};
  const person = name => byName[name] ??= g.people[g.people.push({ name, auth: false, score: 0, points: 0, team: 0, now: 0, events: [] }) - 1];
  const push = (p, type, t, extra) => p.events.push({ type, time: t, team: p.now, ...extra });
  for (const e of events) {
    if (!e.player) continue;
    const p = person(e.player), t = frame(e.seconds), before = e.seconds <= 0;
    // tagpro.eu lists players in the order of their last arrival before the start (a rejoin moves them back)
    if ((e.event === 'join' || e.event === 'rejoin') && (before || p.order == null)) p.order = e.seconds;
    if (e.event === 'join' || e.event === 'rejoin' || e.event === 'switch team') {
      const team = e.event === 'switch team' ? TEAM[e.details.replace('now ', '')] : TEAM[e.team];
      if (before) p.team = p.now = team;
      else { push(p, p.now ? 'switch' : 'join', t); p.now = team; p.events[p.events.length - 1].team = team; }
    } else if (e.event === 'leave') { if (before) p.team = p.now = 0; else { push(p, 'quit', t); p.now = 0; } }
    else if (e.event === 'final stats') {
      p.auth = e.details.startsWith('registered');
      p.score = +(e.details.match(/score (-?\d+)/) || [0, 0])[1];
      p.points = +(e.details.match(/points (-?\d+)/) || [0, 0])[1];
    } else if (e.seconds < 0) continue;
    else if (e.event === 'grab') push(p, 'grab', t);
    else if (e.event === 'cap') push(p, 'capture', t);
    else if (e.event === 'pop') {
      push(p, e.details.startsWith('carrying') ? 'drop' : 'pop', t);
      const by = e.details.match(/(returned|tagged) by ([^;]+)/);
      if (by) push(person(by[2]), by[1] === 'returned' ? 'return' : 'tag', t);
      const sp = e.details.match(/splat at ([\d.]+),([\d.]+)/);
      if (sp) g.splats.push({ time: t, side: TEAM[e.team], x: sp[1] * 40, y: sp[2] * 40 });
    } else if (e.event === 'pup pickup') {
      if (POWER[e.details]) push(p, 'powerup', t, { power: POWER[e.details] }); else push(p, 'duplicatePowerup', t);
    } else if (EDGE[e.event]) push(p, EDGE[e.event], t);
  }
  for (const p of g.people) { if (p.now) push(p, 'end', g.duration); delete p.now; }
  g.people = g.people.filter(p => p.team || p.events.length).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return g;
}

// Which team each person was on and for how long: g.people[i].teamTime { 1, 2 } and .intervals
// [{ team, start, end }] in frames. Used by minutes, color, result, hold against and regulation stats.
function addTeamTime(g) {
  for (const p of g.people) {
    p.teamTime = { 1: 0, 2: 0 }; p.intervals = [];
    let team = p.team, since = team ? 0 : -1;
    const leave = t => { if (since >= 0 && team) { p.teamTime[team] += t - since; p.intervals.push({ team, start: since, end: t }); } since = -1; };
    for (const e of p.events) {
      if (e.type === 'join') { team = e.team; since = e.time; }
      else if (e.type === 'switch') { leave(e.time); team = e.team; since = e.time; }
      else if (e.type === 'quit') { leave(e.time); team = 0; }
      else if (e.type === 'end') leave(e.time);
    }
    // the team a person counts for: the one they spent most time on
    p.color = p.teamTime[1] >= p.teamTime[2] ? (p.teamTime[1] ? 1 : 0) : 2;
    p.minutes = (p.teamTime[1] + p.teamTime[2]) / 60 / 60;
  }
  return g;
}

// Every hold: { player (index into g.people), side, start, end, how: 'cap' | 'drop' | 'pop' | 'end' },
// sorted by start then player, as the league takes them. g.holds. Used by most timeline stats.
function addHolds(g) {
  const holds = [];
  g.people.forEach((p, i) => {
    let hold = null;
    const close = (t, how) => { if (hold) { Object.assign(hold, { end: t, how }); holds.push(hold); hold = null; } };
    for (const e of p.events) {
      if (e.type === 'grab') hold = { player: i, side: e.team, start: e.time };
      else if (e.type === 'capture') close(e.time, 'cap');
      else if (e.type === 'drop' || e.type === 'pop') close(e.time, e.type);
      else if (['switch', 'quit', 'end'].includes(e.type)) close(e.time, 'end');
    }
  });
  g.holds = holds.sort((a, b) => a.start - b.start || a.player - b.player);
  return g;
}
const dropped = h => h.how === 'drop' || h.how === 'pop';

// The league's periods: regulation, then clutch time (the score wasn't tied at the limit and a flag was
// held: play runs on until that hold ends), then overtime (tied at the limit, or tied by a clutch-time
// cap). g.bounds = frame boundaries, g.hadClutch, g.wentToOvertime. Needs g.holds.
function addPeriods(g) {
  const { limit, duration, holds } = g;
  g.bounds = [0]; g.hadClutch = false; g.wentToOvertime = false;
  if (limit && duration > limit) {
    const caps = side => holds.filter(h => h.side === side && h.how === 'cap' && h.end <= limit).length;
    let otFrom = limit;
    if (caps(1) !== caps(2)) {
      const live = holds.filter(h => h.start <= limit && h.end > limit);
      const clutchEnd = live.length ? Math.max(...live.map(h => h.end)) : duration;
      g.bounds.push(limit);
      otFrom = clutchEnd;
      // the league only counts clutch time from half a second past the limit
      g.hadClutch = live.some(h => h.how !== 'end') && clutchEnd - limit >= FPS / 2;
    }
    if (duration - otFrom >= FPS / 2) { g.bounds.push(otFrom); g.wentToOvertime = true; }
  }
  g.bounds.push(duration);
  return g;
}

// ================================================================ stats

// Match and player details: who, when, where, which team, the result.
function info(g) {
  const m = g.meta, score = { 1: m.teams ? m.teams.red.score : 0, 2: m.teams ? m.teams.blue.score : 0 };
  const inGame = g.people.filter(p => p.minutes > 0).length;
  return g.people.map(p => {
    const forUs = p.color ? score[p.color] : 0, against = p.color ? score[3 - p.color] : 0;
    return {
      match_id: g.id, date: m.started ? new Date(m.started).toISOString().slice(0, 10) : '', map: m.mapName || '',
      mode: m.mapType === 'ctf' ? 'ctf' : m.mapType === 'nf' ? 'nf' : 'other', group: m.private ? 1 : 0,
      server: (m.serverHostname || '').replace(/^tagpro-/, '').replace(/\.koalabeast\.com$/, ''), time_limit: g.timeLimit,
      game_minutes: round(g.duration / 3600), finished: m.finished ? 1 : 0, players_in_game: inGame,
      player: p.name, played_as: p.name, auth: p.auth ? 1 : 0, color: { 1: 'red', 2: 'blue' }[p.color] || '',
      result: !p.color ? '' : forUs > against ? 'W' : forUs < against ? 'L' : 'T',
      overtime: g.wentToOvertime ? 1 : 0, clutch_time: g.hadClutch ? 1 : 0,
      caps_for: forUs, caps_against: against, cap_diff: forUs - against, minutes: round(p.minutes),
    };
  });
};

// Teammates and opponents by name (needs the color column).
function teammates(g, rows) {
  const on = { red: [], blue: [] };
  for (const r of rows) if (on[r.color]) on[r.color].push(r.player);
  return rows.map(r => ({ teammates: (on[r.color] || []).filter(n => n !== r.player).join(' / '),
    opponents: r.color ? on[r.color === 'red' ? 'blue' : 'red'].join(' / ') : '' }));
};

// The basic counts, straight from each person's events, plus the pup types.
const KINDS = { grab: 'grabs', capture: 'captures', drop: 'drops', return: 'returns' };
const POWERS = { 1: 'juke_juice', 2: 'rolling_bomb', 4: 'tagpro', 8: 'top_speed' };
function counts(g) {
  const rows = g.people.map(p => {
    const c = { tags: 0, pops: 0, grabs: 0, drops: 0, captures: 0, returns: 0, pups: 0, juke_juice: 0, rolling_bomb: 0, tagpro: 0, top_speed: 0 };
    for (const e of p.events) {
      if (KINDS[e.type]) c[KINDS[e.type]]++;
      if (e.type === 'drop' || e.type === 'pop') c.pops++;
      if (e.type === 'return' || e.type === 'tag') c.tags++;
      if (e.type === 'powerup') { c.pups++; c[POWERS[e.power]]++; }
      if (e.type === 'duplicatePowerup') c.pups++;
    }
    return c;
  });
  const available = rows.reduce((n, c) => n + c.pups, 0);
  return rows.map((c, i) => ({ ...c, pups_available: available, nr_tags: Math.max(0, c.tags - c.returns),
    nd_pops: Math.max(0, c.pops - c.drops), kept_flags: c.grabs - c.drops - c.captures,
    eu_score: g.people[i].score, eu_points: g.people[i].points }));
};

// Seconds holding, preventing, on buttons and blocking (and prevent in regulation).
function timers(g) {
  return g.people.map((p, i) => {
    const out = { prevent: 0, button: 0, block: 0 }, open = {};
    let regPrevent = 0;
    for (const e of p.events) {
      const k = e.type.replace(/^(start|stop)/, '').toLowerCase();
      if (e.type.startsWith('start')) open[k] = e.time;
      else if (e.type.startsWith('stop') && open[k] != null) {
        out[k] += e.time - open[k];
        if (k === 'prevent') regPrevent += Math.max(0, Math.min(e.time, g.regEnd) - open[k]);
        open[k] = null;
      }
    }
    for (const k of Object.keys(open)) if (open[k] != null) out[k] += g.duration - open[k];
    if (open.prevent != null) regPrevent += Math.max(0, g.regEnd - open.prevent);
    const hold = g.holds.filter(h => h.player === i).reduce((n, h) => n + h.end - h.start, 0);
    return { hold: round(hold / 60), prevent: round(out.prevent / 60), button: round(out.button / 60),
      block: round(out.block / 60), regulation_prevent: round(regPrevent / 60) };
  });
};

// Holds against the same side's hold before it: long holds, flaccids, handoffs, regrabs, overtime caps.
// Rules fitted to the league's numbers (STAT_DEFINITIONS.md section 4).
const LONG_HOLD = 20 * FPS, FLACCID = 2 * FPS, HANDOFF = 2 * FPS, HANDOFF_HOLD = 3 * FPS, PASS = 3 * FPS,
  REGRAB_HOLD = 5 * FPS, PASS_HOLD = 2 * FPS, GOOD_HOLD = 5 * FPS;
function chains(g) {
  const out = g.people.map(() => ({ long_holds: 0, flaccids: 0, handoffs: 0, good_handoffs: 0, grabs_off_handoffs: 0,
    grabs_off_regrabs: 0, caps_off_handoffs: 0, caps_off_regrabs: 0, ot_caps: 0 }));
  const last = {};
  for (const h of g.holds) {
    const s = out[h.player], span = h.end - h.start, prev = last[h.side];
    last[h.side] = h;
    if (span > LONG_HOLD && h.how !== 'end') s.long_holds++;
    if (span < FLACCID && dropped(h)) s.flaccids++;
    if (g.limit && h.how === 'cap' && h.end > g.limit) s.ot_caps++;
    if (!prev || prev.player === h.player) continue;
    const gap = h.start - prev.end, given = prev.end - prev.start;
    if (gap < 0) continue;
    const handoff = gap < HANDOFF && given < HANDOFF_HOLD;
    if (handoff) { s.grabs_off_handoffs++; if (h.how === 'cap') s.caps_off_handoffs++; }
    if (gap < PASS && given > REGRAB_HOLD && (gap > 0 || prev.player < h.player)) { s.grabs_off_regrabs++; if (h.how === 'cap') s.caps_off_regrabs++; }
    if ((dropped(h) && gap < PASS && span > PASS_HOLD) || (h.how === 'cap' && handoff)) {
      out[prev.player].handoffs++;
      if (span > GOOD_HOLD) out[prev.player].good_handoffs++;
    }
  }
  return out;
};

// Quick, key and base returns, saves, and TagPro Reference's key returns and saves.
// Rules fitted to the league's numbers (STAT_DEFINITIONS.md section 4).
const QUICK = 2 * FPS, KEY = 3 * FPS, SPLAT_SHIFT = 40, RIB_RADIUS = 5 * 40, SAVE_RADIUS = 2 * 40, SAVE_LAG = FPS / 2,
  MATCH_TOL = 2, TPR_KEY = 2 * FPS, TPR_SAVE_RADIUS = 6 * 40, TPR_SPLAT_SHIFT = 0.5;

// a map from frame to the items in that frame
const byFrame = (list, time) => {
  const map = new Map();
  for (const x of list) { const t = time(x); (map.get(t) || map.set(t, []).get(t)).push(x); }
  return map;
};

function returns(g) {
  const { holds, stands, splats, regEnd } = g;
  const out = g.people.map(() => ({ quick_returns: 0, key_returns: 0, returns_in_base: 0, saves: 0, tprKeyCaps: new Set(), tpr_saves: 0 }));
  const list = [];
  g.people.forEach((p, i) => { for (const e of p.events) if (e.type === 'return') list.push({ time: e.time, player: i, side: e.team }); });
  const capsBySide = { 1: [], 2: [] };
  for (const h of holds) if (h.how === 'cap' && capsBySide[h.side]) capsBySide[h.side].push(h.end);
  // key return: each cap credits the team's last return before it, if that came less than KEY before
  for (const side of [1, 2]) for (const c of capsBySide[side]) {
    let last = null;
    for (const r of list) if (r.side === side && r.time <= c && (!last || r.time >= last.time)) last = r;
    if (last && c - last.time < KEY) out[last.player].key_returns++;
  }
  const dropsAt = byFrame(holds.filter(dropped), h => h.end), splatsAt = byFrame(splats, sp => sp.time);
  const near = (map, t, ok) => {
    for (let d = -MATCH_TOL; d <= MATCH_TOL; d++) for (const x of map.get(t + d) || []) if (ok(x)) return x;
    return null;
  };
  for (const r of list) {
    const s = out[r.player], mine = r.side, theirs = 3 - mine;
    const stopped = near(dropsAt, r.time, h => h.side !== mine);
    if (stopped && stopped.end - stopped.start < QUICK) s.quick_returns++;
    // the returned carrier's splat: the one in the return's own frame if there is one
    let at = null;
    for (let d = 0; d <= MATCH_TOL && !at; d++)
      at = (splatsAt.get(r.time - d) || []).find(sp => sp.side === theirs) || (d && (splatsAt.get(r.time + d) || []).find(sp => sp.side === theirs)) || null;
    if (at) {
      // the league measures from the splat point moved one tile right and one tile down
      const within = (p, radius) => p && (at.x + SPLAT_SHIFT - p[0]) ** 2 + (at.y + SPLAT_SHIFT - p[1]) ** 2 < radius ** 2;
      if (within(stands[mine], RIB_RADIUS)) s.returns_in_base++;
      const holding = holds.some(h => h.side === mine && h.start <= r.time - SAVE_LAG && r.time <= h.end);
      if (!holding && within(stands[theirs], SAVE_RADIUS)) s.saves++;
      const enemy = stands[theirs];
      if (r.time <= regEnd && enemy && !holds.some(h => h.side === mine && h.start <= r.time && r.time < h.end)
        && (at.x + TPR_SPLAT_SHIFT - enemy[0]) ** 2 + (at.y + TPR_SPLAT_SHIFT - enemy[1]) ** 2 < TPR_SAVE_RADIUS ** 2) s.tpr_saves++;
    }
    if (r.time <= regEnd) {
      const cap = (capsBySide[mine] || []).find(c => c >= r.time && c - r.time < TPR_KEY);
      if (cap !== undefined) s.tprKeyCaps.add(cap);
    }
  }
  return out.map(({ tprKeyCaps, ...s }) => ({ ...s, tpr_key_returns: tprKeyCaps.size }));
};

// The league's hold: holds still running at the end left out, each period rounded to whole seconds
// (halves up); hold against = the other team's league hold; regulation hold = the first period's.
function leagueHold(g) {
  const hold = g.people.map(() => 0), regulation = g.people.map(() => 0);
  g.people.forEach((p, i) => {
    for (let k = 0; k + 1 < g.bounds.length; k++) {
      let part = 0;
      for (const h of g.holds) if (h.player === i && h.how !== 'end')
        part += Math.max(0, Math.min(h.end, g.bounds[k + 1]) - Math.max(h.start, g.bounds[k]));
      if (part) hold[i] += Math.floor(part / 60 + 0.5);
      if (k === 0) regulation[i] = hold[i];
    }
  });
  const firstTeam = g.people.map(p => p.intervals[0]?.team ?? 0);
  return g.people.map((p, i) => {
    let against = 0;
    if (firstTeam[i]) g.people.forEach((_, j) => { if (firstTeam[j] && firstTeam[j] !== firstTeam[i]) against += hold[j]; });
    return { league_hold: hold[i], hold_against: against, regulation_hold: regulation[i] };
  });
};

// The counts up to the time limit (the league's season tables, GASP and NISH only count this part).
function regulation(g) {
  const score = { 1: 0, 2: 0 };
  for (const h of g.holds) if (h.how === 'cap' && h.end <= g.regEnd && score[h.side] !== undefined) score[h.side]++;
  return g.people.map(p => {
    const r = { regulation_tags: 0, regulation_pops: 0, regulation_grabs: 0, regulation_caps: 0, regulation_returns: 0 };
    for (const e of p.events) {
      if (e.time > g.regEnd) continue;
      if (e.type === 'grab') r.regulation_grabs++;
      else if (e.type === 'capture') r.regulation_caps++;
      else if (e.type === 'drop' || e.type === 'pop') r.regulation_pops++;
      else if (e.type === 'return') { r.regulation_returns++; r.regulation_tags++; }
      else if (e.type === 'tag') r.regulation_tags++;
    }
    return { ...r, regulation_minutes: round(p.intervals.reduce((a, iv) => a + Math.max(0, Math.min(iv.end, g.regEnd) - iv.start), 0) / 3600),
      regulation_cap_diff: p.color ? score[p.color] - score[3 - p.color] : 0 };
  });
};

// Ratios and per-minute stats, from a row's totals.
function rates(g, rows) {
  return rows.map(r => {
    const pm = k => round(div(r[k], r.minutes));
    return {
      score_pct: round(div(r.captures, r.grabs) * 100), kd: round(div(r.tags, r.pops)),
      hold_per_grab: round(div(r.hold, r.grabs)), prevent_per_return: round(div(r.prevent, r.returns)),
      prevent_per_hold_against: round(div(r.prevent, r.hold_against)), pup_pct: round(div(r.pups, r.pups_available) * 100),
      flaccid_pct: round(div(r.flaccids, r.grabs) * 100), chain_pct: round(div(r.good_handoffs, r.handoffs) * 100),
      spark_pct: round(div(r.captures - r.caps_off_handoffs - r.caps_off_regrabs, r.captures) * 100),
      qr_pct: round(div(r.quick_returns, r.returns) * 100), rib_pct: round(div(r.returns_in_base, r.returns) * 100),
      support: Math.floor(r.button / 5) + Math.floor(r.block / 5) * 2,
      cpm: pm('captures'), gpm: pm('grabs'), rpm: pm('returns'), tpm: pm('tags'), ppm: pm('pops'), dpm: pm('drops'),
      pupm: pm('pups'), hold_pm: pm('hold'), prevent_pm: pm('prevent'), nrtpm: pm('nr_tags'),
      hold_against_pm: pm('hold_against'), cd_pm: pm('cap_diff'),
    };
  });
};

// The in-game scoreboard score (IPMv1.1): each stat compared with the other eligible players in the
// match, weighted, rescaled to 50 +- 20.
function scoreboard(g, rows) {
  const gameMinutes = g.duration / 3600;
  const elig = rows.filter(r => r.color && r.minutes >= 0.5 && div(r.minutes, gameMinutes) >= 0.15);
  const out = rows.map(() => ({ dscore: '', oscore: '', score: '' }));
  if (!elig.length) return out;
  const stat = {
    captures: r => div(r.captures, r.minutes), hold: r => div(r.hold, r.minutes), prevent: r => div(r.prevent, r.minutes),
    returns: r => div(r.returns, r.minutes), nonReturnTags: r => div(r.tags - r.returns, r.minutes),
    scorePercent: r => div(r.captures, r.grabs), kd: r => div(r.tags, r.pops),
  };
  const meanSd = xs => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { mean, sd: Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length) };
  };
  const vals = {}, dist = {};
  for (const k in stat) { vals[k] = elig.map(stat[k]); dist[k] = meanSd(vals[k]); }
  const side = (w, i) => Object.entries(w).reduce((a, [k, wt]) => {
    const { mean, sd } = dist[k], z = sd > 0 ? ((vals[k][i] - mean) / sd) * wt : 0;
    return a + (Number.isFinite(z) ? z : 0);
  }, 0);
  const o = elig.map((_, i) => side({ captures: 20, hold: 38, scorePercent: 42 }, i));
  const d = elig.map((_, i) => side({ kd: 18, returns: 34, prevent: 40, nonReturnTags: 8 }, i));
  const t = o.map((x, i) => (x > d[i] ? x * 2 / 3 + d[i] / 3 : d[i] > x ? x / 3 + d[i] * 2 / 3 : (x + d[i]) / 2));
  const scale = xs => { const { mean, sd } = meanSd(xs); return xs.map(x => { const v = ((x - mean) / sd) * 20 + 50; return Number.isFinite(v) ? Math.round(v) : 50; }); };
  const so = scale(o), sd = scale(d), st = scale(t);
  elig.forEach((r, i) => Object.assign(out[rows.indexOf(r)], { score: st[i], oscore: so[i], dscore: sd[i] }));
  return out;
};

// ================================================================ running it

// in order: later stats read columns the earlier ones made
const STATS = [info, teammates, counts, timers, chains, returns, leagueHold, regulation, rates, scoreboard];

function gameStats(file) {
  const g = addPeriods(addHolds(addTeamTime(buildGame(file))));
  g.id = replayName(file);
  let rows = g.people.map(() => ({}));
  for (const stat of STATS) { const cols = stat(g, rows); rows = rows.map((r, i) => ({ ...r, ...cols[i] })); }
  return rows;
}

const COLUMNS = ['match_id', 'date', 'map', 'mode', 'group', 'server', 'time_limit', 'game_minutes', 'finished',
  'players_in_game', 'player', 'played_as', 'auth', 'color', 'teammates', 'opponents', 'result', 'overtime', 'clutch_time',
  'caps_for', 'caps_against', 'cap_diff', 'minutes', 'tags', 'pops', 'grabs', 'drops', 'captures', 'returns', 'hold',
  'prevent', 'button', 'block', 'pups', 'juke_juice', 'rolling_bomb', 'tagpro', 'top_speed', 'pups_available',
  'long_holds', 'flaccids', 'handoffs', 'good_handoffs', 'grabs_off_handoffs', 'grabs_off_regrabs', 'caps_off_handoffs',
  'caps_off_regrabs', 'ot_caps', 'quick_returns', 'key_returns', 'returns_in_base', 'saves', 'tpr_key_returns', 'tpr_saves',
  'nr_tags', 'nd_pops', 'kept_flags', 'league_hold', 'hold_against', 'eu_score', 'eu_points', 'regulation_minutes',
  'regulation_tags', 'regulation_pops', 'regulation_grabs', 'regulation_caps', 'regulation_returns', 'regulation_hold',
  'regulation_prevent', 'regulation_cap_diff', 'score_pct', 'kd', 'hold_per_grab', 'prevent_per_return',
  'prevent_per_hold_against', 'pup_pct', 'flaccid_pct', 'chain_pct', 'spark_pct', 'qr_pct', 'rib_pct', 'support', 'cpm',
  'gpm', 'rpm', 'tpm', 'ppm', 'dpm', 'pupm', 'hold_pm', 'prevent_pm', 'nrtpm', 'hold_against_pm', 'cd_pm', 'dscore', 'oscore', 'score'];

module.exports = { gameStats, COLUMNS };
if (require.main !== module) return;

const args = process.argv.slice(2), outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : 'eu-stats.csv';
const files = replayFiles(args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)));
if (!files.length) { console.error('usage: node eu-stats.js <replay or folder>... [--out eu-stats.csv]'); process.exit(1); }
const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const lines = [COLUMNS.join(',')];
for (const file of files) for (const r of gameStats(file)) lines.push(COLUMNS.map(c => cell(r[c] ?? '')).join(','));
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${files.length} game(s), ${lines.length - 1} player rows -> ${out}`);
