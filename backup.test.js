const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { backupFirestore, restoreFromBackup, listBackups, encode, decode } = require('./backup');

const { Timestamp, GeoPoint } = admin.firestore;

// Минимальная замена Firestore в памяти
function fakeDb(initial = {}) {
  const data = new Map(Object.entries(initial).map(([name, docs]) => [name, new Map(Object.entries(docs))]));
  const collection = name => {
    if (!data.has(name)) data.set(name, new Map());
    return {
      get: async () => ({ docs: [...data.get(name)].map(([id, value]) => ({ id, data: () => value })) }),
      doc: id => ({ collection: name, id, path: `${name}/${id}` }),
    };
  };
  return {
    data,
    collection,
    doc: p => ({ path: p }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, value) => ops.push([ref, value]),
        commit: async () => { ops.forEach(([ref, value]) => { collection(ref.collection); data.get(ref.collection).set(ref.id, value); }); },
      };
    },
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));

const sample = () => ({
  users: {
    u1: { username: 'Alice', points: 13, createdAt: new Timestamp(1790000000, 123000000) },
    u2: { username: 'Bob', points: 0, createdAt: new Timestamp(1790000100, 0) },
  },
  predictions: {
    p1: { userId: 'u1', matchId: 'Arsenal_Coventry City', homeScore: 3, awayScore: 0, processed: true, processedAt: new Timestamp(1790000200, 5), tags: ['a', { at: new Timestamp(1, 2) }] },
  },
});

test('время, координаты и вложенные значения переживают запись в JSON', () => {
  const original = { t: new Timestamp(123, 456), g: new GeoPoint(1.5, 2.5), list: [1, { deep: new Timestamp(7, 8) }], n: null, s: 'x' };
  const restored = decode(JSON.parse(JSON.stringify(encode(original))), fakeDb());
  assert.ok(restored.t instanceof Timestamp && restored.t.seconds === 123 && restored.t.nanoseconds === 456);
  assert.ok(restored.g instanceof GeoPoint && restored.g.latitude === 1.5);
  assert.ok(restored.list[1].deep instanceof Timestamp);
  assert.strictEqual(restored.n, null);
});

test('неизвестный тип значения не теряется молча', () => {
  class Strange { constructor() { this.x = 1; } }
  assert.throws(() => encode({ value: new Strange() }), /Неизвестный тип/);
});

test('копия создаётся, проверяется и восстанавливается без потерь', async () => {
  const dir = tempDir();
  try {
    const result = await backupFirestore({ db: fakeDb(sample()), dir, now: new Date('2026-09-21T08:00:00Z') });
    assert.deepStrictEqual(result.counts, { users: 2, predictions: 1 });
    assert.ok(fs.existsSync(result.file) && result.file.endsWith('.json.gz'));
    assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.partial')), []);

    // только просмотр: ничего не пишет
    const target = fakeDb();
    const preview = await restoreFromBackup({ db: target, file: result.file });
    assert.strictEqual(preview.restored, false);
    assert.strictEqual(target.data.size, 0);

    // восстановление в пустую базу
    await restoreFromBackup({ db: target, file: result.file, apply: true });
    const alice = target.data.get('users').get('u1');
    assert.strictEqual(alice.username, 'Alice');
    assert.ok(alice.createdAt instanceof Timestamp && alice.createdAt.nanoseconds === 123000000);
    const prediction = target.data.get('predictions').get('p1');
    assert.ok(prediction.processedAt instanceof Timestamp && prediction.tags[1].at instanceof Timestamp);
    assert.strictEqual(target.data.get('users').size, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('хранятся только последние keep копий', async () => {
  const dir = tempDir();
  try {
    for (const day of ['18', '19', '20', '21']) {
      await backupFirestore({ db: fakeDb(sample()), dir, now: new Date(`2026-09-${day}T08:00:00Z`), keep: 2 });
    }
    const names = listBackups(dir).map(b => b.name);
    assert.strictEqual(names.length, 2);
    assert.ok(names[0].includes('2026-09-21') && names[1].includes('2026-09-20'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ошибка чтения базы не оставляет файлов', async () => {
  const dir = tempDir();
  try {
    const broken = { collection: () => ({ get: async () => { throw Object.assign(new Error('quota'), { code: 8 }); } }) };
    await assert.rejects(() => backupFirestore({ db: broken, dir }), /quota/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('чужой файл не принимается за копию', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'other.json');
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    await assert.rejects(() => restoreFromBackup({ db: fakeDb(), file }), /не похож на копию/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
