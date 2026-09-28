// Poll loop + state file + macOS notifications + local HTTP server for the UI.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { groupNotices, markDone, needsDetail, reconcile, view, type Notice, type State } from './events.ts'
import { fetchDetails, ghToken, searchItems } from './github.ts'

const PORT = 8765
const APP_URL = `http://localhost:${PORT}`
const POLL_MS = 60_000
const MAX_BODY = 4096
const STATE_DIR = join(homedir(), '.prwatch')
const STATE_FILE = join(STATE_DIR, 'state.json')
const NOTIFIER_APP = '$(brew --prefix terminal-notifier)/terminal-notifier.app'
const PAGE = new URL('../public/index.html', import.meta.url)
// only answer to our own origin: blocks DNS-rebinding pages from reading your PR list
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`])

function loadState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Cannot read ${STATE_FILE} (fix or delete it): ${(e as Error).message}`)
  }
}

function saveState(s: State) {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(s))
  renameSync(tmp, STATE_FILE) // atomic: a crash mid-write never leaves a half file
}

// Windows toast via built-in PowerShell. Text comes in through env vars, so a PR title can't inject script.
const WIN_TOAST = `
$N = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$x = $N::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode($env:PRW_TITLE))
[void]$t.Item(1).AppendChild($x.CreateTextNode($env:PRW_MESSAGE))
$N::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($x)`

// ponytail: click-to-open only on macOS; Linux/Windows toasts are text only
const NOTIFIERS: Record<string, { cmd: string; probe: string[]; install: string; args: (n: Notice) => string[] }> = {
  darwin: {
    cmd: 'terminal-notifier', probe: ['-help'], install: 'brew install terminal-notifier',
    args: n => ['-title', n.title, '-message', n.message, '-open', n.url, '-group', n.group],
  },
  linux: {
    cmd: 'notify-send', probe: ['--version'], install: 'install libnotify (e.g. apt install libnotify-bin)',
    args: n => ['--app-name=PR Watch', n.title, n.message],
  },
  win32: {
    cmd: 'powershell.exe', probe: ['-NoProfile', '-Command', 'exit'], install: 'Windows PowerShell is missing',
    args: () => ['-NoProfile', '-NonInteractive', '-Command', WIN_TOAST],
  },
}
let notifier: (typeof NOTIFIERS)[string] | undefined = NOTIFIERS[process.platform]

function checkNotifier() {
  if (!notifier) return console.warn(`notifications not supported on ${process.platform}; the board still works`)
  try {
    execFileSync(notifier.cmd, notifier.probe, { stdio: 'ignore' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return
    console.warn(`${notifier.cmd} not found, notifications off (${notifier.install}); the board still works`)
    notifier = undefined
  }
}

function notify(n: Notice) {
  if (!notifier) return
  const env = { ...process.env, PRW_TITLE: n.title, PRW_MESSAGE: n.message }
  execFile(notifier.cmd, notifier.args(n), { env }, (err, _out, stderr) => {
    if (!err) return
    console.error('notification failed:', stderr.trim() || err.message)
    if (process.platform === 'darwin' && stderr.includes('not allowed')) {
      console.error(`  fix: run \`open ${NOTIFIER_APP}\` once, then allow it in System Settings → Notifications`)
    }
  })
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') // same format as GitHub timestamps

const saved = loadState()
let state: State = saved ?? { me: '', tracked: {} }
let baseline = saved === null // first run ever: record what exists, don't notify
let lastPoll = ''
let lastError = ''
let running: Promise<void> | null = null
let refetchAll = true // first poll after start re-downloads every timeline, so parsing changes apply to stored events

async function pollOnce() {
  const token = ghToken() // re-read each poll so `gh auth refresh` is picked up without a restart
  const { me, items } = await searchItems(token)
  const ids = refetchAll ? [...new Set([...items.map(i => i.id), ...needsDetail(state, items)])] : needsDetail(state, items)
  const details = await fetchDetails(token, ids, me)
  // read `state` only after the awaits so a Done clicked mid-poll is not overwritten
  const result = reconcile({ ...state, me }, items, details, nowIso(), !baseline)
  state = result.state
  saveState(state)
  baseline = false
  refetchAll = false
  groupNotices(result.notices, APP_URL).forEach(notify)
}

function poll(): Promise<void> {
  running ??= pollOnce()
    .then(() => { lastPoll = nowIso(); lastError = '' })
    .catch(e => { lastError = (e as Error).message; console.error('poll failed:', lastError) })
    .finally(() => { running = null })
  return running
}

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : String(body)
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` }).end(data)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) throw new Error('body too large')
  }
  return JSON.parse(body)
}

const snapshot = () => ({ me: state.me, lastPoll, lastError, items: view(state) })

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden host' })
  const route = `${req.method} ${req.url}`
  if (route === 'GET /') return send(res, 200, readFileSync(PAGE, 'utf8'), 'text/html')
  if (route === 'GET /api/state') return send(res, 200, snapshot())
  // JSON content type forces a CORS preflight we never answer, so other sites can't POST here
  if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') {
    return send(res, 415, { error: 'expected application/json' })
  }
  if (route === 'POST /api/refresh') {
    await poll()
    return send(res, 200, snapshot())
  }
  if (route === 'POST /api/done') {
    const body = (await readJson(req).catch(() => null)) as { id?: unknown; upTo?: unknown } | null
    if (typeof body?.id !== 'string' || typeof body.upTo !== 'string' || body.upTo.length > 40) {
      return send(res, 400, { error: 'expected {id, upTo}' })
    }
    state = markDone(state, body.id, body.upTo)
    saveState(state)
    return send(res, 200, snapshot())
  }
  send(res, 404, { error: 'not found' })
}

checkNotifier()
createServer((req, res) => {
  handle(req, res).catch(e => send(res, 500, { error: (e as Error).message }))
}).listen(PORT, '127.0.0.1', () => console.log(`PR Watch on ${APP_URL}`))
poll()
setInterval(poll, POLL_MS)
