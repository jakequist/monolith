import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonosplice, standardFixture} from './harness.js'

const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

/** Seed the fixture, then hand back mono, the bare pub remote and an external clone of it. */
async function seededWithExternal(opts: {configExtra?: string} = {}): Promise<{
  root: string
  mono: TestRepo
  pub: TestRepo
  ext: TestRepo
}> {
  const {root, mono, pubDir} = await standardFixture(opts)
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  const ext = await cloneRemote(root, pubDir, 'ext')
  return {root, mono, pub: new TestRepo(pubDir), ext}
}

/** Fast-forward the external clone to whatever monosplice just published. */
async function refresh(ext: TestRepo): Promise<void> {
  await ext.git(['fetch', 'origin'])
  await ext.git(['reset', '--hard', 'origin/main'])
}

function occurrences(list: string[], value: string): number {
  return list.filter((v) => v === value).length
}

describe('S40: sync = pull then push', () => {
  it('converges both sides in one command from non-conflicting divergence', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    await mono.commit('feat: A (mono side)', {'core/a.txt': 'A\n'})
    await ext.commit('external: B', {'b.txt': 'B\n'}, EXT_AUTHOR)
    const extSha = await ext.head()
    await ext.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1/)
    expect(res.stdout).toMatch(/exported \d/)

    // B landed in the monorepo, under core/, with its origin trailer.
    expect(mono.exists('core/b.txt')).toBe(true)
    expect(await mono.fileAt('HEAD', 'core/b.txt')).toBe('B')
    expect((await mono.messages()).join('\n')).toContain(`Monosplice-Origin: ${extSha}`)

    // A landed in pub.
    expect(await pub.subjects()).toContain('feat: A (mono side)')
    expect(await pub.fileAt('HEAD', 'a.txt')).toBe('A')

    // Converged.
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })

  it('tells the user to publish when the public branch does not exist', async () => {
    const {mono} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
  })

  it('refuses to start while a pull is mid-conflict', async () => {
    const {mono, ext} = await seededWithExternal()
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['sync'])
    expect(conflicted.exitCode).not.toBe(0)
    expect(conflicted.stderr).toContain('core/README.md')
    expect(conflicted.stderr).toMatch(/--continue/)

    const restart = await runMonosplice(mono.dir, ['sync'])
    expect(restart.exitCode).not.toBe(0)
    expect(restart.stderr).toMatch(/--continue/)
  })

  it('pushes nothing when the import conflicts', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    const pubHead = await pub.head()

    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode).not.toBe(0)
    expect(await pub.head()).toBe(pubHead)
  })

  it('reports "up to date" when neither side moved', async () => {
    const {mono} = await seededWithExternal()
    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/up to date/)
  })
})

describe('S41: round-trip fidelity with excludes', () => {
  it('leaves pub byte-identical to the non-excluded part of core/', async () => {
    const {mono, pub, ext} = await seededWithExternal({
      configExtra: `exclude: ['INTERNAL.md', 'docs/private/**']`,
    })

    await mono.commit('feat: mixed public and private', {
      'core/INTERNAL.md': 'never publish\n',
      'core/keep.txt': 'keep me\n',
      'core/docs/private/notes.md': 'private notes\n',
      'core/docs/public.md': '# public docs\n',
      'private/plan.md': 'monorepo only\n',
    })
    await ext.commit('external: add ext.txt', {'ext.txt': 'from outside\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)

    const isExcluded = (p: string) => p === 'INTERNAL.md' || p.startsWith('docs/private/')
    const monoPaths = (await mono.treeEntries('HEAD', 'core')).map((e) => e.split(' ')[2]!)
    const pubPaths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2]!)

    expect(monoPaths).toContain('INTERNAL.md')
    expect(monoPaths).toContain('docs/private/notes.md')
    expect([...pubPaths].sort()).toEqual(monoPaths.filter((p) => !isExcluded(p)).sort())

    for (const p of pubPaths) {
      expect(await pub.fileAt('HEAD', p), p).toBe(await mono.fileAt('HEAD', `core/${p}`))
    }
    expect(pubPaths).not.toContain('INTERNAL.md')
    expect(pubPaths.some((p) => p.startsWith('docs/private/'))).toBe(false)
    expect(pubPaths.some((p) => p.includes('plan.md'))).toBe(false)
  })
})

describe('S42: stability', () => {
  it('reaches a fixed point — push/pull/push/pull change nothing', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    await mono.commit('feat: A (mono side)', {'core/a.txt': 'A\n'})
    await ext.commit('external: B', {'b.txt': 'B\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const sync = await runMonosplice(mono.dir, ['sync'])
    expect(sync.exitCode, sync.stderr).toBe(0)

    const monoHead = await mono.head()
    const pubHead = await pub.head()

    for (const cmd of [['push'], ['pull'], ['push'], ['pull']]) {
      const res = await runMonosplice(mono.dir, cmd)
      expect(res.exitCode, `${cmd.join(' ')}: ${res.stderr}`).toBe(0)
      expect(res.stdout, cmd.join(' ')).toMatch(/up to date/)
    }

    expect(await mono.head()).toBe(monoHead)
    expect(await pub.head()).toBe(pubHead)

    const again = await runMonosplice(mono.dir, ['sync'])
    expect(again.exitCode, again.stderr).toBe(0)
    expect(again.stdout).toMatch(/up to date/)
    expect(await mono.head()).toBe(monoHead)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S43: interleaved history over several rounds', () => {
  it('converges with every commit present on both sides', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    // Round 1: monorepo only.
    await mono.commit('r1: mono only', {'core/m1.txt': '1\n'})
    let res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)

    // Round 2: public only.
    await refresh(ext)
    await ext.commit('r2: ext only', {'e2.txt': '2\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)

    // Round 3: both sides, non-conflicting.
    await mono.commit('r3: mono side', {'core/m3.txt': '3\n'})
    await refresh(ext)
    await ext.commit('r3: ext side', {'e3.txt': '3\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)

    const monoSubjects = await mono.subjects()
    const pubSubjects = await pub.subjects()

    for (const subject of ['r1: mono only', 'r2: ext only', 'r3: mono side', 'r3: ext side']) {
      expect(occurrences(monoSubjects, subject), `mono: ${subject}`).toBe(1)
      expect(pubSubjects, `pub: ${subject}`).toContain(subject)
    }
    for (const subject of ['r1: mono only', 'r2: ext only', 'r3: mono side']) {
      expect(occurrences(pubSubjects, subject), `pub: ${subject}`).toBe(1)
    }
    // Locked-in consequence of the two-histories model: in a round where BOTH sides moved,
    // the import commit sits on top of the local commit, so its tree differs from the pub
    // tip and it must be re-exported (same rule that preserves conflict resolutions).
    expect(occurrences(pubSubjects, 'r3: ext side')).toBe(2)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    for (const f of ['m1.txt', 'e2.txt', 'm3.txt', 'e3.txt']) {
      expect(mono.exists(`core/${f}`), f).toBe(true)
      expect(await pub.fileAt('HEAD', f), f).toBe(await mono.fileAt('HEAD', `core/${f}`))
    }

    const monoHead = await mono.head()
    const pubHead = await pub.head()
    const settle = await runMonosplice(mono.dir, ['sync'])
    expect(settle.exitCode, settle.stderr).toBe(0)
    expect(settle.stdout).toMatch(/up to date/)
    expect(await mono.head()).toBe(monoHead)
    expect(await pub.head()).toBe(pubHead)
  })
})
