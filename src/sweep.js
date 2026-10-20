// Sweep: the screenshots you'd delete if you ever got round to it. Every rule
// explains itself, nothing is deleted, and anything you mark "keep" is never
// suggested again. Rules are deliberately conservative: suggesting a boarding
// pass you still need is far worse than missing a duplicate.

import { hamming } from './analyze.js';
import { isOneTimeCode } from './kinds.js';
import { tokens } from './search.js';

const DAY = 86400000;

export const RULES = {
  duplicate: { title: 'Duplicates', why: 'Same screen captured more than once. Hoard keeps the most complete copy.' },
  code: { title: 'Old one-time codes', why: 'Login and verification codes stop working within minutes.' },
  expired: { title: 'Expired tickets', why: 'Boarding passes and event tickets for dates that have passed.' },
  accidental: { title: 'Accidental screenshots', why: 'Blank screens and home screens, usually taken by mistake.' },
};

function jaccard(a, b) {
  const A = new Set(tokens(a, true)), B = new Set(tokens(b, true));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Two screenshots are the same screen if they look alike AND say the same
// thing. Looks alone would merge every chat in the same app; text alone would
// merge two different photos with no words.
export function isDuplicate(a, b) {
  const d = hamming(a.dhash, b.dhash);
  const la = (a.text || '').length, lb = (b.text || '').length;
  if (la > 40 && lb > 40) return d <= 12 && jaccard(a.text, b.text) >= 0.8;
  return d <= 4 && a.img && b.img && cosine(a.img, b.img) >= 0.97;
}

// ---------- dates on tickets ----------

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

export function findDates(text, fallbackYear) {
  const out = [];
  const t = (text || '').toLowerCase();
  const push = (y, m, d) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return;
    const dt = new Date(y, m, d, 23, 59);
    if (!Number.isNaN(dt.getTime())) out.push(dt.getTime());
  };
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?\\s*(20\\d\\d)?\\b`, 'g'))) {
    push(m[3] ? +m[3] : fallbackYear, MON[m[2].slice(0, 3)], +m[1]);
  }
  for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(20\\d\\d)?\\b`, 'g'))) {
    push(m[3] ? +m[3] : fallbackYear, MON[m[1].slice(0, 3)], +m[2]);
  }
  for (const m of t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) push(+m[1], +m[2] - 1, +m[3]);
  return out;
}

// Words that only appear on the ticket itself, not on a receipt that mentions
// one ("Paid to Priya, for: concert tickets" is not a ticket).
const TICKET_WORDS = /\bboarding pass\b|\bgate\b.*\bseat\b|\bseat\b.*\bgate\b|\badmission\b|\bdoors (open|\d)|\bshow this at\b|\badmit one\b/is;

function expired(shot, now) {
  if (shot.kind === 'receipt' || !TICKET_WORDS.test(shot.text || '')) return false;
  const dates = findDates(shot.text, new Date(shot.takenAt).getFullYear());
  // Every date on it must be in the past, with a day's grace.
  return dates.length > 0 && dates.every((d) => d < now - DAY);
}

function accidental(shot) {
  const chars = (shot.text || '').replace(/\s/g, '').length;
  const blank = shot.lumStd < 6 || (chars < 12 && shot.edgeFrac < 0.01);
  return blank || (shot.kind === 'screen' && chars < 160);
}

// Returns { duplicate: [ids], code: [...], expired: [...], accidental: [...] }
// plus, for duplicates, which copy each one duplicates.
export function suggest(shots, now = Date.now()) {
  const live = shots.filter((s) => !s.kept && !s.swept);
  const out = { duplicate: [], code: [], expired: [], accidental: [] };
  const dupOf = {};
  const taken = new Set();

  // Duplicates: cluster, then keep the copy with the most text, newest on ties.
  const sorted = [...live].sort((a, b) => a.takenAt - b.takenAt);
  const clusters = [];
  for (const s of sorted) {
    const c = clusters.find((cl) => cl.some((x) => Math.abs(x.takenAt - s.takenAt) < 400 * DAY && isDuplicate(x, s)));
    if (c) c.push(s); else clusters.push([s]);
  }
  for (const c of clusters) {
    if (c.length < 2) continue;
    const keep = [...c].sort((a, b) => (b.text || '').length - (a.text || '').length || b.takenAt - a.takenAt)[0];
    for (const s of c) if (s !== keep) { out.duplicate.push(s.id); dupOf[s.id] = keep.id; taken.add(s.id); }
  }

  for (const s of live) {
    if (taken.has(s.id)) continue;
    if (isOneTimeCode(s.text) && now - s.takenAt > 2 * DAY) { out.code.push(s.id); continue; }
    if (expired(s, now)) { out.expired.push(s.id); continue; }
    if (accidental(s)) out.accidental.push(s.id);
  }
  return { groups: out, dupOf };
}
