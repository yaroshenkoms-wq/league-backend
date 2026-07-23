require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const cron = require('node-cron');
const admin = require('firebase-admin');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============ НАСТРОЙКА RATE LIMITING ============

// 1. Глобальный лимит - защита от общих атак
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // максимум 100 запросов за 15 минут
  message: {
    success: false,
    error: 'Слишком много запросов. Попробуйте позже.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.ip === '127.0.0.1'
});

// 2. Строгий лимит для чувствительных эндпоинтов
const strictLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 минут
  max: 10,
  message: {
    success: false,
    error: 'Слишком много запросов. Подождите 5 минут.'
  }
});

// 3. Лимит для создания прогнозов
const predictionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 20,
  message: {
    success: false,
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

// Создаём папку для логов
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data: data ? JSON.stringify(data) : null
  };
  
  // Вывод в консоль с цветом
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
  
  // Сохраняем логи в файл
  if (level !== LOG_LEVELS.DEBUG) {
    fs.appendFileSync('logs/app.log', JSON.stringify(logEntry) + '\n');
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

// ============ API-FOOTBALL НАСТРОЙКИ ============

const API_KEY = '3a796c1e33723a0b6c46b8b857c139cb';
const BASE_URL = 'https://v3.football.api-sports.io';

// ============ ЗАГРУЗКА МАТЧЕЙ ИЗ CSV ============

function loadMatches(filename) {
  try {
    const data = fs.readFileSync(filename, 'utf8');
    const lines = data.split('\n').filter(line => line.trim());
    const headers = lines[0].split(',').map(h => h.trim());
    
    const matches = [];
    const now = new Date();
    
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const match = {};
      headers.forEach((header, index) => {
        match[header] = values[index] || '';
      });
      
      const dateStr = match['date'] || '';
      let matchDate = null;
      try {
        const parts = dateStr.split(' ');
        if (parts.length >= 5) {
          const day = parseInt(parts[1]);
          const month = parts[2];
          const year = parseInt(parts[3]);
          const time = parts[4];
          
          const monthMap = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
            'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
          };
          const monthNum = monthMap[month];
          if (monthNum !== undefined) {
            const [hours, minutes] = time.split(':').map(Number);
            matchDate = new Date(year, monthNum, day, hours, minutes);
          }
        }
      } catch (e) {
        matchDate = null;
      }
      
      match['isStarted'] = matchDate ? matchDate < now : false;
      match['id'] = i;
      match['isCompleted'] = false;
      match['homeScore'] = null;
      match['awayScore'] = null;
      matches.push(match);
    }
    return matches;
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка чтения ${filename}: ${error.message}`);
    return [];
  }
}

const eplMatches = loadMatches('matches.csv');
const laLigaMatches = loadMatches('LaLiga.csv');
const bundesligaMatches = loadMatches('Bundesliga.csv');
const serieAMatches = loadMatches('SerieA.csv');
const ligue1Matches = loadMatches('Ligue1.csv');
const testMatches = loadMatches('Test.csv');

log(LOG_LEVELS.INFO, `📊 EPL: ${eplMatches.length} матчей`);
log(LOG_LEVELS.INFO, `📊 La Liga: ${laLigaMatches.length} матчей`);
log(LOG_LEVELS.INFO, `📊 Bundesliga: ${bundesligaMatches.length} матчей`);
log(LOG_LEVELS.INFO, `📊 Serie A: ${serieAMatches.length} матчей`);
log(LOG_LEVELS.INFO, `📊 Ligue 1: ${ligue1Matches.length} матчей`);
log(LOG_LEVELS.INFO, `📊 Test: ${testMatches.length} матчей`);

// ============ КЕШ ДЛЯ РЕАЛЬНЫХ РЕЗУЛЬТАТОВ ============

let realResultsCache = {};
let lastFetchTime = null;

// ============ ПОЛУЧЕНИЕ РЕАЛЬНЫХ РЕЗУЛЬТАТОВ ============

async function getFinishedMatches() {
  try {
    const leagues = [
      { id: 39, name: 'EPL' },
      { id: 140, name: 'La Liga' },
      { id: 78, name: 'Bundesliga' },
      { id: 135, name: 'Serie A' },
      { id: 61, name: 'Ligue 1' },
    ];
    
    let allResults = {};
    
    for (const league of leagues) {
      try {
        const response = await axios.get(`${BASE_URL}/fixtures`, {
          params: {
            league: league.id,
            season: 2026,
            status: 'FT',
          },
          headers: {
            'x-rapidapi-key': API_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          }
        });
        
        const fixtures = response.data.response || [];
        log(LOG_LEVELS.INFO, `📊 ${league.name}: ${fixtures.length} завершенных матчей`);
        
        for (const fixture of fixtures) {
          const home = fixture.teams.home.name;
          const away = fixture.teams.away.name;
          const date = new Date(fixture.fixture.date).toLocaleString('en-GB', {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
          
          const matchId = `${home}_${away}_${date}`;
          allResults[matchId] = {
            home: fixture.goals.home,
            away: fixture.goals.away
          };
        }
      } catch (e) {
        log(LOG_LEVELS.WARN, `⚠️ Ошибка загрузки лиги ${league.name}: ${e.message}`);
      }
    }
    
    realResultsCache = allResults;
    lastFetchTime = new Date();
    return allResults;
  } catch (error) {
    log(LOG_LEVELS.ERROR, `❌ Ошибка API-Football: ${error.message}`);
    return realResultsCache;
  }
}

// ============ РАСЧЕТ ОЧКОВ ============

function calculatePoints(predictedHome, predictedAway, actualHome, actualAway) {
  // Проверка на точный счёт (3 очка)
  if (predictedHome === actualHome && predictedAway === actualAway) {
    return 3;
  }

  // Определяем исход матча
  const actualOutcome = actualHome > actualAway ? 'home' : actualHome < actualAway ? 'away' : 'draw';
  const predictedOutcome = predictedHome > predictedAway ? 'home' : predictedHome < predictedAway ? 'away' : 'draw';

  // Если исход не угадан - 0 очков
  if (actualOutcome !== predictedOutcome) {
    return 0;
  }

  // Если ничья - 1 очко (точный счёт уже проверен)
  if (actualOutcome === 'draw') {
    return 1;
  }

  // Для матчей с победителем: проверяем разницу голов
  const actualGoalDiff = Math.abs(actualHome - actualAway);
  const predictedGoalDiff = Math.abs(predictedHome - predictedAway);

  // Если разница голов угадана - 2 очка
  if (actualGoalDiff === predictedGoalDiff) {
    return 2;
  }

  // Иначе 1 очко (только исход угадан)
  return 1;
}

// ============ ОБНОВЛЕНИЕ СТАТУСА МАТЧЕЙ ============

async function updateMatchStatuses(matches, leagueName) {
  const realResults = await getFinishedMatches();
  
  return matches.map(match => {
    const matchId = `${match.home}_${match.away}_${match.date}`;
    const result = realResults[matchId];
    const isCompleted = result ? true : false;
    
    return {
      ...match,
      isCompleted: isCompleted,
      homeScore: result?.home || null,
      awayScore: result?.away || null,
      isStarted: match.isStarted || false,
      actualScore: result ? `${result.home}:${result.away}` : null
    };
  });
}

// ============ ПРОВЕРКА ЗАВЕРШЕННЫХ МАТЧЕЙ ============

async function checkFinishedMatches() {
  if (!db) {
    log(LOG_LEVELS.WARN, '⏳ Firebase не инициализирован, пропускаем проверку');
    return;
  }
  
  try {
    log(LOG_LEVELS.INFO, '🔄 Проверка завершенных матчей...');
    
    const realResults = await getFinishedMatches();
    
    if (Object.keys(realResults).length === 0) {
      log(LOG_LEVELS.WARN, '📭 Нет завершенных матчей');
      return;
    }
    
    const predictionsSnapshot = await db.collection('predictions')
      .where('processed', '==', false)
      .get();
    
    if (predictionsSnapshot.empty) {
      log(LOG_LEVELS.INFO, '📭 Нет необработанных прогнозов');
      return;
    }
    
    let updated = 0;
    const batch = db.batch();
    const userPointsUpdates = {};
    
    for (const doc of predictionsSnapshot.docs) {
      const data = doc.data();
      const matchId = data.matchId;
      
      if (realResults[matchId]) {
        const actualScore = realResults[matchId];
        const predictedHome = data.homeScore;
        const predictedAway = data.awayScore;
        const actualHome = actualScore.home;
        const actualAway = actualScore.away;
        
        const points = calculatePoints(predictedHome, predictedAway, actualHome, actualAway);
        
        const docRef = doc.ref;
        batch.update(docRef, {
          points: points,
          actualHomeScore: actualHome,
          actualAwayScore: actualAway,
          processed: true,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        const userId = data.userId;
        if (!userPointsUpdates[userId]) {
          userPointsUpdates[userId] = 0;
        }
        userPointsUpdates[userId] += points;
        
        updated++;
        
        log(LOG_LEVELS.INFO, `✅ Прогноз ${doc.id}: +${points} очков (${matchId})`, {
          userId,
          matchId,
          points,
          predicted: `${predictedHome}:${predictedAway}`,
          actual: `${actualHome}:${actualAway}`
        });
      }
    }
    
    for (const [userId, points] of Object.entries(userPointsUpdates)) {
      const userRef = db.collection('users').doc(userId);
      batch.update(userRef, {
        points: admin.firestore.FieldValue.increment(points)
      });
      logUserAction(userId, `Начислено ${points} очков`, { points });
    }
    
    if (updated > 0) {
      await batch.commit();
      log(LOG_LEVELS.INFO, `✅ Обновлено ${updated} прогнозов`);
    } else {
      log(LOG_LEVELS.INFO, '📭 Новых завершенных матчей для прогнозов нет');
    }
  } catch (error) {
    log(LOG_LEVELS.ERROR, `❌ Ошибка проверки матчей: ${error.message}`, {
      error: error.stack
    });
  }
}

// ============ ЭНДПОИНТЫ МАТЧЕЙ (с лимитами) ============

app.get('/api/matches/epl', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(eplMatches, 'EPL');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка EPL: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/matches/laliga', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(laLigaMatches, 'La Liga');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/matches/bundesliga', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(bundesligaMatches, 'Bundesliga');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/matches/seriea', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(serieAMatches, 'Serie A');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/matches/ligue1', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(ligue1Matches, 'Ligue 1');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/matches/test', globalLimiter, async (req, res) => {
  try {
    const matchesWithStatus = await updateMatchStatuses(testMatches, 'Test');
    res.json({ success: true, matches: matchesWithStatus, total: matchesWithStatus.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ЭНДПОИНТЫ ПРОГНОЗОВ (с лимитами) ============

app.get('/api/predictions/:userId', globalLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }
    
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

app.post('/api/predictions', predictionLimiter, async (req, res) => {
  try {
    const { userId, matchId, homeScore, awayScore, league } = req.body;
    
    logUserAction(userId, 'Создание прогноза', { matchId, homeScore, awayScore, league });
    
    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }
    
    if (!userId || !matchId || homeScore === undefined || awayScore === undefined || !league) {
      return res.status(400).json({ 
        success: false, 
        error: 'Недостаточно данных для создания прогноза' 
      });
    }
    
    const existingPredictions = await db.collection('predictions')
      .where('userId', '==', userId)
      .where('matchId', '==', matchId)
      .get();
    
    if (!existingPredictions.empty) {
      logSecurity(userId, 'Попытка создать дублирующий прогноз', { matchId });
      return res.status(400).json({ 
        success: false, 
        error: 'Прогноз для этого матча уже существует' 
      });
    }
    
    const realResults = await getFinishedMatches();
    if (realResults[matchId]) {
      logSecurity(userId, 'Попытка создать прогноз на завершённый матч', { matchId });
      return res.status(400).json({ 
        success: false, 
        error: 'Матч уже завершен, прогнозы не принимаются' 
      });
    }
    
    const predictionData = {
      userId,
      matchId,
      homeScore: parseInt(homeScore),
      awayScore: parseInt(awayScore),
      league,
      points: 0,
      processed: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('predictions').add(predictionData);
    
    logUserAction(userId, 'Прогноз создан', { predictionId: docRef.id, matchId });
    
    res.json({ 
      success: true, 
      prediction: { id: docRef.id, ...predictionData } 
    });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка создания прогноза: ${error.message}`, {
      userId: req.body.userId,
      error: error.stack
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ТАБЛИЦА ЛИДЕРОВ ============

app.get('/api/leaderboard', globalLimiter, async (req, res) => {
  try {
    const leagueFilter = req.query.league || null;
    
    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }
    
    const usersSnapshot = await db.collection('users').get();
    const users = {};
    usersSnapshot.docs.forEach(doc => {
      const data = doc.data();
      users[doc.id] = {
        username: data.username || 'User',
        email: data.email,
        points: data.points || 0,
      };
    });

    if (!leagueFilter || leagueFilter === 'Overall') {
      const leaderboard = [];
      for (const userId in users) {
        leaderboard.push({
          userId: userId,
          username: users[userId].username,
          points: users[userId].points,
        });
      }
      
      leaderboard.sort((a, b) => b.points - a.points);
      leaderboard.forEach((item, index) => {
        item.rank = index + 1;
      });
      
      return res.json({ success: true, leaderboard });
    }
    
    const predictionsSnapshot = await db.collection('predictions')
      .where('league', '==', leagueFilter)
      .get();
    
    const points = {};
    
    predictionsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      const userPoints = data.points || 0;
      
      if (points[userId]) {
        points[userId] += userPoints;
      } else {
        points[userId] = userPoints;
      }
    });

    const leaderboard = [];
    for (const userId in points) {
      const user = users[userId] || { username: 'Unknown' };
      leaderboard.push({
        userId: userId,
        username: user.username,
        points: points[userId],
      });
    }

    leaderboard.sort((a, b) => b.points - a.points);
    leaderboard.forEach((item, index) => {
      item.rank = index + 1;
    });

    res.json({ success: true, leaderboard });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка таблицы лидеров: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ ============

app.get('/api/user-stats/:userId', globalLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }
    
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
    let totalPoints = 0;
    
    predictionsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const points = data.points || 0;
      totalPoints += points;
      
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

app.put('/api/users/:userId', globalLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { username } = req.body;
    
    if (!db) {
      return res.status(500).json({ success: false, error: 'Firebase не инициализирован' });
    }
    
    if (!username) {
      return res.status(400).json({ success: false, error: 'Имя пользователя обязательно' });
    }
    
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }
    
    await userRef.update({
      username: username,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    logUserAction(userId, 'Обновлён профиль', { username });
    
    res.json({ success: true, message: 'Данные обновлены' });
  } catch (error) {
    log(LOG_LEVELS.ERROR, `Ошибка обновления: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ УТИЛИТЫ ============

app.get('/api/check', strictLimiter, async (req, res) => {
  try {
    await checkFinishedMatches();
    res.json({ success: true, message: 'Проверка выполнена успешно' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/refresh-results', strictLimiter, async (req, res) => {
  try {
    const results = await getFinishedMatches();
    res.json({ 
      success: true, 
      message: 'Результаты обновлены',
      count: Object.keys(results).length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/status', globalLimiter, async (req, res) => {
  try {
    let firebaseStatus = 'not initialized';
    let usersCount = 0;
    let predictionsCount = 0;
    
    if (db) {
      try {
        const usersAll = await db.collection('users').get();
        const predictionsAll = await db.collection('predictions').get();
        usersCount = usersAll.docs.length;
        predictionsCount = predictionsAll.docs.length;
        firebaseStatus = 'connected';
      } catch (e) {
        firebaseStatus = 'error';
      }
    }
    
    res.json({
      success: true,
      status: {
        server: 'running',
        firebase: firebaseStatus,
        users: usersCount,
        predictions: predictionsCount,
        lastFetch: lastFetchTime,
        matches: {
          EPL: eplMatches.length,
          'La Liga': laLigaMatches.length,
          Bundesliga: bundesligaMatches.length,
          'Serie A': serieAMatches.length,
          'Ligue 1': ligue1Matches.length,
          Test: testMatches.length
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ЗАПУСК ПРОВЕРОК ============

cron.schedule('*/5 * * * *', () => {
  log(LOG_LEVELS.INFO, '⏰ Запуск плановой проверки...');
  checkFinishedMatches();
});

setTimeout(() => {
  log(LOG_LEVELS.INFO, '🚀 Первичная проверка матчей...');
  checkFinishedMatches();
}, 10000);

cron.schedule('*/10 * * * *', () => {
  log(LOG_LEVELS.INFO, '🔄 Обновление кеша результатов...');
  getFinishedMatches();
});

// ============ ЗАПУСК СЕРВЕРА ============

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log('📋 Доступные эндпоинты:\n');
  console.log('  📊 MATCHES:');
  console.log('  GET /api/matches/:league - Получить матчи лиги');
  console.log('');
  console.log('  🎯 PREDICTIONS:');
  console.log('  GET /api/predictions/:userId - Прогнозы пользователя');
  console.log('  POST /api/predictions - Создать прогноз');
  console.log('');
  console.log('  🏆 LEADERBOARD:');
  console.log('  GET /api/leaderboard - Таблица лидеров');
  console.log('');
  console.log('  👤 USER:');
  console.log('  GET /api/user-stats/:userId - Статистика');
  console.log('  PUT /api/users/:userId - Обновить данные');
  console.log('');
  console.log('  🔧 UTILITY:');
  console.log('  GET /api/check - Ручная проверка');
  console.log('  GET /api/refresh-results - Обновить результаты');
  console.log('  GET /api/status - Статус сервера');
  console.log('');
  console.log('⏰ Плановые задачи:');
  console.log('  - Проверка матчей: каждые 5 минут');
  console.log('  - Обновление результатов: каждые 10 минут');
  console.log('');
  console.log('📁 Логи сохраняются в logs/app.log');
  console.log('🛡️ Rate limiting активен');
  console.log('');
});