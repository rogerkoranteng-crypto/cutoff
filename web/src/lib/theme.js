// Bryntum ships one stylesheet per theme. Structural CSS and icons load once; the theme file is swapped for dark mode.
import '@bryntum/core-thin/fontawesome/css/fontawesome.css';
import '@bryntum/core-thin/fontawesome/css/solid.css';
import '@bryntum/core-thin/core.css';
import '@bryntum/grid-thin/grid.css';
import '@bryntum/scheduler-thin/scheduler.css';
import lightUrl from '@bryntum/core-thin/svalbard-light.css?url';
import darkUrl from '@bryntum/core-thin/svalbard-dark.css?url';

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  let link = document.getElementById('bryntum-theme');
  if (!link) {
    link = document.createElement('link');
    link.id = 'bryntum-theme';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const href = theme === 'dark' ? darkUrl : lightUrl;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  document.documentElement.style.colorScheme = theme;
  try { localStorage.setItem('cutoff-theme', theme); } catch { /* storage can be blocked */ }
}
export const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

// 24-hour clock and Monday-first weeks, to match the UTC times used everywhere else on the page.
import { LocaleManager } from '@bryntum/core-thin';
import '@bryntum/core-thin/locales/core.locale.EnGb.js';
import '@bryntum/grid-thin/locales/grid.locale.EnGb.js';
import '@bryntum/scheduler-thin/locales/scheduler.locale.EnGb.js';
LocaleManager.applyLocale('EnGb');
