// GitHub I/O only: token from the gh CLI, then plain fetch against GraphQL.
import { execFileSync } from 'node:child_process'
import { toEvents, toItem, type Detail, type Item, type RawItem } from './events.ts'

const ENDPOINT = 'https://api.github.com/graphql'
const SEARCH = 'is:open involves:@me'
const DETAIL_BATCH = 25
const TIMEOUT_MS = 30_000

const BASE = `
fragment PRBase on PullRequest {
  id number title url state isDraft reviewDecision mergeable updatedAt
  baseRefName baseRef { associatedPullRequests(first: 1, states: OPEN) { nodes { number } } }
  author { __typename login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment IssueBase on Issue {
  id number title url state updatedAt
  author { __typename login } repository { nameWithOwner }
}`

// ponytail: first 100 search hits; paginate if you're ever involved in more open items than that
const SEARCH_QUERY = `${BASE}
query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 100) { nodes { __typename ...PRBase ...IssueBase } }
}`

// ponytail: last 20 timeline items per fetch; older unread events beyond that are not summarized
const DETAIL_QUERY = `${BASE}
fragment A on Actor { __typename login }
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on PullRequest {
      ...PRBase
      timelineItems(last: 20, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT,
          HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, MERGED_EVENT, CLOSED_EVENT]) {
        nodes {
          __typename
          ... on IssueComment { createdAt bodyText author { ...A } }
          ... on PullRequestReview { submittedAt state bodyText author { ...A } comments(first: 1) { nodes { bodyText path } } }
          ... on PullRequestCommit { commit { committedDate messageHeadline authors(first: 1) { nodes { name user { login } } } } }
          ... on HeadRefForcePushedEvent { createdAt actor { ...A } }
          ... on ReviewRequestedEvent { createdAt actor { ...A } requestedReviewer { ... on User { login } } }
          ... on MergedEvent { createdAt actor { ...A } }
          ... on ClosedEvent { createdAt actor { ...A } }
        }
      }
    }
    ... on Issue {
      ...IssueBase
      timelineItems(last: 20, itemTypes: [ISSUE_COMMENT, CLOSED_EVENT]) {
        nodes {
          __typename
          ... on IssueComment { createdAt bodyText author { ...A } }
          ... on ClosedEvent { createdAt actor { ...A } }
        }
      }
    }
  }
}`

export function ghToken(): string {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

type GqlResult<T> = { data: T | null; errors?: { message: string }[] }

async function graphql<T>(token: string, query: string, variables: object): Promise<GqlResult<T>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as GqlResult<T>
  if (!body.data) throw new Error(body.errors?.map(e => e.message).join('; ') ?? 'empty GraphQL response')
  return body
}

export async function searchItems(token: string): Promise<{ me: string; items: Item[] }> {
  const { data, errors } = await graphql<{ viewer: { login: string }; search: { nodes: (RawItem | null)[] } }>(
    token, SEARCH_QUERY, { q: SEARCH })
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '))
  const items = data!.search.nodes.filter((n): n is RawItem => !!n?.id).map(toItem)
  return { me: data!.viewer.login, items }
}

/** Timelines for `ids`. A null entry means the node is gone (deleted / lost access). */
export async function fetchDetails(token: string, ids: string[], me: string): Promise<Map<string, Detail | null>> {
  const out = new Map<string, Detail | null>()
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch = ids.slice(i, i + DETAIL_BATCH)
    // partial errors are expected here: an unresolvable id comes back as a null node
    const { data } = await graphql<{ nodes: (RawItem | null)[] }>(token, DETAIL_QUERY, { ids: batch })
    batch.forEach((id, j) => {
      const raw = data!.nodes[j]
      out.set(id, raw ? { item: toItem(raw), events: toEvents(raw, me) } : null)
    })
  }
  return out
}
