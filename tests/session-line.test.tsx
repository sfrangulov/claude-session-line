// The status line's text and the module end to end. Run with: claude plugin test <this mod's folder>
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  bar10,
  cacheText,
  composeLine,
  fmtDuration,
  fmtLeft,
  parseGitFile,
  parseHead,
  parseShortstat,
  pct1,
  prettyModel,
} from '../hooks/line.ts'

const MIN = 60_000
// how a tool reading the screen finds the bars: an optional label, the bar, the percent
const SCREEN_BAR = /(?:(\S+)\s+)?[▓░█▒▌▏]+\s+([\d.]+)%/g

describe('the pieces', () => {
  test('bars of ten cells and one decimal', () => {
    expect(bar10(21)).toBe('▓▓░░░░░░░░')
    expect(bar10(0)).toBe('░░░░░░░░░░')
    expect(bar10(140)).toBe('▓▓▓▓▓▓▓▓▓▓')
    expect(bar10(-3)).toBe('░░░░░░░░░░')
    expect(pct1(21)).toBe('21.0')
    expect(pct1(3.04)).toBe('3.0')
    expect(pct1(19.25)).toBe('19.3')
  })

  test('session length and time to a reset', () => {
    expect(fmtDuration(undefined)).toBe('0m')
    expect(fmtDuration(20_000)).toBe('<1m')
    expect(fmtDuration(42 * MIN)).toBe('42m')
    expect(fmtDuration(120 * MIN)).toBe('2hr')
    expect(fmtDuration(65 * MIN + 59_000)).toBe('1hr 5m')
    expect(fmtLeft((2 * 60 + 33) * MIN + 30_000, 0)).toBe('2h33m')
    expect(fmtLeft((5 * 1440 + 33) * MIN, 0)).toBe('5d33m')
    expect(fmtLeft(1440 * MIN, 0)).toBe('1d')
    expect(fmtLeft(0, 5 * MIN)).toBe('0m')
  })

  test('model names', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M context)')
    expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
    expect(prettyModel('')).toBe('?')
  })

  test('git: HEAD, a worktree .git file and --shortstat', () => {
    expect(parseHead('ref: refs/heads/feature/x\n')).toBe('feature/x')
    expect(parseHead('0123456789abcdef\n')).toBe('0123456')
    expect(parseHead('')).toBeUndefined()
    expect(parseGitFile('gitdir: /r/.git/worktrees/w\n', '/w')).toBe('/r/.git/worktrees/w')
    expect(parseGitFile('gitdir: ../r/.git/worktrees/w', '/w')).toBe('/w/../r/.git/worktrees/w')
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 3 deletions(-)\n')).toEqual({ ins: 12, del: 3 })
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ ins: 1, del: 0 })
    expect(parseShortstat(' 1 file changed, 2 deletions(-)\n')).toEqual({ ins: 0, del: 2 })
    expect(parseShortstat('')).toEqual({ ins: 0, del: 0 })
  })

  test('the cache segment', () => {
    const live = { state: 'live' as const, ratio: 0.92, leftMs: 41 * MIN - 5_000, warnMs: MIN, isMiss: false }
    expect(cacheText({ state: 'none' })).toBeUndefined()
    expect(cacheText({ state: 'off' })).toBe('cache off')
    expect(cacheText({ state: 'uncached' })).toBe('cache none')
    expect(cacheText({ state: 'compacted' })).toBe('cache compacted')
    expect(cacheText(live)).toBe('cache 92% · 41m')
    expect(cacheText({ ...live, leftMs: 45_000 })).toBe('cache 92% · 0:45')
    expect(cacheText({ ...live, leftMs: 0 })).toBe('cache 92% · expired')
    expect(cacheText({ ...live, isMiss: true })).toBe('cache 92% · 41m · miss')
    expect(cacheText({ ...live, idleInMs: 35 * MIN })).toBe('cache 92% · 41m · ⇣ 35m')
    expect(cacheText({ ...live, idleInMs: -1 })).toBe('cache 92% · 41m · ⇣ now')
  })
})

describe('the whole line', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const full = composeLine({
    model: 'Opus 5.5',
    effort: 'xhigh',
    context: { tokens: 42_000, window: 200_000, percent: 21 },
    branch: 'main',
    changes: { ins: 12, del: 3 },
    durationMs: 65 * MIN,
    limits: [
      { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(now + 153 * MIN).toISOString() },
      { kind: 'seven_day', percentUsed: 19, resetsAt: new Date(now + (5 * 1440 + 33) * MIN).toISOString() },
    ],
    now,
    cache: 'cache 92% · 41m',
  })

  test('as one line of text, the cache last', () => {
    expect(full).toBe(
      'Opus 5.5 · xhigh │ ▓▓░░░░░░░░ 21.0% │ ⎇ main (+12,-3) │ 1hr 5m │ 5h ░░░░░░░░░░ 3.0% (2h33m) │ wk ▓▓░░░░░░░░ 19.0% (5d33m) │ cache 92% · 41m',
    )
  })

  test('a screen reader of the bars finds the context first, then the 5h and wk windows', () => {
    const bars = [...full.matchAll(SCREEN_BAR)].map(m => [m[1], m[2]])
    expect(bars).toEqual([
      ['│', '21.0'],
      ['5h', '3.0'],
      ['wk', '19.0'],
    ])
  })

  test('outside a repo, before the first response, with no windows', () => {
    const bare = composeLine({ model: 'Opus 5.5', effort: 'default', context: { window: 200_000 }, limits: [], now, durationMs: 10_000 })
    expect(bare).toBe('Opus 5.5 · default │ ░░░░░░░░░░ 0.0% │ <1m')
  })

  test('a long branch is cut at 26, and a branch shows without changes when they are not counted', () => {
    const long = composeLine({ model: 'm', effort: 'e', context: { window: 1 }, branch: 'feature/a-very-long-branch-name', limits: [], now })
    expect(long).toContain('⎇ feature/a-very-long-branc… │')
    expect(long).not.toContain('(+')
  })
})

// The module end to end. Nothing sits beneath the plugin: each hook here stands for the engine.
type Calls = { status: (string | undefined)[]; runs: string[][]; toasts: string[] }

type Over = { rateLimits?: unknown[]; cache?: { read: number; write: number }; effortLevel?: string | null; store?: Record<string, unknown> }

function fakeEngine(on: On, calls: Calls, over: Over = {}) {
  const now = Date.now()
  const files: Record<string, string> = { '/repo/.git/HEAD': 'ref: refs/heads/main\n' }
  const rateLimits = over.rateLimits ?? [
    { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(now + 153 * MIN + 30_000).toISOString() },
    { kind: 'seven_day', percentUsed: 19, resetsAt: new Date(now + (5 * 1440 + 33) * MIN + 30_000).toISOString() },
  ]
  const cache = over.cache ?? { read: 80_000, write: 1_000 }
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async () => ({ sessionId: 's1' }) as never)
  on('session.usage', () => ({ value: { startedAt: now - 65 * MIN, context: { tokens: 42_000, window: 200_000, percent: 21 }, rateLimits } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  // a read of one key is the read of the whole object, projected
  on('settings.read', () => ({ value: over.effortLevel === null ? {} : { effortLevel: over.effortLevel ?? 'xhigh' } }) as never)
  const kept = over.store ?? {}
  on('store.get', ($, e) => ({ value: kept[e.key] }) as never)
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined } as never
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('env.get', () => ({ value: undefined }))
  on('fs.stat', ($, e) => {
    if (e.path === '/repo/.git') return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('process.run', ($, e) => {
    calls.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: ' 2 files changed, 12 insertions(+), 3 deletions(-)\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    calls.toasts.push(String((e as { text: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  // what the plugins beneath draw above the prompt (another mod's band)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 300, output_tokens: 50, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.write },
    } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
}

async function step($: Engine, over: { turnId?: string; index?: number; agentId?: string; effort?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...over } as never)
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true } as never)
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never
const band = ($: Engine) => $.ui.mount({ plugin: 'session-line', surface: 'terminal', component: 'AbovePrompt', props: BAND })
const newCalls = (): Calls => ({ status: [], runs: [], toasts: [] })
const STATUS = { options: { place: 'status' } }
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never
const hint = ($: Engine, columns: number) =>
  $.ui.mount({ plugin: 'session-line', surface: 'terminal', component: 'PromptHint', props: HINT, viewport: { columns, rows: 40 } } as never)

describe('the module', () => {
  test('the line at the start: model, effort, context, branch and changes, length, windows', STATUS, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    expect(calls.status.at(-1)).toBe(
      'Opus 5.5 · xhigh │ ▓▓░░░░░░░░ 21.0% │ ⎇ main (+12,-3) │ 1hr 5m │ 5h ░░░░░░░░░░ 3.0% (2h33m) │ wk ▓▓░░░░░░░░ 19.0% (5d33m)',
    )
    // one git, in the work tree found above the session's directory
    expect(calls.runs).toEqual([['git', '--no-optional-locks', '-C', '/repo', 'diff', 'HEAD', '--shortstat']])
  })

  test('a main-loop request adds the cache and its effort; a subagent request changes nothing', STATUS, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($, { agentId: 'a1', effort: 'low' })
    expect(calls.status.at(-1)).not.toContain('cache')
    expect(calls.status.at(-1)).toContain('· xhigh │')
    await step($, { effort: 'high' })
    // a subscription (the 5h and weekly windows) keeps the cache an hour
    expect(calls.status.at(-1)).toMatch(/^Opus 5\.5 · high │ .* │ cache 98% · 60m$/)
  })

  test('session.measure moves the context bar', STATUS, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await $.session.measure({ context: { tokens: 150_000, window: 200_000, percent: 75 }, rateLimits: [], changed: ['context', 'rateLimits'] } as never)
    expect(calls.status.at(-1)).toBe('Opus 5.5 · xhigh │ ▓▓▓▓▓▓▓▓░░ 75.0% │ ⎇ main (+12,-3) │ 1hr 5m')
  })

  test('gitChanges off runs no process and drops (+ins,-del), the branch stays', { options: { gitChanges: false, place: 'status' } }, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    expect(calls.runs).toEqual([])
    expect(calls.status.at(-1)).toContain('│ ⎇ main │ 1hr 5m')
  })

  test('the band stays empty while the cache needs nothing', async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($)
    const ui = await band($)
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['beneath'])
    await ui.unmount()
  })

  test('the band asks for a message once the cache is inside the warning', { options: { warnSeconds: 4000 } }, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^▲ cache lapses in \d+:\d\d:\d\d: send a message to keep 81\.3k tokens warm$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
    await ui.unmount()
  })

  test('band "always" draws the meter row, and no bar glyph', { options: { band: 'always' } }, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /read 80k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1h · warm/ })).toBeDefined()
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).not.toMatch(/[▓░█▒▌▏]/)
    await ui.unmount()
  })

  test('/cache opens the table: one row per turn, no bar glyphs', async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($)
    await step($, { turnId: 't2' })
    await $.command.run({ command: 'cache', args: '' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'session-line',
        surface,
        component: 'Pane',
        requestId: 'cache',
        props: { title: 'cache', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      } as never)
      expect(await ui.find({ type: 'Text', text: /PROMPT.CACHE/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /98%.hit/ })).toBeDefined()
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
      expect(texts).not.toMatch(/[▓░█▒▌▏]/)
      await ui.unmount()
    }
  })

  test('/clear starts the cache over', STATUS, async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    await step($)
    expect(calls.status.at(-1)).toContain('cache 98%')
    await $.session.end({ reason: 'clear' } as never)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
    expect(calls.status.at(-1)).not.toContain('cache')
  })

  test('place "hint" (the default) draws two rows above the hint line and pins no status entry', async ($, on) => {
    const calls = newCalls()
    fakeEngine(on, calls)
    await start($)
    expect(calls.status.filter(t => t !== undefined)).toEqual([])
    const ui = await hint($, 80)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.join('')).toBe(
      'Opus 5.5 · xhigh │ ▓▓░░░░░░░░ 21.0% │ ⎇ main (+12,-3) │ 1hr 5m5h ░░░░░░░░░░ 3.0% (2h33m) │ wk ▓▓░░░░░░░░ 19.0% (5d33m)beneath',
    )
    expect(texts.at(-1)).toBe('beneath')
    // the rows in order: the context bar first, the windows after it
    const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect([...rows.matchAll(SCREEN_BAR)].map(m => m[1])).toEqual(['│', '5h', 'wk'])
    await ui.unmount()
  })

  test('before the first request the effort this model ran at last time stands in', STATUS, async ($, on) => {
    const calls = newCalls()
    const kept: Record<string, unknown> = { effort: { 'Opus 5.5': 'high' } }
    fakeEngine(on, calls, { effortLevel: null, store: kept })
    await start($)
    expect(calls.status.at(-1)).toMatch(/^Opus 5\.5 · high │/)
    await step($, { effort: 'max' })
    expect(calls.status.at(-1)).toMatch(/^Opus 5\.5 · max │/)
    expect(kept.effort).toEqual({ 'Opus 5.5': 'max' })
  })
})
