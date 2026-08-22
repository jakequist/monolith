import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonosplice, standardFixture} from './harness.js'

const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

async function seededWithExternal(opts: {configExtra?: string} = {}): Promise<{
  mono: TestRepo
  pub: TestRepo
  ext: TestRepo
}> {
  const {root, mono, pubDir} = await standardFixture(opts)
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {mono, pub: new TestRepo(pubDir), ext: await cloneRemote(root, pubDir, 'ext')}
}

const short = (sha: string): string => sha.slice(0, 10)

// ---------------------------------------------------------------------------------------
// S160: push --dry-run / pull --dry-run
// ---------------------------------------------------------------------------------------

describe('S160: push --dry-run', () => {
  it('lists every pending commit in export order and writes nothing', async () => {
    const {mono, pub} = await seededWithExternal()
    const one = await mono.commit('feat: one', {'core/one.txt': '1\n'})
    const two = await mono.commit('feat: two', {'core/two.txt': '2\n'})
    await mono.commit('chore: website only', {'website/index.html': '<p>hi</p>\n'})

    const monoHead = await mono.head()
    const pubHead = await pub.head()

    const res = await runMonosplice(mono.dir, ['push', '--dry-run'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('core: 2 to push (dry run — nothing written)')

    const lines = res.stdout.split('\n').map((l) => l.trim())
    const shown = lines.filter((l) => l.startsWith(short(one)) || l.startsWith(short(two)))
    expect(shown).toEqual([`${short(one)} feat: one`, `${short(two)} feat: two`])
    // The private-only commit is not exportable, so it must not be listed.
    expect(res.stdout).not.toContain('website only')

    // Nothing written: not on the remote, not in the monorepo, not in the work tree.
    expect(await pub.head()).toBe(pubHead)
    expect(await mono.head()).toBe(monoHead)
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    // And a real push still moves exactly those commits.
    const real = await runMonosplice(mono.dir, ['push'])
    expect(real.exitCode, real.stderr).toBe(0)
    expect(await pub.subjects()).toEqual([
      'Initial import of core',
      'feat: one',
      'feat: two',
    ])
  })

  it('prints the up-to-date line when nothing is pending', async () => {
    const {mono, pub} = await seededWithExternal()
    const pubHead = await pub.head()

    const res = await runMonosplice(mono.dir, ['push', '--dry-run'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('core: up to date (dry run — nothing written)')
    expect(await pub.head()).toBe(pubHead)
  })

  it('does not run scan hooks — it reports what would be attempted', async () => {
    const {mono, pub} = await seededWithExternal({
      configExtra: `scan(files) { if (files.has('boom.txt')) throw new Error('scan says no') }`,
    })
    await mono.commit('feat: boom', {'core/boom.txt': 'x\n'})
    const pubHead = await pub.head()

    const dry = await runMonosplice(mono.dir, ['push', '--dry-run'])
    expect(dry.exitCode, dry.stderr).toBe(0)
    expect(dry.stdout).toContain('core: 1 to push (dry run — nothing written)')
    expect(`${dry.stdout}${dry.stderr}`).not.toContain('scan says no')

    // The real push is still gated by the hook.
    const real = await runMonosplice(mono.dir, ['push'])
    expect(real.exitCode).not.toBe(0)
    expect(real.stderr).toContain('scan says no')
    expect(await pub.head()).toBe(pubHead)
  })

  it('says in --help that hooks still gate the real push', async () => {
    const {mono} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['push', '--help'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/--dry-run/)
    expect(res.stdout).toMatch(/hook/i)
  })

  it('reports an unpublished subrepo as the first publish it would make', async () => {
    const {mono, pubDir} = await standardFixture()
    const pub = new TestRepo(pubDir)

    const res = await runMonosplice(mono.dir, ['push', '--dry-run'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/dry run — nothing written/)
    expect(res.stdout).toMatch(/first/i)
    expect(await pub.git(['for-each-ref', 'refs/heads'])).toBe('')
  })
})

describe('S160: pull --dry-run', () => {
  it('lists every incoming commit in import order and writes nothing', async () => {
    const {mono, ext} = await seededWithExternal()
    const one = await ext.commit('external: one', {'e1.txt': '1\n'}, EXT_AUTHOR)
    const two = await ext.commit('external: two', {'e2.txt': '2\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const monoHead = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull', '--dry-run'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('core: 2 to pull (dry run — nothing written)')

    const lines = res.stdout.split('\n').map((l) => l.trim())
    expect(lines.filter((l) => l.startsWith(short(one)) || l.startsWith(short(two)))).toEqual([
      `${short(one)} external: one`,
      `${short(two)} external: two`,
    ])

    expect(await mono.head()).toBe(monoHead)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.exists('core/e1.txt')).toBe(false)

    const real = await runMonosplice(mono.dir, ['pull'])
    expect(real.exitCode, real.stderr).toBe(0)
    expect((await mono.subjects()).slice(-2)).toEqual(['external: one', 'external: two'])
  })

  it('prints the up-to-date line when nothing is incoming', async () => {
    const {mono} = await seededWithExternal()
    const res = await runMonosplice(mono.dir, ['pull', '--dry-run'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('core: up to date (dry run — nothing written)')
  })

  it('refuses to combine --dry-run with --continue or --abort', async () => {
    const {mono} = await seededWithExternal()
    for (const flag of ['--continue', '--abort']) {
      const res = await runMonosplice(mono.dir, ['pull', '--dry-run', flag])
      expect(res.exitCode, flag).not.toBe(0)
      expect(res.stderr, flag).toMatch(/--dry-run/)
    }
  })
})
