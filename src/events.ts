// Pure logic: GraphQL JSON -> items/events, unread calculation, notifications. No I/O here.

export type Kind =
  | 'comment' | 'approved' | 'changes_requested' | 'reviewed' | 'dismissed'
  | 'commit' | 'force_push' | 'review_requested' | 'merged' | 'closed' | 'ci'

export type Event = { time: string; actor: string; kind: Kind; text: string; bot: boolean }

export type Item = {
  id: string
  type: 'PR' | 'Issue'
  repo: string
  number: number
  title: string
  url: string
  author: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  review: string | null
  ci: string | null
  updatedAt: string
}

export type Tracked = { item: Item; events: Event[]; watermark: string; notifiedUpTo: string }
export type State = { me: string; tracked: Record<string, Tracked> }
export type Detail = { item: Item; events: Event[] }
export type Notice = { group: string; title: string; message: string; url: string }

// --- raw GraphQL shapes (only the fields we query) ---
type RawActor = { __typename: string; login: string } | null
export type RawItem = {
  __typename: 'PullRequest' | 'Issue'
  id: string
  number: number
  title: string
  url: string
  state: Item['state']
  isDraft?: boolean
  reviewDecision?: string | null
  updatedAt: string
  author: RawActor
  repository: { nameWithOwner: string }
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  timelineItems?: { nodes: (RawTimeline | null)[] }
}
export type RawTimeline = {
  __typename: string
  createdAt?: string
  submittedAt?: string | null
  state?: string
  bodyText?: string
  author?: RawActor
  actor?: RawActor
  comments?: { nodes: { bodyText: string; path: string }[] }
  commit?: { committedDate: string; messageHeadline: string; authors: { nodes: { user: { login: string } | null; name: string }[] } }
  requestedReviewer?: { login?: string } | null
}

const MAX_EVENTS = 30
const MAX_TEXT = 2000 // full enough to read in the comments dialog
const NOTICE_GROUP_LIMIT = 3
const CI_TERMINAL = new Set(['SUCCESS', 'FAILURE', 'ERROR'])
const REVIEW_KIND: Record<string, Kind> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'reviewed', DISMISSED: 'dismissed',
}
const VERB: Record<Kind, string> = {
  comment: 'commented', approved: 'approved', changes_requested: 'requested changes', reviewed: 'reviewed',
  dismissed: 'dismissed a review', commit: 'pushed a commit', force_push: 'force-pushed',
  review_requested: 'requested your review', merged: 'merged', closed: 'closed', ci: 'CI',
}

const clip = (s = '') => {
  // keep line breaks (the dialog renders them), squeeze other whitespace
  const text = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text
}
const isBot = (a: RawActor) => !!a && (a.__typename === 'Bot' || a.login.endsWith('[bot]'))
const newest = (events: Event[]) => events.at(-1)?.time ?? ''
const byTime = (a: Event, b: Event) => a.time.localeCompare(b.time)

export function toItem(raw: RawItem): Item {
  return {
    id: raw.id,
    type: raw.__typename === 'PullRequest' ? 'PR' : 'Issue',
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? 'ghost',
    state: raw.state,
    draft: raw.isDraft ?? false,
    review: raw.reviewDecision ?? null,
    ci: raw.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    updatedAt: raw.updatedAt,
  }
}

function toEvent(n: RawTimeline, me: string): Event | null {
  const ev = (time: string | null | undefined, a: RawActor, kind: Kind, text = ''): Event | null =>
    time ? { time, actor: a?.login ?? 'ghost', kind, text: clip(text), bot: isBot(a) } : null
  switch (n.__typename) {
    case 'IssueComment':
      return ev(n.createdAt, n.author ?? null, 'comment', n.bodyText)
    case 'PullRequestReview': {
      const kind = REVIEW_KIND[n.state ?? '']
      if (!kind) return null // PENDING = unsubmitted draft review
      const c = n.comments?.nodes[0]
      return ev(n.submittedAt, n.author ?? null, kind, n.bodyText || (c ? `${c.path}: ${c.bodyText}` : ''))
    }
    case 'PullRequestCommit': {
      const a = n.commit!.authors.nodes[0]
      const login = a?.user?.login ?? a?.name ?? 'unknown'
      // ponytail: committedDate, not push time; a rebased old commit shows its original date
      return ev(n.commit!.committedDate, { __typename: 'User', login }, 'commit', n.commit!.messageHeadline)
    }
    case 'HeadRefForcePushedEvent':
      return ev(n.createdAt, n.actor ?? null, 'force_push')
    case 'ReviewRequestedEvent':
      return n.requestedReviewer?.login === me ? ev(n.createdAt, n.actor ?? null, 'review_requested') : null
    case 'MergedEvent':
      return ev(n.createdAt, n.actor ?? null, 'merged')
    case 'ClosedEvent':
      return ev(n.createdAt, n.actor ?? null, 'closed')
    default:
      return null
  }
}

/** Timeline -> events by others, oldest first. Your own actions are dropped. */
export function toEvents(raw: RawItem, me: string): Event[] {
  const events = (raw.timelineItems?.nodes ?? [])
    .flatMap(n => (n ? [toEvent(n, me)] : []))
    .filter((e): e is Event => e !== null && e.actor !== me)
  // GitHub logs a ClosedEvent alongside every MergedEvent, same instant: keep only the merge
  const mergedAt = new Set(events.filter(e => e.kind === 'merged').map(e => e.time))
  return events.filter(e => !(e.kind === 'closed' && mergedAt.has(e.time))).sort(byTime)
}

/** CI state is a snapshot, not a timeline event: synthesize one when it lands on a terminal state. */
export function ciEvent(prev: string | null | undefined, next: string | null, now: string): Event | null {
  if (prev === undefined || prev === next || !next || !CI_TERMINAL.has(next)) return null
  return { time: now, actor: 'CI', kind: 'ci', text: next.toLowerCase(), bot: true }
}

/** Which ids need a timeline fetch: new/changed search hits, plus open items that fell out of the search. */
export function needsDetail(state: State, found: Item[]): string[] {
  const foundIds = new Set(found.map(i => i.id))
  const changed = found.filter(i => state.tracked[i.id]?.item.updatedAt !== i.updatedAt).map(i => i.id)
  const vanished = Object.values(state.tracked)
    .filter(t => !foundIds.has(t.item.id) && t.item.state === 'OPEN')
    .map(t => t.item.id)
  return [...changed, ...vanished]
}

/**
 * Merge a poll result into state. `details` holds a fetched timeline per id from needsDetail
 * (null = node no longer exists). `notify` is false on the very first poll to set a baseline.
 */
export function reconcile(
  state: State, found: Item[], details: Map<string, Detail | null>, now: string, notify: boolean,
): { state: State; notices: Notice[] } {
  const foundById = new Map(found.map(i => [i.id, i]))
  const ids = new Set([...foundById.keys(), ...Object.keys(state.tracked)])
  const tracked: Record<string, Tracked> = {}
  const notices: Notice[] = []

  for (const id of ids) {
    const f = foundById.get(id)
    const d = details.get(id)
    const t = state.tracked[id]
    if (d === null) continue // deleted or no longer accessible
    const item = f ?? d?.item ?? t!.item
    if (!f && d && item.state === 'OPEN') continue // still open but no longer involves me

    const ci = t && f ? ciEvent(t.item.ci, f.ci, now) : null
    const kept = d ? (t?.events ?? []).filter(e => e.kind === 'ci') : (t?.events ?? [])
    const events = [...(d?.events ?? []), ...kept, ...(ci ? [ci] : [])].sort(byTime).slice(-MAX_EVENTS)
    // closed/merged with no close event by someone else => I closed it myself: stop tracking
    if (item.state !== 'OPEN' && !events.some(e => e.kind === 'merged' || e.kind === 'closed')) continue

    const watermark = t?.watermark ?? ''
    const top = newest(events)
    let notifiedUpTo = t?.notifiedUpTo ?? ''
    if (top > watermark && top > notifiedUpTo) {
      if (notify) notices.push(noticeFor(item, events.at(-1)!))
      notifiedUpTo = top
    }
    tracked[id] = { item, events, watermark, notifiedUpTo }
  }
  return { state: { ...state, tracked }, notices }
}

function noticeFor(item: Item, e: Event): Notice {
  const what = e.kind === 'ci' ? `CI ${e.text}` : `${e.actor} ${VERB[e.kind]}`
  return { group: item.id, title: `${item.repo}#${item.number}`, message: `${what} · ${item.title}`, url: item.url }
}

/** More than a few at once collapses into one summary notification. */
export function groupNotices(notices: Notice[], appUrl: string): Notice[] {
  if (notices.length <= NOTICE_GROUP_LIMIT) return notices
  return [{ group: 'prwatch-summary', title: 'PR Watch', message: `${notices.length} items have new activity`, url: appUrl }]
}

/** Mark done up to `upTo` (the newest event the UI showed), so events that arrive meanwhile stay unread. */
export function markDone(state: State, id: string, upTo: string): State {
  const t = state.tracked[id]
  if (!t) return state
  const { [id]: _, ...rest } = state.tracked
  if (t.item.state !== 'OPEN' && upTo >= newest(t.events)) return { ...state, tracked: rest }
  const watermark = upTo > t.watermark ? upTo : t.watermark
  return { ...state, tracked: { ...rest, [id]: { ...t, watermark } } }
}

export type ViewItem = Item & { unread: boolean; unreadCount: number; latest: string; unreadEvents: Event[] }

export function view(state: State): ViewItem[] {
  return Object.values(state.tracked)
    .map(t => {
      const unreadEvents = t.events.filter(e => e.time > t.watermark)
      return {
        ...t.item,
        unread: unreadEvents.length > 0,
        unreadCount: unreadEvents.length,
        latest: newest(t.events) || t.item.updatedAt,
        unreadEvents,
      }
    })
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.latest.localeCompare(a.latest))
}
