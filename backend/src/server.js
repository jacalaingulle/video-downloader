import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { cancelJob, createJob, getJob, publicJob, resetDownloadDir, startCleanup } from './jobs.js';
import { parseLink } from './links.js';
import { UserError, getRawInfo, getVersion, selfUpdate, summarize } from './media.js';

const INVALID_LINK = 'Paste a link to a YouTube or Facebook video.';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://*.fbcdn.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

if (config.corsOrigins.length) {
  app.use('/api', cors({ origin: config.corsOrigins, exposedHeaders: ['Content-Disposition'] }));
}
app.use(express.json({ limit: '10kb' }));

const limiter = (limit) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a few minutes and try again.' },
  });

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/info', limiter(config.rateLimitInfo), async (req, res, next) => {
  try {
    const link = parseLink(req.query.url);
    if (!link) throw new UserError(INVALID_LINK);
    res.json(summarize(await getRawInfo(link)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/jobs', limiter(config.rateLimitDownload), async (req, res, next) => {
  try {
    const { url, kind = 'video', maxHeight = null } = req.body ?? {};
    const link = parseLink(url);
    if (!link) throw new UserError(INVALID_LINK);
    if (!['video', 'audio'].includes(kind)) throw new UserError('Unknown format.');
    if (maxHeight !== null && (!Number.isInteger(maxHeight) || maxHeight < 144 || maxHeight > 4320)) {
      throw new UserError('Unknown quality.');
    }
    const job = await createJob({ link, kind, maxHeight: kind === 'video' ? maxHeight : null });
    res.status(202).json(publicJob(job));
  } catch (err) {
    next(err);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'This download has expired. Please start it again.' });
  res.set('Cache-Control', 'no-store').json(publicJob(job));
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (job) cancelJob(job);
  res.status(204).end();
});

app.get('/api/jobs/:id/file', async (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    if (!job || job.status !== 'done' || !job.filePath) {
      return res.status(404).json({ error: 'This download has expired. Please start it again.' });
    }
    const { size } = await stat(job.filePath);
    const ascii = job.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.set({
      'Content-Type': job.fileName.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
      'Cache-Control': 'no-store',
    });
    createReadStream(job.filePath).on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

if (config.staticDir) {
  app.use(express.static(config.staticDir, { index: false, maxAge: '7d', immutable: true }));
  app.get('/{*splat}', (_req, res) => {
    res.set('Cache-Control', 'no-cache').sendFile(join(config.staticDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  await resetDownloadDir();
  startCleanup();

  try {
    if (config.autoUpdate) {
      await selfUpdate();
      setInterval(selfUpdate, 24 * 60 * 60 * 1000).unref();
    }
    console.log(`yt-dlp ${await getVersion()} (${config.ytDlpPath})`);
  } catch (err) {
    console.error(`${err.message}. Run "npm run ytdlp:install" in backend/ or set YTDLP_PATH.`);
  }

  app.listen(config.port, config.host, () => {
    console.log(`Spectra API listening on http://localhost:${config.port}`);
    if (config.staticDir) console.log(`Serving frontend from ${config.staticDir}`);
  });
}

start();
