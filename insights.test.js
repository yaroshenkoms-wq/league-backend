const test = require('node:test');
const assert = require('node:assert');
const { computeInsights, percentages } = require('./insights');

test('проценты — целые, сумма 100', () => {
  assert.deepStrictEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepStrictEqual(percentages([0, 0, 0]), [0, 0, 0]);
  assert.deepStrictEqual(percentages([5, 0, 0]), [100, 0, 0]);
  for (let i = 0; i < 200; i++) {
    const c = [Math.floor(Math.random() * 50), Math.floor(Math.random() * 50), Math.floor(Math.random() * 50)];
    if (c.every(x => x === 0)) continue;
    assert.strictEqual(percentages(c).reduce((a, b) => a + b, 0), 100);
  }
});

test('статистика: исходы и топ-3 счёта', () => {
  const p = (h, a) => ({ homeScore: h, awayScore: a });
  const r = computeInsights([p(2, 1), p(2, 1), p(2, 1), p(1, 0), p(1, 1), p(0, 2), p(3, 3), p(0, 0)]);
  assert.strictEqual(r.total, 8);
  assert.deepStrictEqual(r.outcomes, { home: 50, draw: 38, away: 12 });
  assert.strictEqual(r.outcomes.home + r.outcomes.draw + r.outcomes.away, 100);
  assert.deepStrictEqual(r.topScores[0], { score: '2:1', count: 3 });
  assert.strictEqual(r.topScores.length, 3);
  assert.deepStrictEqual(computeInsights([]), { total: 0, outcomes: { home: 0, draw: 0, away: 0 }, topScores: [] });
});
