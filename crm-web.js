(function(){
/**
 * Surreal CRM — the three-station pipeline behind the Outreach page (v1.4.0).
 *
 *   brands : Brand deals (seeding-tier freebies → partnership-tier paid work)
 *   video  : Verified video projects (real estate, cars, bigger productions)
 *   stays  : Stayamo + travel collabs
 *
 * WHY ITS OWN STORE: the finance doc (data.json) syncs as a whole document,
 * last-writer-wins. Any device holding a stale copy of that doc in memory
 * (a v1.2.0 Mac logging a gym day, say) overwrote the outreach targets and
 * the cloud faithfully spread the deletion. That is how the Stayamo drafts
 * "kept getting deleted". The CRM now lives in crm.json + cloud key 'crm'
 * and merges PER RECORD (newest updatedAt wins, tombstones for deletes), so
 * no whole-doc write anywhere can touch it.
 *
 * GUARDRAIL: this module drafts and tracks. It has no way to send anything.
 * Stayamo requests go out from the renderer through the in-app Stayamo webview
 * (index.html, stayamoRun), never from this store.
 */


const STATIONS = {
  brands: {
    label: 'Brand Deals',
    stages: ['lead', 'pitched', 'talking', 'deal', 'delivered', 'paid', 'lost'],
    stageLabels: { lead: 'Lead', pitched: 'Pitched', talking: 'In Talks', deal: 'Deal', delivered: 'Delivered', paid: 'Paid', lost: 'Lost' },
    tiers: ['seed', 'partner'],
  },
  video: {
    label: 'Video Projects',
    stages: ['lead', 'quoted', 'booked', 'shooting', 'editing', 'delivered', 'paid', 'lost'],
    stageLabels: { lead: 'Lead', quoted: 'Quoted', booked: 'Booked', shooting: 'Shooting', editing: 'Editing', delivered: 'Delivered', paid: 'Paid', lost: 'Lost' },
    tiers: [],
  },
  stays: {
    label: 'Stays & Travel',
    stages: ['found', 'drafted', 'sent', 'replied', 'booked', 'stayed', 'skipped'],
    stageLabels: { found: 'Found', drafted: 'Draft Ready', sent: 'Sent', replied: 'Replied', booked: 'Booked', stayed: 'Stayed', skipped: 'Skipped' },
    tiers: [],
  },
};

const DEFAULT_CONFIG = {
  autoSend: false,          // emails: the app drafts, Carson sends from Gmail
  // Stayamo is the one exception (Carson, 2026-09-15): the Outreach page searches,
  // drafts and sends collab requests itself. perRun caps one run; the site's own
  // monthly quota (15 base / 30 premium) is the hard stop.
  stays: { autoSend: true, perRun: 5, radiusKm: 60, when: 'A weekday stay next month, flexible on exact dates' },
  gmailAccounts: ['carbes04@gmail.com', 'surrealrider@gmail.com'],
  voice: {
    tone: 'warm, direct, confident, no corporate stiffness',
    banned: ['—', 'elevate', 'leverage', 'seamless', 'cutting-edge'],
    credential: 'Recent work includes a campaign for Cold Soup that ran at Kemo Sabe during Sundance 2024.',
    bio: 'Lifestyle and brand photographer and videographer. Cars, motorcycles, travel, real estate, product. Biker; shot a modeled series around an RX-7 styled after Initial D.',
  },
};

function noEmDash(s) { return typeof s === 'string' ? s.replace(/—/g, ',').replace(/ ,/g, ',') : s; }
function newId() { return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function emptyDoc() {
  return { version: 1, records: {}, tombstones: {}, config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), migratedFromOutreach: false, _updatedAt: 0 };
}

/** Normalize anything vaguely record-shaped (manual add, inbox drop, legacy outreach target) into a CRM record. */
function normalize(t, defaults) {
  defaults = defaults || {};
  const station = STATIONS[t.station] ? t.station : (t.kind === 'brand' ? 'brands' : (defaults.station || 'stays'));
  const st = STATIONS[station];
  const now = new Date().toISOString();
  const stage = st.stages.includes(t.stage) ? t.stage : (st.stages.includes(t.status) ? t.status : st.stages[0]);
  const rec = {
    id: t.id || newId(),
    station,
    name: t.name || t.property || t.brand || t.project || '',
    org: t.org || t.company || '',
    contact: Object.assign({ name: '', email: '', ig: '', phone: '' }, t.contact || {}, t.host ? { name: t.host } : {}),
    stage,
    tier: st.tiers.includes(t.tier) ? t.tier : (st.tiers.length ? st.tiers[0] : ''),
    value: Number(t.value) || 0,
    price: t.price || '',
    location: t.location || '',
    channel: t.channel || (station === 'stays' ? 'stayamo' : 'email'),
    links: Object.assign({ site: '', ig: '', listing: '', requestUrl: '', thread: '' }, t.links || {}, t.url ? { listing: t.url } : {}, t.requestUrl ? { requestUrl: t.requestUrl } : {}),
    gmail: Object.assign({ account: '', threadId: '', threadUrl: '', subject: '', lastEmailAt: '' }, t.gmail || {}),
    draft: Object.assign({ when: '', subject: '', body: '' }, t.draft || {}, t.note ? { body: t.note } : {}, t.when ? { when: t.when } : {}),
    notes: t.notes || t.detail || '',
    why: t.why || '',
    apply: t.apply || '',
    category: t.category || '',
    tags: Array.isArray(t.tags) ? t.tags : [],
    source: t.source || defaults.source || 'manual',
    batch: t.batch || defaults.batch || '',
    listingId: t.listingId || null,
    // v1.8.0 discovery: three ready pitches per target (email / off-site DM / Airbnb inquiry) and what the finder saw
    pitches: Object.assign({}, t.pitches || {}),
    discovery: Object.assign({}, t.discovery || {}),
    skipReason: t.skipReason || '',
    activity: Array.isArray(t.activity) ? t.activity : [],
    dates: Object.assign({ created: now }, t.dates || {}),
    updatedAt: t.updatedAt || Date.now(),
  };
  rec.draft.body = noEmDash(rec.draft.body);
  rec.draft.subject = noEmDash(rec.draft.subject);
  rec.draft.when = noEmDash(rec.draft.when);
  if (rec.draft.body && rec.stage === st.stages[0] && station !== 'video') rec.stage = st.stages[1]; // has a draft → "drafted"/"pitched"
  return rec;
}

function dedupeKey(r) {
  if (r.listingId) return 'id:' + r.listingId;
  if (r.gmail && r.gmail.threadId) return 'thread:' + r.gmail.threadId;
  return (r.station + '|' + (r.name || '').toLowerCase().trim() + '|' + ((r.contact && r.contact.name) || '').toLowerCase().trim());
}

/** Per-record merge. Returns { doc, changed }. */
function merge(local, remote) {
  if (!remote || typeof remote !== 'object') return { doc: local, changed: false };
  const out = emptyDoc();
  out.config = Object.assign({}, remote.config || {}, local.config || {});
  out.config.autoSend = false; // guardrail is not a setting
  out.migratedFromOutreach = !!(local.migratedFromOutreach || remote.migratedFromOutreach);
  const ids = new Set([...Object.keys(local.records || {}), ...Object.keys(remote.records || {})]);
  const tomb = Object.assign({}, remote.tombstones || {}, local.tombstones || {});
  for (const k of Object.keys(tomb)) { const a = (local.tombstones || {})[k] || 0, b = (remote.tombstones || {})[k] || 0; tomb[k] = Math.max(a, b); }
  let changed = false;
  for (const id of ids) {
    const a = (local.records || {})[id], b = (remote.records || {})[id];
    const winner = !a ? b : !b ? a : ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
    if (tomb[id] && tomb[id] >= (winner.updatedAt || 0)) { if (a) changed = true; continue; }
    out.records[id] = winner;
    if (winner !== a) changed = true;
  }
  for (const id of Object.keys(tomb)) { if (!out.records[id]) out.tombstones[id] = tomb[id]; }
  out._updatedAt = Math.max(local._updatedAt || 0, remote._updatedAt || 0);
  return { doc: out, changed };
}

class CrmStore {
  constructor(opts) {
    this.file = 'ss_crm';
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.doc = this._read();
  }
  _read() {
    try { const d = JSON.parse(localStorage.getItem(this.file) || 'null'); if (d && d.records) { d.config = Object.assign({}, DEFAULT_CONFIG, d.config || {}); d.config.autoSend = false; d.config.stays = Object.assign({}, DEFAULT_CONFIG.stays, d.config.stays || {}); return d; } } catch (e) {}
    return emptyDoc();
  }
  _write() {
    try { localStorage.setItem(this.file, JSON.stringify(this.doc)); } catch (e) { this.log('crm write failed: ' + e.message); }
  }
  snapshot() { return this.doc; }
  setConfig(partial) {
    const c = this.doc.config;
    for (const k of Object.keys(partial || {})) {
      if (k === 'autoSend') continue; // email auto-send stays off, always
      c[k] = (partial[k] && typeof partial[k] === 'object' && !Array.isArray(partial[k])) ? Object.assign({}, c[k] || {}, partial[k]) : partial[k];
    }
    this.doc._updatedAt = Date.now();
    this._write(); this.onChange('config');
    return c;
  }
  list() { return Object.values(this.doc.records).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }

  upsert(partial, opts) {
    opts = opts || {};
    const existing = partial.id && this.doc.records[partial.id];
    let rec;
    if (existing) {
      rec = Object.assign({}, existing, partial, { updatedAt: Date.now() });
      // nested objects: merge shallowly so partial edits don't wipe siblings
      for (const k of ['contact', 'links', 'gmail', 'draft', 'dates', 'pitches', 'discovery']) rec[k] = Object.assign({}, existing[k] || {}, partial[k] || {});
      rec.draft.body = noEmDash(rec.draft.body); rec.draft.subject = noEmDash(rec.draft.subject); rec.draft.when = noEmDash(rec.draft.when);
      rec.dates.updated = new Date().toISOString();
      if (partial.stage && partial.stage !== existing.stage) {
        rec.activity = (rec.activity || []).concat([{ ts: Date.now(), type: 'stage', text: existing.stage + ' → ' + partial.stage }]);
        const st = STATIONS[rec.station];
        if (['sent', 'pitched'].includes(partial.stage) && !rec.dates.contacted) rec.dates.contacted = new Date().toISOString();
        if (['replied', 'talking'].includes(partial.stage) && !rec.dates.replied) rec.dates.replied = new Date().toISOString();
        if (st && ['paid', 'stayed', 'lost', 'skipped'].includes(partial.stage)) rec.dates.closed = new Date().toISOString();
      }
    } else {
      rec = normalize(partial, opts);
    }
    this.doc.records[rec.id] = rec;
    delete this.doc.tombstones[rec.id];
    this.doc._updatedAt = Date.now();
    this._write();
    if (!opts.silent) this.onChange('upsert');
    return rec;
  }

  addActivity(id, type, text) {
    const r = this.doc.records[id]; if (!r) return null;
    r.activity = (r.activity || []).concat([{ ts: Date.now(), type: type || 'note', text: noEmDash(text || '') }]);
    r.updatedAt = Date.now();
    this.doc._updatedAt = Date.now();
    this._write(); this.onChange('activity');
    return r;
  }

  remove(id) {
    if (!this.doc.records[id]) return false;
    delete this.doc.records[id];
    this.doc.tombstones[id] = Date.now();
    this.doc._updatedAt = Date.now();
    this._write(); this.onChange('delete');
    return true;
  }

  /** Bulk ingest from an inbox drop or legacy outreach targets. Dedupes; never regresses stage; fills empty drafts. */
  ingest(items, defaults) {
    defaults = defaults || {};
    const byKey = new Map(Object.values(this.doc.records).map(r => [dedupeKey(r), r]));
    let added = 0, updated = 0;
    for (const raw of items || []) {
      if (!raw || (!raw.name && !raw.property && !raw.brand && !raw.project && !raw.listingId)) continue;
      const rec = normalize(raw, defaults);
      const k = dedupeKey(rec);
      const cur = byKey.get(k);
      if (cur) {
        let touched = false;
        if (!cur.draft.body && rec.draft.body) { cur.draft = rec.draft; touched = true; }
        for (const f of ['why', 'apply', 'category', 'notes', 'price', 'location']) { if (!cur[f] && rec[f]) { cur[f] = rec[f]; touched = true; } }
        for (const f of ['site', 'ig', 'listing', 'requestUrl']) { if (!cur.links[f] && rec.links[f]) { cur.links[f] = rec.links[f]; touched = true; } }
        for (const f of ['email', 'ig', 'name']) { if (!cur.contact[f] && rec.contact[f]) { cur.contact[f] = rec.contact[f]; touched = true; } }
        const st = STATIONS[cur.station];
        if (st && st.stages.indexOf(rec.stage) > st.stages.indexOf(cur.stage) && ['drafted', 'pitched'].includes(rec.stage) && st.stages.indexOf(cur.stage) <= 1) { cur.stage = rec.stage; touched = true; }
        if (touched) { cur.updatedAt = Date.now(); updated++; }
      } else {
        this.doc.records[rec.id] = rec; byKey.set(k, rec); added++;
      }
    }
    if (added || updated) { this.doc._updatedAt = Date.now(); this._write(); this.onChange('ingest'); }
    return { added, updated };
  }

  /** One-time lift of the old data.outreach.targets (v1.3.0) into the CRM. */
  migrateFromOutreach(targets) {
    if (this.doc.migratedFromOutreach) return { added: 0, updated: 0 };
    const r = this.ingest(targets || [], { station: 'stays', source: 'legacy-outreach' });
    this.doc.migratedFromOutreach = true;
    this.doc._updatedAt = Date.now();
    this._write();
    return r;
  }

  /** Apply a remote copy (cloud). Returns true if local changed. */
  applyRemote(remote) {
    const { doc, changed } = merge(this.doc, remote);
    const remoteNewer = (remote && remote._updatedAt || 0) > (this.doc._updatedAt || 0);
    this.doc = doc;
    if (changed || remoteNewer) { this._write(); if (changed) this.onChange('remote'); }
    return changed;
  }
}

window.__crm = { CrmStore, STATIONS, DEFAULT_CONFIG, normalize, merge, dedupeKey, noEmDash };

})();
