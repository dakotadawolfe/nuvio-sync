# Emby Direct Play Validation Matrix

Use this after deploying the Emby playback changes to the Nuvio/Stremio addon. Compare the same device, same media, and same network path against the official Emby Android TV app.

## Runtime Flags

Start with redirect mode:

```bash
EMBY_STREAM_PROXY_MODE=redirect
EMBY_DEBUG_PLAYBACK=true
EMBY_PLAYBACK_PROGRESS_INTERVAL_MS=30000
EMBY_REDIRECT_PLAYBACK_HEARTBEAT_SECONDS=21600
```

If redirect mode still buffers or range behavior is unclear, repeat the affected rows with:

```bash
EMBY_STREAM_PROXY_MODE=proxy
EMBY_DEBUG_PLAYBACK=true
EMBY_STREAM_STOP_DEBOUNCE_MS=1500
EMBY_PLAYBACK_PROGRESS_INTERVAL_MS=30000
```

## Matrix

| # | Scenario | Official Emby Android TV Result | Custom Nuvio/Stremio Result | Pass/Fail |
| - | - | - | - | - |
| 1 | Problem MKV around 10 Mbps |  |  |  |
| 2 | Problem MP4 around 4 Mbps |  |  |  |
| 3 | Known-good high-bitrate file around 24 Mbps |  |  |  |
| 4 | MP4 Direct Play with subtitles off |  |  |  |
| 5 | MP4 Direct Play with subtitles on |  |  |  |
| 6 | MKV Direct Play with subtitles off |  |  |  |
| 7 | MKV Direct Play with subtitles on |  |  |  |
| 8 | Alternate audio track if available |  |  |  |

## Evidence To Capture For Each Row

- Direct Play vs Direct Stream vs Transcode.
- Item id.
- Media source id.
- Play session id.
- Selected container.
- Selected video codec.
- Selected audio codec and index.
- Selected subtitle stream and index.
- Final stream URL path shape with tokens redacted.
- Whether `static=true` is used.
- Whether HLS is accidentally used.
- Whether `behaviorHints.notWebReady` is true or false.
- Whether Nuvio/Stremio requests byte ranges.
- Whether Emby returns `200` or `206`.
- Whether the Emby dashboard shows idle or active playback.
- Whether Emby shows a distinct addon DeviceId/device entry for each Nuvio device.
- Whether `/Sessions/Playing/Progress` succeeds after 5, 10, and 15 minutes.
- Whether playback buffers repeatedly, stalls once, or stays smooth.

## Acceptance Notes

- Existing users must not need Emby reauthentication.
- Existing saved `apiKeys.embyServer`, `apiKeys.embyUserId`, and `apiKeys.embyAccessToken` values must continue to work.
- MP4 and MKV must both use the PlaybackInfo/session-aware path.
- Direct Play-capable items must stay Direct Play/static and must not be forced to HLS/transcode.
- Proxy mode should preserve `Range`, `206 Partial Content`, `Content-Range`, `Accept-Ranges`, `Content-Length`, `Content-Type`, `ETag`, and `Last-Modified`.
- Proxy mode should follow upstream Emby redirects without dropping the requested byte range.
