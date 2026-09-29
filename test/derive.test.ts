import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Event, ViewItem } from '../src/events.ts'
import { topSignal } from '../web/derive.ts'

const ev = (kind: Event['kind'], text = ''): Event => ({ time: '1', actor: 'amy', kind, text, bot: false })
const pr = (over: Partial<ViewItem>): ViewItem => ({
  id: 'P', type: 'PR', repo: 'o/r', number: 1, title: 't', url: 'u', author: 'me', state: 'OPEN', draft: false,
  review: null, ci: null, mergeable: null, base: 'main', basePr: null, updatedAt: '1',
  unread: true, unreadCount: 1, latest: '1', unreadEvents: [], working: null, ...over,
})

test('snapshot signals only show while still true: a resolved conflict or fixed CI is not red', () => {
  const conflict = [ev('conflict')]
  assert.equal(topSignal(pr({ unreadEvents: conflict, mergeable: 'CONFLICTING' })).label, 'Merge conflict')
  assert.equal(topSignal(pr({ unreadEvents: conflict, mergeable: 'MERGEABLE' })).rank, 0)

  const ciFailed = [ev('ci', 'failure')]
  assert.equal(topSignal(pr({ unreadEvents: ciFailed, ci: 'FAILURE' })).label, 'CI failure')
  assert.equal(topSignal(pr({ unreadEvents: ciFailed, ci: 'SUCCESS' })).rank, 0)

  const changes = [ev('changes_requested'), ev('approved')]
  assert.equal(topSignal(pr({ unreadEvents: changes, review: 'CHANGES_REQUESTED' })).label, 'amy requested changes')
  assert.equal(topSignal(pr({ unreadEvents: changes, review: 'APPROVED' })).label, 'amy approved')
})
