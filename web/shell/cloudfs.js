/**
 * cloudfs.js — pluggable remote storage for the QGIS WebAssembly filesystem.
 *
 * Mounts object storage (S3 compatible, OpenStack Swift style, HTTP directory) into Emscripten's virtual filesystem
 * (default /cloud/<name>) so that *all* of QGIS —
 * the Browser panel, every open/save dialog, GDAL/OGR, QgsProject::write() — sees cloud data as ordinary files:
 *
 *   qgisCloud.mount({ type: 's3', name: 'gis', endpoint: 'https://s3.corp.example', bucket: 'gis-data', prefix: 'team/',
 *                     region: 'us-east-1', accessKeyId: '…', secretAccessKey: '…', pathStyle: true })
 *   qgisCloud.mount({ type: 'http', name: 'cdn', baseUrl: 'https://cdn.example/data/', index: 'index.json' })
 *
 * Design: the mount is a MEMFS tree whose directories are listed lazily (ListObjectsV2 / index.json) and whose file
 * contents are fetched lazily in ranged chunks on first read; writes are buffered and uploaded (PUT) when the file is
 * closed, unlink/rmdir/rename map to DELETE / COPY. Emscripten's FS is synchronous, so transfers use synchronous
 * XMLHttpRequest (QGIS calls the filesystem from the main thread and, proxied, from its worker threads). Signing is
 * AWS Signature V4 computed in JavaScript (UNSIGNED-PAYLOAD), compatible with S3, MinIO, Ceph RGW and friends.
 *
 * Backends implement: list(dirKey) → [{name, dir, size, mtime}], read(key, start, end) → Uint8Array, size(key),
 * write(key, bytes), remove(key), mkdir(key), copy(fromKey, toKey). Add new ones through qgisCloud.registerBackend().
 * Optional, asynchronous with progress: readAsync(key, onProgress) → Uint8Array, writeAsync(key, bytes, onProgress).
 *
 * The page can move big files around that synchronous filesystem asynchronously, so the tab keeps painting and
 * progress.js can show bytes and a rate (share.js uses both):
 *   await qgisCloud.prefetch(paths, { onProgress })      whole files into their nodes first; QGIS then reads memory
 *   qgisCloud.warm(path)                                 a directory listing ahead of the synchronous access (mount roots
 *                                                        are warmed at mount time); qgisCloud.forgetCors() resets 'auto'
 *   const lease = qgisCloud.writeBehind(folder)          files closed under <folder> wait in memory instead of a
 *   await lease.flush({ onProgress }); lease.release()   blocking PUT, and go up in parallel when the page says so
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- SHA-256 / HMAC (synchronous; SubtleCrypto is async)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const len = bytes.length, bitLen = len * 8;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000)); dv.setUint32(padded.length - 4, bitLen >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
        const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[i * 4] = h[i] >>> 24; out[i * 4 + 1] = (h[i] >>> 16) & 255; out[i * 4 + 2] = (h[i] >>> 8) & 255; out[i * 4 + 3] = h[i] & 255; }
    return out;
  }
  const enc = new TextEncoder();
  const utf8 = (s) => enc.encode(s);
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  function hmac(key, data) {
    if (key.length > 64) key = sha256(key);
    const k = new Uint8Array(64); k.set(key);
    const ipad = k.map((b) => b ^ 0x36), opad = k.map((b) => b ^ 0x5c);
    const inner = new Uint8Array(64 + data.length); inner.set(ipad); inner.set(data, 64);
    const ih = sha256(inner);
    const outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
    return sha256(outer);
  }

  // ---------------------------------------------------------------- synchronous HTTP
  // Synchronous XHR on the main thread cannot use responseType=arraybuffer: binary comes back as a "x-user-defined"
  // string (one char per byte). The main thread is where Emscripten's FS lives (workers proxy their syscalls to it).
  class HttpError extends Error { constructor(status, url, body) { super(`HTTP ${status} for ${url}${body ? ': ' + body.slice(0, 300) : ''}`); this.status = status; } }
  function request(method, url, { headers = {}, body = null, binary = true } = {}) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    if (binary) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    try {
      xhr.send(body);
    } catch (e) {
      // synchronous XHR throws a NetworkError DOMException when the request is blocked (CORS) or the server is unreachable
      throw new Error(`network error for ${method} ${url} (blocked by CORS or server unreachable): ${e.message}`);
    }
    if (xhr.status === 0) throw new Error(`network error for ${method} ${url} (blocked by CORS or server unreachable)`);
    const bytes = () => { const s = xhr.responseText || ''; const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; };
    if (xhr.status >= 400) throw new HttpError(xhr.status, url, binary ? new TextDecoder().decode(bytes()) : xhr.responseText);
    return { status: xhr.status, headers: (name) => xhr.getResponseHeader(name), bytes, text: () => (binary ? new TextDecoder().decode(bytes()) : xhr.responseText) };
  }
  // ---------------------------------------------------------------- asynchronous HTTP (page-driven transfers with progress)
  // onProgress(loaded, total): the upload side when there is a body, the download side otherwise.
  function requestAsync(method, url, { headers = {}, body = null, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.responseType = 'arraybuffer';
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      const report = (e) => { if (onProgress) onProgress(e.loaded, e.lengthComputable ? e.total : body ? body.byteLength : 0); };
      if (body != null) xhr.upload.onprogress = report; else xhr.onprogress = report;
      xhr.onerror = () => reject(new Error(`network error for ${method} ${url} (blocked by CORS or server unreachable)`));
      xhr.onabort = () => reject(new Error(`${method} ${url} aborted`));
      xhr.onload = () => {
        const bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
        if (xhr.status >= 400) reject(new HttpError(xhr.status, url, new TextDecoder().decode(bytes.subarray(0, 300))));
        else resolve({ status: xhr.status, headers: (name) => xhr.getResponseHeader(name), bytes: () => bytes });
      };
      try { xhr.send(body); } catch (e) { reject(new Error(`network error for ${method} ${url}: ${e.message}`)); }
    });
  }

  // ---------------------------------------------------------------- backends
  const backends = {};
  // Servers without CORS headers are reached through the same-origin proxy of scripts/serve.mjs (/proxy?url=…).
  // cfg.proxy: true → always via proxy; a prefix string ending in "url=" → that proxy; false → always direct;
  // 'auto' (default) → direct, and when the browser blocks a request (no CORS headers on that kind of response)
  // retry it through the proxy and keep using the proxy for that kind. Listing responses and object responses are
  // tracked separately: e.g. Swift staticweb directory pages carry no CORS headers while objects do.
  const PROXY_PREFIX = () => `${location.origin}/proxy?url=`;
  // What 'auto' learnt (direct or proxy, per origin and kind) is remembered in the browser for a few hours: a blocked
  // direct attempt costs a full round trip — a synchronous one blocks the main thread for the whole response — and
  // the answer does not change between page loads until the server's CORS configuration does.
  const CORS_MEMORY_MS = 6 * 3600 * 1000;
  const originOf = (cfg) => { try { return new URL(cfg.url || cfg.endpoint || cfg.baseUrl || '', location.href).origin; } catch (e) { return ''; } };
  const corsKey = (cfg) => `qgis-wasm.cloudfs.cors:${originOf(cfg)}`;
  const recallModes = (cfg) => {
    if (cfg.proxy !== 'auto' && cfg.proxy !== undefined) return;
    try {
      const m = JSON.parse(localStorage.getItem(corsKey(cfg)) || 'null');
      if (m && Date.now() - m.at < CORS_MEMORY_MS) { if (m.listing) cfg._modeListing = m.listing; if (m.object) cfg._modeObject = m.object; }
    } catch (e) { /* no storage */ }
  };
  const rememberMode = (cfg, kind, mode) => {
    if (cfg[kind] === mode) return;
    cfg[kind] = mode;
    console.log(`cloudfs: ${cfg.name || cfg.type}: ${kind === '_modeListing' ? 'listings' : 'objects'} — ${mode === 'proxy' ? 'blocked by CORS, using the same-origin /proxy' : 'direct access (CORS ok)'}`);
    try { localStorage.setItem(corsKey(cfg), JSON.stringify({ at: Date.now(), listing: cfg._modeListing || null, object: cfg._modeObject || null })); } catch (e) { /* no storage */ }
  };
  const forgetModes = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('qgis-wasm.cloudfs.cors:')) localStorage.removeItem(k); } catch (e) { /* ignore */ } };

  // Responses fetched ahead of time, asynchronously (sendAsync with warm: true), for the synchronous path: a directory
  // listing a mount warms at mount time is in hand when QGIS asks for it a second later, instead of blocking the
  // main thread for a round trip. One use each, and never older than a listing's TTL.
  const warm = new Map(); // "METHOD url" → { at, status, headers: {name → value}, bytes }
  const WARM_TTL_MS = 30000;
  const takeWarm = (method, url) => {
    const key = `${method} ${url}`;
    const w = warm.get(key);
    if (!w) return null;
    warm.delete(key);
    if (Date.now() - w.at > WARM_TTL_MS) return null;
    const bytes = () => w.bytes;
    return { status: w.status, headers: (name) => w.headers[String(name).toLowerCase()] ?? null, bytes, text: () => new TextDecoder().decode(w.bytes), warmed: true };
  };
  const keepWarm = (method, url, res) => {
    const headers = {};
    for (const n of ['content-length', 'content-type', 'etag', 'last-modified', 'x-container-object-count']) { const v = res.headers(n); if (v != null) headers[n] = v; }
    warm.set(`${method} ${url}`, { at: Date.now(), status: res.status, headers, bytes: res.bytes() });
  };

  const send = (cfg, method, url, opts = {}) => {
    const ready = takeWarm(method, url);
    if (ready) return ready;
    const explicit = cfg.proxy === true ? PROXY_PREFIX() : typeof cfg.proxy === 'string' && cfg.proxy !== 'auto' ? cfg.proxy : null;
    if (explicit) return request(method, explicit + encodeURIComponent(url), opts);
    if (cfg.proxy === false) return request(method, url, opts);
    const kind = /\?|\/$/.test(url) ? '_modeListing' : '_modeObject';
    if (cfg[kind] === 'proxy') return request(method, PROXY_PREFIX() + encodeURIComponent(url), opts);
    try {
      const res = request(method, url, opts);
      rememberMode(cfg, kind, 'direct');
      return res;
    } catch (e) {
      if (!/network error/.test(e.message)) throw e;
      rememberMode(cfg, kind, 'proxy');
      return request(method, PROXY_PREFIX() + encodeURIComponent(url), opts);
    }
  };

  const sendAsync = async (cfg, method, url, opts = {}) => { // the same proxy rules as send(), asynchronously
    const { warm: keep, ...rest } = opts;
    const done = (res) => { if (keep) keepWarm(method, url, res); return res; };
    const explicit = cfg.proxy === true ? PROXY_PREFIX() : typeof cfg.proxy === 'string' && cfg.proxy !== 'auto' ? cfg.proxy : null;
    if (explicit) return done(await requestAsync(method, explicit + encodeURIComponent(url), rest));
    if (cfg.proxy === false) return done(await requestAsync(method, url, rest));
    const kind = /\?|\/$/.test(url) ? '_modeListing' : '_modeObject';
    if (cfg[kind] === 'proxy') return done(await requestAsync(method, PROXY_PREFIX() + encodeURIComponent(url), rest));
    try {
      const res = await requestAsync(method, url, rest);
      rememberMode(cfg, kind, 'direct');
      return done(res);
    } catch (e) {
      if (!/network error/.test(e.message)) throw e;
      rememberMode(cfg, kind, 'proxy');
      return done(await requestAsync(method, PROXY_PREFIX() + encodeURIComponent(url), rest));
    }
  };

  // RFC 3986 encoding as AWS wants it (encodeURIComponent leaves !'()* alone)
  const awsEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  /** S3-compatible object storage (AWS S3, MinIO, Ceph RGW, …) with SigV4 signing or anonymous access. */
  class S3Backend {
    constructor(cfg) {
      this.cfg = cfg;
      this.endpoint = (cfg.endpoint || 'https://s3.amazonaws.com').replace(/\/+$/, '');
      this.bucket = cfg.bucket;
      this.prefix = (cfg.prefix || '').replace(/^\/+/, '');
      if (this.prefix && !this.prefix.endsWith('/')) this.prefix += '/';
      this.region = cfg.region || 'us-east-1';
      this.accessKeyId = cfg.accessKeyId || null;
      this.secretAccessKey = cfg.secretAccessKey || null;
      this.sessionToken = cfg.sessionToken || null;
      this.pathStyle = cfg.pathStyle !== false; // path-style works for every S3-compatible server; virtual-host needs DNS
      if (!this.bucket) throw new Error('s3 mount needs a bucket');
    }
    url(key, query) {
      const base = this.pathStyle ? `${this.endpoint}/${this.bucket}` : this.endpoint.replace('://', `://${this.bucket}.`);
      const path = key ? '/' + key.split('/').map(awsEncode).join('/') : '/';
      return base + path + (query ? '?' + query : '');
    }
    canonicalQuery(params) {
      return Object.keys(params).sort().map((k) => `${awsEncode(k)}=${awsEncode(params[k])}`).join('&');
    }
    sign(method, key, params, extraHeaders) {
      const url = new URL(this.url(key, this.canonicalQuery(params)));
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const date = amzDate.slice(0, 8);
      const headers = { host: url.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, ...extraHeaders };
      if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken;
      if (!this.accessKeyId) { delete headers.host; return { url: url.href, headers: { ...extraHeaders } }; } // anonymous
      const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
      const canonicalHeaders = names.map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim()}\n`).join('');
      const signedHeaders = names.join(';');
      const canonicalRequest = [method, url.pathname.replace(/%2F/gi, '/'), url.searchParams.toString() ? this.canonicalQuery(params) : '', canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
      const scope = `${date}/${this.region}/s3/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(sha256(utf8(canonicalRequest)))].join('\n');
      const kDate = hmac(utf8('AWS4' + this.secretAccessKey), utf8(date));
      const kRegion = hmac(kDate, utf8(this.region));
      const kService = hmac(kRegion, utf8('s3'));
      const kSigning = hmac(kService, utf8('aws4_request'));
      const signature = hex(hmac(kSigning, utf8(stringToSign)));
      const out = { ...headers };
      delete out.host; // the browser sets Host
      out.Authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      return { url: url.href, headers: out };
    }
    call(method, key, params = {}, headers = {}, body = null) {
      const s = this.sign(method, key, params, headers);
      return send(this.cfg, method, s.url, { headers: s.headers, body });
    }
    /** Fetch a directory's listing ahead of time (asynchronously) for the next synchronous list() of it */
    warm(dirKey = '') {
      const prefix = this.prefix + (dirKey ? dirKey.replace(/\/+$/, '') + '/' : '');
      const s = this.sign('GET', '', { 'list-type': '2', delimiter: '/', prefix, 'max-keys': '1000' });
      return sendAsync(this.cfg, 'GET', s.url, { headers: s.headers, warm: true });
    }
    list(dirKey) {
      const prefix = this.prefix + (dirKey ? dirKey.replace(/\/+$/, '') + '/' : '');
      const entries = [];
      let token = null;
      do {
        const params = { 'list-type': '2', delimiter: '/', prefix, 'max-keys': '1000' };
        if (token) params['continuation-token'] = token;
        const res = this.call('GET', '', params);
        const xml = new DOMParser().parseFromString(res.text(), 'application/xml');
        if (xml.querySelector('parsererror')) throw new Error('invalid ListObjectsV2 response');
        for (const cp of xml.getElementsByTagName('CommonPrefixes')) {
          const p = cp.getElementsByTagName('Prefix')[0].textContent;
          const name = p.slice(prefix.length).replace(/\/$/, '');
          if (name) entries.push({ name, dir: true, size: 0, mtime: 0 });
        }
        for (const c of xml.getElementsByTagName('Contents')) {
          const k = c.getElementsByTagName('Key')[0].textContent;
          const name = k.slice(prefix.length);
          if (!name || name.includes('/')) continue; // the directory marker itself
          const lm = c.getElementsByTagName('LastModified')[0];
          entries.push({ name, dir: false, size: Number(c.getElementsByTagName('Size')[0]?.textContent || 0), mtime: lm ? Date.parse(lm.textContent) : 0 });
        }
        const truncated = xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
        token = truncated ? xml.getElementsByTagName('NextContinuationToken')[0]?.textContent : null;
      } while (token);
      return entries;
    }
    read(key, start, end) {
      const res = this.call('GET', this.prefix + key, {}, { Range: `bytes=${start}-${end - 1}` });
      return res.bytes();
    }
    size(key) {
      const res = this.call('HEAD', this.prefix + key);
      return Number(res.headers('Content-Length') || 0);
    }
    write(key, bytes) { this.call('PUT', this.prefix + key, {}, { 'Content-Type': 'application/octet-stream' }, bytes); }
    writeAsync(key, bytes, onProgress) { const s = this.sign('PUT', this.prefix + key, {}, { 'Content-Type': 'application/octet-stream' }); return sendAsync(this.cfg, 'PUT', s.url, { headers: s.headers, body: bytes, onProgress }); }
    async readAsync(key, onProgress) { const s = this.sign('GET', this.prefix + key, {}, {}); return (await sendAsync(this.cfg, 'GET', s.url, { headers: s.headers, onProgress })).bytes(); }
    remove(key) { this.call('DELETE', this.prefix + key); }
    mkdir(key) { this.call('PUT', this.prefix + key.replace(/\/+$/, '') + '/', {}, {}, new Uint8Array(0)); }
    rmdir(key) { try { this.call('DELETE', this.prefix + key.replace(/\/+$/, '') + '/'); } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; } }
    copy(fromKey, toKey) {
      const source = '/' + this.bucket + '/' + (this.prefix + fromKey).split('/').map(awsEncode).join('/');
      this.call('PUT', this.prefix + toKey, {}, { 'x-amz-copy-source': source });
    }
  }
  backends.s3 = (cfg) => new S3Backend(cfg);

  /** Read-only HTTP(S) directory described by a JSON index: {"files": [{"path": "a/b.gpkg", "size": 123}, …]} (or a plain array). */
  class HttpBackend {
    constructor(cfg) {
      this.cfg = cfg;
      this.baseUrl = (cfg.baseUrl || cfg.url || '').replace(/\/+$/, '') + '/';
      this.indexUrl = cfg.index ? new URL(cfg.index, this.baseUrl).href : this.baseUrl + 'index.json';
      this.files = null;
      if (Array.isArray(cfg.files)) this.index(cfg.files); // index already in hand (the shell passes qgis.lazy.json)
    }
    warm() { return this.files ? Promise.resolve() : sendAsync(this.cfg, 'GET', this.indexUrl, { warm: true }); }
    load() {
      if (this.files) return;
      const res = send(this.cfg, 'GET', this.indexUrl, { binary: false });
      const json = JSON.parse(res.text());
      this.index(Array.isArray(json) ? json : json.files || []);
    }
    index(list) {
      this.files = new Map();
      for (const f of list) {
        const path = (typeof f === 'string' ? f : f.path || f.name).replace(/^\/+/, '');
        this.files.set(path, { size: typeof f === 'object' ? Number(f.size || 0) : 0, url: typeof f === 'object' && f.url ? f.url : this.baseUrl + path.split('/').map(encodeURIComponent).join('/'), mtime: typeof f === 'object' && f.mtime ? Date.parse(f.mtime) : 0 });
      }
    }
    list(dirKey) {
      this.load();
      const prefix = dirKey ? dirKey.replace(/\/+$/, '') + '/' : '';
      const seen = new Map();
      for (const [path, info] of this.files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) seen.set(rest, { name: rest, dir: false, size: info.size, mtime: info.mtime });
        else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), dir: true, size: 0, mtime: 0 });
      }
      return [...seen.values()];
    }
    entry(key) { this.load(); const e = this.files.get(key); if (!e) throw new Error(`not in index: ${key}`); return e; }
    read(key, start, end) {
      const e = this.entry(key);
      // a whole-file read goes without Range, so the server may answer with its pre-compressed (.br/.gz) copy
      const headers = start === 0 && e.size > 0 && end >= e.size ? {} : { Range: `bytes=${start}-${end - 1}` };
      return send(this.cfg, 'GET', e.url, { headers }).bytes();
    }
    size(key) {
      const e = this.entry(key);
      if (e.size) return e.size;
      const res = send(this.cfg, 'HEAD', e.url);
      e.size = Number(res.headers('Content-Length') || 0);
      return e.size;
    }
    async readAsync(key, onProgress) { const e = this.entry(key); return (await sendAsync(this.cfg, 'GET', e.url, { onProgress })).bytes(); }
    write() { throw new Error('read-only mount'); }
    remove() { throw new Error('read-only mount'); }
    mkdir() { throw new Error('read-only mount'); }
    rmdir() { throw new Error('read-only mount'); }
    copy() { throw new Error('read-only mount'); }
  }
  backends.http = (cfg) => new HttpBackend(cfg);

  /**
   * OpenStack Swift style object store (also the internal "S3-like" systems with /v1/AUTH_<account>/<container>/<object>
   * URLs): anonymous or X-Auth-Token access, JSON container listings, Range reads, PUT/DELETE/COPY.
   *   { type: 'swift', name: 'shared', url: 'https://host/v1/AUTH_account/container', prefix: '', token: '', proxy: true, listMode: 'html' | 'json' (optional) }
   */
  class SwiftBackend {
    constructor(cfg) {
      this.cfg = cfg;
      this.container = (cfg.url || cfg.endpoint || '').replace(/\/+$/, '');
      if (!this.container) throw new Error('swift mount needs url (…/v1/AUTH_<account>/<container>)');
      this.containerName = this.container.split('/').pop();
      this.prefix = (cfg.prefix || '').replace(/^\/+/, '');
      // listMode 'html' for a staticweb container: lists its index pages straight away — the JSON listing probe would be
      // answered with a redirect or without CORS headers, one red line in the console / Debug view at every start
      this.listMode = cfg.listMode === 'html' || cfg.listMode === 'json' ? cfg.listMode : null;
      if (this.prefix && !this.prefix.endsWith('/')) this.prefix += '/';
      this.token = cfg.token || null;
    }
    headers(extra = {}) { return this.token ? { 'X-Auth-Token': this.token, ...extra } : { ...extra }; }
    objectUrl(key) { return this.container + '/' + key.split('/').map(encodeURIComponent).join('/'); }
    call(method, url, headers = {}, body = null, binary = true) { return send(this.cfg, method, url, { headers: this.headers(headers), body, binary }); }
    // Swift "staticweb" containers (X-Container-Meta-Web-Listings) answer anonymous listing requests with an HTML
    // directory page (and a 301 to the trailing-slash URL) instead of the JSON API: parse that page instead.
    listHtml(prefix) {
      const html = this.call('GET', this.htmlUrl(prefix), {}, null, false).text(); // (an explicit Accept: text/html makes staticweb answer 406)
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const entries = [];
      for (const row of doc.querySelectorAll('tr.item')) {
        if (row.id === 'parent') continue;
        const a = row.querySelector('td.colname a');
        if (!a) continue;
        const text = (a.textContent || '').trim();
        if (!text || text === '../') continue;
        if (row.classList.contains('subdir') || text.endsWith('/')) entries.push({ name: text.replace(/\/$/, ''), dir: true, size: 0, mtime: 0 });
        else {
          const size = Number((row.querySelector('td.colsize') || {}).textContent || 0) || 0;
          const date = ((row.querySelector('td.coldate') || {}).textContent || '').trim();
          entries.push({ name: text, dir: false, size, mtime: date ? Date.parse(date.replace(' ', 'T') + 'Z') || 0 : 0 });
        }
      }
      return entries;
    }
    htmlUrl(prefix) { return this.container + '/' + prefix.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (prefix ? '/' : ''); }
    jsonUrl(prefix, marker = '') { return `${this.container}?format=json&delimiter=%2F&prefix=${encodeURIComponent(prefix)}` + (marker ? `&marker=${encodeURIComponent(marker)}` : ''); }
    /** Fetch a directory's listing ahead of time (asynchronously) for the next synchronous list() of it */
    warm(dirKey = '') {
      const prefix = this.prefix + (dirKey ? dirKey.replace(/\/+$/, '') + '/' : '');
      return sendAsync(this.cfg, 'GET', this.listMode === 'html' ? this.htmlUrl(prefix) : this.jsonUrl(prefix), { headers: this.headers(), warm: true });
    }
    list(dirKey) {
      const prefix = this.prefix + (dirKey ? dirKey.replace(/\/+$/, '') + '/' : '');
      if (this.listMode === 'html') return this.listHtml(prefix); // learnt on the first listing: no JSON attempt first
      const entries = [];
      let marker = '';
      for (;;) {
        let text;
        try {
          text = this.call('GET', this.jsonUrl(prefix, marker), {}, null, false).text();
        } catch (e) {
          if (e instanceof HttpError && (e.status === 301 || e.status === 302 || e.status === 404)) { this.listMode = 'html'; return this.listHtml(prefix); }
          throw e;
        }
        if (/^\s*</.test(text)) { this.listMode = 'html'; return this.listHtml(prefix); } // HTML listing page → staticweb mode
        const page = JSON.parse(text || '[]');
        for (const e of page) {
          if (e.subdir) {
            const name = e.subdir.slice(prefix.length).replace(/\/$/, '');
            if (name) entries.push({ name, dir: true, size: 0, mtime: 0 });
          } else if (e.name) {
            const name = e.name.slice(prefix.length);
            if (!name || name.includes('/')) continue;
            if (e.content_type === 'application/directory' && !e.bytes) { entries.push({ name, dir: true, size: 0, mtime: 0 }); continue; }
            entries.push({ name, dir: false, size: Number(e.bytes || 0), mtime: e.last_modified ? Date.parse(e.last_modified + (e.last_modified.endsWith('Z') ? '' : 'Z')) : 0 });
          }
        }
        if (page.length < 10000) break;
        marker = page[page.length - 1].name || page[page.length - 1].subdir;
      }
      // a directory marker object and a real prefix may both exist: de-duplicate
      const seen = new Set();
      return entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
    }
    read(key, start, end) { return this.call('GET', this.objectUrl(this.prefix + key), { Range: `bytes=${start}-${end - 1}` }).bytes(); }
    size(key) { return Number(this.call('HEAD', this.objectUrl(this.prefix + key)).headers('Content-Length') || 0); }
    write(key, bytes) { this.call('PUT', this.objectUrl(this.prefix + key), { 'Content-Type': 'application/octet-stream' }, bytes); }
    writeAsync(key, bytes, onProgress) { return sendAsync(this.cfg, 'PUT', this.objectUrl(this.prefix + key), { headers: this.headers({ 'Content-Type': 'application/octet-stream' }), body: bytes, onProgress }); }
    async readAsync(key, onProgress) { return (await sendAsync(this.cfg, 'GET', this.objectUrl(this.prefix + key), { headers: this.headers(), onProgress })).bytes(); }
    remove(key) { try { this.call('DELETE', this.objectUrl(this.prefix + key)); } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; } }
    mkdir(key) { this.call('PUT', this.objectUrl(this.prefix + key.replace(/\/+$/, '')), { 'Content-Type': 'application/directory' }, new Uint8Array(0)); }
    rmdir(key) { this.remove(key.replace(/\/+$/, '')); }
    copy(fromKey, toKey) {
      this.call('PUT', this.objectUrl(this.prefix + toKey), { 'X-Copy-From': '/' + this.containerName + '/' + (this.prefix + fromKey).split('/').map(encodeURIComponent).join('/') }, new Uint8Array(0));
    }
  }
  backends.swift = (cfg) => new SwiftBackend(cfg);

  // ---------------------------------------------------------------- the Emscripten filesystem
  const CHUNK = 4 * 1024 * 1024;        // ranged read size
  const WHOLE_FILE_LIMIT = 16 * 1024 * 1024; // smaller files are fetched in one go
  const LIST_TTL_MS = 30000;

  function createCloudFS(FS, MEMFS, log) {
    const EIO = 29, ENOENT = 44, EROFS = 69, ENOTEMPTY = 55;
    const perm = (op, node) => () => { try { return op(); } catch (e) { log(`cloudfs: ${e.message}`); throw new FS.ErrnoError(e instanceof HttpError && e.status === 404 ? ENOENT : /read-only/.test(e.message) ? EROFS : EIO); } };

    const keyOf = (node) => {
      // path relative to the mount root, '' for the root itself
      const parts = [];
      for (let n = node; n && !(n.mount && n.mount.root === n); n = n.parent) parts.unshift(n.name);
      return parts.join('/');
    };
    const backendOf = (node) => node.mount.opts.backend;

    const ensureListed = (dirNode) => {
      const now = Date.now();
      if (dirNode.cloudListed && now - dirNode.cloudListed < LIST_TTL_MS) return;
      perm(() => {
        const entries = backendOf(dirNode).list(keyOf(dirNode));
        const seen = new Set();
        for (const e of entries) {
          seen.add(e.name);
          let child = dirNode.contents[e.name];
          if (!child) {
            child = CLOUDFS.createNode(dirNode, e.name, e.dir ? 0o40777 : 0o100666, 0);
          }
          if (!e.dir && !child.cloudDirty && !child.cloudLocal && !child.cloudLoaded) { child.cloudSize = e.size > 0 ? e.size : undefined; child.usedBytes = e.size > 0 ? e.size : (child.usedBytes || 0); if (!(e.size > 0)) { child.cloudLoaded = false; child.cloudChunks = undefined; } }
          child.cloudPlanted = false; // the listing confirmed it
          if (e.mtime) child.mtime = e.mtime;
        }
        // drop entries that disappeared remotely (unless they hold unsaved local changes)
        for (const name of Object.keys(dirNode.contents)) {
          const child = dirNode.contents[name];
          if (!seen.has(name) && !child.cloudDirty && !child.cloudLocal && !child.cloudPlanted) { FS.hashRemoveNode(child); delete dirNode.contents[name]; }
        }
        dirNode.cloudListed = Date.now();
      })();
    };

    // size of a remote file: from the directory listing, or (listing said 0 / unknown) from a HEAD request
    const sizeOf = (node) => {
      if (node.cloudDirty || node.cloudLocal) return node.usedBytes || 0;
      if (node.cloudSize === undefined) {
        node.cloudSize = perm(() => backendOf(node).size(keyOf(node)))();
        node.usedBytes = node.cloudSize;
      }
      return node.cloudSize;
    };

    const ensureRange = (node, start, end) => {
      // make bytes [start, end) of a lazily loaded file available in node.contents
      if (node.cloudDirty || node.cloudLoaded) return;
      const size = sizeOf(node);
      end = Math.min(end, size);
      if (!node.cloudChunks) { node.cloudChunks = new Set(); node.contents = new Uint8Array(size); node.usedBytes = size; }
      if (size <= WHOLE_FILE_LIMIT) {
        if (size > 0) node.contents.set(perm(() => backendOf(node).read(keyOf(node), 0, size))().subarray(0, size));
        node.cloudLoaded = true;
        return;
      }
      for (let c = Math.floor(start / CHUNK); c * CHUNK < end; c++) {
        if (node.cloudChunks.has(c)) continue;
        const from = c * CHUNK, to = Math.min(size, from + CHUNK);
        node.contents.set(perm(() => backendOf(node).read(keyOf(node), from, to))().subarray(0, to - from), from);
        node.cloudChunks.add(c);
      }
      if (node.cloudChunks.size * CHUNK >= size) node.cloudLoaded = true;
    };

    // ---- page-driven asynchronous transfers (progress.js shows them); the filesystem itself stays synchronous
    const leases = new Set(); // directory nodes under which closed files wait for lease.flush() instead of a blocking PUT
    const deferredFor = (node) => { if (!leases.size) return null; for (let n = node; n; n = n.parent) { if (leases.has(n)) return n; if (n.mount && n.mount.root === n) break; } return null; };
    const sum = (m) => { let s = 0; for (const v of m.values()) s += v; return s; };
    const pool = async (items, parallel, fn) => { const q = items.slice(); await Promise.all(Array.from({ length: Math.min(parallel, q.length) }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); })); };
    /** Files closed under <path> stay in memory (dirty) until flush() uploads them asynchronously; release() ends the lease */
    function writeBehind(path) {
      FS.mkdirTree(path);
      const dir = FS.lookupPath(path, { follow: true }).node;
      if (!backendOf(dir).writeAsync) throw new Error(`${path}: this mount cannot upload asynchronously`);
      leases.add(dir);
      const pending = () => { const out = []; const walk = (n) => { for (const c of Object.values(n.contents || {})) { if (FS.isDir(c.mode)) walk(c); else if (c.cloudDirty) out.push(c); } }; walk(dir); return out; };
      let released = false;
      return {
        path, pending,
        /** upload everything written so far, in parallel → { files, bytes }; onProgress({ done, total, file, files, finished }) counts bytes */
        async flush({ onProgress, parallel = 2 } = {}) {
          const nodes = pending();
          const total = nodes.reduce((s, n) => s + (n.usedBytes || 0), 0), sent = new Map();
          let finished = 0;
          const report = (file) => onProgress && onProgress({ done: sum(sent), total, file, files: nodes.length, finished });
          await pool(nodes, parallel, async (n) => {
            const data = MEMFS.getFileDataAsTypedArray(n), key = keyOf(n);
            await backendOf(n).writeAsync(key, data, (loaded) => { sent.set(n, Math.min(loaded, data.length)); report(n.name); });
            sent.set(n, data.length); n.cloudDirty = false; n.cloudPending = false; n.cloudUploaded = true; n.cloudLoaded = true; finished++;
            log(`cloudfs: uploaded ${key} (${data.length} bytes, asynchronously)`); report(n.name);
          });
          return { files: nodes.length, bytes: total };
        },
        /** stop deferring; whatever is still pending goes up synchronously, so nothing is ever left behind */
        release() {
          if (released) return; released = true; leases.delete(dir);
          for (const n of pending()) { try { backendOf(n).write(keyOf(n), MEMFS.getFileDataAsTypedArray(n)); n.cloudDirty = false; n.cloudPending = false; n.cloudUploaded = true; } catch (e) { log(`cloudfs: ${keyOf(n)} is still not uploaded: ${e.message}`); } }
        },
      };
    }
    /** Declare that <path> exists on its mount (size if known) without listing any directory: the nodes are created
     *  as "planted" and confirmed or corrected by the next listing. A snapshot's manifest knows its files. */
    function plant(path, { size, dir = false } = {}) {
      const mountPath = [...mounts.values()].map((m) => m.path).find((p) => path === p || path.startsWith(p + '/'));
      if (!mountPath) throw new Error(`${path} is not on a cloud mount`);
      let node = FS.lookupPath(mountPath, { follow: true }).node;
      const parts = path.slice(mountPath.length).split('/').filter(Boolean);
      parts.forEach((name, i) => {
        let child = node.contents[name];
        const last = i === parts.length - 1;
        if (!child) { child = CLOUDFS.createNode(node, name, last && !dir ? 0o100666 : 0o40777, 0); child.cloudPlanted = true; if (last && !dir) { child.cloudSize = size > 0 ? size : undefined; child.usedBytes = size > 0 ? size : 0; } }
        node = child;
      });
      return node;
    }
    /** Download whole files into their nodes asynchronously (QGIS then reads them from memory) → { files, bytes }.
     *  Items: paths, or { path, size } to skip the size request (planted when the directory was never listed). */
    async function prefetch(items, { onProgress, parallel = 3 } = {}) {
      const nodes = [];
      for (const it of items) {
        const p = typeof it === 'string' ? it : it.path;
        try {
          const n = typeof it === 'object' ? plant(p, { size: it.size }) : FS.lookupPath(p, { follow: true }).node; // an object item: declared, no listing
          if (FS.isFile(n.mode) && !n.cloudDirty && !n.cloudLoaded && backendOf(n).readAsync) nodes.push(n);
        } catch (e) { /* missing: QGIS reports it when it opens the project */ }
      }
      const sizes = new Map(nodes.map((n) => { let s = n.cloudSize; if (s === undefined && !n.cloudPlanted) { try { s = sizeOf(n); } catch (e) { /* unknown until read */ } } return [n, s || 0]; })), got = new Map();
      const total = sum(sizes);
      let finished = 0;
      const report = (file) => onProgress && onProgress({ done: sum(got), total, file, files: nodes.length, finished });
      await pool(nodes, parallel, async (n) => {
        if (n.cloudLoaded || n.cloudDirty) { finished++; return; } // QGIS got there first
        const size = sizes.get(n) || 0;
        const bytes = await backendOf(n).readAsync(keyOf(n), (loaded) => { got.set(n, size ? Math.min(loaded, size) : loaded); report(n.name); });
        if (!n.cloudLoaded && !n.cloudDirty) { n.contents = bytes; n.usedBytes = bytes.length; n.cloudSize = bytes.length; n.cloudLoaded = true; n.cloudChunks = undefined; }
        got.set(n, bytes.length); finished++; report(n.name);
      });
      return { files: nodes.length, bytes: total };
    }

    const CLOUDFS = {
      mount(mount) {
        const root = CLOUDFS.createNode(null, '/', 0o40777, 0);
        return root;
      },
      createNode(parent, name, mode, dev) {
        const node = MEMFS.createNode(parent, name, mode, dev);
        if (FS.isDir(mode)) {
          node.node_ops = CLOUDFS.dirOps;
          node.stream_ops = CLOUDFS.dirStreamOps;
        } else if (FS.isFile(mode)) {
          node.node_ops = CLOUDFS.fileOps;
          node.stream_ops = CLOUDFS.fileStreamOps;
        }
        return node;
      },
    };
    CLOUDFS.dirOps = {
      ...MEMFS.node_ops,
      lookup(parent, name) {
        const known = parent.contents[name];
        if (known && (known.cloudLocal || known.cloudDirty || known.cloudPlanted)) return known; // ours, or declared by the page: no listing round trip
        ensureListed(parent);
        const n = parent.contents[name]; if (!n) throw new FS.ErrnoError(ENOENT); return n;
      },
      readdir(node) { ensureListed(node); return ['.', '..', ...Object.keys(node.contents)]; },
      mknod(parent, name, mode, dev) {
        const node = CLOUDFS.createNode(parent, name, mode, dev);
        if (FS.isDir(mode)) { perm(() => backendOf(parent).mkdir(keyOf(node)))(); node.cloudListed = Date.now(); }
        else { node.cloudLocal = true; node.cloudLoaded = true; node.cloudDirty = true; node.cloudSize = 0; }
        return node;
      },
      unlink(parent, name) {
        const node = parent.contents[name];
        if (node && !node.cloudLocal) perm(() => backendOf(parent).remove(keyOf(node)))();
        else if (node && node.cloudLocal && node.cloudUploaded) perm(() => backendOf(parent).remove(keyOf(node)))();
        MEMFS.node_ops.unlink(parent, name);
      },
      rmdir(parent, name) {
        const node = parent.contents[name];
        ensureListed(node);
        for (const _ in node.contents) throw new FS.ErrnoError(ENOTEMPTY);
        perm(() => backendOf(parent).rmdir(keyOf(node)))();
        MEMFS.node_ops.rmdir(parent, name);
      },
      rename(oldNode, newDir, newName) {
        if (FS.isDir(oldNode.mode)) throw new FS.ErrnoError(EIO); // directory renames are not supported on object storage
        const backend = backendOf(oldNode);
        if (newDir.mount !== oldNode.mount) throw new FS.ErrnoError(EIO);
        const fromKey = keyOf(oldNode);
        const toKey = (keyOf(newDir) ? keyOf(newDir) + '/' : '') + newName;
        const deferred = oldNode.cloudDirty && deferredFor(oldNode) && deferredFor(newDir); // stays in memory; the lease's flush uploads it under the new name
        perm(() => {
          if (deferred) { if (!oldNode.cloudLocal || oldNode.cloudUploaded) backend.remove(fromKey); return; }
          if (oldNode.cloudDirty) { ensureRange(oldNode, 0, oldNode.usedBytes); backend.write(toKey, MEMFS.getFileDataAsTypedArray(oldNode)); oldNode.cloudDirty = false; }
          else backend.copy(fromKey, toKey);
          if (!oldNode.cloudLocal || oldNode.cloudUploaded) backend.remove(fromKey);
        })();
        if (deferred) { oldNode.cloudLocal = true; oldNode.cloudUploaded = false; oldNode.cloudPending = true; }
        else oldNode.cloudUploaded = true;
        MEMFS.node_ops.rename(oldNode, newDir, newName);
      },
    };
    CLOUDFS.dirStreamOps = { ...MEMFS.stream_ops };
    CLOUDFS.fileOps = {
      ...MEMFS.node_ops,
      getattr(node) { const a = MEMFS.node_ops.getattr(node); if (!node.cloudDirty && !node.cloudLocal) a.size = sizeOf(node); return a; },
      setattr(node, attr) {
        if (attr.size !== undefined) { ensureRange(node, 0, sizeOf(node)); node.cloudDirty = true; node.cloudLoaded = true; MEMFS.resizeFileStorage(node, attr.size); node.cloudSize = attr.size; }
        const rest = { ...attr }; delete rest.size;
        MEMFS.node_ops.setattr(node, rest);
      },
    };
    CLOUDFS.fileStreamOps = {
      ...MEMFS.stream_ops,
      open(stream) {
        const node = stream.node;
        const O_TRUNC = 512, O_WRONLY = 1, O_RDWR = 2;
        if (stream.flags & O_TRUNC) { node.contents = new Uint8Array(0); node.usedBytes = 0; node.cloudSize = 0; node.cloudLoaded = true; node.cloudDirty = true; }
        else if ((stream.flags & (O_WRONLY | O_RDWR)) && !node.cloudLoaded) ensureRange(node, 0, sizeOf(node)); // read-modify-write needs the content
      },
      read(stream, buffer, offset, length, position) {
        ensureRange(stream.node, position, position + length);
        return MEMFS.stream_ops.read(stream, buffer, offset, length, position);
      },
      write(stream, buffer, offset, length, position, canOwn) {
        const node = stream.node;
        if (!node.cloudLoaded) ensureRange(node, 0, sizeOf(node));
        node.cloudDirty = true;
        const n = MEMFS.stream_ops.write(stream, buffer, offset, length, position, false);
        node.cloudSize = node.usedBytes;
        return n;
      },
      close(stream) {
        const node = stream.node;
        if (!node.cloudDirty) return;
        if (deferredFor(node)) { node.cloudPending = true; return; } // a writeBehind lease uploads it asynchronously (flush)
        perm(() => backendOf(node).write(keyOf(node), MEMFS.getFileDataAsTypedArray(node)))();
        node.cloudDirty = false; node.cloudPending = false; node.cloudUploaded = true; node.cloudLoaded = true;
        log(`cloudfs: uploaded ${stream.path} (${node.usedBytes} bytes)`);
      },
      mmap(stream, length, position, prot, flags) { ensureRange(stream.node, position, position + length); return MEMFS.stream_ops.mmap(stream, length, position, prot, flags); },
    };
    CLOUDFS.writeBehind = writeBehind; CLOUDFS.prefetch = prefetch; CLOUDFS.plant = plant;
    return CLOUDFS;
  }

  // ---------------------------------------------------------------- public API
  const mounts = new Map();
  let cloudfs = null, FS = null, logger = (m) => console.log(m);
  const api = {
    ROOT: '/cloud',
    backends,
    registerBackend(type, factory) { backends[type] = factory; },
    /** Attach to the Emscripten module (called by the shell once the module is created) */
    init(module, log) {
      FS = module.FS;
      logger = log || logger;
      cloudfs = createCloudFS(FS, FS.filesystems.MEMFS, logger);
      FS.mkdirTree(api.ROOT);
    },
    /** Mount a remote store at /cloud/<name> (or at cfg.path). cfg.internal hides it from list(). Returns the mount path. */
    mount(cfg) {
      if (!cloudfs) throw new Error('cloudfs not initialised');
      const name = (cfg.name || cfg.bucket || cfg.type).replace(/[^A-Za-z0-9._-]/g, '_');
      const factory = backends[cfg.type];
      if (!factory) throw new Error(`unknown mount type '${cfg.type}' (known: ${Object.keys(backends).join(', ')})`);
      const path = cfg.path || `${api.ROOT}/${name}`;
      if (mounts.has(name)) api.unmount(name);
      recallModes(cfg);
      const backend = factory(cfg);
      FS.mkdirTree(path);
      FS.mount(cloudfs, { backend, config: cfg }, path);
      mounts.set(name, { path, config: { ...cfg, secretAccessKey: cfg.secretAccessKey ? '***' : undefined }, backend });
      logger(`cloudfs: mounted ${cfg.type} at ${path}`);
      // the root listing, ahead of QGIS: the Browser panel's favourites and the file dialogs ask for it right after start
      if (cfg.warm !== false && typeof backend.warm === 'function') backend.warm('').catch(() => {});
      return path;
    },
    unmount(name) {
      const m = mounts.get(name);
      if (!m) return false;
      FS.unmount(m.path);
      FS.rmdir(m.path);
      mounts.delete(name);
      return true;
    },
    list() { return [...mounts.entries()].filter(([, m]) => !m.config.internal).map(([name, m]) => ({ name, path: m.path, type: m.config.type, config: m.config })); },
    /** Download whole files into memory asynchronously, with progress, before QGIS opens them (share.js: ?share=) */
    prefetch(items, opts) { if (!cloudfs) throw new Error('cloudfs not initialised'); return cloudfs.prefetch(items, opts); },
    /** Fetch a directory listing of a mount ahead of time (path under /cloud/<name>) so the next synchronous access has it */
    warm(path) { for (const m of mounts.values()) if (path === m.path || path.startsWith(m.path + '/')) return typeof m.backend.warm === 'function' ? m.backend.warm(path.slice(m.path.length + 1)) : Promise.resolve(); return Promise.resolve(); },
    /** Forget what 'auto' learnt about CORS (e.g. after the server's configuration changed) */
    forgetCors: forgetModes,
    /** Declare a file (or directory) that exists on a mount, so that reaching it needs no directory listing */
    plant(path, opts) { if (!cloudfs) throw new Error('cloudfs not initialised'); return cloudfs.plant(path, opts); },
    /** Files closed under <folder> wait in memory; lease.flush({ onProgress }) uploads them asynchronously, lease.release() ends it */
    writeBehind(folder) { if (!cloudfs) throw new Error('cloudfs not initialised'); return cloudfs.writeBehind(folder); },
    /** Force a fresh directory listing on next access */
    refresh(path) { try { const node = FS.lookupPath(path, { follow: true }).node; node.cloudListed = 0; } catch (e) { /* ignore */ } },
    _internal: { sha256, hmac, hex, request, S3Backend, HttpBackend, SwiftBackend },
  };
  window.qgisCloud = api;
})();
