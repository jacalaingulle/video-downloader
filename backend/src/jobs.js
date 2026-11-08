import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { UserError, assertDownloadable, download, getRawInfo } from './media.js';

const jobs = new Map();

const activeCount = () => [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;

function safeFileName(title, ext) {
  const base = (title || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${base || 'video'}.${ext}`;
}

export function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    fileName: job.fileName,
  };
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export async function createJob({ link, kind, maxHeight }) {
  if (activeCount() >= config.maxConcurrentJobs) {
    throw new UserError('The server is busy right now. Please try again in a minute.', 503);
  }

  const job = {
    id: randomUUID(),
    status: 'queued',
    stage: 'Preparing',
    percent: 0,
    speed: null,
    eta: null,
    error: null,
    fileName: null,
    filePath: null,
    dir: null,
    createdAt: Date.now(),
    finishedAt: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  run(job, { link, kind, maxHeight });
  return job;
}

async function run(job, { link, kind, maxHeight }) {
  const timeout = setTimeout(() => job.controller.abort(), config.jobTimeoutMinutes * 60 * 1000);
  try {
    job.status = 'running';
    job.dir = join(config.downloadDir, job.id);
    await mkdir(job.dir, { recursive: true });

    const raw = await getRawInfo(link);
    assertDownloadable(raw);

    await download({
      raw,
      dir: job.dir,
      kind,
      maxHeight,
      signal: job.controller.signal,
      onProgress: (p) => {
        job.stage = p.stage;
        job.percent = Math.max(job.percent, p.percent);
        job.speed = p.speed ?? null;
        job.eta = p.eta ?? null;
      },
    });

    const media = (await readdir(job.dir)).find((f) => f.startsWith('media.') && !/\.(part|ytdl|json)$/.test(f));
    if (!media) throw new Error('download finished without an output file');

    job.filePath = join(job.dir, media);
    job.fileName = safeFileName(raw.title, media.split('.').pop());
    job.status = 'done';
    job.stage = 'Ready';
    job.percent = 100;
    job.speed = null;
    job.eta = null;
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof UserError ? err.message : 'Something went wrong while preparing the file.';
    if (!(err instanceof UserError) || err.detail) console.error(`[job ${job.id}]`, err.detail || err);
    await removeFiles(job);
  } finally {
    clearTimeout(timeout);
    job.finishedAt = Date.now();
  }
}

export function cancelJob(job) {
  if (job.status === 'queued' || job.status === 'running') job.controller.abort();
}

async function removeFiles(job) {
  if (job.dir) await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  job.filePath = null;
}

/** Deletes finished jobs and their files once they are older than FILE_TTL_MINUTES. */
export function startCleanup() {
  const ttl = config.fileTtlMinutes * 60 * 1000;
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.finishedAt && now - job.finishedAt > ttl) {
        jobs.delete(job.id);
        await removeFiles(job);
      }
    }
  }, 60 * 1000);
  timer.unref();
}

export async function resetDownloadDir() {
  await rm(config.downloadDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(config.downloadDir, { recursive: true });
}
