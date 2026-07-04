const consola: any = require('consola');
const crypto: any = require('crypto');
const { cacheWrapGlobal }: any = require('./getCache');
const redis: any = require('./redisClient');
const { resolveAllIds }: any = require('./id-resolver');
const { httpGet }: any = require('../utils/httpClient');

const logger: any = consola.withTag('OpenSubtitlesProxy');
const OPEN_SUBTITLES_V3_BASE_URL = (process.env.OPENSUBTITLES_V3_URL || 'https://opensubtitles-v3.strem.io').replace(/\/+$/, '');
const OPEN_SUBTITLES_TTL_SECONDS = parsePositiveInt(process.env.OPENSUBTITLES_V3_TTL, 6 * 60 * 60);
const SUBDL_API_BASE_URL = (process.env.SUBDL_API_URL || 'https://api.subdl.com/api/v1').replace(/\/+$/, '');
const SUBDL_DOWNLOAD_BASE_URL = (process.env.SUBDL_DOWNLOAD_URL || 'https://dl.subdl.com').replace(/\/+$/, '');
const SUBDL_LANGUAGES = (process.env.SUBDL_LANGUAGES || 'EN').trim() || 'EN';
const SUBDL_SUBS_PER_PAGE = Math.min(parsePositiveInt(process.env.SUBDL_SUBS_PER_PAGE, 30), 30);
const SUBTITLE_PROVIDER_TIMEOUT_MS = parsePositiveInt(process.env.SUBTITLE_PROVIDER_TIMEOUT_MS, 10000);

interface SubtitleIdParts {
  baseId: string;
  season?: string;
  episode?: string;
}

interface SubdlLookupParts {
  imdbId: string;
  season?: string;
  episode?: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSubtitleType(type: string): 'movie' | 'series' | null {
  if (type === 'movie' || type === 'anime.movie') {
    return 'movie';
  }

  if (type === 'series' || type === 'anime.series' || type === 'anime') {
    return 'series';
  }

  return null;
}

function splitSubtitleId(type: string, id: string): SubtitleIdParts | null {
  if (!id || typeof id !== 'string') {
    return null;
  }

  const cleanId = id.trim();
  if (!cleanId) {
    return null;
  }

  const parts = cleanId.split(':').map((part: string) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (type === 'movie') {
    return { baseId: cleanId };
  }

  if (parts[0].startsWith('tt')) {
    return {
      baseId: parts[0],
      season: parts[1],
      episode: parts[2],
    };
  }

  if (parts.length >= 4) {
    return {
      baseId: `${parts[0]}:${parts[1]}`,
      season: parts[2],
      episode: parts[3],
    };
  }

  if (parts.length >= 3 && ['kitsu', 'mal', 'anidb', 'anilist'].includes(parts[0])) {
    return {
      baseId: `${parts[0]}:${parts[1]}`,
      season: '1',
      episode: parts[2],
    };
  }

  return { baseId: cleanId };
}

async function resolveOpenSubtitlesId(type: string, id: string, config: any): Promise<string | null> {
  const normalizedType = normalizeSubtitleType(type);
  if (!normalizedType) {
    return null;
  }

  const parts = splitSubtitleId(normalizedType, id);
  if (!parts) {
    return null;
  }

  let imdbId = parts.baseId.startsWith('tt') ? parts.baseId : null;
  if (!imdbId) {
    const resolvedIds = await resolveAllIds(parts.baseId, normalizedType, config || {}, {}, ['imdb']);
    imdbId = resolvedIds?.imdbId || null;
  }

  if (!imdbId) {
    logger.debug(`[OpenSubtitles] Could not resolve IMDb ID for ${type}/${id}`);
    return null;
  }

  if (normalizedType === 'series' && parts.season && parts.episode) {
    return `${imdbId}:${parts.season}:${parts.episode}`;
  }

  return imdbId;
}

function sanitizeSubtitlesPayload(payload: any): { subtitles: any[] } {
  if (!payload || !Array.isArray(payload.subtitles)) {
    return { subtitles: [] };
  }

  return { subtitles: payload.subtitles };
}

function getConfiguredSubdlApiKey(config: any): string {
  const key = config?.apiKeys?.subdl || process.env.SUBDL_API_KEY || '';
  return typeof key === 'string' ? key.trim() : '';
}

function getSubdlCacheKeyPart(apiKey: string): string {
  if (!apiKey) {
    return 'no-subdl';
  }

  return `subdl-${crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
}

function splitResolvedSubtitleId(id: string): SubdlLookupParts | null {
  const parts = String(id || '').split(':').map((part) => part.trim()).filter(Boolean);
  if (!parts[0]?.startsWith('tt')) {
    return null;
  }

  return {
    imdbId: parts[0],
    season: parts[1],
    episode: parts[2],
  };
}

function buildSubdlSubtitleUrl(
  normalizedType: 'movie' | 'series',
  resolvedId: string,
  apiKey: string
): string | null {
  const parts = splitResolvedSubtitleId(resolvedId);
  if (!parts || !apiKey) {
    return null;
  }

  const url = new URL(`${SUBDL_API_BASE_URL}/subtitles`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('imdb_id', parts.imdbId);
  url.searchParams.set('type', normalizedType === 'series' ? 'tv' : 'movie');
  url.searchParams.set('languages', SUBDL_LANGUAGES);
  url.searchParams.set('subs_per_page', String(SUBDL_SUBS_PER_PAGE));
  url.searchParams.set('unpack', '1');

  if (normalizedType === 'series') {
    if (parts.season) {
      url.searchParams.set('season_number', parts.season);
    }
    if (parts.episode) {
      url.searchParams.set('episode_number', parts.episode);
    }
  }

  return url.toString();
}

function normalizeSubdlLanguage(value: any): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'eng';
  }

  const normalized = raw.toLowerCase().replace(/[_-].*$/, '').replace(/\s+/g, '');
  const languageMap: Record<string, string> = {
    ar: 'ara',
    arabic: 'ara',
    bg: 'bul',
    bulgarian: 'bul',
    cs: 'cze',
    czech: 'cze',
    da: 'dan',
    danish: 'dan',
    de: 'ger',
    deu: 'ger',
    german: 'ger',
    el: 'gre',
    greek: 'gre',
    en: 'eng',
    eng: 'eng',
    english: 'eng',
    es: 'spa',
    spanish: 'spa',
    fa: 'per',
    farsipersian: 'per',
    persian: 'per',
    fi: 'fin',
    finnish: 'fin',
    fr: 'fre',
    fra: 'fre',
    french: 'fre',
    he: 'heb',
    hebrew: 'heb',
    hi: 'hin',
    hindi: 'hin',
    id: 'ind',
    indonesian: 'ind',
    it: 'ita',
    italian: 'ita',
    ja: 'jpn',
    japanese: 'jpn',
    ko: 'kor',
    korean: 'kor',
    nl: 'dut',
    nld: 'dut',
    dutch: 'dut',
    no: 'nor',
    norwegian: 'nor',
    pl: 'pol',
    polish: 'pol',
    pt: 'por',
    portuguese: 'por',
    ro: 'rum',
    romanian: 'rum',
    ru: 'rus',
    russian: 'rus',
    sr: 'srp',
    serbian: 'srp',
    sv: 'swe',
    swedish: 'swe',
    tr: 'tur',
    turkish: 'tur',
    uk: 'ukr',
    ukrainian: 'ukr',
    zh: 'chi',
    chinese: 'chi',
  };

  return languageMap[normalized] || normalized.slice(0, 3);
}

function buildSubdlDownloadUrl(pathOrUrl: any): string | null {
  if (typeof pathOrUrl !== 'string') {
    return null;
  }

  const trimmed = pathOrUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${SUBDL_DOWNLOAD_BASE_URL}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

function getSubdlSubtitleName(entry: any): string {
  const releaseName = entry?.release_name || entry?.name || entry?.file_name || 'Subtitle';
  const hi = entry?.hi === true ? ' HI' : '';
  return `SubDL - ${releaseName}${hi}`;
}

function getSubdlSubtitleId(entry: any, url: string, index: number): string {
  const stableId = entry?.file_n_id || entry?.sd_id || entry?.n_id || entry?.id || entry?.md5 || url;
  return `subdl:${crypto.createHash('sha1').update(String(stableId)).digest('hex').slice(0, 16)}:${index}`;
}

function flattenSubdlSubtitleEntries(payload: any): any[] {
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const entries: any[] = [];

  for (const subtitle of subtitles) {
    if (Array.isArray(subtitle?.unpack_files) && subtitle.unpack_files.length > 0) {
      for (const file of subtitle.unpack_files) {
        entries.push({
          ...subtitle,
          ...file,
          release_name: file.release_name || subtitle.release_name,
          parent_name: subtitle.name,
        });
      }
      continue;
    }

    entries.push(subtitle);
  }

  return entries;
}

function normalizeSubdlPayload(payload: any): { subtitles: any[] } {
  if (!payload || payload.status === false) {
    return { subtitles: [] };
  }

  const subtitles: any[] = [];
  const entries = flattenSubdlSubtitleEntries(payload);

  entries.forEach((entry, index) => {
    const url = buildSubdlDownloadUrl(entry?.url);
    if (!url) {
      return;
    }

    subtitles.push({
      id: getSubdlSubtitleId(entry, url, index),
      url,
      lang: normalizeSubdlLanguage(entry?.language || entry?.lang),
      name: getSubdlSubtitleName(entry),
      source: 'subdl',
    });
  });

  return { subtitles };
}

function mergeSubtitlePayloads(...payloads: Array<{ subtitles?: any[] }>): { subtitles: any[] } {
  const seen = new Set<string>();
  const subtitles: any[] = [];

  for (const payload of payloads) {
    const entries = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
    for (const subtitle of entries) {
      const key = [
        String(subtitle?.lang || '').toLowerCase(),
        String(subtitle?.url || subtitle?.id || subtitle?.name || '').toLowerCase(),
      ].join(':');

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      subtitles.push(subtitle);
    }
  }

  return { subtitles };
}

function classifySubtitlesResult(result: any): { type: string; ttl: number | null } {
  if (Array.isArray(result?.subtitles) && result.subtitles.length > 0) {
    return { type: 'SUCCESS', ttl: null };
  }

  return { type: 'EMPTY_RESULT', ttl: 60 };
}

function isRedisReady(): boolean {
  return redis?.status === 'ready';
}

async function requestOpenSubtitlesPayload(
  type: string,
  id: string,
  extra?: string,
  queryString?: string
): Promise<{ subtitles: any[] }> {
  const url = buildRemoteSubtitleUrl(type, id, extra, queryString);
  const { data } = await httpGet(url, { timeout: SUBTITLE_PROVIDER_TIMEOUT_MS });
  return sanitizeSubtitlesPayload(data);
}

async function requestSubdlPayload(
  normalizedType: 'movie' | 'series',
  resolvedId: string,
  apiKey: string
): Promise<{ subtitles: any[] }> {
  const url = buildSubdlSubtitleUrl(normalizedType, resolvedId, apiKey);
  if (!url) {
    return { subtitles: [] };
  }

  const { data } = await httpGet(url, { timeout: SUBTITLE_PROVIDER_TIMEOUT_MS });
  return normalizeSubdlPayload(data);
}

function buildRemoteSubtitleUrl(type: string, id: string, extra?: string, queryString?: string): string {
  const extraPath = extra ? `/${encodeURI(extra).replace(/#/g, '%23')}` : '';
  const pathParts = [
    'subtitles',
    encodeURIComponent(type),
    `${encodeURIComponent(id)}${extraPath}.json`,
  ];
  return `${OPEN_SUBTITLES_V3_BASE_URL}/${pathParts.join('/')}${queryString || ''}`;
}

async function fetchOpenSubtitles(
  type: string,
  id: string,
  extra: string | undefined,
  config: any,
  queryString = ''
): Promise<{ subtitles: any[] }> {
  const normalizedType = normalizeSubtitleType(type);
  if (!normalizedType) {
    return { subtitles: [] };
  }

  try {
    const openSubtitlesId = await resolveOpenSubtitlesId(type, id, config);
    if (!openSubtitlesId) {
      return { subtitles: [] };
    }

    const cacheKey = [
      'opensubtitles-v3',
      normalizedType,
      openSubtitlesId,
      extra || 'no-extra',
      queryString || 'no-query',
      getSubdlCacheKeyPart(getConfiguredSubdlApiKey(config)),
    ].join(':');

    const fetchPayload = async () => {
      const subdlApiKey = getConfiguredSubdlApiKey(config);
      const [openSubtitlesResult, subdlResult] = await Promise.allSettled([
        requestOpenSubtitlesPayload(normalizedType, openSubtitlesId, extra, queryString),
        subdlApiKey
          ? requestSubdlPayload(normalizedType, openSubtitlesId, subdlApiKey)
          : Promise.resolve({ subtitles: [] }),
      ]);

      const openSubtitlesPayload = openSubtitlesResult.status === 'fulfilled'
        ? openSubtitlesResult.value
        : { subtitles: [] };
      const subdlPayload = subdlResult.status === 'fulfilled'
        ? subdlResult.value
        : { subtitles: [] };

      if (openSubtitlesResult.status === 'rejected') {
        logger.warn(`[OpenSubtitles] Provider lookup failed for ${type}/${id}: ${openSubtitlesResult.reason?.message || openSubtitlesResult.reason}`);
      }
      if (subdlResult.status === 'rejected') {
        logger.warn(`[SubDL] Provider lookup failed for ${type}/${id}: ${subdlResult.reason?.message || subdlResult.reason}`);
      }

      const mergedPayload = mergeSubtitlePayloads(openSubtitlesPayload, subdlPayload);
      logger.debug(`[Subtitles] Provider results for ${type}/${id}: opensubtitles=${openSubtitlesPayload.subtitles.length}, subdl=${subdlPayload.subtitles.length}, merged=${mergedPayload.subtitles.length}`);
      return mergedPayload;
    };

    if (!isRedisReady()) {
      return await fetchPayload();
    }

    try {
      return await cacheWrapGlobal(
        cacheKey,
        fetchPayload,
        OPEN_SUBTITLES_TTL_SECONDS,
        { skipVersion: true, maxRetries: 1, resultClassifier: classifySubtitlesResult }
      );
    } catch (cacheError: any) {
      logger.warn(`[OpenSubtitles] Cached lookup failed for ${type}/${id}; retrying direct: ${cacheError.message}`);
      return await fetchPayload();
    }
  } catch (error: any) {
    logger.warn(`[OpenSubtitles] Subtitle lookup failed for ${type}/${id}: ${error.message}`);
    return { subtitles: [] };
  }
}

export {
  fetchOpenSubtitles,
  mergeSubtitlePayloads,
  normalizeSubdlPayload,
  resolveOpenSubtitlesId,
  splitSubtitleId,
};

module.exports = {
  fetchOpenSubtitles,
  mergeSubtitlePayloads,
  normalizeSubdlPayload,
  resolveOpenSubtitlesId,
  splitSubtitleId,
};
