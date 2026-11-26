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
const roundNo = m => Number(String(m.round).replace(/\D/g, ''));
const inRound = (list, n) => list.filter(m => roundNo(m) === n);
// Последний сыгранный тур турнира: данные берутся свежие (CSV с рабочего сервера), туры считаются от него
const lastDone = list => Math.max(...list.filter(m => m.done).map(roundNo));
const lastRounds = (list, k) => { const n = lastDone(list); return Array.from({ length: k }, (_, i) => n - i).filter(r => r >= 1); };

// Язык лиги друзей и чата на скриншотах: SEED_LANG=en (по умолчанию) или es
const LANG = process.env.SEED_LANG === 'es' ? 'es' : 'en';
const GROUP = {
  en: { name: 'Sunday League Legends', chat: [
    ['demo-sam', 'Who has the joker on the derby this week? 👀'],
    ['demo-jordan', 'Me. 2-1, no doubt'],
    ['demo-riley', 'Bold. I went 1-1'],
    ['demo-casey', 'Exact score last round, finally 🎯'],
    ['demo-sam', 'Alex is top again… how?'],
  ], mine: 'Experience 😎 Good luck this weekend!' },
  es: { name: 'Los del bar', chat: [
    ['demo-sam', '¿Quién pone el comodín en el derbi esta jornada? 👀'],
    ['demo-jordan', 'Yo. 2-1, sin dudas'],
    ['demo-riley', 'Valiente. Yo puse 1-1'],
    ['demo-casey', 'Resultado exacto la última jornada, ¡por fin! 🎯'],
    ['demo-sam', 'Álex otra vez primero… ¿cómo lo hace?'],
  ], mine: 'Experiencia 😎 ¡Suerte este finde!' },
}[LANG];

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
  { uid: 'demo-alex', name: process.env.SEED_LANG === 'es' ? 'Álex' : 'Alex', email: DEMO.email, skill: [0.24, 0.40] },
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
  const add = (uid, m, [home, away], extra = {}) => writes.push({
    id: `${uid}_${idOf(m).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`,
    data: { userId: uid, matchId: idOf(m), homeScore: home, awayScore: away, league: m.league, round: roundNo(m), joker: false, points: 0, processed: false, timestamp: admin.firestore.FieldValue.serverTimestamp(), ...extra },
  });

  const eplDone = lastRounds(epl, 6), ligaDone = lastRounds(liga, 3), uclDone = lastRounds(ucl, 2);
  // Алекс: последние туры EPL — по разным сценариям, чтобы карточки были зелёными, синими и красными
  const alexModes = ['exact', 'diff', 'outcome', 'wrong', 'exact', 'outcome', 'wrong', 'diff', 'exact', 'outcome'];
  eplDone.forEach(round => inRound(epl, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i * 3 + round) % 10]),
    // джокер в прошлом туре на точно угаданный матч
    round === eplDone[0] && i === inRound(epl, round).findIndex((_, j) => alexModes[(j * 3 + round) % 10] === 'exact') ? { joker: true } : {})));
  ligaDone.forEach(round => inRound(liga, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i + round) % 10]))));
  uclDone.forEach(round => inRound(ucl, round).forEach((m, i) => add('demo-alex', m, guess(m, alexModes[(i + 4) % 10]))));
  // Алекс уже сохранил прогнозы на несколько матчей ближайшего тура EPL, на один — джокер
  const next = lastDone(epl) + 1;
  inRound(epl, next).slice(0, 4).forEach((m, i) => add('demo-alex', m, [[2, 1], [1, 1], [0, 2], [3, 0]][i], i === 0 ? { joker: true } : {}));

  // остальные игроки: прогнозы на все сыгранные матчи этих туров и на ближайший тур
  const played = [...eplDone.flatMap(r => inRound(epl, r)), ...ligaDone.flatMap(r => inRound(liga, r)), ...uclDone.flatMap(r => inRound(ucl, r))].filter(m => m.done);
  PLAYERS.slice(1).forEach((p, pi) => {
    const random = rng(1000 + pi * 97);
    played.forEach(m => {
      const roll = random();
      const mode = roll < p.skill[0] ? 'exact' : roll < p.skill[0] + p.skill[1] ? (random() < 0.4 ? 'diff' : 'outcome') : 'wrong';
      add(p.uid, m, guess(m, mode));
    });
    inRound(epl, next).forEach(m => add(p.uid, m, [Math.floor(random() * 3), Math.floor(random() * 3)]));
  });

  // Лига друзей с чатом (Алекс — создатель)
  const code = 'SUN26K';
  const members = ['demo-alex', 'demo-sam', 'demo-jordan', 'demo-riley', 'demo-casey', 'demo-morgan', 'demo-jamie'];
  const groupRef = db.collection('groups').doc(code);
  await groupRef.set({ name: GROUP.name, code, ownerId: 'demo-alex', members, scoring: { exact: 3, diff: 2, outcome: 1 }, createdAt: new Date(Date.now() - 30 * 864e5) });
  const nameOf = uid => (uid === 'demo-alex' ? (LANG === 'es' ? 'Álex' : 'Alex') : PLAYERS.find(p => p.uid === uid).name);
  const start = Date.now() - 3 * 3600e3;
  for (const [i, [uid, text]] of [...GROUP.chat, ['demo-alex', GROUP.mine]].entries()) {
    await groupRef.collection('messages').add({ userId: uid, username: nameOf(uid), text, createdAt: new Date(start + i * 17 * 60e3) });
  }

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
