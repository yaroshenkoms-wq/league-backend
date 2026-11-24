require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const cron = require('node-cron');
const admin = require('firebase-admin');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { makeMatchId, hasStarted, kickoffTime, isTimeTbd } = require('./matchUtils');
const { syncAll } = require('./syncSchedule');
const { registerGroupRoutes, leaveAllGroups } = require('./groups');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

// За прокси хостинга (Render) IP клиента приходит в X-Forwarded-For. Без этого все пользователи
// выглядят как один IP и делят общий лимит запросов. TRUST_PROXY — число прокси перед сервером (0 — без прокси).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

app.use(cors());
app.use(express.json());

// ============ НАСТРОЙКА RATE LIMITING ============

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'Слишком много запросов. Попробуйте позже.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.ip === '127.0.0.1'
});

const strictLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'Слишком много запросов. Подождите 5 минут.'
  }
});

// Лимит на пользователя, а не на IP: за одним роутером могут сидеть многие. Ставится после requireAuth
const predictionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user.uid,
  message: {
    success: false,
    code: 'rate_limited',
    error: 'Превышен лимит прогнозов. Подождите час.'
  }
});

// ============ СИСТЕМА ЛОГИРОВАНИЯ ============

const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
  USER_ACTION: 'USER_ACTION',
  SECURITY: 'SECURITY'
};

const LOG_FILE = 'logs/app.log';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logWrites = 0;

if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// Когда файл вырос больше лимита, он переименовывается в app.log.1 (предыдущий .1 затирается)
function rotateLogIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (e) {
    // файла ещё нет — ротировать нечего
  }
}

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data: data ? JSON.stringify(data) : null
  };

  const colors = {
    INFO: '\x1b[36m',
    WARN: '\x1b[33m',
    ERROR: '\x1b[31m',
    DEBUG: '\x1b[35m',
    USER_ACTION: '\x1b[32m',
    SECURITY: '\x1b[41m\x1b[37m'
  };

  const color = colors[level] || '\x1b[0m';
  console.log(`${color}[${timestamp}] ${level}: ${message}\x1b[0m`);

  if (level !== LOG_LEVELS.DEBUG) {
    if (++logWrites % 200 === 0) rotateLogIfNeeded();
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
    } catch (e) {
      // диск недоступен для записи (например, только чтение) — логи остаются в консоли
    }
  }
}

function logUserAction(userId, action, details = null) {
  log(LOG_LEVELS.USER_ACTION, `[${userId}] ${action}`, details);
}

function logSecurity(userId, action, details = null) {
  log(LOG_LEVELS.SECURITY, `[${userId}] ${action}`, details);
}

// ============ ИНИЦИАЛИЗАЦИЯ FIREBASE ============

let db = null;
try {
  const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  log(LOG_LEVELS.INFO, '✅ Firebase Admin initialized');
} catch (e) {
  log(LOG_LEVELS.WARN, `⚠️ Firebase Admin not initialized: ${e.message}`);
}

// ============ АВТОРИЗАЦИЯ ============

// Проверяет Firebase ID token из заголовка "Authorization: Bearer <token>" и кладёт пользователя в req.user
async function requireAuth(req, res, next) {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
  }

  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) {
    return res.status(401).json({ success: false, code: 'unauthorized', error: 'Требуется авторизация' });
  }

  try {
    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (e) {
    logSecurity('anonymous', 'Недействительный токен', { ip: req.ip, reason: e.code });
    res.status(401).json({ success: false, code: 'unauthorized', error: 'Недействительный токен' });
  }
}

// Заголовок "x-admin-key" совпадает с ADMIN_KEY
function isAdminRequest(req) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return false;

  const provided = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

// Только для владельца сервиса
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ success: false, error: 'ADMIN_KEY не настроен на сервере' });
  }
  if (!isAdminRequest(req)) {
    logSecurity('anonymous', 'Неверный ADMIN_KEY', { ip: req.ip, path: req.path });
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }
  next();
}

// Пользователь может работать только со своими данными
function requireSelf(req, res, next) {
  if (req.params.userId !== req.user.uid) {
    logSecurity(req.user.uid, 'Попытка доступа к чужим данным', { target: req.params.userId, path: req.path });
    return res.status(403).json({ success: false, code: 'forbidden', error: 'Доступ запрещён' });
  }
  next();
}

// ============ ЗАГРУЗКА МАТЧЕЙ ИЗ CSV ============

function parseMatches(data) {
  const lines = data.split('\n').filter(line => line.trim());
  const headers = lines[0].split(',').map(h => h.trim());

  const matches = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const match = {};
    headers.forEach((header, index) => {
      match[header] = values[index] || '';
    });

    // Преобразуем строки в числа
    match['homeScore'] = match['homeScore'] ? parseInt(match['homeScore']) : null;
    match['awayScore'] = match['awayScore'] ? parseInt(match['awayScore']) : null;
    match['actualHomeScore'] = match['actualHomeScore'] ? parseInt(match['actualHomeScore']) : null;
    match['actualAwayScore'] = match['actualAwayScore'] ? parseInt(match['actualAwayScore']) : null;
    match['isCompleted'] = match['isCompleted'] === 'true';
    match['isStarted'] = match['isStarted'] === 'true';
    match['id'] = i;

    matches.push(match);
  }
  return matches;
}

function loadMatches(filename) {
  try {
    return parseMatches(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка чтения ${filename}: ${error.message}`);
    return [];
  }
}

// slug — часть адреса /api/matches/:slug
// Массивы matches обновляются на месте (см. applyMatches), поэтому ссылки на них всегда актуальны
const LEAGUES = [
  { slug: 'epl', name: 'EPL', file: 'matches.csv' },
  { slug: 'laliga', name: 'La Liga', file: 'LaLiga.csv' },
  { slug: 'bundesliga', name: 'Bundesliga', file: 'Bundesliga.csv' },
  { slug: 'seriea', name: 'Serie A', file: 'SerieA.csv' },
  { slug: 'ligue1', name: 'Ligue 1', file: 'Ligue1.csv' },
  { slug: 'championsleague', name: 'Champions League', file: 'ChampionsLeague.csv' },
  { slug: 'europaleague', name: 'Europa League', file: 'EuropaLeague.csv' },
  { slug: 'conferenceleague', name: 'Conference League', file: 'ConferenceLeague.csv' },
  { slug: 'championship', name: 'Championship', file: 'Championship.csv' },
  { slug: 'eredivisie', name: 'Eredivisie', file: 'Eredivisie.csv' },
  { slug: 'primeiraliga', name: 'Primeira Liga', file: 'PrimeiraLiga.csv' },
  { slug: 'superlig', name: 'Süper Lig', file: 'SuperLig.csv' },
  { slug: 'scottishprem', name: 'Scottish Premiership', file: 'ScottishPremiership.csv' },
  { slug: 'nationsleague', name: 'Nations League', file: 'NationsLeague.csv' },
];

for (const league of LEAGUES) {
  league.matches = loadMatches(league.file);
  log(LOG_LEVELS.INFO, `📊 ${league.name}: ${league.matches.length} матчей`);
}

const getAllCSVMatches = () => LEAGUES.flatMap(league => league.matches);

// Подменяет матчи лиги новыми, не меняя сам массив
function applyMatches(league, matches) {
  league.matches.splice(0, league.matches.length, ...matches);
}

// Ищет матч по matchId ("home_away") во всех лигах
function findMatch(matchId) {
  for (const league of LEAGUES) {
    const match = league.matches.find(m => makeMatchId(m) === matchId);
    if (match) return { match: { ...match, league: league.name }, leagueName: league.name };
  }
  return null;
}

// ============ ПЕРЕЧИТЫВАНИЕ CSV НА ЛЕТУ ============

// Правки CSV вручную (или скриптом) подхватываются без перезапуска сервера
function reloadLeagueFromDisk(league) {
  try {
    const matches = parseMatches(fs.readFileSync(league.file, 'utf8'));
    if (matches.length === 0) throw new Error('файл пуст');
    applyMatches(league, matches);
    log(LOG_LEVELS.INFO, `🔄 ${league.name}: файл ${league.file} перечитан, ${matches.length} матчей`);
  } catch (error) {
    // Старые данные остаются: файл могли сохранять в этот момент
    log(LOG_LEVELS.WARN, `⚠️ Не удалось перечитать ${league.file}: ${error.message}`);
  }
}

for (const league of LEAGUES) {
  fs.watchFile(league.file, { interval: 5000 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs && current.size > 0) {
      reloadLeagueFromDisk(league);
    }
  });
}

// ============ РЕЗУЛЬТАТЫ МАТЧЕЙ ============

// Результаты попадают в CSV вручную или через syncSchedule.js: { matchId: { home, away } }
function getResultsFromCSV(matches) {
  const results = {};
  for (const match of matches) {
    if (match.isCompleted && match.actualHomeScore !== null && match.actualAwayScore !== null) {
      results[makeMatchId(match)] = {
        home: match.actualHomeScore,
        away: match.actualAwayScore
      };
    }
  }
  return results;
}

// ============ РАСЧЕТ ОЧКОВ ============

function calculatePoints(predictedHome, predictedAway, actualHome, actualAway) {
  if (predictedHome === actualHome && predictedAway === actualAway) {
    return 3;
  }

  const actualOutcome = actualHome > actualAway ? 'home' : actualHome < actualAway ? 'away' : 'draw';
  const predictedOutcome = predictedHome > predictedAway ? 'home' : predictedHome < predictedAway ? 'away' : 'draw';

  if (actualOutcome !== predictedOutcome) {
    return 0;
  }

  if (actualOutcome === 'draw') {
    return 1;
  }

  const actualGoalDiff = Math.abs(actualHome - actualAway);
  const predictedGoalDiff = Math.abs(predictedHome - predictedAway);

  if (actualGoalDiff === predictedGoalDiff) {
    return 2;
  }

  return 1;
}

// ============ СТАТУС МАТЧЕЙ ДЛЯ КЛИЕНТА ============

function withStatuses(matches, leagueName) {
  return matches.map(match => {
    const hasResult = match.isCompleted && match.actualHomeScore !== null && match.actualAwayScore !== null;

    // Клиент читает итоговый счёт из homeScore/awayScore
    const homeScore = hasResult ? match.actualHomeScore : match.homeScore;
    const awayScore = hasResult ? match.actualAwayScore : match.awayScore;
    const hasScore = homeScore !== null && awayScore !== null;

    // Время начала в UTC: приложение показывает его по часовому поясу устройства.
    // Для матчей без назначенного времени (timeTbd) это момент закрытия прогнозов, а не начало матча
    const kickoff = kickoffTime(match.date, leagueName);
    
    return {
      ...match,
      // Готовый ID матча: приложение не собирает его само (в еврокубках он включает турнир и тур)
      matchId: makeMatchId({ ...match, league: leagueName }),
      homeScore,
      awayScore,
      kickoff: kickoff ? kickoff.toISOString() : null,
      timeTbd: isTimeTbd(match.date),
      // Матч начался по флагу из CSV или по времени начала
      isStarted: hasStarted({ ...match, league: leagueName }),
      actualScore: hasScore ? `${homeScore}:${awayScore}` : null
    };
  });
}

// ============ КЕШ ТАБЛИЦЫ ЛИДЕРОВ ============

const LEADERBOARD_TTL_MS = 30 * 1000;
const leaderboardCache = new Map();

// ============ ПРОВЕРКА ЗАВЕРШЕННЫХ МАТЧЕЙ ============

// В одном пакете Firestore не больше 500 операций: прогноз + пользователь на каждый прогноз в пачке
const POINTS_CHUNK = 200;
// В условие "in" Firestore принимает не больше 30 значений
const IN_QUERY_LIMIT = 30;
let checkRunning = false;

// Матчи, по прогнозам на которые проверка уже прошла. Прогноз на матч нельзя создать после его начала,
// а результат появляется позже, поэтому каждый матч достаточно проверить один раз.
// Так сервер не перечитывает прогнозы каждые 5 минут (это быстро исчерпывает бесплатную квоту Firestore).
const scannedMatchIds = new Set();

// full: true — проверить все завершённые матчи заново (ручной запуск)
async function checkFinishedMatches({ full = false } = {}) {
  if (!db) {
    log(LOG_LEVELS.WARN, '⏳ Firebase не инициализирован, пропускаем проверку');
    return;
  }

  // Cron, запуск после синхронизации и /api/check не должны считать одни и те же прогнозы одновременно
  if (checkRunning) {
    log(LOG_LEVELS.DEBUG, 'Проверка уже идёт, пропускаем');
    return;
  }
  checkRunning = true;

  try {
    log(LOG_LEVELS.INFO, '🔄 Проверка завершенных матчей...');

    const results = getResultsFromCSV(getAllCSVMatches());

    if (Object.keys(results).length === 0) {
      log(LOG_LEVELS.WARN, '📭 Нет завершенных матчей');
      return;
    }

    if (full) scannedMatchIds.clear();
    const newMatchIds = Object.keys(results).filter(id => !scannedMatchIds.has(id));
    
    if (newMatchIds.length === 0) {
      log(LOG_LEVELS.DEBUG, 'Новых завершенных матчей нет');
      return;
    }
    
    // Читаем только необработанные прогнозы на новые завершённые матчи
    const predictionDocs = [];
    for (let i = 0; i < newMatchIds.length; i += IN_QUERY_LIMIT) {
      const snapshot = await db.collection('predictions')
        .where('processed', '==', false)
        .where('matchId', 'in', newMatchIds.slice(i, i + IN_QUERY_LIMIT))
        .get();
      predictionDocs.push(...snapshot.docs);
    }
    
    const ready = predictionDocs.filter(doc => {
      const data = doc.data();
      if (!data.userId) {
        log(LOG_LEVELS.WARN, `⚠️ Прогноз ${doc.id} без userId пропущен`);
        return false;
      }
      return true;
    });

    if (ready.length === 0) {
      newMatchIds.forEach(id => scannedMatchIds.add(id));
      log(LOG_LEVELS.INFO, '📭 Новых завершенных матчей для прогнозов нет');
      return;
    }

    let updated = 0;
    let failed = 0;

    for (let i = 0; i < ready.length; i += POINTS_CHUNK) {
      const chunk = ready.slice(i, i + POINTS_CHUNK);
      const batch = db.batch();
      const userTotals = {};

      for (const doc of chunk) {
        const data = doc.data();
        const actual = results[data.matchId];
        const points = calculatePoints(data.homeScore, data.awayScore, actual.home, actual.away);

        // lastUpdateTime: если прогноз уже обработал кто-то другой (второй экземпляр сервера),
        // пакет отклоняется целиком и очки не задваиваются
        batch.update(doc.ref, {
          points: points,
          actualHomeScore: actual.home,
          actualAwayScore: actual.away,
          processed: true,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { lastUpdateTime: doc.updateTime });

        const totals = userTotals[data.userId] || (userTotals[data.userId] = { points: 0, byLeague: {} });
        totals.points += points;
        if (data.league) totals.byLeague[data.league] = (totals.byLeague[data.league] || 0) + points;
      }

      // set + merge, а не update: если документа пользователя нет, один прогноз не блокирует остальные
      // Очки по лигам лежат в профиле: рейтинг лиги читает только пользователей, а не все прогнозы
      for (const [userId, totals] of Object.entries(userTotals)) {
        const update = { points: admin.firestore.FieldValue.increment(totals.points) };
        if (Object.keys(totals.byLeague).length > 0) {
          update.pointsByLeague = Object.fromEntries(
            Object.entries(totals.byLeague).map(([league, points]) => [league, admin.firestore.FieldValue.increment(points)])
          );
        }
        batch.set(db.collection('users').doc(userId), update, { merge: true });
      }

      try {
        await batch.commit();
        updated += chunk.length;
        for (const [userId, totals] of Object.entries(userTotals)) {
          logUserAction(userId, `Начислено ${totals.points} очков`, { points: totals.points });
        }
      } catch (error) {
        failed += chunk.length;
        log(LOG_LEVELS.ERROR, `❌ Не удалось обработать ${chunk.length} прогнозов: ${error.message}`, {
          error: error.stack
        });
      }
    }

    // Если хоть один пакет не прошёл, матчи проверим снова в следующий раз
    if (failed === 0) newMatchIds.forEach(id => scannedMatchIds.add(id));
    if (updated > 0) leaderboardCache.clear();
    log(LOG_LEVELS.INFO, `✅ Обновлено ${updated} прогнозов${failed ? `, с ошибкой ${failed}` : ''}`);
  } catch (error) {
    log(LOG_LEVELS.ERROR, `❌ Ошибка проверки матчей: ${error.message}`, {
      error: error.stack
    });
  } finally {
    checkRunning = false;
  }
}

// ============ ЭНДПОИНТЫ МАТЧЕЙ ============

for (const league of LEAGUES) {
  app.get(`/api/matches/${league.slug}`, globalLimiter, (req, res) => {
    try {
      const matches = withStatuses(league.matches, league.name);
      res.json({ success: true, matches, total: matches.length });
    } catch (error) {
      log(LOG_LEVELS.ERROR, `Ошибка ${league.name}: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

// ============ ЭНДПОИНТЫ ПРОГНОЗОВ ============

app.get('/api/predictions/:userId', globalLimiter, requireAuth, requireSelf, async (req, res) => {
  try {
    const userId = req.params.userId;

    const predictionsSnapshot = await db.collection('predictions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .get();

    const predictions = [];
    predictionsSnapshot.docs.forEach(doc => {
      predictions.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ success: true, predictions });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка получения прогнозов: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

const MAX_SCORE = 99;
// Столько прогнозов можно сохранить одним запросом (тур — до 10 матчей)
const MAX_BATCH = 20;

const fail = (status, code, error) => ({ ok: false, status, code, error });

// Проверяет и создаёт один прогноз. Возвращает { ok: true, prediction } или { ok: false, status, code, error }
async function createPrediction(user, { matchId, homeScore, awayScore }) {
  const userId = user.uid;

  logUserAction(userId, 'Создание прогноза', { matchId, homeScore, awayScore });

  if (!user.email_verified) {
    return fail(403, 'email_not_verified', 'Подтвердите email');
  }

  if (typeof matchId !== 'string' || homeScore === undefined || awayScore === undefined) {
    return fail(400, 'invalid_request', 'Недостаточно данных для создания прогноза');
  }

  const home = Number(homeScore);
  const away = Number(awayScore);
  const validScore = score => Number.isInteger(score) && score >= 0 && score <= MAX_SCORE;
  if (!validScore(home) || !validScore(away)) {
    return fail(400, 'invalid_score', `Счёт должен быть целым числом от 0 до ${MAX_SCORE}`);
  }

  const found = findMatch(matchId);
  if (!found) {
    logSecurity(userId, 'Прогноз на несуществующий матч', { matchId });
    return fail(400, 'unknown_match', 'Матч не найден');
  }

  if (hasStarted(found.match)) {
    logSecurity(userId, 'Прогноз на начавшийся матч', { matchId });
    return fail(400, 'match_started', 'Матч уже начался, прогноз не принимается');
  }

  const predictionData = {
    userId,
    matchId,
    homeScore: home,
    awayScore: away,
    league: found.leagueName,
    points: 0,
    processed: false,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  };

  // Детерминированный ID + create() гарантируют один прогноз на матч даже при параллельных запросах
  const predictionId = `${userId}_${crypto.createHash('sha1').update(matchId).digest('hex').slice(0, 20)}`;
  try {
    await db.collection('predictions').doc(predictionId).create(predictionData);
  } catch (e) {
    if (e.code === 6) { // ALREADY_EXISTS
      logSecurity(userId, 'Попытка создать дублирующий прогноз', { matchId });
      return fail(400, 'duplicate', 'Прогноз для этого матча уже существует');
    }
    throw e;
  }

  logUserAction(userId, 'Прогноз создан', { predictionId, matchId });
  return { ok: true, prediction: { id: predictionId, ...predictionData, timestamp: undefined } };
}

app.post('/api/predictions', requireAuth, predictionLimiter, async (req, res) => {
  try {
    const result = await createPrediction(req.user, req.body || {});
    if (!result.ok) {
      return res.status(result.status).json({ success: false, code: result.code, error: result.error });
    }
    res.json({ success: true, prediction: result.prediction });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка создания прогноза: ${error.message}`, {
      userId: req.user.uid,
      error: error.stack
    });
    res.status(500).json({ success: false, error: 'Не удалось сохранить прогноз' });
  }
});

// Несколько прогнозов за раз: каждый проверяется отдельно, ответ содержит результат по каждому.
// Ошибка одного (например, матч уже начался) не мешает сохранить остальные
app.post('/api/predictions/batch', requireAuth, predictionLimiter, async (req, res) => {
  const items = req.body && req.body.predictions;

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
    return res.status(400).json({
      success: false,
      code: 'invalid_request',
      error: `Нужно от 1 до ${MAX_BATCH} прогнозов`
    });
  }
  if (!req.user.email_verified) {
    return res.status(403).json({ success: false, code: 'email_not_verified', error: 'Подтвердите email' });
  }

  try {
    const results = [];
    for (const item of items) {
      const safeItem = item && typeof item === 'object' ? item : {};
      const result = await createPrediction(req.user, safeItem);
      results.push(result.ok
        ? { matchId: safeItem.matchId, success: true, prediction: result.prediction }
        : { matchId: safeItem.matchId, success: false, code: result.code, error: result.error });
    }
    res.json({ success: true, results });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка массового создания прогнозов: ${error.message}`, {
      userId: req.user.uid,
      error: error.stack
    });
    res.status(500).json({ success: false, error: 'Не удалось сохранить прогнозы' });
  }
});

// ============ ТАБЛИЦА ЛИДЕРОВ ============

// Очки по лигам считаются на месте (pointsByLeague в профиле) после разового пересчёта /api/recalculate?apply=1.
// Пока пересчёта не было, рейтинг лиги считается по прогнозам, как раньше: это верно, но читает все прогнозы лиги.
const LEAGUE_TOTALS_VERSION = 1;
let leagueTotalsReadyFlag = false;
let legacyLeaderboardWarnedAt = 0;

async function leagueTotalsReady() {
  if (leagueTotalsReadyFlag) return true;
  const doc = await db.collection('meta').doc('leaderboard').get();
  leagueTotalsReadyFlag = doc.exists && doc.data().version === LEAGUE_TOTALS_VERSION;
  return leagueTotalsReadyFlag;
}

async function buildLeaderboard(leagueFilter) {
  const usersSnapshot = await db.collection('users').get();
  const users = {};
  usersSnapshot.docs.forEach(doc => {
    const data = doc.data();
    users[doc.id] = {
      username: data.username || 'User',
      points: data.points || 0,
      byLeague: data.pointsByLeague || {},
    };
  });

  const points = {};

  if (leagueFilter === 'Overall') {
    for (const userId in users) {
      points[userId] = users[userId].points;
    }
  } else if (await leagueTotalsReady()) {
    for (const userId in users) {
      const value = users[userId].byLeague[leagueFilter];
      if (typeof value === 'number') points[userId] = value;
    }
  } else {
    if (Date.now() - legacyLeaderboardWarnedAt > 60 * 60 * 1000) {
      legacyLeaderboardWarnedAt = Date.now();
      log(LOG_LEVELS.WARN, '⚠️ Рейтинг лиги считается по всем прогнозам. Выполните GET /api/recalculate?apply=1 (x-admin-key), чтобы это исправить');
    }
    const predictionsSnapshot = await db.collection('predictions')
      .where('league', '==', leagueFilter)
      .get();

    predictionsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      points[data.userId] = (points[data.userId] || 0) + (data.points || 0);
    });
  }

  const leaderboard = Object.entries(points).map(([userId, userPoints]) => ({
    userId,
    username: (users[userId] || { username: 'Unknown' }).username,
    points: userPoints,
  }));

  leaderboard.sort((a, b) => b.points - a.points);
  leaderboard.forEach((item, index) => {
    item.rank = index + 1;
  });
  return leaderboard;
}

app.get('/api/leaderboard', globalLimiter, async (req, res) => {
  try {
    const leagueFilter = req.query.league || 'Overall';

    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }

    // Рейтинг читает всю коллекцию пользователей, поэтому результат кешируется на несколько секунд
    const cached = leaderboardCache.get(leagueFilter);
    if (cached && cached.expires > Date.now()) {
      return res.json({ success: true, leaderboard: cached.leaderboard });
    }

    const leaderboard = await buildLeaderboard(leagueFilter);
    leaderboardCache.set(leagueFilter, { leaderboard, expires: Date.now() + LEADERBOARD_TTL_MS });

    res.json({ success: true, leaderboard });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка таблицы лидеров: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Общий рейтинг с тем же кешем, что у /api/leaderboard
async function overallLeaderboard() {
  const cached = leaderboardCache.get('Overall');
  if (cached && cached.expires > Date.now()) return cached.leaderboard;
  const leaderboard = await buildLeaderboard('Overall');
  leaderboardCache.set('Overall', { leaderboard, expires: Date.now() + LEADERBOARD_TTL_MS });
  return leaderboard;
}

// ============ ЛИГИ ДРУЗЕЙ ============
registerGroupRoutes(app, {
  getDb: () => db,
  requireAuth,
  limiter: globalLimiter,
  getOverallLeaderboard: overallLeaderboard,
  log: (level, message) => log(LOG_LEVELS[level] || LOG_LEVELS.ERROR, message),
});

// ============ СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ ============

app.get('/api/user-stats/:userId', globalLimiter, requireAuth, requireSelf, async (req, res) => {
  try {
    const userId = req.params.userId;

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }

    const userData = userDoc.data();

    const predictionsSnapshot = await db.collection('predictions')
      .where('userId', '==', userId)
      .get();

    const totalPredictions = predictionsSnapshot.docs.length;
    const processedPredictions = predictionsSnapshot.docs.filter(
      doc => doc.data().processed === true
    ).length;

    let exactScorePredictions = 0;
    let correctOutcomePredictions = 0;

    predictionsSnapshot.docs.forEach(doc => {
      const data = doc.data();

      if (data.processed && data.points === 3) {
        exactScorePredictions++;
      }
      if (data.processed && data.points > 0) {
        correctOutcomePredictions++;
      }
    });

    res.json({
      success: true,
      stats: {
        totalPredictions,
        processedPredictions,
        exactScorePredictions,
        correctOutcomePredictions,
        totalPoints: userData.points || 0,
        username: userData.username || 'User',
        email: userData.email || ''
      }
    });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка статистики: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ОБНОВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ ============

app.put('/api/users/:userId', globalLimiter, requireAuth, requireSelf, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { username } = req.body;

    if (typeof username !== 'string' || username.trim().length === 0 || username.trim().length > 30) {
      return res.status(400).json({ success: false, error: 'Имя пользователя: от 1 до 30 символов' });
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }

    await userRef.update({
      username: username.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    leaderboardCache.clear();

    logUserAction(userId, 'Обновлён профиль', { username });

    res.json({ success: true, message: 'Данные обновлены' });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка обновления: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ПЕРЕСЧЁТ ОЧКОВ ============

const stableJson = object => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))));
const RECALC_SAMPLES = 50;
// Изменений в одном пакете не больше, чем вмещает Firestore (500)
const RECALC_CHUNK = 400;

// Пересчитывает очки с нуля: по прогнозам и текущим результатам матчей.
// Исправляет прогнозы, у которых очки не совпадают с результатом (например, если счёт матча исправили),
// и приводит в соответствие общие очки и очки по лигам в профилях.
// apply: false — только показать, что изменится.
async function recalculatePoints({ apply }) {
  const [predictionsSnapshot, usersSnapshot] = await Promise.all([
    db.collection('predictions').get(),
    db.collection('users').get(),
  ]);
  const results = getResultsFromCSV(getAllCSVMatches());

  const expected = {};
  const predictionFixes = [];

  for (const doc of predictionsSnapshot.docs) {
    const data = doc.data();
    if (!data.userId) continue;

    let points = data.points || 0;
    let processed = data.processed === true;
    const actual = results[data.matchId];

    if (actual) {
      const correct = calculatePoints(data.homeScore, data.awayScore, actual.home, actual.away);
      if (!processed || points !== correct || data.actualHomeScore !== actual.home || data.actualAwayScore !== actual.away) {
        predictionFixes.push({
          id: doc.id,
          ref: doc.ref,
          before: processed ? points : null,
          after: correct,
          data: {
            points: correct,
            actualHomeScore: actual.home,
            actualAwayScore: actual.away,
            processed: true,
            processedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        });
      }
      points = correct;
      processed = true;
    }

    if (!processed) continue;
    const totals = expected[data.userId] || (expected[data.userId] = { points: 0, byLeague: {} });
    totals.points += points;
    if (data.league) totals.byLeague[data.league] = (totals.byLeague[data.league] || 0) + points;
  }

  const userFixes = [];
  const knownUsers = new Set();
  for (const doc of usersSnapshot.docs) {
    knownUsers.add(doc.id);
    const want = expected[doc.id] || { points: 0, byLeague: {} };
    const data = doc.data();
    const leaguesMatch = stableJson(data.pointsByLeague || {}) === stableJson(want.byLeague);
    if ((data.points || 0) !== want.points || !leaguesMatch) {
      userFixes.push({
        id: doc.id,
        ref: doc.ref,
        before: data.points || 0,
        after: want.points,
        data: { points: want.points, pointsByLeague: want.byLeague }
      });
    }
  }
  const usersWithoutProfile = Object.keys(expected).filter(id => !knownUsers.has(id));

  const summarize = fixes => fixes.slice(0, RECALC_SAMPLES).map(({ id, before, after }) => ({ id, before, after }));
  const report = {
    applied: false,
    predictions: { checked: predictionsSnapshot.size, toFix: predictionFixes.length, samples: summarize(predictionFixes) },
    users: { checked: usersSnapshot.size, toFix: userFixes.length, samples: summarize(userFixes) },
    predictionsWithoutProfile: usersWithoutProfile.length,
    leagueTotalsReady: await leagueTotalsReady()
  };
  if (!apply) return report;

  const writes = [...predictionFixes, ...userFixes];
  for (let i = 0; i < writes.length; i += RECALC_CHUNK) {
    const batch = db.batch();
    writes.slice(i, i + RECALC_CHUNK).forEach(({ ref, data }) => batch.update(ref, data));
    await batch.commit();
  }

  // Отметка, что очки по лигам в профилях полные: с этого момента рейтинг лиги читает только пользователей
  await db.collection('meta').doc('leaderboard').set({
    version: LEAGUE_TOTALS_VERSION,
    rebuiltAt: admin.firestore.FieldValue.serverTimestamp()
  });
  leagueTotalsReadyFlag = true;
  leaderboardCache.clear();

  report.applied = true;
  return report;
}

// Без apply=1 ничего не пишет. Не запускается одновременно с начислением очков
app.get('/api/recalculate', strictLimiter, requireAdmin, async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
  }
  if (checkRunning) {
    return res.status(409).json({ success: false, error: 'Сейчас идёт начисление очков, повторите через минуту' });
  }

  checkRunning = true;
  try {
    const report = await recalculatePoints({ apply: req.query.apply === '1' });
    log(LOG_LEVELS.INFO, `🧮 Пересчёт очков (${report.applied ? 'записан' : 'без записи'}): прогнозов к исправлению ${report.predictions.toFix}, профилей ${report.users.toFix}`);
    res.json({ success: true, ...report });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка пересчёта очков: ${error.message}`, { error: error.stack });
    res.status(500).json({ success: false, error: error.message });
  } finally {
    checkRunning = false;
  }
});

// ============ УДАЛЕНИЕ АККАУНТА ============

// Пакет Firestore — не больше 500 операций
const DELETE_CHUNK = 400;
// Подтверждение пароля не старше этого возраста (в секундах)
const RECENT_LOGIN_SECONDS = 5 * 60;

async function deletePredictionsOf(userId) {
  let deleted = 0;
  for (;;) {
    const snapshot = await db.collection('predictions')
      .where('userId', '==', userId)
      .limit(DELETE_CHUNK)
      .get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.docs.length;

    if (snapshot.docs.length < DELETE_CHUNK) break;
  }
  return deleted;
}

// Удаляет прогнозы, профиль и, в последнюю очередь, сам аккаунт. Запрос можно безопасно повторить:
// если что-то оборвалось, аккаунт остаётся и удаление можно запустить снова.
app.delete('/api/account', globalLimiter, requireAuth, async (req, res) => {
  const userId = req.user.uid;

  try {
    // Необратимое действие: токен должен быть получен после недавнего ввода пароля
    if (Date.now() / 1000 - (req.user.auth_time || 0) > RECENT_LOGIN_SECONDS) {
      return res.status(401).json({
        success: false,
        code: 'recent_login_required',
        error: 'Подтвердите пароль ещё раз'
      });
    }

    const predictions = await deletePredictionsOf(userId);
    await leaveAllGroups(db, userId);
    await db.collection('users').doc(userId).delete();

    try {
      await admin.auth().deleteUser(userId);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
    leaderboardCache.clear();

    logSecurity(userId, 'Аккаунт удалён', { predictions });
    res.json({ success: true });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка удаления аккаунта: ${error.message}`, { userId, error: error.stack });
    res.status(500).json({ success: false, error: 'Не удалось удалить аккаунт' });
  }
});

// ============ СИНХРОНИЗАЦИЯ КАЛЕНДАРЯ И РЕЗУЛЬТАТОВ ============

// Календарь и счета из внешних источников (см. syncSchedule.js). Можно отключить: SYNC_ENABLED=false
const SYNC_ENABLED = process.env.SYNC_ENABLED !== 'false';
const syncState = { lastRun: null, lastChange: null, errors: {}, running: false };

async function runScheduleSync() {
  if (syncState.running) return;
  syncState.running = true;

  try {
    const results = await syncAll(new Date());
    syncState.lastRun = new Date();

    for (const result of results) {
      const name = result.league.name;

      if (result.error) {
        syncState.errors[name] = result.error;
        log(LOG_LEVELS.WARN, `⚠️ Синхронизация ${name}: ${result.error}`);
        continue;
      }
      delete syncState.errors[name];

      const { report } = result;
      for (const conflict of report.conflicts) {
        log(LOG_LEVELS.WARN, `⚠️ ${name}: источники расходятся, результат не записан — ${conflict}`);
      }
      if (!result.changed) continue;

      // Сначала применяем в памяти: диск на хостинге может быть временным или только для чтения
      const league = LEAGUES.find(l => l.name === name);
      applyMatches(league, parseMatches(result.content));
      syncState.lastChange = new Date();
      log(LOG_LEVELS.INFO, `✅ ${name}: календарь обновлён, новых результатов: ${report.newResults}`);

      try {
        fs.writeFileSync(league.file, '﻿' + result.content);
      } catch (error) {
        log(LOG_LEVELS.WARN, `⚠️ ${name}: не удалось сохранить ${league.file}: ${error.message}`);
      }

      if (report.newResults > 0) checkFinishedMatches();
    }
  } catch (error) {
    log(LOG_LEVELS.ERROR, `❌ Ошибка синхронизации: ${error.message}`);
  } finally {
    syncState.running = false;
  }
}

// ============ УТИЛИТЫ ============

// Для внешнего пинга (например, UptimeRobot), чтобы бесплатный хостинг не засыпал
app.get('/api/health', (req, res) => {
  res.json({ success: true });
});

app.get('/api/check', strictLimiter, requireAdmin, async (req, res) => {
  try {
    // ?full=0 — только новые завершённые матчи (без полного перескана)
    await checkFinishedMatches({ full: req.query.full !== '0' });
    res.json({ success: true, message: 'Проверка выполнена успешно' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Внеплановая синхронизация календаря и результатов
app.get('/api/sync', strictLimiter, requireAdmin, async (req, res) => {
  await runScheduleSync();
  res.json({
    success: Object.keys(syncState.errors).length === 0,
    lastRun: syncState.lastRun,
    lastChange: syncState.lastChange,
    errors: syncState.errors
  });
});

// Без ключа — только общее состояние; количество пользователей и прогнозов видно с x-admin-key
app.get('/api/status', globalLimiter, async (req, res) => {
  try {
    const status = {
      server: 'running',
      scheduleSync: {
        enabled: SYNC_ENABLED,
        lastRun: syncState.lastRun,
        lastChange: syncState.lastChange,
        errors: syncState.errors
      },
      matches: Object.fromEntries(LEAGUES.map(league => [league.name, league.matches.length]))
    };

    if (isAdminRequest(req)) {
      status.firebase = 'not initialized';
      if (db) {
        try {
          const [usersAll, predictionsAll] = await Promise.all([
            db.collection('users').get(),
            db.collection('predictions').get()
          ]);
          status.users = usersAll.docs.length;
          status.predictions = predictionsAll.docs.length;
          status.firebase = 'connected';
        } catch (e) {
          status.firebase = 'error';
        }
      }
    }

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ЗАПУСК ПРОВЕРОК ============

// BACKGROUND_JOBS=false — не запускать плановые задачи (для служебных запусков)
const BACKGROUND_JOBS = process.env.BACKGROUND_JOBS !== 'false';

if (BACKGROUND_JOBS && SYNC_ENABLED) {
  cron.schedule('*/30 * * * *', () => {
    log(LOG_LEVELS.INFO, '📅 Синхронизация календаря и результатов...');
    runScheduleSync();
  });
  setTimeout(runScheduleSync, 5000);
}

if (BACKGROUND_JOBS) {
  cron.schedule('*/5 * * * *', () => {
    log(LOG_LEVELS.INFO, '⏰ Запуск плановой проверки...');
    checkFinishedMatches();
  });

  setTimeout(() => {
    log(LOG_LEVELS.INFO, '🚀 Первичная проверка матчей...');
    checkFinishedMatches();
  }, 10000);
}

// HOST=127.0.0.1 на своём сервере: снаружи — только через Caddy (HTTPS)
app.listen(PORT, process.env.HOST, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log('📋 Доступные эндпоинты:\n');
  console.log('  📊 MATCHES:');
  console.log('  GET /api/matches/:league - Получить матчи лиги');
  console.log('');
  console.log('  🎯 PREDICTIONS:');
  console.log('  GET /api/predictions/:userId - Прогнозы пользователя');
  console.log('  POST /api/predictions - Создать прогноз');
  console.log('  POST /api/predictions/batch - Создать до 20 прогнозов за раз');
  console.log('');
  console.log('  🏆 LEADERBOARD:');
  console.log('  GET /api/leaderboard - Таблица лидеров');
  console.log('');
  console.log('  👤 USER:');
  console.log('  GET /api/user-stats/:userId - Статистика');
  console.log('  PUT /api/users/:userId - Обновить данные');
  console.log('  DELETE /api/account - Удалить аккаунт и все данные');
  console.log('');
  console.log('  👥 GROUPS (лиги друзей):');
  console.log('  GET /api/groups, POST /api/groups, POST /api/groups/join');
  console.log('  GET /api/groups/:id/leaderboard, POST /api/groups/:id/leave');
  console.log('');
  console.log('  🔧 UTILITY:');
  console.log('  GET /api/health - Проверка доступности (для пинга)');
  console.log('  GET /api/status - Статус сервера');
  console.log('  GET /api/check - Ручная проверка (x-admin-key)');
  console.log('  GET /api/sync - Внеплановая синхронизация (x-admin-key)');
  console.log('  GET /api/recalculate - Пересчёт очков; ?apply=1 — записать (x-admin-key)');
  console.log('');
  console.log('⏰ Плановые задачи:');
  console.log('  - Проверка матчей: каждые 5 минут');
  console.log(SYNC_ENABLED
    ? '  - Синхронизация календаря и результатов: каждые 30 минут'
    : '  - Синхронизация календаря и результатов: отключена (SYNC_ENABLED=false)');
  console.log('  - CSV перечитываются при изменении файлов');
  console.log('');
  console.log('📁 Логи сохраняются в logs/app.log');
  console.log('🛡️ Rate limiting активен');
  console.log('');
});
