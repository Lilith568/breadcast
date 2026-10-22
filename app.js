import { parseCSV, toCSV, normalise, backtest, bakePlan, criticalRatio, importance, FIELDS, fmtDate, parseDate } from './forecast.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (v) => Math.round(v).toLocaleString('en-US');
const eur = (v) => `€${Math.round(v).toLocaleString('en-US')}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const SAMPLE_ECON = {
  'Wheat roll': { price: 0.55, cost: 0.15, salvage: 0.05 },
  'Rye loaf': { price: 4.2, cost: 1.3, salvage: 0.4 },
  'Croissant': { price: 1.6, cost: 0.45, salvage: 0.1 },
  'Pretzel': { price: 0.95, cost: 0.25, salvage: 0.05 },
  'Cinnamon bun': { price: 2.6, cost: 0.7, salvage: 0.2 },
};
const state = { rows: [], econ: {}, bt: null, plan: [] };

async function useRaw(raw, label) {
  const { rows, problems } = normalise(raw);
  state.rows = rows;
  const products = [...new Set(rows.map((r) => r.product))].sort();
  for (const p of products) state.econ[p] ??= { ...(SAMPLE_ECON[p] || { price: 1, cost: 0.3, salvage: 0 }) };
  const days = new Set(rows.map((r) => r.date)).size;
  $('data-status').textContent = rows.length
    ? `${label}: ${n0(rows.length)} rows, ${products.length} products, ${days} days (${rows[0].date} to ${rows.at(-1).date}).${problems.length ? ` ${problems.length} rows skipped: ${problems[0]}` : ''}`
    : `No usable rows. ${problems[0] || ''}`;
  if (days < 120 && rows.length) $('data-status').textContent += ' Breadcast needs about four months of history for a backtest.';
  renderEcon();
  $('econ-card').hidden = !rows.length;
  $('results').hidden = true; $('plan-card').hidden = true;
}

$('load-sample').addEventListener('click', async () => {
  const text = await fetch('./sample-bakery.csv').then((r) => r.text());
  await useRaw(parseCSV(text), 'Synthetic sample bakery');
});
$('file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await useRaw(parseCSV(await f.text()), f.name); });
$('template').addEventListener('click', () => download('breadcast-template.csv', `${FIELDS.join(',')}\n2026-01-05,Wheat roll,250,231,0,4,0\n`, 'text/csv'));

function penalty() { return Number($('penalty').value) / 100; }
function econFor(p) { const e = state.econ[p]; return { ...e, wastePenalty: e.cost * penalty() }; }

function renderEcon() {
  $('econ-body').innerHTML = Object.entries(state.econ).filter(([p]) => state.rows.some((r) => r.product === p)).map(([p, e]) => `
    <tr data-p="${esc(p)}"><th scope="row">${esc(p)}</th>
      ${['price', 'cost', 'salvage'].map((k) => `<td><input type="number" min="0" step="0.05" value="${e[k]}" data-k="${k}" aria-label="${esc(p)} ${k}"></td>`).join('')}
      <td class="sl" data-sl>${pct(criticalRatio(econFor(p)))}</td></tr>`).join('');
}
$('econ-body').addEventListener('input', (e) => {
  const tr = e.target.closest('tr'); const p = tr.dataset.p; const k = e.target.dataset.k;
  state.econ[p][k] = Math.max(0, Number(e.target.value) || 0);
  tr.querySelector('[data-sl]').textContent = pct(criticalRatio(econFor(p)));
});
$('penalty').addEventListener('input', () => {
  $('penalty-out').textContent = `${$('penalty').value}%`;
  document.querySelectorAll('#econ-body tr').forEach((tr) => { tr.querySelector('[data-sl]').textContent = pct(criticalRatio(econFor(tr.dataset.p))); });
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true; $('run').textContent = 'Training…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    state.bt = backtest(state.rows, econFor);
    if (!state.bt.products.length) { $('data-status').textContent = 'Not enough history per product for a backtest (about 4 months needed).'; return; }
    renderResults();
    const last = state.rows.at(-1).t;
    $('plan-date').value = fmtDate(last + 86400000);
    const lastTemp = [...state.rows].reverse().find((r) => r.temp !== null)?.temp;
    if (lastTemp !== undefined) $('plan-temp').value = Math.round(lastTemp);
    renderPlan();
    $('results').hidden = false; $('plan-card').hidden = false;
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally { $('run').disabled = false; $('run').textContent = 'Train & backtest'; }
});

function renderResults() {
  const s = state.bt.summary;
  const soldDelta = s.soldRec - s.soldActual; const marginDelta = s.marginRec - s.marginActual;
  const kpi = (big, label, cls = '') => `<div class="kpi ${cls}"><b>${big}</b><span>${label}</span></div>`;
  $('kpis').innerHTML = [
    kpi(`−${pct(s.wasteReduction)}`, `unsold items (${n0(s.wasteActual)} → ${n0(s.wasteRec)} in ${s.testDays} days)`, s.wasteReduction > 0 ? 'good' : 'bad'),
    kpi(`${pct(s.wasteActual / s.bakedActual)} → ${pct(s.wasteRec / s.bakedRec)}`, 'waste rate (unsold ÷ baked)'),
    kpi(`${soldDelta >= 0 ? '+' : ''}${pct(soldDelta / s.soldActual)}`, `units sold (conservative: ${soldDelta >= 0 ? '+' : ''}${n0(soldDelta)})`, soldDelta < -0.02 * s.soldActual ? 'bad' : ''),
    kpi(`${marginDelta >= 0 ? '+' : '−'}${eur(Math.abs(marginDelta))}`, 'margin over the test period', marginDelta >= 0 ? 'good' : 'bad'),
  ].join('');
  $('results-body').innerHTML = state.bt.products.map((p) => {
    const dm = p.marginRec - p.marginActual;
    return `<tr><th scope="row">${esc(p.product)}</th><td class="num">${pct(p.q)}</td><td class="num">${n0(p.wasteActual)}</td><td class="num">${n0(p.wasteRec)} <span class="delta ${p.wasteRec <= p.wasteActual ? 'good' : 'bad'}">${p.wasteActual ? `${p.wasteRec <= p.wasteActual ? '−' : '+'}${Math.abs(Math.round((1 - p.wasteRec / p.wasteActual) * 100))}%` : ''}</span></td><td class="num">${pct(p.wasteRateActual)} → ${pct(p.wasteRateRec)}</td><td class="num">${n0(p.soldActual)} → ${n0(p.soldRec)}</td><td class="num"><span class="delta ${dm >= 0 ? 'good' : 'bad'}">${dm >= 0 ? '+' : '−'}${eur(Math.abs(dm))}</span></td></tr>`;
  }).join('');
  const sel = $('chart-product'); const prev = sel.value;
  sel.innerHTML = state.bt.products.map((p) => `<option>${esc(p.product)}</option>`).join('');
  if (state.bt.products.some((p) => p.product === prev)) sel.value = prev;
  renderChart();
}
$('chart-product').addEventListener('change', renderChart);

function renderChart() {
  const p = state.bt.products.find((x) => x.product === $('chart-product').value) || state.bt.products[0];
  const days = p.days; const W = 1080; const H = 300; const L = 48; const R = 14; const T = 14; const B = 34;
  const max = Math.max(...days.flatMap((d) => [d.baked, d.rec, d.sold])) * 1.08;
  const x = (i) => L + (i + 0.5) * ((W - L - R) / days.length);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const bw = Math.max(3, ((W - L - R) / days.length) * 0.62);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#f0e7dc"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${n0(v)}</text>`; }
  days.forEach((d, i) => {
    g += `<rect x="${x(i) - bw / 2}" y="${y(d.baked)}" width="${bw}" height="${y(0) - y(d.baked)}" rx="2" fill="var(--baked)"><title>${d.date}: baked ${d.baked}, sold ${d.sold}${d.censored ? ' (sold out)' : ''}, Breadcast ${d.rec}</title></rect>`;
    if (i % 7 === 0) g += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" class="ax">${d.date.slice(5)}</text>`;
  });
  const line = (k, color, w) => `<polyline fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" points="${days.map((d, i) => `${x(i)},${y(d[k])}`).join(' ')}"/>`;
  g += line('sold', 'var(--sold)', 2.2) + line('rec', 'var(--rec)', 2.6);
  days.forEach((d, i) => { if (d.censored) g += `<circle cx="${x(i)}" cy="${y(d.sold)}" r="4" fill="var(--out)"><title>${d.date}: sold out</title></circle>`; });
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily baked, sold and recommended quantities for ${esc(p.product)}"><style>.ax{font:11px Inter,system-ui,sans-serif;fill:#6f5f52}</style>${g}</svg>`;
  const imp = importance(p.model).slice(0, 8); const m = Math.max(...imp.map((i) => Math.abs(i.weight))) || 1;
  $('learned').innerHTML = `<p class="muted">Weights on standardised features of the ${pct(p.q)} quantile model (log scale). Positive means more demand.</p><ul class="bars">${imp.map((i) => `<li><span>${esc(i.name)}</span><span class="bar ${i.weight < 0 ? 'neg' : ''}" style="width:${(Math.abs(i.weight) / m) * 100}%"></span><span class="num">${i.weight >= 0 ? '+' : ''}${i.weight.toFixed(2)}</span></li>`).join('')}</ul>`;
}

function renderPlan() {
  state.plan = bakePlan(state.rows, econFor, { date: $('plan-date').value, rain: $('plan-rain').checked, holiday: $('plan-holiday').checked, preHoliday: $('plan-pre').checked, temp: Number($('plan-temp').value) });
  $('plan-body').innerHTML = state.plan.map((r) => `<tr><th scope="row">${esc(r.product)}<div class="drivers">${r.weekday}, ${r.date} · service level ${pct(r.q)}</div></th><td class="num">${n0(r.rec)}</td><td class="num">${n0(r.low)}–${n0(r.high)}</td><td>${r.lastSameWeekday ? `baked ${r.lastSameWeekday.baked}, sold ${r.lastSameWeekday.sold}${r.lastSameWeekday.sold >= r.lastSameWeekday.baked ? ' (sold out)' : ''}` : '–'}</td><td class="drivers">${r.top.map((t) => `${esc(t.name)} ${t.effect >= 0 ? '↑' : '↓'}`).join(', ')}</td></tr>`).join('');
}
$('plan-btn').addEventListener('click', renderPlan);
$('plan-csv').addEventListener('click', () => download(`bake-plan-${$('plan-date').value}.csv`, toCSV(state.plan.map((r) => ({ date: r.date, product: r.product, bake: r.rec, low: r.low, high: r.high, service_level: r.q.toFixed(2) })), ['date', 'product', 'bake', 'low', 'high', 'service_level']), 'text/csv'));
$('plan-print').addEventListener('click', () => window.print());

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
void parseDate;
