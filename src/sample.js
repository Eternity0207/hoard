// A fictional person's screenshot pile, drawn on a canvas so the demo (and the
// eval) needs no real data and no image files in the repo. Dates are relative
// to today, so "expired" tickets and "old" one-time codes stay expired.
//
// Every screenshot carries the truth the eval checks against: what kind it is,
// and which sweep rule (if any) should catch it.

const W = 750;
const H = 1334;
const SANS = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';
const MONO = 'Consolas, "Cascadia Mono", Menlo, "Courier New", monospace';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const shortDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const pad = (n) => String(n).padStart(2, '0');

// ---------- Drawing helpers ----------

function font(g, size, weight = 400, family = SANS) {
  g.font = `${weight} ${size}px ${family}`;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function fillRR(g, x, y, w, h, r, color) {
  g.fillStyle = color;
  rr(g, x, y, w, h, r);
  g.fill();
}

function text(g, s, x, y, { size = 30, weight = 400, color = '#111', align = 'left', family = SANS } = {}) {
  font(g, size, weight, family);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillText(s, x, y);
}

// Word-wraps `s` into `maxW` and returns the y below the last line.
function para(g, s, x, y, maxW, { size = 30, lh = 1.35, weight = 400, color = '#111', family = SANS } = {}) {
  font(g, size, weight, family);
  g.fillStyle = color;
  g.textAlign = 'left';
  for (const block of s.split('\n')) {
    let line = '';
    for (const word of block.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, x, y);
        y += size * lh;
        line = word;
      } else line = test;
    }
    g.fillText(line, x, y);
    y += size * lh;
  }
  return y;
}

function lines(g, s, maxW, size, weight = 400) {
  font(g, size, weight);
  const out = [];
  for (const block of s.split('\n')) {
    let line = '';
    for (const word of block.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function statusBar(g, time, dark = false) {
  const c = dark ? '#fff' : '#111';
  text(g, time, 54, 52, { size: 28, weight: 600, color: c });
  // signal bars
  for (let i = 0; i < 4; i++) fillRR(g, 560 + i * 12, 44 - i * 6, 8, 10 + i * 6, 2, c);
  // battery
  g.strokeStyle = c;
  g.lineWidth = 2.5;
  rr(g, 630, 30, 56, 26, 7);
  g.stroke();
  fillRR(g, 634, 34, 38, 18, 4, c);
  fillRR(g, 689, 38, 4, 10, 2, c);
}

function bg(g, color) {
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
}

function navHeader(g, title, { color = '#f7f7f7', fg = '#111', sub, accent = '#0a7cff' } = {}) {
  g.fillStyle = color;
  g.fillRect(0, 0, W, 190);
  text(g, '‹', 30, 150, { size: 64, weight: 300, color: accent });
  text(g, title, W / 2, sub ? 135 : 150, { size: 34, weight: 600, color: fg, align: 'center' });
  if (sub) text(g, sub, W / 2, 172, { size: 24, color: '#888', align: 'center' });
  g.fillStyle = '#ddd';
  g.fillRect(0, 189, W, 1);
}

function bubble(g, s, side, y, { color, fg, name } = {}) {
  const maxW = 460;
  const ls = lines(g, s, maxW - 44, 30);
  font(g, 30);
  const w = Math.min(maxW, Math.max(...ls.map((l) => g.measureText(l).width)) + 44);
  const h = ls.length * 40 + 30;
  const x = side === 'right' ? W - 36 - w : 36;
  if (name) {
    text(g, name, x + 14, y + 4, { size: 22, color: '#777' });
    y += 14;
  }
  fillRR(g, x, y, w, h, 28, color || (side === 'right' ? '#0a7cff' : '#e9e9eb'));
  ls.forEach((l, i) => text(g, l, x + 22, y + 46 + i * 40, { size: 30, color: fg || (side === 'right' ? '#fff' : '#111') }));
  return y + h + 22;
}

// A fake QR code: deterministic noise inside the three finder squares.
function qr(g, x, y, size, seed = 7) {
  const n = 25;
  const c = size / n;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#fff';
  g.fillRect(x - 12, y - 12, size + 24, size + 24);
  g.fillStyle = '#111';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() > 0.52) g.fillRect(x + i * c, y + j * c, c, c);
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    g.fillStyle = '#111';
    g.fillRect(x + fx * c, y + fy * c, 7 * c, 7 * c);
    g.fillStyle = '#fff';
    g.fillRect(x + (fx + 1) * c, y + (fy + 1) * c, 5 * c, 5 * c);
    g.fillStyle = '#111';
    g.fillRect(x + (fx + 2) * c, y + (fy + 2) * c, 3 * c, 3 * c);
  }
}

function notesApp(g, time, title, body, { date } = {}) {
  bg(g, '#fffdf6');
  statusBar(g, time);
  text(g, '‹ Notes', 30, 130, { size: 32, color: '#d4a017' });
  text(g, '⋯', 690, 130, { size: 40, color: '#d4a017', align: 'center' });
  if (date) text(g, date, W / 2, 200, { size: 22, color: '#999', align: 'center' });
  text(g, title, 44, 290, { size: 52, weight: 700 });
  para(g, body, 44, 370, W - 88, { size: 34, lh: 1.5, color: '#222' });
}

function smsApp(g, time, from, msgs) {
  bg(g, '#fff');
  statusBar(g, time);
  navHeader(g, from, { sub: 'Text Message' });
  let y = 250;
  for (const m of msgs) {
    text(g, m.when, W / 2, y, { size: 22, color: '#999', align: 'center' });
    y = bubble(g, m.text, 'left', y + 24);
    y += 16;
  }
}

function chatApp(g, time, title, msgs, { sub = '', accent = '#128c7e', backdrop = '#ece5dd' } = {}) {
  bg(g, backdrop);
  statusBar(g, time, true);
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 190);
  statusBar(g, time, true);
  text(g, '‹', 30, 150, { size: 64, weight: 300, color: '#fff' });
  fillRR(g, 80, 104, 62, 62, 31, '#ffffff55');
  text(g, title, 160, 140, { size: 32, weight: 600, color: '#fff' });
  if (sub) text(g, sub, 160, 174, { size: 22, color: '#dff' });
  let y = 230;
  for (const m of msgs) {
    y = bubble(g, m.text, m.me ? 'right' : 'left', y, {
      color: m.me ? '#dcf8c6' : '#fff', fg: '#111', name: m.me ? null : m.name,
    });
  }
  g.fillStyle = '#f6f6f6';
  g.fillRect(0, H - 110, W, 110);
  fillRR(g, 30, H - 90, 600, 66, 33, '#fff');
  text(g, 'Message', 70, H - 46, { size: 28, color: '#aaa' });
  fillRR(g, 650, H - 92, 70, 70, 35, accent);
}

// ---------- The scenes ----------

function scenes(now) {
  const ago = (days, h = 12, m = 0) => {
    const d = new Date(now.getTime() - days * DAY);
    d.setHours(h, m, Math.floor((days * 37) % 60), 0);
    return d;
  };
  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const S = [];
  const add = (id, when, truth, draw) => S.push({ id, when, truth, draw });

  add('wifi', ago(210, 19, 42), { kind: 'notes' }, (g, t) => notesApp(g, t, "Mum's place",
    'Wi-Fi network: Goyal_Home_5G\nPassword: sunflower-2291\n\nRouter is behind the TV. If it is slow, unplug it for ten seconds.'));

  add('parking', ago(2, 9, 14), { kind: 'notes' }, (g, t) => notesApp(g, t, 'Car',
    'Level 3, Bay C14\nBlue zone, next to lift B\nTicket paid until 6:30 pm'));

  const stay = ago(75);
  add('hotel', ago(96, 22, 5), { kind: 'receipt' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    g.fillStyle = '#003b95';
    g.fillRect(0, 80, W, 140);
    text(g, 'Your booking is confirmed', 40, 170, { size: 38, weight: 700, color: '#fff' });
    text(g, 'Casa do Rio Guesthouse', 40, 300, { size: 40, weight: 700 });
    text(g, 'Rua das Flores 41, Lisbon, Portugal', 40, 350, { size: 28, color: '#555' });
    fillRR(g, 40, 400, W - 80, 260, 18, '#f2f5fb');
    text(g, 'Check-in', 70, 460, { size: 26, color: '#666' });
    text(g, fmtDate(stay), 70, 505, { size: 32, weight: 600 });
    text(g, 'Check-out', 400, 460, { size: 26, color: '#666' });
    text(g, fmtDate(new Date(stay.getTime() + 2 * DAY)), 400, 505, { size: 32, weight: 600 });
    text(g, '2 nights · 1 room · 2 adults', 70, 590, { size: 28, color: '#333' });
    text(g, 'Confirmation number', 40, 740, { size: 28, color: '#666' });
    text(g, '4417 2093 88', 40, 795, { size: 44, weight: 700 });
    text(g, 'PIN code', 40, 870, { size: 28, color: '#666' });
    text(g, '6204', 40, 920, { size: 40, weight: 700 });
    text(g, 'Total price', 40, 1010, { size: 28, color: '#666' });
    text(g, '€184.00', 40, 1065, { size: 44, weight: 700 });
    para(g, 'Free cancellation until 2 days before check-in. Pay at the property.', 40, 1150, W - 80, { size: 26, color: '#555' });
  });

  const flight = ago(60, 7, 25);
  add('boarding', ago(61, 21, 30), { kind: 'ticket', sweep: 'expired' }, (g, t) => {
    bg(g, '#e9eef5');
    statusBar(g, t);
    fillRR(g, 30, 100, W - 60, 1180, 30, '#fff');
    g.fillStyle = '#c8102e';
    rr(g, 30, 100, W - 60, 150, [30, 30, 0, 0]);
    g.fill();
    text(g, 'BOARDING PASS', 70, 195, { size: 40, weight: 800, color: '#fff' });
    text(g, 'LHR', 70, 350, { size: 80, weight: 800 });
    text(g, 'LIS', W - 70, 350, { size: 80, weight: 800, align: 'right' });
    text(g, '✈', W / 2, 340, { size: 60, color: '#c8102e', align: 'center' });
    text(g, 'London Heathrow', 70, 395, { size: 24, color: '#666' });
    text(g, 'Lisbon', W - 70, 395, { size: 24, color: '#666', align: 'right' });
    const cells = [['Passenger', 'A GOYAL'], ['Flight', 'TP 1351'], ['Date', shortDate(flight)], ['Boarding', clock(flight)], ['Gate', 'B32'], ['Seat', '14C']];
    cells.forEach(([k, v], i) => {
      const x = 70 + (i % 2) * 320;
      const y = 490 + Math.floor(i / 2) * 120;
      text(g, k, x, y, { size: 24, color: '#888' });
      text(g, v, x, y + 46, { size: 38, weight: 700 });
    });
    qr(g, W / 2 - 150, 880, 300, 11);
  });

  const gig = ago(40, 19, 30);
  add('concert', ago(70, 13, 2), { kind: 'ticket', sweep: 'expired' }, (g, t) => {
    bg(g, '#1b1035');
    statusBar(g, t, true);
    const grad = g.createLinearGradient(0, 120, W, 520);
    grad.addColorStop(0, '#ff7a59');
    grad.addColorStop(1, '#7b2ff7');
    g.fillStyle = grad;
    rr(g, 40, 120, W - 80, 420, 30);
    g.fill();
    text(g, 'MOSS & LANTERN', W / 2, 300, { size: 58, weight: 800, color: '#fff', align: 'center' });
    text(g, 'Autumn Tour', W / 2, 360, { size: 34, color: '#fff', align: 'center' });
    text(g, 'Live at Roundhouse Hall', W / 2, 420, { size: 30, color: '#fff', align: 'center' });
    text(g, `${fmtDate(gig)} · Doors 7:30 pm`, W / 2, 620, { size: 30, color: '#fff', align: 'center' });
    text(g, 'Standing · General admission · 2 tickets', W / 2, 670, { size: 26, color: '#cbb', align: 'center' });
    qr(g, W / 2 - 160, 740, 320, 23);
    text(g, 'Order 88-21093 · Show this at the door', W / 2, 1150, { size: 26, color: '#cbb', align: 'center' });
  });

  const appt = new Date(now.getTime() + 17 * DAY);
  add('dentist', ago(3, 11, 20), { kind: 'calendar' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    text(g, '‹ Calendar', 30, 130, { size: 32, color: '#e53935' });
    text(g, 'Edit', W - 40, 130, { size: 32, color: '#e53935', align: 'right' });
    text(g, 'Dentist check-up', 44, 260, { size: 50, weight: 700 });
    text(g, 'Smile Dental, 14 Park Road', 44, 320, { size: 30, color: '#666' });
    text(g, fmtDate(appt), 44, 420, { size: 34, weight: 600 });
    text(g, 'from 10:30 to 11:00', 44, 470, { size: 32, color: '#444' });
    g.fillStyle = '#eee';
    g.fillRect(44, 520, W - 88, 2);
    text(g, 'Calendar', 44, 590, { size: 30 });
    text(g, '● Personal', W - 44, 590, { size: 30, color: '#e53935', align: 'right' });
    text(g, 'Alert', 44, 670, { size: 30 });
    text(g, '1 day before', W - 44, 670, { size: 30, color: '#888', align: 'right' });
    text(g, 'Notes', 44, 760, { size: 30 });
    para(g, 'Dr. Mehta. Bring the insurance card. Ask about the night guard.', 44, 810, W - 88, { size: 30, color: '#555' });
  });

  const dinner = [
    { name: 'Sam', text: 'Are we still on for Friday?' },
    { name: 'Nia', text: 'Yes! 8pm at Noodle Bar on King Street' },
    { me: true, text: 'Can someone book a table for 6?' },
    { name: 'Sam', text: 'Booked it, under Sam. See you all there' },
  ];
  add('dinner-1', ago(5, 21, 4), { kind: 'chat', sweep: 'duplicate', dupOf: 'dinner-3' }, (g, t) => chatApp(g, t, 'Friday dinner', dinner, { sub: 'Sam, Nia, Leo, you' }));
  add('dinner-2', ago(5, 21, 4), { kind: 'chat', sweep: 'duplicate', dupOf: 'dinner-3' }, (g, t) => chatApp(g, t, 'Friday dinner', dinner, { sub: 'Sam, Nia, Leo, you' }));
  add('dinner-3', ago(5, 21, 6), { kind: 'chat' }, (g, t) => chatApp(g, t, 'Friday dinner', [...dinner, { name: 'Leo', text: 'Perfect, thanks!' }], { sub: 'Sam, Nia, Leo, you' }));

  add('rent', ago(30, 10, 11), { kind: 'chat' }, (g, t) => chatApp(g, t, 'Mr Patel (landlord)', [
    { name: 'Mr Patel', text: 'Hi! Just a reminder that rent of £950 is due on the 1st. Same account as before.' },
    { me: true, text: 'Thanks, I will send it on the 30th.' },
    { name: 'Mr Patel', text: 'Also the plumber is coming on Tuesday at 9am to look at the boiler.' },
  ], { sub: 'last seen today' }));

  add('party', ago(12, 18, 33), { kind: 'chat' }, (g, t) => chatApp(g, t, 'Maya', [
    { name: 'Maya', text: 'Party at mine on Saturday from 7!' },
    { name: 'Maya', text: '27 Willow Lane, flat 4. Buzz twice, the bell is broken' },
    { me: true, text: 'Amazing, I will bring snacks' },
  ], { accent: '#5b4bdb', backdrop: '#f1effd' }));

  const recipe = (g, t) => notesApp(g, t, 'Lemon garlic pasta',
    'Serves 2 · 20 minutes\n\n200 g spaghetti\n3 cloves garlic, sliced\n1 lemon, zest and juice\n40 g parmesan\nA handful of parsley\n\nCook the pasta. Fry the garlic in olive oil, add lemon, pasta and a splash of pasta water. Finish with parmesan.');
  add('recipe-1', ago(120, 17, 2), { kind: 'notes', sweep: 'duplicate', dupOf: 'recipe-2' }, recipe);
  add('recipe-2', ago(119, 18, 40), { kind: 'notes' }, recipe);

  add('otp-1', ago(1, 8, 2), { kind: 'code' }, (g, t) => smsApp(g, t, 'HOARDBANK', [{ when: 'Today 08:02', text: 'Your Hoardbank login code is 482913. Do not share it with anyone.' }]));
  add('otp-2', ago(8, 13, 45), { kind: 'code', sweep: 'code' }, (g, t) => smsApp(g, t, '72510', [{ when: 'Tue 13:45', text: 'Use 7731 to verify your account. This code expires in 5 minutes.' }]));
  add('otp-3', ago(25, 20, 12), { kind: 'code', sweep: 'code' }, (g, t) => smsApp(g, t, 'ParcelPost', [{ when: '20:12', text: 'Your one-time password is 902114. Valid for 10 minutes.' }]));
  add('otp-4', ago(90, 7, 51), { kind: 'code', sweep: 'code' }, (g, t) => smsApp(g, t, '22000', [{ when: '07:51', text: 'G-552019 is your verification code.' }]));

  add('typeerror', ago(14, 23, 48), { kind: 'code-error' }, (g, t) => {
    bg(g, '#1e1e1e');
    statusBar(g, t, true);
    text(g, 'Console', 40, 140, { size: 30, weight: 600, color: '#ddd' });
    g.fillStyle = '#3a1d1d';
    g.fillRect(0, 180, W, 300);
    para(g, "✖ Uncaught TypeError: Cannot read properties of undefined (reading 'map')", 40, 240, W - 80, { size: 28, color: '#ff8080', family: MONO });
    para(g, '    at TodoList (TodoList.jsx:42:18)\n    at renderWithHooks (react-dom.js:1123)\n    at mountIndeterminateComponent', 40, 360, W - 80, { size: 24, color: '#e0a0a0', family: MONO });
    para(g, 'TodoList.jsx\n40  export function TodoList({ items }) {\n41    return <ul>\n42      {items.map((i) => <li>{i}</li>)}\n43    </ul>;\n44  }', 40, 560, W - 80, { size: 26, color: '#9cdcfe', family: MONO, lh: 1.6 });
  });

  add('npm-error', ago(45, 16, 20), { kind: 'code-error' }, (g, t) => {
    bg(g, '#0c0c0c');
    statusBar(g, t, true);
    para(g, '$ npm install\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! Found: react@18.3.1\nnpm ERR! Could not resolve dependency:\nnpm ERR! peer react@"^17.0.0" from legacy-charts@2.4.0\nnpm ERR! Fix the upstream dependency conflict, or retry with --legacy-peer-deps', 30, 160, W - 60, { size: 26, color: '#d0d0d0', family: MONO, lh: 1.6 });
  });

  add('snippet', ago(100, 15, 3), { kind: 'code-error' }, (g, t) => {
    bg(g, '#282c34');
    statusBar(g, t, true);
    para(g, '// wait until the user stops typing\nfunction debounce(fn, ms = 300) {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}\n\nconst onSearch = debounce((q) => {\n  fetchResults(q);\n}, 250);', 30, 180, W - 60, { size: 27, color: '#abb2bf', family: MONO, lh: 1.7 });
  });

  add('order', ago(9, 12, 26), { kind: 'receipt' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    fillRR(g, 40, 120, 90, 90, 45, '#2e7d32');
    text(g, '✓', 85, 186, { size: 54, weight: 700, color: '#fff', align: 'center' });
    text(g, 'Order placed, thank you!', 150, 180, { size: 36, weight: 700 });
    text(g, 'Order #112-4839201', 40, 300, { size: 30, color: '#555' });
    fillRR(g, 40, 340, 200, 200, 16, '#f0f0f0');
    fillRR(g, 85, 400, 50, 80, 20, '#333');
    fillRR(g, 145, 400, 50, 80, 20, '#333');
    text(g, 'Wireless earbuds, black', 270, 400, { size: 30, weight: 600 });
    text(g, 'Qty 1 · £39.99', 270, 450, { size: 28, color: '#555' });
    text(g, 'Arriving Thursday', 40, 640, { size: 36, weight: 700, color: '#2e7d32' });
    text(g, 'Tracking number', 40, 720, { size: 28, color: '#666' });
    text(g, 'TP 4417 9920 5531 GB', 40, 770, { size: 36, weight: 600 });
    text(g, 'Delivery to: 12 Elm Court, Leeds', 40, 860, { size: 28, color: '#555' });
  });

  add('payment', ago(20, 14, 15), { kind: 'receipt' }, (g, t) => {
    bg(g, '#f4f7fb');
    statusBar(g, t);
    fillRR(g, W / 2 - 70, 200, 140, 140, 70, '#1a73e8');
    text(g, '✓', W / 2, 300, { size: 80, weight: 700, color: '#fff', align: 'center' });
    text(g, '₹2,500', W / 2, 470, { size: 80, weight: 700, align: 'center' });
    text(g, 'Paid to Priya Sharma', W / 2, 540, { size: 34, align: 'center' });
    text(g, 'priya.s@okbank', W / 2, 590, { size: 26, color: '#666', align: 'center' });
    fillRR(g, 40, 680, W - 80, 330, 20, '#fff');
    text(g, 'For: concert tickets 🎶', 70, 750, { size: 30 });
    text(g, 'UPI transaction ID', 70, 830, { size: 26, color: '#666' });
    text(g, '4290 1183 0071', 70, 875, { size: 32, weight: 600 });
    text(g, shortDate(ago(20)) + ', 2:15 pm', 70, 950, { size: 26, color: '#666' });
  });

  add('map', ago(12, 18, 55), { kind: 'map' }, (g, t) => {
    bg(g, '#eae6df');
    g.fillStyle = '#c8e6c9';
    rr(g, 380, 300, 300, 260, 30);
    g.fill();
    g.fillStyle = '#aad3df';
    g.beginPath();
    g.moveTo(0, 820); g.bezierCurveTo(200, 760, 420, 900, 750, 800); g.lineTo(750, 880); g.bezierCurveTo(420, 980, 200, 840, 0, 900); g.fill();
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    for (const [x1, y1, x2, y2, w] of [[0, 250, 750, 330, 26], [120, 0, 260, 1334, 30], [0, 640, 750, 600, 22], [520, 0, 600, 1334, 18], [0, 1100, 750, 1040, 24]]) {
      g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.strokeStyle = '#4285f4';
    g.lineWidth = 12;
    g.beginPath(); g.moveTo(190, 1200); g.lineTo(230, 620); g.lineTo(560, 610); g.lineTo(540, 430); g.stroke();
    fillRR(g, 170, 1180, 40, 40, 20, '#4285f4');
    g.fillStyle = '#ea4335';
    g.beginPath(); g.arc(540, 400, 30, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(515, 415); g.lineTo(540, 460); g.lineTo(565, 415); g.fill();
    text(g, 'Roundhouse Hall', 470, 360, { size: 24, weight: 600, color: '#333', align: 'center' });
    text(g, 'Chalk Farm Rd', 330, 280, { size: 20, color: '#777' });
    statusBar(g, t);
    fillRR(g, 30, 90, W - 60, 90, 45, '#fff');
    text(g, 'Roundhouse Hall', 80, 148, { size: 30 });
    fillRR(g, 0, H - 230, W, 230, 30, '#fff');
    text(g, '12 min', 40, H - 150, { size: 42, weight: 700, color: '#188038' });
    text(g, '(900 m)', 200, H - 150, { size: 32, color: '#666' });
    text(g, 'Fastest route, the usual traffic', 40, H - 95, { size: 26, color: '#666' });
  });

  add('sunset', ago(150, 19, 58), { kind: 'photo' }, (g) => {
    const sky = g.createLinearGradient(0, 0, 0, 760);
    sky.addColorStop(0, '#2b1055');
    sky.addColorStop(0.5, '#d53369');
    sky.addColorStop(1, '#ffb347');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, 760);
    g.fillStyle = '#ffe29a';
    g.beginPath(); g.arc(W / 2, 700, 110, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a1c4a';
    g.beginPath(); g.moveTo(0, 760); g.lineTo(0, 560); g.lineTo(160, 420); g.lineTo(290, 600); g.lineTo(420, 470); g.lineTo(600, 640); g.lineTo(750, 500); g.lineTo(750, 760); g.fill();
    const lake = g.createLinearGradient(0, 760, 0, H);
    lake.addColorStop(0, '#f08a5d');
    lake.addColorStop(1, '#2b1055');
    g.fillStyle = lake;
    g.fillRect(0, 760, W, H - 760);
    g.fillStyle = '#ffe29a88';
    for (let i = 0; i < 14; i++) fillRR(g, W / 2 - 120 + (i % 3) * 30, 790 + i * 34, 240 - (i % 4) * 40, 8, 4, '#ffe29a77');
  });

  add('steps', ago(7, 21, 0), { kind: 'chart' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    text(g, 'Steps', 40, 170, { size: 56, weight: 800 });
    text(g, 'This week', 40, 220, { size: 30, color: '#888' });
    text(g, 'Average 8,214 steps a day', 40, 300, { size: 34, weight: 600, color: '#e8590c' });
    const vals = [6200, 9100, 7400, 11800, 5300, 10200, 7500];
    vals.forEach((v, i) => {
      const h = (v / 12000) * 600;
      fillRR(g, 60 + i * 95, 1000 - h, 60, h, 12, i === 3 ? '#e8590c' : '#ffc9a8');
      text(g, 'MTWTFSS'[i], 90 + i * 95, 1050, { size: 28, color: '#888', align: 'center' });
    });
    g.fillStyle = '#ddd';
    g.fillRect(40, 1000, W - 80, 2);
    text(g, 'Best day: Thursday, 11,800 steps', 40, 1140, { size: 30, color: '#333' });
  });

  add('shoes', ago(33, 22, 40), { kind: 'shopping' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    fillRR(g, 0, 90, W, 600, 0, '#f3f1ec');
    g.fillStyle = '#4f772d';
    g.beginPath(); g.moveTo(150, 520); g.bezierCurveTo(180, 380, 300, 330, 380, 360); g.lineTo(470, 420); g.bezierCurveTo(560, 450, 620, 480, 620, 540); g.lineTo(150, 560); g.fill();
    fillRR(g, 140, 540, 490, 50, 20, '#e9e5dc');
    g.strokeStyle = '#fff'; g.lineWidth = 6;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(300 + i * 30, 380 + i * 12); g.lineTo(340 + i * 30, 420 + i * 12); g.stroke(); }
    text(g, 'Trail Runner 2', 40, 790, { size: 48, weight: 700 });
    text(g, "Men's running shoe · Moss green", 40, 845, { size: 30, color: '#666' });
    text(g, '£89.99', 40, 930, { size: 46, weight: 700 });
    text(g, '£120.00', 230, 930, { size: 30, color: '#999' });
    text(g, 'Only 2 left in size 9', 40, 1000, { size: 30, color: '#c92a2a' });
    fillRR(g, 40, 1090, W - 80, 100, 50, '#111');
    text(g, 'Add to bag', W / 2, 1155, { size: 34, weight: 600, color: '#fff', align: 'center' });
  });

  add('books', ago(160, 23, 12), { kind: 'notes' }, (g, t) => notesApp(g, t, 'Books to read',
    '• The Overstory\n• Piranesi\n• Four Thousand Weeks\n• A Psalm for the Wild-Built\n• The Remains of the Day\n\n(from Leo, said start with Piranesi)'));

  add('train', ago(18, 7, 49), { kind: 'notes' }, (g, t) => {
    bg(g, '#0b1d3a');
    statusBar(g, t, true);
    text(g, 'Departures', 40, 170, { size: 50, weight: 700, color: '#fff' });
    text(g, 'Central Station', 40, 220, { size: 30, color: '#9fb3d1' });
    const rows = [['08:12', 'Brighton', '4', 'On time'], ['08:20', 'Cambridge', '9', 'On time'], ['08:31', 'Oxford', '2', 'Delayed 08:44'], ['08:45', 'Brighton', '4', 'On time'], ['09:02', 'Bristol', '11', 'Cancelled']];
    text(g, 'Time   Destination           Plat   Status', 40, 310, { size: 24, color: '#9fb3d1' });
    rows.forEach(([tm, dest, pl, st], i) => {
      const y = 390 + i * 100;
      text(g, tm, 40, y, { size: 32, weight: 600, color: '#ffd166' });
      text(g, dest, 160, y, { size: 32, color: '#fff' });
      text(g, pl, 470, y, { size: 32, color: '#fff' });
      text(g, st, 540, y, { size: 26, color: st === 'On time' ? '#06d6a0' : '#ef476f' });
    });
  });

  add('prescription', ago(50, 9, 3), { kind: 'notes' }, (g, t) => notesApp(g, t, 'Medicine',
    'Amoxicillin 500 mg\nOne capsule three times a day for 7 days.\nTake with food. Finish the whole course.\n\nIbuprofen 200 mg only if needed, max 3 a day.'));

  const post = (g, t, handle, name, body, likes) => {
    bg(g, '#fff');
    statusBar(g, t);
    text(g, 'Post', W / 2, 140, { size: 32, weight: 700, align: 'center' });
    g.fillStyle = '#eee';
    g.fillRect(0, 180, W, 1);
    fillRR(g, 40, 220, 90, 90, 45, '#9c6644');
    text(g, name, 150, 255, { size: 32, weight: 700 });
    text(g, handle, 150, 295, { size: 28, color: '#777' });
    const y = para(g, body, 40, 390, W - 80, { size: 40, lh: 1.35 });
    text(g, `♥ ${likes}   ↻ ${Math.round(parseFloat(likes) * 120)}   💬 318`, 40, y + 60, { size: 28, color: '#777' });
  };
  add('post-sloth', ago(65, 12, 40), { kind: 'social' }, (g, t) => post(g, t, '@slowdev', 'slow dev', "I don't procrastinate. I just run my to-do list in sloth mode and let the background jobs finish.", '2.4K'));
  add('post-tomorrow', ago(140, 0, 31), { kind: 'social' }, (g, t) => post(g, t, '@nightowl', 'night owl', "Reminder that 'I'll do it tomorrow' is a perfectly valid scheduling algorithm.", '9.1K'));

  add('homescreen', ago(6, 15, 0), { kind: 'screen', sweep: 'accidental' }, (g, t) => {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#355c7d');
    grad.addColorStop(1, '#c06c84');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    statusBar(g, t, true);
    const names = ['Mail', 'Photos', 'Maps', 'Music', 'Notes', 'Clock', 'Camera', 'Settings', 'Weather', 'Wallet', 'Health', 'Files', 'Podcasts', 'Books', 'Store', 'Calc'];
    const cols = ['#4dabf7', '#f783ac', '#69db7c', '#ff6b6b', '#ffd43b', '#343a40', '#868e96', '#adb5bd', '#74c0fc', '#212529', '#ff8787', '#4c6ef5', '#9775fa', '#ff922b', '#339af0', '#495057'];
    names.forEach((n, i) => {
      const x = 60 + (i % 4) * 170;
      const y = 150 + Math.floor(i / 4) * 200;
      fillRR(g, x, y, 120, 120, 28, cols[i]);
      text(g, n, x + 60, y + 160, { size: 22, color: '#fff', align: 'center' });
    });
    fillRR(g, 30, H - 200, W - 60, 170, 50, '#ffffff44');
    for (let i = 0; i < 4; i++) fillRR(g, 75 + i * 165, H - 175, 120, 120, 28, cols[i * 3]);
  });

  add('blank-dark', ago(33, 2, 14), { kind: 'screen', sweep: 'accidental' }, (g, t) => {
    bg(g, '#050505');
    statusBar(g, t, true);
  });

  add('blank-light', ago(100, 9, 9), { kind: 'screen', sweep: 'accidental' }, (g, t) => {
    bg(g, '#fafafa');
    statusBar(g, t);
    fillRR(g, W / 2 - 60, H - 30, 120, 8, 4, '#ccc');
  });

  add('article', ago(80, 22, 22), { kind: 'article' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    text(g, 'NATURE NOTES', 40, 150, { size: 24, weight: 700, color: '#2b8a3e' });
    const y = para(g, 'Why sloths are in no hurry', 40, 220, W - 80, { size: 52, weight: 800, lh: 1.15 });
    para(g, 'A sloth lives on leaves, which carry very little energy. So it saves energy everywhere else: it keeps its body cooler than most mammals, moves only when it has to, and can take a week to digest one meal. Being slow is not laziness. It is a careful budget, and it has worked for millions of years.', 40, y + 30, W - 80, { size: 32, lh: 1.5, color: '#333' });
  });

  add('standup', ago(25, 9, 31), { kind: 'notes' }, (g, t) => notesApp(g, t, 'Standup notes',
    'Ship v2 of the settings page on Friday\nNina owns the release email\nBlocked: waiting on design for the empty state\nNext retro: the 28th'));

  add('gym', ago(55, 6, 40), { kind: 'notes' }, (g, t) => {
    bg(g, '#fff');
    statusBar(g, t);
    text(g, 'Riverside Gym', 40, 160, { size: 48, weight: 800 });
    text(g, 'Class timetable', 40, 210, { size: 30, color: '#888' });
    const rows = [['Mon', '7:00', 'Spin'], ['Mon', '18:30', 'Yoga'], ['Wed', '7:00', 'HIIT'], ['Thu', '19:00', 'Pilates'], ['Sat', '9:30', 'Park run club']];
    rows.forEach(([d, tm, c], i) => {
      const y = 330 + i * 110;
      fillRR(g, 40, y - 60, W - 80, 90, 18, i % 2 ? '#f8f9fa' : '#fff4e6');
      text(g, d, 70, y, { size: 32, weight: 700 });
      text(g, tm, 200, y, { size: 32 });
      text(g, c, 360, y, { size: 32, color: '#d9480f' });
    });
  });

  add('weather', ago(4, 8, 0), { kind: 'other' }, (g, t) => {
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#5f7d95');
    grad.addColorStop(1, '#9db4c0');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    statusBar(g, t, true);
    text(g, 'London', W / 2, 220, { size: 50, color: '#fff', align: 'center' });
    text(g, '14°', W / 2, 400, { size: 170, weight: 200, color: '#fff', align: 'center' });
    text(g, 'Light rain', W / 2, 470, { size: 36, color: '#fff', align: 'center' });
    text(g, 'H:16°  L:9°', W / 2, 520, { size: 32, color: '#fff', align: 'center' });
    fillRR(g, 40, 620, W - 80, 260, 30, '#ffffff33');
    ['Now', '10', '11', '12', '13'].forEach((h, i) => {
      text(g, h, 110 + i * 130, 690, { size: 28, color: '#fff', align: 'center' });
      text(g, i < 2 ? '🌧' : '☁', 110 + i * 130, 780, { size: 44, align: 'center' });
      text(g, `${14 + i}°`, 110 + i * 130, 850, { size: 30, color: '#fff', align: 'center' });
    });
  });

  add('coffee', ago(15, 8, 47), { kind: 'receipt' }, (g, t) => {
    bg(g, '#e9ecef');
    statusBar(g, t);
    fillRR(g, 90, 140, W - 180, 1000, 8, '#fff');
    text(g, 'THE SLOW POUR', W / 2, 240, { size: 40, weight: 800, align: 'center' });
    text(g, 'Coffee & bakery', W / 2, 285, { size: 26, color: '#666', align: 'center' });
    const items = [['Flat white', '3.40'], ['Oat milk', '0.40'], ['Almond croissant', '3.20']];
    items.forEach(([n, p], i) => {
      text(g, n, 130, 400 + i * 60, { size: 30, family: MONO });
      text(g, p, W - 130, 400 + i * 60, { size: 30, family: MONO, align: 'right' });
    });
    g.fillStyle = '#ccc';
    g.fillRect(130, 600, W - 260, 2);
    text(g, 'TOTAL', 130, 660, { size: 34, weight: 700, family: MONO });
    text(g, '£7.00', W - 130, 660, { size: 34, weight: 700, family: MONO, align: 'right' });
    text(g, 'Card ending 4419', 130, 730, { size: 26, color: '#666', family: MONO });
    text(g, shortDate(ago(15)) + ' 08:47', 130, 775, { size: 26, color: '#666', family: MONO });
    text(g, 'Thank you, take it slow!', W / 2, 900, { size: 28, color: '#666', align: 'center' });
  });

  add('playlist', ago(90, 23, 59), { kind: 'other' }, (g, t) => {
    bg(g, '#121212');
    statusBar(g, t, true);
    const grad = g.createLinearGradient(0, 100, 0, 600);
    grad.addColorStop(0, '#2d6a4f');
    grad.addColorStop(1, '#121212');
    g.fillStyle = grad;
    g.fillRect(0, 90, W, 520);
    fillRR(g, W / 2 - 170, 140, 340, 340, 10, '#52b788');
    text(g, 'Rainy day', W / 2, 330, { size: 50, weight: 800, color: '#081c15', align: 'center' });
    text(g, 'Slow songs for a slow afternoon', 40, 560, { size: 30, color: '#ccc' });
    ['Low tide', 'Paper boats', 'Window seat', 'Kettle on', 'Grey Sunday'].forEach((s, i) => {
      const y = 660 + i * 110;
      fillRR(g, 40, y - 50, 80, 80, 6, ['#40916c', '#74c69d', '#1b4332', '#95d5b2', '#2d6a4f'][i]);
      text(g, s, 150, y, { size: 32, color: '#fff' });
      text(g, 'Quiet Harbour', 150, y + 38, { size: 24, color: '#aaa' });
    });
  });

  return S;
}

// ---------- Eval queries ----------
// What someone types, and which screenshot they meant. `visual` marks queries
// where the answer has little or no matching text, so only the image model
// can find it.
export const SAMPLE_QUERIES = [
  { q: 'wifi password', want: 'wifi' },
  { q: 'where did I park', want: 'parking' },
  { q: 'lisbon hotel booking', want: 'hotel' },
  { q: 'flight boarding pass', want: 'boarding' },
  { q: 'pasta recipe', want: ['recipe-1', 'recipe-2'] },
  { q: 'directions to the venue', want: 'map' },
  { q: 'sunset photo', want: 'sunset', visual: true },
  { q: 'the error in my react code', want: 'typeerror' },
  { q: 'when is rent due', want: 'rent' },
  { q: 'dentist appointment', want: 'dentist' },
  { q: 'concert ticket', want: 'concert' },
  { q: 'those green running shoes', want: 'shoes' },
  { q: 'book recommendations', want: 'books' },
  { q: 'how much did I send priya', want: 'payment' },
  { q: 'train times', want: 'train' },
  { q: 'my step count chart', want: 'steps' },
  { q: 'dinner plans with friends', want: ['dinner-1', 'dinner-2', 'dinner-3'] },
  { q: 'tracking number for my order', want: 'order' },
  { q: 'how often do I take the antibiotics', want: 'prescription' },
  { q: 'funny post about procrastinating', want: ['post-sloth', 'post-tomorrow'] },
  { q: 'address for the party', want: 'party' },
  { q: 'yoga class times', want: 'gym' },
  { q: 'is it raining', want: 'weather' },
  { q: 'coffee receipt', want: 'coffee' },
  { q: 'a map', want: 'map', visual: true },
  { q: 'qr code', want: ['boarding', 'concert'], visual: true },
  { q: 'npm dependency conflict', want: 'npm-error' },
  { q: 'debounce function', want: 'snippet' },
  { q: 'article about sloths', want: 'article' },
  { q: 'playlist', want: 'playlist' },
];

// Written before any tuning and never used to pick weights: a check that the
// chosen settings weren't just fitted to the queries above.
export const HELDOUT_QUERIES = [
  { q: 'network password for mums house', want: 'wifi' },
  { q: 'car park level', want: 'parking' },
  { q: 'guesthouse confirmation number', want: 'hotel' },
  { q: 'gate and seat for my flight', want: 'boarding' },
  { q: 'what to cook tonight', want: ['recipe-1', 'recipe-2'] },
  { q: 'cannot read properties of undefined', want: 'typeerror' },
  { q: 'message from my landlord', want: 'rent' },
  { q: 'teeth cleaning', want: 'dentist' },
  { q: 'moss and lantern', want: 'concert' },
  { q: 'trainers in my size', want: 'shoes' },
  { q: 'upi payment', want: 'payment' },
  { q: 'walking route', want: 'map' },
  { q: 'mountains and a lake', want: 'sunset', visual: true },
  { q: 'how many steps on thursday', want: 'steps' },
  { q: 'when are we shipping v2', want: 'standup' },
  { q: 'a black screen', want: 'blank-dark', visual: true },
  { q: 'app icons', want: 'homescreen', visual: true },
  { q: 'weather forecast', want: 'weather' },
  { q: 'croissant', want: 'coffee' },
  { q: 'songs for a rainy day', want: 'playlist' },
];

// ---------- Build the files ----------

const fileName = (d) => `Screenshot_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;

export async function makeSampleHoard(now = new Date()) {
  if (document.fonts?.ready) await document.fonts.ready;
  const out = [];
  for (const s of scenes(now)) {
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    s.draw(g, `${pad(s.when.getHours())}:${pad(s.when.getMinutes())}`);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const file = new File([blob], fileName(s.when), { type: 'image/png', lastModified: s.when.getTime() });
    out.push({ id: s.id, file, truth: s.truth });
  }
  // Two screenshots taken in the same second would share a name; nudge them.
  const seen = new Set();
  for (const o of out) {
    let name = o.file.name;
    for (let i = 2; seen.has(name); i++) name = o.file.name.replace('.png', `(${i}).png`);
    seen.add(name);
    if (name !== o.file.name) o.file = new File([o.file], name, { type: o.file.type, lastModified: o.file.lastModified });
  }
  return out;
}
