'use strict';
/* WebHosting server — zero dependencies. Hosts uploaded sites and serves the admin UI. */
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BASE = (process.env.BASE_DOMAIN || '').toLowerCase().replace(/^\.+/, '');   // e.g. mysites.com (optional wildcard)
const DISPBASE = BASE || 'webhost.app';
const FREE_DAYS = +process.env.FREE_DAYS || 30, DAY = 864e5;
const MAX_FILE = (+process.env.MAX_FILE_MB || 20) * 1048576, MAX_SITE = (+process.env.MAX_SITE_MB || 100) * 1048576;
const MAX_SITES = +process.env.MAX_SITES_PER_USER || 10, MAX_FILES = 2000;
const FRAME = (process.env.ALLOW_FRAME_FROM || '').trim();   // e.g. "https://imrich.in https://www.imrich.in" (sites allowed to embed this app in an iframe)
const RESERVED = ['www', 'admin', 'api', 'mail', 'app', 'ftp', 'root', 'test', 'webhost', 'support', 's'];
const SITES_DIR = path.join(DATA, 'sites');
fs.mkdirSync(SITES_DIR, { recursive: true });

const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', map: 'application/json', webmanifest: 'application/manifest+json', md: 'text/markdown', csv: 'text/csv' };
const TEXTY = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg)/;
const mimeOf = p => { const m = MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream'; return TEXTY.test(m) || m === 'text/javascript' ? m + '; charset=utf-8' : m; };

/* ---------- state ---------- */
const sites = new Map(), bySlug = new Map(), byDomain = new Map(), dirty = new Set();
const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const validDomain = d => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const siteDir = id => path.join(SITES_DIR, id), filesDir = id => path.join(siteDir(id), 'files');

function index(m) { sites.set(m.id, m); bySlug.set(m.slug, m); byDomain.set(m.domain, m); }
function unindex(m) { sites.delete(m.id); bySlug.delete(m.slug); byDomain.delete(m.domain); }
function saveMeta(m) { const f = path.join(siteDir(m.id), 'meta.json'), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(m)); fs.renameSync(t, f); }
for (const id of fs.readdirSync(SITES_DIR)) { try { index(JSON.parse(fs.readFileSync(path.join(SITES_DIR, id, 'meta.json'), 'utf8'))); } catch (e) { } }
setInterval(() => { for (const id of dirty) { const m = sites.get(id); if (m) try { saveMeta(m); } catch (e) { } } dirty.clear(); }, 10000).unref();
setInterval(cleanup, 600000).unref();
async function cleanup() {
  const now = Date.now();
  for (const m of [...sites.values()]) if ((m.status === 'uploading' && now - m.createdAt > 36e5) || (now - m.expiresAt > 30 * DAY && m.status === 'live')) await removeSite(m);
}
async function removeSite(m) { unindex(m); dirty.delete(m.id); await fsp.rm(siteDir(m.id), { recursive: true, force: true }); }

/* ---------- http helpers ---------- */
const send = (res, code, body, h = {}) => { res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...h }); res.end(body); };
const json = (res, code, o) => send(res, code, JSON.stringify(o), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
const htmlPage = (t, m) => `<!DOCTYPE html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t}</title><body style="font-family:system-ui;text-align:center;padding:18vh 20px;color:#333"><h1>${t}</h1><p style="color:#777">${m}</p>`;
const notFound = res => send(res, 404, htmlPage('404 - Not Found', 'This page or website does not exist.'), { 'Content-Type': 'text/html; charset=utf-8' });
function readBody(req, limit) {
  return new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n > limit) { no(Object.assign(new Error('File too large'), { code: 413 })); req.destroy(); return; } ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no); });
}
const stat = p => fsp.stat(p).catch(() => null);
function safeJoin(root, rel) { if (rel.includes('\0')) return null; const full = path.join(root, path.normalize('/' + rel)); return (full === root || full.startsWith(root + path.sep)) ? full : null; }
const rate = new Map();
function limited(key, max, win) { const now = Date.now(), a = (rate.get(key) || []).filter(t => now - t < win); a.push(now); rate.set(key, a); return a.length > max; }
setInterval(() => rate.clear(), 36e5).unref();
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const originOf = req => (req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + (req.headers['x-forwarded-host'] || req.headers.host);

/* ---------- domain check ---------- */
function check(type, value) {
  let v = String(value || '').trim().toLowerCase();
  if (/^https?:\/\//.test(v) || v.includes('/')) return { available: false, reason: "Don't enter http:// or https:// or a path" };
  if (type === 'free') {
    const label = slugify(v.endsWith('.' + DISPBASE) ? v.slice(0, -DISPBASE.length - 1) : v), domain = label + '.' + DISPBASE;
    if (label.length < 3) return { available: false, reason: 'Subdomain must be at least 3 characters' };
    if (RESERVED.includes(label)) return { available: false, reason: 'This name is reserved' };
    if (bySlug.has(label) || byDomain.has(domain)) return { available: false, reason: 'Already taken' };
    return { available: true, value: label, domain, slug: label };
  }
  v = v.replace(/^www\./, '');
  if (!validDomain(v)) return { available: false, reason: 'Enter a valid domain like example.com' };
  if (v === DISPBASE || v.endsWith('.' + DISPBASE)) return { available: false, reason: 'Use the Free Subdomain option for this domain' };
  const slug = v.replace(/\./g, '-');
  if (byDomain.has(v) || bySlug.has(slug)) return { available: false, reason: 'Already taken' };
  return { available: true, value: v, domain: v, slug };
}

/* ---------- API ---------- */
const view = (m, req) => ({ id: m.id, name: m.name, domain: m.domain, type: m.type, slug: m.slug, status: m.status, createdAt: m.createdAt, deployedAt: m.deployedAt, expiresAt: m.expiresAt, files: m.files, size: m.size, stats: m.stats, url: originOf(req) + '/s/' + m.slug + '/', domainUrl: (m.type === 'custom' || BASE) ? 'https://' + m.domain + '/' : null });
async function api(req, res, u) {
  const p = u.pathname, M = req.method;
  if (p === '/api/config' && M === 'GET') return json(res, 200, { baseDomain: BASE, displayBase: DISPBASE, freeDays: FREE_DAYS, maxFile: MAX_FILE, maxSite: MAX_SITE, maxFiles: MAX_FILES });
  if (p === '/api/check' && M === 'GET') { const r = check(u.searchParams.get('type'), u.searchParams.get('value')); return json(res, 200, { available: r.available, reason: r.reason, value: r.value, domain: r.domain }); }
  const tok = String(req.headers['x-owner'] || ''); if (!/^[a-f0-9]{32,64}$/.test(tok)) return json(res, 401, { error: 'Missing owner token' });
  const oh = sha(tok), mine = id => { const m = sites.get(id); return m && m.ownerHash === oh ? m : null; };
  if (p === '/api/sites' && M === 'GET') return json(res, 200, { sites: [...sites.values()].filter(m => m.ownerHash === oh && m.status === 'live').sort((a, b) => b.createdAt - a.createdAt).map(m => view(m, req)) });
  if (p === '/api/sites' && M === 'POST') {
    if (limited('c' + ipOf(req), 30, 36e5)) return json(res, 429, { error: 'Too many requests. Try later.' });
    const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}'), name = String(b.name || '').trim().slice(0, 60);
    if (name.length < 2) return json(res, 400, { error: 'Enter a project name' });
    if ([...sites.values()].filter(m => m.ownerHash === oh).length >= MAX_SITES) return json(res, 403, { error: 'Project limit reached (' + MAX_SITES + ')' });
    const c = check(b.type === 'custom' ? 'custom' : 'free', b.domain); if (!c.available) return json(res, 409, { error: c.reason });
    const m = { id: crypto.randomBytes(8).toString('hex'), ownerHash: oh, name, domain: c.domain, type: b.type === 'custom' ? 'custom' : 'free', slug: c.slug, status: 'uploading', createdAt: Date.now(), deployedAt: 0, expiresAt: 0, files: 0, size: 0, stats: { total: 0, unique: 0, countries: {} } };
    await fsp.mkdir(filesDir(m.id), { recursive: true }); index(m); saveMeta(m); return json(res, 201, view(m, req));
  }
  let r;
  if ((r = p.match(/^\/api\/sites\/([a-f0-9]{16})\/file$/)) && M === 'PUT') {
    const m = mine(r[1]); if (!m) return json(res, 404, { error: 'Not found' }); if (m.status !== 'uploading') return json(res, 409, { error: 'Already deployed' });
    const rel = path.posix.normalize(String(u.searchParams.get('path') || '').replace(/\\/g, '/')).replace(/^\/+/, '');
    if (!rel || rel.startsWith('..') || rel.length > 200 || rel.includes('\0')) return json(res, 400, { error: 'Invalid file path' });
    if (m.files >= MAX_FILES) return json(res, 413, { error: 'Too many files' });
    const buf = await readBody(req, MAX_FILE); if (m.size + buf.length > MAX_SITE) return json(res, 413, { error: 'Site too large' });
    const full = safeJoin(filesDir(m.id), rel); if (!full) return json(res, 400, { error: 'Invalid file path' });
    const old = await stat(full); await fsp.mkdir(path.dirname(full), { recursive: true }); await fsp.writeFile(full, buf);
    m.size += buf.length - (old ? old.size : 0); if (!old) m.files++; return json(res, 200, { ok: true });
  }
  if ((r = p.match(/^\/api\/sites\/([a-f0-9]{16})\/finish$/)) && M === 'POST') {
    const m = mine(r[1]); if (!m) return json(res, 404, { error: 'Not found' });
    if (!(await stat(path.join(filesDir(m.id), 'index.html')))) return json(res, 400, { error: 'index.html not found in ZIP' });
    m.status = 'live'; m.deployedAt = Date.now(); m.expiresAt = m.deployedAt + FREE_DAYS * DAY; saveMeta(m); return json(res, 200, view(m, req));
  }
  if ((r = p.match(/^\/api\/sites\/([a-f0-9]{16})\/renew$/)) && M === 'POST') {
    const m = mine(r[1]); if (!m || m.status !== 'live') return json(res, 404, { error: 'Not found' });
    m.expiresAt = Math.max(m.expiresAt, Date.now()) + FREE_DAYS * DAY; saveMeta(m); return json(res, 200, view(m, req));
  }
  if ((r = p.match(/^\/api\/sites\/([a-f0-9]{16})$/)) && M === 'DELETE') { const m = mine(r[1]); if (!m) return json(res, 404, { error: 'Not found' }); await removeSite(m); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: 'Not found' });
}

/* ---------- site serving ---------- */
async function serveSite(req, res, m, rel, viaPath) {
  if (m.status !== 'live') return notFound(res);
  if (Date.now() > m.expiresAt) return send(res, 410, htmlPage('Website expired', 'This website has expired. The owner can renew it.'), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let r; try { r = decodeURIComponent(rel); } catch (e) { return send(res, 400, 'Bad request'); }
  const root = filesDir(m.id), prefix = viaPath ? '/s/' + m.slug : '';
  let full = safeJoin(root, r === '' || r.endsWith('/') ? r + 'index.html' : r); if (!full) return send(res, 403, 'Forbidden');
  let st = await stat(full), code = 200;
  if (st && st.isDirectory()) return send(res, 301, '', { Location: prefix + '/' + r.replace(/^\/+/, '') + '/' });
  if (!st) { const alt = await stat(full + '.html'); if (alt && alt.isFile()) { full += '.html'; st = alt; } }
  if (!st) { const nf = path.join(root, '404.html'), s2 = await stat(nf); if (s2) { full = nf; st = s2; code = 404; } else return notFound(res); }
  const h = { 'Content-Type': mimeOf(full), 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer-when-downgrade' };
  if (viaPath) { h['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'; h['Access-Control-Allow-Origin'] = '*'; }
  let start = 0, end = st.size - 1; const rg = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (rg && code === 200 && st.size > 0) {
    if (rg[1] === '') start = Math.max(0, st.size - +rg[2]); else { start = +rg[1]; if (rg[2] !== '') end = Math.min(+rg[2], end); }
    if (start > end || start >= st.size) return send(res, 416, '', { 'Content-Range': 'bytes */' + st.size });
    code = 206; h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  } else if (code === 200 && req.method === 'GET' && /\.html?$/.test(full)) {
    const ck = 'whv_' + m.id, seen = (req.headers.cookie || '').includes(ck + '=1');
    m.stats.total++; if (!seen) { m.stats.unique++; h['Set-Cookie'] = `${ck}=1; Max-Age=31536000; Path=${prefix || '/'}; SameSite=Lax`; }
    const al = /-([A-Za-z]{2})\b/.exec(req.headers['accept-language'] || '');
    const cc = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country'] || (al && al[1]) || 'Unknown').toUpperCase().slice(0, 7);
    m.stats.countries[cc] = (m.stats.countries[cc] || 0) + 1; dirty.add(m.id);
  }
  h['Content-Length'] = st.size ? end - start + 1 : 0; res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...h });
  if (req.method === 'HEAD' || !st.size) return res.end();
  fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/* ---------- main ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), host = (req.headers.host || '').split(':')[0].toLowerCase();
    let m = byDomain.get(host) || byDomain.get(host.replace(/^www\./, ''));
    if (m) return await serveSite(req, res, m, u.pathname.slice(1), false);
    let r;
    if ((r = u.pathname.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/))) {
      m = bySlug.get(r[1]); if (!m) return notFound(res);
      if (!r[2]) return send(res, 301, '', { Location: '/s/' + r[1] + '/' });
      return await serveSite(req, res, m, r[2].slice(1), true);
    }
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (u.pathname === '/healthz') return send(res, 200, 'ok');
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let html; for (const f of [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')]) { try { html = await fsp.readFile(f); break; } catch (e) { } }
      if (!html) return send(res, 500, htmlPage('Setup error', 'public/index.html file is missing in your GitHub repo. Upload it inside a folder named <b>public</b>.'), { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(FRAME ? {} : { 'X-Frame-Options': 'DENY' }), 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors " + (FRAME || "'none'") });
    }
    return notFound(res);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof SyntaxError) return json(res, 400, { error: 'Bad request' });
    if (e.code === 413) return json(res, 413, { error: e.message });
    console.error(e); json(res, 500, { error: 'Server error' });
  }
});
server.requestTimeout = 120000;
server.listen(PORT, () => console.log('WebHosting running on :' + PORT + ' data=' + DATA + (BASE ? ' base=' + BASE : '')));
const bye = () => { for (const id of dirty) { const m = sites.get(id); if (m) try { saveMeta(m); } catch (e) { } } process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
