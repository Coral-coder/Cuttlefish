'use strict';
// SignalRGB account client. Signs into the user's own SignalRGB (Firebase)
// account using the client config read from their local install, then downloads
// the effects that account is entitled to. Entitlement is decided by SignalRGB's
// servers (free effects for any account; Pro/owned effects only if the account
// has them), so this can only ever retrieve what the signed-in user may have.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN = 'https://securetoken.googleapis.com/v1/token';
const CATALOG = 'https://catalog.signalrgb.com';
const SERVICES = 'https://services.signalrgb.com';

function doFetch(url, opts) {
  try {
    const { net } = require('electron');
    if (net && net.fetch) return net.fetch(url, opts);
  } catch { /* plain node */ }
  return fetch(url, opts);
}

class SignalRGBAccount extends EventEmitter {
  constructor({ config, effectsDir, cacheFile }) {
    super();
    this.config = config || {};
    this.effectsDir = effectsDir;
    this.cacheFile = cacheFile;
    this.auth = null; // { idToken, refreshToken, uid, email, expiresAt }
    this._load();
  }

  configured() {
    return !!(this.config && this.config.apiKey);
  }

  _load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c.refreshToken) this.auth = c;
    } catch { /* not signed in */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.auth || {}));
    } catch { /* ignore */ }
  }

  async _json(url, opts) {
    const res = await doFetch(url, opts);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = (body && body.error && (body.error.message || body.error)) || `HTTP ${res.status}`;
      const e = new Error(String(msg));
      e.status = res.status;
      throw e;
    }
    return body;
  }

  async signIn(email, password) {
    if (!this.configured()) throw new Error('SignalRGB config not found — run Import from SignalRGB first');
    const r = await this._json(`${IDENTITY}/accounts:signInWithPassword?key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    this.auth = {
      idToken: r.idToken,
      refreshToken: r.refreshToken,
      uid: r.localId,
      email: r.email,
      expiresAt: Date.now() + (Number(r.expiresIn) || 3600) * 1000,
    };
    this._save();
    this.emit('auth', { email: this.auth.email, uid: this.auth.uid });
    return { email: this.auth.email, uid: this.auth.uid };
  }

  signedIn() {
    return !!(this.auth && this.auth.refreshToken);
  }

  signOut() {
    this.auth = null;
    this._save();
    this.emit('auth', null);
  }

  async _token() {
    if (!this.signedIn()) throw new Error('Not signed in');
    if (this.auth.idToken && Date.now() < this.auth.expiresAt - 60000) return this.auth.idToken;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.auth.refreshToken });
    const r = await this._json(`${SECURETOKEN}?key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    this.auth.idToken = r.id_token || r.access_token;
    this.auth.refreshToken = r.refresh_token || this.auth.refreshToken;
    this.auth.uid = r.user_id || this.auth.uid;
    this.auth.expiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000;
    this._save();
    return this.auth.idToken;
  }

  // The signed-in user's document (library, entitlements) from Realtime DB.
  async userDoc() {
    const token = await this._token();
    const base = (this.config.databaseURL || '').replace(/\/$/, '');
    if (!base) throw new Error('No databaseURL in config');
    return this._json(`${base}/users/${this.auth.uid}.json?auth=${encodeURIComponent(token)}`);
  }

  // Public catalog of effects (metadata only).
  async catalog() {
    for (const name of ['catalog_en.json', 'releases_en.json']) {
      try {
        const data = await this._json(`${CATALOG}/${name}`);
        const list = Array.isArray(data) ? data : Object.entries(data).map(([id, v]) => ({ id, ...v }));
        if (list.length) return list;
      } catch { /* try next */ }
    }
    return [];
  }

  // Build the list of effects this account can install: free/force-free for
  // everyone, plus everything in the account's own library/entitlements.
  async library() {
    const cat = await this.catalog();
    const owned = new Set();
    let pro = false;
    if (this.signedIn()) {
      try {
        const doc = await this.userDoc();
        pro = !!(doc && (doc.subscriptions || (doc.roles && doc.roles.pro)));
        for (const key of ['purchased_fx', 'libraryItems', 'library', 'entitlements', 'perpetual_purchases', 'developer_fx', 'developed_effects']) {
          const v = doc && doc[key];
          if (!v) continue;
          for (const id of Array.isArray(v) ? v : Object.keys(v)) owned.add(typeof id === 'string' ? id : (id && id.id));
        }
      } catch (e) {
        this.emit('log', `Could not read account library: ${e.message}`);
      }
    }
    return cat.map((it) => {
      const id = it.id || it.effect_uid;
      const free = it.price === 0 && !it.requires_pro && !(it.included_with_pro && !it.force_free) || (it.tags && it.tags['force-free']);
      const entitled = free || owned.has(id) || (pro && (it.requires_pro || it.included_with_pro));
      return { id, name: it.name, publisher: it.publisher, description: it.description, downloads: it.downloads, rating: it.rating, type: it.type, image: it.image, free: !!free, entitled: !!entitled };
    }).filter((x) => x.id && x.name);
  }

  // Download one effect's HTML, if the server lets this account have it.
  async download(item) {
    const id = item.id;
    const token = this.signedIn() ? await this._token() : null;
    const auth = token ? { Authorization: `Bearer ${token}` } : {};
    const bucket = this.config.storageBucket || (this.config.projectId ? `${this.config.projectId}.appspot.com` : 'whirlwindengine.appspot.com');
    const store = (p) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(p)}?alt=media`;
    const tries = [
      { url: `${SERVICES}/effects/remote/${id}`, headers: auth },
      { url: store(`effects/${id}/effect.html`), headers: auth },
      { url: store(`releases/${id}/effect.html`), headers: auth },
      { url: `${SERVICES}/effects/${id}/effect.html`, headers: auth },
      { url: `${SERVICES}/cms/v2/effect/${id}/download`, headers: auth },
    ];
    let lastErr = null;
    for (const t of tries) {
      try {
        const res = await doFetch(t.url, { headers: t.headers });
        if (res.status === 403) throw new Error('not owned by this account');
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const html = await res.text();
        if (!/<(canvas|meta|html|script)/i.test(html)) { lastErr = new Error('not an effect'); continue; }
        const safe = String(item.name || id).replace(/[^\w .\-]+/g, '_').slice(0, 80);
        const dir = path.join(this.effectsDir, 'SignalRGB');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${safe}.html`);
        fs.writeFileSync(file, html);
        return { file, name: item.name };
      } catch (e) {
        lastErr = e;
        if (/not owned/.test(e.message)) break;
      }
    }
    throw lastErr || new Error('download failed');
  }

  // Download everything entitled (free + owned), skipping what's already there.
  async sync(onProgress) {
    const lib = await this.library();
    const want = lib.filter((x) => x.entitled);
    let ok = 0;
    let skipped = 0;
    const failed = [];
    for (let i = 0; i < want.length; i++) {
      const it = want[i];
      onProgress && onProgress({ i: i + 1, total: want.length, name: it.name });
      try {
        await this.download(it);
        ok++;
      } catch (e) {
        if (/not owned/.test(e.message)) skipped++; else failed.push(`${it.name}: ${e.message}`);
      }
    }
    return { installed: ok, skipped, failed, total: want.length };
  }

  status() {
    return {
      configured: this.configured(),
      signedIn: this.signedIn(),
      email: this.auth && this.auth.email,
      project: this.config && this.config.projectId,
    };
  }
}

module.exports = { SignalRGBAccount };
