// Наполняет ЛОКАЛЬНЫЕ эмуляторы Firebase выдуманными игроками и прогнозами для съёмки скриншотов.
// Никогда не пишет в настоящий проект: без адресов эмуляторов скрипт не запускается.
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node tools/seedDemo.js
//
// Демо-игрок: alex.demo@example.com / Demo-pass-2026 (почта подтверждена).

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Отказ: не заданы FIRESTORE_EMULATOR_HOST и FIREBASE_AUTH_EMULATOR_HOST. Скрипт работает только с эмуляторами.');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { makeMatchId } = require('../matchUtils');

admin.initializeApp({ projectId: 'league-predictions-e0696' });
const db = admin.firestore();
const auth = admin.auth();

const DEMO = { email: 'alex.demo@example.com', password: 'Demo-pass-2026' };

// Стабильный «случайный» генератор: одни и те же данные при каждом запуске
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function readMatches(file, league) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean)
    .map(line => {
      const c = line.split(',');
      return { home: c[0], away: c[1], league, round: c[4], done: c[7] === 'true', ah: Number(c[11]), aa: Number(c[12]) };
    });
}
const epl = readMatches('matches.csv', 'EPL');
const liga = readMatches('LaLiga.csv', 'La Liga');
const ucl = readMatches('ChampionsLeague.csv', 'Champions League');
const idOf = m => makeMatchId({ home: m.home, away: m.away, league: m.league, round: m.round });
const inRound = (list, n) => list.filter(m => m.round === `Round ${n}`);

// Способы «промахнуться» или попасть, чтобы карточки были разноцветными
function guess(m, mode) {
  const { ah: h, aa: a } = m;
  switch (mode) {
    case 'exact': return [h, a];
    case 'diff': // тот же победитель и та же разница, но другой счёт (2 очка)
      if (h > a && a >= 1) return [h - 1, a - 1];
      if (a > h && h >= 1) return [h - 1, a - 1];
      return guess(m, 'outcome');
    case 'outcome': // тот же исход, другой счёт (1 очко)
      if (h > a) return [h + 1, a];
      if (a > h) return [h, a + 1];
      return [h + 1, a + 1];
    default: // 'wrong'
      if (h > a) return [0, 1];
      return [1, 0];
  }
}

const PLAYERS = [
  { uid: 'demo-alex', name: 'Alex', email: DEMO.email, skill: [0.24, 0.40] },
  { uid: 'demo-sam', name: 'Sam', email: 'sam@example.com', skill: [0.27, 0.42] },
  { uid: 'demo-jordan', name: 'Jordan', email: 'jordan@example.com', skill: [0.22, 0.45] },
  { uid: 'demo-riley', name: 'Riley', email: 'riley@example.com', skill: [0.18, 0.44] },
  { uid: 'demo-casey', name: 'Casey', email: 'casey@example.com', skill: [0.17, 0.40] },
  { uid: 'demo-morgan', name: 'Morgan', email: 'morgan@example.com', skill: [0.15, 0.42] },
  { uid: 'demo-taylor', name: 'Taylor', email: 'taylor@example.com', skill: [0.13, 0.38] },
  { uid: 'demo-jamie', name: 'Jamie', email: 'jamie@example.com', skill: [0.10, 0.40] },
  { uid: 'demo-chris', name: 'Chris', email: 'chris@example.com', skill: [0.08, 0.34] },
  { uid: 'demo-robin', name: 'Robin', email: 'robin@example.com', skill: [0.06, 0.30] },
];

async function main() {
  // аккаунты и профили
  for (const p of PLAYERS) {
    await auth.createUser({ uid: p.uid, email: p.email, password: DEMO.password, emailVerified: true, displayName: p.name });
    await db.collection('users').doc(p.uid).set({ username: p.name, email: p.email, points: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  const writes = [];
  const add = (uid, m, [home, away]) => writes.push({
    id: `${uid}_${idOf(m).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`,
    data: { userId: uid, matchId: idOf(m), homeScore: home, awayScore: away, league: m.league, points: 0, processed: false, timestamp: admin.firestore.FieldValue.serverTimestamp() },
  });

  // Алекс: туры EPL 4 и 5 — по разным сценариям, чтобы карточки были зелёными, синими и красными
  const alexModes = ['exact', 'diff', 'outcome', 'wrong', 'exact', 'outcome', 'wrong', 'diff', 'exact', 'outcome'];
  [4, 5].forEach(round => inRound(epl, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i + round) % 10]))));
  // ещё туры и турниры для длинной истории
  [1, 2, 3].forEach(round => inRound(epl, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i * 3 + round) % 10]))));
  [3, 4, 5].forEach(round => inRound(liga, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i + round) % 10]))));
  inRound(ucl, 1).slice(0, 12).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i + 4) % 10])));
  // Алекс уже сохранил прогнозы на несколько матчей будущего тура
  inRound(epl, 6).slice(0, 4).forEach((m, i) => add('demo-alex', m, [[2, 1], [1, 1], [0, 2], [3, 0]][i]));

  // остальные игроки: прогнозы на все сыгранные матчи трёх турниров
  const played = [...[1, 2, 3, 4, 5].flatMap(r => inRound(epl, r)), ...[1, 2, 3, 4, 5].flatMap(r => inRound(liga, r)), ...inRound(ucl, 1)].filter(m => m.done);
  PLAYERS.slice(1).forEach((p, pi) => {
    const random = rng(1000 + pi * 97);
    played.forEach(m => {
      const roll = random();
      const mode = roll < p.skill[0] ? 'exact' : roll < p.skill[0] + p.skill[1] ? (random() < 0.4 ? 'diff' : 'outcome') : 'wrong';
      add(p.uid, m, guess(m, mode));
    });
  });

  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(w => batch.set(db.collection('predictions').doc(w.id), w.data));
    await batch.commit();
  }
  console.log(`Создано игроков: ${PLAYERS.length}, прогнозов: ${writes.length}. Очки посчитает сервер (GET /api/check).`);
  console.log(`Демо-вход: ${DEMO.email} / ${DEMO.password}`);
  process.exit(0);
}

main().catch(error => { console.error('Ошибка:', error.message); process.exit(1); });
