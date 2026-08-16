const PUBLIC_ID = 'tvdb:bleach-kai';
const UPSTREAM_ID = 'bleach-kai';
const SERIES_TYPE = 'series';
const REQUEST_TIMEOUT_MS = 10000;
const EPISODE_COUNT = 35;

function getBaseUrl() {
  const value = String(process.env.BLEACH_KAI_ADDON_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isEnabled() {
  return Boolean(getBaseUrl());
}

function isSeriesId(id) {
  return id === PUBLIC_ID || id === UPSTREAM_ID;
}

function isVideoId(id) {
  return typeof id === 'string'
    && (id.startsWith(`${PUBLIC_ID}:`) || id.startsWith(`${UPSTREAM_ID}:`));
}

function normalizeSearchQuery(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesSearch(type, query, page = 1) {
  if (!isEnabled() || page !== 1 || (type !== 'series' && type !== 'anime.series')) {
    return false;
  }

  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery.length < 3) return false;

  return 'bleach kai'.includes(normalizedQuery) || normalizedQuery.includes('bleach kai');
}

function getArtworkOrigin() {
  const baseUrl = getBaseUrl();
  return baseUrl ? new URL(baseUrl).origin : '';
}

function getEpisodeNumber(id) {
  if (typeof id !== 'string') return null;

  const match = id.match(/^(?:tvdb:bleach-kai|bleach-kai):1:(\d+)$/);
  if (!match) return null;

  const episode = Number(match[1]);
  return Number.isInteger(episode) && episode >= 1 && episode <= EPISODE_COUNT
    ? episode
    : null;
}

function getSubtitles(id) {
  const episode = getEpisodeNumber(id);
  const origin = getArtworkOrigin();
  if (!episode || !origin) return { subtitles: [] };

  const paddedEpisode = String(episode).padStart(2, '0');
  return {
    subtitles: [{
      id: `bleach-kai-en-${paddedEpisode}`,
      url: `${origin}/bleach/subtitles/episode-${paddedEpisode}.en.srt`,
      lang: 'eng',
      title: 'English (Bleach Kai)',
    }],
  };
}

function getSearchMeta() {
  const origin = getArtworkOrigin();
  return {
    id: PUBLIC_ID,
    type: SERIES_TYPE,
    name: 'Bleach Kai',
    poster: `${origin}/artwork/poster.png`,
    background: `${origin}/artwork/background.png`,
    description: 'A 35-part fan edit of Bleach that removes filler and pacing overhead.',
    releaseInfo: '2024',
    genres: ['Anime', 'Action', 'Adventure'],
  };
}

function injectSearchMeta(metas, type, query, page = 1) {
  const results = Array.isArray(metas) ? metas : [];
  if (!matchesSearch(type, query, page) || results.some((meta) => meta?.id === PUBLIC_ID)) {
    return results;
  }
  return [getSearchMeta(), ...results];
}

async function fetchUpstreamJson(route) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    throw new Error('Bleach Kai integration is not configured');
  }

  const response = await fetch(`${baseUrl}${route}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Bleach Kai upstream returned HTTP ${response.status}`);
  }
  return response.json();
}

function toPublicVideoId(id) {
  if (typeof id !== 'string' || !id.startsWith(`${UPSTREAM_ID}:`)) return id;
  return `${PUBLIC_ID}${id.slice(UPSTREAM_ID.length)}`;
}

function toUpstreamVideoId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith(`${PUBLIC_ID}:`)) {
    return `${UPSTREAM_ID}${id.slice(PUBLIC_ID.length)}`;
  }
  return id.startsWith(`${UPSTREAM_ID}:`) ? id : null;
}

async function getMeta() {
  const payload = await fetchUpstreamJson(`/meta/${SERIES_TYPE}/${encodeURIComponent(UPSTREAM_ID)}.json`);
  if (!payload?.meta) return { meta: null };

  return {
    meta: {
      ...payload.meta,
      id: PUBLIC_ID,
      type: SERIES_TYPE,
      videos: Array.isArray(payload.meta.videos)
        ? payload.meta.videos.map((video) => ({ ...video, id: toPublicVideoId(video.id) }))
        : [],
    },
  };
}

async function getStreams(id) {
  const upstreamId = toUpstreamVideoId(id);
  if (!upstreamId) return [];

  const payload = await fetchUpstreamJson(`/stream/${SERIES_TYPE}/${encodeURIComponent(upstreamId)}.json`);
  return Array.isArray(payload?.streams) ? payload.streams : [];
}

module.exports = {
  PUBLIC_ID,
  getMeta,
  getStreams,
  getSubtitles,
  injectSearchMeta,
  isEnabled,
  isSeriesId,
  isVideoId,
  matchesSearch,
  toPublicVideoId,
  toUpstreamVideoId,
};
