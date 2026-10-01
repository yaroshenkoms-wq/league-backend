// Пересчёт очков вручную: показывает, что изменится, и записывает только после подтверждения.
//
//   node recalculate.js
//
// Запускает сервер на временном порту (без плановых задач) с временным ключом админа и обращается к нему,
// поэтому используется тот же код и те же проверки, что на хостинге. Ключ Firebase берётся из
// serviceAccountKey.json или из SERVICE_ACCOUNT.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const print = console.log.bind(console);

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

function describe(report) {
  print(`Проверено прогнозов: ${report.predictions.checked}, профилей: ${report.users.checked}.`);
  print(`К исправлению: прогнозов — ${report.predictions.toFix}, профилей — ${report.users.toFix}.`);

  for (const item of report.predictions.samples.slice(0, 10)) {
    print(`  прогноз ${item.id}: очки ${item.before === null ? 'не были начислены' : item.before} → ${item.after}`);
  }
  for (const item of report.users.samples.slice(0, 10)) {
    print(item.before === item.after
      ? `  профиль ${item.id}: очки остаются ${item.after}, добавится разбивка по лигам`
      : `  профиль ${item.id}: очки ${item.before} → ${item.after}`);
  }
  if (report.predictionsWithoutProfile > 0) {
    print(`  Внимание: прогнозы есть у ${report.predictionsWithoutProfile} пользователей без профиля (они не меняются).`);
  }
}

async function main() {
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  if (!process.env.SERVICE_ACCOUNT) {
    if (!fs.existsSync(keyPath)) throw new Error('Не найден ключ Firebase (serviceAccountKey.json)');
    process.env.SERVICE_ACCOUNT = fs.readFileSync(keyPath, 'utf8');
  }

  const port = await freePort();
  const adminKey = crypto.randomBytes(16).toString('hex'); // временный, живёт только в этом запуске
  Object.assign(process.env, {
    PORT: String(port),
    ADMIN_KEY: adminKey,
    SYNC_ENABLED: 'false',
    BACKGROUND_JOBS: 'false',
  });

  // Сервер шумный: его сообщения скрываем, показываем только ответы этого скрипта
  console.log = () => {};
  require('./server.js');

  const base = `http://127.0.0.1:${port}/api`;
  const call = async endpoint => {
    const response = await fetch(base + endpoint, { headers: { 'x-admin-key': adminKey } });
    const body = await response.json();
    if (!body.success) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  for (let attempt = 0; ; attempt++) {
    try { await fetch(`${base}/health`); break; } catch (e) {
      if (attempt > 40) throw new Error('Сервер не запустился');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  const report = await call('/recalculate');
  describe(report);

  if (report.predictions.toFix === 0 && report.users.toFix === 0 && report.leagueTotalsReady) {
    print('\nВсё уже в порядке, менять нечего.');
    return;
  }

  const answer = await ask('\nЗаписать эти изменения в базу? Напишите yes и нажмите Enter (иначе ничего не запишется): ');
  if (answer !== 'yes') {
    print('Отменено, в базу ничего не записано.');
    return;
  }

  const done = await call('/recalculate?apply=1');
  print(done.applied
    ? `Готово: исправлено прогнозов — ${done.predictions.toFix}, профилей — ${done.users.toFix}.`
    : 'Запись не выполнена.');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    print(`Ошибка: ${error.code === 8 ? 'суточная квота Firestore исчерпана (сброс в 07:00 UTC)' : error.message}`);
    process.exit(1);
  });
