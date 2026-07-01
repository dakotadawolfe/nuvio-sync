# AIO Addon

AIO Addon is a private Stremio metadata addon with one guided setup flow.

The configure page exposes only the pieces this instance uses:

- Required metadata keys: TMDB, TheTVDB, and RPDB.
- Required account connections: Trakt and Emby.
- Curated catalog defaults with Trakt recommendations first.
- Built-in OpenSubtitles v3 proxying so subtitles work through this addon.
- A simple configuration status and save/install flow.

Hidden upstream options are intentionally not part of this setup.

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

Emby streams are generated through `/Items/{Id}/PlaybackInfo` before the addon returns a Stremio stream. The selected Direct Play media source is used to build a static Emby URL with `MediaSourceId`, `PlaySessionId`, `static=true`, the existing saved Emby access token, and a container-specific path such as `stream.mkv` or `stream.mp4`.

Existing Emby users do not need to reauthenticate. The addon still reads the saved `apiKeys.embyServer`, `apiKeys.embyUserId`, and `apiKeys.embyAccessToken` fields.

Playback handoff defaults to signed redirect mode:

```bash
EMBY_STREAM_PROXY_MODE=redirect
```

Modes:

- `redirect`: returns an addon-owned signed URL, reports `/Sessions/Playing` when Stremio/Nuvio requests it, then redirects to Emby.
- `proxy`: uses the same signed URL, reports playback start, forwards `Range` requests and upstream `206`/range headers through the addon, and sends best-effort stopped reporting when the connection closes.
- `off`: returns the direct Emby static URL without addon playback reporting.

Optional diagnostics:

```bash
EMBY_DEBUG_PLAYBACK=true
EMBY_STREAM_SIGNING_SECRET=replace-with-stable-server-secret
EMBY_STREAM_STOP_DEBOUNCE_MS=1500
```

If `EMBY_STREAM_SIGNING_SECRET` is not set, the addon derives a stable signing secret from existing server-only secrets such as `ADDON_PASSWORD`, `ADMIN_KEY`, or `DATABASE_URI`. If none are available, only newly generated signed playback URLs expire on restart; saved Emby auth is not changed.

Stremio direct URL playback does not expose full native player pause, seek, and stop callbacks to this addon. Redirect mode can reliably report playback start when the stream URL is requested. Proxy mode adds best-effort stopped reporting and range/response diagnostics, at the cost of routing video traffic through the addon server. Proxy mode follows upstream Emby redirects while preserving `Range` headers. `EMBY_STREAM_STOP_DEBOUNCE_MS` controls how long proxy mode waits before reporting stopped, which avoids false stops during byte-range switches. Progress reporting helpers exist for callback-capable flows, but the addon does not synthesize fake position updates when the player has not provided a real position.
