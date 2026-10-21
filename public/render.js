(() => {
  'use strict';
  const SS = window.SS;
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const perfEl = document.getElementById('perf');
  const FPS_CAP = [30, 45, 60];
  const INTERP_MS = 90;
  const TAU = Math.PI * 2;

  let scale = 1;
  SS.resize = () => {
    scale = SS.QUALITY[SS.quality].s;
    canvas.width = Math.max(320, Math.round(innerWidth * scale));
    canvas.height = Math.max(240, Math.round(innerHeight * scale));
    perfUntil = performance.now() + 2500;
  };
  let perfUntil = 0;
  window.addEventListener('resize', SS.resize);
  SS.resize();
  perfUntil = 0;

  const FX = SS.fx;
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return a + d * t; };

  // ---- pick the snapshot pair that brackets (now - delay)
  function bracket(rt) {
    const s = SS.snaps;
    if (s.length === 0) return null;
    if (s.length === 1 || rt <= s[0].rt) return { a: s[0], b: s[0], t: 0 };
    for (let i = 0; i < s.length - 1; i++) {
      if (rt >= s[i].rt && rt < s[i + 1].rt) return { a: s[i], b: s[i + 1], t: (rt - s[i].rt) / (s[i + 1].rt - s[i].rt) };
    }
    const l = s[s.length - 1];
    return { a: l, b: l, t: 0 };
  }

  function playerPos(a, b, t, id) {
    const pa = a.players[id];
    const pb = b.players[id];
    if (!pa) return null;
    if (!pb) return { x: pa.x, y: pa.y, angle: pa.angle };
    return { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), angle: lerpAngle(pa.angle, pb.angle, t) };
  }

  let shakeX = 0, shakeY = 0;
  let lastFrame = performance.now();
  let fpsAcc = 0, fpsCount = 0;
  let gridPath = null;

  function poly(sides, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i * TAU) / sides;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawTelegraph(t, camX, camY) {
    const p = t.p;
    const x = t.x - camX, y = t.y - camY;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(239,68,68,0.95)';
    ctx.fillStyle = 'rgba(239,68,68,' + (0.08 + 0.2 * p).toFixed(3) + ')';
    if (t.kind === 'circle') {
      ctx.beginPath(); ctx.arc(0, 0, t.radius, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(239,68,68,0.35)';
      ctx.beginPath(); ctx.arc(0, 0, t.radius * p, 0, TAU); ctx.fill();
    } else if (t.kind === 'pulse') {
      ctx.beginPath(); ctx.arc(0, 0, t.radius * (0.6 + 0.4 * p), 0, TAU); ctx.fill(); ctx.stroke();
    } else if (t.kind === 'ring') {
      ctx.beginPath(); ctx.arc(0, 0, 50 + (t.radius - 50) * p, 0, TAU); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < t.count; i++) {
        const a = t.angle + (i * TAU) / t.count;
        ctx.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
        ctx.lineTo(Math.cos(a) * t.radius, Math.sin(a) * t.radius);
      }
      ctx.globalAlpha = 0.25 + 0.55 * p;
      ctx.stroke();
    } else if (t.kind === 'fan') {
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.2 + 0.6 * p;
      ctx.beginPath();
      for (let i = 0; i < t.count; i++) {
        const a = t.angle + (i - (t.count - 1) / 2) * t.spread;
        ctx.moveTo(Math.cos(a) * 60, Math.sin(a) * 60);
        ctx.lineTo(Math.cos(a) * t.radius, Math.sin(a) * t.radius);
      }
      ctx.stroke();
    } else if (t.kind === 'line') {
      ctx.rotate(t.angle);
      ctx.fillRect(0, -t.width / 2, t.length, t.width);
      ctx.strokeRect(0, -t.width / 2, t.length, t.width);
      ctx.fillStyle = 'rgba(239,68,68,0.4)';
      ctx.fillRect(0, (-t.width / 2) * p, t.length, t.width * p);
    } else if (t.kind === 'summon') {
      ctx.strokeStyle = 'rgba(168,85,247,0.95)';
      ctx.fillStyle = 'rgba(168,85,247,' + (0.06 + 0.18 * p).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(0, 0, t.radius, 0, TAU); ctx.fill(); ctx.stroke();
      for (let i = 0; i < t.count; i++) {
        const a = t.angle + (i * TAU) / t.count;
        ctx.beginPath(); ctx.arc(Math.cos(a) * t.radius, Math.sin(a) * t.radius, 6 + 10 * p, 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawEnemy(e, x, y, rt, now, aimAngle) {
    const flash = FX.flash[e.id];
    let flashing = false;
    if (flash !== undefined) { if (flash > now) flashing = true; else delete FX.flash[e.id]; }
    ctx.save();
    ctx.translate(x, y);
    if (e.type === 'BOSS') {
      ctx.rotate(now / 1800);
      ctx.fillStyle = flashing ? '#fff' : SS.bossColor;
      poly(8, e.size, 0); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke();
      ctx.fillStyle = 'rgba(2,6,23,0.55)';
      poly(8, e.size * 0.55, Math.PI / 8); ctx.fill();
    } else if (e.type === 'HEXAGON') {
      ctx.fillStyle = flashing ? '#fff' : '#F59E0B'; poly(6, e.size, 0); ctx.fill();
    } else if (e.type === 'PENTAGON') {
      ctx.fillStyle = flashing ? '#fff' : '#10B981'; poly(5, e.size, -Math.PI / 2); ctx.fill();
    } else if (e.type === 'CIRCLE') {
      ctx.fillStyle = flashing ? '#fff' : '#EC4899';
      ctx.beginPath(); ctx.arc(0, 0, e.size, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = flashing ? '#fff' : '#EF4444';
      ctx.rotate(aimAngle);
      ctx.beginPath(); ctx.moveTo(e.size, 0); ctx.lineTo(-e.size, e.size); ctx.lineTo(-e.size, -e.size); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    if (e.type !== 'BOSS' && e.hp < e.maxHp) {
      ctx.fillStyle = '#000'; ctx.fillRect(x - 18, y - e.size - 11, 36, 4);
      ctx.fillStyle = '#EF4444'; ctx.fillRect(x - 18, y - e.size - 11, 36 * Math.max(0, e.hp / e.maxHp), 4);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const cap = FPS_CAP[SS.quality];
    if (now - lastFrame < 1000 / cap - 1) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    fpsAcc += dt; fpsCount++;
    if (fpsAcc >= 0.5) { SS.fps = Math.round(fpsCount / fpsAcc); fpsAcc = 0; fpsCount = 0; }

    // overlays cover the screen, so skip all drawing while one is up
    if (!SS.inGame || SS.blocking || SS.snaps.length === 0) {
      perfEl.textContent = '';
      return;
    }

    const rt = performance.now() - INTERP_MS;
    const br = bracket(rt);
    if (!br) return;
    const { a, b, t } = br;

    const vw = innerWidth, vh = innerHeight;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, vw, vh);

    const camId = SS.players_cam_ok && SS.snaps ? null : null; // placeholder removed below
    const focusId = (a.players[SS.spectatingId] && !a.players[SS.spectatingId].dead) ? SS.spectatingId : SS.myId;
    const focus = playerPos(a, b, t, focusId) || playerPos(a, b, t, SS.myId);
    if (!focus) return;

    // screen shake
    if (FX.shake > 0.2) {
      shakeX = (Math.random() - 0.5) * FX.shake;
      shakeY = (Math.random() - 0.5) * FX.shake;
      FX.shake *= Math.pow(0.001, dt);
    } else { FX.shake = 0; shakeX = 0; shakeY = 0; }

    const camX = focus.x - vw / 2 + shakeX;
    const camY = focus.y - vh / 2 + shakeY;
    const W = SS.worldSize;

    // grid, batched in one path
    ctx.strokeStyle = '#0F1B33';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const gx0 = -(((camX % 100) + 100) % 100);
    const gy0 = -(((camY % 100) + 100) % 100);
    for (let x = gx0; x < vw; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, vh); }
    for (let y = gy0; y < vh; y += 100) { ctx.moveTo(0, y); ctx.lineTo(vw, y); }
    ctx.stroke();

    // world border
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 5;
    ctx.strokeRect(-camX, -camY, W, W);

    // obstacles
    const obs = SS.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const ox = o.x - camX, oy = o.y - camY;
      if (ox + o.w < 0 || ox > vw || oy + o.h < 0 || oy > vh) continue;
      ctx.fillStyle = o.color; ctx.fillRect(ox, oy, o.w, o.h);
      ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, o.w, o.h);
    }

    // boss danger zones
    const tels = a.telegraphs;
    for (let i = 0; i < tels.length; i++) drawTelegraph(tels[i], camX, camY);

    // enemy bullets (extrapolated from the older snapshot to the render time)
    const ex = Math.max(0, (rt - a.rt) / 1000);
    ctx.fillStyle = '#F43F5E';
    ctx.beginPath();
    const ebs = a.enemyBullets;
    for (let i = 0; i < ebs.length; i++) {
      const eb = ebs[i];
      const x = eb[0] + eb[2] * ex - camX, y = eb[1] + eb[3] * ex - camY;
      if (x < -20 || x > vw + 20 || y < -20 || y > vh + 20) continue;
      ctx.moveTo(x + 6, y); ctx.arc(x, y, 6, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = '#FFE4E6';
    ctx.beginPath();
    for (let i = 0; i < ebs.length; i++) {
      const eb = ebs[i];
      const x = eb[0] + eb[2] * ex - camX, y = eb[1] + eb[3] * ex - camY;
      if (x < -20 || x > vw + 20 || y < -20 || y > vh + 20) continue;
      ctx.moveTo(x + 2.5, y); ctx.arc(x, y, 2.5, 0, TAU);
    }
    ctx.fill();

    // enemies
    const aimAt = playerPos(a, b, t, focusId) || focus;
    for (let i = 0; i < a.enemies.length; i++) {
      const ea = a.enemies[i];
      const eb = b.emap.get(ea.id);
      const ex2 = eb ? lerp(ea.x, eb.x, t) : ea.x;
      const ey2 = eb ? lerp(ea.y, eb.y, t) : ea.y;
      const x = ex2 - camX, y = ey2 - camY;
      if (x < -90 || x > vw + 90 || y < -90 || y > vh + 90) continue;
      const cur = eb || ea;
      drawEnemy(cur, x, y, rt, now, Math.atan2(aimAt.y - ey2, aimAt.x - ex2));
    }

    // player bullets
    const pbs = a.bullets;
    ctx.fillStyle = '#38BDF8';
    ctx.beginPath();
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
      if (pb[4]) continue;
      const x = pb[0] + pb[2] * ex - camX, y = pb[1] + pb[3] * ex - camY;
      if (x < -10 || x > vw + 10 || y < -10 || y > vh + 10) continue;
      ctx.moveTo(x + 4, y); ctx.arc(x, y, 4, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = '#FBBF24';
    ctx.beginPath();
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
      if (!pb[4]) continue;
      const x = pb[0] + pb[2] * ex - camX, y = pb[1] + pb[3] * ex - camY;
      if (x < -10 || x > vw + 10 || y < -10 || y > vh + 10) continue;
      ctx.moveTo(x + 5, y); ctx.arc(x, y, 5, 0, TAU);
    }
    ctx.fill();

    // particles
    const parts = FX.particles;
    const pLimit = SS.quality === 0 ? 40 : SS.quality === 1 ? 100 : 180;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      if (i >= parts.length - pLimit) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.col;
        ctx.fillRect(p.x - camX - p.size / 2, p.y - camY - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;

    // shockwave rings
    for (let i = FX.rings.length - 1; i >= 0; i--) {
      const r = FX.rings[i];
      r.life -= dt;
      if (r.life <= 0) { FX.rings.splice(i, 1); continue; }
      const k = 1 - r.life / r.max;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = r.col; ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(r.x - camX, r.y - camY, r.r * (0.35 + 0.65 * k), 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // players
    for (const id in a.players) {
      const pa = a.players[id];
      if (pa.dead) continue;
      const pos = playerPos(a, b, t, id);
      if (!pos) continue;
      const x = pos.x - camX, y = pos.y - camY;
      if (x < -60 || x > vw + 60 || y < -60 || y > vh + 60) continue;
      const mine = id === SS.myId;
      ctx.save();
      ctx.translate(x, y);
      if (pa.knocked) {
        ctx.globalAlpha = 0.5 + Math.sin(now / 200) * 0.4;
        ctx.fillStyle = '#EF4444'; ctx.fillRect(-15, -15, 30, 30);
        ctx.globalAlpha = 1;
        ctx.restore();
        ctx.fillStyle = '#fff'; ctx.font = '18px Teko'; ctx.textAlign = 'center';
        ctx.fillText(pa.name + ' (' + pa.deathTimer + 's)', x, y - 24);
        continue;
      }
      ctx.rotate(pos.angle);
      ctx.fillStyle = mine ? '#38BDF8' : '#10B981';
      ctx.fillRect(-15, -15, 30, 30);
      ctx.fillStyle = '#fff'; ctx.fillRect(15, -3, 15, 6);
      ctx.restore();
      ctx.fillStyle = '#fff'; ctx.font = '20px Teko'; ctx.textAlign = 'center';
      ctx.fillText(pa.name, x, y - 26);
      if (mine) {
        ctx.fillStyle = '#334155'; ctx.fillRect(x - 20, y + 22, 40, 4);
        ctx.fillStyle = '#F59E0B'; ctx.fillRect(x - 20, y + 22, 40 * Math.max(0, pa.sprint / pa.maxSprint), 4);
      }
    }

    // floating damage numbers
    const nums = FX.nums;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    for (let i = nums.length - 1; i >= 0; i--) {
      const d = nums[i];
      d.y -= 48 * dt;
      d.life -= 1.5 * dt;
      if (d.life <= 0) { nums.splice(i, 1); continue; }
      ctx.font = 'bold ' + (d.c ? 32 : 22) + 'px Teko';
      ctx.globalAlpha = Math.min(1, d.life * 1.5);
      ctx.strokeStyle = '#000';
      ctx.strokeText(d.v, d.x - camX, d.y - camY);
      ctx.fillStyle = d.c ? '#FBBF24' : '#fff';
      ctx.fillText(d.v, d.x - camX, d.y - camY);
    }
    ctx.globalAlpha = 1;

    // crosshair
    const mx = SS.mouse.x, my = SS.mouse.y;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 9, 0, TAU);
    ctx.moveTo(mx - 15, my); ctx.lineTo(mx - 5, my);
    ctx.moveTo(mx + 5, my); ctx.lineTo(mx + 15, my);
    ctx.moveTo(mx, my - 15); ctx.lineTo(mx, my - 5);
    ctx.moveTo(mx, my + 5); ctx.lineTo(mx, my + 15);
    ctx.stroke();

    // small status line: shown on F, and for a moment after changing quality
    if (SS.showFps || performance.now() < perfUntil) {
      perfEl.textContent = SS.fps + ' fps  |  Quality: ' + SS.QUALITY[SS.quality].name + ' (Q)  |  Sound: ' + (SS.muted ? 'off' : 'on') + ' (M)';
    } else if (perfEl.textContent) {
      perfEl.textContent = '';
    }
  }
  requestAnimationFrame(frame);
})();
