# Emby Direct Play Validation Matrix

Use this after deploying the Emby playback changes to the Nuvio/Stremio addon. Compare the same device, same media, and same network path against the official Emby Android TV app.

## Runtime Flags

Start with redirect mode:

```bash
EMBY_STREAM_PROXY_MODE=redirect
EMBY_DEBUG_PLAYBACK=true
EMBY_PLAYBACK_PROGRESS_INTERVAL_MS=30000
EMBY_REDIRECT_PLAYBACK_HEARTBEAT_SECONDS=120
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
| 8 | MKV with FLAC 5.1 audio, for example `tt0434409` |  |  |  |
| 9 | Alternate audio track if available |  |  |  |

## Evidence To Capture For Each Row

- Direct Play vs Direct Stream vs Transcode.
- PlaybackInfo method (`POST` preferred; GET should only appear as fallback after POST failure).
- Transcode reason if Emby chooses Transcode, for example `AudioCodecNotSupported`.
- Item id.
- Media source id.
- Play session id.
- Selected container.
- Selected video codec.
- Selected audio codec and index.
- Selected subtitle stream and index.
- Final stream URL path shape with tokens redacted.
- Whether `static=true` is used.
- Whether HLS is used deliberately because Emby selected Transcode.
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
- FLAC-capable devices should remain Direct Play when Emby PlaybackInfo reports the source is direct-playable.
- Any unsupported client audio should use Emby's PlaybackInfo-selected transcode path instead of the addon making a local codec-only decision.
- Stream JSON responses must be `no-store` and must not use ETags, so a new click does not reuse stale signed playback session data.
- Proxy mode should preserve `Range`, `206 Partial Content`, `Content-Range`, `Accept-Ranges`, `Content-Length`, `Content-Type`, `ETag`, and `Last-Modified`.
- Proxy mode should follow upstream Emby redirects without dropping the requested byte range.

## Original playback and DTS compatibility

The default Nuvio profile includes DTS for playback through the device/player decoder or a compatible audio receiver. `EMBY_DIRECT_PLAY_AUDIO_CODECS` still overrides the codec list for deployments that need a more restrictive profile.

For DTS sources that Emby reports as direct-playable, the first choice is **Emby · Original**. The addon separately negotiates **Emby · Compatibility** using AAC output for devices without working DTS audio. This is a manual alternate stream, not automatic detection of a playback failure. If compatibility negotiation fails, the original remains available. Other unsupported sources continue to use Emby's negotiated conversion path.

PlaybackInfo, signed playback URLs, and playback reports use `SubtitleStreamIndex=-1`. Nuvio handles subtitle selection and rendering; the addon no longer selects Emby's forced/default subtitle for server burn-in. Embedded subtitle tracks remain in the original file and the existing subtitle addons remain available.

Validate the DTS movie on both Fire TV Stick Max and Google TV Streamer: select Original, confirm picture/audio/seeking and player-rendered subtitles, then verify Compatibility if original audio fails. Server negotiation and byte-range checks do not establish successful playback on physical devices.
