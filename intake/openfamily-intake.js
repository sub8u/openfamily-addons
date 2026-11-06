// openfamily-addons: message intake
// Copyright (C) 2026 sub8u and contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Turns a short text message ("#add milk, dentist Tuesday 3pm") into OpenFamily items.
// A client (for example an iPhone Shortcuts automation that watches a family group chat)
// POSTs {"who": "<member's OpenFamily login email>", "text": "<message>"} with the header
// "X-Intake-Key: <secret>". The add-on then:
//   1. signs in AS that member (short-lived token signed with OpenFamily's JWT_SECRET),
//   2. asks OpenFamily's own AI assistant (/api/ai/parse) to split the text into items,
//   3. adds each item through OpenFamily's normal API, exactly as the in-app AI button does,
//   4. pushes a confirmation such as "🛒 Added to shopping list / Bread · from Alex".
// OpenFamily stores every member's push subscription under the family owner's account,
// so the confirmation reaches all of the family's registered devices.
//
// It runs in its own container started from the openfamily-server image (which already has
// pg, web-push and jsonwebtoken), on the compose network. OpenFamily itself is not modified.
//
// Settings (environment):
//   INTAKE_KEY       required, at least 24 characters; clients must send it as X-Intake-Key
//   INTAKE_KEYWORD   default "#add"; removed from the text before parsing
//   INTAKE_PORT      default 3100
//   OPENFAMILY_API   default http://server:3001 (the server container on the compose network)
//   plus OpenFamily's own POSTGRES_*, JWT_SECRET and VAPID_* (pass the same .env file)
//
// Tested with OpenFamily v1.9.x. Requires the AI assistant to be configured in OpenFamily.
'use strict';

const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const webpush = require('web-push');

const PORT = parseInt(process.env.INTAKE_PORT || '3100', 10);
const KEY = process.env.INTAKE_KEY || '';
const API = process.env.OPENFAMILY_API || 'http://server:3001';
const KEYWORD = (process.env.INTAKE_KEYWORD || '#add').trim();
const MAX_BODY = 8 * 1024;

if (KEY.length < 24) {
    console.error('intake: INTAKE_KEY missing or too short; refusing to start');
    process.exit(1);
}
if (!process.env.JWT_SECRET) {
    console.error('intake: JWT_SECRET missing; refusing to start');
    process.exit(1);
}
const pushReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushReady) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@openfamily.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'postgres',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'openfamily',
    user: process.env.POSTGRES_USER || 'openfamily',
    password: process.env.POSTGRES_PASSWORD,
    max: 3,
});
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

const log = (msg, extra) => console.log(`${new Date().toISOString()} intake: ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

// The same message can arrive twice (e.g. iMessage + SMS fallback); ignore repeats for 3 minutes.
const recent = new Map();
function isDuplicate(who, text) {
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 180000) recent.delete(k);
    const k = crypto.createHash('sha256').update(`${who}\n${text}`).digest('hex');
    if (recent.has(k)) return true;
    recent.set(k, now);
    return false;
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function stripKeyword(text) {
    const esc = KEYWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(esc, 'gi'), ' ').replace(/\s+/g, ' ').trim().replace(/^[:,\-–—\s]+/, '');
}

async function tokenFor(email) {
    const rows = await q('SELECT id, name, family_owner_id, COALESCE(token_version, 0) AS token_version FROM users WHERE lower(email) = lower($1)', [email]);
    if (rows.length === 0) return null;
    const u = rows[0];
    const token = jwt.sign({ userId: u.id, ownerId: u.family_owner_id || u.id, tv: u.token_version }, process.env.JWT_SECRET, { expiresIn: '5m' });
    return { userId: u.family_owner_id || u.id, name: u.name || 'Someone', token };
}

async function api(token, path, body) {
    const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok || (data && data.success === false)) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
}

const KINDS = {
    task: { icon: '✅', list: 'Tasks', added: 'Added to tasks' },
    appointment: { icon: '📅', list: 'Calendar', added: 'Added to calendar' },
    shopping_item: { icon: '🛒', list: 'Shopping list', added: 'Added to shopping list' },
    budget_entry: { icon: '💵', list: 'Budget', added: 'Added to budget' },
};

// Mirrors MagicInput.postProposal in the OpenFamily client. Returns { kind, label }.
async function addProposal(token, p) {
    switch (p.type) {
        case 'task':
            await api(token, '/api/tasks', {
                title: p.title,
                ...(p.description ? { description: p.description } : {}),
                ...(p.due_date ? { due_date: p.due_date } : {}),
                ...(p.priority ? { priority: p.priority } : {}),
                ...(p.frequency ? { frequency: p.frequency } : {}),
                assigned_to: p.assigned_to || [],
            });
            return { kind: 'task', label: `${p.title}${p.due_date ? ` (due ${fmtDate(p.due_date)})` : ''}` };
        case 'appointment':
            await api(token, '/api/appointments', {
                title: p.title,
                ...(p.description ? { description: p.description } : {}),
                start_time: p.start_time,
                ...(p.end_time ? { end_time: p.end_time } : {}),
                ...(p.location ? { location: p.location } : {}),
                family_member_ids: p.family_member_ids || [],
            });
            return { kind: 'appointment', label: `${p.title}, ${fmtDateTime(p.start_time)}` };
        case 'shopping_item':
            await api(token, '/api/shopping', {
                name: p.name,
                category: p.category,
                ...(p.quantity ? { quantity: p.quantity } : {}),
                ...(p.unit ? { unit: p.unit } : {}),
            });
            return { kind: 'shopping_item', label: `${p.name}${p.quantity && p.quantity > 1 ? ` ×${p.quantity}${p.unit ? ' ' + p.unit : ''}` : ''}` };
        case 'budget_entry':
            await api(token, '/api/budget/entries', {
                category: p.category,
                amount: p.amount,
                ...(p.description ? { description: p.description } : {}),
                date: p.date,
                is_expense: p.is_expense,
            });
            return { kind: 'budget_entry', label: `${p.description || p.category}: ${p.amount}` };
        default:
            throw new Error(`unknown item type ${p.type}`);
    }
}

// Builds the confirmation notification.
// One item:   "🛒 Added to shopping list" / "Bread · from Alex"
// Same kind:  "🛒 3 added to shopping list" / "Bread, Milk, Eggs · from Alex"
// Mixed:      "Alex added 3 items" / "🛒 Shopping list: Bread\n📅 Calendar: ..."
function confirmation(added, failedCount, who) {
    const kinds = [...new Set(added.map((a) => a.kind))];
    let title;
    let body;
    if (kinds.length === 1) {
        const k = KINDS[kinds[0]];
        title = added.length === 1 ? `${k.icon} ${k.added}` : `${k.icon} ${added.length} ${k.added.replace(/^Added/, 'added')}`;
        body = `${added.map((a) => a.label).join(kinds[0] === 'shopping_item' ? ', ' : '\n')} · from ${who}`;
    } else {
        title = `${who} added ${added.length} items`;
        const lines = added.slice(0, 8).map((a) => `${KINDS[a.kind].icon} ${KINDS[a.kind].list}: ${a.label}`);
        if (added.length > 8) lines.push(`…and ${added.length - 8} more`);
        body = lines.join('\n');
    }
    if (failedCount) body += `\n⚠️ ${failedCount} item(s) could not be added`;
    return { title, body };
}

function fmtDate(s) {
    const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDateTime(s) {
    const str = String(s);
    const d = new Date(str.slice(0, 19));
    if (isNaN(d)) return str;
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (str.length <= 10 || str.slice(11, 16) === '00:00') return day;
    return `${day} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

async function push(userId, title, body) {
    if (!pushReady) return;
    const subs = await q('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1', [userId]);
    for (const s of subs) {
        try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, url: '/', tag: `intake-${Date.now()}` }));
        } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
            else log('push failed', { error: err && err.message });
        }
    }
}

async function handle(payload) {
    const who = String(payload.who || '').trim();
    const raw = String(payload.text || '').slice(0, 2000);
    const text = stripKeyword(raw);
    if (!who || !text) return { status: 400, body: { ok: false, error: 'who and text are required' } };

    if (isDuplicate(who, text)) return { status: 200, body: { ok: true, duplicate: true, added: [] } };

    const auth = await tokenFor(who);
    if (!auth) {
        log('unknown member', { who });
        return { status: 404, body: { ok: false, error: `no OpenFamily account for ${who}` } };
    }

    let proposals;
    try {
        const parsed = await api(auth.token, '/api/ai/parse', { text });
        proposals = (parsed && parsed.data && parsed.data.items) || [];
    } catch (err) {
        log('parse failed', { who, error: err.message });
        await push(auth.userId, `⚠️ OpenFamily could not read ${auth.name}'s message`, `“${text.slice(0, 120)}” (${err.message})`);
        return { status: 502, body: { ok: false, error: err.message } };
    }

    const added = [];
    const failed = [];
    for (const p of proposals) {
        try {
            added.push(await addProposal(auth.token, p));
        } catch (err) {
            failed.push(`${p.title || p.name || p.type}: ${err.message}`);
        }
    }
    log('processed', { who, proposals: proposals.length, added: added.length, failed: failed.length });

    if (added.length > 0) {
        const { title, body } = confirmation(added, failed.length, auth.name);
        await push(auth.userId, title, body);
    } else {
        await push(auth.userId, `🤔 Nothing added from ${auth.name}'s message`, failed.length ? failed.join('\n').slice(0, 300) : `Couldn't find anything to add in “${text.slice(0, 120)}”`);
    }
    return { status: 200, body: { ok: true, added: added.map((a) => `${KINDS[a.kind].icon} ${a.label}`), failed } };
}

const server = http.createServer((req, res) => {
    const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') return send(200, { ok: true, service: 'openfamily-intake' });
    if (req.method !== 'POST') return send(405, { ok: false });
    if (!safeEqual(req.headers['x-intake-key'] || '', KEY)) return send(401, { ok: false, error: 'bad key' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { send(413, { ok: false }); req.destroy(); return; }
        chunks.push(c);
    });
    req.on('end', async () => {
        if (res.writableEnded) return;
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { ok: false, error: 'invalid JSON' }); }
        try {
            const { status, body } = await handle(payload);
            send(status, body);
        } catch (err) {
            log('error', { error: err && err.message });
            send(500, { ok: false, error: 'internal error' });
        }
    });
});

server.listen(PORT, '0.0.0.0', () => log(`listening on ${PORT}, keyword "${KEYWORD}"`));
const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
