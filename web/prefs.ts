// Per-browser view settings in localStorage. Same key and shape as before the Preact port, so saved settings carry over.
export const THEMES = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }
export type Theme = keyof typeof THEMES
export type Prefs = { mine: boolean; layout: 'board' | 'list'; repos: string[]; collapsed: string[]; theme: Theme }

const KEY = 'prwatch'
const DEFAULTS: Prefs = { mine: false, layout: 'board', repos: [], collapsed: [], theme: 'system' } // repos: [] = all

export function loadPrefs(): Prefs {
  let p: Partial<Prefs> = {}
  try { p = JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch {}
  return {
    mine: p.mine === true,
    layout: p.layout === 'list' ? 'list' : 'board', // older versions stored 'cards'
    repos: Array.isArray(p.repos) ? p.repos : [],
    collapsed: Array.isArray(p.collapsed) ? p.collapsed : [],
    theme: p.theme && p.theme in THEMES ? p.theme : DEFAULTS.theme,
  }
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch {}
}

// ponytail: duplicates the inline pre-paint script in index.html, which must run before any module loads
export function applyTheme(pref: Theme) {
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
