const assert = require('assert/strict');
const sharp = require('sharp');

const {
  POSTER_BADGE_SIZE_RATIO,
  addBadgeToPosterUrl,
  applyPosterBadgeToBuffer,
  buildBadgePosterProxyUrl,
  getPosterBadgeType,
} = require('../addon/utils/posterBadges');

async function testBadgeUrlParamsAreAppended() {
  const url = addBadgeToPosterUrl(
    'https://nuvio.file-host.net/poster/movie/tt2015381?fallback=https%3A%2F%2Fimage.tmdb.org%2Fposter.jpg&lang=en-US&key=rpdb-key',
    'movie'
  );
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/poster/movie/tt2015381');
  assert.equal(parsed.searchParams.get('fallback'), 'https://image.tmdb.org/poster.jpg');
  assert.equal(parsed.searchParams.get('lang'), 'en-US');
  assert.equal(parsed.searchParams.get('key'), 'rpdb-key');
  assert.equal(parsed.searchParams.get('badge'), 'movie');
  assert.equal(parsed.searchParams.get('badgeVersion'), '1');
}

async function testDirectPosterCanBeWrappedWithBadgeProxy() {
  const url = buildBadgePosterProxyUrl({
    host: 'https://nuvio.file-host.net',
    type: 'series',
    proxyId: 'tt0212671',
    fallback: 'https://artworks.thetvdb.com/banners/posters/73838.jpg',
    badgeType: 'series',
  });
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/poster/series/tt0212671');
  assert.equal(parsed.searchParams.get('fallback'), 'https://artworks.thetvdb.com/banners/posters/73838.jpg');
  assert.equal(parsed.searchParams.get('badge'), 'series');
  assert.equal(parsed.searchParams.get('badgeVersion'), '1');
  assert.equal(parsed.searchParams.has('key'), false);
}

async function testBadgeTypeComesFromMovieOrSeriesMetaOnly() {
  assert.equal(getPosterBadgeType({ type: 'movie' }, 'all'), 'movie');
  assert.equal(getPosterBadgeType({ type: 'series' }, 'all'), 'series');
  assert.equal(getPosterBadgeType({ type: 'anime' }, 'all'), null);
  assert.equal(getPosterBadgeType({}, 'movie'), 'movie');
}

async function testOverlayUsesEighteenPercentAtTopLeft() {
  const base = await sharp({
    create: {
      width: 100,
      height: 150,
      channels: 4,
      background: { r: 0, g: 30, b: 200, alpha: 1 },
    },
  }).png().toBuffer();
  const badge = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();

  const { buffer, placement } = await applyPosterBadgeToBuffer(base, 'movie', { badgeInput: badge });
  const metadata = await sharp(buffer).metadata();
  const raw = await sharp(buffer).raw().toBuffer();
  const channels = metadata.channels;
  const sampleOffset = ((placement.top + Math.floor(placement.badgeSize / 2)) * metadata.width + placement.left + Math.floor(placement.badgeSize / 2)) * channels;

  assert.equal(POSTER_BADGE_SIZE_RATIO, 0.18);
  assert.equal(metadata.width, 100);
  assert.equal(metadata.height, 150);
  assert.equal(placement.badgeSize, 18);
  assert.equal(placement.left, 4);
  assert.equal(placement.top, 4);
  assert.ok(raw[sampleOffset] > 150, 'badge sample should have a strong red channel');
  assert.ok(raw[sampleOffset + 2] < 150, 'badge sample should not remain poster blue');
}

async function main() {
  await testBadgeUrlParamsAreAppended();
  await testDirectPosterCanBeWrappedWithBadgeProxy();
  await testBadgeTypeComesFromMovieOrSeriesMetaOnly();
  await testOverlayUsesEighteenPercentAtTopLeft();
  console.log('poster badge tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
