/**
 * line.ts — the pure half of the status line: no `$`, no engine.
 *
 *   Opus 5.5 · xhigh │ ▓▓░░░░░░░░ 21.0% │ ⎇ main (+12,-3) │ 1hr 5m
 *   5h ▓░░░░░░░░░ 3.0% (2h33m) │ wk ▓▓░░░░░░░░ 19.0% (5d33m) │ cache 92% · 41m
 *
 * Tools that read these figures off the screen take the first ▓░ bar for the
 * context and the bars labelled `5h` and `wk` for the limits: keep the bars,
 * the labels and the order.
 */
import { fmtClock } from './cache.ts'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Context = { tokens?: number; window: number; percent?: number }

export type LineInput = {
  model: string
  effort: string
  context: Context
  /** undefined outside a git work tree */
  branch?: string
  /** undefined when not counted (outside a work tree, or gitChanges off) */
  changes?: { ins: number; del: number }
  durationMs?: number
  limits: readonly Limit[]
  /** ms since the epoch */
  now: number
  /** the cache segment, cacheText's; undefined leaves it out */
  cache?: string
}

const SEP = ' │ '

/** 10 cells of ▓ and ░, one per 10%. */
export function bar10(pct: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10)
  return '▓'.repeat(filled) + '░'.repeat(10 - filled)
}

/** One decimal, always: 21 → "21.0". */
export const pct1 = (pct: number) => (Math.round(pct * 10) / 10).toFixed(1)

/** The context fill to one decimal, from the token counts when the engine has them. */
export function contextPercent(c: Context): number {
  if (c.tokens !== undefined && c.window > 0) return (c.tokens / c.window) * 100
  return c.percent ?? 0
}

/** Session length: "<1m", "42m", "2hr", "1hr 5m". */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '0m'
  const tm = Math.floor(ms / 60_000)
  if (tm < 1) return '<1m'
  if (tm < 60) return `${tm}m`
  if (tm % 60 === 0) return `${tm / 60}hr`
  return `${Math.floor(tm / 60)}hr ${tm % 60}m`
}

/** Time until a reset: "2h33m", "5d33m", "0m" once passed. */
export function fmtLeft(resetsAtMs: number, now: number): string {
  const tm = Math.max(0, Math.floor((resetsAtMs - now) / 60_000))
  const d = Math.floor(tm / 1440)
  const h = Math.floor((tm % 1440) / 60)
  const m = tm % 60
  const parts = [d > 0 ? `${d}d` : '', h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean)
  return parts.length === 0 ? '0m' : parts.join('')
}

const FAMILY = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i

/** "claude-opus-5-5[1m]" → "Opus 5.5 (1M context)"; a name already shown that way stays. */
export function prettyModel(model: string): string {
  const m = FAMILY.exec(model.trim())
  if (!m) return model.trim() || '?'
  const [, name = '', major = '', minor, wide] = m
  const family = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
  const version = minor === undefined ? major : `${major}.${minor}`
  return `${family} ${version}${wide ? ' (1M context)' : ''}`
}

/** The branch from a HEAD file: "ref: refs/heads/x" → "x", a detached sha → its first 7. */
export function parseHead(head: string): string | undefined {
  const line = (head.split('\n')[0] ?? '').trim()
  if (line.startsWith('ref: refs/heads/')) return line.slice('ref: refs/heads/'.length)
  if (line.startsWith('ref: ')) return line.slice(5)
  return line === '' ? undefined : line.slice(0, 7)
}

/** Where a worktree's `.git` file points: "gitdir: ../x/.git/worktrees/y", relative to `dir`. */
export function parseGitFile(text: string, dir: string): string | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return undefined
  const path = (m[1] ?? '').trim()
  return path.startsWith('/') ? path : `${dir}/${path}`
}

/** `git diff --shortstat` → insertions and deletions; empty output is (+0,-0). */
export function parseShortstat(out: string): { ins: number; del: number } {
  const ins = /(\d+) insertions?\(\+\)/.exec(out)
  const del = /(\d+) deletions?\(-\)/.exec(out)
  return { ins: ins ? Number(ins[1]) : 0, del: del ? Number(del[1]) : 0 }
}

export function fitBranch(branch: string): string {
  return branch.length > 26 ? `${branch.slice(0, 25)}…` : branch
}

/** One run of text and its colour (an Ink colour name). */
export type Seg = { text: string; color?: string; bold?: boolean }

const DIM = 'gray'

function limit(label: string, w: Limit | undefined, now: number): Seg[] {
  if (!w) return []
  const reset = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
  const segs: Seg[] = [
    { text: `${label} `, color: DIM },
    { text: `${bar10(w.percentUsed)} ${pct1(w.percentUsed)}%`, color: 'greenBright' },
  ]
  if (Number.isFinite(reset)) segs.push({ text: ' (', color: DIM }, { text: fmtLeft(reset, now), color: 'white' }, { text: ')', color: DIM })
  return segs
}

const sep = (): Seg => ({ text: SEP, color: DIM })

/** One figure and the separator after it: a row wraps between figures, never inside one. */
export type Group = Seg[]

const joinGroups = (groups: Seg[][]): Group[] => groups.map((g, n) => (n < groups.length - 1 ? [...g, sep()] : g))

/** The line in two rows of figures: `top` (model to session length) and `bottom` (the windows, then the cache). */
export function lineSegments(i: LineInput & { cacheColor?: string }): { top: Group[]; bottom: Group[] } {
  const ctx = contextPercent(i.context)
  const top: Seg[][] = [
    [
      { text: i.model, color: 'cyanBright', bold: true },
      { text: ' · ', color: DIM },
      { text: i.effort, color: DIM },
    ],
    [{ text: `${bar10(ctx)} ${pct1(ctx)}%`, color: 'blueBright' }],
  ]
  if (i.branch !== undefined) {
    const branch: Seg[] = [{ text: `⎇ ${fitBranch(i.branch)}`, color: 'magentaBright' }]
    if (i.changes) branch.push({ text: ` (+${i.changes.ins},-${i.changes.del})`, color: 'yellowBright' })
    top.push(branch)
  }
  top.push([{ text: fmtDuration(i.durationMs), color: 'white' }])
  const bottom = [
    limit('5h', i.limits.find(w => w.kind === 'five_hour'), i.now),
    limit('wk', i.limits.find(w => w.kind === 'seven_day'), i.now),
    i.cache === undefined ? [] : [{ text: i.cache, color: i.cacheColor }],
  ].filter(g => g.length > 0)
  return { top: joinGroups(top), bottom: joinGroups(bottom) }
}

export const plain = (groups: readonly Group[]) =>
  groups
    .flat()
    .map(s => s.text)
    .join('')

/** The two rows as one line of text, joined by the separator: what the status entry shows. */
export function composeLine(i: LineInput): string {
  const { top, bottom } = lineSegments(i)
  return bottom.length === 0 ? plain(top) : `${plain(top)}${SEP}${plain(bottom)}`
}

/** What the cache segment says, by the meter's state. */
export type CacheView =
  | { state: 'none' }
  | { state: 'off' }
  | { state: 'uncached' }
  | { state: 'compacted' }
  | { state: 'live'; ratio: number; leftMs: number; warnMs: number; isMiss: boolean; idleInMs?: number }

/**
 * "cache 92% · 41m", "cache 92% · 0:45" inside the warning, "cache 92% ·
 * expired", "· miss" after a request that should have read and wrote, and
 * "· ⇣ 35m" while Claude Code will compact the idle conversation by itself.
 * No request yet: nothing.
 */
export function cacheText(v: CacheView): string | undefined {
  switch (v.state) {
    case 'none':
      return undefined
    case 'off':
      return 'cache off'
    case 'uncached':
      return 'cache none'
    case 'compacted':
      return 'cache compacted'
    case 'live': {
      const left = v.leftMs <= 0 ? 'expired' : v.leftMs > v.warnMs ? `${Math.ceil(v.leftMs / 60_000)}m` : fmtClock(v.leftMs)
      const miss = v.isMiss ? ' · miss' : ''
      const idle =
        v.idleInMs === undefined ? '' : ` · ⇣ ${v.idleInMs > 0 ? `${Math.ceil(v.idleInMs / 60_000)}m` : 'now'}`
      return `cache ${Math.round(v.ratio * 100)}% · ${left}${miss}${idle}`
    }
  }
}
