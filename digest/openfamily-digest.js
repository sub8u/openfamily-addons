// openfamily-addons: daily digest
// Copyright (C) 2026 sub8u and contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Sends every family one morning push notification: today's events (including
// recurring ones), tasks due today, overdue tasks, the number of pending tasks and
// the size of the shopping list. It is an add-on: OpenFamily itself is not modified.
//
// It runs INSIDE the openfamily-server container, reusing that container's
// node_modules (pg, web-push) and environment (POSTGRES_*, VAPID_*, TZ). Start it
// every hour from the host's cron; it only sends at DIGEST_HOUR in the family's
// time zone (the container's TZ), so daylight-saving changes need no attention:
//   0 * * * * docker exec -i -w /app openfamily-server node - < openfamily-digest.js
//
// Settings (pass with `docker exec -e NAME=value`):
//   DIGEST_HOUR=7      local hour (0-23) at which to send
//   DIGEST_FORCE=1     send now, whatever the hour
//   DIGEST_DRY_RUN=1   print the digest instead of sending it
//
// Tested with OpenFamily v1.9.x. Notification text is in English.
'use strict';

const { Pool, types } = require('pg');
const webpush = require('web-push');

// Same type parsers as the app: DATE -> 'YYYY-MM-DD', TIMESTAMP -> naive local 'YYYY-MM-DDTHH:mm:ss'.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v.replace(' ', 'T').replace(/\.\d+$/, ''));

const HOUR = parseInt(process.env.DIGEST_HOUR || '7', 10);
const FORCE = process.env.DIGEST_FORCE === '1';
const DRY = process.env.DIGEST_DRY_RUN === '1';
const MAX_LINES = 9;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fmtTime(naive) {
    const [h, m] = naive.slice(11, 16).split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${pad(m)} ${ampm}`;
}

function namesFor(ids, membersById) {
    if (!Array.isArray(ids) || ids.length === 0) return '';
    const names = ids.map((id) => membersById.get(id)).filter(Boolean);
    return names.length ? ` (${names.join(', ')})` : '';
}

let expandRecurring = null;
try {
    expandRecurring = require('/app/server/dist/lib/appointmentRecurrence.js').expandRecurringAppointments;
} catch (e) {
    console.warn('digest: recurrence helper not found, recurring events will only show on their first date');
}

async function main() {
    const now = new Date();
    if (!FORCE && now.getHours() !== HOUR) {
        console.log(`digest: local hour is ${now.getHours()}, not ${HOUR}; nothing to do`);
        return;
    }

    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) throw new Error('VAPID keys are not set in the server environment');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@openfamily.local', pub, priv);

    const pool = new Pool({
        host: process.env.POSTGRES_HOST || 'postgres',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        database: process.env.POSTGRES_DB || 'openfamily',
        user: process.env.POSTGRES_USER || 'openfamily',
        password: process.env.POSTGRES_PASSWORD,
        max: 2,
    });
    const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

    const today = ymd(now);
    const dayStart = `${today}T00:00:00`;
    const dayEnd = `${today}T23:59:59`;
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    try {
        // Each family = an owner account (family_owner_id IS NULL); members point at it.
        const owners = await q('SELECT id FROM users WHERE family_owner_id IS NULL');
        for (const { id: ownerId } of owners) {
            const recipients = await q(
                'SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id WHERE u.id = $1 OR u.family_owner_id = $1',
                [ownerId]
            );
            if (recipients.length === 0) continue;

            const members = await q('SELECT id, name FROM family_members WHERE user_id = $1', [ownerId]);
            const membersById = new Map(members.map((m) => [m.id, m.name]));

            // Today's events, including recurring ones.
            const rows = await q(
                `SELECT id, user_id, title, start_time, end_time, is_all_day, family_member_ids,
                        recurrence_frequency, recurrence_interval, recurrence_until
                 FROM appointments
                 WHERE user_id = $1 AND start_time <= $3
                   AND ((recurrence_frequency = 'none' AND COALESCE(end_time, start_time) >= $2)
                        OR (recurrence_frequency <> 'none' AND (recurrence_until IS NULL OR recurrence_until >= ($2)::date)))`,
                [ownerId, dayStart, dayEnd]
            );
            let events = rows;
            if (expandRecurring) {
                const recurringIds = rows.filter((r) => r.recurrence_frequency !== 'none').map((r) => r.id);
                const exceptions = new Map();
                if (recurringIds.length) {
                    const ex = await q(
                        `SELECT appointment_id, occurrence_date, exception_type, override_data
                         FROM appointment_recurrence_exceptions
                         WHERE appointment_id = ANY($1::uuid[]) AND occurrence_date = ($2)::date`,
                        [recurringIds, today]
                    );
                    for (const row of ex) {
                        const key = String(row.appointment_id);
                        if (!exceptions.has(key)) exceptions.set(key, new Map());
                        exceptions.get(key).set(String(row.occurrence_date).slice(0, 10), row);
                    }
                }
                events = expandRecurring(rows, dayStart, dayEnd, exceptions);
            } else {
                events = rows.filter((r) => r.recurrence_frequency === 'none');
            }
            events = events
                .filter((e) => {
                    const start = String(e.start_time).slice(0, 19);
                    const end = String(e.end_time || e.start_time).slice(0, 19);
                    return start <= dayEnd && end >= dayStart;
                })
                .sort((a, b) => (a.is_all_day === b.is_all_day ? String(a.start_time).localeCompare(String(b.start_time)) : a.is_all_day ? -1 : 1));

            // Tasks.
            const pending = await q('SELECT title, due_date, assigned_to FROM tasks WHERE user_id = $1 AND NOT COALESCE(is_completed, false)', [ownerId]);
            const dueToday = pending.filter((t) => t.due_date && String(t.due_date).slice(0, 10) === today);
            const overdue = pending.filter((t) => t.due_date && String(t.due_date).slice(0, 10) < today);

            // Shopping list.
            const [{ count: shopping }] = await q('SELECT COUNT(*)::int AS count FROM shopping_items WHERE user_id = $1 AND NOT COALESCE(is_checked, false)', [ownerId]);

            const lines = [];
            for (const e of events) {
                const when = e.is_all_day ? 'All day' : fmtTime(String(e.start_time));
                lines.push(`📅 ${when} ${e.title}${namesFor(e.family_member_ids, membersById)}`);
            }
            for (const t of dueToday) lines.push(`✅ Due today: ${t.title}${namesFor(t.assigned_to, membersById)}`);
            for (const t of overdue) lines.push(`⚠️ Overdue: ${t.title}${namesFor(t.assigned_to, membersById)}`);
            if (lines.length === 0) lines.push('Nothing scheduled today 🎉');

            let shown = lines;
            if (lines.length > MAX_LINES) {
                shown = lines.slice(0, MAX_LINES - 1);
                shown.push(`…and ${lines.length - (MAX_LINES - 1)} more in the app`);
            }
            if (shopping > 0) shown.push(`🛒 ${shopping} item${shopping === 1 ? '' : 's'} on the shopping list`);

            const ev = events.length;
            const title = `☀️ ${weekday}: ${ev} event${ev === 1 ? '' : 's'} · ${pending.length} task${pending.length === 1 ? '' : 's'} pending`;
            const payload = { title, body: shown.join('\n'), url: '/', tag: `daily-digest-${today}` };

            if (DRY) {
                console.log(`--- family ${ownerId} (${recipients.length} recipient(s)) ---\n${title}\n${payload.body}`);
                continue;
            }

            let sent = 0;
            for (const { id: userId } of recipients) {
                const subs = await q('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1', [userId]);
                for (const s of subs) {
                    try {
                        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload));
                        sent++;
                    } catch (err) {
                        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                            await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
                        } else {
                            console.warn('digest: send failed:', err && err.message);
                        }
                    }
                }
            }
            console.log(`${new Date().toISOString()} digest: sent to ${sent} device(s) — ${title}`);
        }
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('digest failed:', err && err.message);
    process.exit(1);
});
