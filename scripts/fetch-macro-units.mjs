#!/usr/bin/env node
// ===== Подтягивание живых данных по квартирам из Macro CRM =====
//
// Запускается в CI (.github/workflows/deploy.yml) перед сборкой/публикацией.
// Пишет assets/data/macro-units.generated.json — тот же формат полей,
// что уже использует buildMockUnits() в index.html: { id, entrance, floor,
// rooms, area, price, status, img }. Модалка «Выбор квартиры» на странице
// подхватывает этот файл через fetch() с graceful fallback на моковые
// данные (см. комментарий у APT_PICKER_UNITS в index.html) — тем же
// паттерном, что уже используется для assets/data/banks.json.
//
// Переменные окружения:
//   MACRO_API_KEY       — обязателен. Bearer-токен нового формата
//                         (вида "macro-66-..."), read-only, создан в
//                         личном кабинете Macro: Company → API-ключи.
//   MACRO_HOST          — обязателен. РЕАЛЬНЫЙ хост тенанта, НЕ
//                         https://api.macroserver.ru (тот стабильно
//                         отдаёт 401 для реального аккаунта — см.
//                         MACRO_INTEGRATION.md, раздел 1). Хост нужно
//                         найти в виджете Macro на сайте клиента
//                         (смотреть, с какого домена грузятся данные)
//                         либо перебрать curl'ом с сервера (не из
//                         браузера — CORS маскирует причину).
//                         Пример реального хоста из другого проекта:
//                         https://api.macro.sbercrm.com/v2
//   MACRO_COMPLEX_ID    — обязателен. ID ЖК «Жить хорошо» в Macro.
//                         Узнать: вызвать /estateComplexes/list без
//                         фильтра (вернёт все комплексы аккаунта),
//                         найти нужный по полю publicName.
//   MACRO_PRICE_FLOOR   — опционально, в рублях (по умолчанию 1000000).
//                         Лоты в статусе 32 («Маркетинговый резерв»)
//                         часто имеют служебную цену-заглушку (1 ₽) —
//                         если price ниже порога, лот помечается
//                         status: 'booked' без цены вместо абсурдной
//                         "от 1 ₽" (см. MACRO_INTEGRATION.md, раздел 6.3).
//
// Если MACRO_API_KEY/MACRO_HOST/MACRO_COMPLEX_ID не заданы — скрипт
// молча завершается (exit 0), не трогая существующий generated-файл.
// Так же он ведёт себя при сетевой ошибке/пустом ответе API: сайт не
// должен падать из-за временной недоступности Macro (graceful fallback,
// см. README.md раздела "Модалка «Выбор квартиры»").

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'assets', 'data', 'macro-units.generated.json');

const API_KEY = process.env.MACRO_API_KEY || '';
const HOST = (process.env.MACRO_HOST || '').replace(/\/+$/, '');
const COMPLEX_ID = process.env.MACRO_COMPLEX_ID || '';
const PRICE_FLOOR_RUB = Number(process.env.MACRO_PRICE_FLOOR || 1000000);

// Статусы estateSell, которые вообще показываем на сайте
// (см. MACRO_INTEGRATION.md, раздел 5, enum EstateStatus).
const STATUS_MAP = {
  20: 'free',    // Свободно
  30: 'booked',  // Бронь
  32: 'booked'   // Маркетинговый резерв — показываем как "Бронь"
};

async function call(method, body = {}) {
  const res = await fetch(`${HOST}${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Количество комнат в ответе Macro не задокументировано явно в гайде
// (раздел 5 перечисляет цену/площадь/этаж/подъезд, но не число комнат
// напрямую) — пробуем несколько вероятных полей по порядку. Если ни
// одно не подошло, лог подскажет реальное имя поля из первого лота.
function guessRooms(lot) {
  if (typeof lot.roomsCount === 'number') return lot.roomsCount;
  if (typeof lot.rooms === 'number') return lot.rooms;
  if (typeof lot.roomsNumber === 'number') return lot.roomsNumber;
  if (typeof lot.category === 'string') {
    const m = lot.category.match(/(\d+)/);
    if (m) return Number(m[1]);
    if (/studio/i.test(lot.category)) return 0;
  }
  return null;
}

async function fetchAllLots() {
  const lots = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const body = { complexIds: [Number(COMPLEX_ID)], categories: ['flat'] };
    if (cursor) body.from = cursor;
    const res = await call('/estateSell/list', body);
    const data = Array.isArray(res.data) ? res.data : [];
    lots.push(...data);
    cursor = res.meta && res.meta.next;
    if (!cursor || data.length === 0) break;
  }
  return lots;
}

function mapLot(lot, index) {
  const statusKey = STATUS_MAP[lot.status];
  if (!statusKey) return null; // сделки/продано/проверка — не показываем

  const priceRub = Math.round((lot.price || 0) / 100);
  const marketingReserve = lot.status === 32;
  const priceTooLow = priceRub < PRICE_FLOOR_RUB;

  return {
    id: 'm' + (lot.id != null ? lot.id : index),
    entrance: lot.entrance != null ? String(lot.entrance) : '—',
    floor: Number(lot.floor) || 0,
    rooms: guessRooms(lot),
    area: Number(lot.areaTotal) || null,
    // Лоты маркетингового резерва с ценой-заглушкой — без цены,
    // карточка/список должны показывать «по запросу» (см. раздел 6.3).
    price: marketingReserve && priceTooLow ? null : priceRub,
    status: statusKey,
    // planImage — временная ссылка (протухает через несколько дней,
    // см. раздел 6.4) — это нормально: файл перегенерируется по
    // расписанию в CI (см. .github/workflows/deploy.yml), устаревшая
    // ссылка живёт самое большее до следующего прогона.
    img: lot.planImage || null
  };
}

async function main() {
  if (!API_KEY || !HOST || !COMPLEX_ID) {
    console.log('[macro] MACRO_API_KEY/MACRO_HOST/MACRO_COMPLEX_ID не заданы — пропускаю, оставляю файл как есть.');
    return;
  }

  let units = [];
  try {
    const lots = await fetchAllLots();
    units = lots.map(mapLot).filter(Boolean);
    if (units.length && units[0].rooms == null) {
      console.warn('[macro] Не удалось определить число комнат по известным полям — проверь сырой ответ API и поправь guessRooms() в этом скрипте.');
    }
  } catch (err) {
    console.error('[macro] Не удалось получить данные:', err.message);
    console.error('[macro] Сайт продолжит использовать предыдущий сгенерированный файл (если есть) или моковые данные — сборка не падает.');
    return;
  }

  if (!units.length) {
    console.warn('[macro] API вернул 0 подходящих лотов — оставляю существующий файл без изменений (защита от случайного обнуления витрины).');
    return;
  }

  await writeFile(OUT_PATH, JSON.stringify(units, null, 2) + '\n', 'utf8');
  console.log(`[macro] Записано ${units.length} лотов в ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  // Защитная сетка: даже необработанная ошибка не должна ронять сборку.
  console.error('[macro] Непредвиденная ошибка, пропускаю:', err);
});
