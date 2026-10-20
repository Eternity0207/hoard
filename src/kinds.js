// What sort of screenshot is this? SigLIP compares the picture with a short
// description of each kind; a few text rules settle the cases where the words
// on screen are a giveaway (a boarding pass says "boarding pass").

export const KINDS = [
  { id: 'chat', label: 'Chats', prompts: ['a screenshot of a chat conversation in a messaging app', 'a screenshot of text messages in speech bubbles'] },
  { id: 'receipt', label: 'Receipts & bookings', prompts: ['a screenshot of an order confirmation', 'a screenshot of a receipt', 'a screenshot of a payment confirmation'] },
  { id: 'ticket', label: 'Tickets', prompts: ['a screenshot of a boarding pass', 'a screenshot of an event ticket with a qr code'] },
  { id: 'code', label: 'One-time codes', prompts: ['a screenshot of a text message with a verification code'] },
  { id: 'code-error', label: 'Code & errors', prompts: ['a screenshot of source code', 'a screenshot of an error message in a terminal'] },
  { id: 'map', label: 'Maps', prompts: ['a screenshot of a map with directions', 'a street map'] },
  { id: 'photo', label: 'Photos', prompts: ['a photo of a landscape', 'a photograph of nature', 'a photo of people'] },
  { id: 'social', label: 'Posts', prompts: ['a screenshot of a social media post', 'a screenshot of a tweet'] },
  { id: 'notes', label: 'Notes & lists', prompts: ['a screenshot of a note with a list', 'a screenshot of a notes app', 'a screenshot of a timetable'] },
  { id: 'calendar', label: 'Calendar', prompts: ['a screenshot of a calendar event'] },
  { id: 'shopping', label: 'Shopping', prompts: ['a screenshot of a product in an online shop'] },
  { id: 'chart', label: 'Charts', prompts: ['a screenshot of a bar chart', 'a screenshot of a graph'] },
  { id: 'article', label: 'Articles', prompts: ['a screenshot of a news article', 'a screenshot of a web page with a paragraph of text'] },
  { id: 'screen', label: 'Home & blank screens', prompts: ['a screenshot of a phone home screen with app icons', 'a blank screen'] },
  { id: 'other', label: 'Other', prompts: ['a screenshot of a phone app', 'a screenshot of a weather app', 'a screenshot of a music app'] },
];
export const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));

// Phrases that settle the kind on their own. Kept strict: a wrong rule is worse
// than letting the image model decide.
const RULES = [
  ['code', (t) => isOneTimeCode(t)],
  ['ticket', (t) => /\bboarding pass\b|\bboarding\b.*\bgate\b|\bgate\b.*\bseat\b|\badmit one\b|\bshow this at the door\b|\bgeneral admission\b/is.test(t)],
  ['code-error', (t) => /\b(npm ERR!|Traceback|Uncaught|TypeError|SyntaxError|ReferenceError|Exception|stack trace)\b|\bfunction\s*\w*\s*\(|=>\s*\{|\bconst \w+ =|\bdef \w+\(|\bimport \w+ from\b/.test(t)],
  ['receipt', (t) => /\b(order (placed|confirmed|number|#)|order #|booking (is )?confirmed|payment (sent|received|successful)|paid to|receipt|transaction id|total price|subtotal)\b/i.test(t)],
  ['calendar', (t) => /\b(from \d{1,2}[:.]\d\d to \d{1,2}[:.]\d\d|all-day|alert\b.*\bbefore|add to calendar)\b/is.test(t)],
];

export function isOneTimeCode(t) {
  if (!t || t.length > 500) return false;
  t = t.replace(/\s+/g, ' ');
  const word = /\b(verification code|verify|one[- ]time (password|code|passcode)|otp|login code|security code|sign[- ]in code|passcode|2fa|authentication code|is your code|your code is)\b/i;
  return word.test(t) && /\b(?:[A-Z]-)?\d{4,8}\b/.test(t);
}

export function ruleKind(text) {
  for (const [id, test] of RULES) if (test(text || '')) return id;
  return null;
}

// prompts -> one averaged SigLIP embedding per kind (computed once in the worker).
export function kindPrompts() {
  return KINDS.flatMap((k) => k.prompts.map((p) => ({ id: k.id, p })));
}

export function averageKinds(rows, vecs) {
  const sums = new Map();
  rows.forEach(({ id }, i) => {
    const v = vecs[i];
    const s = sums.get(id) || new Float32Array(v.length);
    for (let j = 0; j < v.length; j++) s[j] += v[j];
    sums.set(id, s);
  });
  return KINDS.map((k) => {
    const s = sums.get(k.id);
    let n = 0;
    for (const x of s) n += x * x;
    n = Math.sqrt(n) || 1;
    return { id: k.id, vec: s.map((x) => x / n) };
  });
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Picks a kind: a matching text rule wins, otherwise the closest description.
export function classify(text, img, kindVecs) {
  const rule = ruleKind(text);
  const scores = kindVecs.map((k) => ({ id: k.id, s: dot(img, k.vec) })).sort((a, b) => b.s - a.s);
  return { kind: rule || scores[0].id, by: rule ? 'text' : 'image', margin: scores[0].s - scores[1].s };
}
