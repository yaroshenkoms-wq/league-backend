const test = require('node:test');
const assert = require('node:assert');
const { makeCode, normalizeCode, isValidCode, cleanName, rankMembers, CODE_LENGTH } = require('./groups');

test('код приглашения: 6 символов без похожих букв и цифр', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeCode();
    assert.strictEqual(code.length, CODE_LENGTH);
    assert.ok(isValidCode(code), code);
    assert.ok(!/[01OIL]/.test(code), code);
  }
});

test('код из сообщения: регистр, пробелы и дефис не мешают', () => {
  assert.strictEqual(normalizeCode(' ab3-k9p '), 'AB3K9P');
  assert.ok(isValidCode(normalizeCode('ab3 k9p')));
  assert.ok(!isValidCode('AB3K9'));
  assert.ok(!isValidCode('AB3K90'));
  assert.ok(!isValidCode(normalizeCode(undefined)));
});

test('название лиги чистится и обрезается до 30 символов', () => {
  assert.strictEqual(cleanName('  Los   del  bar '), 'Los del bar');
  assert.strictEqual(cleanName('x'.repeat(50)).length, 30);
  assert.strictEqual(cleanName('   '), null);
  assert.strictEqual(cleanName(null), null);
});

test('рейтинг лиги: только участники, места заново, равные очки — одно место', () => {
  const overall = [
    { userId: 'a', username: 'Ana', points: 30, rank: 1 },
    { userId: 'x', username: 'Stranger', points: 25, rank: 2 },
    { userId: 'b', username: 'Bea', points: 12, rank: 3 },
    { userId: 'c', username: 'Carlos', points: 12, rank: 4 },
  ];
  const rows = rankMembers(overall, ['c', 'a', 'b', 'new']);
  assert.deepStrictEqual(rows.map(r => [r.username, r.points, r.rank]), [
    ['Ana', 30, 1],
    ['Bea', 12, 2],
    ['Carlos', 12, 2],
    ['User', 0, 4],
  ]);
  assert.ok(!rows.some(r => r.userId === 'x'));
});

test('текст сообщения чата: 1..500 символов после обрезки пробелов', () => {
  const { cleanMessage } = require('./groups');
  assert.strictEqual(cleanMessage('  hola  '), 'hola');
  assert.strictEqual(cleanMessage('   '), null);
  assert.strictEqual(cleanMessage(5), null);
  assert.strictEqual(cleanMessage('x'.repeat(500)).length, 500);
  assert.strictEqual(cleanMessage('x'.repeat(501)), null);
});
