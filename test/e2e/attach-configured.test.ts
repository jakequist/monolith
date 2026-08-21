import fs from 'node:fs'
import path from 'node:path'
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
 * A monorepo whose config ALREADY names the subrepo, facing a remote that has its own
 * history and no monosplice trailers. This is the half of `attach` that takes no URL:
 * the entry exists, so there is nothing to write and only first contact to make.
 * `monoCore` seeds the directory (omit it for the "directory does not exist yet" half).
 */
async function configuredFixture(
  opts: {
    monoCore?: Record<string, string>
    upFiles?: Record<string, string>
    /** Final upstream commit, e.g. to delete the churn files and land on a chosen tree. */
    upTail?: Record<string, string | null>
    commits?: number
    /** Leave the bare remote without any branch at all. */
    emptyRemote?: boolean
    name?: string
    subPath?: string
    configExtra?: string
  } = {},
): Promise<Fixture> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  const pubDir = await makeBareRemote(root, 'core-pub')
  const name = opts.name ?? 'core'
  const subPath = opts.subPath ?? 'core'
  const extra = opts.configExtra ? `, ${opts.configExtra}` : ''
  writeConfig(mono, [
    `    { name: '${name}', path: '${subPath}', remote: ${JSON.stringify(pubDir)}${extra} }`,
  ])
  await mono.commit('chore: initial monorepo', {
    'private/secrets.md': 'internal only\n',
    ...(opts.monoCore ?? {}),
  })

  const up = await makeRepo(root, 'upstream')
  if (!opts.emptyRemote) {
    await up.commit('upstream: initial', opts.upFiles ?? {'README.md': '# upstream core\n'}, UP_AUTHOR)
    for (let i = 1; i < (opts.commits ?? 1); i += 1) {
      await up.commit(`upstream: change ${i}`, {[`file-${i}.txt`]: `${i}\n`}, UP_AUTHOR)
    }
    if (opts.upTail) await up.commit('upstream: tidy up', opts.upTail, UP_AUTHOR)
    await up.git(['remote', 'add', 'origin', pubDir])
    await up.git(['push', 'origin', 'main'])
  }

  const pub = new TestRepo(pubDir)
  return {
    root,
    mono,
    pubDir,
    pub,
    up,
    pubHead: opts.emptyRemote ? '' : await pub.head(),
    pubSubjects: opts.emptyRemote ? [] : await pub.subjects(),
  }
}

function configBytes(mono: TestRepo): Buffer {
  return fs.readFileSync(path.join(mono.dir, 'monosplice.config.ts'))
}

describe('S130: attach a configured subrepo with no url (pub history, no mono directory)', () => {
  it('records ONE mono commit with an Origin trailer, touches no config, and lands in sync', async () => {
    const {mono, pub, pubDir, pubHead} = await configuredFixture({commits: 20})
    const monoBefore = (await mono.subjects()).length
    const before = configBytes(mono)

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/attached/i)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Adopt core from ${pubDir} @ ${pubHead.slice(0, 10)}`)

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    // The entry was already there: attach must not rewrite the config.
    expect(configBytes(mono).equals(before)).toBe(true)
    const changed = (await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).split('\n')
    expect(changed).toContain('core/README.md')
    expect(changed.every((p) => p.startsWith('core/'))).toBe(true)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('core/README.md')).toBe('# upstream core\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')
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

  it('resolves the entry by path or by name when they differ', async () => {
    for (const handle of ['vendor/lodash', 'lodash']) {
      const {mono, pub} = await configuredFixture({name: 'lodash', subPath: 'vendor/lodash'})

      const res = await runMonosplice(mono.dir, ['attach', handle])
      expect(res.exitCode, `${handle}: ${res.stderr}`).toBe(0)
      expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await pub.treeSha('HEAD'))
      expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/lodash: in sync/)
    }
  })
})

describe('S131: attach --history', () => {
  it('replays every public commit with authors and messages preserved, then is in sync', async () => {
    const {mono, pub, pubHead, pubSubjects} = await configuredFixture({commits: 5})
    const monoBefore = await mono.subjects()
    const before = configBytes(mono)

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toEqual([...monoBefore, ...pubSubjects])

    const authors = await mono.authors()
    expect(authors.slice(-5)).toEqual(Array.from({length: 5}, () => 'Up Stream <up@example.test>'))

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toMatch(/core: in sync/)
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })

  it('refuses when the folder already has committed files, changing nothing', async () => {
    const {mono} = await configuredFixture({monoCore: {'core/README.md': '# mono side\n'}})
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--history'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/--history/)
    expect(res.stderr).toMatch(/already has committed files/)
    expect(res.stderr).toMatch(/monosplice attach core/)
    expect(await mono.head()).toBe(head)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
  })

  it('refuses when the remote has no branch to replay', async () => {
    const {mono} = await configuredFixture({emptyRemote: true, monoCore: {'core/README.md': '# core\n'}})
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--history'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/--history/)
    expect(await mono.head()).toBe(head)
  })
})

describe('S132: attach a configured subrepo whose folder has content', () => {
  it('records an empty baseline commit when the trees match and shares history afterwards', async () => {
    const {mono, pub, pubHead} = await configuredFixture({
      monoCore: {'core/README.md': '# same\n'},
      upFiles: {'README.md': '# same\n'},
      commits: 3,
      upTail: {'file-1.txt': null, 'file-2.txt': null},
    })
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toContain('Adopt core')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)
    expect(await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['pull'])).stdout).toMatch(/up to date/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)

    // A new mono commit exports parented on the EXISTING pub head.
    await mono.commit('feat: after attaching', {'core/new.txt': 'n\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/exported 1 commit/)
    expect(await pub.git(['rev-parse', 'HEAD~1'])).toBe(pubHead)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })

  const differing = {
    monoCore: {'core/README.md': '# mono side\n', 'core/only-mono.txt': 'm\n'},
    upFiles: {'README.md': '# pub side\n', 'only-pub.txt': 'p\n'},
  }

  it('refuses listing the differing paths and writes nothing when the trees differ', async () => {
    const {mono, pub, pubHead} = await configuredFixture(differing)
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
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
    const {mono, pub, pubHead} = await configuredFixture(differing)
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--theirs'])
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
    // the pre-attach content is still in monorepo history
    expect(await mono.fileAt('HEAD~1', 'core/only-mono.txt')).toBe('m')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S133: attach a configured subrepo whose remote is empty', () => {
  const monoCore = {'core/README.md': '# core\n', 'core/src/index.ts': 'export const hello = 1\n'}

  it('refuses the first publish without --yes, naming the exact command, and publishes nothing', async () => {
    const {mono, pub} = await configuredFixture({emptyRemote: true, monoCore})
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
    expect(await mono.head()).toBe(head)
    expect(await pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')
  })

  it('--yes publishes the baseline, --full-history replays', async () => {
    const {mono, pub} = await configuredFixture({emptyRemote: true, monoCore})

    const res = await runMonosplice(mono.dir, ['attach', 'core', '--yes'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/published/i)
    expect(await pub.subjects()).toEqual(['Initial import of core'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)

    const other = await configuredFixture({emptyRemote: true, monoCore})
    await other.mono.commit('feat: more core', {'core/src/util.ts': 'export const n = 1\n'})
    const full = await runMonosplice(other.mono.dir, ['attach', 'core', '--yes', '--full-history'])
    expect(full.exitCode, full.stderr).toBe(0)
    expect(await other.pub.subjects()).toEqual(['chore: initial monorepo', 'feat: more core'])
  })

  it('gives the shared "nothing exists yet" error when both sides are empty', async () => {
    const {mono} = await configuredFixture({emptyRemote: true})
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nothing exists yet/i)
    expect(res.stderr).not.toMatch(/monosplice (adopt|vendor)/)
    expect(await mono.head()).toBe(head)
  })
})

describe('S134: attach an already-related subrepo', () => {
  it('refuses when the two repos are already connected by trailers', async () => {
    const {mono, pub} = await configuredFixture()
    expect((await runMonosplice(mono.dir, ['attach', 'core'])).exitCode).toBe(0)
    const headBefore = await mono.head()
    const pubHeadBefore = await pub.head()

    const again = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(again.exitCode).not.toBe(0)
    expect(again.stderr).toMatch(/already/i)
    expect(again.stderr).toMatch(/monosplice (pull|push|sync)/)
    expect(await mono.head()).toBe(headBefore)
    expect(await pub.head()).toBe(pubHeadBefore)
  })

  it('refuses on a subrepo published by `push --yes`', async () => {
    const {mono} = await configuredFixture({emptyRemote: true, monoCore: {'core/README.md': '# core\n'}})
    expect((await runMonosplice(mono.dir, ['push', 'core', '--yes'])).exitCode).toBe(0)

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/already/i)
  })
})

describe('S135: attach preconditions on a configured subrepo', () => {
  it('refuses a dirty subrepo directory before fetching or writing', async () => {
    const {mono} = await configuredFixture({monoCore: {'core/README.md': '# mono side\n'}})
    mono.write('core/README.md', '# work in progress\n')
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/uncommitted/i)
    expect(res.stderr).toMatch(/monosplice attach core/)
    expect(await mono.head()).toBe(headBefore)
    expect(mono.read('core/README.md')).toBe('# work in progress\n')
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/core/remote']).catch(() => '')).toBe('')
  })

  it('refuses staged changes anywhere before fetching or writing', async () => {
    const {mono} = await configuredFixture()
    mono.write('private/secrets.md', 'staged elsewhere\n')
    await mono.git(['add', 'private/secrets.md'])
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/staged/i)
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['diff', '--cached', '--name-only'])).toBe('private/secrets.md')
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/core/remote']).catch(() => '')).toBe('')
  })

  it('reports an unreachable remote in the standard style', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const missing = `${root}/gone.git`
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(missing)} }`])
    await mono.commit('chore: initial', {'core/README.md': '# core\n'})

    const res = await runMonosplice(mono.dir, ['attach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('cannot reach remote')
    expect(res.stderr).toContain('gone.git')
  })
})

describe('S136: attach a configured folder with the url spelled out', () => {
  it('proceeds when the url equals the configured remote', async () => {
    const {mono, pub, pubDir} = await configuredFixture()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
  })

  it('refuses a different url, naming the configured remote and the config file', async () => {
    const {mono, root, pubDir} = await configuredFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', `${root}/somewhere-else.git`])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain(pubDir)
    expect(res.stderr).toContain('somewhere-else.git')
    expect(res.stderr).toMatch(/monosplice\.config\.ts/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core')).toBe(false)
  })

  it('accepts the upstream url of a triangular entry and refuses the fork url', async () => {
    const {root, mono, pubDir, pub} = await configuredFixture()
    const forkDir = await makeBareRemote(root, 'core-fork')
    writeConfig(mono, [
      `    { name: 'core', path: 'core', remote: ${JSON.stringify(forkDir)}, upstream: ${JSON.stringify(pubDir)} }`,
    ])
    await mono.commit('chore: point core at a fork')

    const wrong = await runMonosplice(mono.dir, ['attach', 'core', forkDir])
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.stderr).toContain(pubDir)

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
  })
})

describe('S137: attach with no url and no matching entry', () => {
  it('explains that a url is needed to create the entry and changes nothing', async () => {
    const {mono} = await configuredFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'packages/lib'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('packages/lib')
    expect(res.stderr).toMatch(/monosplice attach packages\/lib <git-url>/)
    expect(res.stderr).toContain('core')

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('packages/lib')).toBe(false)
  })
})

describe('S97: pull against an unrelated pub', () => {
  it('refuses and points at attach, importing nothing', async () => {
    const {mono, pubHead} = await configuredFixture({monoCore: {'core/README.md': '# mono side\n'}})
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice attach core/)
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.read('core/README.md')).toBe('# mono side\n')
    expect(pubHead).toBeTruthy()
  })

  it('refuses the same way when the subrepo directory does not exist yet', async () => {
    const {mono} = await configuredFixture()
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice attach core/)
    expect(await mono.head()).toBe(headBefore)
    expect(mono.exists('core')).toBe(false)
  })
})

describe('S98: push after attach never re-exports pre-attach mono history', () => {
  /**
   * Each shape leaves real pre-attach commits *touching the subrepo path* behind, so a push
   * that anchored only on pub `Monosplice-Source` trailers would replay them onto the
   * attached repo. Nothing but genuinely new work may appear in the pub log.
   */
  const shapes = [
    {
      name: 'snapshot (S130)',
      args: ['attach', 'core'],
      fixture: {commits: 4, monoCore: {'core/legacy.txt': 'gone later\n'}} as Parameters<typeof configuredFixture>[0],
      // the directory existed once and was removed, so HEAD has no core/ tree at attach time
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: extend legacy', {'core/legacy-2.txt': 'b\n'})
        await mono.commit('mono: drop the directory', {'core/legacy.txt': null, 'core/legacy-2.txt': null})
      },
    },
    {
      name: 'matching trees (S132)',
      args: ['attach', 'core'],
      fixture: {
        commits: 4,
        monoCore: {'core/README.md': '# draft\n'},
        upFiles: {'README.md': '# same\n'},
        upTail: {'file-1.txt': null, 'file-2.txt': null, 'file-3.txt': null},
      } as Parameters<typeof configuredFixture>[0],
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: rework the draft', {'core/README.md': '# same\n'})
      },
    },
    {
      name: '--theirs (S132)',
      args: ['attach', 'core', '--theirs'],
      fixture: {
        commits: 4,
        monoCore: {'core/README.md': '# mono side\n'},
        upFiles: {'README.md': '# pub side\n'},
      } as Parameters<typeof configuredFixture>[0],
      legacy: async (mono: TestRepo): Promise<void> => {
        await mono.commit('mono: private history one', {'core/legacy-a.txt': 'a\n'})
        await mono.commit('mono: private history two', {'core/legacy-b.txt': 'b\n'})
      },
    },
  ]

  for (const shape of shapes) {
    it(`keeps the pub log to its own commits plus genuinely new work — ${shape.name}`, async () => {
      const {mono, pub, pubSubjects, pubHead} = await configuredFixture(shape.fixture)
      await shape.legacy(mono)

      const attach = await runMonosplice(mono.dir, shape.args)
      expect(attach.exitCode, attach.stderr).toBe(0)

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
