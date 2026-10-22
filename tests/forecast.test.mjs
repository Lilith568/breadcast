import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../forecast.mjs';

const sample = () => F.normalise(F.syntheticHistory({ days: 300, seed: 3 })).rows;
const econ = () => ({ price: 1, cost: 0.3, salvage: 0 });

test('newsvendor critical ratio follows price, cost, salvage and waste penalty', () => {
  assert.equal(F.criticalRatio({ price: 1, cost: 0.3, salvage: 0 }).toFixed(2), '0.70');
  assert.equal(F.criticalRatio({ price: 1, cost: 0.3, salvage: 0.3 }), 0.98); // free waste → bake generously (capped)
  assert.ok(F.criticalRatio({ price: 1, cost: 0.3, salvage: 0, wastePenalty: 0.6 }) < 0.5);
});

test('normalise caps sold at baked and rejects malformed rows', () => {
  const { rows, problems } = F.normalise([
    { __line: 2, date: '2026-01-05', product: 'Roll', baked: '10', sold: '12' },
    { __line: 3, date: '05.01.2026', product: 'Roll', baked: '10', sold: '5' },
  ]);
  assert.equal(rows.length, 1); assert.equal(rows[0].sold, 10); assert.equal(problems.length, 1);
});

test('quantile regression recovers the requested quantile on noisy data', () => {
  const rnd = F.mulberry32(1);
  const items = Array.from({ length: 2000 }, () => { const a = rnd(); return { x: [1, a], y: 2 + a + (rnd() - 0.5), censored: false }; });
  for (const q of [0.2, 0.5, 0.8]) {
    const m = F.fitQuantile(items, q, { epochs: 900 });
    const below = items.filter((it) => it.y <= m.predictLog(it.x)).length / items.length;
    assert.ok(Math.abs(below - q) < 0.05, `q=${q} coverage ${below}`);
  }
});

test('censored days do not drag the forecast down', () => {
  const rnd = F.mulberry32(2);
  // true demand ~ 100; on half the days the shelf ran out at 70 (sold = 70, censored)
  const items = Array.from({ length: 1200 }, (_, i) => {
    const demand = Math.log1p(100 * Math.exp((rnd() - 0.5) * 0.2));
    const censored = i % 2 === 0;
    return { x: [1], y: censored ? Math.log1p(70) : demand, censored };
  });
  const naive = F.fitQuantile(items.map((it) => ({ ...it, censored: false })), 0.5);
  const aware = F.fitQuantile(items, 0.5);
  assert.ok(Math.expm1(aware.predictLog([1])) > 90, 'censoring-aware median near true demand');
  assert.ok(Math.expm1(naive.predictLog([1])) < Math.expm1(aware.predictLog([1])));
});

test('backtest on the synthetic bakery cuts waste without big sales losses', () => {
  const bt = F.backtest(sample(), econ);
  assert.equal(bt.products.length, 5);
  assert.ok(bt.summary.wasteReduction > 0.2, `waste reduction ${bt.summary.wasteReduction}`);
  assert.ok(bt.summary.soldRec > bt.summary.soldActual * 0.97);
});

test('a higher waste penalty bakes less and wastes less', () => {
  const rows = sample();
  const a = F.backtest(rows, econ).summary;
  const b = F.backtest(rows, () => ({ ...econ(), wastePenalty: 0.6 })).summary;
  assert.ok(b.bakedRec < a.bakedRec && b.wasteRec < a.wasteRec);
});

test('bake plan returns one sensible quantity per product with a range', () => {
  const plan = F.bakePlan(sample(), econ);
  assert.equal(plan.length, 5);
  for (const p of plan) { assert.ok(p.rec > 0); assert.ok(p.low <= p.high); assert.equal(p.top.length, 3); }
});

test('CSV round trip keeps fields', () => {
  const rows = F.syntheticHistory({ days: 3 });
  const back = F.parseCSV(F.toCSV(rows, F.FIELDS));
  assert.equal(back.length, rows.length);
  assert.equal(back[0].product, rows[0].product);
});
