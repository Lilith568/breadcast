// Breadcast engine: censored quantile regression for bakery demand, newsvendor bake plans
// and a waste-focused backtest. Pure functions; runs in browsers and Node 20+.

export const FIELDS = ['date', 'product', 'baked', 'sold', 'rain', 'temp_c', 'holiday'];

// ---------- CSV ----------
export function parseCSV(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l, i) => { const v = split(l); const o = { __line: i + 2 }; head.forEach((h, j) => { o[h] = v[j] ?? ''; }); return o; });
}

export function toCSV(rows, fields) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [fields.join(','), ...rows.map((r) => fields.map((f) => esc(r[f])).join(','))].join('\n');
}

// ---------- dates ----------
const DAY = 86400000;
export const parseDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim()); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
export const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
const weekday = (t) => (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
const dayOfYear = (t) => Math.floor((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY);
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- data preparation ----------
const truthy = (v) => /^(1|true|yes|y|x)$/i.test(String(v ?? '').trim());

export function normalise(raw) {
  const rows = []; const problems = [];
  for (const r of raw) {
    const t = parseDate(r.date); const baked = Number(r.baked); const sold = Number(r.sold);
    if (!Number.isFinite(t) || !r.product || !Number.isFinite(baked) || !Number.isFinite(sold) || baked < 0 || sold < 0) {
      problems.push(`Line ${r.__line}: needs date (YYYY-MM-DD), product, baked and sold as numbers.`); continue;
    }
    rows.push({ t, date: fmtDate(t), product: String(r.product).trim(), baked, sold: Math.min(sold, baked), rain: truthy(r.rain), temp: r.temp_c === '' || r.temp_c === undefined ? null : Number(r.temp_c), holiday: truthy(r.holiday) });
  }
  rows.sort((a, b) => a.t - b.t || a.product.localeCompare(b.product));
  return { rows, problems };
}

/** A day counts as sold out (demand censored) when (almost) everything baked was sold. */
export const isCensored = (r) => r.sold >= r.baked - Math.max(0, Math.floor(r.baked * 0.01));

export function features(r, history, flags) {
  // history: earlier rows of the same product, oldest first
  const wd = weekday(r.t); const doy = dayOfYear(r.t);
  const sameWd = history.filter((h) => weekday(h.t) === wd).slice(-4);
  const last7 = history.slice(-7);
  const lg = (x) => Math.log1p(x);
  const meanLog = (arr) => (arr.length ? arr.reduce((s, h) => s + lg(h.sold), 0) / arr.length : NaN);
  const f = [1];
  for (let d = 1; d < 7; d++) f.push(wd === d ? 1 : 0);
  f.push(Math.sin((2 * Math.PI * doy) / 365.25), Math.cos((2 * Math.PI * doy) / 365.25));
  f.push(flags.holiday ? 1 : 0, flags.preHoliday ? 1 : 0, flags.rain ? 1 : 0, flags.temp ?? 0);
  f.push(meanLog(sameWd), meanLog(last7));
  return f;
}
export const FEATURE_NAMES = ['intercept', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'season sin', 'season cos', 'holiday', 'day before holiday', 'rain', 'temperature', 'same weekday (last 4)', 'last 7 days'];

export function buildDataset(rows) {
  const byProduct = new Map();
  for (const r of rows) (byProduct.get(r.product) || byProduct.set(r.product, []).get(r.product)).push(r);
  const holidays = new Set(rows.filter((r) => r.holiday).map((r) => r.date));
  const out = new Map();
  for (const [p, list] of byProduct) {
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const hist = list.slice(Math.max(0, i - 35), i);
      if (hist.length < 28) continue; // need four weeks of history for lag features
      const preHoliday = holidays.has(fmtDate(r.t + DAY));
      const x = features(r, hist, { holiday: r.holiday, preHoliday, rain: r.rain, temp: r.temp });
      if (x.some((v) => !Number.isFinite(v))) continue;
      items.push({ row: r, x, y: Math.log1p(r.sold), censored: isCensored(r) });
    }
    out.set(p, { rows: list, items });
  }
  return out;
}

// ---------- censored linear quantile regression ----------
// Minimises the pinball loss in log space. For sold-out days we only know demand >= sold,
// so predicting above the observation is not penalised (left-censored likelihood idea).

export function fitQuantile(items, q, { epochs = 700, lr = 0.05, l2 = 1e-3 } = {}) {
  const d = items[0].x.length;
  const mu = new Array(d).fill(0); const sd = new Array(d).fill(1);
  for (let j = 1; j < d; j++) {
    const col = items.map((it) => it.x[j]);
    mu[j] = col.reduce((a, b) => a + b, 0) / col.length;
    const v = col.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / col.length;
    sd[j] = Math.sqrt(v) || 1;
  }
  const X = items.map((it) => it.x.map((v, j) => (j === 0 ? 1 : (v - mu[j]) / sd[j])));
  const w = new Array(d).fill(0);
  w[0] = items.reduce((s, it) => s + it.y, 0) / items.length;
  const m = new Array(d).fill(0); const v2 = new Array(d).fill(0);
  const b1 = 0.9; const b2 = 0.999; const eps = 1e-8;
  for (let e = 1; e <= epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const pred = dot(w, X[i]); const r = items[i].y - pred;
      let gi;
      if (r > 0) gi = -q; // under-predicted
      else if (r < 0) gi = items[i].censored ? 0 : 1 - q; // over-predicted (unknown if sold out)
      else gi = 0;
      for (let j = 0; j < d; j++) g[j] += gi * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      g[j] = g[j] / X.length + (j === 0 ? 0 : l2 * w[j]);
      m[j] = b1 * m[j] + (1 - b1) * g[j];
      v2[j] = b2 * v2[j] + (1 - b2) * g[j] * g[j];
      const mh = m[j] / (1 - b1 ** e); const vh = v2[j] / (1 - b2 ** e);
      w[j] -= (lr / (1 + e / 300)) * mh / (Math.sqrt(vh) + eps);
    }
  }
  return { w, mu, sd, q, predictLog: (x) => dot(w, x.map((v, j) => (j === 0 ? 1 : (v - mu[j]) / sd[j]))) };
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Original-scale coefficients-free importance: |weight| on standardised features. */
export function importance(model) {
  return FEATURE_NAMES.slice(1).map((name, k) => ({ name, weight: model.w[k + 1] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

/** Per-prediction explanation: contribution of each feature group to the (log) forecast vs. an average day. */
export function explain(model, x) {
  const groups = new Map();
  FEATURE_NAMES.forEach((name, j) => {
    if (j === 0) return;
    const g = /^(Tue|Wed|Thu|Fri|Sat|Sun)$/.test(name) ? 'weekday' : name.startsWith('season') ? 'season' : name;
    const c = model.w[j] * ((x[j] - model.mu[j]) / model.sd[j]);
    groups.set(g, (groups.get(g) || 0) + c);
  });
  return [...groups].map(([name, effect]) => ({ name, effect })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
}

// ---------- economics ----------
/** Newsvendor critical ratio. price, cost, salvage per unit; wastePenalty = extra cost you assign to each wasted unit. */
export function criticalRatio({ price, cost, salvage = 0, wastePenalty = 0 }) {
  const under = Math.max(0, price - cost);
  const over = Math.max(0, cost - salvage + wastePenalty);
  if (under + over === 0) return 0.5;
  return Math.min(0.98, Math.max(0.02, under / (under + over)));
}

// ---------- backtest ----------
/**
 * Splits each product's history: trains on everything before the last `testDays` days,
 * then compares the bakery's actual bake quantities with Breadcast's recommendations on the test days.
 * Waste is evaluated conservatively: on sold-out days true demand is unknown, so we assume demand = sold
 * (this can only overstate Breadcast's waste and understate its lost sales).
 */
export function backtest(rows, econByProduct, { testDays = 56 } = {}) {
  const data = buildDataset(rows);
  const products = [];
  for (const [product, { items }] of data) {
    if (items.length < testDays + 60) continue;
    const econ = econByProduct(product);
    const q = criticalRatio(econ);
    const cut = items[items.length - 1].row.t - testDays * DAY;
    const train = items.filter((it) => it.row.t <= cut);
    const test = items.filter((it) => it.row.t > cut);
    const model = fitQuantile(train, q);
    const days = test.map((it) => {
      const rec = Math.max(0, Math.round(Math.expm1(model.predictLog(it.x))));
      const demandKnown = !it.censored;
      const demand = it.row.sold; // lower bound when censored
      const soldRec = Math.min(rec, demand);
      return {
        date: it.row.date, baked: it.row.baked, sold: it.row.sold, censored: it.censored, rec,
        wasteActual: it.row.baked - it.row.sold,
        wasteRec: Math.max(0, rec - demand),
        soldOutActual: it.censored,
        shortRec: demandKnown ? Math.max(0, demand - rec) : Math.max(0, demand - rec), // at least this many
        soldRec,
      };
    });
    const sum = (k) => days.reduce((s, d) => s + d[k], 0);
    const bakedA = sum('baked'); const bakedR = sum('rec');
    const res = {
      product, q, econ, model, days,
      bakedActual: bakedA, bakedRec: bakedR,
      wasteActual: sum('wasteActual'), wasteRec: sum('wasteRec'),
      soldActual: sum('sold'), soldRec: sum('soldRec'),
      soldOutDaysActual: days.filter((d) => d.soldOutActual).length,
      shortDaysRec: days.filter((d) => d.shortRec > 0).length,
    };
    res.wasteRateActual = bakedA ? res.wasteActual / bakedA : 0;
    res.wasteRateRec = bakedR ? res.wasteRec / bakedR : 0;
    res.marginActual = res.soldActual * econ.price - bakedA * econ.cost + res.wasteActual * (econ.salvage || 0);
    res.marginRec = res.soldRec * econ.price - bakedR * econ.cost + res.wasteRec * (econ.salvage || 0);
    products.push(res);
  }
  const tot = (k) => products.reduce((s, p) => s + p[k], 0);
  const summary = {
    testDays, products: products.length,
    wasteActual: tot('wasteActual'), wasteRec: tot('wasteRec'),
    bakedActual: tot('bakedActual'), bakedRec: tot('bakedRec'),
    soldActual: tot('soldActual'), soldRec: tot('soldRec'),
    marginActual: tot('marginActual'), marginRec: tot('marginRec'),
  };
  summary.wasteReduction = summary.wasteActual ? 1 - summary.wasteRec / summary.wasteActual : 0;
  return { products, summary };
}

// ---------- bake plan for the next day ----------
export function bakePlan(rows, econByProduct, { date, rain = false, temp = null, holiday = false, preHoliday = false } = {}) {
  const data = buildDataset(rows);
  const plan = [];
  for (const [product, { rows: list, items }] of data) {
    if (items.length < 60) continue;
    const econ = econByProduct(product);
    const q = criticalRatio(econ);
    const t = date ? parseDate(date) : list[list.length - 1].t + DAY;
    const hist = list.filter((r) => r.t < t).slice(-35);
    const x = features({ t }, hist, { holiday, preHoliday, rain, temp: temp ?? hist.at(-1)?.temp ?? 0 });
    const model = fitQuantile(items, q);
    const lo = fitQuantile(items, 0.25);
    const hi = fitQuantile(items, 0.9);
    const rec = Math.max(0, Math.round(Math.expm1(model.predictLog(x))));
    const sameWd = hist.filter((h) => weekday(h.t) === weekday(t)).slice(-1)[0];
    plan.push({
      product, date: fmtDate(t), weekday: WEEKDAYS[weekday(t)], q, rec,
      low: Math.max(0, Math.round(Math.expm1(lo.predictLog(x)))), high: Math.max(0, Math.round(Math.expm1(hi.predictLog(x)))),
      lastSameWeekday: sameWd ? { baked: sameWd.baked, sold: sameWd.sold } : null,
      top: explain(model, x).slice(0, 3),
    });
  }
  return plan;
}

// ---------- synthetic sample ----------
export function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Synthetic one-bakery history with weekday, seasonal, holiday and weather effects.
 *  The "baked" column mimics a common rule of thumb: average sales of the last four same weekdays plus 20%. */
export function syntheticHistory({ start = '2025-09-01', days = 420, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => { let u = 0; let v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const products = [
    { name: 'Wheat roll', base: 240, wd: [0.85, 0.85, 0.9, 0.9, 1.05, 1.6, 1.3], summer: -0.05, rain: -0.08 },
    { name: 'Rye loaf', base: 42, wd: [0.9, 0.95, 1, 0.95, 1.15, 1.35, 0.4], summer: -0.12, rain: 0.03 },
    { name: 'Croissant', base: 70, wd: [0.8, 0.8, 0.85, 0.9, 1, 1.55, 1.7], summer: 0.05, rain: -0.12 },
    { name: 'Pretzel', base: 95, wd: [1, 1, 1, 1.05, 1.15, 1.05, 0.6], summer: 0.08, rain: -0.1 },
    { name: 'Cinnamon bun', base: 34, wd: [0.7, 0.75, 0.8, 0.85, 1, 1.5, 1.6], summer: -0.25, rain: 0.1 },
  ];
  const t0 = parseDate(start);
  const holidayDates = new Set(['2025-10-03', '2025-12-25', '2025-12-26', '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-10-03']);
  const rows = []; const lastSold = new Map();
  for (let i = 0; i < days; i++) {
    const t = t0 + i * DAY; const date = fmtDate(t); const wd = weekday(t); const doy = dayOfYear(t);
    const summer = Math.cos((2 * Math.PI * (doy - 196)) / 365.25); // +1 mid-July, −1 mid-January
    const temp = Math.round((10 + 9 * summer + gauss() * 3) * 10) / 10;
    const rain = rnd() < 0.32;
    const holiday = holidayDates.has(date);
    const preHoliday = holidayDates.has(fmtDate(t + DAY));
    for (const p of products) {
      let mean = p.base * p.wd[wd] * (1 + p.summer * summer) * (rain ? 1 + p.rain : 1);
      if (holiday) mean *= p.name === 'Rye loaf' || p.name === 'Pretzel' ? 0.45 : 1.25;
      if (preHoliday) mean *= 1.3;
      const demand = Math.max(0, Math.round(mean * Math.exp(gauss() * 0.13)));
      const key = `${p.name}|${wd}`;
      const past = lastSold.get(key) ?? [];
      const ref = past.length ? past.reduce((a, b) => a + b, 0) / past.length : mean;
      const baked = Math.max(5, Math.round((ref * 1.2) / 5) * 5);
      const sold = Math.min(demand, baked);
      lastSold.set(key, [...past, sold].slice(-4));
      rows.push({ date, product: p.name, baked, sold, rain: rain ? 1 : 0, temp_c: temp, holiday: holiday ? 1 : 0 });
    }
  }
  return rows;
}
