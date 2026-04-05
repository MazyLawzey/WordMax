const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

// ─── Конфигурация ───────────────────────────────────────────────────────────
const YANDEX_TOKEN  = process.env.YANDEX_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WATCH_PATH    = process.env.WATCH_PATH || '/';
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут
const STATE_FILE    = path.join(__dirname, 'state.json');

// ─── Валидация конфига ───────────────────────────────────────────────────────
if (!YANDEX_TOKEN || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Ошибка: заполните YANDEX_TOKEN, TELEGRAM_TOKEN и TELEGRAM_CHAT_ID в файле .env');
  process.exit(1);
}

// ─── Состояние (хранит modified-дату каждого файла) ─────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Яндекс Диск API ────────────────────────────────────────────────────────
async function getYandexDiskFiles(folderPath) {
  const response = await axios.get('https://cloud-api.yandex.net/v1/disk/resources', {
    headers: {
      Authorization: `OAuth ${YANDEX_TOKEN}`,
    },
    params: {
      path: folderPath,
      limit: 1000,
      fields: [
        '_embedded.items.path',
        '_embedded.items.name',
        '_embedded.items.modified',
        '_embedded.items.type',
        '_embedded.items.size',
      ].join(','),
    },
  });

  const items = response.data._embedded?.items ?? [];
  return items.filter((item) => item.type === 'file');
}

// ─── Telegram API ────────────────────────────────────────────────────────────
async function sendTelegramMessage(text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }
  );
}

// ─── Форматирование времени ───────────────────────────────────────────────────
function formatDate(isoString) {
  return new Date(isoString).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

// ─── Основная проверка изменений ─────────────────────────────────────────────
async function checkChanges() {
  const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  console.log(`[${timestamp}] Проверка изменений в папке: ${WATCH_PATH}`);

  try {
    const files = await getYandexDiskFiles(WATCH_PATH);
    const state = loadState();
    const changes = [];

    for (const file of files) {
      const key = file.path;
      const prevModified = state[key];
      const currModified = file.modified;

      if (!prevModified) {
        // Первый запуск — просто фиксируем, не уведомляем
        state[key] = currModified;
      } else if (prevModified !== currModified) {
        changes.push(
          `✏️ <b>${file.name}</b>\n` +
          `   📅 Изменён: ${formatDate(currModified)}\n` +
          `   📦 Размер: ${(file.size / 1024).toFixed(1)} КБ`
        );
        state[key] = currModified;
      }
    }

    // Проверяем удалённые файлы
    const currentPaths = new Set(files.map((f) => f.path));
    for (const key of Object.keys(state)) {
      if (!currentPaths.has(key)) {
        const name = key.split('/').pop();
        changes.push(`🗑 Удалён файл: <b>${name}</b>`);
        delete state[key];
      }
    }

    saveState(state);

    if (changes.length > 0) {
      const message =
        `🔔 <b>Яндекс Диск — изменения</b>\n` +
        `📁 <code>${WATCH_PATH}</code>\n` +
        `🕒 ${timestamp}\n\n` +
        changes.join('\n\n');

      await sendTelegramMessage(message);
      console.log(`  → Отправлено уведомлений: ${changes.length}`);
    } else {
      console.log('  → Изменений нет.');
    }
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message;
    console.error(`  → Ошибка: ${errMsg}`);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════╗');
console.log('║   Мониторинг Яндекс Диска → Telegram     ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`  Папка:    ${WATCH_PATH}`);
console.log(`  Интервал: каждые 5 минут\n`);

// Первый запуск сразу (инициализация состояния), затем по расписанию
checkChanges();
setInterval(checkChanges, CHECK_INTERVAL);
