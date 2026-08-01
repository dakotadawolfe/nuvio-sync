const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const embyModulePath = path.resolve(__dirname, '../dist/server/lib/embyStreams.js');

function loadEmbyStreamsWithMocks({ httpGet, httpPost, undiciRequest } = {}) {
  delete require.cache[embyModulePath];

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'undici' && undiciRequest) {
      return {
        request: undiciRequest,
      };
    }
    if (request === '../utils/httpClient') {
      return {
        httpGet: httpGet || (async () => ({ data: {} })),
        httpPost: httpPost || (async () => ({ data: {} })),
      };
    }
    if (request === './id-resolver') {
      return {
        resolveAllIds: async () => ({ imdbId: 'tt1234567' }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(embyModulePath);
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

function makePlaybackInfo(overrides = {}) {
  return {
    PlaySessionId: 'play-session-1',
    MediaSources: [
      {
        Id: 'media-source-1',
        Protocol: 'File',
        Container: 'mkv',
        SupportsDirectPlay: true,
        SupportsDirectStream: false,
        Bitrate: 10_400_000,
        Size: 1_234_567_890,
        Path: '/server/movies/Problem Movie.mkv',
        RunTimeTicks: 7_200_000_000,
        MediaStreams: [
          { Type: 'Video', Codec: 'hevc', Index: 0 },
          { Type: 'Audio', Codec: 'aac', Index: 1 },
          { Type: 'Subtitle', Codec: 'srt', Index: 2 },
        ],
        ...overrides,
      },
    ],
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWritableResponse() {
  const res = new PassThrough();
  res.headers = {};
  res.statusCode = null;
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.setHeader = function setHeader(key, value) {
    this.headers[key.toLowerCase()] = value;
    return this;
  };
  return res;
}

test('getEmbyStreams calls PlaybackInfo and builds a Direct Play URL with MediaSourceId and PlaySessionId', async () => {
  await withEnv({ EMBY_STREAM_PROXY_MODE: 'off', HOST_NAME: undefined }, async () => {
    const getCalls = [];
    const postCalls = [];
    const emby = loadEmbyStreamsWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        getCalls.push(parsed);

        if (parsed.pathname === '/Users/user-1/Items') {
          return { data: { Items: [{ Id: 'item-1', Name: 'Problem Movie' }] } };
        }
        throw new Error(`Unexpected Emby GET ${parsed.pathname}`);
      },
      httpPost: async (url, body, options) => {
        const parsed = new URL(url);
        postCalls.push({ url: parsed, body, options });
        if (parsed.pathname === '/Items/item-1/PlaybackInfo') {
          return { data: makePlaybackInfo() };
        }
        throw new Error(`Unexpected Emby POST ${parsed.pathname}`);
      },
    });

    const result = await emby.getEmbyStreams('movie', 'tt1234567', {
      userUUID: 'user-uuid-1',
      apiKeys: {
        embyServer: 'https://emby.example',
        embyUserId: 'user-1',
        embyAccessToken: 'token-abc',
      },
      playbackClientId: 'client-hash-1',
      playbackDeviceName: 'AIO Addon client-hash-1',
    });

    assert.equal(result.streams.length, 1);
    assert.ok(getCalls.some((call) => call.pathname === '/Users/user-1/Items'));
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].url.pathname, '/Items/item-1/PlaybackInfo');
    assert.equal(postCalls[0].body.IsPlayback, true);
    assert.equal(postCalls[0].body.EnableTranscoding, true);
    assert.ok(postCalls[0].body.DeviceProfile);

    const stream = result.streams[0];
    const streamUrl = new URL(stream.url);
    assert.equal(streamUrl.pathname, '/Videos/item-1/stream.mkv');
    assert.equal(streamUrl.searchParams.get('static'), 'true');
    assert.equal(streamUrl.searchParams.get('MediaSourceId'), 'media-source-1');
    assert.equal(streamUrl.searchParams.get('PlaySessionId'), 'play-session-1');
    assert.equal(streamUrl.searchParams.get('api_key'), 'token-abc');
    assert.equal(stream.behaviorHints.notWebReady, true);
    assert.equal(stream.behaviorHints.filename, 'Problem Movie.mkv');
    assert.equal(stream.behaviorHints.videoSize, 1_234_567_890);
    assert.match(stream.behaviorHints.bingeGroup, /^emby-directplay-mkv-/);
    assert.match(stream.description, /Direct Play/);
    assert.doesNotMatch(stream.title, /\/server\/movies/);
  });
});

test('web-readiness hints only mark HTTPS MP4 and M4V streams ready', () => {
  const emby = loadEmbyStreamsWithMocks();

  assert.equal(emby.isWebReadyDirectPlay({ serverUrl: 'https://emby.example', container: 'mp4' }), true);
  assert.equal(emby.isWebReadyDirectPlay({ serverUrl: 'https://emby.example', container: 'm4v' }), true);
  assert.equal(emby.isWebReadyDirectPlay({ serverUrl: 'http://emby.example', container: 'mp4' }), false);
  assert.equal(emby.isWebReadyDirectPlay({ serverUrl: 'https://emby.example', container: 'mkv' }), false);
});

test('stream extension mapping covers Direct Play containers and fallback stream paths', () => {
  const emby = loadEmbyStreamsWithMocks();

  assert.equal(emby.getStreamExtension('mp4'), 'mp4');
  assert.equal(emby.getStreamExtension('m4v'), 'm4v');
  assert.equal(emby.getStreamExtension('mkv'), 'mkv');
  assert.equal(emby.getStreamExtension('matroska'), 'mkv');
  assert.equal(emby.getStreamExtension('ts'), 'ts');
  assert.equal(emby.getStreamExtension('mpegts'), 'ts');
  assert.equal(emby.getStreamExtension('m2ts'), 'm2ts');
  assert.equal(emby.getStreamExtension('webm'), 'webm');
  assert.equal(emby.getStreamExtension('unknown-container'), '');

  const staticUrl = new URL(emby.buildStaticStreamUrl(
    { serverUrl: 'https://emby.example', accessToken: 'token-abc', userId: 'user-1' },
    'item-1',
    { Id: 'media-source-1', Container: 'unknown-container' },
    'play-session-1'
  ));
  assert.equal(staticUrl.pathname, '/Videos/item-1/stream');
  assert.equal(staticUrl.searchParams.get('MediaSourceId'), 'media-source-1');
  assert.equal(staticUrl.searchParams.get('PlaySessionId'), 'play-session-1');
});

test('Direct Play media source selection skips unsupported and RTMP sources without requiring Direct Stream', () => {
  const emby = loadEmbyStreamsWithMocks();

  const selected = emby.selectDirectPlayableSource([
    { Id: 'unsupported', Protocol: 'File', Container: 'mp4', SupportsDirectPlay: false },
    { Id: 'rtmp-source', Protocol: 'rtmp', Container: 'mkv', SupportsDirectPlay: true },
    { Id: 'direct-play-source', Protocol: 'File', Container: 'webm', SupportsDirectPlay: true, SupportsDirectStream: false },
  ]);

  assert.equal(selected.Id, 'direct-play-source');
});

test('DeviceId is deterministic per Emby server, user id, and addon user UUID', () => {
  const emby = loadEmbyStreamsWithMocks();

  const first = emby.getEmbyDeviceId({
    serverUrl: 'https://emby.example',
    userId: 'emby-user-1',
    userUUID: 'addon-user-1',
  });
  const second = emby.getEmbyDeviceId({
    serverUrl: 'https://emby.example/',
    userId: 'emby-user-1',
    userUUID: 'addon-user-1',
  });
  const different = emby.getEmbyDeviceId({
    serverUrl: 'https://emby.example',
    userId: 'emby-user-1',
    userUUID: 'addon-user-2',
  });

  assert.equal(first, second);
  assert.match(first, /^aio-addon-[a-f0-9]{32}$/);
  assert.notEqual(first, different);
  assert.match(emby.buildEmbyAuthorizationHeader({
    serverUrl: 'https://emby.example',
    userId: 'emby-user-1',
    userUUID: 'addon-user-1',
  }), new RegExp(`DeviceId="${first}"`));
});

test('legacy saved Emby config shape still generates streams without new optional fields', async () => {
  await withEnv({ EMBY_STREAM_PROXY_MODE: 'off', HOST_NAME: undefined }, async () => {
    const emby = loadEmbyStreamsWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Users/user-1/Items') {
          return { data: { Items: [{ Id: 'item-1', Name: 'Legacy Config Movie' }] } };
        }
        throw new Error(`Unexpected Emby GET ${parsed.pathname}`);
      },
      httpPost: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Items/item-1/PlaybackInfo') {
          return { data: { MediaSources: makePlaybackInfo({ Container: 'm4v' }).MediaSources } };
        }
        throw new Error(`Unexpected Emby POST ${parsed.pathname}`);
      },
    });

    const result = await emby.getEmbyStreams('movie', 'tt1234567', {
      emby: {
        serverUrl: 'https://emby.example',
        userId: 'user-1',
        accessToken: 'token-abc',
      },
    });

    assert.equal(result.streams.length, 1);
    const streamUrl = new URL(result.streams[0].url);
    assert.equal(streamUrl.pathname, '/Videos/item-1/stream.m4v');
    assert.equal(streamUrl.searchParams.get('api_key'), 'token-abc');
    assert.match(streamUrl.searchParams.get('PlaySessionId'), /^addon-/);
  });
});

test('default redirect mode returns a signed addon URL without exposing Emby tokens', async () => {
  await withEnv({
    HOST_NAME: 'https://addon.example',
    EMBY_STREAM_PROXY_MODE: undefined,
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const emby = loadEmbyStreamsWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Users/user-1/Items') {
          return { data: { Items: [{ Id: 'item-1', Name: 'Problem MP4' }] } };
        }
        throw new Error(`Unexpected Emby GET ${parsed.pathname}`);
      },
      httpPost: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Items/item-1/PlaybackInfo') {
          return { data: makePlaybackInfo({ Container: 'mp4', Path: '/server/movies/Problem MP4.mp4' }) };
        }
        throw new Error(`Unexpected Emby POST ${parsed.pathname}`);
      },
    });

    const result = await emby.getEmbyStreams('movie', 'tt1234567', {
      userUUID: 'addon-user-1',
      apiKeys: {
        embyServer: 'https://emby.example',
        embyUserId: 'user-1',
        embyAccessToken: 'token-abc',
      },
      playbackClientId: 'client-hash-1',
      playbackDeviceName: 'AIO Addon client-hash-1',
    });

    assert.equal(result.streams.length, 1);
    const streamUrl = new URL(result.streams[0].url);
    assert.equal(streamUrl.origin, 'https://addon.example');
    assert.match(streamUrl.pathname, /^\/emby\/play\/[^/]+\/stream\.mp4$/);
    assert.doesNotMatch(result.streams[0].url, /token-abc|api_key|media-source-1|play-session-1/);

    const signedToken = streamUrl.pathname.split('/')[3];
    const payload = emby.verifySignedEmbyStreamToken(signedToken);
    assert.equal(payload.userUUID, 'addon-user-1');
    assert.equal(payload.itemId, 'item-1');
    assert.equal(payload.mediaSourceId, 'media-source-1');
    assert.equal(payload.playSessionId, 'play-session-1');
    assert.equal(payload.container, 'mp4');
    assert.equal(payload.playbackClientId, 'client-hash-1');
    assert.equal(payload.playbackDeviceName, 'AIO Addon client-hash-1');
  });
});

test('FLAC stays Direct Play when Emby PlaybackInfo reports the source is direct-playable', async () => {
  await withEnv({
    HOST_NAME: 'https://addon.example',
    EMBY_STREAM_PROXY_MODE: undefined,
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const postCalls = [];
    const emby = loadEmbyStreamsWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Users/user-1/Items') {
          return { data: { Items: [{ Id: 'item-1', Name: 'FLAC Direct Movie' }] } };
        }
        throw new Error(`Unexpected Emby GET ${parsed.pathname}`);
      },
      httpPost: async (url, body) => {
        const parsed = new URL(url);
        postCalls.push({ url: parsed, body });
        if (parsed.pathname === '/Items/item-1/PlaybackInfo') {
          return {
            data: makePlaybackInfo({
              Container: 'mkv',
              SupportsDirectPlay: true,
              SupportsDirectStream: false,
              MediaStreams: [
                { Type: 'Video', Codec: 'h264', Index: 0 },
                { Type: 'Audio', Codec: 'flac', Index: 1, IsDefault: true, Channels: 6 },
              ],
            }),
          };
        }
        throw new Error(`Unexpected Emby POST ${parsed.pathname}`);
      },
    });

    const result = await emby.getEmbyStreams('movie', 'tt1234567', {
      userUUID: 'addon-user-1',
      apiKeys: {
        embyServer: 'https://emby.example',
        embyUserId: 'user-1',
        embyAccessToken: 'token-abc',
      },
    });

    assert.equal(result.streams.length, 1);
    const directPlayAudio = postCalls[0].body.DeviceProfile.DirectPlayProfiles
      .map((profile) => profile.AudioCodec || '')
      .join(',');
    assert.match(directPlayAudio, /(^|,)flac(,|$)/i);

    const stream = result.streams[0];
    assert.match(stream.description, /Emby Direct Play/);
    assert.match(stream.behaviorHints.bingeGroup, /^emby-directplay-mkv-/);

    const signedToken = new URL(stream.url).pathname.split('/')[3];
    const payload = emby.verifySignedEmbyStreamToken(signedToken);
    assert.equal(payload.playMethod, 'DirectPlay');
    assert.equal(payload.ext, 'mkv');
    assert.equal(payload.transcodingUrlPath, undefined);
  });
});

test('PlaybackInfo transcode fallback is used only when Emby returns an unsupported source with TranscodingUrl', async () => {
  await withEnv({
    HOST_NAME: 'https://addon.example',
    EMBY_STREAM_PROXY_MODE: undefined,
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const postCalls = [];
    const emby = loadEmbyStreamsWithMocks({
      httpGet: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/Users/user-1/Items') {
          return { data: { Items: [{ Id: 'item-1', Name: 'V for Vendetta' }] } };
        }
        throw new Error(`Unexpected Emby GET ${parsed.pathname}`);
      },
      httpPost: async (url, body) => {
        const parsed = new URL(url);
        postCalls.push({ url: parsed, body });
        if (parsed.pathname === '/Items/item-1/PlaybackInfo') {
          return {
            data: {
              PlaySessionId: 'play-session-flac',
              MediaSources: [
                {
                  Id: 'media-source-flac',
                  Protocol: 'File',
                  Container: 'mkv',
                  SupportsDirectPlay: false,
                  SupportsDirectStream: false,
                  SupportsTranscoding: true,
                  TranscodingUrl: '/videos/item-1/master.m3u8?MediaSourceId=media-source-flac&PlaySessionId=play-session-flac&AudioStreamIndex=1&TranscodingMaxAudioChannels=2&api_key=token-abc',
                  TranscodingSubProtocol: 'hls',
                  TranscodingContainer: 'ts',
                  TranscodeReasons: 'AudioCodecNotSupported',
                  Bitrate: 10_600_000,
                  Size: 1_234_567_890,
                  Path: '/server/movies/V for Vendetta.mkv',
                  MediaStreams: [
                    { Type: 'Video', Codec: 'h264', Index: 0 },
                    { Type: 'Audio', Codec: 'flac', Index: 1, IsDefault: true, Channels: 6 },
                  ],
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected Emby POST ${parsed.pathname}`);
      },
    });

    const result = await emby.getEmbyStreams('movie', 'tt1234567', {
      userUUID: 'addon-user-1',
      apiKeys: {
        embyServer: 'https://emby.example',
        embyUserId: 'user-1',
        embyAccessToken: 'token-abc',
      },
      playbackClientId: 'client-hash-1',
      playbackDeviceName: 'AIO Addon client-hash-1',
    });

    assert.equal(result.streams.length, 1);
    const directPlayAudio = postCalls[0].body.DeviceProfile.DirectPlayProfiles
      .map((profile) => profile.AudioCodec || '')
      .join(',');
    assert.match(directPlayAudio, /(^|,)flac(,|$)/i);

    const stream = result.streams[0];
    assert.match(stream.description, /Emby Transcode/);
    assert.match(stream.description, /AudioCodecNotSupported/);
    assert.match(stream.behaviorHints.bingeGroup, /^emby-transcode-mkv-/);

    const streamUrl = new URL(stream.url);
    assert.equal(streamUrl.origin, 'https://addon.example');
    assert.match(streamUrl.pathname, /^\/emby\/play\/[^/]+\/stream\.m3u8$/);
    assert.doesNotMatch(stream.url, /token-abc|api_key|media-source-flac|play-session-flac/);

    const signedToken = streamUrl.pathname.split('/')[3];
    const payload = emby.verifySignedEmbyStreamToken(signedToken);
    assert.equal(payload.playMethod, 'Transcode');
    assert.equal(payload.mediaSourceId, 'media-source-flac');
    assert.equal(payload.playSessionId, 'play-session-flac');
    assert.equal(payload.audioStreamIndex, 1);
    assert.equal(payload.ext, 'm3u8');
    assert.doesNotMatch(payload.transcodingUrlPath, /api_key|token-abc/);

    const playbackUrl = new URL(emby.buildPlaybackUrlFromPayload({
      serverUrl: 'https://emby.example',
      accessToken: 'token-abc',
      userId: 'user-1',
      userUUID: 'addon-user-1',
    }, payload));
    assert.equal(playbackUrl.pathname, '/videos/item-1/master.m3u8');
    assert.equal(playbackUrl.searchParams.get('api_key'), 'token-abc');
    assert.equal(playbackUrl.searchParams.get('MediaSourceId'), 'media-source-flac');
    assert.equal(playbackUrl.searchParams.get('PlaySessionId'), 'play-session-flac');
  });
});

test('signed playback route reports Sessions/Playing and redirects to final static Emby URL', async () => {
  await withEnv({
    EMBY_STREAM_PROXY_MODE: 'redirect',
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const posts = [];
    const emby = loadEmbyStreamsWithMocks({
      httpPost: async (url, body, options) => {
        posts.push({ url: new URL(url), body, options });
        return { data: {}, status: 204 };
      },
    });

    const signedToken = emby.signEmbyStreamToken({
      userUUID: 'addon-user-1',
      itemId: 'item-1',
      mediaSourceId: 'media-source-1',
      playSessionId: 'play-session-1',
      container: 'mkv',
      ext: 'mkv',
      audioStreamIndex: 1,
      expiresAt: Date.now() + 60_000,
    });
    const res = {
      statusCode: null,
      jsonBody: null,
      redirectCode: null,
      redirectUrl: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.jsonBody = body;
        return this;
      },
      redirect(code, url) {
        this.redirectCode = code;
        this.redirectUrl = url;
        return this;
      },
    };

    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: {} },
      res,
      async (userUUID) => {
        assert.equal(userUUID, 'addon-user-1');
        return {
          apiKeys: {
            embyServer: 'https://emby.example',
            embyUserId: 'user-1',
            embyAccessToken: 'token-abc',
          },
        };
      }
    );

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url.pathname, '/Sessions/Playing');
    assert.equal(posts[0].url.searchParams.get('api_key'), 'token-abc');
    assert.equal(posts[0].body.ItemId, 'item-1');
    assert.equal(posts[0].body.MediaSourceId, 'media-source-1');
    assert.equal(posts[0].body.PlaySessionId, 'play-session-1');
    assert.equal(posts[0].body.PlayMethod, 'DirectPlay');
    assert.equal(posts[0].body.AudioStreamIndex, 1);
    assert.match(posts[0].options.headers['X-Emby-Authorization'], /DeviceId="aio-addon-[a-f0-9]{32}"/);

    assert.equal(res.redirectCode, 302);
    const redirectUrl = new URL(res.redirectUrl);
    assert.equal(redirectUrl.pathname, '/Videos/item-1/stream.mkv');
    assert.equal(redirectUrl.searchParams.get('static'), 'true');
    assert.equal(redirectUrl.searchParams.get('MediaSourceId'), 'media-source-1');
    assert.equal(redirectUrl.searchParams.get('PlaySessionId'), 'play-session-1');
    assert.equal(redirectUrl.searchParams.get('api_key'), 'token-abc');
  });
});

test('signed playback route reports Transcode and redirects to Emby HLS URL', async () => {
  await withEnv({
    EMBY_STREAM_PROXY_MODE: 'proxy',
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const posts = [];
    const emby = loadEmbyStreamsWithMocks({
      httpPost: async (url, body, options) => {
        posts.push({ url: new URL(url), body, options });
        return { data: {}, status: 204 };
      },
    });

    const signedToken = emby.signEmbyStreamToken({
      userUUID: 'addon-user-1',
      itemId: 'item-1',
      mediaSourceId: 'media-source-flac',
      playSessionId: 'play-session-flac',
      container: 'mkv',
      ext: 'm3u8',
      playMethod: 'Transcode',
      transcodingUrlPath: '/videos/item-1/master.m3u8?MediaSourceId=media-source-flac&PlaySessionId=play-session-flac&AudioStreamIndex=1',
      audioStreamIndex: 1,
      expiresAt: Date.now() + 60_000,
    });
    const res = {
      redirectCode: null,
      redirectUrl: null,
      status() {
        return this;
      },
      json() {
        return this;
      },
      redirect(code, url) {
        this.redirectCode = code;
        this.redirectUrl = url;
        return this;
      },
    };

    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: {} },
      res,
      async () => ({
        apiKeys: {
          embyServer: 'https://emby.example',
          embyUserId: 'user-1',
          embyAccessToken: 'token-abc',
        },
      })
    );

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url.pathname, '/Sessions/Playing');
    assert.equal(posts[0].body.PlayMethod, 'Transcode');
    assert.equal(posts[0].body.AudioStreamIndex, 1);

    assert.equal(res.redirectCode, 302);
    const redirectUrl = new URL(res.redirectUrl);
    assert.equal(redirectUrl.pathname, '/videos/item-1/master.m3u8');
    assert.equal(redirectUrl.searchParams.get('api_key'), 'token-abc');
    assert.equal(redirectUrl.searchParams.get('MediaSourceId'), 'media-source-flac');
    assert.equal(redirectUrl.searchParams.get('PlaySessionId'), 'play-session-flac');
    assert.equal(redirectUrl.searchParams.get('AudioStreamIndex'), '1');
  });
});

test('redirect mode expires its heartbeat lease without stopping upstream playback', async () => {
  await withEnv({
    EMBY_STREAM_PROXY_MODE: 'redirect',
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
    EMBY_PLAYBACK_PROGRESS_INTERVAL_MS: '20',
    EMBY_REDIRECT_PLAYBACK_HEARTBEAT_MS: '75',
  }, async () => {
    const posts = [];
    const emby = loadEmbyStreamsWithMocks({
      httpPost: async (url, body, options) => {
        posts.push({ url: new URL(url), body, options });
        return { data: {}, status: 204 };
      },
    });

    const signedToken = emby.signEmbyStreamToken({
      userUUID: 'addon-user-1',
      itemId: 'item-1',
      mediaSourceId: 'media-source-1',
      playSessionId: 'play-session-1',
      container: 'mkv',
      ext: 'mkv',
      expiresAt: Date.now() + 60_000,
    });
    const res = {
      redirectCode: null,
      redirectUrl: null,
      redirect(code, url) {
        this.redirectCode = code;
        this.redirectUrl = url;
        return this;
      },
      status() {
        return this;
      },
      json() {
        return this;
      },
    };

    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: {} },
      res,
      async () => ({
        apiKeys: {
          embyServer: 'https://emby.example',
          embyUserId: 'user-1',
          embyAccessToken: 'token-abc',
        },
      })
    );

    assert.equal(res.redirectCode, 302);
    await wait(50);

    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: {} },
      res,
      async () => ({
        apiKeys: {
          embyServer: 'https://emby.example',
          embyUserId: 'user-1',
          embyAccessToken: 'token-abc',
        },
      })
    );

    await wait(50);

    assert.equal(posts[0].url.pathname, '/Sessions/Playing');
    const progressPosts = posts.filter((post) => post.url.pathname === '/Sessions/Playing/Progress');
    assert.ok(progressPosts.length >= 1);
    assert.equal(progressPosts[0].body.EventName, 'TimeUpdate');
    assert.equal(progressPosts[0].body.PlayMethod, 'DirectPlay');

    assert.equal(posts.filter((post) => post.url.pathname === '/Sessions/Playing/Stopped').length, 0);

    await wait(50);

    assert.equal(posts.filter((post) => post.url.pathname === '/Sessions/Playing/Stopped').length, 0);
    const progressCountAfterLeaseExpiry = posts.filter(
      (post) => post.url.pathname === '/Sessions/Playing/Progress'
    ).length;
    await wait(50);

    assert.equal(
      posts.filter((post) => post.url.pathname === '/Sessions/Playing/Progress').length,
      progressCountAfterLeaseExpiry
    );
  });
});

test('playback progress helper posts DirectPlay progress payload with position and event name', async () => {
  const posts = [];
  const emby = loadEmbyStreamsWithMocks({
    httpPost: async (url, body, options) => {
      posts.push({ url: new URL(url), body, options });
      return { data: {}, status: 204 };
    },
  });

  await emby.reportPlaybackProgress(
    {
      serverUrl: 'https://emby.example',
      accessToken: 'token-abc',
      userId: 'user-1',
      userUUID: 'addon-user-1',
    },
    {
      itemId: 'item-1',
      mediaSourceId: 'media-source-1',
      playSessionId: 'play-session-1',
      container: 'mp4',
      ext: 'mp4',
      audioStreamIndex: 1,
      subtitleStreamIndex: 3,
      expiresAt: Date.now() + 60_000,
    },
    {
      positionTicks: 12_345,
      IsPaused: true,
      EventName: 'Pause',
    }
  );

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.pathname, '/Sessions/Playing/Progress');
  assert.equal(posts[0].body.ItemId, 'item-1');
  assert.equal(posts[0].body.MediaSourceId, 'media-source-1');
  assert.equal(posts[0].body.PlaySessionId, 'play-session-1');
  assert.equal(posts[0].body.PositionTicks, 12_345);
  assert.equal(posts[0].body.IsPaused, true);
  assert.equal(posts[0].body.EventName, 'Pause');
  assert.equal(posts[0].body.PlayMethod, 'DirectPlay');
  assert.equal(posts[0].body.AudioStreamIndex, 1);
  assert.equal(posts[0].body.SubtitleStreamIndex, 3);
  assert.equal(posts[0].url.searchParams.get('api_key'), 'token-abc');
});

test('proxy mode preserves range headers and cancels false stopped events across range switches', async () => {
  await withEnv({
    EMBY_STREAM_PROXY_MODE: 'proxy',
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
    EMBY_STREAM_STOP_DEBOUNCE_MS: '25',
    EMBY_PLAYBACK_PROGRESS_INTERVAL_MS: '20',
  }, async () => {
    const posts = [];
    const proxyRequests = [];
    const emby = loadEmbyStreamsWithMocks({
      httpPost: async (url, body, options) => {
        posts.push({ url: new URL(url), body, options });
        return { data: {}, status: 204 };
      },
      undiciRequest: async (url, options) => {
        proxyRequests.push({ url: new URL(url), options });
        return {
          statusCode: 206,
          headers: {
            'content-range': 'bytes 0-1023/2048',
            'accept-ranges': 'bytes',
            'content-length': '1024',
            'content-type': 'video/x-matroska',
            etag: '"abc"',
            'last-modified': 'Wed, 01 Jul 2026 12:00:00 GMT',
          },
          body: Readable.from(['video-bytes']),
        };
      },
    });

    const signedToken = emby.signEmbyStreamToken({
      userUUID: 'addon-user-1',
      itemId: 'item-1',
      mediaSourceId: 'media-source-1',
      playSessionId: 'play-session-1',
      container: 'mkv',
      ext: 'mkv',
      expiresAt: Date.now() + 60_000,
    });
    const loadConfigFromDatabase = async (userUUID) => {
      assert.equal(userUUID, 'addon-user-1');
      return {
        apiKeys: {
          embyServer: 'https://emby.example',
          embyUserId: 'user-1',
          embyAccessToken: 'token-abc',
        },
      };
    };

    const firstRes = makeWritableResponse();
    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: { range: 'bytes=0-1023' } },
      firstRes,
      loadConfigFromDatabase
    );
    assert.equal(proxyRequests[0].options.headers.Range, 'bytes=0-1023');
    assert.equal(firstRes.statusCode, 206);
    assert.equal(firstRes.headers['content-range'], 'bytes 0-1023/2048');
    assert.equal(firstRes.headers['accept-ranges'], 'bytes');
    await wait(50);
    assert.ok(posts.some((post) => post.url.pathname === '/Sessions/Playing/Progress'));
    firstRes.emit('close');

    const secondRes = makeWritableResponse();
    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: { range: 'bytes=1024-2047' } },
      secondRes,
      loadConfigFromDatabase
    );
    assert.equal(proxyRequests[1].options.headers.Range, 'bytes=1024-2047');

    await wait(50);
    assert.equal(posts.filter((post) => post.url.pathname === '/Sessions/Playing/Stopped').length, 0);

    secondRes.emit('close');
    await wait(50);

    const stoppedPosts = posts.filter((post) => post.url.pathname === '/Sessions/Playing/Stopped');
    assert.equal(stoppedPosts.length, 1);
    assert.equal(stoppedPosts[0].body.ItemId, 'item-1');
    assert.equal(stoppedPosts[0].body.MediaSourceId, 'media-source-1');
    assert.equal(stoppedPosts[0].body.PlaySessionId, 'play-session-1');
    assert.equal(posts.filter((post) => post.url.pathname === '/Sessions/Playing').length, 2);
  });
});

test('request-derived playback client identity separates Emby DeviceIds without storing raw request data', () => {
  const emby = loadEmbyStreamsWithMocks();

  const firstClient = emby.getEmbyPlaybackClientFromRequest({
    headers: {
      'cf-connecting-ip': '203.0.113.10',
      'user-agent': 'Nuvio Android TV/1.0',
    },
  });
  const secondClient = emby.getEmbyPlaybackClientFromRequest({
    headers: {
      'cf-connecting-ip': '203.0.113.11',
      'user-agent': 'Nuvio Android TV/1.0',
    },
  });

  assert.ok(firstClient.playbackClientId);
  assert.notEqual(firstClient.playbackClientId, secondClient.playbackClientId);
  assert.doesNotMatch(JSON.stringify(firstClient), /203\.0\.113\.10|Nuvio Android TV/);

  const base = {
    serverUrl: 'https://emby.example',
    userId: 'user-1',
    userUUID: 'addon-user-1',
  };
  assert.notEqual(
    emby.getEmbyDeviceId({ ...base, playbackClientId: firstClient.playbackClientId }),
    emby.getEmbyDeviceId({ ...base, playbackClientId: secondClient.playbackClientId })
  );
});

test('proxy mode follows upstream redirects while preserving Range', async () => {
  await withEnv({
    EMBY_STREAM_PROXY_MODE: 'proxy',
    EMBY_STREAM_SIGNING_SECRET: 'unit-test-stream-secret',
  }, async () => {
    const proxyRequests = [];
    const emby = loadEmbyStreamsWithMocks({
      httpPost: async () => ({ data: {}, status: 204 }),
      undiciRequest: async (url, options) => {
        const parsed = new URL(url);
        proxyRequests.push({ url: parsed, options });
        if (proxyRequests.length === 1) {
          return {
            statusCode: 302,
            headers: {
              location: '/redirected-media/item-1.mkv?token=server-side',
            },
            body: Readable.from([]),
          };
        }
        return {
          statusCode: 206,
          headers: {
            'content-range': 'bytes 0-1023/4096',
            'accept-ranges': 'bytes',
            'content-length': '1024',
            'content-type': 'video/x-matroska',
          },
          body: Readable.from(['redirected-video-bytes']),
        };
      },
    });

    const signedToken = emby.signEmbyStreamToken({
      userUUID: 'addon-user-1',
      itemId: 'item-1',
      mediaSourceId: 'media-source-1',
      playSessionId: 'play-session-1',
      container: 'mkv',
      ext: 'mkv',
      expiresAt: Date.now() + 60_000,
    });
    const res = makeWritableResponse();

    await emby.handleSignedEmbyStreamRequest(
      { params: { signedToken }, headers: { range: 'bytes=0-1023' } },
      res,
      async () => ({
        apiKeys: {
          embyServer: 'https://emby.example',
          embyUserId: 'user-1',
          embyAccessToken: 'token-abc',
        },
      })
    );

    assert.equal(proxyRequests.length, 2);
    assert.equal(proxyRequests[0].url.pathname, '/Videos/item-1/stream.mkv');
    assert.equal(proxyRequests[0].options.headers.Range, 'bytes=0-1023');
    assert.equal(proxyRequests[1].url.href, 'https://emby.example/redirected-media/item-1.mkv?token=server-side');
    assert.equal(proxyRequests[1].options.headers.Range, 'bytes=0-1023');
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], 'bytes 0-1023/4096');
  });
});
