const test = require('node:test');
const assert = require('node:assert');
const { leaguesToPoll, parseScoreboard, mapEvents, createLiveScores } = require('./liveScores');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-28T15:00:00Z');

const event = (home, away, state, name, clock, hs, as, date = '2026-11-28T14:00Z') => ({
  date,
  status: { displayClock: clock, type: { name, state, shortDetail: clock } },
  competitions: [{ competitors: [
    { homeAway: 'home', score: String(hs), team: { displayName: home, shortDisplayName: home } },
    { homeAway: 'away', score: String(as), team: { displayName: away, shortDisplayName: away } },
  ] }],
});

test('опрашиваются только лиги с матчем в окне [-3 ч, +5 мин]', () => {
  const leagues = [
    { name: 'EPL', matches: [{ kickoffMs: NOW - 2 * HOUR }] },
    { name: 'La Liga', matches: [{ kickoffMs: NOW - 4 * HOUR }, { kickoffMs: NOW + 10 * 60000 }] },
    { name: 'Serie A', matches: [{ kickoffMs: NOW + 4 * 60000 }] },
    { name: 'Bundesliga', matches: [{ kickoffMs: null }] },
    { name: 'Unknown', matches: [{ kickoffMs: NOW }] },
  ];
  assert.deepStrictEqual(leaguesToPoll(leagues, NOW).map(l => l.name), ['EPL', 'Serie A']);
});

test('разбор scoreboard: идёт, перерыв, закончен; ещё не начатые пропускаются', () => {
  const parsed = parseScoreboard({ events: [
    event('Arsenal', 'Chelsea', 'in', 'STATUS_FIRST_HALF', "67'", 2, 1),
    event('Spurs', 'Everton', 'in', 'STATUS_HALFTIME', "45'", 0, 0),
    event('Leeds', 'Fulham', 'post', 'STATUS_FULL_TIME', "90'+5'", 1, 3),
    event('Villa', 'Wolves', 'pre', 'STATUS_SCHEDULED', "0'", 0, 0),
    { broken: true },
  ] });
  assert.deepStrictEqual(parsed.map(e => [e.homeScore, e.awayScore, e.minute, e.status]), [
    [2, 1, "67'", 'in'], [0, 0, 'HT', 'ht'], [1, 3, 'FT', 'ft'],
  ]);
  assert.deepStrictEqual(parseScoreboard(null), []);
});

test('сопоставление команд ESPN с нашими: обе команды, ближайший по времени матч', () => {
  const matches = [
    { matchId: 'Manchester United_Nottingham Forest', home: 'Manchester United', away: 'Nottingham Forest', kickoffMs: NOW - HOUR },
    { matchId: 'Celtic_Rangers_SPFL5', home: 'Celtic', away: 'Rangers', kickoffMs: NOW - 30 * 24 * HOUR },
    { matchId: 'Celtic_Rangers_SPFL20', home: 'Celtic', away: 'Rangers', kickoffMs: NOW - HOUR },
  ];
  const events = parseScoreboard({ events: [
    event('Manchester United', 'Nottingham Forest', 'in', 'STATUS_SECOND_HALF', "55'", 1, 0, new Date(NOW - HOUR).toISOString()),
    event('Celtic', 'Rangers', 'in', 'STATUS_FIRST_HALF', "20'", 0, 2, new Date(NOW - HOUR).toISOString()),
    event('Celtic', 'Hearts', 'in', 'STATUS_FIRST_HALF', "20'", 0, 2, new Date(NOW - HOUR).toISOString()),
  ] });
  const mapped = mapEvents(events, matches);
  assert.strictEqual(mapped.size, 2);
  assert.deepStrictEqual(mapped.get('Manchester United_Nottingham Forest').minute, "55'");
  assert.strictEqual(mapped.get('Celtic_Rangers_SPFL20').away, 2);
  assert.ok(!mapped.has('Celtic_Rangers_SPFL5'));
});

test('опрос: записи по матчам, истечение через 6 часов, ошибки не ломают и предупреждают раз в час', async () => {
  let now = NOW;
  let fail = false;
  let calls = 0;
  const logs = [];
  const live = createLiveScores({
    getLeagues: () => [{ name: 'EPL', matches: [{ matchId: 'A_B', home: 'A', away: 'B', kickoffMs: NOW - HOUR }] }],
    fetchJson: async () => {
      calls++;
      if (fail) throw new Error('HTTP 500');
      return { events: [event('A', 'B', 'in', 'STATUS_SECOND_HALF', "70'", 1, 1, new Date(NOW - HOUR).toISOString())] };
    },
    now: () => now,
    log: (level, message) => logs.push([level, message]),
  });

  assert.deepStrictEqual(await live.pollOnce(), ['EPL']);
  assert.deepStrictEqual(live.get('A_B'), { home: 1, away: 1, minute: "70'", status: 'in' });
  assert.strictEqual(live.get('nothing'), null);

  fail = true;
  now += 2 * 60000;
  await live.pollOnce();
  now += 2 * 60000;
  await live.pollOnce();
  assert.strictEqual(logs.length, 1, 'одно предупреждение в час');
  assert.strictEqual(logs[0][0], 'WARN');
  assert.ok(live.get('A_B'), 'старые данные остаются при ошибке');

  now = NOW - HOUR + 6 * HOUR + 1;
  assert.strictEqual(live.get('A_B'), null);
  await live.pollOnce(); // вне окна 3 ч — не опрашивается, запись удалена
  assert.strictEqual(live._live.size, 0);
});
