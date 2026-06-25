const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fileUpload = require('express-fileupload');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: 5 * 1024 * 1024 }, abortOnLimit: true }));

// ===== ФУНКЦИИ ДЛЯ УВЕДОМЛЕНИЙ =====
app.locals.getNotificationType = function(subject) {
  if (!subject) return 'system';
  if (subject.includes('Сезон') || subject.includes('сезон')) return 'season';
  if (subject.includes('Баланс') || subject.includes('начисление') || subject.includes('токен')) return 'balance';
  return 'system';
};
app.locals.getNotificationIcon = function(subject) {
  if (!subject) return '📩';
  if (subject.includes('Сезон') || subject.includes('сезон')) return '📅';
  if (subject.includes('Баланс') || subject.includes('начисление') || subject.includes('токен')) return '💰';
  return '📩';
};

app.use(session({
  secret: 'super-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// ===== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ КАПЧИ =====
let registerCaptcha = { answer: 0, text: '' };
let loginCaptcha = { answer: 0, text: '' };

function generateCaptcha() {
  const operators = ['+', '-', '*', '/'];
  let num1, num2, op, answer;
  let attempts = 0;
  do {
    num1 = Math.floor(Math.random() * 10) + 1;
    num2 = Math.floor(Math.random() * 10) + 1;
    op = operators[Math.floor(Math.random() * operators.length)];
    if (op === '+') answer = num1 + num2;
    else if (op === '-') {
      if (num1 < num2) [num1, num2] = [num2, num1];
      answer = num1 - num2;
    } else if (op === '*') {
      if (num1 * num2 > 100) {
        num1 = Math.floor(Math.random() * 10) + 1;
        num2 = Math.floor(Math.random() * 10) + 1;
        while (num1 * num2 > 100) {
          num1 = Math.floor(Math.random() * 10) + 1;
          num2 = Math.floor(Math.random() * 10) + 1;
        }
      }
      answer = num1 * num2;
    } else if (op === '/') {
      if (num2 === 0) num2 = 1;
      const product = num1 * num2;
      num1 = product;
      if (num1 > 100) {
        num1 = num2 * (Math.floor(Math.random() * 10) + 1);
        if (num1 > 100) num1 = num2 * (Math.floor(100 / num2));
      }
      answer = num1 / num2;
    }
    attempts++;
  } while (attempts < 10 && (answer === undefined || answer > 100 || answer < 0 || !Number.isInteger(answer)));
  if (answer === undefined || answer > 100 || answer < 0 || !Number.isInteger(answer)) {
    num1 = Math.floor(Math.random() * 10) + 1;
    num2 = Math.floor(Math.random() * 10) + 1;
    op = '+';
    answer = num1 + num2;
  }
  return { answer, text: `${num1} ${op} ${num2} = ?` };
}

const db = new sqlite3.Database(path.join(__dirname, 'database', 'ecosystem.db'));

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ===== MIDDLEWARE ДЛЯ ОНЛАЙН-СТАТУСА =====
app.use(async (req, res, next) => {
  if (req.session.user && req.path !== '/api/unread-count' && !req.path.startsWith('/api') && !req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/images')) {
    try {
      await dbRun('UPDATE users SET last_seen = datetime("now") WHERE id = ?', [req.session.user.id]);
    } catch (e) {}
  }
  next();
});

// ===== ФУНКЦИЯ ОБРАБОТКИ ОЧЕРЕДЕЙ ПО РАЗДЕЛАМ =====
async function processAdQueues() {
  try {
    const sections = ['main', 'about', 'games', 'dashboard', 'notifications', 'ad-queue'];
    for (const section of sections) {
      const nextAd = await dbGet(`
        SELECT * FROM ad_requests 
        WHERE status = 'active' 
          AND section = ? 
          AND started_at IS NULL 
        ORDER BY queue_position ASC 
        LIMIT 1
      `, [section]);
      if (nextAd) {
        await dbRun('UPDATE ad_requests SET started_at = datetime("now") WHERE id = ?', [nextAd.id]);
        console.log(`▶️ Запущен показ баннера "${nextAd.project_name}" (раздел: ${section})`);
      }
    }
  } catch (err) {
    console.error('Ошибка при обработке очередей:', err.message);
  }
}

// ===== ФУНКЦИЯ ПРОВЕРКИ ИСТЕКШИХ БАННЕРОВ =====
async function checkExpiredAds() {
  try {
    const expired = await dbAll(`
      SELECT * FROM ad_requests 
      WHERE status = 'active' 
        AND started_at IS NOT NULL
        AND datetime('now') > datetime(started_at, '+' || duration_days || ' days')
    `);
    for (const ad of expired) {
      await dbRun('UPDATE ad_requests SET status = "completed" WHERE id = ?', [ad.id]);
      await sendNotification(
        ad.user_id,
        '✅ Реклама завершена',
        `Ваша реклама "${ad.project_name}" завершена после ${ad.duration_days} дней показа.`
      );
      console.log(`📢 Баннер "${ad.project_name}" (ID ${ad.id}) истёк и помечен как завершённый.`);
    }
  } catch (err) {
    console.error('Ошибка при проверке истекших баннеров:', err.message);
  }
}

// ===== MIDDLEWARE ДЛЯ ОБРАБОТКИ ОЧЕРЕДЕЙ И ПРОВЕРКИ ИСТЕКШИХ =====
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/images')) {
    await processAdQueues();
    await checkExpiredAds();
  }
  next();
});

io.on('connection', (socket) => {
  console.log('🔌 Новое подключение:', socket.id);
  socket.on('ping', async (userId) => {
    if (userId) {
      try {
        await dbRun('UPDATE users SET last_seen = datetime("now") WHERE id = ?', [userId]);
      } catch (e) {}
    }
  });
  socket.on('disconnect', () => {
    console.log('🔌 Отключение:', socket.id);
  });
});

async function sendNotification(userId, subject, body) {
  const result = await dbRun(
    `INSERT INTO notifications (user_id, subject, body, is_read, created_at)
     VALUES (?, ?, ?, 0, datetime('now'))`,
    [userId, subject, body]
  );
  io.emit(`notification_${userId}`, { id: result.lastID, subject, body, created_at: new Date().toISOString() });
  const count = await getUnreadCount(userId);
  io.emit(`unread_count_${userId}`, { count });
  return result;
}

// ===== АВТОСОЗДАНИЕ АДМИНА =====
(async function initUsers() {
  try {
    const adminExists = await dbGet('SELECT * FROM users WHERE username = ?', ['admin']);
    if (!adminExists) {
      const hash = await bcrypt.hash('admin123', 10);
      const refCode = 'ADMIN' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const email = 'admin@ecosystem.local';
      await dbRun(
        `INSERT INTO users (username, email, password_hash, ref_code, balance)
         VALUES (?, ?, ?, ?, ?)`,
        ['admin', email, hash, refCode, 0]
      );
      console.log('✅ Администратор создан: admin@ecosystem.local / admin123');
    }
    const testExists = await dbGet('SELECT * FROM users WHERE username = ?', ['testuser']);
    if (!testExists) {
      const hash = await bcrypt.hash('test123', 10);
      const refCode = 'TEST' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const email = 'testuser@ecosystem.local';
      await dbRun(
        `INSERT INTO users (username, email, password_hash, ref_code, balance)
         VALUES (?, ?, ?, ?, ?)`,
        ['testuser', email, hash, refCode, 0]
      );
      console.log('✅ Тестовый пользователь создан: testuser@ecosystem.local / test123');
    }
  } catch (err) {
    console.error('Ошибка при создании пользователей:', err.message);
  }
})();

// ===== ФУНКЦИИ ДЛЯ БАЛАНСА =====
async function addBalance(userId, amount, type, description) {
  if (amount === 0) return;
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('Пользователь не найден');
  const newBalance = user.balance + amount;
  await dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
  await dbRun(`INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?, ?, ?, ?, datetime('now'))`, [userId, type, amount, description]);
  io.emit(`balance_${userId}`, { balance: newBalance });
  return newBalance;
}

// ===== ФУНКЦИИ ДЛЯ ТРАНЗАКЦИЙ =====
async function getTransactionsPaginated(userId, limit, offset) {
  return dbAll(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
}
async function getTotalTransactions(userId) {
  const row = await dbGet(`SELECT COUNT(*) as count FROM transactions WHERE user_id = ?`, [userId]);
  return row.count;
}

async function getReferrals(userId) {
  return dbAll(`SELECT id, username, email, created_at, balance FROM users WHERE referrer_id = ? ORDER BY created_at DESC`, [userId]);
}
async function getReferralEarnings(userId) {
  const row = await dbGet(`SELECT COALESCE(SUM(balance), 0) as total FROM users WHERE referrer_id = ?`, [userId]);
  return row.total;
}
async function getReferralCount(userId) {
  const row = await dbGet(`SELECT COUNT(*) as count FROM users WHERE referrer_id = ?`, [userId]);
  return row.count;
}

async function getStats() {
  const usersCount = await dbGet('SELECT COUNT(*) as count FROM users');
  const activeSeasons = await dbGet('SELECT COUNT(*) as count FROM seasons WHERE is_active = 1');
  const completedSeasons = await dbGet(`
    SELECT COUNT(*) as count FROM seasons 
    WHERE is_active = 0 AND end_date < datetime('now')
  `);
  const onlineCount = await getOnlineCount();
  return { 
    users: usersCount.count || 0, 
    activeSeasons: activeSeasons.count || 0, 
    completedSeasons: completedSeasons.count || 0,
    online: onlineCount || 0 
  };
}

async function updateLastSeen(userId) {
  await dbRun('UPDATE users SET last_seen = datetime("now") WHERE id = ?', [userId]);
}
async function getOnlineCount() {
  const row = await dbGet(`SELECT COUNT(*) as count FROM users WHERE last_seen >= datetime('now', '-30 seconds')`);
  return row.count || 0;
}

async function getNotifications(userId, limit = 50) {
  return dbAll(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
}
async function markNotificationRead(notificationId) {
  await dbRun('UPDATE notifications SET is_read = 1 WHERE id = ?', [notificationId]);
}
async function deleteNotification(notificationId, userId) {
  await dbRun('DELETE FROM notifications WHERE id = ? AND user_id = ?', [notificationId, userId]);
}
async function getUnreadCount(userId) {
  const row = await dbGet('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]);
  return row.count;
}

async function getActiveSeason() { return dbGet('SELECT * FROM seasons WHERE is_active = 1'); }
async function getSeasons() { return dbAll('SELECT * FROM seasons ORDER BY created_at DESC'); }
async function getCompletedSeasons() {
  return dbAll(`
    SELECT * FROM seasons 
    WHERE is_active = 0 AND end_date < datetime('now')
    ORDER BY end_date DESC
  `);
}
async function createSeason(name, description, start_date, end_date) {
  await dbRun(`INSERT INTO seasons (name, description, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 0)`, [name, description, start_date, end_date]);
}
async function activateSeason(id) {
  await dbRun('UPDATE seasons SET is_active = 0');
  await dbRun('UPDATE seasons SET is_active = 1 WHERE id = ?', [id]);
}
async function completeSeason(id) {
  const season = await dbGet('SELECT * FROM seasons WHERE id = ?', [id]);
  if (!season) throw new Error('Сезон не найден');
  const users = await dbAll('SELECT id, total_coins FROM users WHERE total_coins > 0');
  const totalCoins = users.reduce((sum, u) => sum + u.total_coins, 0);
  if (totalCoins === 0) {
    await dbRun('UPDATE seasons SET is_active = 0 WHERE id = ?', [id]);
    return;
  }
  const rate = 100;
  const totalTokens = totalCoins / rate;
  for (const user of users) {
    const tokens = user.total_coins / rate;
    if (tokens < 0.01) continue;
    const monthly = tokens / 10;
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 30);
    await dbRun(`INSERT INTO token_schedules (user_id, total_tokens, remaining_tokens, monthly_amount, next_release_date, status) VALUES (?, ?, ?, ?, ?, 'active')`, [user.id, tokens, tokens, monthly, nextDate.toISOString()]);
    await dbRun('UPDATE users SET total_coins = 0 WHERE id = ?', [user.id]);
  }
  await dbRun('UPDATE seasons SET is_active = 0 WHERE id = ?', [id]);
  for (const user of users) {
    const tokens = user.total_coins / rate;
    if (tokens >= 0.01) {
      await sendNotification(user.id, '🎉 Сезон завершён!', `Ваши монеты конвертированы в ${tokens.toFixed(2)} токенов. Начисления будут приходить по 10% в месяц.`);
    }
  }
}

async function getAdQueue() {
  return dbAll(`SELECT * FROM ad_requests WHERE status = 'active' ORDER BY queue_position ASC`);
}
async function getAdRequests(status = null) {
  if (status) {
    return dbAll(`SELECT * FROM ad_requests WHERE status = ? ORDER BY created_at DESC`, [status]);
  }
  return dbAll('SELECT * FROM ad_requests ORDER BY created_at DESC');
}
async function getMyAds(userId) {
  return dbAll(`SELECT * FROM ad_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

async function getSetting(key) {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
}
async function getPricePerDay(section) {
  const key = `price_${section}`;
  const price = await getSetting(key);
  return price ? parseFloat(price) : 10;
}
async function getActiveAdCount(section) {
  const row = await dbGet('SELECT COUNT(*) as count FROM ad_requests WHERE status = "active" AND section = ?', [section]);
  return row.count || 0;
}
async function getActiveAdQueueDays(section) {
  const row = await dbGet('SELECT COALESCE(SUM(duration_days), 0) as total_days FROM ad_requests WHERE status = "active" AND section = ?', [section]);
  return row.total_days || 0;
}

// ===== РОУТЫ =====
app.get('/', async (req, res) => {
  const stats = await getStats();
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'main' ORDER BY queue_position ASC LIMIT 10`);
  res.render('index', { title: 'Главная', user: req.session.user, stats, activeBanners });
});

app.get('/about', async (req, res) => {
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'about' ORDER BY queue_position ASC LIMIT 10`);
  res.render('about', { title: 'О проекте', user: req.session.user, activeBanners });
});

// ===== РЕГИСТРАЦИЯ С КАПЧЕЙ =====
app.get('/register', (req, res) => {
  const ref_code = req.query.ref || '';
  const captchaData = generateCaptcha();
  registerCaptcha = { answer: captchaData.answer, text: captchaData.text };
  res.render('register', {
    title: 'Регистрация',
    user: req.session.user,
    ref_code,
    error: null,
    captcha: registerCaptcha.text
  });
});

app.post('/register', async (req, res) => {
  const { username, password, ref_code, captcha_answer } = req.body;

  if (!captcha_answer || parseInt(captcha_answer) !== registerCaptcha.answer) {
    const captchaData = generateCaptcha();
    registerCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('register', {
      title: 'Регистрация',
      user: req.session.user,
      ref_code,
      error: 'Неверный ответ на капчу. Попробуйте ещё раз.',
      captcha: registerCaptcha.text
    });
  }

  if (!username || !password) {
    const captchaData = generateCaptcha();
    registerCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('register', {
      title: 'Регистрация',
      user: req.session.user,
      ref_code,
      error: 'Заполните все поля',
      captcha: registerCaptcha.text
    });
  }

  const usernameExists = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (usernameExists) {
    const captchaData = generateCaptcha();
    registerCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('register', {
      title: 'Регистрация',
      user: req.session.user,
      ref_code,
      error: 'Этот username уже занят',
      captcha: registerCaptcha.text
    });
  }

  const email = username.toLowerCase() + '@ecosystem.local';
  const emailExists = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
  if (emailExists) {
    const captchaData = generateCaptcha();
    registerCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('register', {
      title: 'Регистрация',
      user: req.session.user,
      ref_code,
      error: 'Не удалось создать email. Попробуйте другое имя.',
      captcha: registerCaptcha.text
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const refCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let referrerId = null;
  if (ref_code) {
    const referrer = await dbGet('SELECT id FROM users WHERE ref_code = ?', [ref_code]);
    if (referrer) referrerId = referrer.id;
  }

  const result = await dbRun(
    `INSERT INTO users (username, email, password_hash, ref_code, referrer_id)
     VALUES (?, ?, ?, ?, ?)`,
    [username, email, hash, refCode, referrerId]
  );

  await sendNotification(
    result.lastID,
    '🎉 Добро пожаловать в NeonForge!',
    `Вы успешно зарегистрировались. Ваш email: ${email}`
  );

  res.redirect('/login');
});

// ===== ВХОД С КАПЧЕЙ =====
app.get('/login', (req, res) => {
  const captchaData = generateCaptcha();
  loginCaptcha = { answer: captchaData.answer, text: captchaData.text };
  res.render('login', {
    title: 'Вход',
    user: req.session.user,
    captcha: loginCaptcha.text,
    error: null
  });
});

app.post('/login', async (req, res) => {
  const { login, password, captcha_answer } = req.body;

  if (!captcha_answer || parseInt(captcha_answer) !== loginCaptcha.answer) {
    const captchaData = generateCaptcha();
    loginCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('login', {
      title: 'Вход',
      user: req.session.user,
      captcha: loginCaptcha.text,
      error: 'Неверный ответ на капчу. Попробуйте ещё раз.'
    });
  }

  const user = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [login, login]);
  if (!user) {
    const captchaData = generateCaptcha();
    loginCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('login', {
      title: 'Вход',
      user: req.session.user,
      captcha: loginCaptcha.text,
      error: 'Неверный логин или пароль'
    });
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    const captchaData = generateCaptcha();
    loginCaptcha = { answer: captchaData.answer, text: captchaData.text };
    return res.render('login', {
      title: 'Вход',
      user: req.session.user,
      captcha: loginCaptcha.text,
      error: 'Неверный логин или пароль'
    });
  }
  req.session.user = user;
  await updateLastSeen(user.id);
  res.redirect('/dashboard');
});

// ===== ЛИЧНЫЙ КАБИНЕТ =====
app.get('/dashboard', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  req.session.user = user;

  const tokens = Math.floor((user.total_coins || 0) / 100);
  const cryptoValue = tokens * 0.01;

  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;
  const transactions = await getTransactionsPaginated(user.id, limit, offset);
  const totalTransactions = await getTotalTransactions(user.id);
  const totalPages = Math.ceil(totalTransactions / limit);

  const referrals = await getReferrals(user.id);
  const referralCount = await getReferralCount(user.id);
  const referralEarnings = await getReferralEarnings(user.id);
  const schedules = await dbAll(`SELECT * FROM token_schedules WHERE user_id = ? AND status = 'active'`, [user.id]);
  const totalPending = schedules.reduce((sum, s) => sum + s.remaining_tokens, 0);
  const unreadCount = await getUnreadCount(user.id);
  const myAds = await getMyAds(user.id);
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'dashboard' ORDER BY queue_position ASC LIMIT 10`);

  res.render('dashboard', {
    title: 'Личный кабинет',
    user: req.session.user,
    transactions,
    referrals,
    referralCount,
    referralEarnings,
    schedules,
    totalPending,
    unreadCount,
    myAds,
    tokens,
    cryptoValue,
    activeBanners,
    currentPage: page,
    totalPages,
    totalTransactions
  });
});

// ===== СЕЗОННЫЕ ИГРЫ (ОБНОВЛЁННЫЙ РОУТ) =====
app.get('/games', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  req.session.user = user;
  
  const activeSeason = await getActiveSeason();
  const completedSeasons = await getCompletedSeasons();
  
  // Заглушка игр (в будущем – из БД)
  const games = [
    { id: 1, name: 'Кликер', description: 'Нажимай на кнопку быстрее всех и зарабатывай монеты!', icon: '🖱️', max_score: 100 },
    { id: 2, name: 'Угадай число', description: 'Угадай число от 1 до 100 и получи бонус!', icon: '🔢', max_score: 100 },
    { id: 3, name: 'Спринт', description: 'Нажимай на кнопку как можно быстрее за 10 секунд.', icon: '🏃', max_score: 50 },
    { id: 4, name: 'Математика', description: 'Реши примеры на скорость.', icon: '🧮', max_score: 20 },
  ];
  
  // Лучшие результаты пользователя
  const userGames = await dbAll(
    `SELECT game_name, MAX(score) as best_score, COUNT(*) as plays 
     FROM game_sessions 
     WHERE user_id = ? 
     GROUP BY game_name`,
    [user.id]
  );
  
  const bestScores = {};
  userGames.forEach(g => { bestScores[g.game_name] = g.best_score; });
  
  // Статистика пользователя в активном сезоне
  let userSeasonStats = null;
  if (activeSeason) {
    userSeasonStats = await dbGet(
      `SELECT SUM(coins_earned) as total_coins, COUNT(*) as total_games 
       FROM game_sessions 
       WHERE user_id = ? AND season_id = ?`,
      [user.id, activeSeason.id]
    );
  }
  
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'games' ORDER BY queue_position ASC LIMIT 10`);
  
  res.render('games', {
    title: 'Сезонные игры',
    user: req.session.user,
    activeSeason,
    completedSeasons,
    games,
    bestScores,
    activeBanners,
    userSeasonStats
  });
});

app.post('/topup-tokens', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  const { stars_amount } = req.body;
  if (!stars_amount || stars_amount < 10) {
    return res.status(400).json({ error: 'Минимальная сумма пополнения – 10 ⭐' });
  }
  const tokens = stars_amount;
  await addBalance(req.session.user.id, tokens, 'topup', `Пополнение на ${stars_amount} ⭐ → ${tokens} токенов`);
  await sendNotification(req.session.user.id, '💸 Пополнение рекламного баланса', `Вы успешно пополнили рекламный баланс на ${tokens} токенов. Спасибо!`);
  res.json({ success: true, tokens });
});

app.get('/notifications', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const notifications = await getNotifications(req.session.user.id);
  const unreadCount = await getUnreadCount(req.session.user.id);
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'notifications' ORDER BY queue_position ASC LIMIT 10`);
  res.render('notifications', { title: 'Уведомления', user: req.session.user, notifications, unreadCount, activeBanners });
});
app.post('/notifications/read/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  await markNotificationRead(req.params.id);
  res.json({ success: true });
});
app.post('/notifications/delete/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  await deleteNotification(req.params.id, req.session.user.id);
  res.json({ success: true });
});
app.get('/api/unread-count', async (req, res) => {
  if (!req.session.user) return res.json({ count: 0 });
  const count = await getUnreadCount(req.session.user.id);
  res.json({ count });
});

// ===== РЕКЛАМА =====
app.get('/ad-buy', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const main = await getSetting('price_main') || 150;
  const about = await getSetting('price_about') || 30;
  const games = await getSetting('price_games') || 50;
  const adQueue = await getSetting('price_ad-queue') || 20;
  const dashboard = await getSetting('price_dashboard') || 15;
  const notifications = await getSetting('price_notifications') || 10;

  const mainDays = await getActiveAdQueueDays('main');
  const aboutDays = await getActiveAdQueueDays('about');
  const gamesDays = await getActiveAdQueueDays('games');
  const adQueueDays = await getActiveAdQueueDays('ad-queue');
  const dashboardDays = await getActiveAdQueueDays('dashboard');
  const notificationsDays = await getActiveAdQueueDays('notifications');

  res.render('ad-buy', {
    title: 'Подать заявку на рекламу',
    user: req.session.user,
    message: '',
    main,
    about,
    games,
    adQueue,
    dashboard,
    notifications,
    mainDays,
    aboutDays,
    gamesDays,
    adQueueDays,
    dashboardDays,
    notificationsDays
  });
});

app.post('/ad-buy', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { project_name, description, link, section, duration_days } = req.body;
  const bannerFile = req.files ? req.files.banner : null;

  if (!project_name || !description || !link || !section || !duration_days) {
    return res.render('ad-buy', {
      title: 'Подать заявку на рекламу',
      user: req.session.user,
      message: 'Ошибка: все поля обязательны для заполнения'
    });
  }

  const pricePerDay = await getPricePerDay(section);
  const days = parseInt(duration_days);
  if (isNaN(days) || days < 1) {
    return res.render('ad-buy', {
      title: 'Подать заявку на рекламу',
      user: req.session.user,
      message: 'Ошибка: количество дней должно быть положительным числом'
    });
  }
  const budgetTokens = pricePerDay * days;

  const user = await dbGet('SELECT balance FROM users WHERE id = ?', [req.session.user.id]);
  if (user.balance < budgetTokens) {
    return res.render('ad-buy', {
      title: 'Подать заявку на рекламу',
      user: req.session.user,
      message: `Ошибка: недостаточно токенов. Нужно ${budgetTokens}, доступно ${user.balance}`
    });
  }

  await addBalance(req.session.user.id, -budgetTokens, 'ad_hold',
    `Блокировка за рекламу "${project_name}" (${days} дн., раздел: ${section})`);

  let bannerPath = null;
  if (bannerFile) {
    const mime = bannerFile.mimetype || 'image/png';
    const base64 = bannerFile.data.toString('base64');
    bannerPath = `data:${mime};base64,${base64}`;
  }

  await dbRun(`
    INSERT INTO ad_requests
    (user_id, project_name, description, link, budget_tokens, rate_per_minute, ad_type, placement, section, duration_days, banner, status, queue_position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, datetime('now'))
  `, [
    req.session.user.id,
    project_name,
    description,
    link,
    budgetTokens,
    null,
    'company',
    null,
    section,
    days,
    bannerPath
  ]);

  await sendNotification(req.session.user.id,
    '📢 Заявка на рекламу отправлена',
    `Ваша заявка "${project_name}" отправлена на модерацию. Стоимость: ${budgetTokens} токенов.`
  );

  res.redirect('/my-ads');
});

app.get('/my-ads', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const ads = await getMyAds(req.session.user.id);
  res.render('my-ads', { title: 'Мои рекламные заявки', user: req.session.user, ads });
});

app.get('/ad-queue', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 6;
  const offset = (page - 1) * limit;

  const activeAdsRaw = await dbAll(
    `SELECT * FROM ad_requests WHERE status = 'active' AND section = 'ad-queue' ORDER BY queue_position ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const totalActive = await dbGet(`SELECT COUNT(*) as count FROM ad_requests WHERE status = 'active' AND section = 'ad-queue'`);
  const totalPages = Math.ceil(totalActive.count / limit);

  const pendingAds = await getAdRequests('pending');
  const activeBanners = await dbAll(`SELECT * FROM ad_requests WHERE status = 'active' AND section = 'ad-queue' ORDER BY queue_position ASC LIMIT 10`);

  const activeAds = activeAdsRaw.map(ad => {
    if (!ad.started_at) {
      return {
        ...ad,
        remaining_seconds: null,
        remaining_days: null,
        remaining_hours: null,
        remaining_minutes: null,
        remaining_seconds_short: null,
        is_expired: false,
        not_started: true
      };
    }
    const now = new Date();
    const startDate = new Date(ad.started_at + 'Z');
    const endDate = new Date(startDate.getTime() + ad.duration_days * 24 * 60 * 60 * 1000);
    const diffMs = endDate - now;
    const diffSec = Math.floor(diffMs / 1000);
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);
    const seconds = diffSec % 60;
    return {
      ...ad,
      remaining_seconds: diffSec > 0 ? diffSec : 0,
      remaining_days: days,
      remaining_hours: hours,
      remaining_minutes: minutes,
      remaining_seconds_short: seconds,
      is_expired: diffSec <= 0,
      not_started: false
    };
  });

  res.render('ad-queue', {
    title: 'Очередь рекламы',
    user: req.session.user,
    activeAds,
    pendingAds,
    activeBanners,
    currentPage: page,
    totalPages,
    totalActive: totalActive.count
  });
});

// ===== АДМИН =====
app.get('/admin', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.send('Доступ запрещён');
  }
  const users = await dbAll('SELECT * FROM users ORDER BY id DESC');
  const seasons = await getSeasons();
  const ads = await getAdRequests();
  const stats = await getStats();
  const pendingAds = await getAdRequests('pending');
  const activeAds = await getAdQueue();

  res.render('admin', {
    title: 'Админ-панель',
    user: req.session.user,
    users,
    seasons,
    ads,
    stats,
    pendingAds: pendingAds.length,
    activeAds: activeAds.length
  });
});

app.post('/admin/season/create', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  const { name, description, start_date, end_date } = req.body;
  await createSeason(name, description, start_date, end_date);
  res.redirect('/admin');
});
app.post('/admin/season/activate/:id', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  await activateSeason(req.params.id);
  res.redirect('/admin');
});
app.post('/admin/season/complete/:id', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  await completeSeason(req.params.id);
  res.redirect('/admin');
});

app.get('/admin-ads', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.send('Доступ запрещён');
  }
  const allRequests = await getAdRequests();
  res.render('admin-ads', { title: 'Управление рекламой', user: req.session.user, requests: allRequests });
});

app.post('/admin-ads/approve/:id', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  const id = req.params.id;
  const maxPos = await dbGet('SELECT MAX(queue_position) as max FROM ad_requests WHERE status = "active"');
  const newPos = (maxPos && maxPos.max) ? maxPos.max + 1 : 1;
  await dbRun(
    `UPDATE ad_requests SET status = 'active', queue_position = ?, started_at = NULL WHERE id = ?`,
    [newPos, id]
  );
  const ad = await dbGet('SELECT user_id, project_name FROM ad_requests WHERE id = ?', [id]);
  if (ad) await sendNotification(ad.user_id, '📢 Реклама одобрена', `Ваша реклама "${ad.project_name}" одобрена и добавлена в очередь.`);
  res.redirect('/admin-ads');
});

app.post('/admin-ads/reject/:id', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  const id = req.params.id;
  const ad = await dbGet('SELECT user_id, budget_tokens, project_name FROM ad_requests WHERE id = ?', [id]);
  if (ad && ad.budget_tokens) {
    await addBalance(ad.user_id, ad.budget_tokens, 'ad_refund', `Возврат токенов за отклонённую рекламу "${ad.project_name}"`);
    await sendNotification(ad.user_id, '❌ Реклама отклонена', `Ваша реклама "${ad.project_name}" отклонена. Токены возвращены на баланс.`);
  }
  await dbRun(`UPDATE ad_requests SET status = 'rejected' WHERE id = ?`, [id]);
  res.redirect('/admin-ads');
});

app.get('/admin/prices', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.send('Доступ запрещён');
  }
  const main = await getSetting('price_main') || '150';
  const about = await getSetting('price_about') || '30';
  const games = await getSetting('price_games') || '50';
  const adQueue = await getSetting('price_ad-queue') || '20';
  const dashboard = await getSetting('price_dashboard') || '15';
  const notifications = await getSetting('price_notifications') || '10';
  const success = req.query.success === '1';
  res.render('admin-prices', {
    title: 'Управление ценами',
    user: req.session.user,
    main,
    about,
    games,
    adQueue,
    dashboard,
    notifications,
    success
  });
});

app.post('/admin/prices', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  const { price_main, price_about, price_games, price_ad_queue, price_dashboard, price_notifications } = req.body;
  await setSetting('price_main', price_main);
  await setSetting('price_about', price_about);
  await setSetting('price_games', price_games);
  await setSetting('price_ad-queue', price_ad_queue);
  await setSetting('price_dashboard', price_dashboard);
  await setSetting('price_notifications', price_notifications);
  res.redirect('/admin/prices?success=1');
});

app.get('/admin/send-notification', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.send('Доступ запрещён');
  }
  res.render('admin-send-notification', { title: 'Отправить уведомление', user: req.session.user });
});

app.post('/admin/send-notification', async (req, res) => {
  if (!req.session.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Доступ запрещён');
  }
  const { subject, body, user_id } = req.body;
  if (!subject || !body) {
    return res.send('Заполните тему и текст');
  }
  if (user_id && user_id !== 'all') {
    await sendNotification(parseInt(user_id), subject, body);
  } else {
    const users = await dbAll('SELECT id FROM users');
    for (const user of users) {
      await sendNotification(user.id, subject, body);
    }
  }
  res.redirect('/admin/send-notification?success=1');
});

// ===== API РОУТЫ =====
app.get('/api/stats', async (req, res) => {
  const stats = await getStats();
  res.json(stats);
});
app.get('/api/user', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  const user = await dbGet('SELECT id, username, email, balance, total_coins FROM users WHERE id = ?', [req.session.user.id]);
  res.json(user);
});
app.post('/api/game/score', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  const { game_name, score, season_id } = req.body;
  if (!game_name) return res.status(400).json({ error: 'Не указана игра' });
  const coins = Math.floor(score / 10);
  await dbRun(`INSERT INTO game_sessions (user_id, season_id, game_name, score, coins_earned) VALUES (?, ?, ?, ?, ?)`, [req.session.user.id, season_id || null, game_name, score, coins]);
  await dbRun(`UPDATE users SET total_coins = total_coins + ? WHERE id = ?`, [coins, req.session.user.id]);
  res.json({ success: true, coins_earned: coins });
});
app.get('/api/active-ad', async (req, res) => {
  const ad = await dbGet(`SELECT * FROM ad_requests WHERE status = 'active' ORDER BY queue_position ASC LIMIT 1`);
  res.json(ad || null);
});

app.get('/add-test-balance', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  await addBalance(req.session.user.id, 10, 'test', 'Тестовое начисление');
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

server.listen(PORT, () => {
  console.log(`🚀 NeonForge запущен на http://localhost:${PORT}`);
});