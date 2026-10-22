/**
 * session-line — Claude Code mod
 *
 * The status line drawn by a mod instead of a statusLine command, which starts
 * a process on every refresh, with a prompt-cache meter in it. Two rows under
 * the prompt:
 *
 *   Opus 5.5 · xhigh │ ▓▓░░░░░░░░ 21.0% │ ⎇ main (+12,-3) │ 1hr 5m
 *   5h ▓░░░░░░░░░ 3.0% (2h33m) │ wk ▓▓░░░░░░░░ 19.0% (5d33m) │ cache 92% · 41m
 *
 * Where each figure comes from; none of it starts a process:
 *   - model: $.session.model(); effort: the main loop's last turn.step, or the
 *     effortLevel setting when that changed later
 *   - context and the 5h / weekly windows: $.session.usage() at the start, then
 *     what session.measure pushes; the session length from usage().startedAt
 *   - branch: .git/HEAD read through $.fs (a worktree's .git file followed)
 *   - (+ins,-del): `git diff HEAD --shortstat`, the one process, run at the
 *     start and once after each main-loop turn (gitChanges: false drops it)
 *   - cache: the four token counts of each main-loop request (turn.step)
 * A one-second $.clock.every redraws, and only when a text changed; model,
 * effort and HEAD are read again once a minute and after each prompt and turn.
 *
 * Tools that read the figures off the screen take the first ▓░ bar for the
 * context and the `5h` / `wk` bars for the limits, so the band and the pane
 * draw no bar glyph (▓░█▒▌▏) of their own.
 *
 * The cache meter is prompt-cache-control 0.1.0 by claude-code-templates
 * (https://github.com/davila7/claude-code-templates), MIT licence, merged in:
 * its pure half is ./cache.ts; its hooks (turn.step samples, the TTL rules and
 * the TTL observed from request timing, idle compaction, the countdown
 * toasts, the band and the /cache pane) are carried over below. Changed: the
 * band shows only when the cache needs you unless `band: "always"`, and the
 * cache figures sit in the status line.
 *
 * Options (the /config menu, or pluginConfigs["session-line@<marketplace>"].options):
 *   place: "hint" | "status"              two rows under the prompt, or one $.ui.status entry (default hint)
 *   ttl: "auto" | "5m" | "1h"            cache lifetime (default auto)
 *   warnSeconds: number                   warning threshold (default 60)
 *   compactAtTokens: number               prompt size that makes a lapsed cache worth a /compact (default 100000)
 *   band: "action" | "always" | "off"     row above the prompt (default action)
 *   toast: boolean                        toasts near expiry (default true)
 *   idleCompact: boolean                  idle compaction countdown and notice (default true)
 *   gitChanges: boolean                   (+ins,-del) from one git diff per turn (default true)
 */
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'
import {
  advise,
  COUNTDOWN_MARKS,
  byTurn,
  fit,
  fmtClock,
  fmtTokens,
  hitRatio,
  idleCompactAt,
  idlePolicy,
  isCachingDisabled,
  accountOf,
  decideTtl,
  missReason,
  observeTtl,
  lifeColor,
  lifeRatio,
  nextToastMark,
  positive,
  promptTokens,
  remainingMs,
  rowRatio,
  segments,
} from './cache.ts'
import type { Account, Advice, CacheEnv, IdleCompact, Sample, Ttl } from './cache.ts'
import { cacheText, lineSegments, parseGitFile, parseHead, parseShortstat, plain, prettyModel } from './line.ts'
import type { CacheView, Group } from './line.ts'

const PANE = 'cache'
const COMMAND = 'cache'
const KEEP = 200
// below this a lapsed cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000
// how often model, effort and HEAD are read again with nothing else asking
const SLOW_MS = 60_000
const EFFORT_KEY = 'effort'

// the cache meter (prompt-cache-control's state)
let samples: Sample[] = []
let ttl: Ttl = '5m'
let baseTtl: Ttl = '5m'
let pinned = false
let observed: Ttl | undefined
let setting: unknown
let account: Account = 'other'
let ttlSource = 'default'
let envSource = 'default'
let env: CacheEnv = {}
let lastKey = ''
let toastedFor = 0
let toastLevel = Infinity
let isPaneOpen = false
let idle: IdleCompact = idlePolicy({})
// the last compaction of the main conversation: a cache entry older than it is gone
let compacted: { at: number; trigger: string; before?: number; after?: number } | undefined

// the status line
let model = ''
let effort = 'default'
let settingEffort: unknown
// whether a main-loop request of this session has said its effort yet
let isEffortSeen = false
let startedAt: number | undefined
let context: SessionContextUsage = { window: 0 }
let rateLimits: SessionRateLimit[] = []
let repo: { cwd: string; dir: string; gitdir: string } | undefined
let branch: string | undefined
let changes: { ins: number; del: number } | undefined
let lastLine = ''
let lastSlow = 0
let isSlowDue = true
let isGitDue = true
let isBusy = false
let stopTimer: { cancel: () => void } | undefined

type Policy = { warnMs: number; compactAtTokens: number }

function current(policy: Policy, now: number) {
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = last ? isCachingDisabled(last.model, env) : isCachingDisabled('', env)
  if (last && compacted && compacted.at > last.startedAt) {
    // the conversation the last request cached is gone: the next one starts from the summary
    const sizes = compacted.before && compacted.after ? ` (${fmtTokens(compacted.before)} → ${fmtTokens(compacted.after)})` : ''
    const how = compacted.trigger === 'idle' ? 'compacted while idle' : 'compacted'
    const advice: Advice = { kind: 'cold', text: `${how}${sizes}: the next message starts from the summary` }
    return { last, advice, left: 0, idleAt: undefined, isCompacted: true }
  }
  const advice: Advice = advise(last, prev, { ttl, ...policy }, now, disabled)
  const left = last ? remainingMs(last, ttl, now) : 0
  const idleAt = disabled ? undefined : idleCompactAt(last, ttl, idle, now)
  return { last, advice, left, idleAt, isCompacted: false }
}

// "⇣ 41:12" until Claude Code compacts on its own, "⇣ now" once that moment has come
const idleClock = (idleAt: number, now: number) => (idleAt > now ? `⇣ ${fmtClock(idleAt - now)}` : '⇣ now')

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}

const ICON: Record<Advice['kind'], string> = {
  warm: '●',
  soon: '▲',
  expired: '✖',
  miss: '✖',
  off: '○',
  cold: '○',
  uncached: '○',
}

function cacheView(policy: Policy, now: number, showIdle: boolean): CacheView {
  const { last, advice, left, idleAt, isCompacted } = current(policy, now)
  if (advice.kind === 'off') return { state: 'off' }
  if (!last) return { state: 'none' }
  if (isCompacted) return { state: 'compacted' }
  if (advice.kind === 'uncached') return { state: 'uncached' }
  const isMiss = missReason(samples[samples.length - 2], last, ttl) !== undefined
  const idleInMs = showIdle && idleAt !== undefined ? idleAt - now : undefined
  return { state: 'live', ratio: hitRatio(last), leftMs: left, warnMs: policy.warnMs, isMiss, idleInMs }
}

// the band's one line when the cache needs the person; undefined when it does not
function actionLine(policy: Policy, now: number): { text: string; color: string } | undefined {
  const { last, advice, left } = current(policy, now)
  if (!last) return undefined
  const size = promptTokens(last)
  if (advice.kind === 'soon' && size >= TOAST_MIN_TOKENS) {
    return { color: 'yellow', text: `▲ cache lapses in ${fmtClock(left)}: send a message to keep ${fmtTokens(size)} tokens warm` }
  }
  if (advice.kind === 'expired' && size >= policy.compactAtTokens) {
    return { color: 'red', text: `✖ cache ${advice.text}` }
  }
  return undefined
}

type Settings = { promptCacheTtl?: unknown; idleCompaction?: unknown; autoCompactEnabled?: unknown }

// the settings the mod follows, each from the first settings file that sets it (local over project over user)
async function readSettings($: EngineInterface): Promise<Settings> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  const out: Settings = {}
  for (const file of files) {
    if (!file) continue
    try {
      const json = JSON.parse(await $.fs.read(file))
      if (out.promptCacheTtl === undefined && (json.promptCacheTtl === '5m' || json.promptCacheTtl === '1h')) out.promptCacheTtl = json.promptCacheTtl
      if (out.idleCompaction === undefined && typeof json.idleCompaction === 'boolean') out.idleCompaction = json.idleCompaction
      if (out.autoCompactEnabled === undefined && typeof json.autoCompactEnabled === 'boolean') out.autoCompactEnabled = json.autoCompactEnabled
    } catch {
      // missing or unreadable: the next file
    }
  }
  return out
}

// Claude Code's global config: the cached idle-compaction rollout flag, and autoCompactEnabled as /config saves it.
// Only those two keys are kept; nothing else in the file is held by the mod.
async function readGlobalConfig($: EngineInterface): Promise<{ flag?: unknown; autoCompact?: unknown }> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)
  const file = dir ? `${dir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  if (!file) return {}
  try {
    const json = JSON.parse(await $.fs.read(file))
    const flag = json?.cachedGrowthBookFeatures?.tengu_sunny_locket
    return { flag: flag && typeof flag === 'object' ? flag : undefined, autoCompact: json?.autoCompactEnabled }
  } catch {
    return {}
  }
}

// the work tree holding `cwd`, walked up as git does; its .git a folder, or a worktree's file naming one
async function findRepo($: EngineInterface, cwd: string): Promise<typeof repo> {
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (;;) {
    const dotGit = `${dir === '/' ? '' : dir}/.git`
    const stat = await $.fs.stat(dotGit).catch(() => undefined)
    if (stat?.kind === 'dir') return { cwd, dir, gitdir: dotGit }
    if (stat?.kind === 'file') {
      const gitdir = parseGitFile(await $.fs.read(dotGit).catch(() => ''), dir)
      if (gitdir) return { cwd, dir, gitdir }
    }
    if (dir === '/') return undefined
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
}

// model, effort setting and branch: engine calls and two small file reads
async function refreshSlow($: EngineInterface) {
  model = prettyModel(await $.session.model().catch(() => model))
  const level = await $.settings.read({ key: 'effortLevel' }).catch(() => settingEffort)
  // the setting wins only when it changed since the last read (/effort); else the last request's effort stands
  if (level !== settingEffort) {
    settingEffort = level
    if (typeof level === 'string' && level !== '') effort = level
  }
  // before the first request nothing says the effort: the one this model ran at last time stands in
  if (!isEffortSeen && !(typeof settingEffort === 'string' && settingEffort !== '')) {
    const known = await $.store.get(EFFORT_KEY).catch(() => undefined)
    const last = known && typeof known === 'object' ? (known as Record<string, unknown>)[model] : undefined
    if (typeof last === 'string') effort = last
  }
  if (startedAt === undefined) startedAt = (await $.session.usage().catch(() => undefined))?.startedAt
  const cwd = await $.session.cwd().catch(() => undefined)
  if (cwd === undefined) return
  if (repo?.cwd !== cwd) repo = await findRepo($, cwd)
  const head = repo ? await $.fs.read(`${repo.gitdir}/HEAD`).catch(() => undefined) : undefined
  branch = head === undefined ? undefined : parseHead(head)
  if (!repo) changes = undefined
}

// the effort each model last ran at, kept across sessions: { "Opus 5.5": "xhigh" }
async function rememberEffort($: EngineInterface, name: string, level: string) {
  const known = await $.store.get(EFFORT_KEY).catch(() => undefined)
  const all = known && typeof known === 'object' ? (known as Record<string, unknown>) : {}
  if (all[name] !== level) await $.store.set(EFFORT_KEY, { ...all, [name]: level }).catch(() => undefined)
}

// the one process: `git diff HEAD --shortstat` in the work tree
async function refreshChanges($: EngineInterface) {
  if (!repo) return
  try {
    const r = await $.process.run(['git', '--no-optional-locks', '-C', repo.dir, 'diff', 'HEAD', '--shortstat'], { timeoutMs: 10_000 })
    changes = parseShortstat(r.exitCode === 0 ? r.stdout : '')
  } catch {
    changes = undefined
  }
}

type Cfg = {
  policy: Policy
  band: 'action' | 'always' | 'off'
  place: 'hint' | 'status'
  wantToast: boolean
  showIdle: boolean
  countChanges: boolean
}

let cfg: Cfg = {
  policy: { warnMs: 60_000, compactAtTokens: 100_000 },
  band: 'action',
  place: 'hint',
  wantToast: true,
  showIdle: true,
  countChanges: true,
}

function line(now: number): { top: Group[]; bottom: Group[]; text: string } {
  const { top, bottom } = lineSegments({
    model: model || '?',
    effort,
    context,
    branch,
    changes: cfg.countChanges ? changes : undefined,
    durationMs: startedAt === undefined ? undefined : now - startedAt,
    limits: rateLimits,
    now,
    cache: cacheText(cacheView(cfg.policy, now, cfg.showIdle)),
    cacheColor: COLOR[current(cfg.policy, now).advice.kind] ?? 'gray',
  })
  return { top, bottom, text: bottom.length === 0 ? plain(top) : `${plain(top)} │ ${plain(bottom)}` }
}

// what the band and the pane draw, as one key: a change redraws them
function drawKey(now: number): string {
  if (cfg.band === 'off' && !isPaneOpen) return ''
  if (cfg.band === 'action' && !isPaneOpen) return actionLine(cfg.policy, now)?.text ?? ''
  const { advice, left, idleAt } = current(cfg.policy, now)
  return `${advice.kind}|${advice.text}|${left > 0 ? fmtClock(left) : ''}|${cfg.showIdle && idleAt ? idleClock(idleAt, now) : ''}`
}

// the line goes under the prompt as the PromptHint row (place "hint"), or as this plugin's $.ui.status entry
function redraw($: EngineInterface, now = Date.now()) {
  const { text } = line(now)
  const key = drawKey(now)
  const isLineNew = text !== lastLine
  if (isLineNew) {
    lastLine = text
    if (cfg.place === 'status') $.ui.status(text)
  }
  if (key !== lastKey || (isLineNew && cfg.place === 'hint')) {
    lastKey = key
    $.ui.invalidate('ui.render')
  }
}

function toastNearExpiry($: EngineInterface, now: number) {
  const { last, left } = current(cfg.policy, now)
  if (!cfg.wantToast || !last || left <= 0 || promptTokens(last) < TOAST_MIN_TOKENS) return
  if (toastedFor !== last.startedAt) {
    toastedFor = last.startedAt
    toastLevel = Infinity
  }
  // the first toast comes at warnSeconds, then 10, 3, 2 and 1 seconds; a late tick skips to the newest one
  const secs = Math.ceil(left / 1000)
  const mark = nextToastMark(secs, cfg.policy.warnMs / 1000, toastLevel)
  if (mark === undefined) return
  toastLevel = mark
  const tail = secs <= (COUNTDOWN_MARKS[0] ?? 10) ? 'send a message now' : `send a message to keep ${fmtTokens(promptTokens(last))} tokens warm`
  $.ui.toast(`cache expires in ${secs >= 60 ? fmtClock(left) : `${secs}s`}: ${tail}`)
}

async function tick($: EngineInterface) {
  const now = Date.now()
  if (!isBusy && (isSlowDue || isGitDue || now - lastSlow >= SLOW_MS)) {
    isBusy = true
    try {
      const isGit = isGitDue
      isSlowDue = false
      isGitDue = false
      lastSlow = now
      await refreshSlow($)
      if (isGit && cfg.countChanges) await refreshChanges($)
    } finally {
      isBusy = false
    }
  }
  redraw($)
  toastNearExpiry($, Date.now())
}

function resetCache() {
  samples = []
  lastKey = ''
  toastedFor = 0
  compacted = undefined
  observed = undefined
}

export const register: Register = (on, options) => {
  cfg = {
    policy: {
      warnMs: positive(options.warnSeconds, 60) * 1000,
      compactAtTokens: positive(options.compactAtTokens, 100_000),
    },
    band: options.band === 'always' || options.band === 'off' ? options.band : 'action',
    place: options.place === 'status' ? 'status' : 'hint',
    wantToast: options.toast !== false,
    showIdle: options.idleCompact !== false,
    countChanges: options.gitChanges !== false,
  }
  const { policy, band, wantToast, showIdle } = cfg

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    resetCache()
    lastLine = ''
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
      disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
      disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
      disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
      disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
    }
    pinned = options.ttl === '5m' || options.ttl === '1h'
    const settings = await readSettings($)
    setting = settings.promptCacheTtl
    const global = await readGlobalConfig($)
    idle = idlePolicy({
      minTokensVar: await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS').catch(none),
      disableAuto: await $.env.get('DISABLE_AUTO_COMPACT').catch(none),
      disableAll: await $.env.get('DISABLE_COMPACT').catch(none),
      setting: settings.idleCompaction,
      autoCompact: settings.autoCompactEnabled ?? global.autoCompact,
      flag: global.flag,
    })
    const usage = await $.session.usage().catch(none)
    startedAt = usage?.startedAt
    context = usage?.context ?? { window: 0 }
    rateLimits = usage?.rateLimits ?? []
    account = accountOf(rateLimits)
    const choice = decideTtl(options.ttl, env, setting, account)
    baseTtl = choice.ttl
    ttl = baseTtl
    envSource = choice.source
    ttlSource = envSource

    await $.command
      .register({
        name: COMMAND,
        description: 'Prompt-cache usage per turn and the time left before it lapses (stop closes)',
        argumentHint: '[stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`session-line: /${COMMAND} not registered: ${err}`))
    $.ui.log(`session-line loaded: ${ttl} cache (${ttlSource}), /${COMMAND} opens the table`, { to: 'debug' })
    $.ui.log(`session-line: idle compaction ${idle.on ? 'on' : 'off'}, ${idle.why}`, { to: 'debug' })

    // a previous version, or place "status" before, may have left an entry
    if (cfg.place === 'hint') $.ui.status(undefined)
    isSlowDue = true
    isGitDue = true
    await tick($)
    stopTimer?.cancel()
    stopTimer = $.clock.every(1000, () => void tick($))
    return r
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process: its cache is a new one, its length counts from now
    if (e.reason === 'clear') {
      resetCache()
      ttl = baseTtl
      ttlSource = envSource
      startedAt = undefined
      context = { window: context.window }
      isSlowDue = true
      $.ui.invalidate('ui.render')
      return next(e)
    }
    stopTimer?.cancel()
    stopTimer = undefined
    return next(e)
  })

  // the status line's figures, pushed after each main-loop turn and as a window moves
  on('session.measure', async ($, e, next) => {
    context = e.context
    rateLimits = e.rateLimits
    redraw($)
    return next(e)
  })

  // a slash command (/model, /effort) or a `!` command may have changed what the line shows
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    isSlowDue = true
    if (e.text.trimStart().startsWith('!')) isGitDue = true
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      isSlowDue = true
      isGitDue = true
    }
    return r
  })

  // a compaction of the main conversation replaces what the cache held; "idle" is Claude Code compacting on its own (2.1.290+)
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // a precompute only prepares a summary; the conversation is unchanged until it is used
    const trigger = String(e.trigger)
    if (e.agentId || trigger === 'precompute' || 'skip' in r) return r
    compacted = { at: Date.now(), trigger, before: r.tokensBefore, after: r.tokensAfter }
    if (trigger === 'idle') {
      const sizes = r.tokensBefore && r.tokensAfter ? ` ${fmtTokens(r.tokensBefore)} → ${fmtTokens(r.tokensAfter)} tokens` : ''
      $.ui.log(`session-line: compacted while idle${sizes}, before the ${ttl} cache lapsed`)
      if (showIdle && wantToast) $.ui.toast(`compacted while idle${sizes}: your next message starts from the summary`)
    }
    lastKey = ''
    redraw($)
    return r
  })

  // each main-loop request: its effort, and what the cache did with it
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    effort = e.effort === undefined ? 'default' : String(e.effort)
    isEffortSeen = true
    await rememberEffort($, prettyModel(e.model), effort)
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      samples.push({
        turnId: e.turnId,
        index: e.index,
        model: r.usage.model || e.model,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
        output: r.usage.output_tokens,
      })
      if (samples.length > KEEP) samples = samples.slice(-KEEP)
      if (!pinned) {
        // the account can change under a session: a subscription running out of plan usage moves to usage credits
        account = accountOf(rateLimits)
        const choice = decideTtl(options.ttl, env, setting, account)
        baseTtl = choice.ttl
        envSource = choice.source
        if (observed === undefined) {
          ttl = baseTtl
          ttlSource = envSource
        }
        const seen = observeTtl(samples[samples.length - 2], samples[samples.length - 1]!, observed)
        if (seen !== observed) {
          observed = seen
          ttl = seen ?? baseTtl
          ttlSource = `observed from request timing; ${envSource} said ${baseTtl}`
          $.ui.log(`session-line: cache lifetime is ${ttl} (${ttlSource})`, { to: 'debug' })
        }
      }
    }
    redraw($)
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'stop') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      isPaneOpen = false
      return { text: 'cache table closed' }
    }
    isPaneOpen = true
    await $.ui.open({ id: PANE, title: 'cache', focus: true })
    lastKey = ''
    $.ui.invalidate('ui.render')
    const { advice } = current(policy, Date.now())
    return { text: `${ttl} cache (${ttlSource}) · ${advice.text} · /${COMMAND} stop closes` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    isPaneOpen = false
    lastKey = ''
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== PANE) return next(e)
    if (e.element === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
    return next(e)
  })

  // the status line itself: two rows above the engine's hint line, each wrapping in a narrow terminal rather than cut off
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (cfg.place !== 'hint') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { top, bottom } = line(Date.now())
    const below = await next(e)
    const row = (groups: Group[], key: string) => (
      <Box key={key} flexDirection="row" flexWrap="wrap">
        {groups.map((g, n) => (
          <Box key={`${key}:${n}`} flexDirection="row">
            {g.map((s, i) => (
              <Text key={`${key}:${n}:${i}`} color={s.color} bold={s.bold}>
                {s.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {row(top, 'top')}
        {bottom.length > 0 ? row(bottom, 'bottom') : null}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (band === 'off' || e.props.hasSurvey || isPaneOpen) return next(e)
    const now = Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    if (band === 'action') {
      const act = actionLine(policy, now)
      if (!act) return next(e)
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Text bold color={act.color} wrap="truncate-end">
            {act.text}
          </Text>
          {below}
        </Box>
      )
    }

    const { last, advice, left, idleAt } = current(policy, now)
    if (!last && advice.kind !== 'off') return next(e)
    const color = COLOR[advice.kind]
    // The band is one instance: whatever the plugins beneath draw (another mod's band) stays, under this line.
    const below = await next(e)
    const stack = (own: ReturnType<typeof Text>) => (
      <Box flexDirection="column">
        {own}
        {below}
      </Box>
    )

    if (!last) return stack(<Text dimColor>{fit(`cache: ${advice.text}`, columns)}</Text>)

    const wide = columns >= 90
    return stack(
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={color}>{ICON[advice.kind]}</Text>
        <Text bold color="cyan">cache</Text>
        <Text bold>{`${Math.round(hitRatio(last) * 100)}%`}</Text>
        {wide ? (
          <>
            <Text color="green">{`read ${fmtTokens(last.read)}`}</Text>
            <Text color="yellow">{`wrote ${fmtTokens(last.write)}`}</Text>
            <Text color="cyan">{`new ${fmtTokens(last.fresh)}`}</Text>
          </>
        ) : (
          <Text dimColor>{`${fmtTokens(promptTokens(last))} tok`}</Text>
        )}
        {advice.kind !== 'uncached' && advice.kind !== 'off' && advice.kind !== 'cold' && (
          <Text bold color={left > 0 ? lifeColor(left, ttl, policy.warnMs) : 'red'}>{left > 0 ? `⏱ ${fmtClock(left)}` : '⏱ 0:00'}</Text>
        )}
        {showIdle && idleAt !== undefined && <Text bold color="magenta">{idleClock(idleAt, now)}</Text>}
        <Text dimColor wrap="truncate-end">{`${ttl} · ${showIdle && idleAt !== undefined ? (idleAt > now ? 'left idle, Claude Code compacts it before the cache lapses' : 'compacting while idle') : advice.text}`}</Text>
      </Box>,
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 1)
    // HTML collapses runs of spaces and trims a text's ends; a no-break space keeps them
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    const now = Date.now()
    const { last, advice, left, idleAt } = current(policy, now)
    const all = byTurn(samples)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off' && advice.kind !== 'cold'
    // the countdown goes green, then yellow, then red as the cache runs out
    const clockColor = counting ? lifeColor(left, ttl, policy.warnMs) : undefined
    const stateColor = advice.kind === 'expired' || advice.kind === 'miss' ? 'red' : (clockColor ?? COLOR[advice.kind])
    const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')
    // solid bars are filled Boxes, not block characters: no seams in HTML, and no glyph that reads as a status-line bar
    const solid = (key: string, parts: [number, string | undefined][]) => (
      <Box key={key} flexDirection="row" height={1} flexShrink={0}>
        {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
      </Box>
    )
    const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
      </Box>
    )

    const barW = Math.min(width, 40)
    const life = lifeRatio(left, ttl)
    const lifeFilled = Math.round(life * barW)
    const [sr, sw, sn] = last ? segments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
    const rows = all.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 16))
    // why the idle-compaction line says what it says
    const idleDetail = (at: number | undefined) => {
      if (!idle.on) return `${idle.why}`
      if (at !== undefined) return `if nobody types, Claude Code compacts at ${Math.round(idle.fraction * 100)}% of the 1h cache, ${idle.why}`
      if (ttl !== '1h') return `needs the 1h cache; this session's is ${ttl}`
      if (last && promptTokens(last) < idle.minTokens) return `waits for ${fmtTokens(idle.minTokens)} tokens; the prompt is ${fmtTokens(promptTokens(last))}`
      return `armed while the cache is warm, ${idle.why}`
    }

    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{sp('⚡ PROMPT CACHE')}</Text>
          <Text dimColor>{sp(`· ${ttl} lifetime (${ttlSource})`)}</Text>
        </Box>

        <Box key="clock" flexDirection="column" marginTop={1}>
          <Text bold color={clockColor}>{sp(counting ? `⏱ ${left > 0 ? fmtClock(left) : '0:00'}` : '⏱ --:--')}</Text>
          {counting ? (
            <Box flexDirection="row" columnGap={1}>
              {solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']])}
              <Text dimColor>{sp(`${Math.round(life * 100)}%`)}</Text>
            </Box>
          ) : null}
        </Box>

        <Box key="advice" marginTop={1} flexDirection="column">
          <Text bold color={stateColor}>{sp(`${ICON[advice.kind]} ${advice.text}`)}</Text>
          {last ? <Text dimColor>{sp(fit(`${last.model} · prompt ${fmtTokens(promptTokens(last))} tokens`, width))}</Text> : null}
        </Box>

        {showIdle ? (
          <Box key="idle" marginTop={1} flexDirection="column">
            <Text bold color={idleAt !== undefined ? 'magenta' : undefined} dimColor={idleAt === undefined}>
              {sp(idleAt !== undefined ? `${idleClock(idleAt, now)} idle compaction` : `⇣ idle compaction ${idle.on ? 'on' : 'off'}`)}
            </Text>
            <Text dimColor>{sp(fit(idleDetail(idleAt), width))}</Text>
          </Box>
        ) : null}

        {last ? (
          <Box key="stack" flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={1}>
              {solid('stack', [[sr, 'green'], [sw, 'yellow'], [sn, 'cyan']])}
              <Text bold color={hitColor(Math.round(hitRatio(last) * 100))}>{sp(`${Math.round(hitRatio(last) * 100)}% hit`)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{sp(`■ read ${fmtTokens(last.read)}`)}</Text>
              <Text color="yellow">{sp(`■ wrote ${fmtTokens(last.write)}`)}</Text>
              <Text color="cyan">{sp(`■ new ${fmtTokens(last.fresh)}`)}</Text>
            </Box>
          </Box>
        ) : null}

        <Box key="table" flexDirection="column" marginTop={1}>
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:turn', 4, 'turn', 'cyan', true)}
            {cell('h:steps', 5, 'steps', 'cyan', true)}
            {cell('h:read', 6, 'read', 'green', true)}
            {cell('h:wrote', 6, 'wrote', 'yellow', true)}
            {cell('h:new', 5, 'new', 'cyan', true)}
            {cell('h:hit', 4, 'hit', 'magenta', true)}
          </Box>
          {rows.length === 0 ? <Text dimColor>{sp('no requests yet')}</Text> : null}
          {rows.map((row, i) => {
            const n = all.length - rows.length + i + 1
            const pct = Math.round(rowRatio(row) * 100)
            return (
              <Box key={`t:${row.turnId}`} flexDirection="row" columnGap={1}>
                {cell(`c:turn:${row.turnId}`, 4, String(n))}
                {cell(`c:steps:${row.turnId}`, 5, String(row.steps))}
                {cell(`c:read:${row.turnId}`, 6, fmtTokens(row.read), 'green')}
                {cell(`c:wrote:${row.turnId}`, 6, fmtTokens(row.write), 'yellow')}
                {cell(`c:new:${row.turnId}`, 5, fmtTokens(row.fresh), 'cyan')}
                {cell(`c:hit:${row.turnId}`, 4, `${pct}%`, hitColor(pct), true)}
              </Box>
            )
          })}
        </Box>

        <Box key="foot" marginTop={1} flexDirection="column">
          <Button key="close" label="close" onPress={() => {}} />
          <Box key="legend" marginTop={1} flexDirection="column">
            <Text color="green">{sp('■ read: served by the cache')}</Text>
            <Text color="yellow">{sp('■ wrote: new cache entry')}</Text>
            <Text color="cyan">{sp('■ new: sent uncached')}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
