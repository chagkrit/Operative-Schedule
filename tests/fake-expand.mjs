// Test helper: a small stand-in for Google's events.list singleEvents=true over [timeMin, timeMax).
// Supports what the fixtures use: RRULE FREQ=DAILY|WEEKLY with BYDAY, COUNT, UNTIL; EXDATE (date or
// UTC/local basic times); all-day and timed starts. Instance ids are `<masterId>_<YYYYMMDD | UTC
// YYYYMMDDTHHMMSSZ>` (confirmed against real Google by the controller's smoke test). A cancelled
// exception hides its occurrence; a modified exception replaces it; an exception whose id is not an
// occurrence of the rule (an orphan) is not shown. Synthetic data only.
const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const pad = (n, w = 2) => String(n).padStart(w, "0");
function suffixOf(ms, allDay) {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return allDay ? date : `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseRule(recurrence) {
  const line = recurrence.find((r) => /^RRULE:/i.test(r));
  if (!line) return null;
  const parts = Object.fromEntries(line.slice(6).split(";").map((p) => p.split("=")));
  return { freq: parts.FREQ, byday: parts.BYDAY ? parts.BYDAY.split(",") : null, count: parts.COUNT ? Number(parts.COUNT) : null, until: parts.UNTIL || null };
}

function exdates(recurrence) {
  const out = new Set();
  for (const r of recurrence) {
    if (!/^EXDATE/i.test(r)) continue;
    for (const v of r.slice(r.indexOf(":") + 1).split(",")) {
      if (/^\d{8}$/.test(v)) out.add(v);
      else if (/^\d{8}T\d{6}Z$/.test(v)) out.add(v);
      else if (/^\d{8}T\d{6}$/.test(v)) out.add(`local:${v}`); // TZID local time (fixtures use Asia/Bangkok, +07:00)
    }
  }
  return out;
}

function occurrences(master, lo, hi) {
  const rule = parseRule(master.recurrence);
  if (!rule) return [];
  const allDay = !!master.start?.date;
  const startMs = allDay ? Date.parse(`${master.start.date}T00:00:00Z`) : Date.parse(master.start.dateTime);
  const endMs = allDay ? Date.parse(`${master.end.date}T00:00:00Z`) : Date.parse(master.end.dateTime);
  const duration = endMs - startMs;
  const untilMs = rule.until ? Date.parse(rule.until.replace(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/, (_, y, m, d, H = "23", M = "59", S = "59") => `${y}-${m}-${d}T${H}:${M}:${S}Z`)) : Infinity;
  const ex = exdates(master.recurrence);
  const startDay = new Date(startMs).getUTCDay();
  const out = [];
  let n = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const t = startMs + i * DAY;
    if (t > untilMs || t >= hi) break;
    const wd = WEEKDAYS[new Date(t + (allDay ? 0 : 7 * 3_600_000)).getUTCDay()];
    const match = rule.freq === "DAILY" || (rule.byday ? rule.byday.includes(wd) : new Date(t).getUTCDay() === startDay);
    if (!match) continue;
    n += 1;
    if (rule.count !== null && n > rule.count) break;
    const suffix = suffixOf(t, allDay);
    const local = allDay ? null : `local:${suffixOf(t + 7 * 3_600_000, false).slice(0, 15)}`;
    if (ex.has(suffix) || (local && ex.has(local))) continue;
    if (t + duration <= lo) continue;
    const time = (ms) => (allDay ? { date: isoDate(ms) } : { dateTime: new Date(ms).toISOString(), ...(master.start.timeZone ? { timeZone: master.start.timeZone } : {}) });
    out.push({ id: `${master.id}_${suffix}`, start: time(t), end: time(t + duration) });
  }
  return out;
}

function inWindow(e, lo, hi) {
  const s = e.start?.date ? Date.parse(`${e.start.date}T00:00:00Z`) : Date.parse(e.start?.dateTime ?? "");
  const en = e.end?.date ? Date.parse(`${e.end.date}T00:00:00Z`) : Date.parse(e.end?.dateTime ?? "");
  if (!Number.isFinite(s)) return false;
  return (Number.isFinite(en) ? en : s) > lo && s < hi;
}

export function expandEvents(events, { timeMin, timeMax }) {
  const lo = Date.parse(timeMin);
  const hi = Date.parse(timeMax);
  const exceptions = new Map(events.filter((e) => e?.recurringEventId).map((e) => [e.id, e]));
  const out = [];
  for (const e of events) {
    if (!e || e.status === "cancelled" || e.recurringEventId || (Array.isArray(e.recurrence) && e.recurrence.length)) continue;
    if (inWindow(e, lo, hi)) out.push(structuredClone(e));
  }
  for (const m of events) {
    if (!m || m.status === "cancelled" || !Array.isArray(m.recurrence) || !m.recurrence.length) continue;
    for (const occ of occurrences(m, lo, hi)) {
      const exc = exceptions.get(occ.id);
      if (exc) {
        if (exc.status !== "cancelled") out.push(structuredClone(exc));
        continue;
      }
      const rest = structuredClone(m);
      delete rest.recurrence;
      out.push({ ...rest, id: occ.id, recurringEventId: m.id, originalStartTime: occ.start, start: occ.start, end: occ.end });
    }
  }
  return out;
}
