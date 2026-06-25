const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'ecosystem.db');
const db = new sqlite3.Database(dbPath);

db.run('ALTER TABLE ad_requests ADD COLUMN started_at TEXT', (err) => {
  if (err && err.message.includes('duplicate column name')) {
    console.log('✅ Колонка started_at уже существует');
  } else if (err) {
    console.error('❌ Ошибка:', err.message);
  } else {
    console.log('✅ Колонка started_at добавлена');
  }
  db.close();
});