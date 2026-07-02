const crypto: any = require('crypto');
const consola: any = require('consola');
const { request: undiciRequest }: any = require('undici');
const buildInfo: any = require('./buildInfo');
const { resolveAllIds }: any = require('./id-resolver');
const { httpGet, httpPost }: any = require('../utils/httpClient');

const logger: any = consola.withTag('EmbyStreams');
const EMBY_TIMEOUT_MS = parsePositiveInt(process.env.EMBY_TIMEOUT_MS, 10000);
const EMBY_ITEM_CACHE_TTL_MS = parsePositiveInt(process.env.EMBY_ITEM_CACHE_TTL_SECONDS, 5 * 60) * 1000;
const EMBY_STREAM_TOKEN_TTL_MS = parsePositiveInt(process.env.EMBY_STREAM_TOKEN_TTL_SECONDS, 6 * 60 * 60) * 1000;
const EMBY_PLAYBACK_PROGRESS_INTERVAL_MS = parsePositiveInt(process.env.EMBY_PLAYBACK_PROGRESS_INTERVAL_MS, 30_000);
const EMBY_REDIRECT_PLAYBACK_HEARTBEAT_MS = parsePositiveInt(
  process.env.EMBY_REDIRECT_PLAYBACK_HEARTBEAT_MS,
  parsePositiveInt(
    process.env.EMBY_REDIRECT_PLAYBACK_HEARTBEAT_SECONDS,
    parsePositiveInt(process.env.EMBY_STREAM_TOKEN_TTL_SECONDS, 6 * 60 * 60)
  ) * 1000
);
const EMBY_APP_NAME = 'AIO Addon';

const DEFAULT_FIELDS = [
  'ProviderIds',
  'RunTimeTicks',
  'Size',
  'FileName',
  'MediaStreams',
  'Container',
  'Bitrate',
  'MediaSources',
  'Path',
].join(',');

const SAFE_PROXY_HEADERS = [
  'content-range',
  'accept-ranges',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'cache-control',
];

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const inMemorySigningSecret = crypto.randomBytes(32).toString('hex');
let warnedEphemeralSigningSecret = false;
const playbackStopDebounces = new Map<string, any>();
const playbackProgressHeartbeats = new Map<string, { interval: any; timeout?: any }>();

interface EmbyTokenConfig {
  serverUrl: string;
  accessToken: string;
  userId: string;
  userUUID?: string;
  playbackClientId?: string;
  playbackDeviceName?: string;
}

interface EmbySession {
  serverUrl: string;
  accessToken: string;
  userId: string;
  userUUID?: string;
  playbackClientId?: string;
  playbackDeviceName?: string;
}

interface EmbyMediaStream {
  Type?: string;
  Codec?: string;
  Index?: number;
  IsDefault?: boolean;
  IsForced?: boolean;
}

interface EmbyMediaSource {
  Id?: string;
  Name?: string;
  Protocol?: string;
  Container?: string;
  Bitrate?: number;
  Size?: number;
  Path?: string;
  FileName?: string;
  RunTimeTicks?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  TranscodingUrl?: string;
  MediaStreams?: EmbyMediaStream[];
}

interface EmbyPlaybackInfo {
  PlaySessionId?: string;
  MediaSources?: EmbyMediaSource[];
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
  MediaStreams?: EmbyMediaStream[];
  Size?: number;
  Path?: string;
  FileName?: string;
  RunTimeTicks?: number;
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

interface SignedStreamPayload {
  userUUID: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  container: string;
  ext: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  playbackClientId?: string;
  playbackDeviceName?: string;
  expiresAt: number;
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

function firstHeaderValue(value: any): string {
  if (Array.isArray(value)) {
    return String(value[0] || '').trim();
  }
  return String(value || '').trim();
}

function getRequestHeader(req: any, name: string): string {
  const headers = req?.headers || {};
  return firstHeaderValue(headers[name] || headers[name.toLowerCase()]);
}

function firstForwardedAddress(value: string): string {
  return String(value || '').split(',')[0].trim();
}

function getEmbyPlaybackClientFromRequest(req: any): { playbackClientId?: string; playbackDeviceName?: string } {
  const address = firstForwardedAddress(
    getRequestHeader(req, 'cf-connecting-ip') ||
    getRequestHeader(req, 'x-real-ip') ||
    getRequestHeader(req, 'x-forwarded-for') ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    ''
  );
  const userAgent = getRequestHeader(req, 'user-agent');
  const platform = getRequestHeader(req, 'sec-ch-ua-platform');
  const clientHint = getRequestHeader(req, 'x-stremio-client') || getRequestHeader(req, 'x-nuvio-client');
  const fingerprintSource = [address, userAgent, platform, clientHint]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\0');

  if (!fingerprintSource) {
    return {};
  }

  const digest = crypto.createHash('sha256')
    .update(fingerprintSource)
    .digest('hex');
  return {
    playbackClientId: digest.slice(0, 32),
    playbackDeviceName: `${EMBY_APP_NAME} ${digest.slice(0, 8)}`,
  };
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

function normalizeBaseUrlForHash(rawUrl: string): string {
  try {
    return normalizeBaseUrl(rawUrl).toLowerCase();
  } catch {
    return String(rawUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  }
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

function getAddonHost(): string | null {
  const host = (process.env.HOST_NAME || '').trim();
  if (!host) {
    return null;
  }
  return host.startsWith('http://') || host.startsWith('https://') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`;
}

function sanitizeEmbyHeaderValue(value: string): string {
  return String(value || '').replace(/["\r\n]/g, '').trim();
}

function getEmbyDeviceId(input: {
  serverUrl?: string;
  userId?: string;
  userUUID?: string;
  userUuid?: string;
  playbackClientId?: string;
  clientPlaybackId?: string;
}): string {
  const serverUrl = normalizeBaseUrlForHash(input.serverUrl || '');
  const userId = String(input.userId || '').trim();
  const userUUID = String(input.userUUID || input.userUuid || userId || '').trim();
  const playbackClientId = String(input.playbackClientId || input.clientPlaybackId || '').trim();
  const digest = crypto.createHash('sha256')
    .update(`${serverUrl}\0${userId}\0${userUUID}\0${playbackClientId}`)
    .digest('hex')
    .slice(0, 32);
  return `aio-addon-${digest}`;
}

function buildEmbyAuthorizationHeader(input: {
  serverUrl?: string;
  userId?: string;
  userUUID?: string;
  userUuid?: string;
  playbackClientId?: string;
  clientPlaybackId?: string;
  playbackDeviceName?: string;
} = {}): string {
  const version = String(buildInfo.version || '1.0.0').replace(/"/g, '');
  const deviceId = getEmbyDeviceId(input);
  const deviceName = sanitizeEmbyHeaderValue(input.playbackDeviceName || EMBY_APP_NAME) || EMBY_APP_NAME;
  return `MediaBrowser Client="${EMBY_APP_NAME}", Device="${deviceName}", DeviceId="${deviceId}", Version="${version}"`;
}

function authHeader(session?: Partial<EmbySession>): string {
  return buildEmbyAuthorizationHeader(session || {});
}

function embyHeaders(session: EmbySession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    'X-Emby-Authorization': buildEmbyAuthorizationHeader(session),
  };
}

function debugEnabled(): boolean {
  return String(process.env.EMBY_DEBUG_PLAYBACK || '').toLowerCase() === 'true';
}

function redactUrlShape(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of ['api_key', 'access_token', 'token', 'signedToken']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '<redacted>');
      }
    }
    parsed.pathname = parsed.pathname.replace(/\/emby\/play\/[^/]+/i, '/emby/play/<signed-token>');
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(rawUrl).replace(/(api_key=)[^&\s]+/gi, '$1<redacted>');
  }
}

function debugPlayback(event: string, details: Record<string, any>): void {
  if (!debugEnabled()) {
    return;
  }
  const safeDetails: Record<string, any> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/token|api[_-]?key|password|secret/i.test(key)) {
      safeDetails[key] = '<redacted>';
    } else if (key.toLowerCase().includes('url') && typeof value === 'string') {
      safeDetails[key] = redactUrlShape(value);
    } else {
      safeDetails[key] = value;
    }
  }
  logger.debug(`[EmbyPlayback] ${event}`, safeDetails);
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
        'X-Emby-Authorization': authHeader({ serverUrl: normalizedServerUrl, userId: trimmedUsername, userUUID: trimmedUsername }),
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

function getConfigUserUUID(config: any): string | undefined {
  return config?.userUUID || config?.userUuid || config?.uuid;
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
    userUUID: getConfigUserUUID(config),
    playbackClientId: config?.playbackClientId,
    playbackDeviceName: config?.playbackDeviceName,
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
      headers: embyHeaders(session, {
        Accept: 'application/json',
      }),
    }
  );

  return setCached(itemCache, scopedCacheKey, data as T, EMBY_ITEM_CACHE_TTL_MS);
}

async function getPlaybackInfo(session: EmbySession, itemId: string, options: Record<string, string | number | boolean | undefined> = {}): Promise<EmbyPlaybackInfo> {
  const { data } = await httpGet(
    buildEmbyUrl(session.serverUrl, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      UserId: session.userId,
      ...options,
      api_key: session.accessToken,
    }),
    {
      timeout: EMBY_TIMEOUT_MS,
      headers: embyHeaders(session, {
        Accept: 'application/json',
      }),
    }
  );

  return data || {};
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

function normalizeContainer(container: string | undefined): string {
  return String(container || '')
    .split(/[,\s]+/)
    .find(Boolean)
    ?.trim()
    .toLowerCase() || '';
}

function getStreamExtension(container: string | undefined): string {
  const normalized = normalizeContainer(container);
  const extensionMap: Record<string, string> = {
    mp4: 'mp4',
    m4v: 'm4v',
    mkv: 'mkv',
    matroska: 'mkv',
    ts: 'ts',
    mpegts: 'ts',
    m2ts: 'm2ts',
    webm: 'webm',
  };
  return extensionMap[normalized] || '';
}

function isDirectPlayableSource(source: EmbyMediaSource): boolean {
  const protocol = String(source.Protocol || '').toLowerCase();
  if (protocol === 'rtmp') {
    return false;
  }
  if (source.SupportsDirectPlay === false) {
    return false;
  }
  return Boolean(source.Id || source.Path || source.FileName || source.Container || source.MediaStreams?.length);
}

function directPlaySourceScore(source: EmbyMediaSource): number {
  let score = 0;
  if (source.SupportsDirectPlay === true) score += 100;
  if (source.Protocol && ['file', 'http', 'https'].includes(source.Protocol.toLowerCase())) score += 30;
  if (source.Id) score += 20;
  if (source.Path || source.FileName) score += 10;
  if (source.Container) score += 5;
  if (source.Bitrate) score += Math.min(25, Math.round(source.Bitrate / 1_000_000));
  return score;
}

function selectDirectPlayableSource(sourceOrItem: EmbyMediaSource[] | EmbyItem): EmbyMediaSource | null {
  const sources = Array.isArray(sourceOrItem) ? sourceOrItem : sourceOrItem.MediaSources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const candidates = sources.filter(isDirectPlayableSource);
  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .slice()
    .sort((left, right) => directPlaySourceScore(right) - directPlaySourceScore(left))[0];
}

function generateFallbackPlaySessionId(session: EmbySession, itemId: string, mediaSourceId: string): string {
  return `addon-${crypto.randomBytes(8).toString('hex')}-${hashCacheKey(`${session.serverUrl}\0${session.userId}\0${itemId}\0${mediaSourceId}`).slice(0, 16)}`;
}

function getMediaStreams(item: EmbyItem, mediaSource: EmbyMediaSource): EmbyMediaStream[] {
  return mediaSource.MediaStreams || item.MediaStreams || [];
}

function selectStreamIndex(streams: EmbyMediaStream[], type: 'Audio' | 'Subtitle'): number | undefined {
  const matching = streams.filter((stream) => String(stream.Type || '').toLowerCase() === type.toLowerCase());
  if (matching.length === 0) {
    return undefined;
  }

  const selected = type === 'Subtitle'
    ? matching.find((stream) => stream.IsDefault || stream.IsForced)
    : matching.find((stream) => stream.IsDefault) || matching[0];
  return typeof selected?.Index === 'number' ? selected.Index : undefined;
}

function basenameFromPath(value: string | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) {
    return undefined;
  }
  return raw.split(/[\\/]/).filter(Boolean).pop();
}

function getMediaSourceFilename(item: EmbyItem, mediaSource: EmbyMediaSource): string | undefined {
  return mediaSource.FileName || basenameFromPath(mediaSource.Path) || item.FileName || basenameFromPath(item.Path);
}

function getMediaSize(item: EmbyItem, mediaSource: EmbyMediaSource): number | undefined {
  return typeof mediaSource.Size === 'number' && mediaSource.Size > 0
    ? mediaSource.Size
    : typeof item.Size === 'number' && item.Size > 0
      ? item.Size
      : undefined;
}

function isWebReadyDirectPlay(input: { serverUrl: string; container?: string }): boolean {
  let isHttps = false;
  try {
    isHttps = new URL(input.serverUrl).protocol === 'https:';
  } catch {
    isHttps = false;
  }

  const container = normalizeContainer(input.container);
  return isHttps && (container === 'mp4' || container === 'm4v');
}

function qualityBucket(bitrate: number | undefined): string {
  if (!bitrate || bitrate <= 0) {
    return 'unknown';
  }
  return `${Math.max(1, Math.round(bitrate / 1_000_000))}mbps`;
}

function formatBitrate(bitrate: number | undefined): string {
  if (!bitrate || bitrate <= 0) {
    return '';
  }
  return `${Math.round(bitrate / 1_000_000)} Mbps`;
}

function buildStaticStreamUrl(
  session: EmbySession,
  itemId: string,
  mediaSource: EmbyMediaSource,
  playSessionId: string,
  streamIndexes: { audioStreamIndex?: number; subtitleStreamIndex?: number } = {}
): string {
  const extension = getStreamExtension(mediaSource.Container);
  const pathSuffix = extension ? `/stream.${extension}` : '/stream';
  return buildEmbyUrl(session.serverUrl, `/Videos/${encodeURIComponent(itemId)}${pathSuffix}`, {
    static: 'true',
    MediaSourceId: mediaSource.Id || itemId,
    PlaySessionId: playSessionId,
    AudioStreamIndex: streamIndexes.audioStreamIndex,
    SubtitleStreamIndex: streamIndexes.subtitleStreamIndex,
    api_key: session.accessToken,
  });
}

function getStreamSigningSecret(): string {
  if (process.env.EMBY_STREAM_SIGNING_SECRET) {
    return process.env.EMBY_STREAM_SIGNING_SECRET;
  }
  if (process.env.STREAM_SIGNING_SECRET) {
    return process.env.STREAM_SIGNING_SECRET;
  }
  if (process.env.ADDON_PASSWORD) {
    return crypto.createHash('sha256').update(`emby-stream:addon:${process.env.ADDON_PASSWORD}`).digest('hex');
  }
  if (process.env.ADMIN_KEY) {
    return crypto.createHash('sha256').update(`emby-stream:admin:${process.env.ADMIN_KEY}`).digest('hex');
  }
  if (process.env.DATABASE_URI) {
    return crypto.createHash('sha256').update(`emby-stream:database:${process.env.DATABASE_URI}`).digest('hex');
  }

  if (!warnedEphemeralSigningSecret) {
    warnedEphemeralSigningSecret = true;
    logger.warn('[Emby] EMBY_STREAM_SIGNING_SECRET is not set and no server-only secret was available; signed playback URLs will expire on restart but saved Emby auth is not affected.');
  }
  return inMemorySigningSecret;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signEmbyStreamToken(payload: Omit<SignedStreamPayload, 'expiresAt'> & { expiresAt?: number }): string {
  const completePayload: SignedStreamPayload = {
    ...payload,
    expiresAt: payload.expiresAt || Date.now() + EMBY_STREAM_TOKEN_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(completePayload));
  const signature = crypto.createHmac('sha256', getStreamSigningSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySignedEmbyStreamToken(token: string): SignedStreamPayload {
  const [encodedPayload, signature, extra] = String(token || '').split('.');
  if (!encodedPayload || !signature || extra) {
    throw new Error('Invalid Emby stream token format');
  }

  const expectedSignature = crypto.createHmac('sha256', getStreamSigningSecret())
    .update(encodedPayload)
    .digest('base64url');
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Invalid Emby stream token signature');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SignedStreamPayload;
  if (!payload.expiresAt || payload.expiresAt <= Date.now()) {
    throw new Error('Emby stream token expired');
  }
  return payload;
}

function getEmbyStreamProxyMode(): 'off' | 'redirect' | 'proxy' {
  const mode = String(process.env.EMBY_STREAM_PROXY_MODE || 'redirect').trim().toLowerCase();
  if (mode === 'off' || mode === 'redirect' || mode === 'proxy') {
    return mode;
  }
  logger.warn(`[Emby] Unknown EMBY_STREAM_PROXY_MODE "${mode}", falling back to redirect`);
  return 'redirect';
}

function getProxyStopDebounceMs(): number {
  return parsePositiveInt(process.env.EMBY_STREAM_STOP_DEBOUNCE_MS, 1500);
}

function playbackStopKey(session: EmbySession, payload: SignedStreamPayload): string {
  return `${session.serverUrl}\0${session.userId}\0${payload.itemId}\0${payload.playSessionId}`;
}

function clearTimer(timer: any): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
  }
}

function stopPlaybackProgressHeartbeat(session: EmbySession, payload: SignedStreamPayload): void {
  const key = playbackStopKey(session, payload);
  const existing = playbackProgressHeartbeats.get(key);
  if (!existing) {
    return;
  }
  clearTimer(existing.interval);
  clearTimer(existing.timeout);
  playbackProgressHeartbeats.delete(key);
}

function startPlaybackProgressHeartbeat(
  session: EmbySession,
  payload: SignedStreamPayload,
  options: { leaseMs?: number; stopWhenLeaseExpires?: boolean } = {}
): void {
  const key = playbackStopKey(session, payload);
  const existing = playbackProgressHeartbeats.get(key);
  if (existing) {
    if (options.leaseMs) {
      clearTimer(existing.timeout);
      existing.timeout = setTimeout(() => {
        stopPlaybackProgressHeartbeat(session, payload);
        if (options.stopWhenLeaseExpires) {
          reportPlaybackStopped(session, payload).catch(() => {});
        }
      }, options.leaseMs);
      existing.timeout?.unref?.();
    }
    return;
  }

  const interval = setInterval(() => {
    reportPlaybackProgress(session, payload, {
      EventName: 'TimeUpdate',
      positionTicks: 0,
    }).catch(() => {});
  }, EMBY_PLAYBACK_PROGRESS_INTERVAL_MS);
  interval?.unref?.();

  let timeout;
  if (options.leaseMs) {
    timeout = setTimeout(() => {
      stopPlaybackProgressHeartbeat(session, payload);
      if (options.stopWhenLeaseExpires) {
        reportPlaybackStopped(session, payload).catch(() => {});
      }
    }, options.leaseMs);
    timeout?.unref?.();
  }

  playbackProgressHeartbeats.set(key, { interval, timeout });
}

function cancelPendingPlaybackStopped(session: EmbySession, payload: SignedStreamPayload): void {
  const key = playbackStopKey(session, payload);
  const existingTimer = playbackStopDebounces.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    playbackStopDebounces.delete(key);
  }
}

function schedulePlaybackStopped(session: EmbySession, payload: SignedStreamPayload): void {
  const key = playbackStopKey(session, payload);
  cancelPendingPlaybackStopped(session, payload);
  const timer = setTimeout(() => {
    if (playbackStopDebounces.get(key) !== timer) {
      return;
    }
    playbackStopDebounces.delete(key);
    stopPlaybackProgressHeartbeat(session, payload);
    reportPlaybackStopped(session, payload).catch(() => {});
  }, getProxyStopDebounceMs());
  playbackStopDebounces.set(key, timer);
}

async function requestProxyStreamWithRedirects(url: string, headers: Record<string, string>, redirectsRemaining = 3): Promise<any> {
  const upstream = await undiciRequest(url, {
    method: 'GET',
    headers,
    bodyTimeout: 0,
    headersTimeout: EMBY_TIMEOUT_MS,
  });

  const locationHeader = upstream.headers?.location || upstream.headers?.Location;
  if (redirectsRemaining > 0 && REDIRECT_STATUS_CODES.has(upstream.statusCode) && locationHeader) {
    upstream.body?.destroy?.();
    const nextUrl = new URL(locationHeader, url).toString();
    return requestProxyStreamWithRedirects(nextUrl, headers, redirectsRemaining - 1);
  }

  return upstream;
}

function buildSignedAddonStreamUrl(
  session: EmbySession,
  itemId: string,
  mediaSource: EmbyMediaSource,
  playSessionId: string,
  streamIndexes: { audioStreamIndex?: number; subtitleStreamIndex?: number }
): string | null {
  const addonHost = getAddonHost();
  const userUUID = session.userUUID;
  if (!addonHost || !userUUID) {
    return null;
  }

  const ext = getStreamExtension(mediaSource.Container);
  const token = signEmbyStreamToken({
    userUUID,
    itemId,
    mediaSourceId: mediaSource.Id || itemId,
    playSessionId,
    container: normalizeContainer(mediaSource.Container) || ext || 'unknown',
    ext,
    audioStreamIndex: streamIndexes.audioStreamIndex,
    subtitleStreamIndex: streamIndexes.subtitleStreamIndex,
    playbackClientId: session.playbackClientId,
    playbackDeviceName: session.playbackDeviceName,
  });

  return `${addonHost}/emby/play/${encodeURIComponent(token)}/stream${ext ? `.${ext}` : ''}`;
}

function buildDirectPlayUrlFromPayload(session: EmbySession, payload: SignedStreamPayload): string {
  const mediaSource: EmbyMediaSource = {
    Id: payload.mediaSourceId,
    Container: payload.container,
  };
  return buildStaticStreamUrl(session, payload.itemId, mediaSource, payload.playSessionId, {
    audioStreamIndex: payload.audioStreamIndex,
    subtitleStreamIndex: payload.subtitleStreamIndex,
  });
}

function buildPlaybackEventPayload(payload: SignedStreamPayload, positionTicks = 0): any {
  const body: any = {
    QueueableMediaTypes: ['Video'],
    CanSeek: true,
    ItemId: payload.itemId,
    MediaSourceId: payload.mediaSourceId,
    IsPaused: false,
    IsMuted: false,
    PositionTicks: positionTicks,
    PlayMethod: 'DirectPlay',
    PlaySessionId: payload.playSessionId,
    PlaylistIndex: 0,
    PlaylistLength: 1,
    PlaybackRate: 1,
  };
  if (typeof payload.audioStreamIndex === 'number') {
    body.AudioStreamIndex = payload.audioStreamIndex;
  }
  if (typeof payload.subtitleStreamIndex === 'number') {
    body.SubtitleStreamIndex = payload.subtitleStreamIndex;
  }
  return body;
}

async function postPlaybackEvent(session: EmbySession, endpoint: string, payload: any, eventName: string): Promise<boolean> {
  try {
    await httpPost(
      buildEmbyUrl(session.serverUrl, endpoint, {
        api_key: session.accessToken,
      }),
      payload,
      {
        timeout: EMBY_TIMEOUT_MS,
        headers: embyHeaders(session, {
          Accept: 'application/json',
        }),
      }
    );
    debugPlayback(`${eventName}:success`, {
      userUUID: session.userUUID,
      itemId: payload.ItemId,
      mediaSourceId: payload.MediaSourceId,
      playSessionId: payload.PlaySessionId,
    });
    return true;
  } catch (error: any) {
    logger.warn(`[Emby] ${eventName} failed for item ${payload?.ItemId}: ${error.message}`);
    debugPlayback(`${eventName}:failed`, {
      userUUID: session.userUUID,
      itemId: payload?.ItemId,
      mediaSourceId: payload?.MediaSourceId,
      playSessionId: payload?.PlaySessionId,
      error: error.message,
    });
    return false;
  }
}

async function reportPlaybackStarted(session: EmbySession, payload: SignedStreamPayload): Promise<boolean> {
  return postPlaybackEvent(session, '/Sessions/Playing', buildPlaybackEventPayload(payload, 0), 'Sessions/Playing');
}

async function reportPlaybackProgress(session: EmbySession, payload: SignedStreamPayload, options: any = {}): Promise<boolean> {
  const positionTicks = options.PositionTicks ?? options.positionTicks ?? 0;
  const body = {
    ...buildPlaybackEventPayload(payload, positionTicks),
    EventName: options.EventName || 'TimeUpdate',
    IsPaused: options.IsPaused === true,
  };
  return postPlaybackEvent(session, '/Sessions/Playing/Progress', body, 'Sessions/Playing/Progress');
}

async function reportPlaybackStopped(session: EmbySession, payload: SignedStreamPayload, positionTicks = 0): Promise<boolean> {
  return postPlaybackEvent(session, '/Sessions/Playing/Stopped', buildPlaybackEventPayload(payload, positionTicks), 'Sessions/Playing/Stopped');
}

function toEmbyStream(session: EmbySession, item: EmbyItem, mediaSource: EmbyMediaSource, playSessionId: string): any {
  const container = normalizeContainer(mediaSource.Container);
  const extension = getStreamExtension(mediaSource.Container);
  const bitrateText = formatBitrate(mediaSource.Bitrate);
  const details = [container ? container.toUpperCase() : '', bitrateText].filter(Boolean).join(' - ');
  const filename = getMediaSourceFilename(item, mediaSource);
  const videoSize = getMediaSize(item, mediaSource);
  const mediaStreams = getMediaStreams(item, mediaSource);
  const audioStreamIndex = selectStreamIndex(mediaStreams, 'Audio');
  const subtitleStreamIndex = selectStreamIndex(mediaStreams, 'Subtitle');
  const streamIndexes = { audioStreamIndex, subtitleStreamIndex };
  const directUrl = buildStaticStreamUrl(session, item.Id, mediaSource, playSessionId, streamIndexes);
  const mode = getEmbyStreamProxyMode();
  const signedUrl = mode === 'off' ? null : buildSignedAddonStreamUrl(session, item.Id, mediaSource, playSessionId, streamIndexes);
  const url = signedUrl || directUrl;
  const notWebReady = !isWebReadyDirectPlay({ serverUrl: session.serverUrl, container });
  const videoStream = mediaStreams.find((stream) => String(stream.Type || '').toLowerCase() === 'video');
  const audioStream = mediaStreams.find((stream) => String(stream.Type || '').toLowerCase() === 'audio' && (audioStreamIndex === undefined || stream.Index === audioStreamIndex));
  const subtitleStream = mediaStreams.find((stream) => String(stream.Type || '').toLowerCase() === 'subtitle' && (subtitleStreamIndex === undefined || stream.Index === subtitleStreamIndex));

  debugPlayback('stream-built', {
    userUUID: session.userUUID,
    itemId: item.Id,
    mediaSourceId: mediaSource.Id || item.Id,
    playSessionId,
    selectedContainer: container,
    selectedBitrate: mediaSource.Bitrate,
    selectedVideoCodec: videoStream?.Codec,
    selectedAudioCodec: audioStream?.Codec,
    selectedAudioIndex: audioStreamIndex,
    selectedSubtitleIndex: subtitleStreamIndex,
    finalUrl: url,
    directUrl,
    streamExtension: extension,
    static: true,
    mode: signedUrl ? mode : 'direct',
    notWebReady,
    hasFilename: Boolean(filename),
    hasVideoSize: Boolean(videoSize),
  });

  return {
    name: 'Emby',
    title: details ? `Emby\n${details}` : 'Emby',
    description: ['Emby Direct Play', details, filename].filter(Boolean).join('\n'),
    url,
    behaviorHints: {
      notWebReady,
      filename,
      videoSize,
      bingeGroup: `emby-directplay-${container || 'unknown'}-${qualityBucket(mediaSource.Bitrate)}`,
    },
  };
}

async function toPlaybackAwareEmbyStream(session: EmbySession, item: EmbyItem): Promise<any | null> {
  if (item.IsFolder || item.LocationType === 'Virtual') {
    return null;
  }

  const playbackInfo = await getPlaybackInfo(session, item.Id);
  const mediaSources = Array.isArray(playbackInfo.MediaSources) && playbackInfo.MediaSources.length > 0
    ? playbackInfo.MediaSources
    : item.MediaSources || [];
  const mediaSource = selectDirectPlayableSource(mediaSources);
  if (!mediaSource) {
    return null;
  }

  const mediaSourceId = mediaSource.Id || item.Id;
  const playSessionId = playbackInfo.PlaySessionId || generateFallbackPlaySessionId(session, item.Id, mediaSourceId);
  return toEmbyStream(session, item, mediaSource, playSessionId);
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

  return toPlaybackAwareEmbyStream(session, movie);
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

  return toPlaybackAwareEmbyStream(session, episode);
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

async function proxyEmbyStream(req: any, res: any, session: EmbySession, payload: SignedStreamPayload, directUrl: string): Promise<void> {
  cancelPendingPlaybackStopped(session, payload);

  const headers: Record<string, string> = embyHeaders(session, {});
  if (req.headers?.range) {
    headers.Range = req.headers.range;
  }

  const upstream = await requestProxyStreamWithRedirects(directUrl, headers);
  startPlaybackProgressHeartbeat(session, payload);

  res.status(upstream.statusCode);
  for (const header of SAFE_PROXY_HEADERS) {
    const value = upstream.headers?.[header] || upstream.headers?.[header.toLowerCase()] || upstream.headers?.[header.toUpperCase()];
    if (value !== undefined) {
      res.setHeader(header, value);
    }
  }

  debugPlayback('proxy-response', {
    userUUID: session.userUUID,
    itemId: payload.itemId,
    mediaSourceId: payload.mediaSourceId,
    playSessionId: payload.playSessionId,
    statusCode: upstream.statusCode,
    hasRangeRequest: Boolean(req.headers?.range),
    contentRange: upstream.headers?.['content-range'],
  });

  let stopped = false;
  const scheduleStopped = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    schedulePlaybackStopped(session, payload);
  };

  res.on('close', scheduleStopped);
  upstream.body.on('error', (error: any) => {
    logger.warn(`[Emby] Proxy stream error for item ${payload.itemId}: ${error.message}`);
    scheduleStopped();
    if (!res.headersSent) {
      res.status(502);
    }
    res.end();
  });
  upstream.body.pipe(res);
}

async function handleSignedEmbyStreamRequest(req: any, res: any, loadConfigFromDatabase: (userUUID: string) => Promise<any>): Promise<void> {
  try {
    const signedToken = req.params?.signedToken;
    const payload = verifySignedEmbyStreamToken(signedToken);
    const config = await loadConfigFromDatabase(payload.userUUID);
    const requestPlaybackClient = getEmbyPlaybackClientFromRequest(req);
    const session = await getEmbySession({
      ...config,
      userUUID: payload.userUUID,
      playbackClientId: payload.playbackClientId || requestPlaybackClient.playbackClientId,
      playbackDeviceName: payload.playbackDeviceName || requestPlaybackClient.playbackDeviceName,
    });

    if (!session) {
      res.status(404).json({ error: 'Emby credentials were not found for this user' });
      return;
    }

    await reportPlaybackStarted(session, payload);
    const directUrl = buildDirectPlayUrlFromPayload(session, payload);
    const mode = getEmbyStreamProxyMode();

    debugPlayback('signed-url-requested', {
      userUUID: payload.userUUID,
      itemId: payload.itemId,
      mediaSourceId: payload.mediaSourceId,
      playSessionId: payload.playSessionId,
      mode,
      directUrl,
    });

    if (mode === 'proxy') {
      await proxyEmbyStream(req, res, session, payload, directUrl);
      return;
    }

    startPlaybackProgressHeartbeat(session, payload, {
      leaseMs: EMBY_REDIRECT_PLAYBACK_HEARTBEAT_MS,
      stopWhenLeaseExpires: true,
    });
    res.redirect(302, directUrl);
  } catch (error: any) {
    const message = error?.message || 'Invalid Emby playback request';
    const status = message.includes('expired') ? 410 : 400;
    logger.warn(`[Emby] Signed stream request failed: ${message}`);
    res.status(status).json({ error: message });
  }
}

export {
  authenticateEmby,
  getEmbyStreams,
  hasEmbyCredentials,
  normalizeBaseUrl,
  buildEmbyUrl,
  buildStaticStreamUrl,
  getPlaybackInfo,
  selectDirectPlayableSource,
  getStreamExtension,
  isWebReadyDirectPlay,
  getEmbyDeviceId,
  getEmbyPlaybackClientFromRequest,
  buildEmbyAuthorizationHeader,
  signEmbyStreamToken,
  verifySignedEmbyStreamToken,
  reportPlaybackStarted,
  reportPlaybackProgress,
  reportPlaybackStopped,
  handleSignedEmbyStreamRequest,
};

module.exports = {
  authenticateEmby,
  getEmbyStreams,
  hasEmbyCredentials,
  normalizeBaseUrl,
  buildEmbyUrl,
  buildStaticStreamUrl,
  getPlaybackInfo,
  selectDirectPlayableSource,
  getStreamExtension,
  isWebReadyDirectPlay,
  getEmbyDeviceId,
  getEmbyPlaybackClientFromRequest,
  buildEmbyAuthorizationHeader,
  signEmbyStreamToken,
  verifySignedEmbyStreamToken,
  reportPlaybackStarted,
  reportPlaybackProgress,
  reportPlaybackStopped,
  handleSignedEmbyStreamRequest,
};
