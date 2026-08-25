const express = require('express');
const fs = require('fs');
const path = require('path');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const app = express();
const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS !== 'false';
const ALLOW_MANUAL_CAPTCHA = process.env.ALLOW_MANUAL_CAPTCHA === 'true';
const CAPTCHA_WAIT_MS = Number(process.env.CAPTCHA_WAIT_MS || 180000);
const DEFAULT_CITY_SLUG = 'moskva';
const DEFAULT_DEAL_FILTER = 'all';
const DEFAULT_PROPERTY_FILTER = 'all';
const DEFAULT_PAGES = Number(process.env.DEFAULT_PAGES || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);
const PAGE_FETCH_RETRIES = Number(process.env.PAGE_FETCH_RETRIES || 3);
const DEAL_FILTERS = {
  rent: { slug: 'sdam', label: 'Аренда' },
  sale: { slug: 'prodam', label: 'Продажа' }
};
const PROPERTY_FILTERS = {
  apartments: { slug: 'kvartiry', label: 'Квартиры' },
  houses: { slug: 'doma_dachi_kottedzhi', label: 'Дома' }
};
function resolveRuntimePath(rawPath, fallbackPath) {
  const value = String(rawPath || '').trim();
  return value ? path.resolve(__dirname, value) : fallbackPath;
}

const DATA_DIR = resolveRuntimePath(
  process.env.DATA_DIR,
  path.join(__dirname, 'data')
);
const DATA_FILE = path.join(DATA_DIR, 'avito_data.json');
const BROWSER_PROFILE_DIR = resolveRuntimePath(
  process.env.BROWSER_PROFILE_DIR,
  path.join(__dirname, '.local', 'browser-profile')
);
const AVITO_PROXY_SERVER = process.env.AVITO_PROXY_SERVER || '';
const AVITO_PROXY_USERNAME = process.env.AVITO_PROXY_USERNAME || '';
const AVITO_PROXY_PASSWORD = process.env.AVITO_PROXY_PASSWORD || '';
const PUPPETEER_NO_SANDBOX = process.env.PUPPETEER_NO_SANDBOX === 'true';

// Настройки express
app.set('view engine', 'ejs');
app.disable('x-powered-by');
app.use(express.static('public'));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPuppeteer() {
  const module = await import('puppeteer');
  return module.default || module;
}

function buildAvitoUrl(citySlug, target) {
  return `https://www.avito.ru/${citySlug}/${target.propertySlug}/${target.dealSlug}`;
}

function buildPagedUrl(baseUrl, pageNumber) {
  if (pageNumber <= 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set('p', String(pageNumber));
  return url.toString();
}

function normalizeCitySlug(rawCity) {
  const city = String(rawCity || '').trim().toLowerCase();
  if (!city) return DEFAULT_CITY_SLUG;
  if (/^[a-z0-9_-]+$/.test(city)) return city;

  const map = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya'
  };

  const slug = [...city]
    .map((char) => map[char] ?? char)
    .join('')
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || DEFAULT_CITY_SLUG;
}

function normalizeDealFilter(rawDeal) {
  const value = String(rawDeal || '').trim().toLowerCase();
  if (value === 'rent' || value === 'sale' || value === 'all') return value;
  return DEFAULT_DEAL_FILTER;
}

function normalizePropertyFilter(rawProperty) {
  const value = String(rawProperty || '').trim().toLowerCase();
  if (value === 'apartments' || value === 'houses' || value === 'all') {
    return value;
  }
  return DEFAULT_PROPERTY_FILTER;
}

function getDealFilterLabel(dealFilter) {
  if (dealFilter === 'all') return 'Аренда + Продажа';
  return DEAL_FILTERS[dealFilter]?.label || 'Аренда + Продажа';
}

function getPropertyFilterLabel(propertyFilter) {
  if (propertyFilter === 'all') return 'Квартиры + Дома';
  return PROPERTY_FILTERS[propertyFilter]?.label || 'Квартиры + Дома';
}

function resolveSearchTargets(dealFilter, propertyFilter) {
  const dealKeys =
    dealFilter === 'all' ? Object.keys(DEAL_FILTERS) : [dealFilter];
  const propertyKeys =
    propertyFilter === 'all'
      ? Object.keys(PROPERTY_FILTERS)
      : [propertyFilter];

  const targets = [];
  for (const propertyKey of propertyKeys) {
    for (const dealKey of dealKeys) {
      const deal = DEAL_FILTERS[dealKey];
      const property = PROPERTY_FILTERS[propertyKey];
      if (!deal || !property) continue;
      targets.push({
        dealKey,
        propertyKey,
        dealSlug: deal.slug,
        propertySlug: property.slug,
        dealLabel: deal.label,
        propertyLabel: property.label
      });
    }
  }

  return targets;
}

function normalizePages(rawPages) {
  const parsed = Number.parseInt(String(rawPages || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGES;
  return Math.min(parsed, MAX_PAGES);
}

function parsePositiveInt(rawValue) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return parsed;
}

function normalizePageRange(rawPageFrom, rawPageTo, rawPages) {
  const parsedFrom = parsePositiveInt(rawPageFrom);
  const parsedTo = parsePositiveInt(rawPageTo);
  const parsedPages = parsePositiveInt(rawPages);

  const pageFrom = parsedFrom || 1;
  let pageTo = pageFrom;

  if (parsedTo !== null) {
    pageTo = parsedTo;
  } else if (parsedPages !== null) {
    pageTo = pageFrom + Math.min(parsedPages, MAX_PAGES) - 1;
  }

  if (pageTo < pageFrom) {
    pageTo = pageFrom;
  }

  if (pageTo - pageFrom + 1 > MAX_PAGES) {
    pageTo = pageFrom + MAX_PAGES - 1;
  }

  return {
    pageFrom,
    pageTo,
    pages: pageTo - pageFrom + 1
  };
}

function normalizeNumericOrNull(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeRoomsFilter(rawRooms) {
  const input = String(rawRooms || '').trim().toLowerCase();
  if (!input) return [];

  const values = new Set();
  const tokens = input.split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) {
    if (
      token === 'studio' ||
      token === 'studia' ||
      token === 'студия' ||
      token === 'студ'
    ) {
      values.add(0);
      continue;
    }

    if (/^\d+$/.test(token)) {
      values.add(Number(token));
    }
  }

  return [...values];
}

function parsePriceValue(rawPrice) {
  const digits = String(rawPrice || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

function parseAreaValue(source) {
  const text = String(source || '').replace(/\u00a0/g, ' ').replace(',', '.');
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseRoomsValue(source) {
  const text = String(source || '').toLowerCase();
  if (!text) return null;

  if (text.includes('студия') || text.includes('студ')) return 0;

  const patterns = [
    /(\d+)\s*-\s*комн/i,
    /(\d+)\s*комн/i,
    /(\d+)\s*к\b/i,
    /(\d+)\s*комнат/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

function parseWallMaterial(source) {
  const text = String(source || '').replace(/\u00a0/g, ' ');
  if (!text) return null;

  const patterns = [
    /(?:материал\s+стен|стены)\s*[:\-]\s*([^,.;\n]+)/i,
    /стен[аы]\s*[:\-]\s*([^,.;\n]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = String(match[1] || '').replace(/\s+/g, ' ').trim();
    if (value) return value;
  }

  return null;
}

function parseBuildYear(source) {
  const text = String(source || '').replace(/\u00a0/g, ' ');
  if (!text) return null;

  const currentYear = new Date().getFullYear() + 1;
  const patterns = [
    /(?:год(?:\s+постройки)?|г\.?\s*п\.?)\s*[:\-]?\s*(\d{4})/i,
    /(\d{4})\s*г(?:од[ау]?)?\s*постройки/i,
    /постро(?:ен|ена|ено|или)\s*(?:в\s*)?(\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const year = Number(match[1]);
    if (Number.isFinite(year) && year >= 1800 && year <= currentYear) {
      return year;
    }
  }

  return null;
}

function enrichListing(listing, target, sourceUrl, sourcePage) {
  const textForParsing = `${listing.title || ''} ${listing.details || ''}`;
  const priceValue = parsePriceValue(listing.price);
  const area = parseAreaValue(textForParsing);
  const rooms = parseRoomsValue(textForParsing);
  const wallMaterial = parseWallMaterial(textForParsing);
  const buildYear = parseBuildYear(textForParsing);

  return {
    ...listing,
    priceValue,
    area,
    rooms,
    wallMaterial,
    buildYear,
    deal: target.dealKey,
    dealLabel: target.dealLabel,
    propertyType: target.propertyKey,
    propertyLabel: target.propertyLabel,
    sourceUrl,
    sourcePage
  };
}

function listingPassesValueFilters(listing, filters) {
  if (filters.minPrice !== null) {
    if (listing.priceValue === null || listing.priceValue < filters.minPrice) {
      return false;
    }
  }
  if (filters.maxPrice !== null) {
    if (listing.priceValue === null || listing.priceValue > filters.maxPrice) {
      return false;
    }
  }
  if (filters.minArea !== null) {
    if (listing.area === null || listing.area < filters.minArea) {
      return false;
    }
  }
  if (filters.maxArea !== null) {
    if (listing.area === null || listing.area > filters.maxArea) {
      return false;
    }
  }
  if (filters.rooms.length > 0) {
    if (listing.rooms === null || !filters.rooms.includes(listing.rooms)) {
      return false;
    }
  }

  return true;
}

function listingMatchesTarget(listing, target) {
  const url = String(listing?.url || '').toLowerCase();
  if (!url || url === '#') return true;

  const hasHouses = url.includes('/doma_dachi_kottedzhi/');
  const hasApartments = url.includes('/kvartiry/');
  const hasRent = url.includes('/sdam/');
  const hasSale = url.includes('/prodam/');

  if (target.propertyKey === 'houses' && hasApartments) return false;
  if (target.propertyKey === 'apartments' && hasHouses) return false;
  if (target.dealKey === 'sale' && hasRent) return false;
  if (target.dealKey === 'rent' && hasSale) return false;

  return true;
}

function saveListings(listings, meta = {}) {
  const payload = {
    meta: {
      ...meta,
      count: listings.length,
      savedAt: new Date().toISOString()
    },
    listings
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
}

function readListings() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!data) return { listings: [], meta: null };
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return { listings: parsed, meta: null };
    }

    if (parsed && typeof parsed === 'object') {
      const listings = Array.isArray(parsed.listings) ? parsed.listings : [];
      const meta =
        parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : null;
      return { listings, meta };
    }

    return { listings: [], meta: null };
  } catch (error) {
    return { listings: [], meta: null };
  }
}

function escapeCsvCell(value) {
  const str = protectSpreadsheetFormula(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function protectSpreadsheetFormula(value) {
  const str = String(value ?? '');
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
}

const EXPORT_HEADERS = [
  'id',
  'title',
  'price',
  'priceValue',
  'area',
  'rooms',
  'wallMaterial',
  'buildYear',
  'location',
  'deal',
  'dealLabel',
  'propertyType',
  'propertyLabel',
  'sourcePage',
  'sourceUrl',
  'url'
];

function buildCsv(listings) {
  const lines = [EXPORT_HEADERS.join(',')];
  for (const listing of listings) {
    const row = EXPORT_HEADERS.map((field) => escapeCsvCell(listing[field]));
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

function escapeXmlCell(value) {
  return protectSpreadsheetFormula(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildExcelXml(listings) {
  const numericFields = new Set([
    'priceValue',
    'area',
    'rooms',
    'buildYear',
    'sourcePage'
  ]);

  const headerRow = `<Row>${EXPORT_HEADERS.map(
    (field) => `<Cell><Data ss:Type="String">${escapeXmlCell(field)}</Data></Cell>`
  ).join('')}</Row>`;

  const dataRows = listings
    .map((listing) => {
      const cells = EXPORT_HEADERS.map((field) => {
        const value = listing?.[field];
        if (value === null || value === undefined || value === '') {
          return '<Cell><Data ss:Type="String"></Data></Cell>';
        }

        if (numericFields.has(field) && Number.isFinite(Number(value))) {
          return `<Cell><Data ss:Type="Number">${Number(value)}</Data></Cell>`;
        }

        return `<Cell><Data ss:Type="String">${escapeXmlCell(value)}</Data></Cell>`;
      }).join('');

      return `<Row>${cells}</Row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Avito">
    <Table>
      ${headerRow}
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

function isAccessBlocked(pageTitle, pageText) {
  const text = `${pageTitle}\n${pageText}`.toLowerCase();
  return (
    text.includes('доступ ограничен') ||
    text.includes('проблема с ip') ||
    text.includes('капч')
  );
}

function isNoResultsPage(pageText) {
  const text = String(pageText || '').toLowerCase();
  return (
    text.includes('ничего не найдено') ||
    text.includes('по вашему запросу ничего не найдено') ||
    text.includes('объявления не найдены')
  );
}

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isTransientContextError(error) {
  const message = String(error?.message || '');
  return (
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('Inspected target navigated or closed') ||
    message.includes('Target closed')
  );
}

async function evaluateWithRetry(
  page,
  evaluateFn,
  { attempts = 8, delayMs = 500, label = 'evaluate' } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.evaluate(evaluateFn);
    } catch (error) {
      lastError = error;
      if (!isTransientContextError(error) || attempt === attempts) {
        throw error;
      }

      console.log(
        `[${label}] transient navigation/context error (${attempt}/${attempts}), retry...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function getPageSnapshot(page) {
  return evaluateWithRetry(
    page,
    () => {
      const cardsSelector =
        '[data-marker="item"], [data-item-id], article[data-marker*="item"]';
      return {
        title: document.title || '',
        text: (document.body?.innerText || '').slice(0, 5000),
        cardsCount: document.querySelectorAll(cardsSelector).length
      };
    },
    { label: 'snapshot' }
  );
}

async function extractListings(page) {
  return evaluateWithRetry(
    page,
    () => {
      const textContent = (el) =>
        (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const cleanSellerText = (raw) => {
        let text = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';

        text = text
          .replace(/(реквизиты проверены|документы проверены|проверено в росреестре|надёжный партнёр|комфортная сделка)/gi, '')
          .replace(/\d+\s*заверш[а-яё\s]*объявлен[а-яё]*/gi, '')
          .replace(/\d+\s*объявлен[а-яё]*/gi, '')
          .replace(/\d+\s*отзыв[а-яё]*/gi, '')
          .replace(/написать|показать телефон/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 120) return '';
        if (/^\d+[\s₽руб\.]*$/i.test(text)) return '';
        if (/рейтинг|просмотр|объявлени|вчера|сегодня|поднять/i.test(text)) {
          return '';
        }
        return text;
      };
      const detectRealtorName = (card) => {
        const primary =
          card.querySelector('[class*="sellerInfo"]') ||
          card.querySelector('[class*="userInfoStep"]') ||
          card.querySelector('[class*="asideContent"]');
        if (primary) {
          const txt = cleanSellerText(textContent(primary));
          if (txt) {
            if (/частн(ое|ый)\s+лицо|собственник/i.test(txt)) return '';
            return txt;
          }
        }

        const fallbackCandidates = Array.from(
          card.querySelectorAll('[data-marker*="item-contact"], [class*="seller"], [class*="agency"], [class*="author"]')
        );
        for (const node of fallbackCandidates) {
          const className = String(node.className || '').toLowerCase();
          if (className.includes('badge') || className.includes('rating')) {
            continue;
          }
          const txt = cleanSellerText(textContent(node));
          if (!txt) continue;
          if (/частн(ое|ый)\s+лицо|собственник/i.test(txt)) return '';
          if (/показать телефон|написать/i.test(txt)) continue;
          return txt;
        }

        const cardText = textContent(card);
        if (/частн(ое|ый)\s+лицо|собственник/i.test(cardText)) {
          return '';
        }
        return '';
      };

      const cards = Array.from(
        document.querySelectorAll(
          '[data-marker="item"], [data-item-id], article[data-marker*="item"]'
        )
      );

      const unique = [];
      const seen = new Set();

      for (const card of cards) {
        const linkEl =
          card.querySelector('a[href*="/doma_dachi_kottedzhi/"]') ||
          card.querySelector('a[href*="/kvartiry/"]') ||
          card.querySelector('a[href*="/prodam"]') ||
          card.querySelector('a[href*="/sdam"]') ||
          card.querySelector('a[href]');

        const rawUrl = linkEl?.href || '';
        const id =
          card.getAttribute('data-item-id') ||
          card.querySelector('[data-item-id]')?.getAttribute('data-item-id') ||
          '';
        const key = id || rawUrl;

        if (!key || seen.has(key)) continue;
        seen.add(key);

        const title =
          textContent(card.querySelector('[itemprop="name"]')) ||
          textContent(card.querySelector('[data-marker*="item-title"]')) ||
          textContent(linkEl);

        const price =
          textContent(card.querySelector('[itemprop="price"]')) ||
          textContent(card.querySelector('[data-marker="item-price"]')) ||
          textContent(card.querySelector('[class*="price"]'));

        const location =
          textContent(card.querySelector('[data-marker="item-location"]')) ||
          textContent(card.querySelector('[class*="geo"]')) ||
          'N/A';
        const details =
          textContent(card.querySelector('[data-marker="item-specific-params"]')) ||
          textContent(card.querySelector('[data-marker="item-params"]')) ||
          textContent(card.querySelector('[class*="params"]')) ||
          '';
        const realtorName = detectRealtorName(card);

        if (!title || !price) continue;

        unique.push({
          id: id || `item-${unique.length + 1}`,
          title,
          price,
          details,
          realtorName,
          url: rawUrl || '#',
          location
        });
      }

      return unique;
    },
    { label: 'listings' }
  );
}

async function waitForManualCaptcha(page) {
  const deadline = Date.now() + CAPTCHA_WAIT_MS;
  const waitSeconds = Math.floor(CAPTCHA_WAIT_MS / 1000);

  console.log(
    `Обнаружена капча/блокировка. Ожидаю ручное прохождение в окне браузера (${waitSeconds} сек)...`
  );
  await page.bringToFront();

  while (Date.now() < deadline) {
    await sleep(2500);
    const snapshot = await getPageSnapshot(page);
    const blocked = isAccessBlocked(snapshot.title, snapshot.text);
    if (!blocked && snapshot.cardsCount > 0) {
      console.log('Капча пройдена, продолжаем парсинг.');
      return;
    }
  }

  throw new Error(
    'Капча не была пройдена вовремя. Повтори запуск или увеличь CAPTCHA_WAIT_MS.'
  );
}

async function parseAvitoListings(citySlug, options = {}) {
  const headless = options.headless ?? HEADLESS;
  const allowManualCaptcha = options.allowManualCaptcha ?? ALLOW_MANUAL_CAPTCHA;
  const pageRange = normalizePageRange(
    options.pageFrom,
    options.pageTo,
    options.pages
  );
  const pageFrom = pageRange.pageFrom;
  const pageTo = pageRange.pageTo;
  const pages = pageRange.pages;
  const valueFilters = options.valueFilters || {
    minPrice: null,
    maxPrice: null,
    minArea: null,
    maxArea: null,
    rooms: []
  };
  const targets =
    Array.isArray(options.targets) && options.targets.length
      ? options.targets
      : resolveSearchTargets(DEFAULT_DEAL_FILTER, DEFAULT_PROPERTY_FILTER);

  let browser;
  try {
    const puppeteer = await loadPuppeteer();
    const launchArgs = [];
    if (PUPPETEER_NO_SANDBOX) {
      launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    if (AVITO_PROXY_SERVER) {
      launchArgs.push(`--proxy-server=${AVITO_PROXY_SERVER}`);
    }

    browser = await puppeteer.launch({
      headless,
      args: launchArgs,
      userDataDir: BROWSER_PROFILE_DIR
    });

    const page = await browser.newPage();
    if (AVITO_PROXY_USERNAME && AVITO_PROXY_PASSWORD) {
      await page.authenticate({
        username: AVITO_PROXY_USERNAME,
        password: AVITO_PROXY_PASSWORD
      });
    }

    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    const mergedListings = [];
    const seen = new Set();

    for (const target of targets) {
      const baseUrl = buildAvitoUrl(citySlug, target);

      for (let pageNumber = pageFrom; pageNumber <= pageTo; pageNumber += 1) {
        const avitoUrl = buildPagedUrl(baseUrl, pageNumber);
        let listings = [];
        let matchedListings = [];
        let noResultsPage = false;
        const pageIndex = pageNumber - pageFrom + 1;

        for (let attempt = 1; attempt <= PAGE_FETCH_RETRIES; attempt += 1) {
          console.log(
            `Открываем Авито: ${avitoUrl} (${target.propertyLabel}, ${target.dealLabel}, страница ${pageNumber} [${pageIndex}/${pages}], попытка ${attempt}/${PAGE_FETCH_RETRIES})`
          );

          await page.goto(avitoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });
          await sleep(2500 + Math.min(attempt * 400, 1200));

          const pageInfo = await getPageSnapshot(page);
          if (isAccessBlocked(pageInfo.title, pageInfo.text)) {
            if (allowManualCaptcha && !headless) {
              await waitForManualCaptcha(page);
              const pageAfterCaptcha = await getPageSnapshot(page);
              if (isAccessBlocked(pageAfterCaptcha.title, pageAfterCaptcha.text)) {
                throw new Error(
                  'Капча пройдена, но Avito всё ещё ограничивает доступ. Попробуй другой IP/proxy.'
                );
              }
            } else {
              throw new Error(
                'Avito ограничил доступ (капча/блокировка IP). Включи ручной режим капчи в интерфейсе (или установи HEADLESS=false и ALLOW_MANUAL_CAPTCHA=true), либо используй proxy.'
              );
            }
          }

          noResultsPage = isNoResultsPage(pageInfo.text);
          listings = await extractListings(page);
          matchedListings = listings
            .filter((listing) => listingMatchesTarget(listing, target))
            .map((listing) => enrichListing(listing, target, avitoUrl, pageNumber))
            .filter((listing) => listingPassesValueFilters(listing, valueFilters));

          console.log(
            `Найдено в категории ${target.propertyLabel} / ${target.dealLabel}, стр ${pageNumber}: raw=${listings.length}, afterFilter=${matchedListings.length}, noResultsPage=${noResultsPage}`
          );

          if (listings.length > 0 || noResultsPage || attempt === PAGE_FETCH_RETRIES) {
            break;
          }

          console.log(
            `Страница вернула 0 карточек, повторяю загрузку (стр ${pageNumber})...`
          );
          await sleep(1200);
        }

        for (const listing of matchedListings) {
          const key =
            (listing.url && listing.url !== '#' && listing.url) ||
            `${listing.id}-${target.propertyKey}-${target.dealKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          mergedListings.push(listing);
        }

        if (listings.length === 0 || noResultsPage) {
          break;
        }
      }
    }

    return mergedListings;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Главная страница
app.get('/', (req, res) => {
  res.render('index', { maxPages: MAX_PAGES });
});

// Парсинг Авито
let isParsing = false;

app.get('/parse', async (req, res) => {
  if (isParsing) {
    return res.status(409).json({
      status: 'error',
      message: 'Парсинг уже выполняется. Дождись его завершения и повтори попытку.'
    });
  }

  isParsing = true;
  try {
    const cityInput = String(req.query.city || '').trim();
    const city = normalizeCitySlug(cityInput);
    const manualCaptcha = toBool(req.query.manualCaptcha);
    const pageRange = normalizePageRange(
      req.query.pageFrom,
      req.query.pageTo,
      req.query.pages
    );
    const pageFrom = pageRange.pageFrom;
    const pageTo = pageRange.pageTo;
    const pages = pageRange.pages;
    const dealFilter = normalizeDealFilter(req.query.deal);
    const propertyFilter = normalizePropertyFilter(
      req.query.propertyType || req.query.property
    );
    const minPrice = normalizeNumericOrNull(req.query.minPrice);
    const maxPrice = normalizeNumericOrNull(req.query.maxPrice);
    const minArea = normalizeNumericOrNull(req.query.minArea);
    const maxArea = normalizeNumericOrNull(req.query.maxArea);
    const rooms = normalizeRoomsFilter(req.query.rooms);

    const priceFrom = minPrice;
    const priceTo =
      maxPrice !== null && minPrice !== null && maxPrice < minPrice
        ? minPrice
        : maxPrice;
    const areaFrom = minArea;
    const areaTo =
      maxArea !== null && minArea !== null && maxArea < minArea
        ? minArea
        : maxArea;

    const valueFilters = {
      minPrice: priceFrom,
      maxPrice: priceTo,
      minArea: areaFrom,
      maxArea: areaTo,
      rooms
    };

    const targets = resolveSearchTargets(dealFilter, propertyFilter);
    const sourceUrls = targets.flatMap((target) =>
      Array.from({ length: pages }, (_, index) =>
        buildPagedUrl(buildAvitoUrl(city, target), pageFrom + index)
      )
    );

    const parseOptions = manualCaptcha
      ? {
          headless: false,
          allowManualCaptcha: true,
          targets,
          pageFrom,
          pageTo,
          pages,
          valueFilters
        }
      : {
          headless: HEADLESS,
          allowManualCaptcha: ALLOW_MANUAL_CAPTCHA,
          targets,
          pageFrom,
          pageTo,
          pages,
          valueFilters
        };

    const listings = await parseAvitoListings(city, parseOptions);
    saveListings(listings, {
      city,
      cityInput: cityInput || city,
      pages,
      pageFrom,
      pageTo,
      dealFilter,
      propertyFilter,
      dealLabel: getDealFilterLabel(dealFilter),
      propertyLabel: getPropertyFilterLabel(propertyFilter),
      valueFilters,
      sourceUrls,
      manualCaptcha,
      targets: targets.map((target) => ({
        deal: target.dealKey,
        propertyType: target.propertyKey,
        dealLabel: target.dealLabel,
        propertyLabel: target.propertyLabel,
        urls: Array.from({ length: pages }, (_, index) =>
          buildPagedUrl(buildAvitoUrl(city, target), pageFrom + index)
        )
      }))
    });
    console.log(
      `Парсинг завершён. Город: ${city}. ${getPropertyFilterLabel(propertyFilter)} / ${getDealFilterLabel(dealFilter)}. Страницы: ${pageFrom}-${pageTo} (${pages}). Найдено: ${listings.length} объявлений`
    );

    res.json({
      status: 'success',
      message: `Парсинг завершён. Город: ${city}. ${getPropertyFilterLabel(propertyFilter)} / ${getDealFilterLabel(dealFilter)}. Страницы: ${pageFrom}-${pageTo} (${pages}). Найдено: ${listings.length} объявлений`,
      count: listings.length,
      city,
      pages,
      pageFrom,
      pageTo,
      dealFilter,
      propertyFilter,
      valueFilters,
      sourceUrls
    });
  } catch (error) {
    console.error('Ошибка парсинга:', error.message);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Ошибка парсинга'
    });
  } finally {
    isParsing = false;
  }
});

// Страница с результатами
app.get('/results', (req, res) => {
  const { listings, meta } = readListings();
  const error =
    listings.length === 0
      ? 'Данные не найдены. Сначала запусти парсинг на главной странице.'
      : null;

  res.render('results', { listings, error, meta });
});

app.get('/download/csv', (req, res) => {
  const { listings, meta } = readListings();
  if (!Array.isArray(listings) || listings.length === 0) {
    return res.status(404).send('Нет данных для экспорта');
  }

  const city = String(meta?.city || 'all').replace(/[^a-z0-9-_]/gi, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `avito_${city}_${timestamp}.csv`;
  const csv = `\uFEFF${buildCsv(listings)}`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
});

app.get('/download/excel', (req, res) => {
  const { listings, meta } = readListings();
  if (!Array.isArray(listings) || listings.length === 0) {
    return res.status(404).send('Нет данных для экспорта');
  }

  const city = String(meta?.city || 'all').replace(/[^a-z0-9-_]/gi, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `avito_${city}_${timestamp}.xls`;
  const excel = buildExcelXml(listings);

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(excel);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  buildCsv,
  buildExcelXml,
  listingPassesValueFilters,
  normalizeCitySlug,
  normalizePageRange,
  normalizeRoomsFilter,
  parseAreaValue,
  parseBuildYear,
  parsePriceValue,
  parseRoomsValue,
  protectSpreadsheetFormula
};
