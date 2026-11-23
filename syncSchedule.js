// Обновляет календарь и результаты лиг по внешним источникам.
//
// Из командной строки:
//   node syncSchedule.js            — только отчёт, файлы не меняются
//   node syncSchedule.js --write    — перезаписать CSV (старые копии сохраняются в csv_backup/)
//   node syncSchedule.js --force    — не проверять, что число матчей в лиге не изменилось
//
// Сервер вызывает syncAll() по расписанию (см. server.js).
//
// Календарь и счета: fixturedownload.com. Счёт принимается, только если матч уже закончился и
// его не опровергает football-data.co.uk (второй источник). Результаты, вписанные в CSV вручную,
// сохраняются, пока источники их не подтвердят или не опровергнут. Test.csv не трогаем.

const fs = require('fs');
const path = require('path');
const { makeTeamResolver, makeMatchId, teamMatchScore } = require('./matchUtils');

const SEASON = 2026;

const LEAGUES = [
  { name: 'EPL', file: 'matches.csv', feed: 'epl', footballData: 'E0', tz: 'Europe/London' },
  { name: 'La Liga', file: 'LaLiga.csv', feed: 'la-liga', footballData: 'SP1', tz: 'Europe/Madrid' },
  { name: 'Bundesliga', file: 'Bundesliga.csv', feed: 'bundesliga', footballData: 'D1', tz: 'Europe/Berlin' },
  { name: 'Serie A', file: 'SerieA.csv', feed: 'serie-a', footballData: 'I1', tz: 'Europe/Rome' },
  { name: 'Ligue 1', file: 'Ligue1.csv', feed: 'ligue-1', footballData: 'F1', tz: 'Europe/Paris' },
  // Еврокубки: второго источника для сверки счёта нет, состав матчей растёт (плей-офф добавляется после жеребьёвки)
  { name: 'Champions League', file: 'ChampionsLeague.csv', feed: 'champions-league', tz: 'Europe/Paris', competition: true },
  { name: 'Europa League', file: 'EuropaLeague.csv', feed: 'europa-league', tz: 'Europe/Paris', competition: true },
  { name: 'Conference League', file: 'ConferenceLeague.csv', feed: 'conference-league', tz: 'Europe/Paris', competition: true },
];

const HEADER = 'home,away,date,league,round,isStarted,id,isCompleted,homeScore,awayScore,actualScore,actualHomeScore,actualAwayScore';

// Матч считается законченным через столько минут после начала (в еврокубках возможны дополнительное время и пенальти)
const FINISHED_AFTER_MIN = 105;
const COMPETITION_FINISHED_AFTER_MIN = 135;

// Счёт с большим числом голов считаем ошибкой источника и не записываем
const MAX_GOALS = 15;

// Названия из фидов еврокубков, которые нельзя сопоставить автоматически: "Paris" — это PSG, а не "Paris FC"
const COMPETITION_NAME_OVERRIDES = { Paris: 'PSG' };

// Если время матча ещё не назначено, лига ставит заглушку (00:00). В дату пишем TBD:
// приложение покажет «время не назначено», а сервер закроет прогнозы в 12:00 по местному времени (см. matchUtils.js).
const TBD_MARK = 'TBD';

const FETCH_TIMEOUT_MS = 20000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============ ВСПОМОГАТЕЛЬНОЕ ============

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function hasResult(row) {
  return row.isCompleted === 'true' && row.actualHomeScore !== '' && row.actualAwayScore !== '';
}

// Части даты/времени в часовом поясе tz
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: '2-digit', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function formatDate(p, time) {
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1]} ${p.year} ${time}`;
}

// Счета из football-data: { "home|away": "h:a" } в названиях команд из CSV
function footballDataScores(rows, toCsvTeam) {
  const scores = new Map();
  for (const r of rows) {
    if (r.FTHG === '' || r.FTAG === '' || r.FTHG === undefined) continue;
    const home = toCsvTeam(r.HomeTeam);
    const away = toCsvTeam(r.AwayTeam);
    if (home && away) scores.set(`${home}|${away}`, `${r.FTHG}:${r.FTAG}`);
  }
  return scores;
}

// Название из списка, совпадающее с name после нормализации и псевдонимов. Частичные совпадения не берём:
// "Inter Escaldes" (Андорра) не должен превратиться в "Inter" (Милан)
function makeExactResolver(teams) {
  return name => {
    const matches = teams.filter(team => teamMatchScore(team, name) === 2);
    return matches.length === 1 ? matches[0] : null;
  };
}

// Названия команд из национальных чемпионатов (для единых названий в еврокубках)
function domesticTeams(dir) {
  const teams = new Set();
  for (const league of LEAGUES.filter(l => !l.competition)) {
    const file = path.join(dir, league.file);
    if (!fs.existsSync(file)) continue;
    for (const row of parseCsv(fs.readFileSync(file, 'utf8'))) {
      teams.add(row.home);
      teams.add(row.away);
    }
  }
  return [...teams];
}

// ============ ОДНА ЛИГА ============

// Возвращает { league, filePath, content, changed, report }. Файлы не пишет.
async function syncLeague(league, now, { force = false, dir = __dirname } = {}) {
  const filePath = path.join(dir, league.file);
  const currentText = fs.readFileSync(filePath, 'utf8');
  const oldRows = parseCsv(currentText);
  // ID матча (в еврокубках включает тур): по нему находим прежние строки и результаты, вписанные вручную
  const idOf = row => makeMatchId({ ...row, league: league.name });
  const oldById = new Map(oldRows.map(r => [idOf(r), r]));
  const csvTeams = [...new Set(oldRows.flatMap(r => [r.home, r.away]))];
  const toCsvTeam = makeTeamResolver(csvTeams);

  const feed = JSON.parse(await fetchText(`https://fixturedownload.com/feed/json/${league.feed}-${SEASON}`));
  const fdRows = league.footballData
    ? parseCsv(await fetchText(`https://www.football-data.co.uk/mmz4281/${String(SEASON).slice(2)}${String(SEASON + 1).slice(2)}/${league.footballData}.csv`))
    : [];

  // Защита от битого ответа. Чемпионат: число матчей в сезоне не меняется.
  // Еврокубок: матчей может стать больше (плей-офф), но не меньше
  const badSize = league.competition ? feed.length < oldRows.length : feed.length !== oldRows.length;
  if (!Array.isArray(feed) || (!force && badSize)) {
    throw new Error(`фид вернул ${Array.isArray(feed) ? feed.length : 'не список'} матчей, а в файле ${oldRows.length}, файл не тронут`);
  }

  // Имена команд из фида должны однозначно сопоставиться с CSV, иначе рискуем сломать ID матчей
  const feedTeams = [...new Set(feed.flatMap(f => [f.HomeTeam, f.AwayTeam]))];
  const teamMap = {};
  const problems = [];

  // Клубы еврокубков называем так же, как в национальных чемпионатах, если они там есть ("Man City" -> "Manchester City"),
  // иначе одна команда выглядела бы в приложении по-разному. Остальные остаются как в фиде.
  const knownResolver = league.competition ? makeExactResolver(csvTeams) : null;
  const domesticResolver = league.competition ? makeExactResolver(domesticTeams(dir)) : null;

  for (const name of feedTeams) {
    const team = league.competition
      ? COMPETITION_NAME_OVERRIDES[name] || knownResolver(name) || domesticResolver(name) || name
      : toCsvTeam(name);
    if (team) teamMap[name] = team; else problems.push(name);
  }
  const mapped = Object.values(teamMap);
  const duplicates = mapped.filter((t, i) => mapped.indexOf(t) !== i);
  if (problems.length || duplicates.length) {
    throw new Error(`не удалось сопоставить команды: ${[...problems, ...duplicates].join(', ')} (добавьте псевдоним в matchUtils.js)`);
  }

  const crossCheck = footballDataScores(fdRows, toCsvTeam);

  const report = {
    total: feed.length, results: 0, resultsSingleSource: 0, preserved: 0,
    newResults: 0, conflicts: [], tbd: 0, awaiting: [],
  };
  const rows = [];

  const sorted = [...feed].sort((a, b) =>
    a.RoundNumber - b.RoundNumber || a.DateUtc.localeCompare(b.DateUtc) || a.MatchNumber - b.MatchNumber);

  for (const f of sorted) {
    const home = teamMap[f.HomeTeam];
    const away = teamMap[f.AwayTeam];
    const kickoff = new Date(f.DateUtc.replace(' ', 'T'));
    const local = localParts(kickoff, league.tz);
    const localTime = `${local.hour}:${local.minute}`;

    const isTbd = f.DateUtc.slice(11, 16) === '00:00' || localTime === '00:00';
    if (isTbd) report.tbd++;
    const date = formatDate(local, isTbd ? TBD_MARK : localTime);
    const finishedAfter = league.competition ? COMPETITION_FINISHED_AFTER_MIN : FINISHED_AFTER_MIN;
    const finished = kickoff.getTime() + finishedAfter * 60000 <= now.getTime();
    const round = `Round ${f.RoundNumber}`;

    let result = null;
    if (f.HomeTeamScore !== null && f.AwayTeamScore !== null) {
      const score = `${f.HomeTeamScore}:${f.AwayTeamScore}`;
      const other = crossCheck.get(`${home}|${away}`);
      if (Math.max(f.HomeTeamScore, f.AwayTeamScore) > MAX_GOALS) {
        report.conflicts.push(`${home} - ${away}: нереальный счёт ${score}`);
      } else if (other && other !== score) {
        report.conflicts.push(`${home} - ${away}: ${score} против ${other}`);
      } else if (finished) {
        result = { home: f.HomeTeamScore, away: f.AwayTeamScore };
        report.results++;
        if (!other) report.resultsSingleSource++;
      }
    } else if (finished) {
      // fixturedownload бывает выкладывает счёт с опозданием больше суток, а football-data уже его дал:
      // берём счёт оттуда, чтобы результаты не ждали
      const other = crossCheck.get(`${home}|${away}`);
      if (other) {
        const [h, a] = other.split(':').map(Number);
        if (Number.isInteger(h) && Number.isInteger(a) && Math.max(h, a) <= MAX_GOALS) {
          result = { home: h, away: a };
          report.results++;
          report.resultsSingleSource++;
          report.fromFootballData = (report.fromFootballData || 0) + 1;
        }
      }
    }

    // Результат, вписанный вручную, не теряем, пока источники не дали свой
    const previous = oldById.get(idOf({ home, away, round }));
    if (!result && previous && hasResult(previous)) {
      result = { home: Number(previous.actualHomeScore), away: Number(previous.actualAwayScore) };
      report.preserved++;
    }

    if (!result && finished && !isTbd) report.awaiting.push(`${home} - ${away} (${date})`);

    rows.push({ home, away, date, round, result });
  }

  const lines = rows.map((row, index) => {
    const fields = [row.home, row.away, row.date, league.name, row.round];
    if (row.result) {
      const { home, away } = row.result;
      fields.push('true', index + 1, 'true', home, away, `${home}:${away}`, home, away);
    }
    return fields.join(',');
  });
  const content = [HEADER, ...lines].join('\r\n');

  report.newResults = rows.filter(r => r.result).length - oldRows.filter(hasResult).length;

  // Как изменились ID матчей
  const oldIds = new Set(oldRows.map(idOf));
  const newIds = new Set(rows.map(idOf));
  report.idsKept = [...newIds].filter(id => oldIds.has(id)).length;
  report.idsRemoved = [...oldIds].filter(id => !newIds.has(id)).length;

  return { league, filePath, content, changed: content !== currentText.replace(/^﻿/, ''), report };
}

// Все лиги; ошибка одной лиги не мешает остальным: { league, error } вместо результата
async function syncAll(now = new Date(), options = {}) {
  const results = [];
  for (const league of LEAGUES) {
    try {
      results.push(await syncLeague(league, now, options));
    } catch (error) {
      results.push({ league, error: error.message });
    }
  }
  return results;
}

// ============ ЗАПУСК ИЗ КОМАНДНОЙ СТРОКИ ============

async function main() {
  const write = process.argv.includes('--write');
  const force = process.argv.includes('--force');
  const now = new Date();
  const results = await syncAll(now, { force });

  for (const { league, report, error, changed } of results) {
    if (error) {
      console.log(`\n${league.name}: ОШИБКА — ${error}`);
      continue;
    }
    console.log(`\n${league.name}: матчей ${report.total}, с результатом ${report.results + report.preserved} (новых: ${report.newResults}, вручную: ${report.preserved}, из одного источника: ${report.resultsSingleSource}), время не назначено: ${report.tbd}${report.fromFootballData ? `, счёт только из football-data: ${report.fromFootballData}` : ''}${changed ? '' : ' — без изменений'}`);
    if (report.idsRemoved) console.log(`  ID матчей: сохранилось ${report.idsKept}, исчезло ${report.idsRemoved}`);
    if (report.conflicts.length) console.log('  КОНФЛИКТ источников (результат не записан):', report.conflicts);
    if (report.awaiting.length) console.log(`  Матч закончился, но счёта в источниках ещё нет (${report.awaiting.length}):`, report.awaiting);
  }

  const failed = results.some(r => r.error);
  if (!write) {
    console.log('\nФайлы не изменены. Запустите с --write, чтобы записать.');
    process.exit(failed ? 1 : 0);
  }

  const toWrite = results.filter(r => !r.error && r.changed);
  if (toWrite.length > 0) {
    const backupDir = path.join(__dirname, 'csv_backup', now.toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    for (const { league, filePath, content } of toWrite) {
      fs.copyFileSync(filePath, path.join(backupDir, league.file));
      fs.writeFileSync(filePath, '﻿' + content);
    }
    console.log(`\nОбновлено файлов: ${toWrite.length}. Старые версии: ${backupDir}`);
  } else {
    console.log('\nВсе файлы уже актуальны.');
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { syncAll, syncLeague, LEAGUES };
