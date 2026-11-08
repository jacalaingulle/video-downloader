# Spectra

Download YouTube and Facebook videos in the best available quality. Paste a link, choose MP4 video (up to 8K on YouTube, with sound) or MP3 audio, and download.

Accepted links: YouTube videos and Shorts (`youtube.com/watch`, `youtu.be`, `/shorts/`), and public Facebook videos and reels (`facebook.com/.../videos/...`, `/watch?v=`, `/reel/`, `/share/v/`, `/share/r/`, `fb.watch`). Private, friends-only and group videos on Facebook need a login and are refused with a clear message.

| Folder | Stack |
|---|---|
| `frontend/` | Angular 21 |
| `backend/` | Node.js 22+, Express 5, yt-dlp, ffmpeg |

## How it works

1. The page sends the link to `GET /api/info`, which returns the site, title, thumbnail, duration and available resolutions. The backend rebuilds every link as a clean canonical URL (`backend/src/links.js`) before it reaches yt-dlp.
2. `POST /api/jobs` downloads the best video and audio streams on the server and merges them into one MP4 (or converts the audio to MP3).
3. The page polls `GET /api/jobs/:id` for progress, then saves the file from `GET /api/jobs/:id/file`.

Files are deleted 20 minutes after they are ready, and the download folder is cleared on every start.

## Run locally

Requirements: Node.js 22.12 or newer.

```bash
npm run install:all
```

`npm install` in `backend/` downloads the yt-dlp binary for your system into `backend/bin` and the ffmpeg binary through `ffmpeg-static`.

Start both parts in two terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open http://localhost:4200. The Angular dev server forwards `/api` to the backend on port 4000.

## Production

The backend serves the built frontend, so one server runs the whole app.

```bash
npm run install:all
npm run build
npm start
```

Open http://localhost:4000.

### Docker

```bash
docker build -t spectra .
docker run -p 4000:4000 -e TRUST_PROXY=1 spectra
```

The image works on any host that runs containers: Render, Railway, Fly.io, DigitalOcean, a VPS. Set `TRUST_PROXY=1` when the host puts a proxy in front of the app (all of the ones listed do).

Pick a host with a persistent process and enough temporary disk for the largest file you expect (a 10-minute 4K video is about 1 GB). Serverless platforms (Vercel functions, Netlify functions) are not suitable for the backend.

### Frontend on a separate host

1. Set `apiUrl` in `frontend/src/environments/environment.ts` to the backend address, for example `https://api.example.com/api`.
2. Build with `npm run build` and upload `frontend/dist/frontend/browser`. Configure the host to serve `index.html` for unknown paths.
3. On the backend, set `CORS_ORIGINS` to the frontend address.

### Configuration

All settings are environment variables, listed with defaults in [`backend/.env.example`](backend/.env.example). Copy it to `backend/.env` for local use.

### Keeping downloads working

- **Update yt-dlp often.** YouTube changes regularly and older yt-dlp versions stop working. Set `YTDLP_AUTO_UPDATE=true` (the Docker image does) or run `npm run ytdlp:install` in `backend/`.
- **"YouTube (or Facebook) is temporarily blocking requests from this server"** means the site is challenging the host's IP address, which is common on cloud providers. Provide a `cookies.txt` file exported from a browser signed in to YouTube with `YTDLP_COOKIES_FILE`, or route requests through a residential proxy with `YTDLP_PROXY`.

## Legal

Downloading may be restricted by YouTube's and Facebook's Terms of Service and by copyright law in your country. Users should download only content they own or have permission to use.
