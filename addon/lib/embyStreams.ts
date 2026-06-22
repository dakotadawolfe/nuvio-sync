const crypto: any = require('crypto');
const consola: any = require('consola');
const buildInfo: any = require('./buildInfo');
const { resolveAllIds }: any = require('./id-resolver');
const { httpGet, httpPost }: any = require('../utils/httpClient');

const logger: any = consola.withTag('EmbyStreams');
const EMBY_TIMEOUT_MS = parsePositiveInt(process.env.EMBY_TIMEOUT_MS, 10000);
const EMBY_ITEM_CACHE_TTL_MS = parsePositiveInt(process.env.EMBY_ITEM_CACHE_TTL_SECONDS, 5 * 60) * 1000;
const EMBY_APP_NAME = 'AIO Addon';

const DEFAULT_FIELDS = [
  'ProviderIds',
  'RunTimeTicks',
  'MediaSources',
  'Path',
].join(',');

interface EmbyTokenConfig {
  serverUrl: string;
  accessToken: string;
  userId: string;
}

interface EmbySession {
  serverUrl: string;
  accessToken: string;
  userId: string;
}

interface EmbyMediaSource {
  Id?: string;
  Name?: string;
  Protocol?: string;
  Container?: string;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  TranscodingUrl?: string;
}

interface EmbyItem {
  Id: string;
  Type?: string;
  Name?: string;
  IsFolder?: boolean;
  LocationType?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  MediaSources?: EmbyMediaSource[];
}

interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

interface ParsedStreamId {
  baseId: string;
  season?: number;
  episode?: number;
}

const itemCache = new Map<string, CachedValue<any>>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCached<T>(cache: Map<string, CachedValue<T>>, key: string): T | null {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function setCached<T>(cache: Map<string, CachedValue<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

function hashCacheKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Emby server URL must start with http:// or https://');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function appendQuery(url: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }

  const serialized = params.toString();
  return serialized ? `${url}?${serialized}` : url;
}

function buildEmbyUrl(
  serverUrl: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {}
): string {
  return appendQuery(`${normalizeBaseUrl(serverUrl)}${path}`, query);
}

function authHeader(): string {
  const version = String(buildInfo.version || '1.0.0').replace(/"/g, '');
  return `MediaBrowser Client="${EMBY_APP_NAME}", Device="${EMBY_APP_NAME}", DeviceId="aio-addon", Version="${version}"`;
}

async function authenticateEmby(serverUrl: string, username: string, password: string): Promise<EmbySession> {
  const trimmedServerUrl = (serverUrl || '').trim();
  const trimmedUsername = (username || '').trim();

  if (!trimmedServerUrl || !trimmedUsername || !password) {
    throw new Error('Emby server URL, username, and password are required');
  }

  const normalizedServerUrl = normalizeBaseUrl(trimmedServerUrl);

  const { data } = await httpPost(
    buildEmbyUrl(normalizedServerUrl, '/Users/AuthenticateByName'),
    {
      Username: trimmedUsername,
      Pw: password,
    },
    {
      timeout: EMBY_TIMEOUT_MS,
      headers: {
        'X-Emby-Authorization': authHeader(),
      },
    }
  );

  const accessToken = data?.AccessToken;
  const userId = data?.User?.Id;
  if (typeof accessToken !== 'string' || typeof userId !== 'string') {
    throw new Error('Emby authentication response did not include an access token and user id');
  }

  return {
    serverUrl: normalizedServerUrl,
    accessToken,
    userId,
  };
}

function getEmbyTokenConfig(config: any): EmbyTokenConfig | null {
  const apiKeys = config?.apiKeys || {};
  const server = apiKeys.embyServer || config?.emby?.serverUrl || config?.emby?.url;
  const accessToken = apiKeys.embyAccessToken || config?.emby?.accessToken;
  const userId = apiKeys.embyUserId || config?.emby?.userId;

  if (!server?.trim() || !accessToken?.trim() || !userId?.trim()) {
    return null;
  }

  return {
    serverUrl: normalizeBaseUrl(server.trim()),
    accessToken: accessToken.trim(),
    userId: userId.trim(),
  };
}

async function getEmbySession(config: any): Promise<EmbySession | null> {
  const tokenConfig = getEmbyTokenConfig(config);
  if (!tokenConfig) {
    return null;
  }

  return tokenConfig;
}

async function getEmbyJson<T>(
  session: EmbySession,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  cacheKey: string
): Promise<T> {
  const scopedCacheKey = hashCacheKey(`${session.serverUrl}\0${session.userId}\0${cacheKey}`);
  const cached = getCached<T>(itemCache, scopedCacheKey);
  if (cached) {
    return cached;
  }

  const { data } = await httpGet(
    buildEmbyUrl(session.serverUrl, path, {
      ...query,
      api_key: session.accessToken,
    }),
    {
      timeout: EMBY_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
      },
    }
  );

  return setCached(itemCache, scopedCacheKey, data as T, EMBY_ITEM_CACHE_TTL_MS);
}

function normalizeContentType(type: string): 'movie' | 'series' | null {
  if (type === 'movie' || type === 'anime.movie') {
    return 'movie';
  }
  if (type === 'series' || type === 'anime.series' || type === 'anime') {
    return 'series';
  }
  return null;
}

function parseStreamId(type: 'movie' | 'series', id: string): ParsedStreamId | null {
  if (!id || typeof id !== 'string') {
    return null;
  }

  const cleanId = id.trim();
  if (!cleanId) {
    return null;
  }

  if (type === 'movie') {
    return { baseId: cleanId };
  }

  const match = cleanId.match(/^(.+):(\d+):(\d+)$/);
  if (!match) {
    return { baseId: cleanId };
  }

  return {
    baseId: match[1],
    season: Number(match[2]),
    episode: Number(match[3]),
  };
}

async function resolveImdbId(type: 'movie' | 'series', id: string, config: any): Promise<string | null> {
  if (/^tt\d+$/i.test(id)) {
    return id.toLowerCase();
  }

  const resolvedIds = await resolveAllIds(id, type, config || {}, {}, ['imdb']);
  return resolvedIds?.imdbId || null;
}

async function findByImdbProviderId(session: EmbySession, type: 'movie' | 'series', imdbId: string): Promise<EmbyItem | null> {
  const includeItemTypes = type === 'movie' ? 'Movie' : 'Series';
  const body = await getEmbyJson<{ Items?: EmbyItem[] }>(
    session,
    `/Users/${encodeURIComponent(session.userId)}/Items`,
    {
      IncludeItemTypes: includeItemTypes,
      Recursive: true,
      AnyProviderIdEquals: `imdb.${imdbId.toLowerCase()}`,
      Limit: 1,
      Fields: DEFAULT_FIELDS,
    },
    `find:${type}:${imdbId.toLowerCase()}`
  );

  return body?.Items?.[0] || null;
}

async function getItem(session: EmbySession, itemId: string): Promise<EmbyItem | null> {
  const item = await getEmbyJson<EmbyItem>(
    session,
    `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`,
    {
      Fields: DEFAULT_FIELDS,
    },
    `item:${itemId}`
  );

  return item?.Id ? item : null;
}

async function getSeriesEpisodes(session: EmbySession, seriesId: string): Promise<EmbyItem[]> {
  const body = await getEmbyJson<{ Items?: EmbyItem[] }>(
    session,
    `/Shows/${encodeURIComponent(seriesId)}/Episodes`,
    {
      UserId: session.userId,
      Fields: DEFAULT_FIELDS,
    },
    `episodes:${seriesId}`
  );

  return body?.Items || [];
}

async function ensureMediaSources(session: EmbySession, item: EmbyItem): Promise<EmbyItem> {
  if (Array.isArray(item.MediaSources) && item.MediaSources.length > 0) {
    return item;
  }

  const hydratedItem = await getItem(session, item.Id);
  return hydratedItem || item;
}

function isDirectPlayableSource(source: EmbyMediaSource): boolean {
  const supportedDirectPlay = source.SupportsDirectPlay !== false;
  const supportedDirectStream = source.SupportsDirectStream !== false;
  const hasTranscodingUrl = Boolean(source.TranscodingUrl);
  return supportedDirectPlay && supportedDirectStream && !hasTranscodingUrl && source.Protocol?.toLowerCase() !== 'rtmp';
}

function selectDirectPlayableSource(item: EmbyItem): EmbyMediaSource | null {
  if (item.IsFolder || item.LocationType === 'Virtual') {
    return null;
  }

  return item.MediaSources?.find(isDirectPlayableSource) || null;
}

function buildStaticStreamUrl(session: EmbySession, itemId: string): string {
  return buildEmbyUrl(session.serverUrl, `/Videos/${encodeURIComponent(itemId)}/stream`, {
    static: 'true',
    api_key: session.accessToken,
  });
}

function toEmbyStream(session: EmbySession, item: EmbyItem): any | null {
  const mediaSource = selectDirectPlayableSource(item);
  if (!mediaSource) {
    return null;
  }

  const quality = mediaSource.Bitrate ? `${Math.round(mediaSource.Bitrate / 1_000_000)} Mbps` : '';
  const container = mediaSource.Container ? mediaSource.Container.toUpperCase() : '';
  const details = [container, quality].filter(Boolean).join(' - ');

  return {
    name: 'Emby',
    title: details ? `Emby\n${details}` : 'Emby',
    url: buildStaticStreamUrl(session, item.Id),
    behaviorHints: {
      notWebReady: false,
    },
  };
}

async function getEmbyMovieStream(session: EmbySession, id: string, config: any): Promise<any | null> {
  const imdbId = await resolveImdbId('movie', id, config);
  if (!imdbId) {
    return null;
  }

  const movie = await findByImdbProviderId(session, 'movie', imdbId);
  if (!movie) {
    return null;
  }

  return toEmbyStream(session, await ensureMediaSources(session, movie));
}

async function getEmbySeriesStream(session: EmbySession, id: string, config: any): Promise<any | null> {
  const parsed = parseStreamId('series', id);
  if (!parsed?.season || !parsed?.episode) {
    return null;
  }

  const imdbId = await resolveImdbId('series', parsed.baseId, config);
  if (!imdbId) {
    return null;
  }

  const series = await findByImdbProviderId(session, 'series', imdbId);
  if (!series) {
    return null;
  }

  const episodes = await getSeriesEpisodes(session, series.Id);
  const episode = episodes.find((candidate) =>
    candidate.ParentIndexNumber === parsed.season &&
    candidate.IndexNumber === parsed.episode
  );

  if (!episode) {
    return null;
  }

  return toEmbyStream(session, await ensureMediaSources(session, episode));
}

async function getEmbyStreams(type: string, id: string, config: any): Promise<{ streams: any[] }> {
  const contentType = normalizeContentType(type);
  if (!contentType) {
    return { streams: [] };
  }

  try {
    const session = await getEmbySession(config);
    if (!session) {
      return { streams: [] };
    }

    const stream = contentType === 'movie'
      ? await getEmbyMovieStream(session, id, config)
      : await getEmbySeriesStream(session, id, config);

    return { streams: stream ? [stream] : [] };
  } catch (error: any) {
    logger.warn(`[Emby] Stream lookup failed for ${type}/${id}: ${error.message}`);
    return { streams: [] };
  }
}

function hasEmbyCredentials(config: any): boolean {
  try {
    return !!getEmbyTokenConfig(config);
  } catch {
    return false;
  }
}

export {
  authenticateEmby,
  getEmbyStreams,
  hasEmbyCredentials,
  normalizeBaseUrl,
  buildEmbyUrl,
};

module.exports = {
  authenticateEmby,
  getEmbyStreams,
  hasEmbyCredentials,
  normalizeBaseUrl,
  buildEmbyUrl,
};
