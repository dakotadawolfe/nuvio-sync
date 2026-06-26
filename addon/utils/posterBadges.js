const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const POSTER_BADGE_VERSION = '1';
const POSTER_BADGE_SIZE_RATIO = 0.18;
const POSTER_BADGE_MARGIN_RATIO = 0.035;
const MAX_POSTER_BADGE_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_POSTER_BADGE_INPUT_PIXELS = 10000 * 10000;

const BADGE_ASSET_FILES = {
  movie: 'movie.png',
  series: 'series.png',
};

const resizedBadgeCache = new Map();

function normalizePosterBadgeType(value) {
  if (value === 'movie' || value === 'series') return value;
  return null;
}

function getPosterBadgeType(meta = {}, fallbackType = null) {
  return normalizePosterBadgeType(meta?.type) || normalizePosterBadgeType(fallbackType);
}

function addBadgeToPosterUrl(posterUrl, badgeType) {
  const normalizedBadge = normalizePosterBadgeType(badgeType);
  if (!posterUrl || !normalizedBadge) return posterUrl;

  try {
    const parsed = new URL(posterUrl);
    parsed.searchParams.set('badge', normalizedBadge);
    parsed.searchParams.set('badgeVersion', POSTER_BADGE_VERSION);
    return parsed.toString();
  } catch {
    return posterUrl;
  }
}

function buildBadgePosterProxyUrl({ host, type, proxyId, fallback, badgeType, language, key, url }) {
  const normalizedBadge = normalizePosterBadgeType(badgeType);
  if (!host || !type || !proxyId || !fallback || !normalizedBadge) return fallback;

  const trimmedHost = String(host).replace(/\/+$/, '');
  const parsed = new URL(`${trimmedHost}/poster/${type}/${proxyId}`);
  parsed.searchParams.set('fallback', fallback);
  if (language) parsed.searchParams.set('lang', language);
  if (key) parsed.searchParams.set('key', key);
  if (url) parsed.searchParams.set('url', url);
  parsed.searchParams.set('badge', normalizedBadge);
  parsed.searchParams.set('badgeVersion', POSTER_BADGE_VERSION);
  return parsed.toString();
}

async function streamToBuffer(stream, maxBytes = MAX_POSTER_BADGE_INPUT_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Poster image too large for badge overlay');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

async function getResizedBadgeBuffer(badgeType, badgeSize, badgeInput) {
  const normalizedBadge = normalizePosterBadgeType(badgeType);
  if (!normalizedBadge) {
    throw new Error(`Unsupported poster badge type: ${badgeType}`);
  }

  if (badgeInput) {
    return sharp(badgeInput)
      .resize(badgeSize, badgeSize, { fit: 'contain' })
      .png()
      .toBuffer();
  }

  const cacheKey = `${normalizedBadge}:${badgeSize}`;
  const cached = resizedBadgeCache.get(cacheKey);
  if (cached) return cached;

  const resized = await sharp(resolveBadgeAssetPath(normalizedBadge))
    .resize(badgeSize, badgeSize, { fit: 'contain' })
    .png()
    .toBuffer();
  resizedBadgeCache.set(cacheKey, resized);
  return resized;
}

function resolveBadgeAssetPath(badgeType) {
  const filename = BADGE_ASSET_FILES[badgeType];
  const candidates = [
    path.join(__dirname, '..', 'static', 'poster-badges', filename),
    path.join(__dirname, '..', '..', '..', 'addon', 'static', 'poster-badges', filename),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(`Poster badge asset not found for ${badgeType}`);
  }
  return resolved;
}

async function applyPosterBadgeToBuffer(imageBuffer, badgeType, options = {}) {
  const normalizedBadge = normalizePosterBadgeType(badgeType);
  if (!normalizedBadge) {
    throw new Error(`Unsupported poster badge type: ${badgeType}`);
  }

  const metadata = await sharp(imageBuffer, { limitInputPixels: MAX_POSTER_BADGE_INPUT_PIXELS }).metadata();
  const width = metadata.width || 600;
  const badgeSize = Math.max(16, Math.round(width * POSTER_BADGE_SIZE_RATIO));
  const margin = Math.max(0, Math.round(width * POSTER_BADGE_MARGIN_RATIO));
  const badge = await getResizedBadgeBuffer(normalizedBadge, badgeSize, options.badgeInput);

  const buffer = await sharp(imageBuffer, { limitInputPixels: MAX_POSTER_BADGE_INPUT_PIXELS })
    .rotate()
    .composite([{ input: badge, left: margin, top: margin }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  return {
    buffer,
    contentType: 'image/jpeg',
    placement: {
      badgeSize,
      left: margin,
      top: margin,
      sizeRatio: POSTER_BADGE_SIZE_RATIO,
      marginRatio: POSTER_BADGE_MARGIN_RATIO,
    },
  };
}

async function pipePosterImageResponseWithBadge(res, imageResponse, badgeType) {
  const sourceBuffer = await streamToBuffer(imageResponse.data);
  const { buffer, contentType } = await applyPosterBadgeToBuffer(sourceBuffer, badgeType);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.end(buffer);
}

module.exports = {
  POSTER_BADGE_MARGIN_RATIO,
  POSTER_BADGE_SIZE_RATIO,
  POSTER_BADGE_VERSION,
  addBadgeToPosterUrl,
  applyPosterBadgeToBuffer,
  buildBadgePosterProxyUrl,
  getPosterBadgeType,
  normalizePosterBadgeType,
  pipePosterImageResponseWithBadge,
  resolveBadgeAssetPath,
};
