import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';

export type Platform = 'youtube' | 'facebook';

export const PLATFORM_NAME: Record<Platform, string> = { youtube: 'YouTube', facebook: 'Facebook' };

export interface Quality {
  /** Pixel height, used to cap the download; null when the site does not state it. */
  height: number | null;
  /** Shorter side, as qualities are named (1080p); null when unknown. */
  p: number | null;
  label: string;
}

export interface VideoInfo {
  id: string;
  platform: Platform;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  isLive: boolean;
  best: (Quality & { fps: number | null }) | null;
  qualities: Quality[];
}

export type MediaKind = 'video' | 'audio';

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: string;
  percent: number;
  speed: number | null;
  eta: number | null;
  error: string | null;
  fileName: string | null;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'mbasic.facebook.com',
  'touch.facebook.com',
  'fb.com',
  'www.fb.com',
  'fb.watch',
  'www.fb.watch',
]);

const NUMERIC_ID = /^\d{5,25}$/;
const SHARE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,39}$/;

export interface LinkCheck {
  /** The site the link belongs to, when it is one Spectra supports. */
  platform: Platform | null;
  /** Why the link cannot be downloaded, in words for the visitor; null when it is a usable video link. */
  problem: string | null;
}

/** Mirrors the backend's link check (backend/src/links.js) so mistakes are caught before a request. */
export function checkLink(value: string): LinkCheck {
  const unsupported =
    "This link isn't from YouTube or Facebook. Copy the address of a video from either site.";
  let url: URL;
  try {
    const raw = value.trim();
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { platform: null, problem: unsupported };
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (YOUTUBE_HOSTS.has(host)) {
    const id = host.endsWith('youtu.be')
      ? parts[0]
      : (url.searchParams.get('v') ??
        (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0]) ? parts[1] : null));
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { platform: 'youtube', problem: null };
    if (url.searchParams.has('list') || parts[0] === 'playlist') {
      return {
        platform: 'youtube',
        problem: "Playlist links aren't supported. Open one video and copy its link.",
      };
    }
    return {
      platform: 'youtube',
      problem: "This YouTube link doesn't point to a video. Open the video and copy its link.",
    };
  }

  if (FACEBOOK_HOSTS.has(host)) {
    const videos = parts.indexOf('videos');
    const isVideo = host.endsWith('fb.watch')
      ? SHARE_CODE.test(parts[0] ?? '')
      : ((parts[0] === 'watch' || parts[0] === 'video.php') &&
          NUMERIC_ID.test(url.searchParams.get('v') ?? '')) ||
        (parts[0] === 'reel' && NUMERIC_ID.test(parts[1] ?? '')) ||
        (parts[0] === 'share' &&
          ['v', 'r'].includes(parts[1]) &&
          SHARE_CODE.test(parts[2] ?? '')) ||
        (videos > 0 && parts.slice(videos + 1).some((p) => NUMERIC_ID.test(p)));
    if (isVideo) return { platform: 'facebook', problem: null };
    return {
      platform: 'facebook',
      problem:
        "This Facebook link doesn't point to a video. Open the video or reel and copy its link.",
    };
  }

  return { platform: null, problem: unsupported };
}

export function isSupportedVideoUrl(value: string): boolean {
  return checkLink(value).problem === null;
}

@Injectable({ providedIn: 'root' })
export class DownloaderService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  info(url: string): Promise<VideoInfo> {
    return this.call(this.http.get<VideoInfo>(`${this.api}/info`, { params: { url } }));
  }

  start(url: string, kind: MediaKind, maxHeight: number | null): Promise<Job> {
    return this.call(this.http.post<Job>(`${this.api}/jobs`, { url, kind, maxHeight }));
  }

  job(id: string): Promise<Job> {
    return this.call(this.http.get<Job>(`${this.api}/jobs/${id}`));
  }

  cancel(id: string): Promise<void> {
    return this.call(this.http.delete<void>(`${this.api}/jobs/${id}`)).catch(() => undefined);
  }

  fileUrl(id: string): string {
    return `${this.api}/jobs/${id}/file`;
  }

  private async call<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (err) {
      throw toApiError(err);
    }
  }
}

/** An API failure; `transient` means the server could not be reached and a retry may succeed. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

const UNREACHABLE = 'Cannot reach the server. Check your connection and try again.';

function toApiError(err: unknown): ApiError {
  if (err instanceof HttpErrorResponse) {
    // 0: no connection; 502/504: a proxy in front of the server could not reach it.
    if (err.status === 0 || err.status === 502 || err.status === 504)
      return new ApiError(UNREACHABLE, true);
    const message = err.error?.error;
    if (typeof message === 'string') return new ApiError(message, false);
  }
  return new ApiError('Something went wrong. Please try again.', false);
}
