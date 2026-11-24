// Живой счёт из публичного scoreboard ESPN. Только для показа в приложении: очки по нему не начисляются
// (источник результатов для очков — CSV и syncSchedule.js).
const { makeTeamResolver } = require('./matchUtils');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// Название лиги -> код ESPN
const ESPN_CODES = {
  EPL: 'eng.1',
  'La Liga': 'esp.1',
  Bundesliga: 'ger.1',
  'Serie A': 'ita.1',
  'Ligue 1': 'fra.1',
  'Champions League': 'uefa.champions',
  'Europa League': 'uefa.europa',
  'Conference League': 'uefa.europa.conf',
  Championship: 'eng.2',
  Eredivisie: 'ned.1',
  'Primeira Liga': 'por.1',
  'Süper Lig': 'tur.1',
  'Scottish Premiership': 'sco.1',
  'Nations League': 'uefa.nations',
};

const POLL_INTERVAL_MS = 2 * 60 * 1000;
// Опрашиваем лигу, если в ней есть матч с началом в окне [сейчас - 3 ч, сейчас + 5 мин]
const WINDOW_BEFORE_MS = 3 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 5 * 60 * 1000;
// Запись о матче живёт до 6 часов после начала
const KEEP_AFTER_KICKOFF_MS = 6 * 60 * 60 * 1000;
const WARN_EVERY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
// Начало матча в ESPN и у нас может расходиться (перенос, время из заглушки): ищем пару в пределах двух суток
const MAX_KICKOFF_DIFF_MS = 2 * 24 * 60 * 60 * 1000;

// Лиги, в которых есть матч в окне опроса. leagues: [{ name, matches: [{ kickoffMs }] }]
function leaguesToPoll(leagues, nowMs) {
  return leagues.filter(league => ESPN_CODES[league.name] && league.matches.some(m =>
    m.kickoffMs !== null && m.kickoffMs >= nowMs - WINDOW_BEFORE_MS && m.kickoffMs <= nowMs + WINDOW_AFTER_MS));
}

// Ответ scoreboard -> [{ home, away (названия-кандидаты), homeScore, awayScore, minute, status, dateMs }].
// Матчи, которые ещё не начались, пропускаем. status: 'in' | 'ht' | 'ft'
function parseScoreboard(json) {
  const events = [];
  for (const event of (json && Array.isArray(json.events) ? json.events : [])) {
    const type = event.status && event.status.type;
    const competition = event.competitions && event.competitions[0];
    if (!type || !competition || !Array.isArray(competition.competitors)) continue;

    let status;
    if (type.name === 'STATUS_HALFTIME') status = 'ht';
    else if (type.state === 'in') status = 'in';
    else if (type.state === 'post') status = 'ft';
    else continue;

    const home = competition.competitors.find(c => c.homeAway === 'home');
    const away = competition.competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;

    const names = c => [c.team && c.team.displayName, c.team && c.team.shortDisplayName, c.team && c.team.name].filter(Boolean);
    const clock = String(event.status.displayClock || type.shortDetail || '').trim();
    events.push({
      home: names(home),
      away: names(away),
      homeScore,
      awayScore,
      minute: status === 'ht' ? 'HT' : status === 'ft' ? 'FT' : clock,
      status,
      dateMs: Date.parse(event.date) || null,
    });
  }
  return events;
}

// События ESPN -> записи по нашим матчам: Map matchId -> { home, away, minute, status, kickoffMs }.
// matches: [{ matchId, home, away, kickoffMs }]. Обе команды должны сопоставиться с нашими названиями
function mapEvents(events, matches) {
  const resolve = makeTeamResolver([...new Set(matches.flatMap(m => [m.home, m.away]))]);
  const resolveAny = names => {
    for (const name of names) {
      const team = resolve(name);
      if (team) return team;
    }
    return null;
  };

  const result = new Map();
  for (const event of events) {
    const home = resolveAny(event.home);
    const away = resolveAny(event.away);
    if (!home || !away) continue;

    const candidates = matches.filter(m => m.home === home && m.away === away && m.kickoffMs !== null);
    if (candidates.length === 0) continue;
    // Пара может встретиться несколько раз (Шотландия): берём матч с ближайшим началом
    candidates.sort((a, b) => Math.abs(a.kickoffMs - (event.dateMs ?? a.kickoffMs)) - Math.abs(b.kickoffMs - (event.dateMs ?? b.kickoffMs)));
    const match = candidates[0];
    if (event.dateMs !== null && Math.abs(match.kickoffMs - event.dateMs) > MAX_KICKOFF_DIFF_MS) continue;

    result.set(match.matchId, {
      home: event.homeScore, away: event.awayScore, minute: event.minute, status: event.status, kickoffMs: match.kickoffMs,
    });
  }
  return result;
}

// Хранилище живых счетов и опрос. getLeagues() -> [{ name, matches: [{ matchId, home, away, kickoffMs }] }]
function createLiveScores({ getLeagues, fetchJson, now = () => Date.now(), log = () => {} }) {
  const live = new Map();
  const warnedAt = new Map();

  const warn = (leagueName, message) => {
    if (now() - (warnedAt.get(leagueName) || 0) < WARN_EVERY_MS) return;
    warnedAt.set(leagueName, now());
    log('WARN', `⚠️ Живой счёт ${leagueName}: ${message}`);
  };

  function prune() {
    for (const [matchId, entry] of live) {
      if (now() > entry.kickoffMs + KEEP_AFTER_KICKOFF_MS) live.delete(matchId);
    }
  }

  async function pollOnce() {
    prune();
    const leagues = leaguesToPoll(getLeagues(), now());
    for (const league of leagues) {
      try {
        const json = await fetchJson(`${ESPN_BASE}/${ESPN_CODES[league.name]}/scoreboard`);
        const mapped = mapEvents(parseScoreboard(json), league.matches);
        for (const [matchId, entry] of mapped) live.set(matchId, entry);
      } catch (error) {
        // Ошибки ESPN ничего не ломают: старые данные остаются, живой счёт просто не обновляется
        warn(league.name, error.message);
      }
    }
    return leagues.map(l => l.name);
  }

  // { home, away, minute, status } или null
  function get(matchId) {
    const entry = live.get(matchId);
    if (!entry || now() > entry.kickoffMs + KEEP_AFTER_KICKOFF_MS) return null;
    return { home: entry.home, away: entry.away, minute: entry.minute, status: entry.status };
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => pollOnce().catch(() => {}), POLL_INTERVAL_MS);
    timer.unref();
  }

  return { pollOnce, get, start, _live: live };
}

async function fetchJsonWithTimeout(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

module.exports = { ESPN_CODES, POLL_INTERVAL_MS, leaguesToPoll, parseScoreboard, mapEvents, createLiveScores, fetchJsonWithTimeout };
