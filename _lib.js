// Shared helpers for all API routes.
// Files starting with "_" inside /api are NOT exposed as routes by Vercel.

const crypto = require('crypto');

function env(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

const SB_URL = env('SUPABASE_URL', '').replace(/\/$/, '');
const SB_SERVICE = env('SUPABASE_SERVICE_KEY', '');
const SB_ANON = env('SUPABASE_ANON_KEY', '');
const APP_URL = env('APP_URL', '').replace(/\/$/, '');
const APP_NAME = env('APP_NAME', 'GrowMyPin Autopilot');

// ---------- pricing ----------
const BASE_PRICE = parseInt(env('BASE_PRICE', '999'), 10);
const MANDATE_MAX = parseInt(env('MANDATE_MAX', '6500'), 10);
// views threshold -> milestone charge (rupees) for that cycle
const MILESTONES = [
  { views: 200000, amount: 5500 },
  { views: 100000, amount: 4000 },
  { views: 50000, amount: 2500 },
  { views: 25000, amount: 1499 }
];

function milestoneFor(views) {
  for (const m of MILESTONES) {
    if (views >= m.views) return m.amount;
  }
  return 0;
}

function nextMilestone(views) {
  const asc = MILESTONES.slice().reverse();
  for (const m of asc) {
    if (views < m.views) return m;
  }
  return null;
}

// ---------- http ----------
function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// ---------- supabase rest ----------
async function db(path, opts) {
  opts = opts || {};
  const headers = {
    apikey: SB_SERVICE,
    Authorization: 'Bearer ' + SB_SERVICE,
    'Content-Type': 'application/json'
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }
  if (!r.ok) {
    const msg = data && data.message ? data.message : text;
    throw new Error('DB ' + r.status + ': ' + msg);
  }
  return data;
}

const dbGet = (table, query) => db(table + '?' + query);
const dbInsert = (table, rows) =>
  db(table, { method: 'POST', body: rows, prefer: 'return=representation' });
const dbUpdate = (table, query, patch) =>
  db(table + '?' + query, { method: 'PATCH', body: patch, prefer: 'return=representation' });
const dbDelete = (table, query) => db(table + '?' + query, { method: 'DELETE' });

async function uploadImage(path, buffer, contentType) {
  const r = await fetch(SB_URL + '/storage/v1/object/pins/' + path, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE,
      Authorization: 'Bearer ' + SB_SERVICE,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) throw new Error('Storage upload failed: ' + r.status + ' ' + (await r.text()));
  return SB_URL + '/storage/v1/object/public/pins/' + path;
}

// ---------- auth ----------
async function getUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const r = await fetch(SB_URL + '/auth/v1/user', {
    headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, email: u.email } : null;
}

async function ensureAccount(user) {
  const rows = await dbGet('accounts', 'id=eq.' + user.id + '&select=*');
  if (rows && rows.length) return rows[0];
  const created = await dbInsert('accounts', { id: user.id, email: user.email });
  return created[0];
}

// Returns account or sends 401 and returns null
async function requireAccount(req, res) {
  const user = await getUser(req);
  if (!user) {
    send(res, 401, { error: 'Please log in again' });
    return null;
  }
  return ensureAccount(user);
}

// ---------- dates (IST) ----------
function todayIST() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// ---------- signing (oauth state) ----------
function sign(value) {
  const sig = crypto.createHmac('sha256', env('APP_SECRET', 'change-me')).update(value).digest('hex');
  return value + '.' + sig;
}

function unsign(signed) {
  const i = (signed || '').lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = sign(value);
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

// ---------- pinterest ----------
const PIN_API = env('PINTEREST_API_BASE', 'https://api.pinterest.com').replace(/\/$/, '');

function pinBasicAuth() {
  return 'Basic ' + Buffer.from(env('PINTEREST_APP_ID', '') + ':' + env('PINTEREST_APP_SECRET', '')).toString('base64');
}

async function pinTokenRequest(params) {
  const r = await fetch(PIN_API + '/v5/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: pinBasicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params).toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Pinterest token error: ' + JSON.stringify(data));
  return data;
}

async function freshPinToken(account) {
  if (!account.pin_access_token) throw new Error('Pinterest not connected');
  const exp = account.pin_token_expires_at ? new Date(account.pin_token_expires_at).getTime() : 0;
  if (exp && exp - Date.now() > 2 * 86400000) return account.pin_access_token;
  if (!account.pin_refresh_token) return account.pin_access_token;
  const t = await pinTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: account.pin_refresh_token
  });
  const patch = {
    pin_access_token: t.access_token,
    pin_token_expires_at: new Date(Date.now() + (t.expires_in || 2592000) * 1000).toISOString()
  };
  if (t.refresh_token) patch.pin_refresh_token = t.refresh_token;
  await dbUpdate('accounts', 'id=eq.' + account.id, patch);
  Object.assign(account, patch);
  return t.access_token;
}

async function pinApi(account, path, opts) {
  opts = opts || {};
  const token = await freshPinToken(account);
  const r = await fetch(PIN_API + path, {
    method: opts.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Pinterest ' + r.status + ': ' + (data.message || JSON.stringify(data)));
  return data;
}

// ---------- razorpay ----------
function rzpAuth() {
  return 'Basic ' + Buffer.from(env('RAZORPAY_KEY_ID', '') + ':' + env('RAZORPAY_KEY_SECRET', '')).toString('base64');
}

async function rzp(path, method, body) {
  const r = await fetch('https://api.razorpay.com/v1' + path, {
    method: method || 'GET',
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data && data.error ? data.error.description : JSON.stringify(data);
    throw new Error('Razorpay ' + r.status + ': ' + msg);
  }
  return data;
}

// Charge a saved UPI mandate. Razorpay sends the pre-debit notification,
// the money arrives later via the payment.captured webhook.
async function chargeMandate(account, kind, amount, forCycleStart, note) {
  if (!account.rzp_token_id || !account.rzp_customer_id) throw new Error('No active mandate');
  const order = await rzp('/orders', 'POST', {
    amount: amount * 100,
    currency: 'INR',
    receipt: (kind + '_' + account.id).slice(0, 40),
    notes: { user_id: account.id, kind: kind }
  });
  const rows = await dbInsert('charges', {
    user_id: account.id,
    kind: kind,
    amount: amount,
    for_cycle_start: forCycleStart,
    rzp_order_id: order.id,
    status: 'created',
    note: note || null
  });
  try {
    const p = await rzp('/payments/create/recurring', 'POST', {
      email: account.email || undefined,
      contact: account.phone || undefined,
      amount: amount * 100,
      currency: 'INR',
      order_id: order.id,
      customer_id: account.rzp_customer_id,
      token: account.rzp_token_id,
      recurring: '1',
      description: APP_NAME + ' ' + kind + ' charge',
      notes: { user_id: account.id, kind: kind }
    });
    await dbUpdate('charges', 'id=eq.' + rows[0].id, {
      status: 'pending',
      rzp_payment_id: p.razorpay_payment_id || null
    });
  } catch (e) {
    await dbUpdate('charges', 'id=eq.' + rows[0].id, { status: 'failed', note: String(e.message).slice(0, 300) });
    throw e;
  }
  return rows[0];
}

// Called after the first (mandate registration) payment succeeds.
// Safe to call twice (from checkout verify and from the webhook).
async function activateAccount(userId, tokenId, orderId) {
  const rows = await dbGet('accounts', 'id=eq.' + userId + '&select=*');
  const acc = rows && rows[0];
  if (!acc) return null;
  if (acc.billing_status === 'active' && acc.rzp_token_id === tokenId) return acc;
  const today = todayIST();
  const patch = {
    billing_status: 'active',
    posting_paused: false,
    rzp_token_id: tokenId || acc.rzp_token_id,
    cycle_start: today,
    cycle_end: addDays(today, 30),
    cycle_views: 0,
    milestone_charged: 0,
    last_daily_run: null
  };
  const updated = await dbUpdate('accounts', 'id=eq.' + userId, patch);
  if (orderId) {
    await dbUpdate('charges', 'rzp_order_id=eq.' + orderId, { status: 'captured', for_cycle_start: today });
  }
  // Old unpaid dues were added into this first payment, so mark them settled.
  await dbUpdate('charges', 'user_id=eq.' + userId + '&kind=eq.milestone&status=eq.failed', { status: 'settled' });
  await dbUpdate('charges', 'user_id=eq.' + userId + '&kind=eq.base&status=eq.failed', { status: 'cancelled' });
  return updated[0];
}

module.exports = {
  activateAccount,
  env, send, readRaw, readJson,
  db, dbGet, dbInsert, dbUpdate, dbDelete, uploadImage,
  getUser, ensureAccount, requireAccount,
  todayIST, addDays, daysBetween,
  sign, unsign,
  PIN_API, pinTokenRequest, pinApi, freshPinToken,
  rzp, chargeMandate,
  BASE_PRICE, MANDATE_MAX, MILESTONES, milestoneFor, nextMilestone,
  APP_URL, APP_NAME, SB_URL, SB_ANON
};
