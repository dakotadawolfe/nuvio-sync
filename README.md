# AIO Addon

AIO Addon is a private Stremio metadata addon with one guided setup flow.

The configure page exposes only the pieces this instance uses:

- Required metadata keys: TMDB, TheTVDB, and RPDB.
- Required account connections: Trakt and Emby.
- Curated catalog defaults with Trakt recommendations first.
- Built-in OpenSubtitles v3 proxying, with optional SubDL fallback, so subtitles work through this addon.
- A simple configuration status and save/install flow.

Hidden upstream options are intentionally not part of this setup.

## Upstream Attribution

This project is a modified, deployment-focused fork of [cedya77/aiometadata](https://github.com/cedya77/aiometadata). Original upstream work remains credited to cedya77 and its contributors. This repository is distributed under GPL-3.0-only; see [LICENSE](LICENSE).

## Default Catalogs

Choosing **Start with Defaults** enables this order:

1. Recommended (Movies)
2. Recommended (TV)
3. Trending (Movies)
4. Trending (Series)
5. Popular (Movies)
6. Popular (Series)
7. Netflix (Movies)
8. Netflix (Series)
9. HBO Max (Movies)
10. HBO Max (Series)
11. Disney+ (Movies)
12. Disney+ (Series)
13. Prime Video (Movies)
14. Prime Video (Series)
15. Apple TV+ (Movies)
16. Apple TV+ (Series)
17. Paramount+ (Movies)
18. Paramount+ (Series)
19. Peacock Premium (Movies)
20. Peacock Premium (Series)
21. Hulu (Movies)
22. Hulu (Series)
23. Crunchyroll (Series)
24. Crunchyroll (Movies)

## Required Setup

See [SETUP.md](SETUP.md) for a fresh-server guide.

At a high level:

1. Deploy the server with Node 24 or Docker.
2. Set the environment variables in `.env`.
3. Open `https://your-domain.com/configure`.
4. Enter TMDB, TheTVDB, and RPDB keys.
5. Connect Trakt.
6. Connect Emby.
7. Choose the default catalogs.
8. Save and install the generated Stremio addon URL.

## Local Development

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5174
```

For a backend build:

```bash
npm run build
npm run build:backend
npm run start:backend
```

The backend requires `DATABASE_URI` in the environment.

## Emby Direct Play

Emby streams are generated through a playback-aware `POST /Items/{Id}/PlaybackInfo` before the addon returns a Stremio stream. The request includes a Nuvio/Android-TV-style device profile so Emby can decide whether the selected source should Direct Play or transcode for the advertised client capabilities.

When Emby returns a Direct Play-capable media source, the addon builds a static Emby URL with `MediaSourceId`, `PlaySessionId`, `static=true`, the existing saved Emby access token, and a container-specific path such as `stream.mkv` or `stream.mp4`. When Direct Play is not supported and Emby returns a `TranscodingUrl`, the signed addon URL carries only the sanitized transcode path; the server reattaches the saved Emby access token after signature validation and redirects to Emby's HLS/AAC URL.

The Stremio stream JSON route uses `Cache-Control: no-store` and does not emit ETags. Each click asks the addon for a fresh signed playback URL and a fresh Emby PlaybackInfo/PlaySessionId instead of reusing stale session data from client or proxy cache.

Existing Emby users do not need to reauthenticate. The addon still reads the saved `apiKeys.embyServer`, `apiKeys.embyUserId`, and `apiKeys.embyAccessToken` fields.

### Subtitle Providers

OpenSubtitles v3 is enabled by default. To add SubDL as a fallback source, set `SUBDL_API_KEY` on the server or save a SubDL key in `apiKeys.subdl` through the configure UI. The key is only used server-side for lookup requests and is not appended to returned subtitle download URLs.

Playback handoff defaults to signed redirect mode:

```bash
EMBY_STREAM_PROXY_MODE=redirect
```

Modes:

- `redirect`: returns an addon-owned signed URL, reports `/Sessions/Playing` when Stremio/Nuvio requests it, starts a bounded `/Sessions/Playing/Progress` heartbeat, then redirects to Emby.
- `proxy`: uses the same signed URL, reports playback start, forwards `Range` requests and upstream `206`/range headers through the addon, sends progress heartbeats while the proxy connection is active, and sends best-effort stopped reporting when the connection closes.
- `off`: returns the direct Emby static URL without addon playback reporting.

HLS transcode handoff uses redirect mode even if proxy mode is requested, because proxying only the master playlist without rewriting segment URLs can break playback. Direct Play streams can still use proxy mode for range-preserving diagnostics.

Optional diagnostics:

```bash
EMBY_DEBUG_PLAYBACK=true
EMBY_STREAM_SIGNING_SECRET=replace-with-stable-server-secret
EMBY_STREAM_STOP_DEBOUNCE_MS=1500
EMBY_PLAYBACK_PROGRESS_INTERVAL_MS=30000
EMBY_REDIRECT_PLAYBACK_HEARTBEAT_SECONDS=120
EMBY_DIRECT_PLAY_AUDIO_CODECS=aac,mp3,ac3,eac3,opus,flac
```

Core playback decisions are logged with redacted URL/token fields. `EMBY_DEBUG_PLAYBACK=true` adds the detailed URL shape and proxy-response diagnostics without logging Emby access tokens, `api_key` values, passwords, or signed stream tokens.

If `EMBY_STREAM_SIGNING_SECRET` is not set, the addon derives a stable signing secret from existing server-only secrets such as `ADDON_PASSWORD`, `ADMIN_KEY`, or `DATABASE_URI`. If none are available, only newly generated signed playback URLs expire on restart; saved Emby auth is not changed.

Stremio direct URL playback does not expose full native player pause, seek, and stop callbacks to this addon. Redirect mode reports playback start and keeps the Emby session active while the client continues requesting the signed stream URL. Each request renews a bounded inactivity lease; after 120 seconds without another request by default, the addon sends `Sessions/Playing/Stopped`. Proxy mode adds connection-close stopped reporting and range/response diagnostics, at the cost of routing video traffic through the addon server. Proxy mode follows upstream Emby redirects while preserving `Range` headers. `EMBY_STREAM_STOP_DEBOUNCE_MS` controls how long proxy mode waits before reporting stopped, which avoids false stops during byte-range switches. `EMBY_PLAYBACK_PROGRESS_INTERVAL_MS` controls progress heartbeat frequency. `EMBY_REDIRECT_PLAYBACK_HEARTBEAT_SECONDS` controls the redirect-mode inactivity timeout. The addon derives a hashed playback-client id from request metadata for Emby DeviceId separation without storing raw IP or User-Agent values in signed URLs.
