(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io();

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  const QUALITY = [{ name: 'Low', s: 0.6 }, { name: 'Medium', s: 0.8 }, { name: 'High', s: 1 }];

  const SS = window.SS = {
    socket, QUALITY,
    myId: null, roomId: null, isHost: false,
    inGame: false, blocking: true,
    worldSize: 3000, obstacles: [], snaps: [],
    mouse: { x: innerWidth / 2, y: innerHeight / 2, down: false },
    spectatingId: null,
    quality: 2, showFps: false, muted: store.get('ss_mute', '0') === '1',
    fx: { particles: [], rings: [], nums: [], flash: {}, shake: 0 },
    bossColor: '#A855F7',
    fps: 0
  };
  { const q = parseInt(store.get('ss_q', '2'), 10); SS.quality = q >= 0 && q <= 2 ? q : 2; }

  // ------------------------------------------------------------ card info
  const CARD_CAT = {
    hp: 'def', armor: 'def', regen: 'def', lifesteal: 'def',
    dmg: 'off', firerate: 'off', bulletspeed: 'off', pierce: 'off', multishot: 'off', crit: 'off', knockback: 'off',
    spd: 'utl', sprintspd: 'utl', sprintdur: 'utl', revive: 'utl'
  };
  const CARD_NAME = {
    hp: 'Vitality', spd: 'Agility', dmg: 'Brute Force', firerate: 'Trigger Happy', bulletspeed: 'Velocity',
    regen: 'Cellular Regen', sprintspd: 'Track Star', sprintdur: 'Marathon', revive: 'Combat Medic',
    pierce: 'Piercing', multishot: 'Spread', lifesteal: 'Vampirism', knockback: 'Repel', armor: 'Plating', crit: 'Lethality'
  };
  const CAT_NAME = { off: 'OFFENSE', def: 'DEFENSE', utl: 'UTILITY' };

  const mk = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // ------------------------------------------------------------ audio (tiny synth, no files)
  let actx = null;
  const lastSfx = {};
  const SFX_GAP = { shoot: 120, hit: 45, kill: 45, hurt: 150, boom: 100, pick: 0, warn: 400 };
  function initAudio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  function beep(freq, dur, type, vol, slide) {
    if (!actx || SS.muted) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function sfx(name) {
    if (!actx || SS.muted) return;
    const now = performance.now();
    if (now - (lastSfx[name] || 0) < (SFX_GAP[name] || 0)) return;
    lastSfx[name] = now;
    switch (name) {
      case 'shoot': beep(520, 0.05, 'square', 0.012, -220); break;
      case 'hit': beep(240, 0.05, 'triangle', 0.03); break;
      case 'kill': beep(190, 0.11, 'sawtooth', 0.035, -110); break;
      case 'hurt': beep(130, 0.2, 'sawtooth', 0.07, -70); break;
      case 'boom': beep(80, 0.35, 'sawtooth', 0.09, -40); break;
      case 'pick': beep(600, 0.09, 'sine', 0.06); setTimeout(() => beep(900, 0.12, 'sine', 0.06), 80); break;
      case 'warn': beep(110, 0.5, 'sawtooth', 0.08, 60); setTimeout(() => beep(110, 0.5, 'sawtooth', 0.08, 60), 350); break;
    }
  }
  SS.sfx = sfx;

  // ------------------------------------------------------------ ui helpers
  const overlays = ['menu', 'lobby', 'cardOverlay', 'gameOver'];
  function refreshBlocking() {
    SS.blocking = overlays.some(id => !$(id).classList.contains('hidden'));
  }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  function banner(main, sub, boss) {
    const b = $('banner');
    $('bannerMain').textContent = main;
    $('bannerSub').textContent = sub || '';
    b.classList.remove('show', 'boss');
    void b.offsetWidth;
    if (boss) b.classList.add('boss');
    b.classList.add('show');
  }

  const hurtEl = $('hurt');
  let lowHp = false;
  function applyLow() {
    if (hurtEl.classList.contains('flash')) return;
    hurtEl.classList.toggle('low', lowHp);
  }
  function flashHurt() {
    hurtEl.classList.remove('low', 'flash');
    void hurtEl.offsetWidth;
    hurtEl.classList.add('flash');
  }
  hurtEl.addEventListener('animationend', (e) => {
    if (e.animationName === 'hurtflash') { hurtEl.classList.remove('flash'); applyLow(); }
  });

  // ------------------------------------------------------------ menu / lobby
  function joinRoom() {
    initAudio();
    const name = $('username').value.trim() || 'Player';
    const code = $('roomCode').value.trim().toUpperCase();
    $('menuError').textContent = '';
    socket.emit('joinRoom', { roomId: code, username: name });
  }
  $('joinBtn').addEventListener('click', joinRoom);
  $('roomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('startBtn').addEventListener('click', () => socket.emit('startGame'));
  $('playAgainBtn').addEventListener('click', () => socket.emit('startGame'));

  socket.on('joinError', (msg) => { $('menuError').textContent = msg; });

  socket.on('joined', (d) => {
    SS.myId = d.id;
    SS.roomId = d.roomId;
    $('displayRoom').textContent = d.roomId;
    hide('menu'); show('lobby');
    refreshBlocking();
  });

  socket.on('updateLobby', (players) => {
    const me = players.find(p => p.id === SS.myId);
    if (me) SS.isHost = me.isHost;
    const box = $('lobbyPlayers');
    box.textContent = '';
    players.forEach(p => box.appendChild(mk('div', '', (p.isHost ? '\u{1F451} ' : '\u{1F464} ') + p.name)));
    $('startBtn').classList.toggle('hidden', !SS.isHost);
    $('lobbyWait').classList.toggle('hidden', SS.isHost);
    $('playAgainBtn').classList.toggle('hidden', !SS.isHost);
    $('goWait').classList.toggle('hidden', SS.isHost);
  });

  socket.on('gameStarted', (d) => {
    SS.obstacles = d.map;
    SS.worldSize = d.worldSize;
    SS.snaps.length = 0;
    SS.fx.particles.length = 0; SS.fx.rings.length = 0; SS.fx.nums.length = 0; SS.fx.flash = {}; SS.fx.shake = 0;
    SS.spectatingId = null;
    lastSent.t = 0;
    buildMiniBase();
    hide('lobby'); hide('gameOver'); hide('cardOverlay');
    show('hud');
    SS.inGame = true;
    refreshBlocking();
  });

  socket.on('waveStart', (d) => {
    hide('cardOverlay');
    refreshBlocking();
    $('waveNum').textContent = d.wave;
    $('waveBox').classList.toggle('boss', !!d.boss);
    if (d.boss) { banner('BOSS WAVE', d.boss, true); sfx('warn'); }
    else banner('WAVE ' + d.wave, '', false);
  });

  // ------------------------------------------------------------ cards
  let currentCards = [];
  socket.on('showCards', (d) => {
    currentCards = d.cards;
    const box = $('cardsBox');
    box.textContent = '';
    $('upgradeTitle').textContent = d.wasBoss ? 'BOSS DEFEATED! TEAM BUFFED + CHOOSE AN UPGRADE' : 'CHOOSE AN UPGRADE';
    d.cards.forEach((c, i) => {
      const cat = CARD_CAT[c.id] || 'utl';
      const tier = (d.upgrades && d.upgrades[c.id]) || 0;
      const el = mk('div', 'card ' + cat);
      el.appendChild(mk('span', 'key', String(i + 1)));
      el.appendChild(mk('div', 'cat', CAT_NAME[cat]));
      el.appendChild(mk('div', 'title', c.name));
      el.appendChild(mk('div', 'desc', c.desc));
      const pips = mk('div', 'pips');
      for (let k = 0; k < 5; k++) pips.appendChild(mk('i', k < tier ? 'on' : k === tier ? 'next' : ''));
      el.appendChild(pips);
      el.addEventListener('click', () => pickCard(c.id));
      box.appendChild(el);
    });
    $('cardsBox').classList.remove('hidden');
    $('cardWait').classList.add('hidden');
    show('cardOverlay');
    refreshBlocking();
  });

  function pickCard(id) {
    if (!currentCards.length) return;
    currentCards = [];
    socket.emit('selectCard', { cardId: id });
    sfx('pick');
    $('cardsBox').classList.add('hidden');
    $('cardWait').classList.remove('hidden');
  }

  // ------------------------------------------------------------ game over
  socket.on('gameOver', (d) => {
    SS.inGame = true; // keep state, renderer is paused by the overlay
    $('finalWave').textContent = d.wave;
    const best = Math.max(d.wave, parseInt(store.get('ss_best', '0'), 10) || 0);
    store.set('ss_best', String(best));
    $('bestWave').textContent = '(best: ' + best + ')';
    const t = $('statsTable');
    t.textContent = '';
    const head = mk('tr');
    ['Player', 'Kills', 'Damage', 'Revives'].forEach(h => head.appendChild(mk('th', '', h)));
    t.appendChild(head);
    d.stats.forEach(s => {
      const r = mk('tr');
      r.appendChild(mk('td', '', s.name));
      r.appendChild(mk('td', '', String(s.kills)));
      r.appendChild(mk('td', '', String(s.damage)));
      r.appendChild(mk('td', '', String(s.revives)));
      t.appendChild(r);
    });
    show('gameOver');
    refreshBlocking();
  });

  // ------------------------------------------------------------ snapshots + effects
  const FX = SS.fx;
  const BURST_COLOR = { TRIANGLE: '#EF4444', PENTAGON: '#10B981', CIRCLE: '#EC4899', HEXAGON: '#F59E0B', BOSS: '#A855F7' };

  function burst(x, y, size, type) {
    const col = type === 'BOSS' ? SS.bossColor : (BURST_COLOR[type] || '#fff');
    const n = type === 'BOSS' ? 40 : Math.min(12, 5 + ((size / 5) | 0));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * (type === 'BOSS' ? 380 : 200);
      FX.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + Math.random() * 0.3, max: 0.65, size: 2 + Math.random() * 3, col });
    }
    while (FX.particles.length > 180) FX.particles.shift();
  }

  function handleEvents(evs) {
    if (!evs) return;
    const now = performance.now();
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      switch (ev.t) {
        case 'd':
          FX.nums.push({ x: ev.x + (Math.random() * 20 - 10), y: ev.y - 10, v: ev.v, c: ev.c, life: 1 });
          if (FX.nums.length > 30) FX.nums.shift();
          FX.flash[ev.id] = now + 90;
          sfx('hit');
          break;
        case 'k': burst(ev.x, ev.y, ev.s, ev.ty); sfx('kill'); if (ev.ty === 'BOSS') FX.shake = Math.max(FX.shake, 22); break;
        case 'h':
          if (ev.id === SS.myId) { flashHurt(); sfx('hurt'); FX.shake = Math.max(FX.shake, 6); }
          break;
        case 'boom': FX.rings.push({ x: ev.x, y: ev.y, r: ev.r, life: 0.5, max: 0.5, col: ev.col || '#fff' }); sfx('boom'); break;
        case 'shake': FX.shake = Math.max(FX.shake, Math.min(24, ev.m)); break;
        case 'phase': banner('PHASE ' + ev.n, ev.name, true); sfx('warn'); break;
      }
    }
  }

  let hudTick = 0;
  socket.on('gameState', (d) => {
    d.rt = performance.now();
    d.emap = new Map();
    for (let i = 0; i < d.enemies.length; i++) d.emap.set(d.enemies[i].id, d.enemies[i]);
    SS.snaps.push(d);
    if (SS.snaps.length > 6) SS.snaps.shift();
    if (d.boss) SS.bossColor = d.boss.color;
    handleEvents(d.ev);
    updateHud(d, (hudTick++ & 1) === 0);
  });

  // ------------------------------------------------------------ HUD
  const teamEls = {};
  function updateTeam(players) {
    const root = $('team');
    for (const id in teamEls) {
      if (!players[id]) { teamEls[id].root.remove(); delete teamEls[id]; }
    }
    for (const id in players) {
      const p = players[id];
      let t = teamEls[id];
      if (!t) {
        const rootEl = mk('div', 'tm' + (id === SS.myId ? ' me' : ''));
        const top = mk('div', 'tm-top');
        const name = mk('span', '', p.name);
        const status = mk('span', 'tm-status', '');
        top.appendChild(name); top.appendChild(status);
        const bar = mk('div', 'bar');
        const fill = mk('i');
        bar.appendChild(fill);
        const rev = mk('div', 'revive');
        const revFill = mk('i');
        rev.appendChild(revFill);
        rootEl.appendChild(top); rootEl.appendChild(bar); rootEl.appendChild(rev);
        root.appendChild(rootEl);
        t = teamEls[id] = { root: rootEl, status, fill, rev, revFill, hp: -1, st: '', rp: -1, down: null };
      }
      const hpPct = Math.max(0, p.hp / p.maxHp);
      if (t.hp !== p.hp) { t.fill.style.transform = 'scaleX(' + hpPct.toFixed(3) + ')'; t.hp = p.hp; }
      const st = p.dead ? 'DEAD' : p.knocked ? 'DOWNED ' + p.deathTimer + 's' : '';
      if (t.st !== st) { t.status.textContent = st; t.st = st; }
      const down = p.knocked || p.dead;
      if (t.down !== down) { t.root.classList.toggle('down', down); t.down = down; }
      const rp = p.knocked ? p.reviveProgress : 0;
      if (t.rp !== rp) {
        t.rev.style.display = rp > 0 ? 'block' : 'none';
        t.revFill.style.transform = 'scaleX(' + (rp / 100) + ')';
        t.rp = rp;
      }
    }
  }

  let chipSig = '';
  function updateChips(upg) {
    const sig = JSON.stringify(upg);
    if (sig === chipSig) return;
    chipSig = sig;
    const box = $('chips');
    box.textContent = '';
    Object.keys(upg).forEach(id => {
      if (!upg[id]) return;
      box.appendChild(mk('span', 'chip ' + (CARD_CAT[id] || 'utl'), (CARD_NAME[id] || id) + ' ' + upg[id]));
    });
  }

  let lastBossName = '';
  function updateBoss(boss) {
    const bar = $('bossBar');
    if (!boss) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.style.setProperty('--boss', boss.color);
    if (lastBossName !== boss.name) { $('bossName').textContent = boss.name; lastBossName = boss.name; }
    $('bossPhase').textContent = 'PHASE ' + boss.phase + ' / 3';
    const s = 'scaleX(' + Math.max(0, boss.hp / boss.maxHp).toFixed(4) + ')';
    $('bossFill').style.transform = s;
    $('bossTrail').style.transform = s;
  }

  function updateHud(d, full) {
    updateBoss(d.boss);
    const me = d.players[SS.myId];
    if (!me) return;

    if (full) {
      updateTeam(d.players);
      $('enemyCount').textContent = d.enemies.length;
      let kills = 0;
      for (const id in d.players) kills += d.players[id].kills;
      $('killCount').textContent = kills;

      $('selfHp').style.transform = 'scaleX(' + Math.max(0, me.hp / me.maxHp).toFixed(3) + ')';
      $('selfHpText').textContent = me.hp + ' / ' + me.maxHp;
      $('selfSp').style.transform = 'scaleX(' + Math.max(0, me.sprint / me.maxSprint).toFixed(3) + ')';
      updateChips(me.upgrades || {});

      const nowLow = !me.dead && !me.knocked && me.hp / me.maxHp < 0.3;
      if (nowLow !== lowHp) { lowHp = nowLow; applyLow(); }

      // spectate
      const spec = $('spectateUI');
      if (me.dead) {
        spec.classList.remove('hidden');
        const sp = d.players[SS.spectatingId];
        if (!sp || sp.dead) cycleSpectate(1, d);
        const cur = d.players[SS.spectatingId];
        $('specName').textContent = cur ? 'Spectating: ' + cur.name : 'Spectating';
      } else {
        spec.classList.add('hidden');
        SS.spectatingId = SS.myId;
      }

      // revive prompt
      const prompt = $('prompt');
      let msg = '';
      if (me.knocked) msg = 'YOU ARE DOWN (' + me.deathTimer + 's). A teammate can revive you.';
      else if (me.dead) msg = '';
      else {
        for (const id in d.players) {
          const o = d.players[id];
          if (o.knocked && !o.dead && Math.hypot(o.x - me.x, o.y - me.y) < 110) { msg = 'HOLD [E] TO REVIVE ' + o.name; break; }
        }
      }
      if (msg) { prompt.textContent = msg; prompt.classList.remove('hidden'); }
      else prompt.classList.add('hidden');

      drawMini(d);
    }
  }

  function cycleSpectate(dir, snap) {
    const d = snap || SS.snaps[SS.snaps.length - 1];
    if (!d) return;
    const alive = Object.values(d.players).filter(p => !p.dead);
    if (alive.length === 0) return;
    let idx = alive.findIndex(p => p.id === SS.spectatingId);
    idx = (idx + dir + alive.length) % alive.length;
    SS.spectatingId = alive[idx].id;
  }
  $('specPrev').addEventListener('click', () => cycleSpectate(-1));
  $('specNext').addEventListener('click', () => cycleSpectate(1));

  // ------------------------------------------------------------ minimap (offscreen base + 10 Hz dots)
  const mini = $('minimap');
  const mCtx = mini.getContext('2d');
  const miniBase = document.createElement('canvas');
  miniBase.width = mini.width; miniBase.height = mini.height;
  function buildMiniBase() {
    const c = miniBase.getContext('2d');
    c.clearRect(0, 0, miniBase.width, miniBase.height);
    const s = miniBase.width / SS.worldSize;
    c.fillStyle = 'rgba(56,189,248,0.22)';
    SS.obstacles.forEach(o => c.fillRect(o.x * s, o.y * s, Math.max(1, o.w * s), Math.max(1, o.h * s)));
  }
  function drawMini(d) {
    const s = mini.width / SS.worldSize;
    mCtx.clearRect(0, 0, mini.width, mini.height);
    mCtx.drawImage(miniBase, 0, 0);
    for (let i = 0; i < d.enemies.length; i++) {
      const e = d.enemies[i];
      if (e.type === 'BOSS') {
        mCtx.fillStyle = d.boss ? d.boss.color : '#A855F7';
        mCtx.beginPath(); mCtx.arc(e.x * s, e.y * s, 5, 0, Math.PI * 2); mCtx.fill();
      } else {
        mCtx.fillStyle = '#EF4444';
        mCtx.fillRect(e.x * s - 1, e.y * s - 1, 2, 2);
      }
    }
    for (const id in d.players) {
      const p = d.players[id];
      if (p.dead) continue;
      mCtx.fillStyle = p.knocked ? '#F87171' : id === SS.myId ? '#FFFFFF' : '#10B981';
      mCtx.beginPath(); mCtx.arc(p.x * s, p.y * s, 3, 0, Math.PI * 2); mCtx.fill();
    }
  }

  // ------------------------------------------------------------ input
  const keys = { up: false, down: false, left: false, right: false, sprint: false, revive: false };
  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyE: 'revive'
  };
  const typing = () => { const a = document.activeElement; return a && a.tagName === 'INPUT'; };

  function setQuality(q) {
    SS.quality = q;
    store.set('ss_q', String(q));
    if (SS.resize) SS.resize();
  }

  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    const k = KEYMAP[e.code];
    if (k) { keys[k] = true; if (e.code.startsWith('Arrow')) e.preventDefault(); return; }
    if (e.repeat) return;
    if (e.code === 'KeyQ') setQuality((SS.quality + 1) % 3);
    else if (e.code === 'KeyF') SS.showFps = !SS.showFps;
    else if (e.code === 'KeyM') { SS.muted = !SS.muted; store.set('ss_mute', SS.muted ? '1' : '0'); initAudio(); }
    else if (e.code >= 'Digit1' && e.code <= 'Digit3') {
      const i = parseInt(e.code.slice(5), 10) - 1;
      if (currentCards[i]) pickCard(currentCards[i].id);
    }
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
  window.addEventListener('mousemove', (e) => { SS.mouse.x = e.clientX; SS.mouse.y = e.clientY; });
  window.addEventListener('mousedown', (e) => { if (e.button === 0) { SS.mouse.down = true; initAudio(); } });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) SS.mouse.down = false; });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    SS.mouse.down = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // only send when something changed; the server keeps the last input and moves players itself
  const lastSent = { dx: 0, dy: 0, shoot: false, sprint: false, revive: false, angle: 0, t: 0 };
  let lastShootSfx = 0;
  setInterval(() => {
    if (!SS.inGame || SS.blocking) return;
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const angle = Math.atan2(SS.mouse.y - innerHeight / 2, SS.mouse.x - innerWidth / 2);
    const shoot = SS.mouse.down, sprint = keys.sprint, revive = keys.revive;
    const now = performance.now();
    if (dx !== lastSent.dx || dy !== lastSent.dy || shoot !== lastSent.shoot || sprint !== lastSent.sprint ||
        revive !== lastSent.revive || Math.abs(angle - lastSent.angle) > 0.01 || now - lastSent.t > 1000) {
      socket.emit('playerInput', { dx, dy, angle, isShooting: shoot, isSprinting: sprint, isReviving: revive });
      lastSent.dx = dx; lastSent.dy = dy; lastSent.shoot = shoot; lastSent.sprint = sprint; lastSent.revive = revive;
      lastSent.angle = angle; lastSent.t = now;
    }
    if (shoot && now - lastShootSfx > 140) { lastShootSfx = now; sfx('shoot'); }
  }, 1000 / 30);

  // used by the renderer
  SS.lowHp = () => lowHp;
})();
