import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonosplice, standardFixture, writeConfig} from './harness.js'

const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

/**
 * S85: the machine-readable contract. Any accidental rename/addition here fails the test,
 * which is the point — CI consumers pipe this into jq.
 */
const SUBREPO_KEYS = [
  'ahead',
  'behind',
  'branch',
  'inSync',
  'name',
  'path',
  'pullInProgress',
  'remote',
  'seeded',
]

interface StatusJson {
  subrepos: Array<Record<string, unknown>>
}

/** Run `status` both ways and check the JSON contract on every call site (S85). */
async function status(dir: string): Promise<{human: string; json: StatusJson; core: Record<string, unknown>}> {
  const human = await runMonosplice(dir, ['status'])
  expect(human.exitCode, human.stderr).toBe(0)

  const json = await runMonosplice(dir, ['status', '--json'])
  expect(json.exitCode, json.stderr).toBe(0)
  const parsed = JSON.parse(json.stdout) as StatusJson
  expect(Array.isArray(parsed.subrepos)).toBe(true)
  const core = parsed.subrepos[0]!
  expect(Object.keys(core).sort()).toEqual(SUBREPO_KEYS)
  return {human: human.stdout, json: parsed, core}
}

async function seededWithExternal(opts: {configExtra?: string} = {}): Promise<{
  root: string
  mono: TestRepo
  pub: TestRepo
  ext: TestRepo
  pubDir: string
}> {
  const {root, mono, pubDir} = await standardFixture(opts)
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  const ext = await cloneRemote(root, pubDir, 'ext')
  return {root, mono, pub: new TestRepo(pubDir), ext, pubDir}
}

describe('S50 / S85: status across the lifecycle', () => {
  it('reports ahead/behind at every stage and keeps the JSON contract stable', async () => {
    const {mono, ext, pubDir} = await seededWithExternal()

    // 1. Fresh seed → in sync.
    let s = await status(mono.dir)
    expect(s.human).toMatch(/core: in sync/)
    expect(s.core).toMatchObject({
      name: 'core',
      path: 'core',
      remote: pubDir,
      branch: 'main',
      seeded: true,
      ahead: 0,
      behind: 0,
      inSync: true,
      pullInProgress: false,
    })

    // 2. Two local commits → 2 to push.
    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    await mono.commit('feat: two', {'core/two.txt': '2\n'})
    s = await status(mono.dir)
    expect(s.human).toMatch(/core: 2 to push/)
    expect(s.human).not.toMatch(/to pull/)
    expect(s.core).toMatchObject({ahead: 2, behind: 0, inSync: false})

    // 3. One external commit → also 1 to pull.
    await ext.commit('external: drive-by', {'ext.txt': 'x\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    s = await status(mono.dir)
    expect(s.human).toMatch(/core: 2 to push, 1 to pull/)
    expect(s.core).toMatchObject({ahead: 2, behind: 1, inSync: false})

    // 4. After sync → in sync again.
    const sync = await runMonosplice(mono.dir, ['sync'])
    expect(sync.exitCode, sync.stderr).toBe(0)
    s = await status(mono.dir)
    expect(s.human).toMatch(/core: in sync/)
    expect(s.core).toMatchObject({ahead: 0, behind: 0, inSync: true})

    // 5. Accuracy: a pure import is a tree no-op on export, so it is NOT "to push".
    await ext.git(['fetch', 'origin'])
    await ext.git(['reset', '--hard', 'origin/main'])
    await ext.commit('external: second', {'ext2.txt': 'y\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    s = await status(mono.dir)
    expect(s.human).toMatch(/core: 1 to pull/)
    expect(s.core).toMatchObject({ahead: 0, behind: 1})

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    s = await status(mono.dir)
    expect(s.core).toMatchObject({ahead: 0, behind: 0, inSync: true})
    expect(s.human).toMatch(/core: in sync/)

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
  })

  it('reports an unseeded subrepo without failing', async () => {
    const {mono, pubDir} = await standardFixture()
    const s = await status(mono.dir)
    expect(s.human).toMatch(/core: not published yet/)
    expect(s.human).toMatch(/monosplice push core --yes/)
    expect(s.core).toMatchObject({
      name: 'core',
      remote: pubDir,
      seeded: false,
      ahead: null,
      behind: null,
      inSync: false,
      pullInProgress: false,
    })
  })

  it('errors when the remote is unreachable', async () => {
    const {root, mono} = await seededWithExternal()
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(path.join(root, 'nope.git'))} }`])

    const res = await runMonosplice(mono.dir, ['status'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nope\.git/)
  })

  it('prints only JSON on stdout so it pipes into jq', async () => {
    const {mono} = await seededWithExternal()
    const res = await runMonosplice(mono.dir, ['status', '--json'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout.trim().startsWith('{')).toBe(true)
    expect(res.stdout.trim().endsWith('}')).toBe(true)
    expect(res.stdout).not.toMatch(/✓|in sync|to push/)
    expect(() => JSON.parse(res.stdout)).not.toThrow()
  })

  it('flags a mid-conflict pull prominently', async () => {
    const {mono, ext} = await seededWithExternal()
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)

    const s = await status(mono.dir)
    expect(s.human).toMatch(/pull/i)
    expect(s.human).toMatch(/--continue/)
    expect(s.core).toMatchObject({pullInProgress: true})
  })

  it('does not crash when a scan hook would reject the pending commits', async () => {
    const {mono} = await seededWithExternal({
      configExtra: `scan: (files) => {
        for (const [p, f] of files) {
          if (f.data.toString('utf8').includes('SECRET')) throw new Error('possible secret in ' + p)
        }
      }`,
    })
    await mono.commit('feat: oops', {'core/config.ts': 'export const token = "SECRET-abc"\n'})

    const human = await runMonosplice(mono.dir, ['status'])
    expect(human.exitCode, human.stderr).toBe(0)
    expect(human.stdout).toMatch(/1 to push/)
    expect(human.stdout).toContain('possible secret in config.ts')

    const json = await runMonosplice(mono.dir, ['status', '--json'])
    expect(json.exitCode, json.stderr).toBe(0)
    const parsed = JSON.parse(json.stdout) as StatusJson
    const core = parsed.subrepos[0]!
    expect(core.ahead).toBe(1)
    expect(String(core.hookError)).toContain('possible secret in config.ts')
    // hookError is the only optional key.
    expect(Object.keys(core).sort()).toEqual([...SUBREPO_KEYS, 'hookError'].sort())

    // and push really would fail, which is what the warning promised
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode).not.toBe(0)
  })

  it('accepts a subrepo name argument', async () => {
    const {mono} = await seededWithExternal()
    const res = await runMonosplice(mono.dir, ['status', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/core: in sync/)

    const unknown = await runMonosplice(mono.dir, ['status', 'nope'])
    expect(unknown.exitCode).not.toBe(0)
  })
})
