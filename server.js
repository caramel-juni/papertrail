'use strict';
const http = require('http'), https = require('https'), dns = require('dns'), net = require('net');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel } = require('docx');

const PORT = +process.env.PORT || 2525;
const SOURCES_FILE = process.env.SOURCES_FILE || '/data/sources.txt';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RATE_POINTS = +process.env.RATE_POINTS_PER_MIN || 600;
const MAX_PAGE = 3 * 1024 * 1024, MAX_IMG = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; papertrail/1.0; +feed-reader)';

/* ---------- detailed, classified errors ---------- */
class SourceError extends Error {
  constructor(m, stage, hint, status) { super(m); this.stage = stage || 'network'; this.hint = hint || ''; this.status = status || null; }
}
const HTTP_HINTS = {
  401: 'The page needs a login.',
  403: 'The site refused the request (bot protection or a login wall). Look for its RSS/Atom feed URL and add that instead.',
  404: 'Page not found. Check the URL for typos or find the real feed address.',
  410: 'This page has been removed.', 429: 'The site is rate-limiting requests. Wait a while and retry.',
  451: 'Blocked for legal reasons in the server’s region.',
};
function classify(e) {
  if (e instanceof SourceError) return e;
  const c = e.code || '', m = String(e.message || '');
  if (c === 'EBLOCKED') return new SourceError('Address resolves to a private or internal network', 'blocked', 'Only public internet sites can be fetched.');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new SourceError('DNS lookup failed: host not found', 'dns', 'Check the domain spelling. If every source fails, the server may have no DNS or internet access.');
  if (c === 'ECONNREFUSED') return new SourceError('Connection refused by the site', 'connect', 'The site is down or not accepting web connections on this address.');
  if (c === 'ECONNRESET' || c === 'EPIPE') return new SourceError('Connection was reset by the site', 'connect', 'Often caused by bot protection. Try the site’s feed URL.');
  if (c === 'ETIMEDOUT' || c === 'ENETUNREACH' || c === 'EHOSTUNREACH' || /timeout/i.test(m)) return new SourceError('Timed out waiting for the site', 'timeout', 'The site is slow or unreachable. Retry later.');
  if (/CERT|SELF.SIGNED|SSL|TLS|ALTNAME|WRONG_VERSION/i.test(c + m)) return new SourceError('HTTPS certificate problem (' + (c || clip(m, 60)) + ')', 'tls', 'The site’s certificate is invalid, expired or mismatched, so it was not trusted.');
  return new SourceError(clip(m, 160) || 'Unknown network error', 'network', '');
}

/* ---------- SSRF-safe outbound fetching (no allowlist; blocks internal networks) ---------- */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('::ffff:') || v.startsWith('64:ff9b') ||
    v.startsWith('2001:db8') || v.startsWith('ff') || /^(fc|fd|fe[89ab])/.test(v);
}
// The socket connects to the exact address validated here, so DNS rebinding can't swap in an internal IP.
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivate(a.address))) return cb(Object.assign(new Error('blocked'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function get(urlStr, { max = MAX_PAGE, accept = '*/*', until = '' } = {}, hops = 0, chain = []) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new SourceError('Invalid URL', 'validate', 'Check the address, including http:// or https://.')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new SourceError('Only http(s) URLs are allowed', 'validate', 'Use an http:// or https:// address.'));
    if (u.username || u.password) return reject(new SourceError('Credentials in the URL are not allowed', 'validate'));
    if (u.port && !['80', '443'].includes(u.port)) return reject(new SourceError('Port ' + u.port + ' is not allowed', 'validate', 'Only ports 80 and 443 can be fetched.'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivate(host)) return reject(new SourceError('Address is on a private or internal network', 'blocked', 'Only public internet sites can be fetched.'));
    const lib = u.protocol === 'https:' ? https : http;
    let timer, done = false;
    const fail = e => { clearTimeout(timer); if (!done) { done = true; reject(classify(e)); } };
    const finish = r => { clearTimeout(timer); if (!done) { done = true; resolve(r); } };
    const req = lib.request(u, {
      method: 'GET', lookup: safeLookup, timeout: 8000,
      headers: { 'user-agent': UA, accept, 'accept-encoding': 'identity' },
    }, res => {
      const sc = res.statusCode;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume(); clearTimeout(timer); done = true;
        if (hops >= 4) return reject(new SourceError('Too many redirects (' + chain.concat(u.href).join(' → ') + ')', 'http', 'The site redirects in a loop.'));
        let next; try { next = new URL(res.headers.location, u).href; } catch { return reject(new SourceError('Redirect to an invalid address', 'http')); }
        return resolve(get(next, { max, accept, until }, hops + 1, chain.concat(u.href))); // every hop is re-validated
      }
      if (sc >= 400) {
        res.resume();
        return fail(new SourceError(`HTTP ${sc} ${res.statusMessage || ''}`.trim(), 'http', HTTP_HINTS[sc] || (sc >= 500 ? 'The site’s server reported an error. Try again later.' : ''), sc));
      }
      const chunks = []; let n = 0, acc = '';
      const end = () => finish({ status: sc, headers: res.headers, body: Buffer.concat(chunks), url: u.href, chain: chain.concat(u.href) });
      res.on('data', c => {
        if (done) return;
        n += c.length;
        if (n > max) return req.destroy(new SourceError('Response exceeded the ' + Math.round(max / 1024) + ' KB limit', 'size', 'The page is too large to read.'));
        chunks.push(c);
        if (until) { acc += c.toString('latin1'); if (acc.toLowerCase().includes(until)) { end(); req.destroy(); } }
      });
      res.on('end', end);
      res.on('error', fail);
    });
    timer = setTimeout(() => req.destroy(new SourceError('Timed out after 15 s', 'timeout', 'The site is too slow to respond.')), 15000);
    req.on('timeout', () => req.destroy(new SourceError('No data from the site for 8 s', 'timeout', 'The site is slow or unreachable. Retry later.')));
    req.on('error', fail);
    req.end();
  });
}
function decode(r) {
  const m = /charset=([\w-]+)/i.exec(r.headers['content-type'] || '');
  try { return new TextDecoder(m ? m[1] : 'utf-8').decode(r.body); } catch { return r.body.toString('utf8'); }
}

/* ---------- helpers ---------- */
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const txt = x => x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x);
const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const htmlText = h => { try { return cheerio.load('<div>' + h + '</div>').text(); } catch { return ''; } };
const abs = (u, base) => { try { const x = new URL(String(u).trim(), base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const pdate = v => { const t = Date.parse(txt(v)); return Number.isFinite(t) ? Math.min(t, Date.now()) : null; };
const xp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function mediaImg(it) {
  const t = arr(it['media:thumbnail']).find(x => x && x['@_url']);
  if (t) return t['@_url'];
  const c = arr(it['media:content']).find(x => x && x['@_url'] && (!x['@_medium'] || x['@_medium'] === 'image' || /^image/.test(x['@_type'] || '')));
  if (c) return c['@_url'];
  const e = arr(it.enclosure).find(x => x && /^image/.test(x['@_type'] || ''));
  return e ? e['@_url'] : null;
}
function atomLink(e) {
  const ls = arr(e.link);
  const l = ls.find(x => x && x['@_rel'] === 'alternate') || ls.find(x => x && !x['@_rel']) || ls[0];
  return typeof l === 'string' ? l : (l && l['@_href']) || '';
}
function parseXml(text) {
  const d = xp.parse(text);
  let name = '', raw = [], kind = '';
  if (d.rss) {
    kind = 'RSS';
    const c = d.rss.channel || {}; name = txt(c.title);
    raw = arr(c.item).map(i => ({ title: txt(i.title), link: txt(i.link) || txt(i.guid), pub: i.pubDate || i['dc:date'],
      html: txt(i.description) || txt(i['content:encoded']), cats: arr(i.category).map(txt), img: mediaImg(i) }));
  } else if (d.feed) {
    kind = 'Atom'; name = txt(d.feed.title);
    raw = arr(d.feed.entry).map(e => ({ title: txt(e.title), link: atomLink(e), pub: e.published || e.updated,
      html: txt(e.summary) || txt(e.content), cats: arr(e.category).map(c => (c && c['@_term']) || txt(c)), img: mediaImg(e) }));
  } else if (d['rdf:RDF']) {
    const r = d['rdf:RDF']; kind = 'RSS 1.0'; name = txt((r.channel || {}).title);
    raw = arr(r.item).map(i => ({ title: txt(i.title), link: txt(i.link), pub: i['dc:date'], html: txt(i.description), cats: arr(i['dc:subject']).map(txt), img: null }));
  } else return null;
  return { name, raw, kind };
}
function parseJsonFeed(text) {
  const d = JSON.parse(text);
  if (!Array.isArray(d.items)) return null;
  return { kind: 'JSON Feed', name: d.title || '', raw: d.items.map(i => ({ title: i.title || '', link: i.url || i.external_url, pub: i.date_published,
    html: i.summary || i.content_text || i.content_html || '', cats: arr(i.tags).map(String), img: i.image || i.banner_image })) };
}
function parseAny(text, trail) {
  const t = text.trimStart();
  try {
    if (t[0] === '{') {
      const p = parseJsonFeed(t);
      if (!p) trail.push('JSON received but it is not a JSON Feed (no "items" array)');
      return p;
    }
    if (/<(rss|feed|rdf:RDF)[\s>]/i.test(t.slice(0, 2500))) {
      const p = parseXml(t);
      if (!p) trail.push('XML looks like a feed but has no recognised RSS/Atom structure');
      return p;
    }
  } catch (e) { trail.push('Feed parse error: ' + clip(e.message, 120)); }
  return null;
}
function discover(html, base) {
  const $ = cheerio.load(html);
  return $('link[rel~="alternate"]').map((i, e) => ({ t: ($(e).attr('type') || '').toLowerCase(), h: $(e).attr('href') })).get()
    .filter(f => f.h && /rss|atom|xml|json/.test(f.t)).map(f => abs(f.h, base)).filter(Boolean);
}
function scrape(html, base) {
  const $ = cheerio.load(html), seen = new Set(), raw = [];
  $('article a[href], h1 a[href], h2 a[href], h3 a[href]').each((i, a) => {
    if (raw.length >= 40) return;
    const link = abs($(a).attr('href'), base), title = $(a).text().replace(/\s+/g, ' ').trim();
    if (!link || title.length < 25 || seen.has(link)) return;
    seen.add(link);
    const img = $(a).closest('article, li, div').find('img').first();
    raw.push({ title, link, pub: null, html: '', cats: [], img: img.attr('src') || img.attr('data-src') || null });
  });
  return { name: $('title').first().text().trim(), raw, scraped: true };
}
const normalise = (p, base, userTags) => {
  const seen = new Set(), items = [];
  for (const r of p.raw) {
    const link = abs(r.link, base), title = clip(htmlText(r.title), 300);
    if (!link || !title || seen.has(link)) continue;
    seen.add(link);
    const tags = [...new Set([...r.cats.map(c => clip(c, 40).toLowerCase()).filter(Boolean), ...userTags])].slice(0, 12);
    items.push({
      id: 'a' + crypto.createHash('sha1').update(link).digest('hex').slice(0, 16), title, link,
      published: pdate(r.pub), summary: clip(htmlText(r.html), 400),
      image: r.img ? abs(r.img, base) : (r.html && (() => { try { return abs(cheerio.load(r.html)('img').first().attr('src'), base); } catch { return null; } })()) || null,
      tags, scraped: !!p.scraped,
    });
    if (items.length >= 60) break;
  }
  return items;
};
async function loadSource(s) {
  const trail = [], t0 = Date.now();
  try {
    if (!s || typeof s.url !== 'string' || s.url.length > 2000) throw new SourceError('Invalid source entry', 'validate');
    const userTags = arr(s.tags).slice(0, 10).map(t => clip(String(t), 40).toLowerCase()).filter(Boolean);
    const r = await get(s.url, { accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, text/html;q=0.8, */*;q=0.5' });
    const ctype = String(r.headers['content-type'] || 'unknown').split(';')[0];
    trail.push(`GET ${s.url} → ${r.status} ${ctype}, ${Math.max(1, Math.round(r.body.length / 1024))} KB` + (r.chain.length > 1 ? `, redirected ${r.chain.length - 1}× to ${r.url}` : ''));
    if (!/html|xml|json|text/i.test(ctype)) throw new SourceError(`Not a web page or feed (${ctype})`, 'content', 'This URL points at a file, not a site or feed.');
    const body = decode(r);
    let p = parseAny(body, trail), base = r.url, via = 'feed';
    if (p) trail.push(`Recognised as ${p.kind} with ${p.raw.length} entries`);
    else {
      trail.push('Not a feed, looking for feed links advertised in the page');
      const links = discover(body, r.url);
      trail.push(links.length ? `Found ${links.length} advertised feed link(s)` : 'No feed links advertised in the page head');
      for (const f of links.slice(0, 3)) {
        try {
          const fr = await get(f), q = parseAny(decode(fr), trail);
          if (q && q.raw.length) { p = q; base = fr.url; via = 'discovered feed'; trail.push(`Using ${q.kind} feed ${f} (${q.raw.length} entries)`); break; }
          trail.push(`Feed ${f} had no usable entries`);
        } catch (e) { trail.push(`Feed ${f} failed: ${classify(e).message}`); }
      }
    }
    if (!p) { p = scrape(body, r.url); via = 'scraped page'; trail.push(`Scraped the page: ${p.raw.length} headline link(s) matched`); }
    const items = normalise(p, base, userTags);
    if (!items.length) {
      const js = (body.match(/<script/gi) || []).length > 8 || /id="(__next|root|app)"|ng-app|data-reactroot/.test(body);
      throw new SourceError('No articles found', 'parse', js
        ? 'The page looks JavaScript-rendered and advertises no feed. Find its RSS/Atom URL (often /feed or /rss.xml) and add that instead.'
        : 'No feed was found and the page has no recognisable headlines (links of 25+ characters inside article or h1–h3 tags). Try a section page or the site’s feed URL.');
    }
    return { url: s.url, name: clip(htmlText(p.name), 80) || new URL(r.url).hostname.replace(/^www\./, ''), items, via, ms: Date.now() - t0, trail, scraped: !!p.scraped };
  } catch (e) {
    const c = classify(e); trail.push('Failed: ' + c.message); c.trail = trail; throw c;
  }
}
async function feeds(body) {
  const list = arr(body.sources).slice(0, 40), out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, async () => {
    while (i < list.length) {
      const k = i++;
      out[k] = await loadSource(list[k]).catch(e => ({ url: String((list[k] || {}).url || '').slice(0, 200), error: e.message, stage: e.stage, hint: e.hint, status: e.status, trail: e.trail || [] }));
    }
  }));
  return { results: out };
}
const errMsg = e => classify(e).message;

/* ---------- article detail (summary + thumbnail) ---------- */
const artCache = new Map();
const remember = (k, v) => { if (artCache.size > 800) artCache.delete(artCache.keys().next().value); artCache.set(k, v); return v; };
const metaOf = $ => n => $(`meta[property="${n}"],meta[name="${n}"]`).attr('content') || '';
// Head-only fetch: stops reading at </head>, so checking many stories for thumbnails stays cheap.
async function headInfo(u) {
  const key = 'h:' + u;
  if (artCache.has(key)) return artCache.get(key);
  const r = await get(u, { max: 400 * 1024, accept: 'text/html,*/*;q=0.5', until: '</head>' });
  const $ = cheerio.load(decode(r)), meta = metaOf($);
  const image = abs(meta('og:image:secure_url') || meta('og:image') || meta('twitter:image') || meta('twitter:image:src') || $('link[rel="image_src"]').attr('href') || '', r.url);
  return remember(key, { image, summary: clip(meta('og:description') || meta('twitter:description') || meta('description'), 500) });
}
async function article(u) {
  const key = 'a:' + u;
  if (artCache.has(key)) return artCache.get(key);
  const r = await get(u, { max: 1.5 * 1024 * 1024, accept: 'text/html,*/*;q=0.5' });
  const $ = cheerio.load(decode(r)), meta = metaOf($);
  const image = abs(meta('og:image') || meta('twitter:image') || '', r.url);
  let summary = meta('og:description') || meta('description');
  if (!summary || summary.length < 80) {
    summary = $('article p, main p, p').map((i, e) => $(e).text().replace(/\s+/g, ' ').trim()).get().filter(t => t.length > 60).slice(0, 3).join(' ');
  }
  return remember(key, { image, summary: clip(summary, 700) });
}
async function enrich(body) {
  const urls = arr(body.urls).filter(x => typeof x === 'string' && x.length < 2000).slice(0, 20), out = new Array(urls.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
    while (i < urls.length) {
      const k = i++;
      out[k] = await headInfo(urls[k]).then(r => ({ url: urls[k], ...r }), e => ({ url: urls[k], error: classify(e).message }));
    }
  }));
  return { results: out };
}

/* ---------- Word report (grouped by category) ---------- */
const clean = s => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const cleanItems = a => arr(a).map(i => ({ title: clip(clean(i && i.title), 300), link: abs(String((i && i.link) || '')) })).filter(i => i.title && i.link && i.link.length < 2000);
async function report(body) {
  let left = 300;
  let groups = arr(body.groups).slice(0, 50).map(g => ({ name: clip(clean(g && g.name), 80), items: cleanItems(g && g.items) })).filter(g => g.items.length);
  if (!groups.length) groups = [{ name: '', items: cleanItems(body.items) }];
  const kids = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(clip(clean(body.title), 120) || 'News report')] }),
    new Paragraph({ children: [new TextRun({ text: 'Compiled ' + new Date().toUTCString(), italics: true })] }),
  ];
  for (const g of groups) {
    const items = g.items.slice(0, left); left -= items.length;
    if (!items.length) break;
    if (g.name) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(g.name)] }));
    for (const i of items) kids.push(new Paragraph({ bullet: { level: 0 }, children: [new ExternalHyperlink({ link: i.link, children: [new TextRun({ text: i.title, style: 'Hyperlink' })] })] }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children: kids }] }));
}

/* ---------- HTTP layer ---------- */
const STATIC = {};
for (const [route, file, type] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8']])
  STATIC[route] = { type, body: fs.readFileSync(path.join(__dirname, 'public', file)) };

const buckets = new Map();
function charge(ip, cost) {
  const now = Date.now(), b = buckets.get(ip) || { pts: RATE_POINTS, t: now };
  b.pts = Math.min(RATE_POINTS, b.pts + (now - b.t) / 60000 * RATE_POINTS); b.t = now;
  buckets.set(ip, b);
  if (b.pts < cost) return false;
  b.pts -= cost; return true;
}
setInterval(() => { const c = Date.now() - 120000; for (const [k, v] of buckets) if (v.t < c) buckets.delete(k); }, 60000).unref();

const SEC = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => { res.writeHead(code, { ...SEC, 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('JSON required'), { status: 415 }));
    const ch = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })); } });
  });
}
const IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
    if (req.method === 'GET' && STATIC[u.pathname]) return send(res, 200, STATIC[u.pathname].body, STATIC[u.pathname].type, { 'Cache-Control': 'no-cache' });
    if (u.pathname === '/healthz') return send(res, 200, 'ok');
    if (!u.pathname.startsWith('/api/')) return send(res, 404, 'Not found');

    if (u.pathname === '/api/default-sources' && req.method === 'GET') {
      let t = ''; try { t = fs.readFileSync(SOURCES_FILE, 'utf8').slice(0, 100000); } catch { /* none configured */ }
      return send(res, 200, t);
    }
    if (u.pathname === '/api/feeds' && req.method === 'POST') {
      const b = await readJson(req);
      if (!charge(ip, Math.max(1, Math.min(40, arr(b.sources).length)))) return send(res, 429, 'Rate limit');
      return json(res, 200, await feeds(b));
    }
    if (u.pathname === '/api/enrich' && req.method === 'POST') {
      const b = await readJson(req);
      if (!charge(ip, Math.max(1, Math.min(20, arr(b.urls).length)))) return send(res, 429, 'Rate limit');
      return json(res, 200, await enrich(b));
    }
    if (u.pathname === '/api/article' && req.method === 'GET') {
      if (!charge(ip, 3)) return send(res, 429, 'Rate limit');
      try { return json(res, 200, await article(u.searchParams.get('url') || '')); } catch (e) { const c = classify(e); return json(res, 502, { error: c.message, hint: c.hint }); }
    }
    if (u.pathname === '/api/img' && req.method === 'GET') {
      if (!charge(ip, 1)) return send(res, 429, 'Rate limit');
      try {
        const r = await get(u.searchParams.get('u') || '', { max: MAX_IMG, accept: 'image/*' });
        const ct = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!IMG_TYPES.has(ct)) return send(res, 415, 'Unsupported image');
        return send(res, 200, r.body, ct, { 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "sandbox; default-src 'none'" });
      } catch { return send(res, 502, 'Image unavailable'); }
    }
    if (u.pathname === '/api/report' && req.method === 'POST') {
      if (!charge(ip, 5)) return send(res, 429, 'Rate limit');
      const buf = await report(await readJson(req));
      return send(res, 200, buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { 'Content-Disposition': 'attachment; filename="news-report.docx"' });
    }
    send(res, 404, 'Not found');
  } catch (e) {
    send(res, e.status || 500, e.status ? e.message : 'Server error');
  }
});
server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
server.listen(PORT, '0.0.0.0', () => console.log('papertrail listening on :' + PORT));
