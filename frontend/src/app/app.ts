import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeService } from './theme.service';
import {
  ApiError,
  DownloaderService,
  Job,
  MediaKind,
  PLATFORM_NAME,
  VideoInfo,
  checkLink,
  isSupportedVideoUrl,
} from './downloader.service';

type View = 'idle' | 'loading' | 'ready' | 'working' | 'done';
/** 'checking' while asking the server; 'locked' shows the passcode screen; 'open' shows the downloader. */
type Gate = 'checking' | 'locked' | 'open';

const POLL_MS = 800;
const RETRY_MS = 1500;
const MAX_POLL_MISSES = 10;
const HINT_DELAY_MS = 600;
/** After a finished download, the page clears itself once the visitor has done nothing for this long. */
const AUTO_CLEAR_MS = 2 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

@Component({
  selector: 'app-root',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnDestroy {
  private readonly downloader = inject(DownloaderService);
  protected readonly themes = inject(ThemeService);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private infoRequest = 0;

  protected readonly year = new Date().getFullYear();

  protected readonly gate = signal<Gate>('checking');
  protected readonly passcode = signal('');
  protected readonly passcodeError = signal<string | null>(null);
  protected readonly unlocking = signal(false);

  protected readonly url = signal('');
  protected readonly view = signal<View>('idle');
  protected readonly error = signal<string | null>(null);
  protected readonly info = signal<VideoInfo | null>(null);
  protected readonly kind = signal<MediaKind>('video');
  protected readonly quality = signal<number | null>(null);
  protected readonly job = signal<Job | null>(null);

  protected readonly urlValid = computed(() => isSupportedVideoUrl(this.url()));
  /** Site name shown inside the field once a supported video link is entered. */
  protected readonly platformName = computed(() => {
    const check = checkLink(this.url());
    return check.platform && !check.problem ? PLATFORM_NAME[check.platform] : null;
  });
  /** Shown under the field; set after a short pause in typing, or at once on paste or submit. */
  protected readonly linkHint = signal<string | null>(null);
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private autoClearTimer: ReturnType<typeof setInterval> | null = null;
  private autoClearDeadline = 0;
  /** Seconds until the finished card clears itself; null when no countdown is running. */
  protected readonly clearIn = signal<number | null>(null);
  /** The countdown as m:ss, for the finished card. */
  protected readonly clearInLabel = computed(() => {
    const left = this.clearIn();
    return left === null ? null : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  });
  protected readonly fileUrl = computed(() => {
    const job = this.job();
    return job ? this.downloader.fileUrl(job.id) : null;
  });
  protected readonly bestLabel = computed(() => {
    const best = this.info()?.best;
    if (!best) return null;
    const fps = best.fps && best.fps > 30 ? ` ${best.fps}fps` : '';
    return best.p ? `${best.p}p${fps} · ${best.label}` : best.label;
  });

  constructor() {
    void this.checkSession();
  }

  protected async submitPasscode(): Promise<void> {
    const passcode = this.passcode().trim();
    if (!passcode) {
      this.passcodeError.set('Enter the passcode.');
      return;
    }
    this.unlocking.set(true);
    this.passcodeError.set(null);
    try {
      await this.downloader.unlock(passcode);
      this.passcode.set('');
      this.gate.set('open');
    } catch (err) {
      this.passcodeError.set((err as Error).message);
    } finally {
      this.unlocking.set(false);
    }
  }

  protected onUrlChange(value: string): void {
    this.url.set(value);
    this.error.set(null);
    this.scheduleHint(value);
    if (this.view() === 'done') {
      // Typing a new link after a download starts over, so the old result must not clear it later.
      this.stopAutoClear();
      this.view.set('idle');
      this.info.set(null);
      this.job.set(null);
    }
    if (this.view() === 'ready' || this.view() === 'loading') {
      this.view.set('idle');
      this.info.set(null);
    }
  }

  protected onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text')?.trim();
    if (!text) return;
    event.preventDefault();
    this.onUrlChange(text);
    this.showHint();
    if (isSupportedVideoUrl(text)) void this.fetchInfo();
  }

  protected async fetchInfo(): Promise<void> {
    if (!this.urlValid()) {
      this.showHint();
      return;
    }
    this.stopAutoClear();
    const request = ++this.infoRequest;
    this.error.set(null);
    this.info.set(null);
    this.job.set(null);
    this.quality.set(null);
    this.view.set('loading');
    try {
      const info = await this.downloader.info(this.url().trim());
      if (request !== this.infoRequest) return;
      this.info.set(info);
      this.view.set('ready');
    } catch (err) {
      if (request !== this.infoRequest) return;
      this.view.set('idle');
      if (!this.lockIfNeeded(err)) this.error.set((err as Error).message);
    }
  }

  protected async startDownload(): Promise<void> {
    const info = this.info();
    if (!info) return;
    this.error.set(null);
    this.view.set('working');
    this.job.set({
      id: '',
      status: 'queued',
      stage: 'Preparing',
      percent: 0,
      speed: null,
      eta: null,
      error: null,
      fileName: null,
    });
    try {
      const job = await this.downloader.start(
        this.url().trim(),
        this.kind(),
        this.kind() === 'video' ? this.quality() : null,
      );
      if (this.view() !== 'working') {
        await this.downloader.cancel(job.id);
        return;
      }
      this.job.set(job);
      this.poll(job.id);
    } catch (err) {
      if (this.view() === 'working') this.fail((err as Error).message);
      this.lockIfNeeded(err);
    }
  }

  protected async cancel(): Promise<void> {
    const job = this.job();
    this.stopPolling();
    if (job?.id) await this.downloader.cancel(job.id);
    this.job.set(null);
    this.view.set('ready');
  }

  protected reset(): void {
    this.stopPolling();
    this.stopAutoClear();
    this.clearHint();
    this.infoRequest++;
    this.url.set('');
    this.info.set(null);
    this.job.set(null);
    this.error.set(null);
    this.kind.set('video');
    this.quality.set(null);
    this.view.set('idle');
  }

  protected saveFile(): void {
    const href = this.fileUrl();
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.rel = 'noopener';
    link.download = this.job()?.fileName ?? '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  protected formatDuration(seconds: number | null): string {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  protected formatSpeed(bytes: number | null): string {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytes / 1024).toFixed(0)} KB/s`;
  }

  protected formatEta(seconds: number | null): string {
    if (seconds === null || seconds === undefined) return '';
    if (seconds < 60) return `${seconds}s left`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.stopAutoClear();
    this.clearHint();
  }

  /**
   * Clears the page AUTO_CLEAR_MS after the download finished; any click, key or scroll restarts the wait.
   * The countdown only runs while the visitor is on the page: the browser's Save dialog, another tab or
   * another app pauses it, and coming back restarts the full wait. Otherwise the time spent choosing
   * where to save the file would run the countdown out behind the dialog.
   */
  private startAutoClear(): void {
    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, this.onAttentionChange, { capture: true, passive: true });
    }
    window.addEventListener('focus', this.onAttentionChange);
    window.addEventListener('blur', this.onAttentionChange);
    document.addEventListener('visibilitychange', this.onAttentionChange);
    this.onAttentionChange();
  }

  /** Activity and focus changes: count down while the visitor is on the page, hold while away. */
  private readonly onAttentionChange = (): void => {
    if (document.hasFocus() && document.visibilityState === 'visible') this.armAutoClear();
    else this.pauseAutoClear();
  };

  /** (Re)starts the wait; a frequent tick updates the countdown shown on the card. */
  private armAutoClear(): void {
    this.autoClearDeadline = Date.now() + AUTO_CLEAR_MS;
    this.clearIn.set(Math.round(AUTO_CLEAR_MS / 1000));
    this.autoClearTimer ??= setInterval(() => {
      const left = Math.max(0, Math.ceil((this.autoClearDeadline - Date.now()) / 1000));
      this.clearIn.set(left);
      if (left === 0 && this.view() === 'done') this.reset();
    }, 250);
  }

  /** Holds the countdown at the full wait while the visitor is away from the page. */
  private pauseAutoClear(): void {
    if (this.autoClearTimer) clearInterval(this.autoClearTimer);
    this.autoClearTimer = null;
    this.clearIn.set(Math.round(AUTO_CLEAR_MS / 1000));
  }

  private stopAutoClear(): void {
    for (const type of ACTIVITY_EVENTS) {
      document.removeEventListener(type, this.onAttentionChange, { capture: true });
    }
    window.removeEventListener('focus', this.onAttentionChange);
    window.removeEventListener('blur', this.onAttentionChange);
    document.removeEventListener('visibilitychange', this.onAttentionChange);
    if (this.autoClearTimer) clearInterval(this.autoClearTimer);
    this.autoClearTimer = null;
    this.clearIn.set(null);
  }

  /** Waits for a pause in typing so the message does not flash while a link is half typed. */
  private scheduleHint(value: string): void {
    this.clearHint();
    if (value.trim() && checkLink(value).problem)
      this.hintTimer = setTimeout(() => this.showHint(), HINT_DELAY_MS);
  }

  private showHint(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    const value = this.url();
    this.linkHint.set(value.trim() ? checkLink(value).problem : null);
  }

  private clearHint(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.linkHint.set(null);
  }

  /** `misses` counts consecutive progress checks that could not reach the server. */
  private poll(id: string, misses = 0): void {
    this.stopPolling();
    this.pollTimer = setTimeout(
      async () => {
        try {
          const job = await this.downloader.job(id);
          if (this.job()?.id !== id) return;
          this.job.set(job);
          if (job.status === 'done') {
            this.view.set('done');
            this.saveFile();
            this.startAutoClear();
          } else if (job.status === 'error') {
            this.fail(job.error ?? 'The download failed.');
          } else {
            this.poll(id);
          }
        } catch (err) {
          if (this.job()?.id !== id) return;
          // A dropped connection (mobile network, proxy hiccup) gets retried for a while before giving up.
          if (err instanceof ApiError && err.transient && misses < MAX_POLL_MISSES)
            this.poll(id, misses + 1);
          else {
            this.fail((err as Error).message);
            this.lockIfNeeded(err);
          }
        }
      },
      misses ? RETRY_MS : POLL_MS,
    );
  }

  private async checkSession(): Promise<void> {
    try {
      const session = await this.downloader.session();
      this.gate.set(session.locked && !session.unlocked ? 'locked' : 'open');
    } catch {
      // Server unreachable: show the downloader, which explains the problem on first use.
      this.gate.set('open');
    }
  }

  /** Shows the passcode screen when the server asks for it (for example after the passcode changed). */
  private lockIfNeeded(err: unknown): boolean {
    if (!(err instanceof ApiError && err.locked)) return false;
    this.error.set(null);
    this.gate.set('locked');
    return true;
  }

  private fail(message: string): void {
    this.stopPolling();
    this.error.set(message);
    this.job.set(null);
    this.view.set(this.info() ? 'ready' : 'idle');
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
