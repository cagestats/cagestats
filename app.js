/* Cage Stats web dashboard. Plain JavaScript, no build step. */
(function () {
  'use strict';

  // Only goals and assists are tracked. Older matches may still contain shots,
  // saves or tackles; those are hidden rather than deleted.
  const STATS = {
    GOAL:   { one: 'Goal',   many: 'Goals',   short: 'G' },
    ASSIST: { one: 'Assist', many: 'Assists', short: 'A' },
  };
  const ORDER = Object.keys(STATS);
  const MOVING = 1.0; // m/s, same threshold as the watch

  const app = document.getElementById('app');
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = (k) => `var(--c-${k})`;
  const km = (m) => (m / 1000).toFixed(2);
  const mins = (ms) => Math.round(ms / 60000);
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDateLong = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const movingPct = (m) => (m.duration_ms > 0 ? Math.round((m.moving_ms / m.duration_ms) * 100) : 0);
  const count = (m, k) => Number((m.counts || {})[k] || 0);
  const shown = (m) => (m.tracked || []).filter((k) => STATS[k]);

  // ---------------------------------------------------------------- setup

  const cfg = window.CAGESTATS_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey) {
    app.innerHTML = `<div class="panel center-panel"><h2>Almost there</h2><p class="muted">Add your Supabase project URL and publishable key to <b>config.js</b>, then reload.</p></div>`;
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  let session = null;
  let matches = [];
  let devices = [];

  // ---------------------------------------------------------------- routing

  async function route() {
    const { data } = await sb.auth.getSession();
    session = data.session;
    $('#sign-out').hidden = !session;
    $('#nav-watches').hidden = !session;
    if (!session) return viewSignIn();

    await loadData();
    const hash = location.hash.replace(/^#/, '');
    if (!devices.length) return viewLink(true);
    if (hash === 'watches') return viewWatches();
    if (hash.startsWith('match-')) return viewMatch(hash.slice(6));
    return viewOverview();
  }

  async function loadData() {
    const [d, m] = await Promise.all([
      sb.from('devices').select('id,label,linked_at,last_seen_at').order('linked_at'),
      sb.from('matches')
        .select('id,started_at,duration_ms,paused_ms,distance_m,moving_ms,avg_hr,max_hr,tracked,counts')
        .order('started_at', { ascending: false }),
    ]);
    devices = d.data || [];
    matches = m.data || [];
  }

  window.addEventListener('hashchange', route);
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      if (event === 'SIGNED_IN' && location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
      route();
    }
  });
  $('#sign-out').addEventListener('click', async () => { await sb.auth.signOut(); location.hash = ''; });
  $('#nav-watches').addEventListener('click', () => { location.hash = 'watches'; });

  // ---------------------------------------------------------------- sign in

  /** Signed-out landing: what Cage Stats is on the left, sign-in on the right. */
  function viewSignIn() {
    app.innerHTML = `
      <div class="landing">
        <section class="hero-copy">
          <p class="eyebrow">5-a-side stats from your watch</p>
          <h1 class="display">Every goal.<br>Every metre.</h1>
          <p class="lede">Who scored the most this season? Nobody remembers... your watch does.</p>
          <p class="lede sub">One tap logs a goal or an assist. Distance, work rate and heart rate record themselves. At full time, it all lands here.</p>
        </section>
        <section class="panel auth" id="auth"></section>
        <div class="sample" aria-label="Example match summary">
            <div class="sample-head"><span class="caps">Example match</span><span class="caps">60 min</span></div>
            <div class="sample-stats">
              <div><span class="num" style="color:var(--c-GOAL)">3</span><span class="caps">Goals</span></div>
              <div><span class="num" style="color:var(--c-ASSIST)">2</span><span class="caps">Assists</span></div>
              <div><span class="num">4.31<small>km</small></span><span class="caps">Distance</span></div>
              <div><span class="num">78<small>%</small></span><span class="caps">Work rate</span></div>
            </div>
        </div>
      </div>`;
    authEmailStep();
  }

  function authEmailStep(prefill) {
    const box = $('#auth');
    box.innerHTML = `
      <h2>Sign in</h2>
      <p class="muted">No password. We email you a link that signs you in.</p>
      <form id="signin" class="stack">
        <label class="caps" for="email">Email</label>
        <input class="field" id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required value="${esc(prefill || '')}">
        <button class="btn primary" type="submit">Email me a link</button>
      </form>
      <p class="msg" id="msg" role="status"></p>
      <p class="fine">New here? Same step. Your account is set up automatically.</p>`;
    $('#email').focus();
    $('#signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#email').value.trim();
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Sending';
      const { error } = await sendLink(email);
      btn.disabled = false; btn.textContent = 'Email me a link';
      if (error) { const msg = $('#msg'); msg.className = 'msg err'; msg.textContent = error.message; return; }
      authSentStep(email);
    });
  }

  function sendLink(email) {
    return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  }

  /** After sending: no code to type. Tapping the link in the email signs you in. */
  function authSentStep(email, note) {
    const box = $('#auth');
    box.innerHTML = `
      <h2>Check your email</h2>
      <p class="muted">We sent a sign-in link to<br><b class="em">${esc(email)}</b></p>
      <p class="muted">Tap the link in that email and you're in. Open it on the device you want to use the dashboard on.</p>
      <p class="msg${note ? ' ok' : ''}" id="msg" role="status">${esc(note || '')}</p>
      <div class="row between">
        <button class="link-btn" id="change" type="button">Use a different email</button>
        <button class="link-btn" id="resend" type="button" disabled>Resend in 60s</button>
      </div>`;
    $('#change').addEventListener('click', () => authEmailStep(email));

    const resend = $('#resend');
    let left = 60;
    const tick = setInterval(() => {
      if (!resend.isConnected) return clearInterval(tick);
      left -= 1;
      if (left <= 0) { clearInterval(tick); resend.disabled = false; resend.textContent = 'Resend email'; }
      else resend.textContent = `Resend in ${left}s`;
    }, 1000);
    resend.addEventListener('click', async () => {
      resend.disabled = true; resend.textContent = 'Sending';
      const { error } = await sendLink(email);
      if (error) { const msg = $('#msg'); msg.className = 'msg err'; msg.textContent = error.message; resend.disabled = false; resend.textContent = 'Resend email'; return; }
      authSentStep(email, 'Sent again. Use the newest email.');
    });
  }

  // ---------------------------------------------------------------- link a watch

  function linkForm() {
    return `
      <form id="link" class="section">
        <input class="field code-field" id="code" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC 123" required>
        <input class="field" id="label" maxlength="40" placeholder="Name, e.g. Galaxy Watch7" value="Galaxy Watch">
        <button class="btn primary" type="submit">Connect watch</button>
        <p class="msg" id="msg"></p>
      </form>`;
  }

  function bindLinkForm() {
    $('#link').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      const msg = $('#msg');
      btn.disabled = true;
      const { error } = await sb.rpc('link_device', {
        p_code: $('#code').value.replace(/\s+/g, ''),
        p_label: $('#label').value,
      });
      btn.disabled = false;
      if (error) { msg.className = 'msg err'; msg.textContent = error.message; return; }
      msg.className = 'msg ok';
      msg.textContent = 'Connected. Your matches are on their way.';
      setTimeout(() => { location.hash = ''; route(); }, 900);
    });
  }

  function viewLink(first) {
    app.innerHTML = `
      <div class="panel center-panel">
        <h2>${first ? 'Connect your watch' : 'Connect another watch'}</h2>
        <p class="muted">On the watch, tap <b>Set up sync</b> at the bottom of the home screen, then type the 6-character code it shows.</p>
        ${linkForm()}
      </div>`;
    bindLinkForm();
  }

  // ---------------------------------------------------------------- overview

  function viewOverview() {
    if (!matches.length) {
      app.innerHTML = `
        <div class="panel center-panel">
          <h2>No matches yet</h2>
          <p class="muted">Play one. It lands here at full time, or the next time your watch is online.</p>
        </div>`;
      return;
    }

    const playedMs = matches.reduce((s, m) => s + m.duration_ms, 0);
    const distM = matches.reduce((s, m) => s + m.distance_m, 0);
    const movingMs = matches.reduce((s, m) => s + m.moving_ms, 0);

    const statCards = ORDER.map((k) => {
      const tracked = matches.filter((m) => shown(m).includes(k));
      if (!tracked.length) return '';
      const total = tracked.reduce((s, m) => s + count(m, k), 0);
      const hours = tracked.reduce((s, m) => s + m.duration_ms, 0) / 3.6e6;
      const perGame = total / tracked.length;
      return `
        <div class="stat-card">
          <span class="caps" style="color:${color(k)}">${STATS[k].many}</span>
          <span class="num" style="color:${color(k)}">${total}</span>
          <span class="per"><b>${perGame.toFixed(1)}</b> per match</span>
          <span class="per"><b>${hours ? (total / hours).toFixed(1) : '0.0'}</b> per hour</span>
          ${tracked.length < matches.length ? `<span class="per">Tracked in ${tracked.length} of ${matches.length}</span>` : ''}
        </div>`;
    }).join('');

    app.innerHTML = `
      <section class="section">
        <div class="hero">
          <div><span class="caps">Matches</span><span class="num">${matches.length}</span></div>
          <div><span class="caps">Played</span><span class="num">${(playedMs / 3.6e6).toFixed(1)}<small>h</small></span></div>
          <div><span class="caps">Distance</span><span class="num">${(distM / 1000).toFixed(1)}<small>km</small></span></div>
          <div><span class="caps">Work rate</span><span class="num">${playedMs ? Math.round((movingMs / playedMs) * 100) : 0}<small>%</small></span></div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Your stats</h2><span class="caps">All time</span></div>
        <div class="stats-grid">${statCards}</div>
      </section>

      <section class="section panel">
        <div class="section-head"><h2>Distance per match</h2><span class="caps">Last ${Math.min(barCount(), matches.length)}</span></div>
        <div class="chart fit">${distanceChart(matches.slice(0, barCount()).reverse())}</div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Matches</h2><span class="caps">${matches.length} total</span></div>
        <div class="matches">${matches.map(matchRow).join('')}</div>
      </section>`;

    app.querySelectorAll('[data-match]').forEach((el) =>
      el.addEventListener('click', () => { location.hash = 'match-' + el.dataset.match; }));
  }

  function matchRow(m) {
    const chips = shown(m).map((k) => `
      <span class="chip"><span class="dot" style="background:${color(k)}"></span><span class="num">${count(m, k)}</span><span class="caps">${STATS[k].short}</span></span>`).join('');
    return `
      <button class="match" data-match="${esc(m.id)}">
        <div>
          <div class="date">${fmtDate(m.started_at)} <span class="muted">· ${mins(m.duration_ms)} min</span></div>
          <div class="chips">${chips}</div>
        </div>
        <div class="km"><span class="num">${km(m.distance_m)}</span><div class="caps">km · ${movingPct(m)}% work rate</div></div>
      </button>`;
  }

  const narrow = () => window.innerWidth < 640;
  const barCount = () => (narrow() ? 6 : 12);

  /** Bars of km per match, oldest on the left. Sized so text stays readable on a phone. */
  function distanceChart(list) {
    const W = narrow() ? 360 : 640, H = narrow() ? 200 : 220, L = 30, R = 6, T = 22, B = 30;
    const maxKm = Math.max(1, ...list.map((m) => m.distance_m / 1000));
    const top = Math.ceil(maxKm);
    const n = list.length, slot = (W - L - R) / Math.max(n, 1), bw = Math.min(38, slot * 0.6);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    let grid = '';
    const step = top <= 4 ? 1 : 2;
    for (let v = 0; v <= top; v += step) {
      grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>
        <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="Barlow, sans-serif">${v}</text>`;
    }
    const bars = list.map((m, i) => {
      const v = m.distance_m / 1000, cx = L + slot * i + slot / 2;
      const last = i === n - 1;
      return `<rect x="${cx - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(2, y(0) - y(v))}" rx="5" fill="${last ? 'var(--volt)' : '#fff'}"><title>${fmtDate(m.started_at)}: ${v.toFixed(2)} km</title></rect>
        <text x="${cx}" y="${y(v) - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--fg)" font-family="'Barlow Condensed', sans-serif">${v.toFixed(1)}</text>
        <text x="${cx}" y="${H - 10}" text-anchor="middle" font-size="10.5" fill="var(--muted)" font-family="Barlow, sans-serif">${new Date(m.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilometres covered in each recent match">${grid}${bars}</svg>`;
  }

  // ---------------------------------------------------------------- match detail

  async function viewMatch(id) {
    const m = matches.find((x) => x.id === id);
    if (!m) { location.hash = ''; return; }
    app.innerHTML = `<div class="spinner">Loading match</div>`;
    const { data } = await sb.from('matches').select('raw').eq('id', id).single();
    const raw = data?.raw || {};

    const big = shown(m).map((k) => `
      <div><div class="num" style="color:${color(k)}">${count(m, k)}</div><div class="caps">${STATS[k].many}</div></div>`).join('');
    const paused = mins(m.paused_ms);

    app.innerHTML = `
      <section class="section">
        <button class="link-btn" id="back" style="align-self:flex-start">← All matches</button>
        <div class="detail-top">
          <div>
            <h2>${fmtDateLong(m.started_at)}</h2>
            <p class="muted">Kick-off ${fmtTime(m.started_at)} · ${mins(m.duration_ms)} min played${paused ? ` · ${paused} min paused` : ''}</p>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="big-stats">${big}</div>
        <div class="metrics">
          <div><div class="caps">Distance</div><span class="num">${km(m.distance_m)}</span><small>km</small></div>
          <div><div class="caps">Work rate</div><span class="num">${movingPct(m)}</span><small>%</small></div>
          <div><div class="caps">On the move</div><span class="num">${mmss(m.moving_ms)}</span></div>
          <div><div class="caps">Heart rate</div><span class="num">${m.avg_hr ?? '--'}</span><small>avg${m.max_hr ? ' · ' + m.max_hr + ' max' : ''}</small></div>
        </div>
        ${raw.batteryStart != null && raw.batteryEnd != null
          ? `<p class="fine">Watch battery ${raw.batteryStart}% to ${raw.batteryEnd}%${raw.recovered ? ' · saved automatically after the watch shut down' : ''}</p>`
          : ''}
      </section>

      <section class="section panel">
        <div class="section-head"><h2>Timeline</h2></div>
        <div class="legend">
          <span><i style="background:var(--heart)"></i>Heart rate</span>
          <span><i style="background:var(--move);border-radius:2px"></i>On the move</span>
          ${shown(m).map((k) => `<span><i style="background:${color(k)}"></i>${STATS[k]?.one || k}</span>`).join('')}
        </div>
        <div class="chart">${timeline(raw, m)}</div>
      </section>

      <section class="row">
        <button class="btn danger" id="delete">Delete match</button>
        <span class="msg" id="msg"></span>
      </section>`;

    $('#back').addEventListener('click', () => { location.hash = ''; });
    let armed = false;
    $('#delete').addEventListener('click', async (e) => {
      if (!armed) {
        armed = true;
        e.target.textContent = 'Tap again to delete';
        setTimeout(() => { armed = false; if (e.target.isConnected) e.target.textContent = 'Delete match'; }, 3000);
        return;
      }
      const { error } = await sb.from('matches').delete().eq('id', id);
      if (error) { const msg = $('#msg'); msg.className = 'msg err'; msg.textContent = error.message; return; }
      location.hash = '';
    });
  }

  /** Heart rate over the match, a band showing when you were moving, and each tap marked. */
  function timeline(raw, m) {
    const samples = (raw.samples || []).filter((s) => Array.isArray(s));
    const events = (raw.events || []).filter((e) => STATS[e.type]);
    const endMs = Math.max(m.duration_ms + (m.paused_ms || 0), ...samples.map((s) => s[0]), ...events.map((e) => e.atMs), 60000);
    const W = 760, H = 250, L = 38, R = 10, T = 34, B = 48;
    const hrs = samples.map((s) => s[1]).filter((v) => typeof v === 'number');
    const lo = hrs.length ? Math.floor((Math.min(...hrs) - 8) / 10) * 10 : 100;
    const hi = hrs.length ? Math.ceil((Math.max(...hrs) + 8) / 10) * 10 : 200;
    const x = (t) => L + (t / endMs) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    let grid = '';
    const gstep = (hi - lo) > 60 ? 20 : 10;
    for (let v = lo; v <= hi; v += gstep) {
      grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>
        <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="Barlow, sans-serif">${v}</text>`;
    }
    const totalMin = endMs / 60000, tstep = totalMin > 70 ? 15 : totalMin > 30 ? 10 : 5;
    let ticks = '';
    for (let t = 0; t <= totalMin; t += tstep) {
      ticks += `<text x="${x(t * 60000)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="Barlow, sans-serif">${t}'</text>`;
    }

    const bandY = H - B + 8;
    let band = '';
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], next = samples[i + 1] ? samples[i + 1][0] : s[0] + 10000;
      if (typeof s[2] === 'number' && s[2] > MOVING) {
        band += `<rect x="${x(s[0]).toFixed(1)}" y="${bandY}" width="${Math.max(0.6, x(next) - x(s[0]) + 0.3).toFixed(1)}" height="10" fill="var(--move)"/>`;
      }
    }

    let line = '';
    const pts = samples.filter((s) => typeof s[1] === 'number').map((s) => `${x(s[0]).toFixed(1)},${y(s[1]).toFixed(1)}`);
    if (pts.length > 1) {
      line = `<path d="M${pts[0]} L${pts.slice(1).join(' L')} L${x(samples.filter((s) => typeof s[1] === 'number').at(-1)[0]).toFixed(1)},${y(lo)} L${pts[0].split(',')[0]},${y(lo)} Z" fill="var(--heart)" fill-opacity=".1"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="var(--heart)" stroke-width="1.8" stroke-linejoin="round"/>`;
    }

    const marks = events.map((e) => {
      const k = e.type, ex = x(e.atMs);
      return `<line x1="${ex}" x2="${ex}" y1="22" y2="${H - B}" stroke="${color(k)}" stroke-opacity=".35" stroke-dasharray="2 3"/>
        <circle cx="${ex}" cy="14" r="9" fill="${color(k)}"><title>${STATS[k]?.one || k} ${Math.floor(e.atMs / 60000) + 1}'</title></circle>
        <text x="${ex}" y="17.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="#000" font-family="Barlow, sans-serif">${STATS[k]?.short || ''}</text>`;
    }).join('');

    const empty = !samples.length
      ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="13" font-family="Barlow, sans-serif">No sensor data for this match</text>`
      : '';
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heart rate and movement over the match, with logged stats marked">${grid}${band}${line}${marks}${ticks}${empty}</svg>`;
  }

  // ---------------------------------------------------------------- watches

  function viewWatches() {
    const rows = devices.map((d) => `
      <div class="device">
        <div><div style="font-weight:600">${esc(d.label)}</div><div class="msg">Linked ${d.linked_at ? fmtDate(d.linked_at) : ''}</div></div>
        <div class="msg">${d.last_seen_at ? 'Last upload ' + fmtDate(d.last_seen_at) : ''}</div>
      </div>`).join('');
    app.innerHTML = `
      <section class="section">
        <button class="link-btn" id="back" style="align-self:flex-start">← All matches</button>
        <div class="panel">
          <h2>Your watches</h2>
          <div class="devices">${rows}</div>
        </div>
        <div class="panel">
          <h2>Connect another watch</h2>
          <p class="muted">On the watch, tap <b>Set up sync</b> at the bottom of the home screen and type the code here.</p>
          ${linkForm()}
        </div>
      </section>`;
    $('#back').addEventListener('click', () => { location.hash = ''; });
    bindLinkForm();
  }

  route();
})();
