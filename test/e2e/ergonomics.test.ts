import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  cloneRemote,
  makeBareRemote,
  makeRepo,
  multiFixture,
  runMonosplice,
  sandbox,
  standardFixture,
  writeConfig,
} from './harness.js'

const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

async function seededWithExternal(): Promise<{root: string; mono: TestRepo; pub: TestRepo; ext: TestRepo}> {
  const {root, mono, pubDir} = await standardFixture()
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {root, mono, pub: new TestRepo(pubDir), ext: await cloneRemote(root, pubDir, 'ext')}
}

/** A monorepo with a config whose `subrepos` array is empty — what `monosplice init` writes. */
async function emptyConfigRepo(): Promise<TestRepo> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  writeConfig(mono, [])
  await mono.commit('chore: initial monorepo', {'app/main.ts': 'export const app = true\n'})
  return mono
}

// ---------------------------------------------------------------------------------------
// S151: --import-history / --export-history
// ---------------------------------------------------------------------------------------

describe('S151: --import-history / --export-history', () => {
  it('is the only spelling — the old flags are unknown', async () => {
    const {mono, pubDir} = await standardFixture()

    for (const args of [
      ['push', 'core', '--yes', '--full-history'],
      ['attach', 'core', '--full-history'],
      ['attach', 'core', '--history'],
    ]) {
      const res = await runMonosplice(mono.dir, args)
      expect(res.exitCode, `${args.join(' ')} should have been rejected`).not.toBe(0)
      expect(`${res.stdout}\n${res.stderr}`.replace(/\s+/g, ' '), args.join(' ')).toMatch(/Nonexistent flag/i)
    }
    expect(pubDir).toBeTruthy()
  })

  it('push --export-history replays every monorepo commit on the first publish', async () => {
    const {mono, pubDir} = await standardFixture()
    const pub = new TestRepo(pubDir)
    await mono.commit('feat: one', {'core/one.txt': '1\n'})

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes', '--export-history'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await pub.subjects()).toEqual(['chore: initial monorepo', 'feat: one'])
  })

  it('attach --import-history replays every standalone-repo commit inwards', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const pubDir = await makeBareRemote(root, 'core-pub')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)} }`])
    await mono.commit('chore: initial monorepo', {'app/main.ts': 'export const app = true\n'})

    const up = await makeRepo(root, 'upstream')
    await up.commit('upstream: one', {'a.txt': 'a\n'}, EXT_AUTHOR)
    await up.commit('upstream: two', {'b.txt': 'b\n'}, EXT_AUTHOR)
    await up.git(['push', pubDir, 'main'])

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--import-history'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect((await mono.subjects()).slice(-2)).toEqual(['upstream: one', 'upstream: two'])
  })

  it('names the other flag in every help text that offers one', async () => {
    const {mono} = await standardFixture()

    const attach = await runMonosplice(mono.dir, ['attach', '--help'])
    expect(attach.exitCode).toBe(0)
    expect(attach.stdout).toMatch(/--import-history/)
    expect(attach.stdout).toMatch(/--export-history/)

    const push = await runMonosplice(mono.dir, ['push', '--help'])
    expect(push.exitCode).toBe(0)
    expect(push.stdout).toMatch(/--export-history/)
    // "not to be confused with" — the export flag points at the import one and back.
    expect(push.stdout).toMatch(/--import-history/)
    expect(push.stdout).not.toMatch(/--full-history/)
    expect(attach.stdout).not.toMatch(/--full-history/)
  })
})

// ---------------------------------------------------------------------------------------
// S152: empty config
// ---------------------------------------------------------------------------------------

describe('S152: a config with no subrepos', () => {
  const EXPECTED = 'no subrepos configured — run `monosplice attach <folder> <git-url>` to connect one'

  it('says so instead of printing nothing, and still exits 0', async () => {
    const mono = await emptyConfigRepo()

    for (const command of ['status', 'push', 'pull', 'sync']) {
      const res = await runMonosplice(mono.dir, [command])
      expect(res.exitCode, `${command}: ${res.stderr}`).toBe(0)
      expect(`${res.stdout}${res.stderr}`, command).toContain(EXPECTED)
    }
  })

  it('keeps `status --json` valid JSON and nothing else', async () => {
    const mono = await emptyConfigRepo()
    const res = await runMonosplice(mono.dir, ['status', '--json'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).not.toContain(EXPECTED)
    expect(JSON.parse(res.stdout)).toEqual({subrepos: []})
  })
})

// ---------------------------------------------------------------------------------------
// S153: status --check
// ---------------------------------------------------------------------------------------

describe('S153: status --check', () => {
  it('exits 0 in sync, 1 otherwise, with the human output unchanged', async () => {
    const {mono, ext} = await seededWithExternal()

    const clean = await runMonosplice(mono.dir, ['status'])
    const cleanCheck = await runMonosplice(mono.dir, ['status', '--check'])
    expect(cleanCheck.exitCode, cleanCheck.stderr).toBe(0)
    expect(cleanCheck.stdout).toBe(clean.stdout)

    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    const ahead = await runMonosplice(mono.dir, ['status'])
    const aheadCheck = await runMonosplice(mono.dir, ['status', '--check'])
    expect(aheadCheck.exitCode).toBe(1)
    expect(aheadCheck.stdout).toBe(ahead.stdout)

    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)
    expect((await runMonosplice(mono.dir, ['status', '--check'])).exitCode).toBe(0)

    await ext.git(['fetch', 'origin'])
    await ext.git(['reset', '--hard', 'origin/main'])
    await ext.commit('external: drive-by', {'x.txt': 'x\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    expect((await runMonosplice(mono.dir, ['status', '--check'])).exitCode).toBe(1)
  })

  it('fails on a subrepo that was never published', async () => {
    const {mono} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['status', '--check'])
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toMatch(/core: not published yet/)
  })

  it('combines with --json, keeping stdout pure JSON', async () => {
    const {mono} = await seededWithExternal()
    await mono.commit('feat: one', {'core/one.txt': '1\n'})

    const res = await runMonosplice(mono.dir, ['status', '--check', '--json'])
    expect(res.exitCode).toBe(1)
    expect(() => JSON.parse(res.stdout)).not.toThrow()
    expect(res.stdout.trim().startsWith('{')).toBe(true)
    expect(res.stdout.trim().endsWith('}')).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// S154: doctor --json
// ---------------------------------------------------------------------------------------

const DOCTOR_KEYS = ['monorepo', 'ok', 'problems', 'pullInProgress', 'subrepos']
const DOCTOR_SUBREPO_KEYS = [
  'ahead',
  'behind',
  'branch',
  'forkHead',
  'lastExportedMono',
  'lastExportedPub',
  'name',
  'notes',
  'path',
  'problems',
  'pubHead',
  'pushBranch',
  'reachable',
  'remote',
  'seeded',
  'upstream',
]

describe('S154: doctor --json', () => {
  it('emits one stable object on stdout and no human report', async () => {
    const {mono, pub} = await seededWithExternal()

    const res = await runMonosplice(mono.dir, ['doctor', '--json'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).not.toMatch(/✓|✗|to push:/)

    const parsed = JSON.parse(res.stdout) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(DOCTOR_KEYS)
    expect(parsed.ok).toBe(true)
    expect(parsed.problems).toBe(0)
    expect(parsed.pullInProgress).toBeNull()

    const rows = parsed.subrepos as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(DOCTOR_SUBREPO_KEYS)
    expect(rows[0]).toMatchObject({
      name: 'core',
      path: 'core',
      branch: 'main',
      upstream: null,
      reachable: true,
      seeded: true,
      pubHead: await pub.head(),
      forkHead: null,
      ahead: 0,
      behind: 0,
      problems: [],
    })
  })

  it('keeps the same shape and exit code when there are problems', async () => {
    const {mono} = await standardFixture()

    const res = await runMonosplice(mono.dir, ['doctor', '--json'])
    expect(res.exitCode).toBe(1)
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(DOCTOR_KEYS)
    expect(parsed.ok).toBe(false)
    expect(parsed.problems).toBe(1)

    const rows = parsed.subrepos as Array<Record<string, unknown>>
    expect(Object.keys(rows[0]!).sort()).toEqual(DOCTOR_SUBREPO_KEYS)
    expect(rows[0]).toMatchObject({seeded: false, ahead: null, behind: null})
    expect((rows[0]!.problems as string[]).join('\n')).toMatch(/not published yet/)
  })

  it('reports an unfinished pull as structured state', async () => {
    const {mono, ext} = await seededWithExternal()
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    expect((await runMonosplice(mono.dir, ['pull'])).exitCode).not.toBe(0)

    const res = await runMonosplice(mono.dir, ['doctor', '--json'])
    expect(res.exitCode).toBe(1)
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>
    expect(parsed.pullInProgress).toMatchObject({subrepo: 'core'})
    expect(String((parsed.pullInProgress as Record<string, unknown>).statePath)).toContain('pull-state.json')
  })
})

// ---------------------------------------------------------------------------------------
// S155: uniform multi-subrepo failure policy
// ---------------------------------------------------------------------------------------

describe('S155: pull and sync collect failures like push', () => {
  it('keeps pulling the other subrepos after one refuses', async () => {
    const {mono, libPubDir, root} = await multiFixture()
    expect((await runMonosplice(mono.dir, ['push', 'lib', '--yes'])).exitCode).toBe(0)

    const ext = await cloneRemote(root, libPubDir, 'lib-ext')
    await ext.commit('external: lib drive-by', {'drive.txt': 'd\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    // `core` is first in the config and is not published, so it fails before `lib` is reached.
    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
    expect(res.stdout).toMatch(/lib: imported 1 commit/)
    expect((await mono.subjects()).at(-1)).toBe('external: lib drive-by')
  })

  it('keeps syncing the other subrepos after one refuses', async () => {
    const {mono, libPubDir, root, libPub} = await multiFixture()
    expect((await runMonosplice(mono.dir, ['push', 'lib', '--yes'])).exitCode).toBe(0)

    const ext = await cloneRemote(root, libPubDir, 'lib-ext')
    await ext.commit('external: lib drive-by', {'drive.txt': 'd\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    await mono.commit('feat: lib work', {'packages/lib/new.txt': 'n\n'})

    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
    // Both sides moved, so the import lands on top of the local commit and both export (S43).
    expect(res.stdout).toMatch(/lib: imported 1, exported 2/)
    expect(await libPub.subjects()).toContain('feat: lib work')
  })

  it('stops the whole run on an import conflict, because only one sequencer can exist', async () => {
    const {root, mono, corePubDir, libPubDir, libPub} = await multiFixture()
    expect((await runMonosplice(mono.dir, ['push', '--yes'])).exitCode).toBe(0)

    const coreExt = await cloneRemote(root, corePubDir, 'core-ext')
    await coreExt.commit('external: core wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await coreExt.git(['push', 'origin', 'main'])
    const libExt = await cloneRemote(root, libPubDir, 'lib-ext')
    await libExt.commit('external: lib drive-by', {'drive.txt': 'd\n'}, EXT_AUTHOR)
    await libExt.git(['push', 'origin', 'main'])

    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice pull --continue/)
    expect(res.stderr).toMatch(/monosplice pull --abort/)
    // lib was never reached: its external commit is still waiting.
    expect(res.stdout).not.toMatch(/lib:/)
    expect(await mono.subjects()).not.toContain('external: lib drive-by')
    expect(await libPub.subjects()).toContain('external: lib drive-by')
  })
})

// ---------------------------------------------------------------------------------------
// S156: wording and streams
// ---------------------------------------------------------------------------------------

describe('S156: wording and stream consistency', () => {
  it('never calls the other repo "public" in a command description', async () => {
    const mono = await emptyConfigRepo()

    const root = await runMonosplice(mono.dir, ['--help'])
    expect(root.stdout).not.toMatch(/public/i)

    for (const command of ['attach', 'push', 'pull', 'sync', 'status', 'doctor', 'tag', 'init']) {
      const res = await runMonosplice(mono.dir, [command, '--help'])
      expect(res.exitCode, command).toBe(0)
      expect(res.stdout, command).not.toMatch(/public/i)
    }
  })

  it('sends status diagnostics to stderr so stdout stays pipeable', async () => {
    const {mono, ext} = await seededWithExternal()
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    expect((await runMonosplice(mono.dir, ['pull'])).exitCode).not.toBe(0)

    const res = await runMonosplice(mono.dir, ['status'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).not.toMatch(/!/)
    expect(res.stdout).not.toMatch(/--continue/)
    expect(res.stderr).toMatch(/--continue/)
    expect(res.stderr).toMatch(/monosplice pull --abort/)

    const json = await runMonosplice(mono.dir, ['status', '--json'])
    expect(json.stdout.trim().startsWith('{')).toBe(true)
    expect(() => JSON.parse(json.stdout)).not.toThrow()
  })
})
