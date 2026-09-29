import { useEffect, useState } from 'preact/hooks'
import type { Snapshot, ViewItem } from '../src/events.ts'
import { Card, CommentsDialog } from './Card.tsx'
import { ago, column, currentPage, PAGES, sortWithin, type Page } from './derive.ts'
import { applyTheme, loadPrefs, savePrefs, THEMES, type Prefs, type Theme } from './prefs.ts'

const UI_POLL_MS = 15_000

async function api(path: string, body?: object): Promise<Snapshot> {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data
}

export function App() {
  const [snap, setSnap] = useState<Snapshot>({ me: '', items: [], lastPoll: '', lastError: '' })
  const [prefs, setPrefsState] = useState(loadPrefs)
  const [page, setPage] = useState(currentPage)
  const [dialog, setDialog] = useState<ViewItem | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(p => {
    const next = { ...p, ...patch }
    savePrefs(next)
    return next
  })
  const load = (path = '/api/state', body?: object, failure = 'UI') => api(path, body)
    .then(setSnap)
    .catch(e => setSnap(s => ({ ...s, lastError: `${failure}: ${(e as Error).message}` })))

  useEffect(() => {
    load()
    const poll = setInterval(() => load(), UI_POLL_MS)
    const onHash = () => setPage(currentPage())
    addEventListener('hashchange', onHash)
    return () => { clearInterval(poll); removeEventListener('hashchange', onHash) }
  }, [])

  useEffect(() => {
    applyTheme(prefs.theme)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const follow = () => applyTheme(prefs.theme)
    mq.addEventListener('change', follow)
    return () => mq.removeEventListener('change', follow)
  }, [prefs.theme])

  const unreadAll = snap.items.filter(i => i.unread).length
  useEffect(() => { document.title = `${unreadAll ? `(${unreadAll}) ` : ''}PR Watch` }, [unreadAll])

  const refresh = async () => {
    setRefreshing(true)
    await load('/api/refresh', {})
    setRefreshing(false)
  }
  const cycleTheme = () => {
    const order = Object.keys(THEMES) as Theme[]
    setPrefs({ theme: order[(order.indexOf(prefs.theme) + 1) % order.length] })
  }

  const mine = snap.items.filter(i => !prefs.mine || i.author === snap.me)
  // ignore saved repos that no longer have items, so a stale pref can't leave the board empty with no chip to undo it
  const repos = [...new Set(snap.items.map(i => i.repo))]
  const active = prefs.repos.filter(r => repos.includes(r))
  const items = mine.filter(i => !active.length || active.includes(i.repo))
  const { type, columns } = PAGES[page]

  const cardActions = {
    onDone: (i: ViewItem) => load('/api/done', { id: i.id, upTo: i.unreadEvents.at(-1)?.time ?? '' }, 'Done failed'),
    onWork: (i: ViewItem) => { load('/api/working', { id: i.id, on: !i.working }, 'Working failed') },
    onComments: setDialog,
  }
  const kidsOf = (i: ViewItem) => snap.items.filter(k => k.repo === i.repo && k.basePr === i.number).map(k => k.number)
  const status = snap.lastError
    || (snap.lastPoll ? `synced ${ago(snap.lastPoll) === 'now' ? 'just now' : `${ago(snap.lastPoll)} ago`}` : 'syncing…')

  return <>
    <header>
      <h1>PR Watch</h1>
      <Tabs items={items} page={page} />
      <span class={`status ${snap.lastError ? 'err' : ''}`} role="status">{status}</span>
      <label class="toggle">
        <input type="checkbox" checked={prefs.mine} onChange={e => setPrefs({ mine: e.currentTarget.checked })} />Mine only
      </label>
      <div class="seg" role="group" aria-label="Layout">
        {(['board', 'list'] as const).map(l =>
          <button key={l} type="button" aria-pressed={prefs.layout === l} onClick={() => setPrefs({ layout: l })}>{l === 'board' ? 'Board' : 'List'}</button>)}
      </div>
      <button class="btn" type="button" title={`Theme: ${prefs.theme} (click to switch)`} onClick={cycleTheme}>{THEMES[prefs.theme]}</button>
      <button class="btn" type="button" disabled={refreshing} onClick={refresh}>Refresh</button>
      <RepoChips repos={repos} active={active} items={mine.filter(i => i.type === type)} setRepos={r => setPrefs({ repos: r })} />
    </header>
    <main>
      <div class={`board ${prefs.layout}`}>
        {columns.map(c => {
          const list = sortWithin(c.key, items.filter(i => column(i, snap.me) === c.key))
          const expanded = !prefs.collapsed.includes(c.key)
          const toggle = () => setPrefs({ collapsed: expanded ? [...prefs.collapsed, c.key] : prefs.collapsed.filter(k => k !== c.key) })
          return <section key={c.key} class={`column ${c.key}`} aria-label={c.title}>
            <h2>
              <button class="col-head" type="button" aria-expanded={expanded} aria-controls={`stack-${c.key}`} onClick={toggle}>
                <span>{c.title}</span><span class="n">{list.length}</span><span class="chev" aria-hidden="true" />
              </button>
            </h2>
            {expanded && <div class="stack" id={`stack-${c.key}`}>
              {list.length
                ? list.map(i => <Card key={i.id} i={i} kids={kidsOf(i)} {...cardActions} />)
                : <p class="empty">{c.empty}</p>}
            </div>}
          </section>
        })}
      </div>
    </main>
    <CommentsDialog i={dialog} onClose={() => setDialog(null)} />
  </>
}

function Tabs({ items, page }: { items: ViewItem[]; page: Page }) {
  return <nav class="tabs" aria-label="Pages">
    {(Object.entries(PAGES) as [Page, (typeof PAGES)[Page]][]).map(([key, p]) => {
      const unread = items.filter(i => i.type === p.type && i.unread).length
      return <a key={key} href={`#${key}`} class="tab" aria-current={key === page ? 'page' : undefined}>
        {p.label}{unread > 0 && <span class="chip-n" title="unread">{unread}</span>}
      </a>
    })}
  </nav>
}

type ChipProps = { label: string; pressed: boolean; onClick: () => void; count?: number; title?: string }
const Chip = ({ label, pressed, onClick, count, title }: ChipProps) =>
  <button type="button" class="chip" aria-pressed={pressed} title={title} onClick={onClick}>
    {label}{count ? <span class="chip-n">{count}</span> : null}
  </button>

type ChipsProps = { repos: string[]; active: string[]; items: ViewItem[]; setRepos: (r: string[]) => void }
function RepoChips({ repos, active, items, setRepos }: ChipsProps) {
  const unreadIn = (r: string) => items.filter(i => i.repo === r && i.unread).length
  const sorted = repos.toSorted((a, b) => unreadIn(b) - unreadIn(a) || a.localeCompare(b))
  return <nav class="repos" aria-label="Filter by repository">
    <Chip label="All" pressed={!active.length} onClick={() => setRepos([])} />
    {sorted.map(r => <Chip key={r} label={r.split('/')[1]!} pressed={active.includes(r)} count={unreadIn(r)} title={r}
      onClick={() => setRepos(active.includes(r) ? active.filter(x => x !== r) : [...active, r])} />)}
  </nav>
}
