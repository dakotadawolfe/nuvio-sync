const consola: any = require('consola');
const { cacheWrapGlobal }: any = require('./getCache');
const redis: any = require('./redisClient');
const { resolveAllIds }: any = require('./id-resolver');
const { httpGet }: any = require('../utils/httpClient');

const logger: any = consola.withTag('OpenSubtitlesProxy');
const OPEN_SUBTITLES_V3_BASE_URL = (process.env.OPENSUBTITLES_V3_URL || 'https://opensubtitles-v3.strem.io').replace(/\/+$/, '');
const OPEN_SUBTITLES_TTL_SECONDS = parsePositiveInt(process.env.OPENSUBTITLES_V3_TTL, 6 * 60 * 60);

interface SubtitleIdParts {
  baseId: string;
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
  const { data } = await httpGet(url, { timeout: 10000 });
  return sanitizeSubtitlesPayload(data);
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
    ].join(':');

    const fetchPayload = () => requestOpenSubtitlesPayload(normalizedType, openSubtitlesId, extra, queryString);

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
  resolveOpenSubtitlesId,
  splitSubtitleId,
};

module.exports = {
  fetchOpenSubtitles,
  resolveOpenSubtitlesId,
  splitSubtitleId,
};
