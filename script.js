/*<pure>*/
const HOP = 0.25;
const cl = x => Math.min(1, Math.max(0, x));

function buildFeatures(E) {
  const n = E.length;
  const sorted = Float32Array.from(E).sort();
  const q = p => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const p10 = q(0.10), p20 = q(0.20), p90 = q(0.90), p95 = q(0.95);
  const span = Math.max(6, p95 - p10);
  const silTh = p20 + (p90 - p20) * 0.22;
  const En = new Float32Array(n);
  const quiet = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    En[i] = Math.min(1.2, Math.max(0, (E[i] - p10) / span));
    quiet[i] = E[i] < silTh ? 1 : 0;
  }
  // pause = kam se kam 0.75 sec lagatar shaanti
  const pause = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < n && quiet[j]) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) pause[k] = 1;
    i = j;
  }
  const P1 = new Float64Array(n + 1), P2 = new Float64Array(n + 1), PS = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    P1[k + 1] = P1[k] + En[k];
    P2[k + 1] = P2[k] + En[k] * En[k];
    PS[k + 1] = PS[k] + pause[k];
  }
  return { n, En, pause, P1, P2, PS, dur: n * HOP };
}

function scoreWindow(f, i0, i1) {
  i0 = Math.max(0, i0); i1 = Math.min(f.n, i1);
  const N = i1 - i0;
  if (N < 4) return { raw: 0, t: { mean: 0, dyn: 0, hook: 0, lift: 0, talk: 0 } };
  const mean = (f.P1[i1] - f.P1[i0]) / N;
  const sd = Math.sqrt(Math.max(0, (f.P2[i1] - f.P2[i0]) / N - mean * mean));
  const h3 = Math.min(i1, i0 + 12);
  const hook = (f.P1[h3] - f.P1[i0]) / (h3 - i0);
  const b0 = Math.max(0, i0 - 16);
  const before = (i0 - b0) >= 4 ? (f.P1[i0] - f.P1[b0]) / (i0 - b0) : hook;
  const silFrac = (f.PS[i1] - f.PS[i0]) / N;
  const t = {
    mean: cl(mean / 0.8),
    dyn: cl(sd / 0.3),
    hook: cl(hook / 0.9),
    lift: cl((hook - before + 0.1) / 0.5),
    talk: cl(1 - silFrac * 2.5)
  };
  const raw = 0.30 * t.mean + 0.25 * t.dyn + 0.20 * t.hook + 0.10 * t.lift + 0.15 * t.talk;
  return { raw, t };
}

function snapWindow(f, i, len) {
  let a = i, b = i + len, sa = false, sb = false, best = null;
  for (let j = Math.max(1, i - 12); j <= Math.min(f.n - 1, i + 12); j++) {
    if (f.pause[j - 1] && !f.pause[j] && (best === null || Math.abs(j - i) < Math.abs(best - i))) best = j;
  }
  if (best !== null) { a = Math.max(0, best - 1); sa = true; }
  best = null;
  for (let j = Math.max(1, b - 16); j <= Math.min(f.n - 1, b + 16); j++) {
    if (!f.pause[j - 1] && f.pause[j] && (best === null || Math.abs(j - b) < Math.abs(best - b))) best = j;
  }
  if (best !== null) { b = Math.min(f.n, best + 1); sb = true; }
  if (b - a < Math.round(len * 0.6)) { a = i; b = i + len; sa = sb = false; }
  return { a, b, snapped: sa && sb };
}

function makeClip(f, a, b, snapped, rank) {
  const s = scoreWindow(f, a, b);
  return { rank, start: a * HOP, end: b * HOP, score: Math.round(s.raw * 100), t: s.t, snapped };
}

function pickClips(f, L, count) {
  const len = Math.round(L / HOP);
  if (f.n < len + 8) return [makeClip(f, 0, f.n, false, 1)];
  const cands = [];
  for (let i = 0; i + len <= f.n; i += 4) cands.push({ i, raw: scoreWindow(f, i, i + len).raw });
  cands.sort((x, y) => y.raw - x.raw);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.every(p => Math.abs(p.i - c.i) >= len)) picked.push(c);
  }
  return picked.map(p => {
    const s = snapWindow(f, p.i, len);
    return makeClip(f, s.a, s.b, s.snapped, 0);
  }).sort((x, y) => y.score - x.score).map((c, k) => { c.rank = k + 1; return c; });
}

function demoEnergy() {
  const n = Math.round(2520 / HOP);
  const E = new Float32Array(n);
  let seed = 7;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let i = 0;
  while (i < n) {
    const r = rnd();
    let kind = 'talk', secs = 6 + rnd() * 18;
    if (r < 0.22) { kind = 'pause'; secs = 0.8 + rnd() * 1.8; }
    else if (r > 0.88) { kind = 'burst'; secs = 3 + rnd() * 6; }
    const len = Math.max(2, Math.round(secs / HOP));
    const base = kind === 'pause' ? -58 : kind === 'burst' ? -23 : -35 + rnd() * 5;
    const wob = kind === 'burst' ? 7 : 4.5;
    for (let k = 0; k < len && i < n; k++, i++) {
      E[i] = base + (rnd() - 0.5) * wob * 2 + Math.sin(k / 3) * (kind === 'burst' ? 3 : 1.5);
    }
  }
  return E;
}
/*</pure>*/

(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const state = {
    demo: true, feat: null, dur: 0, url: null,
    L: 30, N: 5, fmt: 'vertical', clips: [], active: -1,
    busy: false, exporting: false, fetching: false, stopAt: null
  };
  const player = $('#player');

  const fmtT = t => {
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* ---------- status ---------- */
  function setStatus(text, mode, pct) {
    const box = $('#status');
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('err', mode === 'err');
    $('#statusText').textContent = text;
    const prog = $('#prog');
    prog.hidden = mode === 'err';
    prog.classList.toggle('indet', pct == null);
    $('#progFill').style.width = pct == null ? '' : Math.round(pct * 100) + '%';
  }

  /* ---------- analysis ---------- */
  async function analyze(file) {
    setStatus('Awaaz padh raha hu…', 'busy', null);
    const AC = window.AudioContext || window.webkitAudioContext;
    let ac;
    try { ac = new AC({ sampleRate: 8000 }); } catch (e) { ac = new AC(); }
    let buf;
    try {
      const ab = await file.arrayBuffer();
      buf = await ac.decodeAudioData(ab);
    } catch (e) {
      try { ac.close(); } catch (_) {}
      throw new Error('decode');
    }
    try { ac.close(); } catch (_) {}
    const sr = buf.sampleRate, hopN = Math.round(sr * HOP), n = Math.floor(buf.length / hopN);
    if (n < 8) throw new Error('short');
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const E = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const o = i * hopN;
      for (const ch of chs) {
        let s = 0;
        for (let k = 0; k < hopN; k++) { const x = ch[o + k]; s += x * x; }
        acc += s / hopN;
      }
      E[i] = 20 * Math.log10(Math.sqrt(acc / chs.length) + 1e-5);
      if (i % 1500 === 0) { setStatus('Awaaz ke hisse naap raha hu…', 'busy', i / n); await tick(); }
    }
    return buildFeatures(E);
  }

  const once = (el, ev) => new Promise((res, rej) => {
    const ok = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); res(); };
    const bad = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); rej(new Error('media')); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });

  async function loadFile(file) {
    if (state.busy || state.exporting || !file) return;
    const looksVideo = (file.type || '').startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(file.name);
    if (!looksVideo) { setStatus('Ye video file nahi lagti. MP4, MOV ya WebM chuno.', 'err'); return; }
    state.busy = true;
    $('#drop').classList.remove('over');
    try {
      const f = await analyze(file);
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = URL.createObjectURL(file);
      player.src = state.url;
      await once(player, 'loadedmetadata');
      state.demo = false;
      state.feat = f;
      state.dur = isFinite(player.duration) ? player.duration : f.dur;
      $('#drop').hidden = true;
      $('#playerWrap').hidden = false;
      $('#fname').textContent = file.name + ' · ' + fmtT(state.dur);
      $('#demoPill').hidden = true; $('#clipPill').hidden = true; $('#demoNote').hidden = true;
      $('#tlwrap').classList.add('live');
      $('#ph').hidden = false;
      setStatus('');
      repick();
    } catch (e) {
      const msg = e && e.message === 'short'
        ? 'Video bahut choti hai. Kam se kam kuch second ki awaaz wali video chuno.'
        : 'Is video ki awaaz browser nahi padh paaya. MP4 (H.264 + AAC) ya WebM try karo, ya choti file chuno.';
      setStatus(msg, 'err');
    } finally {
      state.busy = false;
      $('#file').value = '';
    }
  }

  /* ---------- picking + rendering ---------- */
  function repick() {
    state.clips = pickClips(state.feat, state.L, state.N);
    state.active = -1;
    renderList();
    drawTimeline();
    const e = $('#empty');
    if (state.clips.length < state.N && !state.demo) {
      e.hidden = false;
      e.textContent = state.clips.length <= 1 && state.dur < state.L * 2
        ? 'Video choti hai, isliye sirf ' + state.clips.length + ' clip ban payi. Chhoti lambai chuno.'
        : 'Itne alag clips is video me nahi bane. Chhoti lambai ya kam clips try karo.';
    } else e.hidden = true;
  }

  function why(c) {
    const r = [];
    if (c.t.hook >= 0.7) r.push('Shuruaat tez awaaz se');
    if (c.t.lift >= 0.6) r.push('Pichle hisse ke baad awaaz upar jaati hai');
    if (c.t.dyn >= 0.6) r.push('Awaaz me kaafi utaar-chadhav');
    if (c.t.talk >= 0.85) r.push('Beech me lambi chuppi nahi');
    if (c.t.mean >= 0.7) r.push('Poore clip me awaaz ooncha');
    if (c.snapped) r.push('Pause se shuru aur khatam');
    return r.slice(0, 3).join(' · ') || 'Aam level ka clip';
  }

  function renderList() {
    const dis = state.demo ? ' disabled' : '';
    $('#list').innerHTML = state.clips.map((c, i) => `
      <li class="clip" data-i="${i}">
        <div class="rank">${c.rank}</div>
        <div>
          <div class="ctime"><span class="mono t-range"></span><span class="dur"></span></div>
          <div class="scorerow"><span class="scorelab">Hook score</span><div class="meter"><i></i></div><span class="score"></span></div>
          <p class="why"></p>
          <div class="actions">
            <button class="btn" data-act="play"${dis}>Dekho</button>
            <span class="nudge"><span class="lab">Start</span><button class="btn" data-act="s-" aria-label="Start 1 second pehle"${dis}>−1s</button><button class="btn" data-act="s+" aria-label="Start 1 second baad"${dis}>+1s</button></span>
            <span class="nudge"><span class="lab">End</span><button class="btn" data-act="e-" aria-label="End 1 second pehle"${dis}>−1s</button><button class="btn" data-act="e+" aria-label="End 1 second baad"${dis}>+1s</button></span>
            <button class="btn primary" data-act="export"${dis}>Export</button>
          </div>
          <div class="xstat" hidden></div>
        </div>
      </li>`).join('');
    state.clips.forEach((_, i) => updateClipEl(i));
  }

  function updateClipEl(i) {
    const c = state.clips[i], el = $('#list').children[i];
    if (!el) return;
    el.querySelector('.t-range').textContent = fmtT(c.start) + ' – ' + fmtT(c.end);
    el.querySelector('.dur').textContent = Math.round(c.end - c.start) + ' sec';
    el.querySelector('.meter i').style.width = c.score + '%';
    el.querySelector('.score').textContent = c.score;
    el.querySelector('.why').textContent = why(c);
  }

  function markActive() {
    [...$('#list').children].forEach((el, i) => el.classList.toggle('active', i === state.active));
    drawTimeline();
  }

  function rescore(c) {
    const s = scoreWindow(state.feat, Math.round(c.start / HOP), Math.round(c.end / HOP));
    c.score = Math.round(s.raw * 100); c.t = s.t; c.snapped = false;
  }

  function nudge(i, which, d) {
    const c = state.clips[i];
    if (which === 's') {
      c.start = Math.min(c.end - 5, Math.max(0, c.start + d));
      c.start = Math.max(c.start, c.end - 90);
    } else {
      c.end = Math.max(c.start + 5, Math.min(state.dur, c.end + d));
      c.end = Math.min(c.end, c.start + 90);
    }
    rescore(c); updateClipEl(i); drawTimeline();
  }

  /* ---------- timeline ---------- */
  function drawTimeline() {
    const cv = $('#tl'), w = cv.parentElement.clientWidth, h = 96;
    if (!w || !state.feat) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const col = n => css.getPropertyValue(n).trim();
    const f = state.feat, dur = f.dur;
    const cols = Math.max(1, Math.floor(w / 3)), bw = w / cols;
    const top = 24, area = h - top - 4, mid = top + area / 2;
    for (let x = 0; x < cols; x++) {
      const t0 = x / cols * dur, t1 = (x + 1) / cols * dur;
      const i0 = Math.floor(t0 / HOP), i1 = Math.max(i0 + 1, Math.ceil(t1 / HOP));
      let m = 0;
      for (let i = i0; i < i1 && i < f.n; i++) if (f.En[i] > m) m = f.En[i];
      const tm = (t0 + t1) / 2;
      const inClip = state.clips.some(c => tm >= c.start && tm <= c.end);
      const bh = Math.max(2, Math.min(1, m / 1.1) * area);
      g.fillStyle = inClip ? col('--accent') : col('--bar');
      g.fillRect(x * bw + 0.5, mid - bh / 2, Math.max(1, bw - 1), bh);
    }
    const sx = t => t / state.dur * w;
    state.clips.forEach((c, i) => {
      if (i === state.active) {
        g.strokeStyle = col('--ink'); g.lineWidth = 1.5;
        g.strokeRect(sx(c.start), top - 2, Math.max(2, sx(c.end) - sx(c.start)), area + 4);
      }
      const cx = Math.min(w - 10, Math.max(10, sx((c.start + c.end) / 2)));
      g.fillStyle = col('--accent');
      g.beginPath(); g.arc(cx, 11, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = col('--on-accent');
      g.font = '500 11px ' + col('--font-mono');
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(c.rank), cx, 11.5);
    });
    $('#ax1').textContent = fmtT(state.dur / 2);
    $('#ax2').textContent = fmtT(state.dur);
  }

  function movePlayhead() {
    if (state.demo || !state.dur) return;
    $('#ph').style.left = (player.currentTime / state.dur * 100) + '%';
  }

  /* ---------- playback ---------- */
  function playClip(i) {
    const c = state.clips[i];
    state.active = i; markActive();
    state.stopAt = null;
    player.currentTime = c.start;
    state.stopAt = c.end;
    player.play().catch(() => {});
  }
  player.addEventListener('timeupdate', () => {
    if (state.stopAt != null && player.currentTime >= state.stopAt && player.currentTime < state.stopAt + 0.8) {
      player.pause(); state.stopAt = null;
    }
    movePlayhead();
  });
  $('#tlwrap').addEventListener('click', e => {
    if (state.demo) return;
    const r = e.currentTarget.getBoundingClientRect();
    state.stopAt = null;
    player.currentTime = Math.min(state.dur, Math.max(0, (e.clientX - r.left) / r.width * state.dur));
  });

  /* ---------- export ---------- */
  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
    ];
    if (!window.MediaRecorder) return null;
    return list.find(m => MediaRecorder.isTypeSupported(m)) || null;
  }

  function drawCredit(g, W, H, text, vertical) {
    const size = Math.round(W * 0.034);
    g.font = '600 ' + size + 'px system-ui, sans-serif';
    const label = 'Credit: ' + text;
    const tw = g.measureText(label).width, padX = size * 0.8, bh = size * 1.9;
    const y = vertical ? H - Math.round(H * 0.17) : H - Math.round(H * 0.07) - bh;
    const x = (W - tw - padX * 2) / 2;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath(); g.roundRect ? g.roundRect(x, y, tw + padX * 2, bh, bh / 2) : g.rect(x, y, tw + padX * 2, bh); g.fill();
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(label, x + padX, y + bh / 2 + 1);
  }

  async function recordClip(c, onProg) {
    const mime = pickMime();
    if (!mime) throw new Error('norec');
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    try { await ac.resume(); } catch (_) {}
    const v = document.createElement('video');
    v.src = state.url; v.playsInline = true; v.preload = 'auto';
    await once(v, 'loadedmetadata');
    const vw = v.videoWidth, vh = v.videoHeight, vertical = state.fmt === 'vertical';
    let W, H;
    if (vertical) { W = 720; H = 1280; }
    else { const sc = Math.min(1, 1280 / Math.max(vw, vh)); W = Math.round(vw * sc / 2) * 2; H = Math.round(vh * sc / 2) * 2; }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const small = document.createElement('canvas'); small.width = 54; small.height = 96;
    const sg = small.getContext('2d');
    const credit = $('#credit').value.trim();

    const draw = () => {
      if (vertical) {
        const cover = Math.max(54 / vw, 96 / vh);
        sg.drawImage(v, (54 - vw * cover) / 2, (96 - vh * cover) / 2, vw * cover, vh * cover);
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(small, 0, 0, W, H);
        g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, W, H);
        const f = Math.min(W / vw, H / vh);
        g.drawImage(v, (W - vw * f) / 2, (H - vh * f) / 2, vw * f, vh * f);
      } else g.drawImage(v, 0, 0, W, H);
      if (credit) drawCredit(g, W, H, credit, vertical);
    };

    const src = ac.createMediaElementSource(v);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    const stream = cv.captureStream(30);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    v.currentTime = c.start;
    await once(v, 'seeked');
    draw();

    const blob = await new Promise((resolve, reject) => {
      const chunks = [];
      let done = false, failed = false, raf = 0, iv = 0, lastT = v.currentTime, lastAt = performance.now();
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = () => reject(new Error('rec'));
      rec.onstop = () => failed ? reject(new Error('stall')) : resolve(new Blob(chunks, { type: mime.split(';')[0] }));
      const finish = () => {
        if (done) return; done = true;
        clearInterval(iv); cancelAnimationFrame(raf); v.pause();
        setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 200);
      };
      const frame = () => {
        if (done) return;
        draw();
        onProg(Math.min(1, (v.currentTime - c.start) / (c.end - c.start)));
        if (v.currentTime >= c.end || v.ended) finish(); else raf = requestAnimationFrame(frame);
      };
      iv = setInterval(() => {
        if (done) return;
        if (v.currentTime >= c.end || v.ended) { finish(); return; }
        if (v.currentTime !== lastT) { lastT = v.currentTime; lastAt = performance.now(); }
        else if (performance.now() - lastAt > 8000) { failed = true; finish(); }
      }, 500);
      rec.start(500);
      v.play().then(() => { raf = requestAnimationFrame(frame); }).catch(err => { failed = true; finish(); });
    });
    try { ac.close(); } catch (_) {}
    v.removeAttribute('src'); v.load();
    return { blob, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }

  async function saveFile(blob, name) {
    if (window.claude && window.claude.use) {
      const dl = await window.claude.use('downloads');
      if (!dl) return { ok: false, msg: 'Is view me save nahi ho sakta. Neeche preview dekho, ya is page ko claude.ai me kholo.' };
      try { await dl.save({ filename: name, data: blob }); return { ok: true, msg: 'Save ho gaya: ' + name }; }
      catch (e) {
        if (e && e.code === 'declined') return { ok: false, msg: 'Save cancel hua. "Dobara save karo" dabao.' };
        if (e && e.code === 'too_large') return { ok: false, msg: 'File bahut badi hai. Chhota clip ya 60 sec se kam try karo.' };
        return { ok: false, msg: 'Save nahi ho paya' + (e && e.code ? ' (' + e.code + ')' : '') + '.' };
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return { ok: true, msg: 'Download shuru ho gaya: ' + name };
  }

  async function exportClip(i) {
    if (state.exporting) return;
    const c = state.clips[i], li = $('#list').children[i], box = li.querySelector('.xstat');
    const btn = li.querySelector('[data-act="export"]');
    state.exporting = true;
    document.querySelectorAll('#list button').forEach(b => b.disabled = true);
    box.hidden = false;
    box.innerHTML = '<div class="msg"></div>';
    const msg = box.querySelector('.msg');
    msg.textContent = 'Record ho raha hai… 0%. Tab khula rakho.';
    try {
      const { blob, ext } = await recordClip(c, p => { msg.textContent = 'Record ho raha hai… ' + Math.round(p * 100) + '%. Tab khula rakho.'; });
      const name = 'hook-cutter-clip' + c.rank + '-' + fmtT(c.start).replace(/:/g, 'm') + 's.' + ext;
      const url = URL.createObjectURL(blob);
      const note = ext === 'webm' ? ' Ye WebM hai, Instagram ko MP4 chahiye, to convert karna padega.' : '';
      const showResult = (r) => {
        box.innerHTML = '<div class="msg"></div><video controls playsinline></video>';
        const m = box.querySelector('.msg');
        m.className = 'msg ' + (r.ok ? 'ok' : 'err');
        m.textContent = r.msg + (r.ok ? note : '');
        box.querySelector('video').src = url;
        const again = document.createElement('button');
        again.className = 'btn'; again.style.marginTop = '8px'; again.textContent = 'Dobara save karo';
        again.addEventListener('click', async () => { again.disabled = true; const r2 = await saveFile(blob, name); showResult(r2); });
        m.appendChild(document.createElement('br')); m.appendChild(again);
      };
      msg.textContent = 'Save ka option khul raha hai…';
      showResult(await saveFile(blob, name));
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e && e.message === 'norec'
        ? 'Is browser me clip record nahi ho sakta. Chrome, Edge ya Firefox try karo.'
        : 'Export fail ho gaya. Tab khula rakho aur dobara try karo. Video ka format browser ko pasand na ho to MP4 (H.264) use karo.';
    } finally {
      state.exporting = false;
      document.querySelectorAll('#list button').forEach(b => b.disabled = state.demo);
    }
  }

  /* ---------- YouTube link (server.py ke saath) ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function initLink() {
    try {
      const r = await fetch('/api/ping');
      if (r.ok && (await r.json()).ok) { $('#linkForm').hidden = false; return; }
    } catch (_) {}
    $('#linkNote').hidden = false;
  }
  $('#linkForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (state.busy || state.exporting || state.fetching) return;
    const url = $('#ytUrl').value.trim();
    if (!url) return;
    state.fetching = true;
    $('#ytGo').disabled = true;
    try {
      setStatus('Link check ho raha hai…', 'busy', null);
      const r = await fetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Link kaam nahi kiya.');
      let s;
      for (;;) {
        await sleep(1000);
        s = await (await fetch('/api/status?id=' + j.id)).json();
        if (s.state === 'error') throw new Error(s.error);
        if (s.state === 'done') break;
        setStatus('Video download ho rahi hai… ' + (s.pct != null ? Math.round(s.pct) + '%' : ''), 'busy', s.pct != null ? s.pct / 100 : null);
      }
      setStatus('Video browser me la raha hu…', 'busy', null);
      const blob = await (await fetch(s.media)).blob();
      state.fetching = false;
      await loadFile(new File([blob], (s.title || 'video') + '.mp4', { type: 'video/mp4' }));
    } catch (err) {
      setStatus(err && err.message ? err.message : 'Video nahi aa payi. Dobara try karo.', 'err');
    } finally {
      state.fetching = false;
      $('#ytGo').disabled = false;
    }
  });

  /* ---------- events ---------- */
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const i = Number(b.closest('.clip').dataset.i), a = b.dataset.act;
    if (a === 'play') playClip(i);
    else if (a === 'export') exportClip(i);
    else nudge(i, a[0], a[1] === '+' ? 1 : -1);
  });
  $('#file').addEventListener('change', e => loadFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  document.querySelectorAll('input[name="len"]').forEach(r => r.addEventListener('change', e => { state.L = Number(e.target.value); repick(); }));
  document.querySelectorAll('input[name="cnt"]').forEach(r => r.addEventListener('change', e => { state.N = Number(e.target.value); repick(); }));
  document.querySelectorAll('input[name="fmt"]').forEach(r => r.addEventListener('change', e => { state.fmt = e.target.value; }));

  /* theme + resize redraw */
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawTimeline); } catch (_) {}
  new MutationObserver(drawTimeline).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.ResizeObserver) new ResizeObserver(drawTimeline).observe($('#tlwrap'));

  /* ---------- start in demo state ---------- */
  initLink();
  state.feat = buildFeatures(demoEnergy());
  state.dur = state.feat.dur;
  repick();
})();
