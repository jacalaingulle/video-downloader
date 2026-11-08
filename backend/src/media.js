import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function baseArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-color',
    '--ignore-config',
    '--js-runtimes',
    `node:${process.execPath}`,
    '--ffmpeg-location',
    config.ffmpegPath,
  ];
  if (config.cookiesFile) args.push('--cookies', config.cookiesFile);
  if (config.proxy) args.push('--proxy', config.proxy);
  return args;
}

/** Turns yt-dlp's error output into a message that is safe and useful to show to a visitor. */
export function friendlyError(stderr, platform = 'youtube') {
  const text = stderr || '';
  const site = platform === 'facebook' ? 'Facebook' : 'YouTube';
  const rules = [
    ...(platform === 'facebook'
      ? [
          [
            /registered users|log ?in|logged|private|cookies|cannot parse data|unsupported url/i,
            'This Facebook video is private or needs a login, so it cannot be downloaded. Only public videos work.',
          ],
        ]
      : []),
    [/private video/i, 'This video is private.'],
    [/confirm your age|age-restricted|inappropriate for some users/i, 'This video is age-restricted and cannot be downloaded.'],
    [/not a bot|sign in to confirm/i, `${site} is temporarily blocking requests from this server. Please try again later.`],
    [/members-only|join this channel/i, 'This video is for channel members only.'],
    [/premieres in|live event will begin|is upcoming/i, 'This video has not been released yet.'],
    [/not available in your country|geo.?restrict/i, "This video is not available in the server's region."],
    [/copyright/i, 'This video is no longer available because of a copyright claim.'],
    [/video (is )?unavailable|has been removed|does not exist|account .*terminated/i, 'This video is unavailable.'],
    [/http error 429|too many requests/i, `${site} is rate-limiting this server. Please try again in a few minutes.`],
  ];
  for (const [pattern, message] of rules) if (pattern.test(text)) return message;
  return 'The video could not be processed. Please check the link and try again.';
}

function run(args, { onLine, signal, platform } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, [...baseArgs(), ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';

    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onLine) {
        stdout += chunk;
        return;
      }
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) if (line) onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', abort);
      reject(
        err.code === 'ENOENT'
          ? new Error(`yt-dlp not found at "${config.ytDlpPath}"`)
          : err,
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (buffer && onLine) onLine(buffer);
      if (signal?.aborted) return reject(new UserError('Download cancelled.', 499));
      if (code === 0) return resolve(stdout);
      const err = new UserError(friendlyError(stderr, platform), 422);
      err.detail = stderr.trim().split('\n').slice(-3).join('\n');
      reject(err);
    });
  });
}

// Short-lived cache so the details request and the download that follows extract the video once.
const infoCache = new Map();
const INFO_TTL_MS = 10 * 60 * 1000;
const INFO_CACHE_MAX = 50;

/** Full yt-dlp metadata for a link from parseLink(). */
export async function getRawInfo(link) {
  const cached = infoCache.get(link.key);
  if (cached && cached.expires > Date.now()) return cached.raw;

  const raw = JSON.parse(await run(['--dump-single-json', '--', link.url], { platform: link.platform }));
  if (raw._type === 'playlist') throw new UserError('Playlists are not supported. Paste a single video link.');
  raw.__platform = link.platform;

  infoCache.set(link.key, { raw, expires: Date.now() + INFO_TTL_MS });
  if (infoCache.size > INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
  return raw;
}

function qualityLabel(height) {
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return 'Full HD';
  if (height >= 720) return 'HD';
  return 'SD';
}

/** The subset of yt-dlp's metadata the page needs. */
export function summarize(raw) {
  const videoFormats = (raw.formats ?? []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
  const heights = [...new Set(videoFormats.map((f) => f.height))].sort((a, b) => b - a);
  // "1080p" names the shorter side, so a vertical 1080x1920 Short is 1080p, not 1920p.
  const quality = (height) => {
    const width = videoFormats.find((f) => f.height === height)?.width ?? height;
    const p = Math.min(width, height);
    return { height, p, label: qualityLabel(p) };
  };
  const platform = raw.__platform ?? 'youtube';
  // Older Facebook videos only come as "hd" and "sd" files with no stated resolution.
  const namedHd = (raw.formats ?? []).some((f) => f.format_id === 'hd');
  const best = heights[0]
    ? quality(heights[0])
    : namedHd
      ? { height: null, p: null, label: 'HD' }
      : null;
  const fps = best?.height
    ? Math.max(0, ...videoFormats.filter((f) => f.height === best.height).map((f) => f.fps ?? 0))
    : 0;

  return {
    id: raw.id,
    platform,
    title: raw.title || raw.description?.slice(0, 120) || 'Untitled video',
    channel: raw.channel || raw.uploader || '',
    duration: raw.duration ?? null,
    // YouTube: hqdefault exists for every video; maxresdefault does not. Facebook: the CDN image yt-dlp found.
    thumbnail:
      platform === 'youtube'
        ? `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg`
        : /^https:\/\/[a-z0-9.-]+\.fbcdn\.net\//i.test(raw.thumbnail ?? '')
          ? raw.thumbnail
          : null,
    isLive: raw.is_live === true || raw.live_status === 'is_upcoming',
    best: best ? { ...best, fps: fps || null } : null,
    qualities: heights.map(quality),
  };
}

export function assertDownloadable(raw) {
  if (raw.is_live || raw.live_status === 'is_live') throw new UserError('Live streams cannot be downloaded while they are live.');
  if (raw.live_status === 'is_upcoming') throw new UserError('This video has not been released yet.');
  if (raw.duration && raw.duration > config.maxDurationMinutes * 60) {
    throw new UserError(`Videos longer than ${config.maxDurationMinutes} minutes are not supported.`);
  }
}

/**
 * Downloads into `dir`. Video: best video stream (optionally capped at `maxHeight`) merged with the best
 * audio into MP4. Audio: best audio stream converted to MP3 at the highest VBR quality.
 */
export async function download({ raw, dir, kind, maxHeight, signal, onProgress }) {
  const infoFile = join(dir, 'info.json');
  await writeFile(infoFile, JSON.stringify(raw));

  const cap = maxHeight ? `[height<=${maxHeight}]` : '';
  const args =
    kind === 'audio'
      ? ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
      : [
          '-f',
          `bv*${cap}+ba[ext=m4a]/bv*${cap}+ba/b${cap}/bv*+ba/b`,
          '-S',
          'res,fps,hdr:12,vcodec,acodec:m4a',
          '--merge-output-format',
          'mp4',
        ];

  // How many files yt-dlp fetches (video + audio = 2); read from its "Downloading N format(s): a+b" line.
  let parts = kind === 'audio' ? 1 : 2;
  let part = 0;
  let lastPct = 0;
  const report = (stage, pct, extra = {}) => onProgress({ stage, percent: Math.min(100, Math.round(pct * 10) / 10), ...extra });

  await run(
    [
      ...args,
      '--embed-metadata',
      '--no-mtime',
      '--newline',
      '--progress-template',
      'download:@@P %(progress)j',
      '-P',
      dir,
      '-o',
      'media.%(ext)s',
      '--load-info-json',
      infoFile,
    ],
    {
      signal,
      platform: raw.__platform,
      onLine(line) {
        const formats = /Downloading \d+ format\(s\): (\S+)/.exec(line);
        if (formats) parts = formats[1].split('+').length;
        if (line.startsWith('@@P ')) {
          let p;
          try {
            p = JSON.parse(line.slice(4));
          } catch {
            return;
          }
          const total = p.total_bytes || p.total_bytes_estimate;
          const pct = total ? (p.downloaded_bytes / total) * 100 : 0;
          if (pct + 5 < lastPct && part < parts - 1) part++;
          lastPct = pct;
          const overall = ((part + pct / 100) / parts) * 92;
          report(kind === 'video' && (part === 0 || parts === 1) ? 'Downloading video' : 'Downloading audio', overall, {
            speed: p.speed ?? null,
            eta: p.eta ?? null,
          });
          if (p.status === 'finished') {
            part = Math.min(part + 1, parts - 1);
            lastPct = 0;
          }
        } else if (line.startsWith('[Merger]')) {
          report('Merging video and audio', 95);
        } else if (line.startsWith('[ExtractAudio]')) {
          report('Converting to MP3', 95);
        } else if (line.startsWith('[Metadata]')) {
          report('Finishing', 98);
        }
      },
    },
  );
}

export async function getVersion() {
  return (await run(['--version'])).trim();
}

export function selfUpdate() {
  return run(['-U']).catch((err) => {
    console.warn(`[yt-dlp] update failed: ${err.detail || err.message}`);
  });
}
