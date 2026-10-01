// Резервная копия и восстановление базы Firestore (пользователи и прогнозы).
//
//   node backup.js                       — сделать копию в backups/
//   node backup.js list                  — показать имеющиеся копии
//   node backup.js restore <файл>        — показать, что будет восстановлено (ничего не пишет)
//   node backup.js restore <файл> --yes  — восстановить (документы перезаписываются, лишние не удаляются)
//
// Ключ Firebase берётся из переменной SERVICE_ACCOUNT или из файла serviceAccountKey.json рядом со скриптом.
// Копия — один файл backup-<дата>.json.gz; после записи он перечитывается и сверяется с базой по числу документов.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const admin = require('firebase-admin');

const COLLECTIONS = ['users', 'predictions'];
const BACKUP_DIR = path.join(__dirname, 'backups');
const FORMAT_VERSION = 1;
const WRITE_BATCH_SIZE = 400;

// ============ ЗНАЧЕНИЯ FIRESTORE <-> JSON ============

// Время и ссылки нельзя просто записать в JSON: при восстановлении они превратились бы в обычные объекты
function encode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'reference', path: value.path };
  }
  if (Array.isArray(value)) return value.map(encode);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Неизвестный тип значения в базе: ${value.constructor && value.constructor.name}`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
}

function decode(value, db) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => decode(item, db));

  switch (value.__type) {
    case 'timestamp': return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
    case 'geopoint': return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    case 'reference': return db.doc(value.path);
    default:
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, db)]));
  }
}

// ============ КОПИЯ ============

function listBackups(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /^backup-.*\.json\.gz$/.test(name))
    .map(name => ({ name, path: path.join(dir, name), size: fs.statSync(path.join(dir, name)).size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function readBackupFile(file) {
  const raw = fs.readFileSync(file);
  // Формат определяем по содержимому (gzip начинается с байтов 1f 8b), а не по расширению
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const payload = JSON.parse(text);
  if (payload.version !== FORMAT_VERSION || typeof payload.collections !== 'object') {
    throw new Error('Файл не похож на копию, сделанную этим скриптом');
  }
  return payload;
}

async function backupFirestore({ db, dir = BACKUP_DIR, now = new Date(), keep = 30 }) {
  const collections = {};
  for (const name of COLLECTIONS) {
    const snapshot = await db.collection(name).get();
    collections[name] = snapshot.docs.map(doc => ({ id: doc.id, data: encode(doc.data()) }));
  }
  const counts = Object.fromEntries(Object.entries(collections).map(([name, docs]) => [name, docs.length]));

  const payload = { version: FORMAT_VERSION, createdAt: now.toISOString(), counts, collections };
  fs.mkdirSync(dir, { recursive: true });

  // Пишем во временный файл и переименовываем только после проверки: битая копия не займёт место настоящей
  const fileName = `backup-${now.toISOString().replace(/[:.]/g, '-')}.json.gz`;
  const finalPath = path.join(dir, fileName);
  const tempPath = `${finalPath}.partial`;
  fs.writeFileSync(tempPath, zlib.gzipSync(JSON.stringify(payload)), { mode: 0o600 });

  try {
    const check = readBackupFile(tempPath);
    for (const name of COLLECTIONS) {
      if (check.collections[name].length !== counts[name]) {
        throw new Error(`после записи в ${name} ${check.collections[name].length} документов вместо ${counts[name]}`);
      }
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Копия не прошла проверку: ${error.message}`);
  }
  fs.renameSync(tempPath, finalPath);

  // Старые копии удаляем, оставляя последние keep штук
  for (const old of listBackups(dir).slice(keep)) {
    fs.rmSync(old.path, { force: true });
  }

  return { file: finalPath, counts, bytes: fs.statSync(finalPath).size };
}

// ============ ВОССТАНОВЛЕНИЕ ============

// apply: false — только показать, что лежит в копии
async function restoreFromBackup({ db, file, apply = false }) {
  const payload = readBackupFile(file);
  const counts = Object.fromEntries(Object.entries(payload.collections).map(([name, docs]) => [name, docs.length]));
  if (!apply) return { counts, createdAt: payload.createdAt, restored: false };

  for (const [name, docs] of Object.entries(payload.collections)) {
    for (let i = 0; i < docs.length; i += WRITE_BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.set(db.collection(name).doc(doc.id), decode(doc.data, db));
      }
      await batch.commit();
    }
  }
  return { counts, createdAt: payload.createdAt, restored: true };
}

// ============ ЗАПУСК ИЗ КОМАНДНОЙ СТРОКИ ============

function initDb() {
  let serviceAccount;
  if (process.env.SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
  } else {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyPath)) {
      throw new Error('Не найден ключ Firebase: положите serviceAccountKey.json рядом со скриптом или задайте SERVICE_ACCOUNT');
    }
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

function friendlyError(error) {
  if (error.code === 8) {
    return 'Суточная бесплатная квота Firestore исчерпана. Она сбрасывается в 07:00 UTC, попробуйте после этого времени.';
  }
  return error.message;
}

const formatSize = bytes => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} КБ` : `${(bytes / 1024 / 1024).toFixed(2)} МБ`);

async function main() {
  const [command, fileArg] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const confirmed = process.argv.includes('--yes');

  if (command === 'list') {
    const backups = listBackups();
    if (backups.length === 0) console.log('Копий пока нет.');
    backups.forEach(b => console.log(`${b.name}  ${formatSize(b.size)}`));
    return;
  }

  const db = initDb();

  if (command === 'restore') {
    if (!fileArg) throw new Error('Укажите файл копии: node backup.js restore backups/backup-....json.gz');
    const file = path.resolve(fileArg);
    const result = await restoreFromBackup({ db, file, apply: confirmed });
    const summary = Object.entries(result.counts).map(([name, n]) => `${name}: ${n}`).join(', ');
    if (!result.restored) {
      console.log(`В копии от ${result.createdAt}: ${summary}.`);
      console.log('Ничего не записано. Чтобы восстановить, добавьте --yes (документы с теми же ID будут перезаписаны).');
    } else {
      console.log(`Восстановлено из копии от ${result.createdAt}: ${summary}.`);
    }
    return;
  }

  const keep = parseInt(process.env.BACKUP_KEEP, 10) || 30;
  const result = await backupFirestore({ db, keep });
  const summary = Object.entries(result.counts).map(([name, n]) => `${name}: ${n}`).join(', ');
  console.log(`Копия сохранена и проверена: ${result.file}`);
  console.log(`Документов — ${summary}; размер ${formatSize(result.bytes)}.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error(`Ошибка: ${friendlyError(error)}`);
    process.exit(1);
  });
}

module.exports = { backupFirestore, restoreFromBackup, listBackups, encode, decode };
