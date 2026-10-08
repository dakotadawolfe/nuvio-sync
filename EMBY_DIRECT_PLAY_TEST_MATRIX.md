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

## Server and device audit - 2026-10-06

### Playback path and evidence

The production path is Nuvio on the device -> HTTPS Cloudflare Tunnel -> nginx -> the addon for catalog/stream negotiation. The signed playback endpoint redirects the device to the remote Emby server, which supplies media directly. Tailscale is the management/SSH path. Movie bytes do not normally pass through the local addon, nginx, or Cloudflare Tunnel. Locally hosted Bleach files are a separate path.

At inspection, all three application containers were healthy with zero restarts, approximately 4.9 GiB of available RAM, low CPU load, and 2.1 GiB free on a 15 GiB root filesystem. There was no pending OS reboot. A bounded 24 MiB read of the problem movie returned HTTP 206 in 6.29 seconds (32.0 Mbps including 4.36 seconds before headers). Earlier explicit middle/end byte ranges also returned the correct 206 offsets. A suffix range was incorrectly interpreted by the remote origin; the addon cannot repair that in redirect mode. These are server-to-origin observations, not measurements of either TV device's Wi-Fi.

### Server corrections

- DTS original playback remains first. The compatibility stream is negotiated only when requested, so an unused conversion option cannot delay original-stream discovery. HEAD and GET for the same compatibility link reuse negotiation for one minute.
- HEAD probes do not report playback starts or create progress heartbeats. Proxy mode forwards HEAD as HEAD and preserves range response headers.
- Signed playback handoffs send private/no-store and no-referrer headers. They are not reusable CDN cache entries.
- Playback signing no longer derives a key from a predictable database URI. Production uses a dedicated random `EMBY_STREAM_SIGNING_SECRET`, retained privately across restarts.
- nginx uses Docker DNS with a shared upstream zone so addon address changes are resolved without an nginx restart. Its upstream keepalive is enabled and proxy buffering is disabled.
- Access logs omit query strings, signed playback tokens, and addon profile IDs. Request and upstream timing remain available for diagnosis.
- Docker logs rotate at 20 MiB with three files per service. The production Compose/nginx configuration is tracked under `deploy/`.
- Docker build contexts exclude persistent databases, Redis files, backups, and environment files. The server has Docker Buildx installed so the repository's Dockerfile can build without a temporary workaround.
- Runtime dependency updates address 11 npm audit findings, including HTTP client/proxy handling, image decoder libraries, and CSV column parsing. The updated lockfile reports zero production advisories. The full development dependency scan still reports four high-severity entries involving nodemon/chokidar/braces and picomatch; those development tools are omitted from the runtime image. No forced dependency downgrade was applied.

To reproduce the deployed topology from the repository root, copy `deploy/nuvio.compose.yml` to `docker-compose.yml`, populate `.env` with private credentials and a random signing secret, and run `docker compose up -d --build`. The existing `/srv/nuvio-files/bleach` mount is for separately provisioned media. Keep database/media backups separate from source and build contexts.

The release passed the frontend/backend builds, all 32 backend tests, the poster badge image tests, and native SQLite/bcrypt and CSV-import smoke checks. nginx and production Compose configuration validation also passed. The playback tests cover deferred compatibility negotiation, HEAD without playback side effects, byte-range proxy handling, disabled server subtitle selection, and rejection of tokens forged with the former predictable database-derived key.

Release `8436162` was deployed and verified through the public hostname. Backend, nginx, and public health checks returned HTTP 200; all three containers were healthy with zero restarts. The movie stream list returned in 2.84 seconds with Original first and lazy Compatibility second. Original HEAD returned a private 302 in 0.24 seconds; Compatibility negotiated an AAC route in 2.05 seconds, and a repeated HEAD reused that session. Both redirects specified `SubtitleStreamIndex=-1`. A 128 KiB read at offset 7,123,244,980 returned HTTP 206 with the correct content range. Dedicated signing-key configuration, token redaction, and log rotation were verified in the running services. The production image's npm audit reported zero runtime advisories. These checks verify the server path; neither physical player was remotely inspected.

### Device findings and recommended baseline

| Area | Fire TV Stick 4K Max | Google TV Streamer 4K |
| --- | --- | --- |
| Ordinary H.264/HEVC video | Use device decoding and Original playback | Use device decoding and Original playback |
| DTS audio | Core DTS and DTS-HD are different. Generation and HDMI equipment matter; do not force DTS-HD passthrough based only on the codec label | The published Google specification lists Dolby audio; DTS decoding/output depends on the player and connected equipment |
| DTS trouble | Keep video hardware decoding; use app/FFmpeg audio decoding or the compatibility stream | Use app audio decoding or the compatibility stream |
| Experimental settings | Leave tunneling and forced optical passthrough off unless the actual audio setup needs and verifies them | Same |
| Buffers | Keep defaults/managed memory budget; oversized buffers can exhaust the 2 GiB device's app heap | Keep defaults/managed budget; more RAM does not cure a stalled upstream |
| Networking | Verify stable Wi-Fi; device generation determines Wi-Fi capabilities | Built-in gigabit Ethernet is available if Wi-Fi is inconsistent |

The problem request identified Nuvio 0.9.1-beta. The addon is shared by several versions, so other version strings in its logs do not identify these two devices. The official latest stable release observed was 1.0.0; use Nuvio's Stable channel for the main viewing devices. Between 0.9.1-beta and 1.0.0, upstream changes include FFmpeg downmix/buffer fixes, resume/episode-state fixes, and subtitle credential handling fixes.

In the inspected Nuvio source, ExoPlayer is the default engine, extension/audio decoder fallback is available, and tunneling is off by default. The custom buffer engine is off by default; when enabled, its managed budget is device-aware. Do not blindly enable parallel connections, force large buffers, or enable tunneling as general buffering cures. A published Nuvio issue includes a Fire Max 2nd-generation DTS-HD passthrough failure with silent audio and tunneled-video freezing; that does not establish a fault with ordinary DTS core on every device.

No device-local settings or firmware were inspected or changed. The addon cannot discover actual HDMI/audio support from a generic Nuvio user-agent, set local buffer settings, or detect a silent-audio failure and select the alternate stream automatically. Playback identity also uses an IP/user-agent fingerprint; clients behind the same NAT with identical versions may be indistinguishable without a stable client-supplied ID. Progress heartbeats are transport bookkeeping, not measured player positions, so Emby session positions should not be used as proof of real watch progress.

### Primary references

- [Nuvio 1.0.0 stable release](https://github.com/NuvioMedia/NuvioTV/releases/tag/1.0.0)
- [Nuvio player settings at 1.0.0](https://github.com/NuvioMedia/NuvioTV/blob/1.0.0/app/src/main/java/com/nuvio/tv/data/local/PlayerSettingsDataStore.kt)
- [Nuvio player initialization at 0.9.1-beta](https://github.com/NuvioMedia/NuvioTV/blob/0.9.1-beta/app/src/main/java/com/nuvio/tv/ui/screens/player/PlayerRuntimeControllerInitialization.kt)
- [Nuvio Fire Max DTS-HD report](https://github.com/NuvioMedia/NuvioTV/issues/2786)
- [Amazon Fire TV specifications](https://developer.amazon.com/docs/device-specs/device-specifications-fire-tv-streaming-media-player.html)
- [Google TV Streamer specifications](https://support.google.com/chromecast/answer/3046409?hl=en)
- [Google audio output settings](https://support.google.com/chromecast/answer/10110321?hl=en)
- [nginx upstream DNS resolution](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#resolve)
- [Docker JSON log rotation](https://docs.docker.com/engine/logging/drivers/json-file/)

## Lord of Mysteries episode 1 - 2026-10-07

The reported Google TV request was `tt28618556:1:1`, Emby episode `6785592` (The Fool). Its file contains 1080p, 8-bit H.264 video and recognized EAC3 audio tracks in German, English, Spanish, and French. The default Portuguese track at index 5 has no identified codec and reports `CodecTag=enca`. No Chinese audio track is listed in this particular copy.

With audio index 5, Emby rejected direct playback with `AudioCodecNotSupported`. Both HLS playlists returned HTTP 200, but the first actual media segment returned HTTP 500. With the same file and English audio index 2, Emby allowed direct play and direct stream. A 256 KiB original-file read returned HTTP 206 with the correct range in 1.09 seconds. This identifies a bad default audio selection and a failing upstream conversion, not a language-specific playback limitation.

The addon now checks for an identified audio codec before inheriting an unusable file default. When a valid alternate track exists, it prefers the configured language for that fallback and negotiates the alternate before requesting playback. It also honors Emby's negotiated audio index when constructing the URL. Valid original-language defaults remain unchanged, and server subtitle burn-in remains disabled. No provider media files or device settings were modified.

The frontend/backend builds and all 35 backend tests passed. A candidate built from the updated source was checked against the live provider and selected DirectPlay with English audio index 2 and subtitle index -1 for the exact episode. Tests also verify preservation of valid Chinese defaults and consistency with Emby's negotiated audio selection.
