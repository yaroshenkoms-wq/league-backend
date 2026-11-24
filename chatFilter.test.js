const test = require('node:test');
const assert = require('node:assert');
const { maskProfanity } = require('./chatFilter');

test('английская брань маскируется, длина сохраняется', () => {
  assert.strictEqual(maskProfanity('what the fuck, this is shit'), 'what the ****, this is ****');
  assert.strictEqual(maskProfanity('Motherfucker!'), '************!');
  assert.strictEqual(maskProfanity('you BITCH'), 'you *****');
});

test('испанская брань маскируется', () => {
  assert.strictEqual(maskProfanity('qué mierda de árbitro'), 'qué ****** de árbitro');
  assert.strictEqual(maskProfanity('hijo de puta'), '************');
  assert.strictEqual(maskProfanity('Cabrón, joder'), '******, *****');
});

test('русская брань маскируется, включая склонения', () => {
  assert.strictEqual(maskProfanity('судья мудак'), 'судья *****');
  assert.strictEqual(maskProfanity('вот это пиздец'), 'вот это ******');
  assert.strictEqual(maskProfanity('ну блять'), 'ну *****');
});

test('обычные слова не трогаем', () => {
  for (const ok of ['computador', 'disputa del partido', 'class', 'Scunthorpe', 'assist', 'сумка', 'hello world', 'Gol de Pedri!', 'пиво', 'хулиганы']) {
    assert.strictEqual(maskProfanity(ok), ok, ok);
  }
});
