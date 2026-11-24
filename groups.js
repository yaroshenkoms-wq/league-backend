// Частные лиги друзей: создать лигу, войти по коду приглашения, рейтинг участников, выйти.
// Лиги хранятся в Firestore (коллекция groups), клиент читает их только через этот API.
// Рейтинг лиги — общие очки участников из общего рейтинга (Overall), отдельно ничего не считается.
const crypto = require('crypto');

// Без похожих символов (0/O, 1/I/L), чтобы код было легко продиктовать
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 30;
const MAX_MEMBERS = 200;
const MAX_GROUPS_PER_USER = 20;

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
  };
}

function registerGroupRoutes(app, { getDb, requireAuth, limiter, getOverallLeaderboard, log }) {
  const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

  // Создавать и вступать может только игрок с подтверждённой почтой (как и прогнозы)
  function requireVerified(req, res, next) {
    if (!req.user.email_verified) return fail(res, 403, 'email_not_verified', 'Подтвердите почту');
    next();
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
            createdAt: new Date(),
          });
          return true;
        });
        if (created) {
          return res.json({ success: true, group: { id: code, name, code, members: 1, isOwner: true } });
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
      res.json({
        success: true,
        group: summary(doc, req.user.uid),
        leaderboard: rankMembers(overall, doc.data().members || []),
      });
    } catch (e) {
      log('ERROR', `Ошибка рейтинга лиги: ${e.message}`);
      fail(res, 500, 'server_error', 'Не удалось загрузить рейтинг');
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
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const data = doc.data();
    const members = (data.members || []).filter(id => id !== uid);
    if (members.length === 0) {
      tx.delete(ref);
    } else {
      tx.update(ref, { members, ownerId: data.ownerId === uid ? members[0] : data.ownerId });
    }
  });
}

// При удалении аккаунта — выйти из всех лиг
async function leaveAllGroups(db, uid) {
  const snapshot = await db.collection('groups').where('members', 'array-contains', uid).get();
  for (const doc of snapshot.docs) await leaveGroup(db, doc.id, uid);
  return snapshot.size;
}

module.exports = {
  registerGroupRoutes,
  leaveAllGroups,
  makeCode,
  normalizeCode,
  isValidCode,
  cleanName,
  rankMembers,
  CODE_LENGTH,
};
