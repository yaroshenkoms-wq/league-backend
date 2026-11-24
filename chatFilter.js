// Фильтр чата лиги: заменяет сильную брань (английский, испанский, русский) звёздочками.
// Это не полная защита: обход написанием с цифрами и пробелами не ловится, поэтому в чате есть жалобы (report).

const L = '[\\p{L}\\p{M}]';
const START = '(?<![\\p{L}\\p{M}\\p{N}])';
const END = '(?![\\p{L}\\p{M}\\p{N}])';

// Каждый шаблон — слово или его начало/корень целиком. Для коротких корней границы слова обязательны,
// чтобы не маскировать обычные слова ("computador", "disputa", "class")
const PATTERNS = [
  // английский: корни длинные, ловим и склонения ("fucking", "motherfucker")
  `${L}*fuck${L}*`, `${L}*shit${L}*`, `bitch${L}*`, `cunt${L}*`, 'asshole[s]?', 'nigg(?:er|a)[s]?', 'fagg?ot[s]?', 'whore[s]?', 'slut[s]?',
  // испанский
  'put[ao]s?', 'putad[ao]s?', 'hijo\\s?de\\s?puta', 'hijoputa[s]?', 'mierda[s]?', 'co[ñn]o', 'joder', 'j[óo]dete', 'jodid[ao]s?',
  'cabr[óo]n(?:es)?', 'gilipollas', 'pendej[ao]s?', 'culer[ao]s?', 'maric[óo]n(?:es)?', 'zorra[s]?', 'polla[s]?', 'capull[ao]s?',
  // русский: корни, склонения через \p{L}*
  'х[уy]й\\p{L}*', 'х[уy][ея]\\p{L}*', 'пизд\\p{L}*', 'бл[яе]ть', 'бляд\\p{L}*', 'блять', '[её]ба[тлн]\\p{L}*', 'заеб\\p{L}*', 'уеб\\p{L}*',
  'сук[аиуе]', 'мудак\\p{L}*', 'мудил\\p{L}*', 'пидор\\p{L}*', 'пидар\\p{L}*', 'гандон\\p{L}*', 'залуп\\p{L}*', 'шлюх\\p{L}*',
];

const PROFANITY = new RegExp(`${START}(?:${PATTERNS.join('|')})${END}`, 'giu');

// Заменяет бранные слова звёздочками той же длины: "what the fuck" -> "what the ****"
function maskProfanity(text) {
  return String(text).replace(PROFANITY, word => '*'.repeat([...word].length));
}

module.exports = { maskProfanity };
