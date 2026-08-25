const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../index');

test('normalizes an Avito city slug without losing underscores', () => {
  assert.equal(normalizeCitySlug('nizhniy_novgorod'), 'nizhniy_novgorod');
  assert.equal(normalizeCitySlug(' Москва '), 'moskva');
  assert.equal(normalizeCitySlug(''), 'moskva');
});

test('limits a page range to a safe number of pages', () => {
  assert.deepEqual(normalizePageRange('3', '30'), {
    pageFrom: 3,
    pageTo: 12,
    pages: 10
  });
  assert.deepEqual(normalizePageRange('5', '2'), {
    pageFrom: 5,
    pageTo: 5,
    pages: 1
  });
});

test('parses real-estate numeric fields', () => {
  assert.equal(parsePriceValue('9 500 000 ₽'), 9500000);
  assert.equal(parsePriceValue('Цена по запросу'), null);
  assert.equal(parseAreaValue('Дом 110,4 м² на участке 7 сот.'), 110.4);
  assert.equal(parseRoomsValue('3-комн. квартира'), 3);
  assert.equal(parseRoomsValue('Квартира-студия'), 0);
  assert.equal(parseBuildYear('Год постройки: 2020'), 2020);
});

test('normalizes room filters and applies numeric listing filters', () => {
  assert.deepEqual(normalizeRoomsFilter('studio, 1; 3'), [0, 1, 3]);

  const filters = {
    minPrice: 5000000,
    maxPrice: 10000000,
    minArea: 80,
    maxArea: 150,
    rooms: [3]
  };
  assert.equal(
    listingPassesValueFilters(
      { priceValue: 7000000, area: 110, rooms: 3 },
      filters
    ),
    true
  );
  assert.equal(
    listingPassesValueFilters(
      { priceValue: 7000000, area: 110, rooms: 2 },
      filters
    ),
    false
  );
});

test('protects CSV and Excel exports from spreadsheet formulas', () => {
  assert.equal(protectSpreadsheetFormula('=HYPERLINK("https://bad")'), "'=HYPERLINK(\"https://bad\")");

  const listing = { id: '1', title: '=2+2' };
  assert.match(buildCsv([listing]), /'=2\+2/);
  assert.match(buildExcelXml([listing]), /&apos;=2\+2/);
});
