const test = require('node:test');
const assert = require('node:assert');
const { teamMatchScore, makeTeamResolver, kickoffTime, isTimeTbd, hasStarted, makeMatchId } = require('./matchUtils');

test('названия из CSV сопоставляются с названиями API-Football', () => {
  const pairs = [
    ['Bayern', 'Bayern Munich'],
    ['Gladbach', 'Borussia Monchengladbach'],
    ['Köln', '1. FC Koln'],
    ['Eintracht', 'Eintracht Frankfurt'],
    ['Mainz', 'FSV Mainz 05'],
    ['Schalke 04', 'FC Schalke 04'],
    ['Hoffenheim', '1899 Hoffenheim'],
    ['Atlético de Madrid', 'Atletico Madrid'],
    ['Deportivo Alavés', 'Alaves'],
    ['RC Celta', 'Celta Vigo'],
    ['RC Deportivo', 'Deportivo La Coruna'],
    ['R. Racing Club', 'Racing Santander'],
    ['Málaga CF', 'Malaga'],
    ['Brighton & Hove Albion', 'Brighton'],
    ['AFC Bournemouth', 'Bournemouth'],
    ['Tottenham Hotspur', 'Tottenham'],
    ['PSG', 'Paris Saint Germain'],
    ['Lyon', 'Olympique Lyonnais'],
    ['Rennes', 'Stade Rennais'],
    ['Brest', 'Stade Brestois 29'],
    ['OGC Nice', 'Nice'],
    ['Inter', 'Inter'],
    ['AC Milan', 'AC Milan'],
    ['Sassuolo', 'US Sassuolo Calcio'],
    ['Manchester United', 'Man Utd'],
    ['Manchester City', 'Man City'],
    ['Nottingham Forest', "Nott'm Forest"],
    ['Tottenham Hotspur', 'Spurs'],
    ['Inter', 'Internazionale'],
    ['Le Havre', 'Havre Athletic Club'],
    ['RCD Espanyol de Barcelona', 'Espanol'],
    ['RC Deportivo', 'La Coruna'],
    ['Atlético de Madrid', 'Ath Madrid'],
    ['Athletic Club', 'Ath Bilbao'],
    ['Bayern', 'FC Bayern München'],
    ['Bayern', 'Bayern Munich'],
    ['Eintracht', 'Ein Frankfurt'],
    ['Gladbach', "M'gladbach"],
    ['Gladbach', 'Borussia Mönchengladbach'],
    ['Hamburger SV', 'Hamburg'],
    ['PSG', 'Paris SG'],
    ['R. Racing Club', 'Santander'],
  ];
  for (const [csv, api] of pairs) {
    assert.ok(teamMatchScore(csv, api) > 0, `${csv} <-> ${api}`);
  }
});

test('разные команды не сопоставляются', () => {
  const pairs = [
    ['Manchester City', 'Manchester United'],
    ['Hull City', 'Manchester City'],
    ['Real Madrid', 'Real Betis'],
    ['Deportivo Alavés', 'Deportivo La Coruna'],
    ['Paris FC', 'Marseille'],
    ['Inter', 'AC Milan'],
  ];
  for (const [a, b] of pairs) {
    assert.strictEqual(teamMatchScore(a, b), 0, `${a} <-> ${b}`);
  }
});

test('Paris FC и PSG не путаются', () => {
  const resolve = makeTeamResolver(['Paris FC', 'PSG', 'Lyon']);
  assert.strictEqual(resolve('Paris Saint Germain'), 'PSG');
  assert.strictEqual(resolve('Paris FC'), 'Paris FC');
  assert.strictEqual(resolve('Olympique Lyonnais'), 'Lyon');
});

test('неизвестная команда не сопоставляется с чужой', () => {
  const resolve = makeTeamResolver(['Arsenal', 'Coventry City']);
  assert.strictEqual(resolve('Wolves'), null);
  assert.strictEqual(resolve('Coventry'), 'Coventry City');
});

test('ID матча не зависит от даты', () => {
  const a = { home: 'Arsenal', away: 'Coventry City', date: 'Fri 21 Aug 2026 20:00' };
  const b = { ...a, date: 'Sat 22 Aug 2026 12:30' };
  assert.strictEqual(makeMatchId(a), 'Arsenal_Coventry City');
  assert.strictEqual(makeMatchId(a), makeMatchId(b));
});

test('время начала учитывает часовой пояс и переход на зимнее время', () => {
  // Лето: Лондон UTC+1, Берлин UTC+2
  assert.strictEqual(kickoffTime('Fri 21 Aug 2026 20:00', 'EPL').toISOString(), '2026-08-21T19:00:00.000Z');
  assert.strictEqual(kickoffTime('Fri 28 Aug 2026 20:30', 'Bundesliga').toISOString(), '2026-08-28T18:30:00.000Z');
  // Зима: Лондон UTC+0, Париж UTC+1
  assert.strictEqual(kickoffTime('Sat 12 Dec 2026 15:00', 'EPL').toISOString(), '2026-12-12T15:00:00.000Z');
  assert.strictEqual(kickoffTime('Sat 12 Dec 2026 20:45', 'Ligue 1').toISOString(), '2026-12-12T19:45:00.000Z');
  // Неизвестная лига или мусор вместо даты
  assert.strictEqual(kickoffTime('Thu 23 Jul 2026 20:45', 'Test'), null);
  assert.strictEqual(kickoffTime('скоро', 'EPL'), null);
});

test('hasStarted: по времени и по флагам из CSV', () => {
  const match = { date: 'Fri 21 Aug 2026 20:00', league: 'EPL', isStarted: false, isCompleted: false };
  assert.strictEqual(hasStarted(match, new Date('2026-08-21T18:59:00Z')), false);
  assert.strictEqual(hasStarted(match, new Date('2026-08-21T19:00:00Z')), true);
  assert.strictEqual(hasStarted({ ...match, isStarted: true }, new Date('2026-08-01T00:00:00Z')), true);
  // Тестовая лига без часового пояса — полагаемся только на флаги
  assert.strictEqual(hasStarted({ date: 'Thu 23 Jul 2026 20:45', league: 'Test' }, new Date('2030-01-01')), false);
});

test('время TBD: прогнозы закрываются в 12:00 по местному времени лиги', () => {
  assert.strictEqual(isTimeTbd('Fri 09 Oct 2026 TBD'), true);
  assert.strictEqual(isTimeTbd('Fri 09 Oct 2026 20:30'), false);
  // 9 октября в Берлине ещё летнее время (UTC+2): 12:00 -> 10:00 UTC
  assert.strictEqual(kickoffTime('Fri 09 Oct 2026 TBD', 'Bundesliga').toISOString(), '2026-10-09T10:00:00.000Z');
  // после перехода на зимнее время (UTC+1): 12:00 -> 11:00 UTC
  assert.strictEqual(kickoffTime('Sat 07 Nov 2026 TBD', 'Bundesliga').toISOString(), '2026-11-07T11:00:00.000Z');
  const match = { date: 'Fri 09 Oct 2026 TBD', league: 'Bundesliga' };
  assert.strictEqual(hasStarted(match, new Date('2026-10-09T09:59:00Z')), false);
  assert.strictEqual(hasStarted(match, new Date('2026-10-09T10:00:00Z')), true);
});

test('еврокубки: разные клубы с похожими названиями не путаются', () => {
  // Частичное совпадение (score 1) не считается «тем же клубом» при переименовании команд еврокубков
  assert.strictEqual(teamMatchScore('Inter', 'Inter Escaldes'), 1);
  assert.strictEqual(teamMatchScore('Inter', 'Inter'), 2);
  assert.strictEqual(teamMatchScore('Paris FC', 'Paris'), 2); // поэтому «Paris» из фида УЕФА задан явно (PSG)
  // Названия из фида УЕФА совпадают с национальными точно
  for (const [domestic, uefa] of [['Dortmund', 'B. Dortmund'], ['RB Leipzig', 'Leipzig'], ['Bayern', 'Bayern München'],
    ['Manchester City', 'Man City'], ['Atlético de Madrid', 'Atleti'], ['Brighton & Hove Albion', 'Brighton'],
    ['FC Barcelona', 'Barcelona'], ['AS Roma', 'Roma'], ['AC Milan', 'Milan'], ['Getafe CF', 'Getafe']]) {
    assert.strictEqual(teamMatchScore(domestic, uefa), 2, `${domestic} <-> ${uefa}`);
  }
});

test('ID матча еврокубка включает турнир и тур, чемпионата — нет', () => {
  assert.strictEqual(makeMatchId({ home: 'Arsenal', away: 'PSG', league: 'Champions League', round: 'Round 3' }), 'Arsenal_PSG_UCL3');
  assert.strictEqual(makeMatchId({ home: 'Arsenal', away: 'PSG', league: 'Europa League', round: 'Round 3' }), 'Arsenal_PSG_UEL3');
  assert.strictEqual(makeMatchId({ home: 'Arsenal', away: 'PSG', league: 'Conference League', round: 'Round 10' }), 'Arsenal_PSG_UECL10');
  assert.strictEqual(makeMatchId({ home: 'Arsenal', away: 'Chelsea', league: 'EPL', round: 'Round 3' }), 'Arsenal_Chelsea');
  // одна и та же пара в разных турах — разные матчи
  assert.notStrictEqual(
    makeMatchId({ home: 'A', away: 'B', league: 'Champions League', round: 'Round 2' }),
    makeMatchId({ home: 'A', away: 'B', league: 'Champions League', round: 'Round 9' }));
});
