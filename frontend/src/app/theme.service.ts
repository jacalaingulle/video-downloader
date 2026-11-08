import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'spectra-theme';
const THEME_COLOR: Record<Theme, string> = { light: '#f1f1f5', dark: '#060609' };

/**
 * Follows the system light/dark setting until the visitor picks a theme with the toggle;
 * from then on their choice is remembered.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly systemDark = this.document.defaultView?.matchMedia?.(
    '(prefers-color-scheme: dark)',
  );

  // public/theme-init.js has already applied the saved or system theme before the app started.
  readonly theme = signal<Theme>(
    this.document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );

  constructor() {
    effect(() => {
      const theme = this.theme();
      this.document.documentElement.setAttribute('data-theme', theme);
      this.document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLOR[theme]);
    });

    this.systemDark?.addEventListener('change', (event) => {
      if (!this.savedTheme()) this.theme.set(event.matches ? 'dark' : 'light');
    });
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be blocked (private mode); the choice then lasts for this visit only.
    }
  }

  private savedTheme(): Theme | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === 'light' || saved === 'dark' ? saved : null;
    } catch {
      return null;
    }
  }
}
