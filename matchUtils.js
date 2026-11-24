// Сопоставление названий команд между источниками и определение времени начала матча.

// ============ НАЗВАНИЯ КОМАНД ============

// Служебные части названий, которые в CSV и в API пишутся по-разному ("FC Köln" / "Köln")
const STOP_TOKENS = new Set([
  'fc', 'cf', 'ac', 'as', 'rc', 'rcd', 'ca', 'sc', 'sv', 'fsv', 'vfb', 'vfl', 'tsg',
  'ud', 'cd', 'sd', 'us', 'ss', 'ssc', 'afc', 'bc', 'ogc', 'calcio',
  'de', 'del', 'la', 'the',
]);

// Названия из CSV, которые нельзя получить простой нормализацией: normalize(CSV) -> варианты из источников.
// Если синхронизация не смогла сопоставить команду, она сообщит об этом — добавьте псевдоним сюда.
const TEAM_ALIASES = {
  // Названия из API-Football, fixturedownload.com и football-data.co.uk
  'manchester united': ['Man Utd', 'Man United'],
  'manchester city': ['Man City'],
  'nottingham forest': ["Nott'm Forest"],
  'tottenham hotspur': ['Spurs'],
  'rcd espanyol de barcelona': ['Espanol'],
  'rc deportivo': ['La Coruna'],
  'atletico de madrid': ['Ath Madrid', 'Atleti'],
  'athletic club': ['Ath Bilbao'],
  'r racing club': ['Racing Santander', 'Santander'],
  bayern: ['Bayern Munich', 'Bayern Munchen'],
  dortmund: ['B. Dortmund'],
  'rb leipzig': ['Leipzig'],
  'brighton and hove albion': ['Brighton'],
  eintracht: ['Ein Frankfurt'],
  gladbach: ['Borussia Monchengladbach', "M'gladbach"],
  'hamburger sv': ['Hamburg'],
  inter: ['Internazionale'],
  psg: ['Paris Saint Germain', 'Paris SG'],
  lyon: ['Olympique Lyonnais'],
  rennes: ['Stade Rennais'],
  brest: ['Stade Brestois 29'],
  'le havre': ['Havre Athletic Club'],
  // Дополнительные лиги (football-data.co.uk)
  'wolverhampton wanderers': ['Wolves'],
  'west bromwich albion': ['West Brom'],
  'queens park rangers': ['QPR'],
  'fortuna sittard': ['For Sittard'],
  'vitoria sc': ['Guimaraes'],
  'sporting cp': ['Sp Lisbon'],
  'istanbul basaksehir': ['Buyuksehyr'],
  goztepe: ['Goztep'],
  'heart of midlothian': ['Hearts'],
};

function normalizeTeam(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(normalized) {
  return normalized
    .split(' ')
    .filter(t => t && !STOP_TOKENS.has(t) && !/^\d+$/.test(t));
}

function isSubset(a, b) {
  return a.length > 0 && a.every(t => b.includes(t));
}

function nameVariants(name) {
  const normalized = normalizeTeam(name);
  return [normalized, ...(TEAM_ALIASES[normalized] || []).map(normalizeTeam)];
}

// 2 — названия совпали после нормализации, 1 — одно название целиком входит в другое, 0 — разные команды
function teamMatchScore(csvName, apiName) {
  let best = 0;
  for (const a of nameVariants(csvName)) {
    for (const b of nameVariants(apiName)) {
      const ta = tokens(a);
      const tb = tokens(b);
      if (ta.length && ta.join(' ') === tb.join(' ')) return 2;
      if (isSubset(ta, tb) || isSubset(tb, ta)) best = 1;
    }
  }
  return best;
}

// ============ ИДЕНТИФИКАТОР МАТЧА ============

// Еврокубки: у каждого турнира свой код. Клубы одной страны могут встретиться в плей-офф, и пара
// "хозяева — гости" совпала бы с матчем национального чемпионата, поэтому в ID добавляются турнир и тур.
const COMPETITION_CODES = {
  'Champions League': 'UCL',
  'Europa League': 'UEL',
  'Conference League': 'UECL',
  'Nations League': 'NL',
  // В шотландской премьер-лиге за 33 тура пара встречается трижды, так что "хозяева — гости" повторяется: нужен тур
  'Scottish Premiership': 'SPFL',
};

// Национальный чемпионат: пара "хозяева — гости" встречается один раз за сезон, поэтому дата в ID не нужна.
// Без неё ID не меняется, когда матч переносят или лига назначает время.
// Еврокубок: "хозяева_гости_код+тур", например Arsenal_PSG_UCL3.
function makeMatchId(match) {
  const code = COMPETITION_CODES[match.league];
  if (!code) return `${match.home}_${match.away}`;

  const round = /\d+/.exec(String(match.round || ''));
  return `${match.home}_${match.away}_${code}${round ? round[0] : ''}`;
}

// Возвращает функцию name -> название из списка teams (или null, если совпадения нет или оно неоднозначно).
// Точное совпадение важнее частичного: "Paris FC" не путается с "Paris Saint Germain".
function makeTeamResolver(teams) {
  return name => {
    const scored = teams
      .map(team => [team, teamMatchScore(team, name)])
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);
    if (scored.length === 0) return null;
    if (scored.length > 1 && scored[0][1] === scored[1][1]) return null;
    return scored[0][0];
  };
}

// ============ ВРЕМЯ НАЧАЛА МАТЧА ============

// Даты в CSV записаны по местному времени лиги
const LEAGUE_TIMEZONES = {
  EPL: 'Europe/London',
  'La Liga': 'Europe/Madrid',
  Bundesliga: 'Europe/Berlin',
  'Serie A': 'Europe/Rome',
  'Ligue 1': 'Europe/Paris',
  Championship: 'Europe/London',
  Eredivisie: 'Europe/Amsterdam',
  'Primeira Liga': 'Europe/Lisbon',
  'Süper Lig': 'Europe/Istanbul',
  'Scottish Premiership': 'Europe/London',
  'Nations League': 'Europe/Paris',
  // Время матчей еврокубков в CSV записано по центральноевропейскому времени, как в расписании УЕФА
  'Champions League': 'Europe/Paris',
  'Europa League': 'Europe/Paris',
  'Conference League': 'Europe/Paris',
};

// Если лига ещё не назначила время матча, в дате пишется TBD. Для закрытия прогнозов берём это местное время:
// лучше закрыть раньше, чем позже. Когда время назначат, синхронизация подставит настоящее.
const TBD_LOCAL_HOUR = 12;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

// Время матча ещё не назначено ("Fri 09 Oct 2026 TBD")
function isTimeTbd(dateStr) {
  return /\bTBD\b/.test(dateStr || '');
}

// "Fri 28 Aug 2026 20:30" в часовом поясе лиги -> Date (UTC). null, если дату или лигу не удалось разобрать.
// Для "TBD" возвращает момент закрытия прогнозов (TBD_LOCAL_HOUR по местному времени).
function kickoffTime(dateStr, leagueName) {
  const timeZone = LEAGUE_TIMEZONES[leagueName];
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(?:(\d{1,2}):(\d{2})|TBD)/.exec(dateStr || '');
  if (!timeZone || !m) return null;

  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;

  const hour = m[4] === undefined ? TBD_LOCAL_HOUR : +m[4];
  const minute = m[5] === undefined ? 0 : +m[5];
  const wallClock = Date.UTC(+m[3], month, +m[1], hour, minute);
  // Смещение считаем дважды: первый проход может попасть по другую сторону перевода часов
  let utc = wallClock - tzOffsetMs(wallClock, timeZone);
  utc = wallClock - tzOffsetMs(utc, timeZone);
  return new Date(utc);
}

// Матч начался, если так помечено в CSV или наступило время начала
function hasStarted(match, now = new Date()) {
  if (match.isStarted || match.isCompleted) return true;
  const kickoff = kickoffTime(match.date, match.league);
  return kickoff !== null && now >= kickoff;
}

module.exports = {
  normalizeTeam,
  teamMatchScore,
  makeMatchId,
  COMPETITION_CODES,
  makeTeamResolver,
  kickoffTime,
  isTimeTbd,
  hasStarted,
};
