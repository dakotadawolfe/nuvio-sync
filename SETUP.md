# Fresh Server Setup

This guide covers only the public setup flow for AIO Addon.

## 1. Create Required Accounts And Keys

You need:

- TMDB API key: https://www.themoviedb.org/settings/api
- TheTVDB API key: https://thetvdb.com/api-information
- RPDB API key: https://ratingposterdb.com/
- Trakt OAuth app: https://trakt.tv/oauth/applications
- Emby server account with access to your library

For Trakt, set the redirect URI to:

```text
https://your-domain.com/api/auth/trakt/callback
```

Replace `https://your-domain.com` with your real `HOST_NAME`.

## 2. Deploy With Docker

Copy the sample files:

```bash
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

Edit `.env` and set:

```text
HOST_NAME=https://your-domain.com
TMDB_API_KEY=...
TVDB_API_KEY=...
RPDB_API_KEY=...
TRAKT_CLIENT_ID=...
TRAKT_CLIENT_SECRET=...
TRAKT_REDIRECT_URI=https://your-domain.com/api/auth/trakt/callback
```

Start the server:

```bash
docker compose up -d --build
```

Check health:

```bash
curl http://127.0.0.1:3232/health
```

Put the service behind HTTPS before using it from Stremio outside your LAN.

## 3. Deploy With Node

Install Node 24, then run:

```bash
npm ci
npm run build
npm run build:backend
```

Create `.env` from `.env.example`, edit it, then start:

```bash
npm run start:backend
```

The default server port is `3232`.

## 4. Configure The Addon

Open:

```text
https://your-domain.com/configure
```

In **Integrations & API Keys**:

1. Enter TMDB, TheTVDB, and RPDB keys.
2. Use **Test All Keys** to verify them.
3. Open Trakt and complete the OAuth connection.
4. Enter your Emby server URL, username, and password, then choose **Connect Emby**.

Emby username/password are only used for the connection exchange. The saved config stores the Emby server URL, user id, and access token.

## 5. Catalog Defaults

Open **Catalogs**, choose **Start with Defaults**, then keep the curated default order:

1. Trakt recommendations
2. TMDB trending
3. TMDB popular
4. Major streaming provider rows

The exact enabled rows are listed in [README.md](README.md).

## 6. Save And Install

In **Configuration Status**, all required integrations should show **Configured**.

Save the configuration, copy the generated install URL, and install it in Stremio.

The addon also exposes subtitles through the built-in OpenSubtitles v3 proxy, so you only need this one Stremio addon installed.

## Updating

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

For Node:

```bash
git pull
npm ci
npm run build
npm run build:backend
npm run start:backend
```
