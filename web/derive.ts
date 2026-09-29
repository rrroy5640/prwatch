// Pure view logic: what a card says and where it goes. No DOM here.
import type { Event, ViewItem } from '../src/events.ts'

export type Tone = 'red' | 'amber' | 'green' | 'purple' | ''
export type Signal = { rank: number; tone?: Tone; label?: string }
export type Column = { key: string; title: string; empty: string }

// each page is a list of sections; page comes from the URL hash so reloads and bookmarks keep it
export const PAGES = {
  prs: { label: 'Pull requests', type: 'PR', columns: [
    { key: 'action', title: 'Needs you', empty: 'All clear' },
    { key: 'waiting', title: 'Waiting on others', empty: 'Nothing waiting' },
    { key: 'handled', title: 'Handled', empty: 'Nothing here' },
  ] },
  issues: { label: 'Issues', type: 'Issue', columns: [
    { key: 'issue-new', title: 'Needs you', empty: 'All clear' },
    { key: 'issue-read', title: 'Handled', empty: 'Nothing here' },
  ] },
} satisfies Record<string, { label: string; type: ViewItem['type']; columns: Column[] }>
export type Page = keyof typeof PAGES
export const currentPage = (): Page => (location.hash === '#issues' ? 'issues' : 'prs')

export function ago(t: string | null | undefined): string {
  if (!t) return ''
  const m = (Date.now() - new Date(t).getTime()) / 60000
  if (m < 1) return 'now'
  if (m < 60) return `${Math.round(m)}m`
  if (m < 1440) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function column(i: ViewItem, me: string): string {
  // working stays in "Needs you" until Done, so it can't slip out of sight
  if (i.type === 'Issue') return i.unread || i.working ? 'issue-new' : 'issue-read'
  if (i.unread || i.working) return 'action'
  if (i.state === 'OPEN' && i.author === me && i.review !== 'APPROVED') return 'waiting'
  return 'handled'
}

// what's wrong with the PR right now, independent of events: a conflict or failing CI shows while it lasts,
// even if the event for it was never recorded (it predates tracking) or is already marked done
function stateSignals(i: ViewItem): Signal[] {
  if (i.state !== 'OPEN') return []
  const s: Signal[] = []
  if (i.mergeable === 'CONFLICTING') s.push({ rank: 3, tone: 'red', label: 'Merge conflict' })
  if (i.ci === 'FAILURE' || i.ci === 'ERROR') s.push({ rank: 3, tone: 'red', label: `CI ${i.ci.toLowerCase()}` })
  return s
}

// the most urgent unread event; ci/conflict events are left to stateSignals, and a change request
// only counts while it still stands (re-approved = not red)
function signalOf(e: Event, i: ViewItem): Signal {
  if (e.kind === 'changes_requested' && i.review === 'CHANGES_REQUESTED') return { rank: 3, tone: 'red', label: `${e.actor} requested changes` }
  if (e.kind === 'review_requested') return { rank: 2, tone: 'amber', label: `${e.actor} requested your review` }
  if (e.kind === 'approved') return { rank: 1, tone: 'green', label: `${e.actor} approved` }
  if (e.kind === 'merged') return { rank: 1, tone: 'purple', label: `${e.actor} merged` }
  if (e.kind === 'closed') return { rank: 1, tone: 'red', label: `${e.actor} closed` }
  return { rank: 0 }
}
// ties go to the later entry, so current state beats an event of the same rank
export const topSignal = (i: ViewItem): Signal =>
  [...i.unreadEvents.map(e => signalOf(e, i)), ...stateSignals(i)].reduce((a, b) => (b.rank >= a.rank ? b : a), { rank: 0 })

const TALK = new Set(['comment', 'reviewed', 'changes_requested', 'approved', 'dismissed'])
export type Actor = { login: string; comments: number; pushes: number; last: string; summary: string }
// "9 comments · 2 pushes" per person, most recently active first
export function actorsOf(i: ViewItem): Actor[] {
  const by = new Map<string, Omit<Actor, 'summary'>>()
  for (const e of i.unreadEvents) {
    if (e.kind === 'ci' || e.kind === 'conflict') continue
    const a = by.get(e.actor) ?? { login: e.actor, comments: 0, pushes: 0, last: '' }
    by.set(e.actor, {
      ...a,
      comments: a.comments + Number(TALK.has(e.kind) && !!e.text),
      pushes: a.pushes + Number(e.kind === 'commit' || e.kind === 'force_push'),
      last: e.time,
    })
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last)).map(a => ({
    ...a, summary: [a.comments && plural(a.comments, 'comment'), a.pushes && plural(a.pushes, 'push')].filter(Boolean).join(' · '),
  }))
}

export function tagsOf(i: ViewItem): [string, Tone][] {
  const t: [string, Tone][] = []
  if (i.state === 'MERGED') t.push(['Merged', 'purple'])
  if (i.state === 'CLOSED') t.push(['Closed', 'red'])
  if (i.state === 'OPEN' && i.mergeable === 'CONFLICTING') t.push(['Conflicts', 'red'])
  if (i.review === 'APPROVED') t.push(['Approved', 'green'])
  if (i.review === 'CHANGES_REQUESTED') t.push(['Changes requested', 'red'])
  if (i.review === 'REVIEW_REQUIRED') t.push(['Review required', 'amber'])
  return t
}

export const textEvents = (i: ViewItem) => i.unreadEvents.filter(e => e.text && e.kind !== 'ci').reverse()

export function sortWithin(key: string, items: ViewItem[]): ViewItem[] {
  const byTime = (a: ViewItem, b: ViewItem) => b.latest.localeCompare(a.latest)
  if (key !== 'action' && key !== 'issue-new') return items.toSorted(byTime)
  // in progress first, then most urgent, then newest
  return items.toSorted((a, b) => Number(!!b.working) - Number(!!a.working) || topSignal(b).rank - topSignal(a).rank || byTime(a, b))
}
