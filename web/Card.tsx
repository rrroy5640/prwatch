import { useEffect, useRef, useState } from 'preact/hooks'
import type { ViewItem } from '../src/events.ts'
import { actorsOf, ago, plural, tagsOf, textEvents, topSignal, type Signal } from './derive.ts'

const LEAVE_MS = 180
const MAX_ACTORS = 2 // fits the fixed card height
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// tiny + upscaled = pixel art (Chrome blanks pixelated *downscales*)
const Avatar = ({ login, size }: { login: string; size: number }) => (
  <img src={`https://github.com/${encodeURIComponent(login)}.png?size=${Math.round(size / 2)}`} alt="" loading="lazy" width={size} height={size} />
)

const ext = { target: '_blank', rel: 'noopener' }

// merge target: stacked PRs link to the PR they sit on, everything else just names the branch
function Base({ i }: { i: ViewItem }) {
  if (i.basePr) {
    return <a class="base" href={i.url.replace(/\d+$/, String(i.basePr))} {...ext} title={`Stacked on #${i.basePr} (${i.base})`}>→ #{i.basePr}</a>
  }
  return i.base ? <span class="base" title={`Merges into ${i.base}`}>→ {i.base}</span> : null
}

// ponytail: `kids` only has stacked PRs on the board; others stacked on it by people you don't follow are missed
function Num({ i, kids }: { i: ViewItem; kids: number[] }) {
  if (!kids.length) return <>#{i.number}</>
  return <span class="has-stack" title={`Stacked on this: ${kids.map(k => `#${k}`).join(', ')}`}>#{i.number}</span>
}

type CardProps = {
  i: ViewItem
  kids: number[]
  onDone: (i: ViewItem) => Promise<void>
  onWork: (i: ViewItem) => void
  onComments: (i: ViewItem) => void
}

export function Card({ i, kids, onDone, onWork, onComments }: CardProps) {
  const [leaving, setLeaving] = useState(false)
  const sig: Signal = i.unread || i.working ? topSignal(i) : { rank: 0 }
  const tone = i.working ? 'working' : sig.tone === 'red' ? 'tone-red' : ''

  const done = async () => {
    setLeaving(true)
    await Promise.all([onDone(i), new Promise(r => setTimeout(r, reducedMotion.matches ? 0 : LEAVE_MS))])
    setLeaving(false) // still mounted if Done failed or new events kept it on the board
  }

  const head = <>
    <div class="top">
      <span>{i.repo.split('/')[1]} <Num i={i} kids={kids} /></span>
      {i.draft && <span class="draft" title="Draft PR">Draft</span>}
      <Base i={i} />
      {i.ci && <span class={`ci ${i.ci}`} title={`CI ${i.ci.toLowerCase()}`}>CI</span>}
      <span class="when">{ago(i.latest)}</span>
    </div>
    <a class="title" href={i.url} {...ext} title={i.title}>{i.title}</a>
  </>

  if (!i.unread && !i.working) {
    const tags = tagsOf(i)
    return <article class="card" data-id={i.id}>
      {head}
      {tags.length > 0 && <div class="tags">{tags.map(([label, t]) => <span key={label} class={`tag ${t}`}>{label}</span>)}</div>}
    </article>
  }

  const actors = actorsOf(i).filter(a => a.summary)
  const n = textEvents(i).length
  return <article class={`card ${tone} ${leaving ? 'leaving' : ''}`} data-id={i.id}>
    {head}
    {actors.length > 0 && <div class="actors">
      {actors.slice(0, MAX_ACTORS).map(a => <div key={a.login} class="actor">
        <Avatar login={a.login} size={18} /><b>{a.login}</b><span>{a.summary}</span>
      </div>)}
    </div>}
    {sig.rank > 0
      ? <div><span class={`signal ${sig.tone}`}>{sig.label}</span></div>
      // ponytail: reminder only when no urgent signal, the fixed card height fits one
      : i.working && <div><span class="signal amber">In progress · Done when finished</span></div>}
    <div class="foot">
      {n > 0 && <button class="show-comments" type="button" aria-haspopup="dialog" onClick={() => onComments(i)}>{plural(n, 'comment')}</button>}
      <button
        class="btn work" type="button" aria-pressed={!!i.working} onClick={() => onWork(i)}
        title={i.working ? `Working since ${new Date(i.working).toLocaleString()}; click to unflag. Mark Done when finished.` : 'Flag as in progress'}
      >{i.working ? `▶ Working ${ago(i.working)}` : 'Work on it'}</button>
      <button class="btn done" type="button" onClick={done}
        title={i.working ? 'Finished? Mark done and clear the working flag' : 'Mark done until there is new activity'}>Done</button>
    </div>
  </article>
}

export function CommentsDialog({ i, onClose }: { i: ViewItem | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (i && !ref.current?.open) ref.current?.showModal() }, [i])
  return <dialog ref={ref} class="comments-dialog" aria-labelledby="dlg-title" onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
    {i && <>
      <div class="dlg-head">
        <div style="min-width:0">
          <div class="top">{i.repo} #{i.number}</div>
          <a class="title" id="dlg-title" href={i.url} {...ext}>{i.title}</a>
        </div>
      </div>
      <ul class="comments">
        {textEvents(i).map(e => {
          const m = e.text.match(/^([\w./-]+\.\w+): ([\s\S]*)$/) // "path/file.ts: body" from inline review comments
          return <li key={e.time + e.actor}>
            <Avatar login={e.actor} size={24} />
            <div class="bubble">
              <div class="meta"><b>{e.actor}</b> · {ago(e.time)}{m && <span class="file"> · {m[1]}</span>}</div>
              {m ? m[2] : e.text}
            </div>
          </li>
        })}
      </ul>
      <div class="dlg-foot">
        <a class="btn" href={i.url} {...ext}>Open on GitHub ↗</a>
        <button class="btn primary" type="button" autofocus onClick={() => ref.current?.close()}>Close</button>
      </div>
    </>}
  </dialog>
}
