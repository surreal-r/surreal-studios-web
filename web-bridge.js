/* Surreal Studios — web bridge (iPhone / browser build).
 * Replaces the Electron preload: window.surreal talks straight to Surreal Cloud
 * (Supabase) with the same document shapes, the same _cloud stamps and the same
 * per-record CRM merge the Macs use. Mac-only features (Studio, Content, Brain,
 * Stayamo autopilot, Sequence credentials) answer "Mac only" instead of failing.
 */
(function () {
  const CFG = { url: 'https://agwufkqbmjxolsjfcjms.supabase.co', key: 'sb_publishable_b8eG32OdgtfWHRgRvvaOqw_65NEjjXp' };
  const WEB_VERSION = 'web 1.9.1';
  const SYNC_FIELDS = ['bankAccounts', 'bankTransactions', 'bankSyncStatus', 'socialMetrics', 'socialHistory', 'excludedSequenceAccounts', '_migrationVersion'];
  const POLL_MS = 45 * 1000;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const deviceId = (function () { let id = LS.get('ss_device', null); if (!id) { id = 'iPhone-' + Math.random().toString(36).slice(2, 8); LS.set('ss_device', id); } return id; })();
  const log = (m) => { try { console.log('[Cloud]', m); } catch (e) {} };

  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  const state = { user: null, lastSeenTs: 0, lastPull: null, dataCache: LS.get('ss_data', null), crm: null, pollTimer: null, crmPushTimer: null };
  const listeners = { data: [], status: [], crm: [] };
  const fire = (k, p) => listeners[k].forEach(f => { try { f(p); } catch (e) {} });

  async function currentUser() {
    try { const { data } = await sb.auth.getSession(); state.user = data && data.session && data.session.user || null; } catch (e) { state.user = null; }
    return state.user;
  }
  async function pullKey(key) {
    const u = state.user || await currentUser(); if (!u) return { ok: false, error: 'not linked' };
    const { data, error } = await sb.from('app_state').select('value, updated_at').eq('user_id', u.id).eq('key', key).maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, value: data ? data.value : null, updatedAt: data ? data.updated_at : null };
  }
  async function pushKey(key, value) {
    const u = state.user || await currentUser(); if (!u) return { ok: false, error: 'not linked' };
    const { error } = await sb.from('app_state').upsert({ user_id: u.id, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  function status() { return { available: true, linked: !!state.user, email: state.user ? state.user.email : null, deviceId, hasSyncLease: false, lastPush: null, lastPull: state.lastPull, dirty: false, lastError: null, web: true }; }

  // ── finance doc (whole-doc, last-write-wins, same stamps as cloudStore.js) ──
  async function pullData(reason) {
    const r = await pullKey('data');
    if (!r.ok || !r.value) return null;
    state.lastPull = Date.now();
    const meta = r.value._cloud || {};
    const fresh = !!(meta.ts && meta.device !== deviceId && meta.ts > state.lastSeenTs);
    if (meta.ts) state.lastSeenTs = Math.max(state.lastSeenTs, meta.ts);
    state.dataCache = r.value; LS.set('ss_data', r.value);
    if (fresh && reason !== 'get') fire('data', { device: meta.device || 'another device' });
    return r.value;
  }
  async function getData() {
    if (await currentUser()) { const d = await pullData('get'); if (d) return d; }
    return state.dataCache;
  }
  async function saveData(doc) {
    if (!doc || typeof doc !== 'object') return false;
    if (!state.user) { state.dataCache = doc; LS.set('ss_data', doc); return true; }
    // the server (bank engine) owns the sync fields; never let a phone copy overwrite them
    const r = await pullKey('data');
    if (r.ok && r.value) for (const f of SYNC_FIELDS) if (r.value[f] !== undefined) doc[f] = r.value[f];
    doc._cloud = { device: deviceId, ts: Date.now() };
    state.lastSeenTs = doc._cloud.ts;
    state.dataCache = doc; LS.set('ss_data', doc);
    const p = await pushKey('data', doc);
    if (!p.ok) log('push failed: ' + p.error);
    return true;
  }

  // ── polling: the phone sees what the Macs and the engine write ──
  function startPoll() { stopPoll(); state.pollTimer = setInterval(() => { pullData('poll').catch(() => {}); if (state.crm) crmPull('poll').catch(() => {}); if (state.content) contentPull('poll').catch(() => {}); }, POLL_MS); }
  function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.user) { pullData('resume').catch(() => {}); if (state.crm) crmPull('resume').catch(() => {}); if (state.content) contentPull('resume').catch(() => {}); brainPull(false).catch(() => {}); } });

  // ── conversations + prompts ──
  async function getConversations() {
    if (!state.user) return LS.get('ss_convos', []);
    const { data, error } = await sb.from('conversations').select('data, updated_at').eq('user_id', state.user.id).order('updated_at', { ascending: false });
    if (error) return LS.get('ss_convos', []);
    const c = (data || []).map(r => r.data); LS.set('ss_convos', c); return c;
  }
  async function saveConversations(convos) {
    LS.set('ss_convos', convos || []);
    if (!state.user || !Array.isArray(convos)) return true;
    const rows = convos.filter(c => c && c.id != null).map(c => ({ user_id: state.user.id, id: String(c.id), data: c, updated_at: new Date().toISOString() }));
    if (rows.length) await sb.from('conversations').upsert(rows, { onConflict: 'user_id,id' });
    return true;
  }
  // same shape main.js serves: saved prompts + the content prompts spliced in (never persisted twice)
  function withContentPrompts(list) {
    try {
      const PROMPTS = (window.__contentPrompts || {}).PROMPTS || [];
      const out = (list || []).filter(p => !/^content-/.test(p.id || ''));
      const existing = list || [];
      for (const p of PROMPTS) {
        const idx = existing.findIndex(x => x.id === p.id);
        const rec = { id: p.id, name: p.name, prompt: p.prompt, brain: true, group: 'content', tools: p.tools || [] };
        if (idx >= 0) out.splice(Math.min(idx, out.length), 0, rec); else out.push(rec);
      }
      return out;
    } catch (e) { return list || []; }
  }
  async function getSystemPrompts() {
    let saved = null;
    if (state.user) { const r = await pullKey('system_prompts'); if (r.ok && Array.isArray(r.value)) { LS.set('ss_prompts', r.value); saved = r.value; } }
    if (!saved) saved = LS.get('ss_prompts', null);
    if (!saved || !saved.length) saved = (window.__defaultPrompts || []).slice();
    return withContentPrompts(saved);
  }
  async function saveSystemPrompts(p) { const own = (p || []).filter(x => !/^content-/.test(x.id || '')); LS.set('ss_prompts', own); if (state.user) await pushKey('system_prompts', own); return true; }

  // ── Claude chat, straight from the phone; mirrors services/claude.js (cached system, web search, pause_turn) ──
  function parseActions(text) {
    const actions = []; const re = /```json-action\s*([\s\S]*?)```/g; let m;
    while ((m = re.exec(text || '')) !== null) { try { actions.push(JSON.parse(m[1].trim())); } catch (e) {} }
    return actions;
  }
  async function chat(opts) {
    opts = opts || {};
    const apiKey = opts.apiKey || LS.get('ss_api_key', null);
    if (!apiKey) return { success: false, error: 'No API key. Add it in Settings.' };
    const model = opts.model || 'claude-opus-5';
    const system = [{ type: 'text', text: opts.systemPrompt || 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } }];
    const brainCtx = opts.brainContext != null ? opts.brainContext : (opts.useBrain ? brainContext() : '');
    if (brainCtx) system.push({ type: 'text', text: brainCtx, cache_control: { type: 'ephemeral' } });
    const body = { model, max_tokens: 16000, system, messages: opts.messages || [] };
    if ((opts.tools || []).includes('web_search')) body.tools = [/opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable/.test(model) ? { type: 'web_search_20260209', name: 'web_search', max_uses: 15 } : { type: 'web_search_20250305', name: 'web_search', max_uses: 15 }];
    const post = async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
      return j;
    };
    try {
      let r = await post(), hops = 0;
      while (r.stop_reason === 'pause_turn' && hops < 4) { hops++; body.messages = body.messages.concat([{ role: 'assistant', content: r.content }]); r = await post(); }
      if (r.stop_reason === 'refusal') return { success: false, error: 'Claude declined this request' };
      const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (!text) return { success: false, error: 'Model returned no text (stop_reason: ' + r.stop_reason + ')' };
      const sources = [];
      for (const b of (r.content || [])) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const s of b.content) if (s && s.url) sources.push(s.url);
      const actions = parseActions(text);
      let contentApplied = [];
      if (opts.useBrain && actions.length) { try { contentApplied = contentApplyActions(actions, { source: 'chat', conversationId: opts.conversationId }); } catch (e) {} }
      return { success: true, content: text, actions, usage: r.usage, stopReason: r.stop_reason, sources, contentApplied };
    } catch (e) { return { success: false, error: e.message }; }
  }
  // file attach: a real picker, text files read in the browser (same shape the Mac returns)
  function openFileDialog() {
    return new Promise((resolve) => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.txt,.csv,.json,.md,.html,.js,.py,text/*';
      inp.style.display = 'none'; document.body.appendChild(inp);
      let done = false; const finish = (v) => { if (!done) { done = true; inp.remove(); resolve(v); } };
      inp.onchange = async () => {
        const out = [];
        for (const f of Array.from(inp.files || [])) { try { out.push({ path: f.name, name: f.name, size: f.size, content: (await f.text()).slice(0, 100000) }); } catch (e) {} }
        finish(out);
      };
      window.addEventListener('focus', () => setTimeout(() => finish([]), 1500), { once: true });
      inp.click();
    });
  }

  // ── bank engine: ask Surreal Cloud for a fresh Sequence pull, then adopt it ──
  async function syncBankBalances() {
    if (!state.user) return { success: false, error: 'Sign in to Surreal Cloud first' };
    let engine = false;
    try {
      const s = await pullKey('secrets');
      const token = s.ok && s.value && (s.value.syncTriggerToken || s.value.sync_trigger_token);
      if (token) {
        const r = await fetch(CFG.url + '/functions/v1/bank-sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sync-token': token }, body: '{}' });
        engine = r.ok;
      }
    } catch (e) { log('engine trigger from phone failed: ' + e.message); }
    const d = await pullData('sync');
    return { success: true, cloud: true, engine, synced: d && d.bankAccounts ? d.bankAccounts.length : 0 };
  }

  // ── CRM: the real crm.js running on a localStorage "disk" ──
  function initCrm() {
    if (state.crm || !window.__crm || !window.__crm.CrmStore) return;
    state.crm = new window.__crm.CrmStore({ storePath: 'web', log, onChange: (why) => { fire('crm', { reason: why }); crmSchedulePush(); } });
  }
  function crmSchedulePush() { if (state.crmPushTimer) clearTimeout(state.crmPushTimer); state.crmPushTimer = setTimeout(() => { state.crmPushTimer = null; crmPush().catch(() => {}); }, 2000); }
  async function crmPush() { if (!state.crm || !state.user) return; const r = await pullKey('crm'); if (r.ok && r.value) state.crm.applyRemote(r.value); await pushKey('crm', state.crm.snapshot()); }
  async function crmPull(reason) {
    if (!state.crm || !state.user) return;
    const r = await pullKey('crm'); if (!r.ok) return;
    if (!r.value) { await crmPush(); return; }
    const localStamp = state.crm.snapshot()._updatedAt || 0;
    const changed = state.crm.applyRemote(r.value);
    if (changed) fire('crm', { reason: 'remote' });
    if (localStamp > (r.value._updatedAt || 0)) crmSchedulePush();
  }

  // ── AI Brain: read-only mirror the Mac pushes to cloud key 'brain' (v1.9.1 contentEngine.pushBrain) ──
  const BRAIN_TTL = 10 * 60 * 1000;
  state.brain = LS.get('ss_brain', null); state.brainAt = 0;
  async function brainPull(force) {
    if (!state.user) return state.brain;
    if (!force && state.brain && Date.now() - state.brainAt < BRAIN_TTL) return state.brain;
    const r = await pullKey('brain');
    if (r.ok && r.value) { state.brain = r.value; state.brainAt = Date.now(); LS.set('ss_brain', r.value); }
    else if (r.ok) state.brainAt = Date.now();
    return state.brain;
  }
  function brainContext() {
    const b = state.brain; if (!b || !b.context) return '';
    // the Mac's index of the bank can lag the phone; append what the phone holds so Claude never duplicates an idea
    let ctx = b.context;
    if (state.content) {
      const list = state.content.list().slice(0, 40).map(r => '- [' + r.id + '] ' + (r.title || '').slice(0, 80) + ' (' + r.stage + ')').join('\n');
      if (list) ctx = ctx.replace(/### CONTENT BANK[\s\S]*$/, '') + '### CONTENT BANK (what already exists, do not duplicate)\n' + list;
    }
    return ctx;
  }
  function brainStatus() {
    const b = state.brain;
    if (!b) return { available: false, web: true, cloud: true, docs: {}, path: '', configuredPath: '', bankCount: 0, inboxCount: 0, convoInboxCount: 0, hint: 'Open Surreal Studios on a Mac once (v1.9.1 or newer) and the brain appears here.' };
    const docs = {}; for (const k in (b.docs || {})) { const d = b.docs[k]; docs[k] = { file: d.file, exists: !!d.exists, size: d.size || 0, mtime: d.mtime }; }
    const age = b.updatedAt ? Math.round((Date.now() - b.updatedAt) / 60000) : null;
    return { available: true, web: true, cloud: true, docs, path: 'Surreal Cloud · mirrored from ' + (b.device || 'your Mac') + (age != null ? (age < 2 ? ' just now' : age < 120 ? ' ' + age + 'm ago' : ' ' + Math.round(age / 60) + 'h ago') : ''), configuredPath: b.path || '', bankCount: b.bankCount || 0, inboxCount: b.inboxCount || 0, convoInboxCount: b.convoInboxCount || 0, updatedAt: b.updatedAt };
  }

  // ── Content Engine: the real content.js on a localStorage disk, cloud key 'content', same per-record merge ──
  const C = () => window.__content, P = () => window.__contentPrompts;
  const running = new Map();
  function initContent() {
    if (state.content || !C() || !C().ContentStore) return;
    state.content = new (C().ContentStore)({ storePath: 'web', log, onChange: (why, payload) => { fire('content', Object.assign({ reason: why }, payload && payload.id ? { id: payload.id } : {})); contentSchedulePush(); } });
  }
  function contentSchedulePush() { if (state.contentPushTimer) clearTimeout(state.contentPushTimer); state.contentPushTimer = setTimeout(() => { state.contentPushTimer = null; contentPush().catch(() => {}); }, 2500); }
  async function contentPush() { if (!state.content || !state.user) return; const r = await pullKey('content'); if (r.ok && r.value) state.content.applyRemote(r.value); const p = await pushKey('content', state.content.snapshot()); if (!p.ok) log('content push failed: ' + p.error); }
  async function contentPull(reason) {
    initContent(); if (!state.content || !state.user) return;
    const r = await pullKey('content'); if (!r.ok) return;
    if (!r.value) { await contentPush(); return; }
    const localStamp = state.content.snapshot()._updatedAt || 0;
    state.content.applyRemote(r.value);
    if (localStamp > (r.value._updatedAt || 0)) contentSchedulePush();
  }
  function contentApplyActions(actions, meta) {
    initContent(); const store = state.content; if (!store) return [];
    meta = meta || {}; const desc = [];
    for (const a of (actions || [])) {
      if (!a || !a.action) continue; const d = a.data || {};
      try {
        if (a.action === 'add_idea') { const r = store.upsert(Object.assign({}, d, { id: undefined, source: meta.source || 'chat', conversationId: meta.conversationId || '' })); desc.push('Idea: ' + r.title); }
        else if (a.action === 'add_brief') {
          const payload = Object.assign({}, d);
          if (!payload.brief && (payload.corePoint || payload.spokenHooks)) payload.brief = payload;
          if (payload.id && store.get(payload.id)) { const r = store.upsert(Object.assign({}, payload, { stage: payload.stage || 'brief' })); desc.push('Brief: ' + r.title); }
          else { delete payload.id; const r = store.upsert(Object.assign({}, payload, { stage: 'brief', source: meta.source || 'chat', conversationId: meta.conversationId || '' })); desc.push('Brief: ' + r.title); }
        }
        else if (a.action === 'update_idea' && d.id && store.get(d.id)) { const r = store.upsert(d); desc.push('Updated: ' + r.title); }
        else if (a.action === 'add_script' && d.id && store.get(d.id)) { const r = store.upsert({ id: d.id, script: d.script || '', post: d.post || {} }); desc.push('Script: ' + r.title); }
        else if (a.action === 'add_research') {
          if (d.id && store.get(d.id)) { const r = store.upsert({ id: d.id, research: d.research || {} }); desc.push('Research: ' + r.title); }
          else if (d.research) { const r = store.upsert({ title: d.title || 'Viral scan ' + new Date().toISOString().slice(0, 10), research: d.research, stage: 'developing', tags: ['viral-scan'], source: meta.source || 'chat' }); desc.push('Research: ' + r.title); }
        }
        else if (a.action === 'set_stage' && d.id && store.get(d.id)) { const r = store.upsert({ id: d.id, stage: d.stage }); desc.push(r.title + ' → ' + r.stage); }
      } catch (e) { log('content action failed (' + a.action + '): ' + e.message); }
    }
    return desc;
  }
  async function contentRun(id, step, extra) {
    initContent(); const store = state.content, pr = P();
    if (!store || !pr) return { success: false, error: 'Content engine not loaded' };
    const spec = pr.PIPELINE[step]; if (!spec) return { success: false, error: 'unknown step ' + step };
    const rec = id ? store.get(id) : null; if (id && !rec) return { success: false, error: 'idea not found' };
    if (running.has(id || step)) return { success: false, error: 'already running' };
    const apiKey = LS.get('ss_api_key', null); if (!apiKey) return { success: false, error: 'No API key. Add it in Settings.' };
    running.set(id || step, step); fire('content', { reason: 'running', id, step });
    try {
      await brainPull(false);
      const p = pr.get(spec.promptId);
      const user = spec.build(rec || { id: '', title: extra || '', spark: extra || '' }, extra);
      const r = await chat({ apiKey, model: store.config().model || 'claude-opus-5', systemPrompt: p.prompt, brainContext: brainContext(), messages: [{ role: 'user', content: user }], tools: spec.tools });
      if (!r.success) return r;
      const applied = contentApplyActions(r.actions, { source: 'pipeline:' + step });
      if (rec) store.addActivity(rec.id, 'run', spec.label + (applied.length ? ': ' + applied.join(', ') : ' (no changes saved)'));
      if (rec && step === 'viral' && r.sources && r.sources.length && !(store.get(rec.id).research || {}).sources) store.upsert({ id: rec.id, research: { sources: r.sources.slice(0, 15) } });
      return { success: true, content: String(r.content || '').replace(/```json-action[\s\S]*?```/g, '').trim(), applied, usage: r.usage };
    } catch (e) { return { success: false, error: e.message }; }
    finally { running.delete(id || step); fire('content', { reason: 'done', id, step }); }
  }
  function contentListPayload() {
    initContent(); const c = C(); const store = state.content;
    const meta = c ? { stages: c.STAGES, stageLabels: c.STAGE_LABELS, types: c.TYPES, funnels: c.FUNNELS, funnelLabels: c.FUNNEL_LABELS, formats: c.FORMATS, platforms: c.PLATFORMS, closed: c.CLOSED } : {};
    if (!store) return { records: [], config: {}, stats: {}, meta, web: true };
    return { records: store.list(), config: store.config(), stats: store.stats(), meta, brain: brainStatus(), web: true };
  }
  listeners.content = [];

  const macOnly = (what) => async () => ({ ok: false, success: false, error: (what || 'This') + ' runs on your Mac, not on the phone.' });

  window.surreal = {
    // window chrome (no-ops on web)
    minimize() {}, maximize() {}, close() {},
    getData, saveData,
    getApiKey: async () => LS.get('ss_api_key', null),
    setApiKey: async (k) => { LS.set('ss_api_key', k); return true; },
    getConversations, saveConversations, getSystemPrompts, saveSystemPrompts,
    openFileDialog,
    chat,
    // Sequence (credentials live on the mini only)
    setSequenceCreds: macOnly('Sequence setup'), getSequenceCreds: async () => null, sequenceWebLogin: macOnly('Sequence login'), openSequenceAccounts: async () => { window.open('https://app.getsequence.io/', '_blank', 'noopener'); return { success: true }; },
    testSequenceConnection: macOnly('Sequence test'), discoverBankAccounts: macOnly('Account discovery'), addBankAccounts: macOnly('Adding accounts'),
    syncBankBalances, importBankTransactions: macOnly('Transaction import'),
    categorizeTransaction: async ({ transactionId, category, subcategory }) => {
      const d = await getData(); if (!d || !d.bankTransactions) return { success: false, error: 'No transactions' };
      const t = d.bankTransactions.find(x => x.id === transactionId); if (!t) return { success: false, error: 'Transaction not found' };
      t.category = category; t.subcategory = subcategory; t.reviewed = true; t.categorization = { confidence: 1, method: 'manual' };
      // categorization is a sync-owned field, so write it without the overlay
      d._cloud = { device: deviceId, ts: Date.now() }; state.lastSeenTs = d._cloud.ts; state.dataCache = d; LS.set('ss_data', d);
      if (state.user) await pushKey('data', d);
      return { success: true };
    },
    recategorizeAll: macOnly('Recategorize'),
    speak: async (text) => { try { const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 800)); u.lang = 'ja-JP'; u.rate = 0.9; speechSynthesis.speak(u); return { success: true }; } catch (e) { return { success: false, error: e.message }; } },
    toggleBankSync: async () => true,
    getBankSyncStatus: async () => ((state.dataCache && state.dataCache.bankSyncStatus) || {}),
    getCategorizationStats: async () => ({}),
    onBankSyncUpdate() {}, onBankSyncError() {},
    // Surreal Cloud
    cloudStatus: async () => status(),
    cloudSignIn: async (email, password) => {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { ok: false, error: error.message };
      await currentUser(); fire('status', status()); startPoll(); initCrm(); crmPull('signin').catch(() => {}); contentPull('signin').catch(() => {}); brainPull(true).catch(() => {});
      return { ok: true, email };
    },
    cloudSignUp: async () => ({ ok: false, error: 'Sign-ups are closed. Use your Surreal Cloud login.' }),
    cloudSignOut: async () => { try { await sb.auth.signOut(); } catch (e) {} state.user = null; stopPoll(); fire('status', status()); return { ok: true }; },
    cloudSyncNow: async () => { if (!state.user) return { ok: false, error: 'not signed in' }; await pullData('manual'); await crmPull('manual'); return { ok: true }; },
    onCloudDataUpdate: (cb) => listeners.data.push(cb),
    onCloudStatusChanged: (cb) => listeners.status.push(cb),
    openExternal: async (url) => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener'); return true; },
    // CRM (identical store code to the Macs)
    crmList: async () => { initCrm(); if (!state.crm) return { records: [], config: {}, stations: (window.__crm || {}).STATIONS || {} }; return { records: state.crm.list(), config: state.crm.snapshot().config, stations: window.__crm.STATIONS }; },
    crmUpsert: async (rec) => { initCrm(); return state.crm && rec ? state.crm.upsert(rec) : null; },
    crmDelete: async (id) => { initCrm(); return state.crm ? state.crm.remove(id) : false; },
    crmActivity: async (id, type, text) => { initCrm(); return state.crm ? state.crm.addActivity(id, type, text) : null; },
    crmIngest: async (payload) => { initCrm(); if (!state.crm) return { added: 0, updated: 0 }; try { const raw = typeof payload === 'string' ? JSON.parse(payload) : payload; const items = Array.isArray(raw) ? raw : (raw.records || raw.targets || raw.leads || []); return state.crm.ingest(items, { source: (raw && raw.source) || 'paste', batch: (raw && raw.batch) || 'pasted', station: raw && raw.station }); } catch (e) { return { added: 0, updated: 0, error: e.message }; } },
    crmSyncNow: async () => { initCrm(); await crmPull('manual'); await crmPush(); return { ok: true, count: state.crm ? state.crm.list().length : 0 }; },
    crmInboxPaths: async () => [],
    crmSetConfig: async (partial) => { initCrm(); return state.crm && state.crm.setConfig ? state.crm.setConfig(partial || {}) : null; },
    onCrmUpdate: (cb) => listeners.crm.push(cb),
    // Mac-only subsystems
    stayamoGeocode: macOnly('Stayamo search'), stayamoSearch: macOnly('Stayamo search'), stayamoPrompt: macOnly('Stayamo'), stayamoRecord: macOnly('Stayamo'), stayamoPayload: macOnly('Stayamo'), stayamoQuota: async () => ({ ok: false }),
    // Content Engine (same store code as the Macs; Claude runs from the phone with the cloud-mirrored brain)
    contentList: async () => contentListPayload(),
    contentUpsert: async (rec) => { initContent(); return state.content && rec ? state.content.upsert(rec) : null; },
    contentDelete: async (id) => { initContent(); return state.content ? state.content.remove(id) : false; },
    contentActivity: async (id, type, text) => { initContent(); return state.content ? state.content.addActivity(id, type, text) : null; },
    contentConfig: async (partial) => { initContent(); return state.content ? state.content.setConfig(partial) : {}; },
    contentIngest: async (payload) => { initContent(); if (!state.content) return { added: 0, updated: 0 }; try { const raw = typeof payload === 'string' ? JSON.parse(payload) : payload; const items = Array.isArray(raw) ? raw : (raw.records || raw.ideas || raw.briefs || [raw]); return state.content.ingest(items, { source: 'paste' }); } catch (e) { return { added: 0, updated: 0, error: e.message }; } },
    contentApplyActions: async (actions, conversationId) => contentApplyActions(actions, { source: 'chat', conversationId }),
    contentRun: async (id, step, extra) => contentRun(id, step, extra),
    contentSyncNow: async () => { await contentPull('manual'); await contentPush(); await brainPull(true); return { ok: true, inbox: { added: 0 }, count: state.content ? state.content.list().length : 0, web: true }; },
    contentPrompts: async () => (P() ? P().PROMPTS.map(p => ({ id: p.id, name: p.name, brain: true, group: 'content', tools: p.tools || [] })) : []),
    onContentUpdate: (cb) => listeners.content.push(cb),
    // AI Brain (read-only mirror from the Mac)
    brainStatus: async () => { await brainPull(false).catch(() => {}); return brainStatus(); },
    brainSetPath: async () => { const s = brainStatus(); s.error = 'The brain folder lives on your Mac. The phone reads the copy your Mac mirrors to Surreal Cloud.'; return s; },
    brainReadDoc: async (key) => { await brainPull(false).catch(() => {}); const b = state.brain; return b && b.docs && b.docs[key] ? b.docs[key].text || '' : ''; },
    brainContextSize: async () => brainContext().length,
    brainOpen: async () => false,
    brainNote: macOnly('Brain notes'),
    studioConfig: async () => ({}), studioSetConfig: macOnly('Studio'), studioStyles: async () => [], studioStyleVerdict: macOnly('Studio'), studioStyleRequest: macOnly('Studio'), studioStyleRequests: async () => [], studioStyleRemove: macOnly('Studio'), studioResume: macOnly('Studio'), studioBrollIndex: macOnly('Studio'), studioRecordings: async () => [], studioJobs: async () => [], studioRunJob: macOnly('Studio'), studioPick: macOnly('Studio'), studioResult: macOnly('Studio'), studioObsConfig: async () => ({}), studioLaunchObs: macOnly('Studio'), studioRecorded: macOnly('Studio'), studioOpenPath: macOnly('Studio'), studioRevealPath: macOnly('Studio'), studioOpenTeleprompter: macOnly('Studio'), studioDraftPost: macOnly('Studio'), studioTeleprompterData: async () => ({}), onStudioUpdate() {}, onStudioTeleprompterSet() {},
    // updater (the web build updates itself on reload)
    getAppVersion: async () => WEB_VERSION, checkUpdatesNow: async () => ({ upToDate: true }), installUpdate: async () => ({ success: false, error: 'Reload the page to update.' }), onUpdateAvailable() {},
  };

  // restore an existing session, then start the watchers; open sign-in if there is none
  (async () => {
    const u = await currentUser();
    if (u) { startPoll(); initCrm(); crmPull('startup').catch(() => {}); contentPull('startup').catch(() => {}); brainPull(true).catch(() => {}); }
    window.__ssReady = true;
    fire('status', status());
  })();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { state.user = null; stopPoll(); fire('status', status()); } });
})();
