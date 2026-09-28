import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ciEvent, conflictEvent, groupNotices, markDone, needsDetail, reconcile, setWorking, toEvents, toItem, view,
  type Detail, type Event, type Item, type RawItem, type State,
} from '../src/events.ts'

const ME = 'me'
const user = (login: string) => ({ __typename: 'User', login })

const item = (over: Partial<Item> = {}): Item => ({
  id: 'PR1', type: 'PR', repo: 'o/r', number: 1, title: 'Fix it', url: 'https://github.com/o/r/pull/1',
  author: ME, state: 'OPEN', draft: false, review: null, ci: null, mergeable: null, base: null, basePr: null, updatedAt: 't1', ...over,
})
const ev = (time: string, over: Partial<Event> = {}): Event =>
  ({ time, actor: 'bob', kind: 'comment', text: '', bot: false, ...over })
const empty: State = { me: ME, tracked: {} }

test('toEvents drops my own actions, maps review states, skips pending reviews', () => {
  const raw = {
    __typename: 'PullRequest',
    timelineItems: { nodes: [
      { __typename: 'IssueComment', createdAt: '3', bodyText: 'mine', author: user(ME) },
      { __typename: 'PullRequestReview', submittedAt: '2', state: 'CHANGES_REQUESTED', bodyText: '', author: user('amy'),
        comments: { nodes: [{ path: 'a.ts', bodyText: 'rename   this' }] } },
      { __typename: 'PullRequestReview', submittedAt: null, state: 'PENDING', bodyText: '', author: user('amy') },
      { __typename: 'IssueComment', createdAt: '1', bodyText: 'deployed', author: { __typename: 'Bot', login: 'vercel' } },
      { __typename: 'ReviewRequestedEvent', createdAt: '4', actor: user('amy'), requestedReviewer: { login: 'someone-else' } },
      { __typename: 'ReviewRequestedEvent', createdAt: '5', actor: user('amy'), requestedReviewer: { login: ME } },
      null,
    ] },
  } as unknown as RawItem
  assert.deepEqual(toEvents(raw, ME), [
    { time: '1', actor: 'vercel', kind: 'comment', text: 'deployed', bot: true },
    { time: '2', actor: 'amy', kind: 'changes_requested', text: 'a.ts: rename this', bot: false },
    { time: '5', actor: 'amy', kind: 'review_requested', text: '', bot: false },
  ])
})

test('ciEvent fires only on a change to a terminal state of a known item', () => {
  assert.equal(ciEvent(undefined, 'FAILURE', 'n'), null) // new item: no baseline yet
  assert.equal(ciEvent('SUCCESS', 'PENDING', 'n'), null)
  assert.equal(ciEvent('FAILURE', 'FAILURE', 'n'), null)
  assert.equal(ciEvent('PENDING', 'FAILURE', 'n')?.text, 'failure')
  assert.equal(ciEvent(null, 'SUCCESS', 'n')?.kind, 'ci')
})

test('needsDetail: new or changed hits, plus open items that vanished from search', () => {
  const state: State = { me: ME, tracked: {
    A: { item: item({ id: 'A', updatedAt: 't1' }), events: [], watermark: '', notifiedUpTo: '' },
    B: { item: item({ id: 'B' }), events: [], watermark: '', notifiedUpTo: '' },
    C: { item: item({ id: 'C', state: 'MERGED' }), events: [], watermark: '', notifiedUpTo: '' },
  } }
  const found = [item({ id: 'A', updatedAt: 't1' }), item({ id: 'N' })]
  assert.deepEqual(needsDetail(state, found), ['N', 'B'])
})

test('first poll is a baseline: unread shows, but no notifications', () => {
  const details = new Map<string, Detail>([['PR1', { item: item(), events: [ev('2')] }]])
  const { state, notices } = reconcile(empty, [item()], details, 'now', false)
  assert.equal(notices.length, 0)
  assert.equal(view(state)[0]!.unread, true)
  // same data again with notify on: already baselined, still nothing
  assert.equal(reconcile(state, [item()], new Map(), 'now', true).notices.length, 0)
})

test('new activity after Done notifies once and becomes unread again', () => {
  let { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [ev('2')] }]]), 'n', false)
  state = markDone(state, 'PR1', '2')
  assert.equal(view(state)[0]!.unread, false)

  const changed = item({ updatedAt: 't2' })
  const next = reconcile(state, [changed], new Map([['PR1', { item: changed, events: [ev('2'), ev('3', { kind: 'approved' })] }]]), 'n', true)
  assert.equal(next.notices.length, 1)
  assert.match(next.notices[0]!.message, /bob approved/)
  assert.deepEqual(view(next.state)[0]!.unreadEvents.map(e => e.time), ['3'])
  assert.equal(reconcile(next.state, [changed], new Map(), 'n', true).notices.length, 0)
})

test('Done only covers what the UI showed; later events stay unread', () => {
  const { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [ev('2'), ev('3')] }]]), 'n', false)
  assert.deepEqual(view(markDone(state, 'PR1', '2'))[0]!.unreadEvents.map(e => e.time), ['3'])
})

test('CI transition becomes an unread event and survives timeline refetches', () => {
  let { state } = reconcile(empty, [item({ ci: 'PENDING' })], new Map([['PR1', { item: item(), events: [] }]]), 'n', false)
  const failed = item({ ci: 'FAILURE' })
  const r = reconcile(state, [failed], new Map(), '5', true)
  assert.equal(r.notices[0]!.message, 'CI failure · Fix it')
  const refetched = item({ ci: 'FAILURE', updatedAt: 't9' })
  state = reconcile(r.state, [refetched], new Map([['PR1', { item: refetched, events: [ev('6')] }]]), '7', true).state
  assert.deepEqual(state.tracked.PR1!.events.map(e => e.kind), ['ci', 'comment'])
})

test('merged by someone else stays until Done; closed by me is dropped', () => {
  const { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [] }]]), 'n', false)
  const merged = item({ state: 'MERGED' })
  const r = reconcile(state, [], new Map([['PR1', { item: merged, events: [ev('4', { kind: 'merged' })] }]]), 'n', true)
  assert.match(r.notices[0]!.message, /bob merged/)
  assert.equal(view(r.state)[0]!.state, 'MERGED')
  // not refetched on later polls, still there
  assert.equal(needsDetail(r.state, []).length, 0)
  assert.equal(Object.keys(reconcile(r.state, [], new Map(), 'n', true).state.tracked).length, 1)
  // Done removes it for good
  assert.equal(Object.keys(markDone(r.state, 'PR1', '4').tracked).length, 0)

  const mine = reconcile(state, [], new Map([['PR1', { item: merged, events: [] }]]), 'n', true)
  assert.equal(Object.keys(mine.state.tracked).length, 0)
})

test('open item that left the search (no longer involves me) or was deleted is dropped', () => {
  const { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [] }]]), 'n', false)
  assert.equal(Object.keys(reconcile(state, [], new Map([['PR1', { item: item(), events: [] }]]), 'n', true).state.tracked).length, 0)
  assert.equal(Object.keys(reconcile(state, [], new Map([['PR1', null]]), 'n', true).state.tracked).length, 0)
  // detail fetch missing for it (e.g. failed batch): keep and retry next poll
  assert.equal(Object.keys(reconcile(state, [], new Map(), 'n', true).state.tracked).length, 1)
})

test('groupNotices collapses more than 3 into one summary', () => {
  const n = { group: 'g', title: 't', message: 'm', url: 'u' }
  assert.equal(groupNotices([n, n, n], 'app').length, 3)
  assert.deepEqual(groupNotices([n, n, n, n], 'app').map(x => x.message), ['4 items have new activity'])
})

test('view sorts unread first, then by latest activity', () => {
  const tracked: State['tracked'] = {
    A: { item: item({ id: 'A' }), events: [ev('9')], watermark: '9', notifiedUpTo: '9' },
    B: { item: item({ id: 'B' }), events: [ev('1')], watermark: '', notifiedUpTo: '1' },
    C: { item: item({ id: 'C' }), events: [ev('5')], watermark: '', notifiedUpTo: '5' },
  }
  assert.deepEqual(view({ me: ME, tracked }).map(v => v.id), ['C', 'B', 'A'])
})

test('comment text keeps paragraph breaks, squeezes other whitespace', () => {
  const raw = {
    __typename: 'Issue',
    timelineItems: { nodes: [{ __typename: 'IssueComment', createdAt: '1', author: user('bob'), bodyText: '  first   line \n\n\n\n second\tline\nthird ' }] },
  } as unknown as RawItem
  assert.equal(toEvents(raw, ME)[0]!.text, 'first line\n\nsecond line\nthird')
})

test('a merge is reported as merged, not closed (GitHub logs both at the same instant)', () => {
  const raw = {
    __typename: 'PullRequest',
    timelineItems: { nodes: [
      { __typename: 'MergedEvent', createdAt: '2026-09-28T04:52:23Z', actor: user('nicky') },
      { __typename: 'ClosedEvent', createdAt: '2026-09-28T04:52:23Z', actor: user('nicky') },
    ] },
  } as unknown as RawItem
  const events = toEvents(raw, ME)
  assert.deepEqual(events.map(e => e.kind), ['merged'])

  const { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [] }]]), 'n', false)
  const merged = item({ state: 'MERGED' })
  const r = reconcile(state, [], new Map([['PR1', { item: merged, events }]]), 'n', true)
  assert.match(r.notices[0]!.message, /nicky merged/)
})

test('conflict fires once per transition into CONFLICTING, UNKNOWN keeps last value', () => {
  assert.equal(conflictEvent(undefined, 'CONFLICTING', 'n'), null)
  assert.equal(conflictEvent('MERGEABLE', 'CONFLICTING', 'n')?.kind, 'conflict')
  let { state } = reconcile(empty, [item({ mergeable: 'MERGEABLE' })], new Map(), '1', false)
  const r = reconcile(state, [item({ mergeable: 'CONFLICTING' })], new Map(), '2', true)
  assert.equal(r.notices[0]?.message.startsWith('Merge conflict'), true)
  state = reconcile(r.state, [item({ mergeable: 'UNKNOWN' })], new Map(), '3', true).state
  assert.equal(state.tracked.PR1!.item.mergeable, 'CONFLICTING')
  const again = reconcile(state, [item({ mergeable: 'CONFLICTING' })], new Map(), '4', true)
  assert.equal(again.state.tracked.PR1!.events.filter(e => e.kind === 'conflict').length, 1)
})

test('working flag survives polls, can be cleared, and Done clears it', () => {
  const { state } = reconcile(empty, [item()], new Map([['PR1', { item: item(), events: [ev('2')] }]]), 'n', false)
  const working = setWorking(state, 'PR1', true, 'w1')
  assert.equal(view(working)[0]!.working, 'w1')
  assert.equal(setWorking(state, 'nope', true, 'w1'), state)
  const changed = item({ updatedAt: 't2' })
  const polled = reconcile(working, [changed], new Map([['PR1', { item: changed, events: [ev('2'), ev('3')] }]]), 'n', true).state
  assert.equal(view(polled)[0]!.working, 'w1')
  assert.equal(view(setWorking(polled, 'PR1', false, 'x'))[0]!.working, null)
  // Done with nothing unread shown (upTo '') still clears the flag and keeps events unread
  const done = view(markDone(polled, 'PR1', ''))[0]!
  assert.equal(done.working, null)
  assert.equal(done.unreadCount, 2)
})

test('toItem: base branch, plus the parent PR number when stacked', () => {
  const raw = (over: Partial<RawItem>) => ({
    __typename: 'PullRequest', id: 'P', number: 2, title: 't', url: 'u', state: 'OPEN', updatedAt: 't',
    author: user(ME), repository: { nameWithOwner: 'o/r' }, ...over,
  }) as RawItem
  const onMain = toItem(raw({ baseRefName: 'main', baseRef: { associatedPullRequests: { nodes: [] } } }))
  assert.deepEqual([onMain.base, onMain.basePr], ['main', null])
  const stacked = toItem(raw({ baseRefName: 'feat/a', baseRef: { associatedPullRequests: { nodes: [{ number: 1 }] } } }))
  assert.deepEqual([stacked.base, stacked.basePr], ['feat/a', 1])
  const deleted = toItem(raw({ baseRefName: 'gone', baseRef: null })) // base branch deleted
  assert.deepEqual([deleted.base, deleted.basePr], ['gone', null])
  const issue = toItem(raw({ __typename: 'Issue' }))
  assert.deepEqual([issue.base, issue.basePr], [null, null])
})
