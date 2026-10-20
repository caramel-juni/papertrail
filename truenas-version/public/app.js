'use strict';
const $ = s => document.querySelector(s);
const h = (t, p = {}, ...k) => {
  const e = document.createElement(t);
  for (const [a, v] of Object.entries(p)) {
    if (a === 'class') e.className = v;
    else if (a.startsWith('on')) e.addEventListener(a.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(a, v === true ? '' : v);
  }
  for (const c of k.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let sourcesText = load('sources', ''), cache = load('cache', {}), saved = load('saved', {}), later = load('later', {}), report = load('report', {}),
  cats = load('cats', []), assign = load('assign', {}), kept = load('kept', {}), sstat = load('sstat', {}),
  cfg = { win: 72, sort: 'new', title: 'News report', ...load('cfg', {}) };
let view = 'feed', tag = '', src = '', q = '', limit = 100, catSel = '', panelOpen = false, lastItems = [];
const expanded = new Set(), catOpen = new Set(), failOpen = new Set();
const STOP = new Set('about after again also been before being could does from have into just like more most over said says than that their them then there these they this were what when where which while will with would your'.split(' '));

const ts = i => Math.min(i.published || i.seen, Date.now());
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const persist = () => {
  for (const [k, v] of [['saved', saved], ['later', later], ['report', report], ['cats', cats], ['assign', assign], ['kept', kept], ['sstat', sstat], ['cfg', cfg], ['sources', sourcesText]]) store(k, v);
  if (!store('cache', cache)) { dropOldest(0.5); store('cache', cache); }
};
function dropOldest(f) {
  const ids = Object.keys(cache).sort((a, b) => ts(cache[a]) - ts(cache[b]));
  ids.slice(0, Math.floor(ids.length * f)).forEach(id => delete cache[id]);
}
function prune() {
  const cut = Date.now() - 30 * 864e5;
  for (const id in cache) if (ts(cache[id]) < cut) delete cache[id];
  if (Object.keys(cache).length > 4000) dropOldest(0.25);
}
const setStatus = t => { $('#status').textContent = t; };
const ago = t => { const m = Math.max(0, (Date.now() - t) / 6e4); return m < 60 ? Math.round(m) + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
let rt; const renderSoon = () => { clearTimeout(rt); rt = setTimeout(render, 250); };

const parseSources = t => t.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
  const [u, tg = ''] = l.split('|'); let url = u.trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  return { url, tags: tg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) };
}).filter(s => /^https?:\/\/[^\s]+$/i.test(s.url));

/* ----- fetching sources ----- */
function merge(s) {
  for (const it of s.items) {
    const old = cache[it.id] || {};
    const fresh = Object.fromEntries(Object.entries(it).filter(([, v]) => v != null && v !== ''));
    cache[it.id] = { ...old, ...fresh, tags: [...new Set([...(old.tags || []), ...(it.tags || [])])], seen: old.seen || Date.now(), source: s.name, sourceUrl: s.url };
  }
}
const failed = (s, error, stage, hint) => { sstat[s.url] = { ok: false, error, stage, hint, trail: [], at: Date.now() }; };
async function refresh(only) {
  const all = parseSources(sourcesText), srcs = only || all;
  if (!all.length) { setStatus('Add some sources first.'); return openSources(); }
  if (!only) for (const u of Object.keys(sstat)) if (!all.some(s => s.url === u)) delete sstat[u];
  let done = 0; setStatus(`Loading 0/${srcs.length} sources…`);
  const batches = []; for (let i = 0; i < srcs.length; i += 8) batches.push(srcs.slice(i, i + 8));
  await Promise.all(batches.map(async b => {
    try {
      const r = await post('/api/feeds', { sources: b });
      if (!r.ok) throw Object.assign(new Error(r.status === 429 ? 'Rate limited by this Papertrail server' : 'Papertrail server error ' + r.status),
        { hint: r.status === 429 ? 'Wait a minute, then use “Retry failed”.' : 'Try again; check the server logs if it persists.' });
      const d = await r.json();
      d.results.forEach((s, k) => {
        if (s.error) sstat[b[k].url] = { ok: false, error: s.error, stage: s.stage, hint: s.hint, http: s.status, trail: s.trail || [], at: Date.now() };
        else { merge(s); sstat[b[k].url] = { ok: true, name: s.name, count: s.items.length, via: s.via, ms: s.ms, trail: s.trail || [], at: Date.now() }; }
      });
    } catch (e) { b.forEach(s => failed(s, e.hint ? e.message : 'Could not reach the Papertrail server', 'client', e.hint || 'Check your connection, then retry.')); }
    done += b.length; setStatus(`Loading ${done}/${srcs.length} sources…`); render();
  }));
  cfg.last = Date.now(); prune(); persist(); render();
}

/* ----- filtering / trending ----- */
const windowItems = () => { const cut = Date.now() - cfg.win * 36e5; return Object.values(cache).filter(i => ts(i) >= cut); };
function trend(items) {
  const toks = items.map(i => [...new Set(i.title.toLowerCase().match(/[a-z0-9\u00c0-\uffff]{4,}/g) || [])].filter(w => !STOP.has(w)));
  const seen = {};
  items.forEach((i, k) => toks[k].forEach(w => (seen[w] ??= new Set()).add(i.source)));
  return new Map(items.map((i, k) => {
    let s = 0; for (const w of toks[k]) s += Math.max(0, seen[w].size - 1);
    return [i.id, s / Math.pow((Date.now() - ts(i)) / 36e5 + 2, 0.8)];
  }));
}
function filtered(pool) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = pool.filter(i => (!tag || i.tags.includes(tag)) && (!src || i.sourceUrl === src) &&
    terms.every(t => (i.title + ' ' + i.summary + ' ' + i.source + ' ' + i.tags.join(' ')).toLowerCase().includes(t)));
  if (cfg.sort === 'trend') { const sc = trend(pool); items.sort((a, b) => (sc.get(b.id) - sc.get(a.id)) || ts(b) - ts(a)); }
  else items.sort((a, b) => ts(b) - ts(a));
  return items;
}

/* ----- background thumbnail fetching (no click needed) ----- */
let enriching = 0, enrichTimer;
const scheduleEnrich = () => { clearTimeout(enrichTimer); enrichTimer = setTimeout(enrich, 150); };
function applyInfo(id, d) {
  for (const o of [cache[id], saved[id], later[id], report[id], kept[id]]) if (o) {
    if (d.image && !o.image) o.image = d.image;
    if (d.summary && !o.summary) o.summary = d.summary;
  }
}
async function enrich() {
  if (view !== 'feed' || enriching >= 2) return;
  const want = lastItems.slice(0, limit).map(i => cache[i.id]).filter(c => c && !c.headTried && (!c.image || (c.scraped && !c.summary))).slice(0, 20);
  if (!want.length) return;
  want.forEach(c => { c.headTried = Date.now(); });
  enriching++;
  try {
    const r = await post('/api/enrich', { urls: want.map(c => c.link) });
    if (r.ok) (await r.json()).results.forEach((d, k) => { if (!d.error) applyInfo(want[k].id, d); });
  } catch { /* leave without thumbnail */ }
  enriching--; persist(); renderSoon(); scheduleEnrich();
}

/* ----- categories ----- */
function setCat(i, c, on) {
  const a = new Set(assign[i.id] || []); on ? a.add(c) : a.delete(c);
  if (a.size) { assign[i.id] = [...a]; kept[i.id] ||= { ...(cache[i.id] || i) }; } else { delete assign[i.id]; delete kept[i.id]; }
  persist(); render();
}
function renameCat(c) {
  const n = (prompt('Rename category', c) || '').trim().slice(0, 60);
  if (!n || n === c) return;
  if (!cats.includes(n)) cats[cats.indexOf(c)] = n; else cats = cats.filter(x => x !== c);
  for (const id in assign) assign[id] = [...new Set(assign[id].map(x => x === c ? n : x))];
  catSel = n; persist(); render();
}
function deleteCat(c) {
  if (!confirm(`Delete category “${c}”? Its stories stay wherever else they are saved.`)) return;
  cats = cats.filter(x => x !== c);
  for (const id in assign) { assign[id] = assign[id].filter(x => x !== c); if (!assign[id].length) { delete assign[id]; delete kept[id]; } }
  persist(); render();
}
function newCat(name) { const n = name.trim().slice(0, 60); if (n && !cats.includes(n)) { cats.push(n); persist(); } return n; }
function catPanel(i) {
  const mine = assign[i.id] || [], nm = h('input', { type: 'text', placeholder: 'New category…', 'aria-label': 'New category name', maxlength: 60 });
  const add = () => { const n = newCat(nm.value); if (n) setCat(i, n, true); };
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return h('div', { class: 'catpanel' },
    cats.length ? cats.map(c => h('label', { class: 'catopt' }, h('input', { type: 'checkbox', checked: mine.includes(c), onchange: e => setCat(i, c, e.target.checked) }), c)) : h('span', { class: 'note' }, 'No categories yet — create one:'),
    h('div', { class: 'row' }, nm, h('button', { class: 'act', onclick: add }, 'Add')));
}

/* ----- rendering ----- */
function chipBar(opts, sel, pick) {
  $('#tags').replaceChildren(...opts.map(([v, label]) => h('button', { class: 'chip' + (sel === v ? ' on' : ''), onclick: () => pick(v) }, label)));
}
function drawSources(pool) {
  const names = {}; for (const i of Object.values(cache)) names[i.sourceUrl] = i.source;
  const n = {}; pool.forEach(i => { n[i.sourceUrl] = (n[i.sourceUrl] || 0) + 1; });
  const opts = parseSources(sourcesText).map(s => ({ v: s.url, t: `${sstat[s.url] && !sstat[s.url].ok ? '⚠ ' : ''}${names[s.url] || hostOf(s.url)} (${n[s.url] || 0})` }));
  if (src && !opts.some(o => o.v === src)) src = '';
  const sel = $('#srcSel'), sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) { sel.replaceChildren(h('option', { value: '' }, 'All sources'), ...opts.map(o => h('option', { value: o.v }, o.t))); sel.dataset.sig = sig; }
  sel.value = src;
}
async function toggleOpen(i) {
  expanded.has(i.id) ? expanded.delete(i.id) : expanded.add(i.id);
  render();
  const c = cache[i.id] || i;
  if (expanded.has(i.id) && !c.enriched && !c.summary) {
    try {
      const r = await fetch('/api/article?url=' + encodeURIComponent(c.link));
      if (r.ok) { applyInfo(i.id, await r.json()); if (cache[i.id]) cache[i.id].enriched = true; persist(); render(); }
    } catch { /* leave as is */ }
  }
}
function toggleIn(map, i) { map[i.id] ? delete map[i.id] : map[i.id] = { ...i }; persist(); render(); }
function card(i) {
  const open = expanded.has(i.id), mine = assign[i.id] || [];
  const ph = () => h('div', { class: 'thumb ph' }, (i.source || '•')[0].toUpperCase());
  const thumb = i.image ? h('img', { class: 'thumb', src: '/api/img?u=' + encodeURIComponent(i.image), loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onerror: e => e.target.replaceWith(ph()) }) : ph();
  const act = (label, on, fn) => h('button', { class: 'act' + (on ? ' on' : ''), onclick: fn }, label);
  return h('article', { class: 'card' + (open ? ' open' : '') },
    h('div', { class: 'head', tabindex: 0, role: 'button', 'aria-expanded': String(open), onclick: () => toggleOpen(i),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(i); } } },
      thumb, h('div', { class: 'meta' }, h('h3', {}, i.title), h('p', { class: 'sub' }, `${i.source} · ${ago(ts(i))}` + (mine.length ? ' · 📁 ' + mine.join(', ') : '')))),
    open && h('div', { class: 'body' }, h('p', {}, i.summary || 'No summary available — use Open to read the article.'), h('p', { class: 'tags' }, i.tags.map(t => '#' + t).join(' '))),
    h('div', { class: 'actions' },
      act(saved[i.id] ? '★ Saved' : '☆ Save', saved[i.id], () => toggleIn(saved, i)),
      act(later[i.id] ? '⏰ In read later' : '⏰ Read later', later[i.id], () => toggleIn(later, i)),
      act(mine.length ? `📁 Categories (${mine.length})` : '📁 Categories', catOpen.has(i.id), () => { catOpen.has(i.id) ? catOpen.delete(i.id) : catOpen.add(i.id); render(); }),
      act(report[i.id] ? '📄 In report' : '📄 Add to report', report[i.id], () => toggleIn(report, i)),
      h('a', { class: 'act', href: i.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗')),
    catOpen.has(i.id) && catPanel(i));
}
function srcRow(s, st) {
  const d = h('details', { class: 'srcrow ' + (st.ok ? 'ok' : 'fail'), open: failOpen.has(s.url) },
    h('summary', {}, st.ok ? `✔ ${st.name} — ${st.count} articles via ${st.via} (${st.ms} ms)` : `✖ ${hostOf(s.url)} — ${st.error}`),
    h('dl', {}, h('dt', {}, 'URL'), h('dd', {}, s.url),
      !st.ok && [h('dt', {}, 'Failed at'), h('dd', {}, st.stage || 'unknown'),
        st.http && [h('dt', {}, 'HTTP status'), h('dd', {}, String(st.http))],
        st.hint && [h('dt', {}, 'Suggestion'), h('dd', {}, st.hint)]],
      st.trail && st.trail.length ? [h('dt', {}, 'Steps taken'), h('dd', {}, h('ol', {}, st.trail.map(t => h('li', {}, t))))] : null));
  d.addEventListener('toggle', () => { d.open ? failOpen.add(s.url) : failOpen.delete(s.url); });
  return d;
}
function statusPanel() {
  const rows = parseSources(sourcesText).map(s => [s, sstat[s.url]]).filter(r => r[1]);
  if (!rows.length) return null;
  const bad = rows.filter(r => !r[1].ok), badSrc = bad.map(r => r[0]);
  const d = h('details', { class: 'xpbox' + (bad.length ? ' bad' : ''), open: panelOpen },
    h('summary', {}, bad.length ? `⚠ ${bad.length} of ${rows.length} sources had problems — click for details` : `✔ All ${rows.length} sources loaded`),
    h('div', { class: 'inner' }, bad.length ? h('p', {}, h('button', { onclick: () => refresh(badSrc) }, 'Retry failed')) : null,
      [...bad, ...rows.filter(r => r[1].ok)].map(r => srcRow(r[0], r[1]))));
  d.addEventListener('toggle', () => { panelOpen = d.open; });
  return d;
}
function reportGroups() {
  const items = Object.values(report), slim = i => ({ title: i.title, link: i.link }), groups = [];
  for (const c of cats) { const its = items.filter(i => (assign[i.id] || []).includes(c)); if (its.length) groups.push({ name: c, items: its }); }
  const un = items.filter(i => !(assign[i.id] || []).length);
  if (un.length) groups.push({ name: groups.length ? 'Uncategorised' : '', items: un });
  return { groups, payload: groups.map(g => ({ name: g.name, items: g.items.map(slim) })) };
}
function renderReport(list) {
  const items = Object.values(report), { groups } = reportGroups();
  list.append(h('div', { class: 'row reportbar' },
    h('input', { type: 'text', value: cfg.title, 'aria-label': 'Report title', onchange: e => { cfg.title = e.target.value; persist(); } }),
    h('button', { onclick: downloadReport, disabled: !items.length }, 'Download Word doc (.docx)'),
    h('button', { onclick: () => { if (confirm('Clear the report?')) { report = {}; persist(); render(); } } }, 'Clear')));
  if (!items.length) list.append(h('p', { class: 'empty' }, 'No stories yet. Use “Add to report” on any story. Links are grouped by the categories you give them.'));
  else if (groups.length > 1 || groups[0].name) list.append(h('p', { class: 'note' }, 'Preview — links are grouped by category in the document (a story in several categories appears under each).'));
  groups.forEach(g => { if (g.name) list.append(h('h4', { class: 'grp' }, g.name)); g.items.forEach(i => list.append(card(i))); });
}
async function downloadReport() {
  const r = await post('/api/report', { title: cfg.title, groups: reportGroups().payload });
  if (!r.ok) return setStatus('Could not build the report (' + r.status + ').');
  const a = h('a', { href: URL.createObjectURL(await r.blob()), download: 'news-report.docx' });
  document.body.append(a); a.click(); a.remove();
}
function renderCats(list) {
  const nm = h('input', { type: 'text', placeholder: 'New category name…', 'aria-label': 'New category name', maxlength: 60 });
  const add = () => { const n = newCat(nm.value); if (n) { catSel = n; render(); } };
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  list.append(h('div', { class: 'row reportbar' }, nm, h('button', { onclick: add }, 'Create category')));
  if (!cats.length) return list.append(h('p', { class: 'empty' }, 'No categories yet. Create one, then use “📁 Categories” on any story to file it.'));
  if (!cats.includes(catSel)) catSel = cats[0];
  const count = c => Object.values(assign).filter(a => a.includes(c)).length;
  chipBar(cats.map(c => [c, `${c} (${count(c)})`]), catSel, v => { catSel = v; render(); });
  const items = Object.keys(assign).filter(id => assign[id].includes(catSel)).map(id => kept[id] || cache[id]).filter(Boolean).reverse();
  list.append(h('div', { class: 'row reportbar' }, h('strong', {}, catSel),
    h('button', { onclick: () => renameCat(catSel) }, 'Rename'), h('button', { onclick: () => deleteCat(catSel) }, 'Delete'),
    h('button', { disabled: !items.length, onclick: () => { items.forEach(i => { report[i.id] ||= { ...i }; }); persist(); setStatus(`Added ${items.length} stories to the report.`); render(); } }, 'Add all to report')));
  if (!items.length) list.append(h('p', { class: 'empty' }, 'Nothing filed here yet.'));
  items.forEach(i => list.append(card(i)));
}
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  const list = $('#list'); list.replaceChildren(); $('#tags').replaceChildren();
  $('.toolbar').classList.toggle('dim', view !== 'feed');
  if (view === 'report') { renderReport(list); return setStatus(`${Object.keys(report).length} stories in report`); }
  if (view === 'cats') { renderCats(list); return setStatus(`${cats.length} categories`); }
  let items;
  if (view === 'feed') {
    const pool = windowItems(); drawSources(pool);
    const n = {}; pool.forEach(i => i.tags.forEach(t => { n[t] = (n[t] || 0) + 1; }));
    const top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 30);
    chipBar([['', 'All tags'], ...top.map(([t, c]) => [t, `${t} (${c})`])], tag, v => { tag = v; limit = 100; render(); });
    items = lastItems = filtered(pool);
    const sp = statusPanel(); if (sp) list.append(sp);
  } else items = Object.values(view === 'saved' ? saved : later).reverse();
  if (!items.length) list.append(h('p', { class: 'empty' }, view === 'feed' ? 'No articles in this time window. Add sources or hit Refresh.' : 'Nothing here yet.'));
  items.slice(0, limit).forEach(i => list.append(card(i)));
  if (items.length > limit) list.append(h('button', { class: 'more', onclick: () => { limit += 100; render(); } }, `Show more (${items.length - limit} left)`));
  setStatus(view === 'feed' ? `${items.length} articles · last refresh ${cfg.last ? ago(cfg.last) : 'never'}` : `${items.length} stories`);
  if (view === 'feed') scheduleEnrich();
}

/* ----- sources dialog, import/export ----- */
function openSources() { $('#srcText').value = sourcesText; $('#dlg').showModal(); }
const readFile = f => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).slice(0, 2e6)); fr.readAsText(f); });
function wire() {
  $('#win').value = String(cfg.win); $('#sort').value = cfg.sort;
  $('#win').onchange = e => { cfg.win = +e.target.value; limit = 100; persist(); render(); };
  $('#sort').onchange = e => { cfg.sort = e.target.value; persist(); render(); };
  $('#srcSel').onchange = e => { src = e.target.value; limit = 100; render(); };
  let t; $('#q').oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; limit = 100; view = 'feed'; render(); }, 150); };
  $('#refresh').onclick = () => refresh(); $('#srcBtn').onclick = openSources; $('#start').onclick = openSources;
  document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => { view = b.dataset.view; limit = 100; render(); }; });
  $('#srcFile').onchange = async e => { if (e.target.files[0]) $('#srcText').value = await readFile(e.target.files[0]); };
  $('#srcSave').onclick = () => { sourcesText = $('#srcText').value; persist(); $('#dlg').close(); refresh(); };
  $('#srcClose').onclick = $('#srcX').onclick = () => $('#dlg').close();
  $('#srcDefaults').onclick = async () => { const t2 = await (await fetch('/api/default-sources')).text(); if (t2) $('#srcText').value = t2; else alert('No server-side default sources configured.'); };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ sources: $('#srcText').value, saved, later, report, cats, assign, kept, cfg })], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'papertrail-backup.json' }); document.body.append(a); a.click(); a.remove();
  };
  $('#importFile').onchange = async e => {
    try {
      const d = JSON.parse(await readFile(e.target.files[0]));
      if (typeof d.sources === 'string') sourcesText = d.sources;
      for (const [k, m] of [['saved', saved], ['later', later], ['report', report], ['assign', assign], ['kept', kept]]) if (d[k] && typeof d[k] === 'object') Object.assign(m, d[k]);
      if (Array.isArray(d.cats)) cats = [...new Set([...cats, ...d.cats.map(String)])];
      if (d.cfg && typeof d.cfg === 'object') cfg = { ...cfg, win: +d.cfg.win || cfg.win, sort: d.cfg.sort === 'trend' ? 'trend' : 'new', title: String(d.cfg.title || cfg.title) };
      persist(); $('#dlg').close(); render(); refresh();
    } catch { alert('That file is not a valid backup.'); }
  };
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  tick(); setInterval(tick, 15000);
}
(async function init() {
  wire(); render();
  if (!sourcesText) {
    try { const r = await fetch('/api/default-sources'); const t = r.ok ? await r.text() : ''; if (t.trim()) { sourcesText = t; persist(); } } catch { /* ignore */ }
  }
  if (!sourcesText) return openSources();
  if (!cfg.last || Date.now() - cfg.last > 10 * 6e4) refresh();
})();
