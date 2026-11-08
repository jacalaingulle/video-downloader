import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function ytDlpPath() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const local = join(root, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return existsSync(local) ? local : 'yt-dlp';
}

// yt-dlp writes the cookies file back after each run, but hosts often mount secret files read-only
// (Render keeps them in /etc/secrets). Work from a private copy in the temp folder instead.
function cookiesFile() {
  const source = process.env.YTDLP_COOKIES_FILE;
  if (!source) return null;
  const copy = join(tmpdir(), 'spectra-cookies.txt');
  try {
    // Write the contents into a fresh, writable file: a plain copy would keep the read-only mode.
    if (existsSync(copy)) chmodSync(copy, 0o600);
    writeFileSync(copy, readFileSync(source), { mode: 0o600 });
    return copy;
  } catch (err) {
    console.error(`[yt-dlp] cannot read cookies file ${source}: ${err.message}`);
    return null;
  }
}

function staticDir() {
  const candidate = process.env.STATIC_DIR
    ? resolve(process.env.STATIC_DIR)
    : resolve(root, '..', 'frontend', 'dist', 'frontend', 'browser');
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

export const config = {
  port: int('PORT', 4000),
  host: process.env.HOST || '0.0.0.0',
  isProduction: process.env.NODE_ENV === 'production',
  // Number of reverse proxies in front of the app (Render, Railway, Nginx...): needed for per-IP rate limits.
  trustProxy: int('TRUST_PROXY', 0),
  corsOrigins: list('CORS_ORIGINS'),
  staticDir: staticDir(),

  ytDlpPath: ytDlpPath(),
  ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
  cookiesFile: cookiesFile(),
  proxy: process.env.YTDLP_PROXY || null,
  autoUpdate: bool('YTDLP_AUTO_UPDATE', false),

  downloadDir: resolve(process.env.DOWNLOAD_DIR || join(tmpdir(), 'spectra-downloads')),
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 3),
  maxDurationMinutes: int('MAX_DURATION_MINUTES', 180),
  fileTtlMinutes: int('FILE_TTL_MINUTES', 20),
  jobTimeoutMinutes: int('JOB_TIMEOUT_MINUTES', 30),

  rateLimitInfo: int('RATE_LIMIT_INFO', 60),
  rateLimitDownload: int('RATE_LIMIT_DOWNLOAD', 15),

  // Optional: when set, visitors must enter this passcode before they can use the site.
  passcode: process.env.SITE_PASSCODE || null,
};
