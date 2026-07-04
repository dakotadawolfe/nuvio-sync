const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const proxyModulePath = path.resolve(__dirname, '../dist/server/lib/openSubtitlesProxy.js');

function loadOpenSubtitlesProxyWithMocks({ httpGet, resolveAllIds } = {}) {
  delete require.cache[proxyModulePath];

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === './getCache') {
      return {
        cacheWrapGlobal: async (_key, fn) => fn(),
      };
    }
    if (request === './redisClient') {
      return { status: 'end' };
    }
    if (request === './id-resolver') {
      return {
        resolveAllIds: resolveAllIds || (async () => ({ imdbId: 'tt1843866' })),
      };
    }
    if (request === '../utils/httpClient') {
      return {
        httpGet: httpGet || (async () => ({ data: { subtitles: [] } })),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(proxyModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function withEnv(updates, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('configured SubDL key appends English subtitles to OpenSubtitles results', async () => {
  await withEnv({ SUBDL_API_KEY: undefined }, async () => {
    const requestedUrls = [];
    const proxy = loadOpenSubtitlesProxyWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        requestedUrls.push(parsed);

        if (parsed.hostname === 'opensubtitles-v3.strem.io') {
          return {
            data: {
              subtitles: [
                {
                  id: 'os-cze',
                  url: 'https://opensubtitles.example/cze.srt',
                  lang: 'cze',
                },
              ],
            },
          };
        }

        if (parsed.hostname === 'api.subdl.com') {
          assert.equal(parsed.pathname, '/api/v1/subtitles');
          assert.equal(parsed.searchParams.get('api_key'), 'subdl-key-1');
          assert.equal(parsed.searchParams.get('imdb_id'), 'tt1843866');
          assert.equal(parsed.searchParams.get('type'), 'movie');
          assert.equal(parsed.searchParams.get('languages'), 'EN');
          assert.equal(parsed.searchParams.get('unpack'), '1');
          assert.equal(parsed.searchParams.get('subs_per_page'), '30');

          return {
            data: {
              status: true,
              subtitles: [
                {
                  release_name: 'Captain America The Winter Soldier 2014 1080p BluRay',
                  name: 'Captain.America.The.Winter.Soldier.2014.1080p.BluRay.srt',
                  url: '/subtitle/3197651-3213944.zip',
                  lang: 'english',
                  hi: false,
                },
              ],
            },
          };
        }

        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const payload = await proxy.fetchOpenSubtitles(
      'movie',
      'tt1843866',
      undefined,
      { apiKeys: { subdl: 'subdl-key-1' } },
      ''
    );

    assert.equal(payload.subtitles.length, 2);
    assert.equal(payload.subtitles[0].lang, 'cze');
    assert.equal(payload.subtitles[1].lang, 'eng');
    assert.equal(payload.subtitles[1].source, 'subdl');
    assert.match(payload.subtitles[1].id, /^subdl:/);
    assert.equal(payload.subtitles[1].url, 'https://dl.subdl.com/subtitle/3197651-3213944.zip');
    assert.match(payload.subtitles[1].name, /Captain America/);
    assert.equal(requestedUrls.filter((url) => url.hostname === 'api.subdl.com').length, 1);
  });
});

test('SubDL lookup is skipped when neither config nor environment provides an API key', async () => {
  await withEnv({ SUBDL_API_KEY: undefined }, async () => {
    const requestedHosts = [];
    const proxy = loadOpenSubtitlesProxyWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        requestedHosts.push(parsed.hostname);
        return {
          data: {
            subtitles: [
              {
                id: 'os-eng',
                url: 'https://opensubtitles.example/eng.srt',
                lang: 'eng',
              },
            ],
          },
        };
      },
    });

    const payload = await proxy.fetchOpenSubtitles(
      'movie',
      'tt0434409',
      undefined,
      { apiKeys: {} },
      ''
    );

    assert.equal(payload.subtitles.length, 1);
    assert.deepEqual(requestedHosts, ['opensubtitles-v3.strem.io']);
  });
});

