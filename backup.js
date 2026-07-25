require('dotenv').config();

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const archiver = require('archiver');

// Инициализация Firebase
const serviceAccount = require('/Users/maximyaroshenko/league_backend/serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Создаём папку для бекапов
const BACKUP_DIR = './backups';
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR);
  console.log('📁 Папка backups создана');
}

// Функция для создания бекапа
async function backupFirestore() {
  console.log('🔄 Начинаем бекап Firestore...');
  
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `backup-${timestamp}.json`);
    const zipFile = path.join(BACKUP_DIR, `backup-${timestamp}.zip`);
    
    // Список коллекций для бекапа
    const collections = ['users', 'predictions', 'logs'];
    const backupData = {};
    
    for (const collectionName of collections) {
      console.log(`📁 Бекапим коллекцию: ${collectionName}`);
      
      try {
        const snapshot = await db.collection(collectionName).get();
        backupData[collectionName] = [];
        
        snapshot.docs.forEach(doc => {
          backupData[collectionName].push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        console.log(`  ✅ ${collectionName}: ${snapshot.docs.length} документов`);
      } catch (error) {
        console.log(`  ⚠️ Ошибка бекапа коллекции ${collectionName}: ${error.message}`);
        backupData[collectionName] = [];
      }
    }
    
    // Сохраняем в JSON файл
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log(`✅ JSON бекап сохранён: ${backupFile}`);
    
    // Создаём ZIP архив
    await createZipArchive(zipFile, backupFile);
    console.log(`✅ ZIP архив создан: ${zipFile}`);
    
    // Удаляем JSON файл после создания ZIP
    fs.unlinkSync(backupFile);
    console.log(`🗑️ JSON файл удалён`);
    
    // Удаляем старые бекапы (оставляем только последние 30)
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime
      }))
      .sort((a, b) => b.time - a.time);
    
    const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;
    if (files.length > retentionDays) {
      const toDelete = files.slice(retentionDays);
      toDelete.forEach(file => {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Удалён старый бекап: ${file.name}`);
      });
    }
    
    // Логируем успешный бекап
    console.log(`✅ Бекап завершён успешно!`);
    console.log(`📊 Размер: ${(fs.statSync(zipFile).size / 1024 / 1024).toFixed(2)} MB`);
    
    return zipFile;
  } catch (error) {
    console.error('❌ Ошибка бекапа:', error.message);
    throw error;
  }
}

// Функция для создания ZIP архива
function createZipArchive(zipPath, jsonPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Максимальное сжатие
    });
    
    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));
    
    archive.pipe(output);
    archive.file(jsonPath, { name: path.basename(jsonPath) });
    archive.finalize();
  });
}

// Функция для восстановления из бекапа
async function restoreFromBackup(backupFile) {
  console.log(`🔄 Восстановление из бекапа: ${backupFile}`);
  
  try {
    let data;
    
    // Если файл ZIP, распаковываем его
    if (backupFile.endsWith('.zip')) {
      const extract = require('extract-zip');
      const tempDir = path.join(BACKUP_DIR, 'temp_restore');
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
      }
      
      await extract(backupFile, { dir: tempDir });
      const jsonFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.json'));
      
      if (jsonFiles.length === 0) {
        throw new Error('В архиве нет JSON файла');
      }
      
      data = JSON.parse(fs.readFileSync(path.join(tempDir, jsonFiles[0]), 'utf8'));
      
      // Удаляем временную папку
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      // Если файл JSON
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    }
    
    for (const [collectionName, documents] of Object.entries(data)) {
      console.log(`📁 Восстанавливаем коллекцию: ${collectionName}`);
      
      let restored = 0;
      for (const doc of documents) {
        const { id, ...docData } = doc;
        try {
          await db.collection(collectionName).doc(id).set(docData);
          restored++;
        } catch (error) {
          console.log(`  ⚠️ Ошибка восстановления документа ${id}: ${error.message}`);
        }
      }
      
      console.log(`  ✅ ${collectionName}: ${restored} документов`);
    }
    
    console.log('✅ Восстановление завершено');
  } catch (error) {
    console.error('❌ Ошибка восстановления:', error.message);
    throw error;
  }
}

// Запускаем бекап каждый день в 3:00
if (process.env.BACKUP_ENABLED === 'true') {
  cron.schedule('0 3 * * *', async () => {
    console.log('⏰ Запуск планового бекапа...');
    try {
      await backupFirestore();
    } catch (error) {
      console.error('❌ Ошибка планового бекапа:', error.message);
    }
  });
  console.log('⏰ Плановый бекап настроен на 3:00 каждый день');
}

// Если запускаем напрямую
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'restore') {
    const backupFile = process.argv[3];
    if (!backupFile) {
      console.error('❌ Укажите файл бекапа для восстановления');
      console.log('Пример: node backup.js restore backups/backup-2026-07-23T03-00-00.zip');
      process.exit(1);
    }
    restoreFromBackup(backupFile).then(() => {
      console.log('✅ Восстановление завершено');
      process.exit(0);
    }).catch((error) => {
      console.error('❌ Ошибка восстановления:', error);
      process.exit(1);
    });
  } else {
    backupFirestore().then(() => {
      console.log('✅ Бекап завершён');
      process.exit(0);
    }).catch((error) => {
      console.error('❌ Ошибка бекапа:', error);
      process.exit(1);
    });
  }
}

module.exports = { backupFirestore, restoreFromBackup };