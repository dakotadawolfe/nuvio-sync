const assert = require('node:assert/strict');
const test = require('node:test');

const bleachKai = require('../addon/lib/bleachKai');

const originalBaseUrl = process.env.BLEACH_KAI_ADDON_BASE_URL;

test.beforeEach(() => {
  process.env.BLEACH_KAI_ADDON_BASE_URL = 'https://example.com/private-token';
});

test.after(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.BLEACH_KAI_ADDON_BASE_URL;
  } else {
    process.env.BLEACH_KAI_ADDON_BASE_URL = originalBaseUrl;
  }
});

test('injects Bleach Kai into matching first-page series searches', () => {
  const existing = [{ id: 'tt0434665', type: 'series', name: 'Bleach' }];
  const result = bleachKai.injectSearchMeta(existing, 'series', 'bleach', 1);

  assert.equal(result[0].id, 'tvdb:bleach-kai');
  assert.equal(result[0].name, 'Bleach Kai');
  assert.deepEqual(result.slice(1), existing);
});

test('does not inject into unrelated, movie, or later-page searches', () => {
  assert.deepEqual(bleachKai.injectSearchMeta([], 'series', 'dragon ball', 1), []);
  assert.deepEqual(bleachKai.injectSearchMeta([], 'movie', 'bleach kai', 1), []);
  assert.deepEqual(bleachKai.injectSearchMeta([], 'series', 'bleach kai', 2), []);
});

test('uses an existing manifest prefix and translates episode IDs', () => {
  assert.equal(bleachKai.toPublicVideoId('bleach-kai:1:12'), 'tvdb:bleach-kai:1:12');
  assert.equal(bleachKai.toUpstreamVideoId('tvdb:bleach-kai:1:12'), 'bleach-kai:1:12');
  assert.equal(bleachKai.isSeriesId('tvdb:bleach-kai'), true);
  assert.equal(bleachKai.isVideoId('tvdb:bleach-kai:1:12'), true);
});

test('stays disabled when the private upstream is not configured', () => {
  delete process.env.BLEACH_KAI_ADDON_BASE_URL;
  assert.deepEqual(bleachKai.injectSearchMeta([], 'series', 'bleach kai', 1), []);
});
