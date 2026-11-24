const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_SCORING, calculatePoints, scorePrediction, validateScoring, isDefaultScoring, groupScoring, pointsByUser, roundNumber } = require('./scoring');

test('очки по умолчанию: 3 / 2 / 1 / 0', () => {
  assert.strictEqual(calculatePoints(2, 1, 2, 1), 3);
  assert.strictEqual(calculatePoints(3, 2, 2, 1), 2); // победитель и разница
  assert.strictEqual(calculatePoints(1, 0, 3, 0), 1); // победитель, другая разница
  assert.strictEqual(calculatePoints(0, 0, 2, 2), 1); // ничья не точным счётом — только исход
  assert.strictEqual(calculatePoints(2, 1, 0, 1), 0);
});

test('очки по правилам лиги', () => {
  const rules = { exact: 5, diff: 3, outcome: 0 };
  assert.strictEqual(calculatePoints(2, 1, 2, 1, rules), 5);
  assert.strictEqual(calculatePoints(3, 2, 2, 1, rules), 3);
  assert.strictEqual(calculatePoints(1, 0, 3, 0, rules), 0);
  assert.strictEqual(calculatePoints(1, 1, 2, 2, rules), 0);
});

test('джокер удваивает очки, ноль остаётся нулём', () => {
  assert.strictEqual(scorePrediction(2, 1, 2, 1, true), 6);
  assert.strictEqual(scorePrediction(2, 1, 2, 1, false), 3);
  assert.strictEqual(scorePrediction(2, 1, 2, 1, undefined), 3);
  assert.strictEqual(scorePrediction(0, 1, 2, 1, true), 0);
  assert.strictEqual(scorePrediction(0, 0, 1, 1, true, { exact: 4, diff: 2, outcome: 2 }), 4);
});

test('проверка правил лиги', () => {
  assert.deepStrictEqual(validateScoring({ exact: 3, diff: 2, outcome: 1 }), DEFAULT_SCORING);
  assert.deepStrictEqual(validateScoring({ exact: 10, diff: 10, outcome: 0 }), { exact: 10, diff: 10, outcome: 0 });
  for (const bad of [null, [], 'x', {}, { exact: 3, diff: 4, outcome: 1 }, { exact: 3, diff: 2, outcome: 3 },
    { exact: 0, diff: 0, outcome: 0 }, { exact: 11, diff: 2, outcome: 1 }, { exact: 3, diff: 2, outcome: -1 },
    { exact: 3.5, diff: 2, outcome: 1 }, { exact: '3', diff: 2, outcome: 1 }]) {
    assert.strictEqual(validateScoring(bad), null, JSON.stringify(bad));
  }
  assert.ok(isDefaultScoring({ exact: 3, diff: 2, outcome: 1 }));
  assert.ok(isDefaultScoring(undefined));
  assert.ok(!isDefaultScoring({ exact: 4, diff: 2, outcome: 1 }));
  assert.deepStrictEqual(groupScoring({}), DEFAULT_SCORING);
  assert.deepStrictEqual(groupScoring({ scoring: { exact: 5, diff: 2, outcome: 1 } }), { exact: 5, diff: 2, outcome: 1 });
});

test('очки участников лиги пересчитываются по правилам лиги, необработанные не считаются', () => {
  const preds = [
    { userId: 'a', homeScore: 2, awayScore: 1, actualHomeScore: 2, actualAwayScore: 1, processed: true },
    { userId: 'a', homeScore: 1, awayScore: 0, actualHomeScore: 3, actualAwayScore: 0, processed: true, joker: true },
    { userId: 'b', homeScore: 0, awayScore: 0, actualHomeScore: 1, actualAwayScore: 1, processed: true },
    { userId: 'b', homeScore: 2, awayScore: 0, processed: false },
  ];
  assert.deepStrictEqual(pointsByUser(preds, { exact: 5, diff: 2, outcome: 1 }), { a: 5 + 2, b: 1 });
});

test('номер тура из "Round N"', () => {
  assert.strictEqual(roundNumber('Round 12'), 12);
  assert.strictEqual(roundNumber(''), null);
  assert.strictEqual(roundNumber(undefined), null);
});
