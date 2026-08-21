import {describe, expect, it} from 'vitest'
import {TestRepo, makeBareRemote, makeRepo, runMonosplice, sandbox, writeConfig} from './harness.js'

const UP_AUTHOR = {authorName: 'Up Stream', authorEmail: 'up@example.test'}

interface Fixture {
  root: string
  mono: TestRepo
  pubDir: string
  pub: TestRepo
  up: TestRepo
  pubHead: string
  pubSubjects: string[]
}

/**
 * A monorepo that has never met an existing public repo: the remote already has its own
 * history and carries no monosplice trailers. `monoCore` seeds `core/` in the monorepo
 * (omit it for the "directory does not exist yet" half of the matrix).
 */
async function upstreamFixture(
  opts: {
    monoCore?: Record<string, string>
    upFiles?: Record<string, string>
    /** Final upstream commit, e.g. to delete the churn files and land on a chosen tree. */
    upTail?: Record<string, string | null>
    commits?: number
    configExtra?: string
  } = {},
): Promise<Fixture> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  const pubDir = await makeBareRemote(root, 'core-pub')
  const extra = opts.configExtra ? `, ${opts.configExtra}` : ''
  writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)}${extra} }`])
  await mono.commit('chore: initial monorepo', {
    'private/secrets.md': 'internal only\n',
    ...(opts.monoCore ?? {}),
  })

  const up = await makeRepo(root, 'upstream')
  await up.commit('upstream: initial', opts.upFiles ?? {'README.md': '# upstream core\n'}, UP_AUTHOR)
  for (let i = 1; i < (opts.commits ?? 1); i += 1) {
    await up.commit(`upstream: change ${i}`, {[`file-${i}.txt`]: `${i}\n`}, UP_AUTHOR)
  }
  if (opts.upTail) await up.commit('upstream: tidy up', opts.upTail, UP_AUTHOR)
  await up.git(['remote', 'add', 'origin', pubDir])
  await up.git(['push', 'origin', 'main'])

  const pub = new TestRepo(pubDir)
  return {root, mono, pubDir, pub, up, pubHead: await pub.head(), pubSubjects: await pub.subjects()}
}

describe('S93: adopt with pub history and no mono directory (shallow default)', () => {
  it('records ONE mono commit with an Origin trailer and lands in sync', async () => {
    const {mono, pub, pubDir, pubHead} = await upstreamFixture({commits: 20})
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/adopt/i)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Adopt core from ${pubDir} @ ${pubHead.slice(0, 10)}`)

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('core/README.md')).toBe('# upstream core\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    // the private side is untouched
    expect(mono.exists('private/secrets.md')).toBe(true)

    // The whole point of ancestry-based reflection: 20 pub commits, none "to pull".
    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toMatch(/core: in sync/)
    expect(status.stdout).not.toMatch(/to pull/)

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toMatch(/up to date/)

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S94: adopt --history', () => {
  it('replays every public commit with authors and messages preserved, then is in sync', async () => {
    const {mono, pub, pubHead, pubSubjects} = await upstreamFixture({commits: 5})
    const monoBefore = await mono.subjects()

    const res = await runMonosplice(mono.dir, ['adopt', 'core', '--history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toEqual([...monoBefore, ...pubSubjects])

    const authors = await mono.authors()
    expect(authors.slice(-5)).toEqual(Array.from({length: 5}, () => 'Up Stream <up@example.test>'))

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toMatch(/core: in sync/)
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S95: adopt when both sides have content and the trees match', () => {
  it('records an empty baseline commit and shares history going forward', async () => {
    const {mono, pub, pubHead} = await upstreamFixture({
      monoCore: {'core/README.md': '# same\n'},
      upFiles: {'README.md': '# same\n'},
      commits: 3,
      upTail: {'file-1.txt': null, 'file-2.txt': null},
    })
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toContain('Adopt core')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)
    // the adopt commit changed nothing in the monorepo
    expect(await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['pull'])).stdout).toMatch(/up to date/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)

    // A new mono commit exports parented on the EXISTING pub head.
    await mono.commit('feat: after adoption', {'core/new.txt': 'n\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/exported 1 commit/)
    expect(await pub.git(['rev-parse', 'HEAD~1'])).toBe(pubHead)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S96: adopt when both sides have content and the trees differ', () => {
  it('refuses listing the differing paths and writes nothing', async () => {
    const {mono, pub, pubHead} = await upstreamFixture({
      monoCore: {'core/README.md': '# mono side\n', 'core/only-mono.txt': 'm\n'},
      upFiles: {'README.md': '# pub side\n', 'only-pub.txt': 'p\n'},
    })
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('README.md')
    expect(res.stderr).toContain('only-mono.txt')
    expect(res.stderr).toContain('only-pub.txt')
    expect(res.stderr).toMatch(/--theirs/)

    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.read('core/README.md')).toBe('# mono side\n')
    expect(await pub.head()).toBe(pubHead)
  })

  it('--theirs replaces the mono directory in one commit and lands in sync', async () => {
    const {mono, pub, pubHead} = await upstreamFixture({
      monoCore: {'core/README.md': '# mono side\n', 'core/only-mono.txt': 'm\n'},
      upFiles: {'README.md': '# pub side\n', 'only-pub.txt': 'p\n'},
    })
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['adopt', 'core', '--theirs'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toContain('Adopt core')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('core/README.md')).toBe('# pub side\n')
    expect(mono.exists('core/only-mono.txt')).toBe(false)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    // the pre-adopt content is still in monorepo history
    expect(await mono.fileAt('HEAD~1', 'core/only-mono.txt')).toBe('m')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S97: pull against an unrelated pub', () => {
  it('refuses and points at adopt, importing nothing', async () => {
    const {mono, pubHead} = await upstreamFixture({monoCore: {'core/README.md': '# mono side\n'}})
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice adopt core/)
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.read('core/README.md')).toBe('# mono side\n')
    expect(pubHead).toBeTruthy()
  })

  it('refuses the same way when the subrepo directory does not exist yet', async () => {
    const {mono} = await upstreamFixture()
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice adopt core/)
    expect(await mono.head()).toBe(headBefore)
    expect(mono.exists('core')).toBe(false)
  })
})

describe('S98: push after adopt never re-exports pre-adoption mono history', () => {
  /**
   * Each shape leaves real pre-adoption commits *touching the subrepo path* behind, so a
   * push that anchored only on pub `Monosplice-Source` trailers would replay them onto the
   * adopted repo. Nothing but genuinely new work may appear in the pub log.
   */
  const shapes = [
    {
      name: 'shallow (S93)',
      args: ['adopt', 'core'],
      fixture: {commits: 4, monoCore: {'core/legacy.txt': 'gone later\n'}} as Parameters<typeof upstreamFixture>[0],
      // the directory existed once and was removed, so HEAD has no core/ tree at adopt time
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: extend legacy', {'core/legacy-2.txt': 'b\n'})
        await mono.commit('mono: drop the directory', {'core/legacy.txt': null, 'core/legacy-2.txt': null})
      },
    },
    {
      name: 'matching trees (S95)',
      args: ['adopt', 'core'],
      fixture: {
        commits: 4,
        monoCore: {'core/README.md': '# draft\n'},
        upFiles: {'README.md': '# same\n'},
        upTail: {'file-1.txt': null, 'file-2.txt': null, 'file-3.txt': null},
      } as Parameters<typeof upstreamFixture>[0],
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: rework the draft', {'core/README.md': '# same\n'})
      },
    },
    {
      name: '--theirs (S96)',
      args: ['adopt', 'core', '--theirs'],
      fixture: {
        commits: 4,
        monoCore: {'core/README.md': '# mono side\n'},
        upFiles: {'README.md': '# pub side\n'},
      } as Parameters<typeof upstreamFixture>[0],
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: private history one', {'core/legacy-a.txt': 'a\n'})
        await mono.commit('mono: private history two', {'core/legacy-b.txt': 'b\n'})
      },
    },
  ]

  for (const shape of shapes) {
    it(`keeps the pub log to its own commits plus genuinely new work — ${shape.name}`, async () => {
      const {mono, pub, pubSubjects, pubHead} = await upstreamFixture(shape.fixture)
      await shape.legacy(mono)

      const adopt = await runMonosplice(mono.dir, shape.args)
      expect(adopt.exitCode, adopt.stderr).toBe(0)

      const firstPush = await runMonosplice(mono.dir, ['push'])
      expect(firstPush.exitCode, firstPush.stderr).toBe(0)
      expect(firstPush.stdout).toMatch(/up to date/)
      expect(await pub.subjects()).toEqual(pubSubjects)
      expect(await pub.head()).toBe(pubHead)

      await mono.commit('feat: genuinely new', {'core/new.txt': 'n\n'})
      const second = await runMonosplice(mono.dir, ['push'])
      expect(second.exitCode, second.stderr).toBe(0)
      expect(second.stdout).toMatch(/exported 1 commit/)

      expect(await pub.subjects()).toEqual([...pubSubjects, 'feat: genuinely new'])
      expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    })
  }
})

describe('S99a: adopt preconditions', () => {
  it('refuses a dirty subrepo directory before fetching or writing', async () => {
    const {mono} = await upstreamFixture({monoCore: {'core/README.md': '# mono side\n'}})
    mono.write('core/README.md', '# work in progress\n')
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/uncommitted/i)
    expect(await mono.head()).toBe(headBefore)
    expect(mono.read('core/README.md')).toBe('# work in progress\n')
    // nothing was fetched either
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/core/remote']).catch(() => '')).toBe('')
  })

  it('refuses staged changes anywhere before fetching or writing', async () => {
    const {mono} = await upstreamFixture()
    mono.write('private/secrets.md', 'staged elsewhere\n')
    await mono.git(['add', 'private/secrets.md'])
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/staged/i)
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['diff', '--cached', '--name-only'])).toBe('private/secrets.md')
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/core/remote']).catch(() => '')).toBe('')
  })
})

describe('S99b: adopt an already-related subrepo', () => {
  it('refuses when the two repos are already connected by trailers', async () => {
    const {mono, pub} = await upstreamFixture()
    expect((await runMonosplice(mono.dir, ['adopt', 'core'])).exitCode).toBe(0)
    const headBefore = await mono.head()
    const pubHeadBefore = await pub.head()

    const again = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(again.exitCode).not.toBe(0)
    expect(again.stderr).toMatch(/already/i)
    expect(again.stderr).toMatch(/monosplice (pull|push|sync)/)
    expect(await mono.head()).toBe(headBefore)
    expect(await pub.head()).toBe(pubHeadBefore)
  })

  it('refuses on a subrepo published by `push --yes`', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const pubDir = await makeBareRemote(root, 'core-pub')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)} }`])
    await mono.commit('chore: initial', {'core/README.md': '# core\n'})
    expect((await runMonosplice(mono.dir, ['push', 'core', '--yes'])).exitCode).toBe(0)

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/already/i)
  })
})

describe('adopt against a remote that has nothing to adopt', () => {
  it('points at `push --yes` when the remote branch does not exist', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const pubDir = await makeBareRemote(root, 'core-pub')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)} }`])
    await mono.commit('chore: initial', {'core/README.md': '# core\n'})

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
  })

  it('reports an unreachable remote in the standard style', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const missing = `${root}/gone.git`
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(missing)} }`])
    await mono.commit('chore: initial', {'core/README.md': '# core\n'})

    const res = await runMonosplice(mono.dir, ['adopt', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('cannot reach remote')
    expect(res.stderr).toContain('gone.git')
  })
})
