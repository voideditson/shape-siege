'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const WORLD_SIZE = 3000;
const TICK_RATE = 30;
const SNAP_INTERVAL = 0.05; // seconds between snapshots sent to clients (20 Hz)
const MAX_PLAYERS = 6;
const BULLET_RANGE = 450;
// For testing only: START_WAVE=5 node server.js jumps straight to a boss wave.
const START_WAVE = Math.max(1, parseInt(process.env.START_WAVE || '1', 10) || 1);

// 15 Upgrade Cards (Max 5 Limit each)
const CARDS = [
  { id: 'hp', name: 'Vitality', desc: '+25% Max HP' },
  { id: 'spd', name: 'Agility', desc: '+15% Move Speed' },
  { id: 'dmg', name: 'Brute Force', desc: '+20% Damage' },
  { id: 'firerate', name: 'Trigger Happy', desc: '+15% Fire Rate' },
  { id: 'bulletspeed', name: 'Velocity', desc: '+25% Bullet Speed' },
  { id: 'regen', name: 'Cellular Regen', desc: 'Heal 1.5 HP/sec' },
  { id: 'sprintspd', name: 'Track Star', desc: '+25% Sprint Speed' },
  { id: 'sprintdur', name: 'Marathon', desc: '+30% Max Stamina' },
  { id: 'revive', name: 'Combat Medic', desc: '+50% Revive Speed' },
  { id: 'pierce', name: 'Piercing', desc: 'Bullets pierce +1 target' },
  { id: 'multishot', name: 'Spread', desc: '+1 Projectile (More Spread)' },
  { id: 'lifesteal', name: 'Vampirism', desc: '+5 HP on kill' },
  { id: 'knockback', name: 'Repel', desc: '+30% Knockback' },
  { id: 'armor', name: 'Plating', desc: '-10% Damage Taken' },
  { id: 'crit', name: 'Lethality', desc: '+10% Crit Chance' }
];

const BOSS_KINDS = [
  { name: 'THE BRUTE', color: '#A855F7', attacks: ['slam', 'charge', 'ring'] },
  { name: 'THE WEAVER', color: '#EC4899', attacks: ['spiral', 'volley', 'summon'] },
  { name: 'THE WARDEN', color: '#F59E0B', attacks: ['slam', 'ring', 'spiral', 'charge', 'summon', 'volley'] }
];
const ATTACK_MIN_PHASE = { slam: 1, ring: 1, volley: 1, spiral: 1, charge: 1, summon: 2 };
const WINDUP = { slam: 1100, ring: 900, volley: 750, spiral: 700, charge: 950, summon: 1000 };

const rooms = {};

// ---------------------------------------------------------------- helpers
const rid = () => Math.random().toString(36).substring(2, 8);
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const axis = (v) => { v = num(v); return v > 0.3 ? 1 : v < -0.3 ? -1 : 0; };
const cleanName = (s) => String(s || '').replace(/[<>&"'`\\/]/g, '').trim().slice(0, 10) || 'Player';

function pushEvent(room, ev) { if (room.events.length < 250) room.events.push(ev); }
function later(room, ms, fn) { room.timers.push({ at: Date.now() + ms, fn }); }

function segCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((cx - x1) * dx + (cy - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x1 + dx * t - cx, py = y1 + dy * t - cy;
  return px * px + py * py <= r * r;
}

// ---------------------------------------------------------------- map
function generateMap() {
  const obstacles = [];
  const c = WORLD_SIZE / 2;
  let guard = 0;
  while (obstacles.length < 60 && guard++ < 600) {
    const w = Math.random() * 120 + 40;
    const h = Math.random() * 120 + 40;
    const x = Math.random() * (WORLD_SIZE - 200) + 100;
    const y = Math.random() * (WORLD_SIZE - 200) + 100;
    // keep the spawn area in the middle clear
    const nx = Math.max(x, Math.min(c, x + w));
    const ny = Math.max(y, Math.min(c, y + h));
    if (Math.hypot(nx - c, ny - c) < 260) continue;
    obstacles.push({ x, y, w, h, color: ['#1E293B', '#334155', '#0F172A'][Math.floor(Math.random() * 3)] });
  }
  return obstacles;
}

function insideObstacle(room, x, y) {
  const map = room.map;
  for (let i = 0; i < map.length; i++) {
    const o = map[i];
    if (x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h) return true;
  }
  return false;
}

// circle (ent, radius r) vs every obstacle rectangle, pushes ent out
function pushOut(room, ent, r) {
  const map = room.map;
  for (let i = 0; i < map.length; i++) {
    const o = map[i];
    if (ent.x < o.x - r || ent.x > o.x + o.w + r || ent.y < o.y - r || ent.y > o.y + o.h + r) continue;
    const cx = Math.max(o.x, Math.min(ent.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(ent.y, o.y + o.h));
    const dx = ent.x - cx, dy = ent.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 > 0.0001) {
      const d = Math.sqrt(d2);
      const push = r - d;
      ent.x += (dx / d) * push;
      ent.y += (dy / d) * push;
    } else {
      const left = ent.x - o.x, right = o.x + o.w - ent.x, up = ent.y - o.y, down = o.y + o.h - ent.y;
      const m = Math.min(left, right, up, down);
      if (m === left) ent.x = o.x - r;
      else if (m === right) ent.x = o.x + o.w + r;
      else if (m === up) ent.y = o.y - r;
      else ent.y = o.y + o.h + r;
    }
  }
}

// ---------------------------------------------------------------- players
function initPlayer(id, name, isHost) {
  return {
    id, name, isHost,
    x: WORLD_SIZE / 2 + (Math.random() * 100 - 50),
    y: WORLD_SIZE / 2 + (Math.random() * 100 - 50),
    angle: 0,
    hp: 100, maxHp: 100,
    knocked: false, deathTimer: 30, dead: false,
    reviveProgress: 0,
    sprint: 100, maxSprint: 100,
    // speeds are pixels per second now, so changing TICK_RATE no longer changes game speed
    stats: { spd: 165, dmg: 22, firerate: 380, bulletspeed: 280, regen: 0, sprintspd: 270, revivespd: 1, pierce: 0, multishot: 1, lifesteal: 0, knockback: 1, armor: 1, crit: 0.05 },
    upgrades: {},
    offered: [],
    lastShot: 0,
    hasPickedCard: false,
    hurtUntil: 0,
    kills: 0, damage: 0, revives: 0,
    input: { dx: 0, dy: 0, angle: 0, shoot: false, sprint: false, revive: false }
  };
}

function getRandomCards(p) {
  const available = CARDS.filter(c => (p.upgrades[c.id] || 0) < 5);
  const shuffled = [...available].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3);
}

function applyUpgrade(p, cardId) {
  if (cardId === 'hp') { p.maxHp *= 1.25; p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25); }
  if (cardId === 'spd') p.stats.spd *= 1.15;
  if (cardId === 'dmg') p.stats.dmg *= 1.20;
  if (cardId === 'firerate') p.stats.firerate *= 0.85;
  if (cardId === 'bulletspeed') p.stats.bulletspeed *= 1.25;
  if (cardId === 'regen') p.stats.regen += 1.5;
  if (cardId === 'sprintspd') p.stats.sprintspd *= 1.25;
  if (cardId === 'sprintdur') p.maxSprint *= 1.30; // was applied twice before (+69%), now a true +30%
  if (cardId === 'revive') p.stats.revivespd *= 1.5;
  if (cardId === 'pierce') p.stats.pierce += 1;
  if (cardId === 'multishot') p.stats.multishot += 1;
  if (cardId === 'lifesteal') p.stats.lifesteal += 5;
  if (cardId === 'knockback') p.stats.knockback *= 1.3;
  if (cardId === 'armor') p.stats.armor *= 0.9;
  if (cardId === 'crit') p.stats.crit += 0.1;
}

function applyBossBuffs(room) {
  Object.values(room.players).forEach(p => {
    p.maxHp += 50;
    p.hp = p.maxHp;
    p.stats.dmg *= 1.25;
    p.stats.spd *= 1.1;
  });
}

// returns true if the hit landed (not blocked by invulnerability frames)
function hurtPlayer(room, p, dmg, iframesMs, now) {
  if (p.dead || p.knocked || now < p.hurtUntil) return false;
  p.hurtUntil = now + iframesMs;
  const real = dmg * p.stats.armor;
  p.hp -= real;
  pushEvent(room, { t: 'h', id: p.id, v: Math.round(real) });
  if (p.hp <= 0) {
    p.hp = 0;
    p.knocked = true;
    p.deathTimer = 30;
    p.reviveProgress = 0;
    p.input.shoot = false;
  }
  return true;
}

function getNearestAlive(room, x, y) {
  let best = null, bd = Infinity;
  for (const p of Object.values(room.players)) {
    if (p.dead || p.knocked) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---------------------------------------------------------------- enemies
function getMapSpawnPosition(room) {
  const players = Object.values(room.players).filter(p => !p.dead);
  let x = WORLD_SIZE / 2, y = WORLD_SIZE / 2;
  for (let attempts = 0; attempts < 30; attempts++) {
    x = Math.random() * (WORLD_SIZE - 400) + 200;
    y = Math.random() * (WORLD_SIZE - 400) + 200;
    let safe = true;
    for (const p of players) {
      if (Math.hypot(p.x - x, p.y - y) < 400) { safe = false; break; }
    }
    if (safe) {
      for (const o of room.map) {
        if (x > o.x - 40 && x < o.x + o.w + 40 && y > o.y - 40 && y < o.y + o.h + 40) { safe = false; break; }
      }
    }
    if (safe) break;
  }
  return { x, y };
}

function createEnemy(room, type, x, y) {
  const w = room.wave;
  let hp = 40 * (1 + w * 0.15);
  let speed = 84 + w * 0.8;
  let size = 16;
  if (type === 'PENTAGON') { speed = 56; hp *= 1.4; size = 20; }
  else if (type === 'CIRCLE') { speed = 116; hp *= 0.7; size = 12; }
  else if (type === 'HEXAGON') { speed = 40; hp *= 3.5; size = 32; }
  return { id: rid(), x, y, hp, maxHp: hp, speed, size, type, lastShot: Date.now() + Math.random() * 2000 };
}

function spawnBoss(room) {
  const idx = Math.floor(room.wave / 5) - 1;
  const kind = BOSS_KINDS[idx % BOSS_KINDS.length];
  const n = Math.max(1, Object.keys(room.players).length);
  // old formula was 6000 * (1 + wave * 0.4) = 18000 HP at wave 5, which is minutes of solo shooting
  const hp = (1800 + room.wave * 380) * (1 + 0.6 * (n - 1));
  const pos = getMapSpawnPosition(room);
  const now = Date.now();
  room.enemies.push({
    id: rid(), x: pos.x, y: pos.y, hp, maxHp: hp,
    speed: 48, size: 65, type: 'BOSS',
    name: kind.name, color: kind.color, kind,
    phase: 1, mode: 'chase', attack: null,
    nextAttack: now + 2500, recoverUntil: 0, lastAttack: null
  });
}

function spawnWave(room) {
  room.state = 'PLAYING';
  const isBossWave = room.wave % 5 === 0;
  const n = Math.max(1, Object.keys(room.players).length);

  if (isBossWave) {
    spawnBoss(room);
    const boss = room.enemies[room.enemies.length - 1];
    io.to(room.id).emit('waveStart', { wave: room.wave, boss: boss.name });
  } else {
    const count = Math.min(90, Math.round((8 + room.wave * 3) * (1 + 0.45 * (n - 1))));
    for (let i = 0; i < count; i++) {
      const pos = getMapSpawnPosition(room);
      const rand = Math.random();
      let type = 'TRIANGLE';
      if (rand < 0.25) type = 'PENTAGON';
      else if (rand < 0.45) type = 'CIRCLE';
      else if (rand < 0.60) type = 'HEXAGON';
      room.enemies.push(createEnemy(room, type, pos.x, pos.y));
    }
    io.to(room.id).emit('waveStart', { wave: room.wave, boss: null });
  }
}

function fireEnemyBullet(room, x, y, angle, speed, dmg, life, k) {
  if (room.enemyBullets.length > 700) return;
  room.enemyBullets.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, dmg, life, k });
}
function fireRing(room, x, y, count, angle, speed, dmg) {
  for (let i = 0; i < count; i++) fireEnemyBullet(room, x, y, angle + (i * Math.PI * 2) / count, speed, dmg, 4, 1);
}
function fireFan(room, x, y, angle, count, spread, speed, dmg) {
  for (let i = 0; i < count; i++) fireEnemyBullet(room, x, y, angle + (i - (count - 1) / 2) * spread, speed, dmg, 3.2, 1);
}

function killEnemy(room, e, owner) {
  e.dead = true;
  if (owner) {
    owner.kills++;
    if (owner.stats.lifesteal > 0 && !owner.knocked && !owner.dead) owner.hp = Math.min(owner.maxHp, owner.hp + owner.stats.lifesteal);
  }
  pushEvent(room, { t: 'k', x: r1(e.x), y: r1(e.y), s: e.size, ty: e.type });
  if (e.type === 'BOSS') {
    pushEvent(room, { t: 'shake', m: 22 });
    room.telegraphs = room.telegraphs.filter(t => t.owner !== e.id);
    room.enemyBullets = [];
    room.timers = [];
    for (const o of room.enemies) {
      if (o !== e && !o.dead) {
        o.dead = true;
        pushEvent(room, { t: 'k', x: r1(o.x), y: r1(o.y), s: o.size, ty: o.type });
      }
    }
  }
}

// ---------------------------------------------------------------- boss brain
const bossDmgMul = (room) => 1 + Math.max(0, Math.floor(room.wave / 5) - 1) * 0.25;

function newTel(room, e, now, wind, kind, props) {
  const t = Object.assign({ id: rid(), owner: e.id, kind, x: e.x, y: e.y, angle: 0, radius: 0, length: 0, width: 0, count: 0, spread: 0, start: now, exec: now + wind }, props);
  room.telegraphs.push(t);
  return t;
}
function removeTel(room, id) { room.telegraphs = room.telegraphs.filter(t => t.id !== id); }

function endBossAttack(room, e, now, recoverMs) {
  e.mode = 'recover';
  e.attack = null;
  e.recoverUntil = now + recoverMs;
  e.nextAttack = now + recoverMs + [1800, 1400, 1000][e.phase - 1];
}

function onBossPhase(room, e, now) {
  room.telegraphs = room.telegraphs.filter(t => t.owner !== e.id);
  e.attack = null;
  e.mode = 'recover';
  e.recoverUntil = now + 1200;
  e.nextAttack = now + 2400;
  pushEvent(room, { t: 'phase', n: e.phase, name: e.name });
  pushEvent(room, { t: 'shake', m: 18 });
  fireRing(room, e.x, e.y, 20, 0, 150, 14 * bossDmgMul(room));
}

function startBossAttack(room, e, now, target) {
  const pool = e.kind.attacks.filter(a => ATTACK_MIN_PHASE[a] <= e.phase && a !== e.lastAttack);
  const type = pool.length ? pool[Math.floor(Math.random() * pool.length)] : e.kind.attacks[0];
  e.lastAttack = type;
  const wind = WINDUP[type] * (e.phase === 3 ? 0.8 : 1);
  const aim = Math.atan2(target.y - e.y, target.x - e.x);
  let tel;
  if (type === 'slam') tel = newTel(room, e, now, wind, 'circle', { radius: 230 });
  else if (type === 'ring') tel = newTel(room, e, now, wind, 'ring', { count: [14, 18, 22][e.phase - 1], angle: Math.random() * Math.PI * 2, radius: 320 });
  else if (type === 'volley') tel = newTel(room, e, now, wind, 'fan', { count: [5, 7, 9][e.phase - 1], spread: 0.16, angle: aim, radius: 700 });
  else if (type === 'spiral') tel = newTel(room, e, now, wind, 'pulse', { radius: 110 });
  else if (type === 'charge') tel = newTel(room, e, now, wind, 'line', { angle: aim, length: 900, width: e.size * 2 + 10 });
  else tel = newTel(room, e, now, wind, 'summon', { radius: 160, count: [4, 6, 8][e.phase - 1], angle: Math.random() * Math.PI * 2 });
  e.mode = 'windup';
  e.attack = { type, tel, execAt: now + wind };
}

function execBossAttack(room, e, now) {
  const a = e.attack;
  const tel = a.tel;
  const dm = bossDmgMul(room);
  const ph = e.phase;
  removeTel(room, tel.id);

  if (a.type === 'slam') {
    for (const p of Object.values(room.players)) {
      if (!p.dead && !p.knocked && Math.hypot(p.x - tel.x, p.y - tel.y) < tel.radius + 15) hurtPlayer(room, p, 40 * dm, 500, now);
    }
    pushEvent(room, { t: 'boom', x: r1(tel.x), y: r1(tel.y), r: tel.radius, col: e.color });
    pushEvent(room, { t: 'shake', m: 14 });
    if (ph >= 2) fireRing(room, tel.x, tel.y, 12, 0, 170, 16 * dm);
    if (ph === 3) later(room, 450, () => { if (!e.dead) fireRing(room, tel.x, tel.y, 12, Math.PI / 12, 170, 16 * dm); });
    endBossAttack(room, e, now, 700);
  } else if (a.type === 'ring') {
    fireRing(room, e.x, e.y, tel.count, tel.angle, 165, 18 * dm);
    if (ph >= 2) later(room, 420, () => { if (!e.dead) fireRing(room, e.x, e.y, tel.count, tel.angle + Math.PI / tel.count, 165, 18 * dm); });
    if (ph === 3) later(room, 840, () => { if (!e.dead) fireRing(room, e.x, e.y, tel.count, tel.angle + Math.PI / (2 * tel.count), 165, 18 * dm); });
    pushEvent(room, { t: 'boom', x: r1(e.x), y: r1(e.y), r: 90, col: e.color });
    pushEvent(room, { t: 'shake', m: 8 });
    endBossAttack(room, e, now, 800);
  } else if (a.type === 'volley') {
    fireFan(room, e.x, e.y, tel.angle, tel.count, tel.spread, 280, 16 * dm);
    if (ph >= 2) {
      later(room, 380, () => {
        if (e.dead) return;
        const t = getNearestAlive(room, e.x, e.y);
        if (t) fireFan(room, e.x, e.y, Math.atan2(t.y - e.y, t.x - e.x), tel.count, tel.spread, 280, 16 * dm);
      });
    }
    pushEvent(room, { t: 'shake', m: 5 });
    endBossAttack(room, e, now, 700);
  } else if (a.type === 'spiral') {
    a.spiral = { end: now + (ph === 3 ? 3600 : 3000), next: now, ang: Math.random() * Math.PI * 2, arms: ph === 3 ? 3 : 2 };
    e.mode = 'active';
  } else if (a.type === 'charge') {
    a.dash = { until: now + 750, angle: tel.angle, hit: {} };
    e.mode = 'active';
  } else if (a.type === 'summon') {
    let existing = room.enemies.filter(x => !x.dead && x.type !== 'BOSS').length;
    for (let i = 0; i < tel.count && existing < 36; i++, existing++) {
      const ang = tel.angle + (i * Math.PI * 2) / tel.count;
      const x = clamp(tel.x + Math.cos(ang) * tel.radius, 40, WORLD_SIZE - 40);
      const y = clamp(tel.y + Math.sin(ang) * tel.radius, 40, WORLD_SIZE - 40);
      room.enemies.push(createEnemy(room, Math.random() < 0.65 ? 'TRIANGLE' : 'CIRCLE', x, y));
    }
    pushEvent(room, { t: 'boom', x: r1(tel.x), y: r1(tel.y), r: tel.radius, col: e.color });
    pushEvent(room, { t: 'shake', m: 6 });
    endBossAttack(room, e, now, 800);
  }
}

function tickBossActive(room, e, dt, now, target) {
  const a = e.attack;
  const dm = bossDmgMul(room);
  if (!a) { e.mode = 'recover'; e.recoverUntil = now; return; }

  if (a.type === 'spiral') {
    const s = a.spiral;
    let guard = 0;
    while (now >= s.next && now < s.end && guard++ < 4) {
      for (let k = 0; k < s.arms; k++) fireEnemyBullet(room, e.x, e.y, s.ang + (k * Math.PI * 2) / s.arms, 150, 13 * dm, 4, 1);
      s.ang += 0.34;
      s.next += e.phase === 3 ? 70 : 90;
    }
    if (now >= s.end) endBossAttack(room, e, now, 800);
  } else if (a.type === 'charge') {
    const d = a.dash;
    const speed = 950 * (e.phase === 3 ? 1.1 : 1);
    e.x = clamp(e.x + Math.cos(d.angle) * speed * dt, e.size, WORLD_SIZE - e.size);
    e.y = clamp(e.y + Math.sin(d.angle) * speed * dt, e.size, WORLD_SIZE - e.size);
    for (const p of Object.values(room.players)) {
      if (p.dead || p.knocked || d.hit[p.id]) continue;
      if (Math.hypot(p.x - e.x, p.y - e.y) < e.size + 15) {
        d.hit[p.id] = true;
        hurtPlayer(room, p, 45 * dm, 500, now);
        pushEvent(room, { t: 'shake', m: 10 });
      }
    }
    if (now >= d.until) {
      if (e.phase === 3 && !a.second && target) {
        const aim = Math.atan2(target.y - e.y, target.x - e.x);
        const tel = newTel(room, e, now, 500, 'line', { angle: aim, length: 900, width: e.size * 2 + 10 });
        e.mode = 'windup';
        e.attack = { type: 'charge', tel, execAt: now + 500, second: true };
      } else {
        endBossAttack(room, e, now, 900);
      }
    }
  }
}

function updateBoss(room, e, dt, now, target) {
  const hpPct = e.hp / e.maxHp;
  const phase = hpPct > 0.66 ? 1 : hpPct > 0.33 ? 2 : 3;
  if (phase !== e.phase) { e.phase = phase; onBossPhase(room, e, now); }
  const speedMul = phase === 1 ? 1 : phase === 2 ? 1.2 : 1.45;

  if (e.mode === 'chase') {
    if (target) {
      const a = Math.atan2(target.y - e.y, target.x - e.x);
      e.x += Math.cos(a) * e.speed * speedMul * dt;
      e.y += Math.sin(a) * e.speed * speedMul * dt;
      if (now >= e.nextAttack) startBossAttack(room, e, now, target);
    }
  } else if (e.mode === 'windup') {
    if (now >= e.attack.execAt) execBossAttack(room, e, now);
  } else if (e.mode === 'active') {
    tickBossActive(room, e, dt, now, target);
  } else if (e.mode === 'recover') {
    if (now >= e.recoverUntil) e.mode = 'chase';
  }
  e.x = clamp(e.x, e.size, WORLD_SIZE - e.size);
  e.y = clamp(e.y, e.size, WORLD_SIZE - e.size);
}

// ---------------------------------------------------------------- wave flow
function offerCards(room, wasBoss) {
  room.state = 'CARD_SELECT';
  for (const p of Object.values(room.players)) {
    p.input.shoot = false;
    const cards = getRandomCards(p);
    p.offered = cards.map(c => c.id);
    p.hasPickedCard = cards.length === 0; // nothing left to offer, skip them
    if (cards.length) io.to(p.id).emit('showCards', { cards, wasBoss, upgrades: p.upgrades });
  }
  maybeResumeFromCards(room);
}

function maybeResumeFromCards(room) {
  if (room.state !== 'CARD_SELECT') return;
  const players = Object.values(room.players);
  if (players.length && players.every(p => p.hasPickedCard)) spawnWave(room);
}

function finishWave(room) {
  const wasBoss = room.wave % 5 === 0;
  room.bullets = [];
  room.enemyBullets = [];
  room.telegraphs = [];
  room.timers = [];
  if (wasBoss) applyBossBuffs(room);
  for (const p of Object.values(room.players)) {
    if (p.dead || p.knocked) {
      // everyone comes back between waves, so dying early is not a long wait
      p.dead = false;
      p.knocked = false;
      p.hp = Math.max(p.hp, p.maxHp * 0.5);
      p.deathTimer = 30;
      p.reviveProgress = 0;
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
    }
    p.hurtUntil = 0;
  }
  room.wave++;
  offerCards(room, wasBoss);
}

// ---------------------------------------------------------------- snapshots
function sendSnapshot(room, now) {
  const players = {};
  for (const p of Object.values(room.players)) {
    players[p.id] = {
      id: p.id, name: p.name, x: r1(p.x), y: r1(p.y), angle: Math.round(p.angle * 100) / 100,
      hp: Math.ceil(p.hp), maxHp: Math.ceil(p.maxHp), knocked: p.knocked, dead: p.dead,
      deathTimer: Math.ceil(p.deathTimer), reviveProgress: Math.round(p.reviveProgress),
      sprint: Math.round(p.sprint), maxSprint: Math.round(p.maxSprint),
      upgrades: p.upgrades, kills: p.kills, damage: Math.round(p.damage), revives: p.revives
    };
  }
  let boss = null;
  const enemies = room.enemies.map(e => {
    if (e.type === 'BOSS') boss = { id: e.id, name: e.name, color: e.color, phase: e.phase, hp: Math.ceil(e.hp), maxHp: Math.ceil(e.maxHp) };
    return { id: e.id, type: e.type, x: r1(e.x), y: r1(e.y), hp: Math.ceil(e.hp), maxHp: Math.ceil(e.maxHp), size: e.size };
  });
  const snap = {
    players,
    enemies,
    boss,
    bullets: room.bullets.map(b => [r1(b.x), r1(b.y), Math.round(b.vx), Math.round(b.vy), b.crit ? 1 : 0]),
    enemyBullets: room.enemyBullets.map(b => [r1(b.x), r1(b.y), Math.round(b.vx), Math.round(b.vy), b.k]),
    telegraphs: room.telegraphs.map(t => ({
      id: t.id, kind: t.kind, x: r1(t.x), y: r1(t.y), angle: Math.round(t.angle * 100) / 100,
      radius: t.radius, length: t.length, width: t.width, count: t.count, spread: t.spread,
      p: Math.round(clamp((now - t.start) / (t.exec - t.start), 0, 1) * 100) / 100
    })),
    ev: room.events
  };
  room.events = [];
  io.to(room.id).emit('gameState', snap);
}

// ---------------------------------------------------------------- main tick
function tickRoom(room, dt, now) {
  const players = Object.values(room.players);
  if (players.length === 0) return;

  for (let i = room.timers.length - 1; i >= 0; i--) {
    if (i < room.timers.length && now >= room.timers[i].at) {
      const t = room.timers.splice(i, 1)[0];
      t.fn();
    }
  }

  // --- players
  for (const p of players) {
    if (p.dead) continue;
    if (p.knocked) {
      p.deathTimer -= dt;
      p.reviveProgress = Math.max(0, p.reviveProgress - 10 * dt);
      if (p.deathTimer <= 0) { p.dead = true; p.reviveProgress = 0; }
      continue;
    }
    const inp = p.input;
    p.angle = inp.angle;
    const len = Math.hypot(inp.dx, inp.dy);
    let speed = p.stats.spd;
    if (inp.sprint && p.sprint > 0 && len > 0) {
      speed = p.stats.sprintspd;
      p.sprint = Math.max(0, p.sprint - 36 * dt);
    } else if (p.sprint < p.maxSprint) {
      p.sprint = Math.min(p.maxSprint, p.sprint + 18 * dt);
    }
    if (len > 0) {
      p.x += (inp.dx / len) * speed * dt;
      p.y += (inp.dy / len) * speed * dt;
    }
    p.x = clamp(p.x, 20, WORLD_SIZE - 20);
    p.y = clamp(p.y, 20, WORLD_SIZE - 20);
    pushOut(room, p, 15);
    p.x = clamp(p.x, 20, WORLD_SIZE - 20);
    p.y = clamp(p.y, 20, WORLD_SIZE - 20);

    if (p.hp < p.maxHp && p.stats.regen > 0) p.hp = Math.min(p.maxHp, p.hp + p.stats.regen * dt);

    if (inp.shoot && now - p.lastShot >= p.stats.firerate && room.bullets.length < 500) {
      p.lastShot = now;
      const n = p.stats.multishot;
      // spread shrinks as the projectile count grows so extra shots stay useful at range
      const step = n > 1 ? Math.min(0.28, 0.9 / (n - 1)) : 0;
      const spd = p.stats.bulletspeed;
      const life = BULLET_RANGE / spd;
      for (let i = 0; i < n; i++) {
        const a = p.angle + (i - (n - 1) / 2) * step;
        const crit = Math.random() < p.stats.crit;
        room.bullets.push({
          x: p.x, y: p.y, px: p.x, py: p.y,
          vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
          dmg: Math.round(p.stats.dmg * (crit ? 2 : 1)), crit,
          pierce: p.stats.pierce, owner: p.id, life, hit: []
        });
      }
    }
  }

  // everyone dead = game over (a dead player used to stay "knocked", so this never fired)
  if (players.every(p => p.dead)) {
    room.state = 'GAME_OVER';
    io.to(room.id).emit('gameOver', {
      wave: room.wave,
      stats: players.map(p => ({ name: p.name, kills: p.kills, damage: Math.round(p.damage), revives: p.revives }))
    });
    return;
  }

  const alive = players.filter(p => !p.dead && !p.knocked);

  // --- revives
  for (const rescuer of alive) {
    if (!rescuer.input.revive) continue;
    for (const downed of players) {
      if (downed.knocked && !downed.dead && Math.hypot(rescuer.x - downed.x, rescuer.y - downed.y) < 90) {
        downed.reviveProgress += 50 * dt * rescuer.stats.revivespd;
        if (downed.reviveProgress >= 100) {
          downed.knocked = false;
          downed.hp = downed.maxHp * 0.4;
          downed.deathTimer = 30;
          downed.reviveProgress = 0;
          downed.hurtUntil = now + 1500;
          rescuer.revives++;
        }
      }
    }
  }

  // --- player bullets
  for (const b of room.bullets) {
    b.px = b.x; b.py = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD_SIZE || b.y > WORLD_SIZE || insideObstacle(room, b.x, b.y)) b.dead = true;
  }

  // --- enemy bullets
  for (const eb of room.enemyBullets) {
    eb.x += eb.vx * dt; eb.y += eb.vy * dt; eb.life -= dt;
    if (eb.life <= 0 || eb.x < 0 || eb.y < 0 || eb.x > WORLD_SIZE || eb.y > WORLD_SIZE || insideObstacle(room, eb.x, eb.y)) { eb.dead = true; continue; }
    for (const p of alive) {
      if (p.knocked || p.dead) continue;
      if (Math.hypot(p.x - eb.x, p.y - eb.y) < 20) {
        hurtPlayer(room, p, eb.dmg, 120, now);
        eb.dead = true;
        break;
      }
    }
  }

  // --- enemies
  const dm = bossDmgMul(room);
  for (const e of room.enemies) {
    if (e.dead) continue;
    let target = null, minDist = Infinity;
    for (const p of alive) {
      if (p.knocked || p.dead) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < minDist) { minDist = d; target = p; }
    }

    if (e.type === 'BOSS') {
      updateBoss(room, e, dt, now, target);
    } else if (target) {
      const angle = Math.atan2(target.y - e.y, target.x - e.x);
      if (e.type === 'PENTAGON') {
        if (minDist > 250) {
          e.x += Math.cos(angle) * e.speed * dt;
          e.y += Math.sin(angle) * e.speed * dt;
        }
        if (now - e.lastShot > 2000) {
          e.lastShot = now;
          fireEnemyBullet(room, e.x, e.y, angle, 140, 15, 3, 0);
        }
      } else {
        e.x += Math.cos(angle) * e.speed * dt;
        e.y += Math.sin(angle) * e.speed * dt;
      }
      pushOut(room, e, e.size * 0.85);
      e.x = clamp(e.x, e.size, WORLD_SIZE - e.size);
      e.y = clamp(e.y, e.size, WORLD_SIZE - e.size);
    }

    // contact damage, with a short invulnerability window so packs can't delete a player in one tick
    if (target && minDist < e.size + 15) {
      const hit = hurtPlayer(room, target, e.type === 'BOSS' ? 35 * dm : 14, 450, now);
      if (hit && e.type !== 'BOSS') {
        const a = Math.atan2(target.y - e.y, target.x - e.x);
        e.x -= Math.cos(a) * 24;
        e.y -= Math.sin(a) * 24;
      }
    }
  }

  // --- push enemies apart so they don't stack into one blob
  const en = room.enemies;
  if (en.length < 160) {
    for (let i = 0; i < en.length; i++) {
      const a = en[i];
      if (a.dead || a.type === 'BOSS') continue;
      for (let j = i + 1; j < en.length; j++) {
        const b = en[j];
        if (b.dead || b.type === 'BOSS') continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = (a.size + b.size) * 0.8;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = ((min - d) / 2) * 0.4;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }
  }

  // --- bullets vs enemies (swept, so fast bullets can't skip small enemies)
  for (const e of room.enemies) {
    if (e.dead) continue;
    const rad = e.size + 6;
    for (const b of room.bullets) {
      if (b.dead) continue;
      if (b.hit.indexOf(e.id) !== -1) continue; // pierced bullets only hit an enemy once
      if (!segCircle(b.px, b.py, b.x, b.y, e.x, e.y, rad)) continue;

      e.hp -= b.dmg;
      const owner = room.players[b.owner];
      if (owner) {
        owner.damage += b.dmg;
        if (e.type !== 'BOSS') {
          e.x += b.vx * 0.0075 * owner.stats.knockback;
          e.y += b.vy * 0.0075 * owner.stats.knockback;
        }
      }
      pushEvent(room, { t: 'd', x: r1(e.x), y: r1(e.y), v: b.dmg, c: b.crit ? 1 : 0, id: e.id });

      if (b.pierce > 0) { b.pierce--; b.hit.push(e.id); }
      else b.dead = true;

      if (e.hp <= 0) { killEnemy(room, e, owner); break; }
    }
  }

  room.enemies = room.enemies.filter(e => !e.dead);
  room.bullets = room.bullets.filter(b => !b.dead);
  room.enemyBullets = room.enemyBullets.filter(b => !b.dead);

  // --- snapshot
  room.snapAcc += dt;
  const cleared = room.enemies.length === 0;
  if (room.snapAcc >= SNAP_INTERVAL || cleared) {
    room.snapAcc = 0;
    sendSnapshot(room, now);
  }

  if (cleared) finishWave(room);
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const id in rooms) {
    const room = rooms[id];
    if (room.state !== 'PLAYING') continue;
    try { tickRoom(room, dt, now); } catch (err) { console.error('tick error', err); }
  }
}, 1000 / TICK_RATE);

// ---------------------------------------------------------------- sockets
const lobbyList = (room) => Object.values(room.players).map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));

io.on('connection', (socket) => {
  socket.on('joinRoom', (data) => {
    if (socket.data.roomId) return;
    data = data || {};
    let roomId = String(data.roomId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!roomId) roomId = rid().toUpperCase().slice(0, 4);

    let room = rooms[roomId];
    if (room) {
      if (room.state !== 'LOBBY' && room.state !== 'GAME_OVER') return socket.emit('joinError', 'That game is already in progress.');
      if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('joinError', 'That room is full.');
    } else {
      room = rooms[roomId] = {
        id: roomId, state: 'LOBBY', wave: 0,
        players: {}, enemies: [], bullets: [], enemyBullets: [],
        telegraphs: [], timers: [], events: [], snapAcc: 0,
        map: [], host: socket.id
      };
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    room.players[socket.id] = initPlayer(socket.id, cleanName(data.username), room.host === socket.id);
    socket.emit('joined', { roomId, id: socket.id });
    io.to(roomId).emit('updateLobby', lobbyList(room));
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id) return;
    if (room.state !== 'LOBBY' && room.state !== 'GAME_OVER') return;

    room.map = generateMap();
    room.wave = START_WAVE;
    room.enemies = [];
    room.bullets = [];
    room.enemyBullets = [];
    room.telegraphs = [];
    room.timers = [];
    room.events = [];
    room.snapAcc = 0;
    Object.values(room.players).forEach(p => {
      Object.assign(p, initPlayer(p.id, p.name, p.isHost));
    });
    io.to(room.id).emit('gameStarted', { map: room.map, worldSize: WORLD_SIZE });
    spawnWave(room);
  });

  socket.on('playerInput', (d) => {
    const room = rooms[socket.data.roomId];
    if (!room || !d) return;
    const p = room.players[socket.id];
    if (!p) return;
    const i = p.input;
    i.dx = axis(d.dx);
    i.dy = axis(d.dy);
    i.angle = num(d.angle);
    i.shoot = !!d.isShooting;
    i.sprint = !!d.isSprinting;
    i.revive = !!d.isReviving;
  });

  socket.on('selectCard', (d) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'CARD_SELECT' || !d) return;
    const p = room.players[socket.id];
    if (!p || p.hasPickedCard) return;
    const cardId = String(d.cardId || '');
    if (!p.offered.includes(cardId)) return;
    if ((p.upgrades[cardId] || 0) >= 5) return;

    p.upgrades[cardId] = (p.upgrades[cardId] || 0) + 1;
    applyUpgrade(p, cardId);
    p.hasPickedCard = true;
    p.offered = [];
    maybeResumeFromCards(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const wasHost = room.host === socket.id;
    delete room.players[socket.id];
    const ids = Object.keys(room.players);
    if (ids.length === 0) { delete rooms[room.id]; return; }
    if (wasHost) {
      room.host = ids[0];
      room.players[ids[0]].isHost = true;
    }
    io.to(room.id).emit('updateLobby', lobbyList(room));
    // if the player we were waiting on left, don't leave the room stuck on the card screen
    maybeResumeFromCards(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shape Siege running on port ${PORT}`));
