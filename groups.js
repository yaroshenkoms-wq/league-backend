// Частные лиги друзей: создать лигу, войти по коду приглашения, рейтинг участников, выйти.
// Лиги хранятся в Firestore (коллекция groups), клиент читает их только через этот API.
// Рейтинг лиги — общие очки участников из общего рейтинга (Overall). Если лига задала свои правила очков,
// очки участников пересчитываются по ним из их обработанных прогнозов.
// Чат лиги (с фильтром брани, жалобами и удалением), прогнозы друзей на начавшийся матч.
const crypto = require('crypto');
const { DEFAULT_SCORING, validateScoring, isDefaultScoring, groupScoring, pointsByUser } = require('./scoring');
const { maskProfanity } = require('./chatFilter');

// Без похожих символов (0/O, 1/I/L), чтобы код было легко продиктовать
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 30;
const MAX_MEMBERS = 200;
const MAX_GROUPS_PER_USER = 20;
const MAX_MESSAGE_LENGTH = 500;
const MESSAGES_PAGE = 100;
const MAX_REASON_LENGTH = 200;
// В условие "in" Firestore принимает не больше 30 значений
const IN_QUERY_LIMIT = 30;
const SCORING_CACHE_MS = 30 * 1000;
const DELETE_CHUNK = 400;

function makeCode(randomInt = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// Код из сообщения: регистр, пробелы и дефисы не важны
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[\s-]/g, '');
}

function isValidCode(code) {
  return code.length === CODE_LENGTH && [...code].every(ch => CODE_ALPHABET.includes(ch));
}

// Название лиги: обрезаем пробелы и лишнее; пустое — null
function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

// Рейтинг лиги из общего рейтинга: только участники, места заново, при равных очках — одно место
function rankMembers(overall, memberIds, usernames = {}) {
  const byId = new Map(overall.map(entry => [entry.userId, entry]));
  const rows = memberIds.map(userId => ({
    userId,
    username: byId.get(userId)?.username || usernames[userId] || 'User',
    points: byId.get(userId)?.points || 0,
  }));
  rows.sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
  rows.forEach((row, i) => {
    row.rank = i > 0 && row.points === rows[i - 1].points ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

function summary(doc, uid) {
  const data = doc.data();
  return {
    id: doc.id,
    name: data.name,
    code: data.code,
    members: (data.members || []).length,
    isOwner: data.ownerId === uid,
    scoring: groupScoring(data),
  };
}

function registerGroupRoutes(app, { getDb, requireAuth, limiter, chatLimiter, getOverallLeaderboard, findMatch, hasStarted, log }) {
  const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

  // Создавать и вступать может только игрок с подтверждённой почтой (как и прогнозы)
  function requireVerified(req, res, next) {
    if (!req.user.email_verified) return fail(res, 403, 'email_not_verified', 'Подтвердите почту');
    next();
  }

  // Группа, в которой состоит пользователь; иначе отвечает 404 и возвращает null
  async function memberGroup(req, res) {
    const doc = await getDb().collection('groups').doc(normalizeCode(req.params.id)).get();
    if (!doc.exists || !(doc.data().members || []).includes(req.user.uid)) {
      fail(res, 404, 'not_found', 'Лига не найдена');
      return null;
    }
    return doc;
  }

  // Общий рейтинг с очками, пересчитанными по правилам лиги (кеш на 30 с: читает все обработанные прогнозы участников)
  const rescoreCache = new Map();
  async function rescoredTable(groupId, members, rules, overall) {
    const key = `${groupId}|${JSON.stringify(rules)}|${members.join(',')}`;
    const cached = rescoreCache.get(groupId);
    let totals = cached && cached.key === key && cached.expires > Date.now() ? cached.totals : null;
    if (!totals) {
      const predictions = [];
      for (let i = 0; i < members.length; i += IN_QUERY_LIMIT) {
        const snapshot = await getDb().collection('predictions')
          .where('userId', 'in', members.slice(i, i + IN_QUERY_LIMIT))
          .where('processed', '==', true)
          .get();
        snapshot.docs.forEach(doc => predictions.push(doc.data()));
      }
      totals = pointsByUser(predictions, rules);
      rescoreCache.set(groupId, { key, totals, expires: Date.now() + SCORING_CACHE_MS });
    }
    return overall.map(entry => ({ ...entry, points: totals[entry.userId] || 0 }));
  }

  async function myGroupCount(db, uid) {
    const snapshot = await db.collection('groups').where('members', 'array-contains', uid).count().get();
    return snapshot.data().count;
  }

  app.get('/api/groups', limiter, requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const snapshot = await db.collection('groups').where('members', 'array-contains', req.user.uid).get();
      const groups = snapshot.docs.map(doc => summary(doc, req.user.uid));
      groups.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ success: true, groups });
    } catch (e) {
      log('ERROR', `Ошибка списка лиг: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось загрузить лиги');
    }
  });

  app.post('/api/groups', limiter, requireAuth, requireVerified, async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, 'invalid_name', 'Введите название');
    let scoring = { ...DEFAULT_SCORING };
    if (req.body?.scoring !== undefined && req.body?.scoring !== null) {
      scoring = validateScoring(req.body.scoring);
      if (!scoring) return fail(res, 400, 'invalid_scoring', 'Неверные правила очков');
    }
    try {
      const db = getDb();
      if (await myGroupCount(db, req.user.uid) >= MAX_GROUPS_PER_USER) {
        return fail(res, 400, 'too_many_groups', 'Слишком много лиг');
      }
      // Код уникален: при совпадении пробуем другой
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeCode();
        const ref = db.collection('groups').doc(code);
        const created = await db.runTransaction(async tx => {
          if ((await tx.get(ref)).exists) return false;
          tx.set(ref, {
            name,
            code,
            ownerId: req.user.uid,
            members: [req.user.uid],
            scoring,
            createdAt: new Date(),
          });
          return true;
        });
        if (created) {
          return res.json({ success: true, group: { id: code, name, code, members: 1, isOwner: true, scoring } });
        }
      }
      fail(res, 500, 'server_error', 'Не удалось создать лигу');
    } catch (e) {
      log('ERROR', `Ошибка создания лиги: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось создать лигу');
    }
  });

  app.post('/api/groups/join', limiter, requireAuth, requireVerified, async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!isValidCode(code)) return fail(res, 400, 'invalid_code', 'Неверный код');
    try {
      const db = getDb();
      if (await myGroupCount(db, req.user.uid) >= MAX_GROUPS_PER_USER) {
        return fail(res, 400, 'too_many_groups', 'Слишком много лиг');
      }
      const ref = db.collection('groups').doc(code);
      const result = await db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) return { error: ['not_found', 404] };
        const members = doc.data().members || [];
        if (!members.includes(req.user.uid)) {
          if (members.length >= MAX_MEMBERS) return { error: ['group_full', 400] };
          tx.update(ref, { members: [...members, req.user.uid] });
        }
        return { group: { ...summary(doc, req.user.uid), members: members.length + (members.includes(req.user.uid) ? 0 : 1) } };
      });
      if (result.error) return fail(res, result.error[1], result.error[0], 'Не удалось вступить');
      res.json({ success: true, group: result.group });
    } catch (e) {
      log('ERROR', `Ошибка вступления в лигу: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось вступить');
    }
  });

  app.get('/api/groups/:id/leaderboard', limiter, requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const doc = await db.collection('groups').doc(normalizeCode(req.params.id)).get();
      if (!doc.exists || !(doc.data().members || []).includes(req.user.uid)) {
        return fail(res, 404, 'not_found', 'Лига не найдена');
      }
      const overall = await getOverallLeaderboard();
      const members = doc.data().members || [];
      const rules = groupScoring(doc.data());
      // Правила по умолчанию: очки те же, что в общем рейтинге. Свои правила: пересчёт по прогнозам участников
      const table = isDefaultScoring(rules) ? overall : await rescoredTable(doc.id, members, rules, overall);
      res.json({
        success: true,
        group: summary(doc, req.user.uid),
        leaderboard: rankMembers(table, members),
      });
    } catch (e) {
      log('ERROR', `Ошибка рейтинга лиги: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось загрузить рейтинг');
    }
  });

  // Изменить правила очков может только владелец
  app.put('/api/groups/:id/scoring', limiter, requireAuth, async (req, res) => {
    try {
      const scoring = validateScoring(req.body?.scoring ?? req.body);
      if (!scoring) return fail(res, 400, 'invalid_scoring', 'Неверные правила очков');
      const doc = await memberGroup(req, res);
      if (!doc) return;
      if (doc.data().ownerId !== req.user.uid) return fail(res, 403, 'forbidden', 'Только владелец лиги');
      await doc.ref.update({ scoring });
      log('USER_ACTION', `[${req.user.uid}] Правила очков лиги ${doc.id}: ${JSON.stringify(scoring)}`);
      res.json({ success: true, scoring });
    } catch (e) {
      log('ERROR', `Ошибка правил лиги: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось сохранить правила');
    }
  });

  // Прогнозы участников на матч: до начала — только сколько человек уже прогнозировали, после — сами прогнозы
  app.get('/api/groups/:id/match/:matchId', limiter, requireAuth, async (req, res) => {
    try {
      const doc = await memberGroup(req, res);
      if (!doc) return;
      const found = findMatch(req.params.matchId);
      if (!found) return fail(res, 404, 'unknown_match', 'Матч не найден');

      const db = getDb();
      const members = doc.data().members || [];
      const docs = [];
      for (let i = 0; i < members.length; i += IN_QUERY_LIMIT) {
        const snapshot = await db.collection('predictions')
          .where('matchId', '==', req.params.matchId)
          .where('userId', 'in', members.slice(i, i + IN_QUERY_LIMIT))
          .get();
        docs.push(...snapshot.docs);
      }

      if (!hasStarted(found.match)) {
        return res.json({ success: true, started: false, predicted: docs.length });
      }

      const users = docs.length > 0
        ? await db.getAll(...docs.map(d => db.collection('users').doc(d.data().userId)))
        : [];
      const names = Object.fromEntries(users.map(u => [u.id, u.exists ? u.data().username : null]));
      const predictions = docs.map(d => {
        const p = d.data();
        return {
          userId: p.userId,
          username: names[p.userId] || 'User',
          homeScore: p.homeScore,
          awayScore: p.awayScore,
          joker: p.joker === true,
          points: p.points || 0,
          processed: p.processed === true,
        };
      }).sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
      res.json({ success: true, started: true, predictions });
    } catch (e) {
      log('ERROR', `Ошибка прогнозов друзей: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось загрузить прогнозы');
    }
  });

  // ============ ЧАТ ЛИГИ ============

  app.get('/api/groups/:id/messages', limiter, requireAuth, async (req, res) => {
    try {
      const doc = await memberGroup(req, res);
      if (!doc) return;
      let query = doc.ref.collection('messages');
      const after = Number(req.query.after);
      if (req.query.after !== undefined && Number.isFinite(after) && after > 0) {
        query = query.where('createdAt', '>', new Date(after));
      }
      const snapshot = await query.orderBy('createdAt', 'desc').limit(MESSAGES_PAGE).get();
      res.json({ success: true, messages: snapshot.docs.map(messageView).reverse() });
    } catch (e) {
      log('ERROR', `Ошибка чтения чата: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось загрузить чат');
    }
  });

  app.post('/api/groups/:id/messages', requireAuth, chatLimiter, requireVerified, async (req, res) => {
    try {
      const text = cleanMessage(req.body?.text);
      if (!text) return fail(res, 400, 'invalid_message', `Сообщение: от 1 до ${MAX_MESSAGE_LENGTH} символов`);
      const doc = await memberGroup(req, res);
      if (!doc) return;

      const db = getDb();
      const userDoc = await db.collection('users').doc(req.user.uid).get();
      const username = (userDoc.exists && userDoc.data().username) || 'User';
      const ref = doc.ref.collection('messages').doc();
      await ref.set({ userId: req.user.uid, username, text: maskProfanity(text), createdAt: new Date() });
      res.json({ success: true, message: messageView(await ref.get()) });
    } catch (e) {
      log('ERROR', `Ошибка отправки сообщения: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось отправить сообщение');
    }
  });

  // Удалить может автор или владелец лиги
  app.delete('/api/groups/:id/messages/:msgId', limiter, requireAuth, async (req, res) => {
    try {
      const doc = await memberGroup(req, res);
      if (!doc) return;
      const ref = doc.ref.collection('messages').doc(req.params.msgId);
      const message = await ref.get();
      if (!message.exists) return fail(res, 404, 'not_found', 'Сообщение не найдено');
      if (message.data().userId !== req.user.uid && doc.data().ownerId !== req.user.uid) {
        return fail(res, 403, 'forbidden', 'Нельзя удалить чужое сообщение');
      }
      await ref.delete();
      res.json({ success: true });
    } catch (e) {
      log('ERROR', `Ошибка удаления сообщения: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось удалить сообщение');
    }
  });

  // Жалоба на сообщение: ложится в коллекцию reports (разбирает владелец сервиса). Одна жалоба от одного игрока на сообщение
  app.post('/api/groups/:id/messages/:msgId/report', limiter, requireAuth, async (req, res) => {
    try {
      const doc = await memberGroup(req, res);
      if (!doc) return;
      const message = await doc.ref.collection('messages').doc(req.params.msgId).get();
      if (!message.exists) return fail(res, 404, 'not_found', 'Сообщение не найдено');

      const reason = String(req.body?.reason || '').trim().slice(0, MAX_REASON_LENGTH) || 'other';
      const data = message.data();
      await getDb().collection('reports').doc(`${doc.id}_${message.id}_${req.user.uid}`).set({
        groupId: doc.id,
        messageId: message.id,
        text: data.text,
        authorId: data.userId,
        reporterId: req.user.uid,
        reason,
        createdAt: new Date(),
      });
      log('WARN', `🚩 Жалоба на сообщение ${message.id} в лиге ${doc.id}: автор ${data.userId}, жалуется ${req.user.uid}, причина: ${reason}`);
      res.json({ success: true });
    } catch (e) {
      log('ERROR', `Ошибка жалобы: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось отправить жалобу');
    }
  });

  app.post('/api/groups/:id/leave', limiter, requireAuth, async (req, res) => {
    try {
      const db = getDb();
      await leaveGroup(db, normalizeCode(req.params.id), req.user.uid);
      res.json({ success: true });
    } catch (e) {
      log('ERROR', `Ошибка выхода из лиги: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось выйти из лиги');
    }
  });
}

// Выход из лиги. Последний участник уходит — лига удаляется; уходит владелец — владельцем становится следующий
async function leaveGroup(db, groupId, uid) {
  const ref = db.collection('groups').doc(groupId);
  const removed = await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) return false;
    const data = doc.data();
    const members = (data.members || []).filter(id => id !== uid);
    if (members.length === 0) {
      tx.delete(ref);
      return true;
    }
    tx.update(ref, { members, ownerId: data.ownerId === uid ? members[0] : data.ownerId });
    return false;
  });
  // Лига удалена — вместе с ней сообщения чата (подколлекция сама не удаляется)
  if (removed) await db.recursiveDelete(ref);
}

// Удаляет сообщения пользователя во всех его лигах (при удалении аккаунта)
async function deleteUserMessages(db, uid) {
  const groups = await db.collection('groups').where('members', 'array-contains', uid).get();
  let deleted = 0;
  for (const group of groups.docs) {
    for (;;) {
      const snapshot = await group.ref.collection('messages').where('userId', '==', uid).limit(DELETE_CHUNK).get();
      if (snapshot.empty) break;
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      deleted += snapshot.size;
      if (snapshot.size < DELETE_CHUNK) break;
    }
  }
  return deleted;
}

// При удалении аккаунта — выйти из всех лиг
async function leaveAllGroups(db, uid) {
  await deleteUserMessages(db, uid);
  const snapshot = await db.collection('groups').where('members', 'array-contains', uid).get();
  for (const doc of snapshot.docs) await leaveGroup(db, doc.id, uid);
  return snapshot.size;
}

// Сообщение для клиента
function messageView(doc) {
  const data = doc.data();
  const created = data.createdAt;
  return {
    id: doc.id,
    userId: data.userId,
    username: data.username,
    text: data.text,
    createdAt: created && created.toMillis ? created.toMillis() : Number(created) || 0,
  };
}

// Текст сообщения: обрезаем пробелы, 1..500 символов; иначе null
function cleanMessage(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const length = [...text].length;
  return length >= 1 && length <= MAX_MESSAGE_LENGTH ? text : null;
}

module.exports = {
  registerGroupRoutes,
  deleteUserMessages,
  cleanMessage,
  MAX_MESSAGE_LENGTH,
  leaveAllGroups,
  makeCode,
  normalizeCode,
  isValidCode,
  cleanName,
  rankMembers,
  CODE_LENGTH,
};
