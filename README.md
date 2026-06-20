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
