import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  cloneRemote,
  denyPushes,
  makeBareRemote,
  makeRepo,
  runMonosplice,
  sandbox,
  writeConfig,
} from './harness.js'

const UP_AUTHOR = {authorName: 'Up Stream', authorEmail: 'up@example.test'}

interface Fixture {
  root: string
  mono: TestRepo
  pubDir: string
  pub: TestRepo
  /** null when the fixture left the remote empty. */
  pubHead: string | null
  pubSubjects: string[]
}

/**
 * A monorepo with an EMPTY subrepos array — `attach` is the command that writes the entry —
 * plus a bare remote that either already has its own history or is still empty.
 */
async function attachFixture(
  opts: {
    /** Extra files committed into the monorepo's first commit (e.g. `core/README.md`). */
    monoFiles?: Record<string, string>
    upFiles?: Record<string, string>
    upTail?: Record<string, string | null>
    commits?: number
    /** Leave the bare remote without any branch at all. */
    emptyRemote?: boolean
    /** Config entries to start from (verbatim source lines). */
    subrepos?: string[]
  } = {},
): Promise<Fixture> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  writeConfig(mono, opts.subrepos ?? [])
  await mono.commit('chore: initial monorepo', {
    'app/main.ts': 'export const app = true\n',
    'private/secrets.md': 'internal only\n',
    ...(opts.monoFiles ?? {}),
  })

  const pubDir = await makeBareRemote(root, 'core-pub')
  if (!opts.emptyRemote) {
    const up = await makeRepo(root, 'upstream')
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
    pubHead: opts.emptyRemote ? null : await pub.head(),
    pubSubjects: opts.emptyRemote ? [] : await pub.subjects(),
  }
}

function configBytes(mono: TestRepo): Buffer {
  return fs.readFileSync(path.join(mono.dir, 'monosplice.config.ts'))
}

async function remoteBranch(pub: TestRepo): Promise<string> {
  return pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')
}

describe('S120: attach an empty folder to a remote that has history', () => {
  it('writes config and the remote tree in ONE commit and lands in sync', async () => {
    const {mono, pub, pubDir, pubHead} = await attachFixture({commits: 20})
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('core')
    expect(res.stdout).toContain(pubDir)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Adopt core from ${pubDir} @ ${pubHead!.slice(0, 10)}`)

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    // The config edit and the remote tree land in the SAME commit, and nothing else moves.
    const changed = (await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).split('\n').sort()
    expect(changed).toContain('monosplice.config.ts')
    expect(changed).toContain('core/README.md')
    expect(changed.every((p) => p === 'monosplice.config.ts' || p.startsWith('core/'))).toBe(true)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('core/README.md')).toBe('# upstream core\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    const config = mono.read('monosplice.config.ts')
    expect(config).toContain(`path: 'core'`)
    expect(config).toContain(`remote: '${pubDir}'`)

    // 20 pub commits, none "to pull": reflection is ancestry-based.
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

  it('works at a nested path, defaulting the name to the last segment', async () => {
    const {mono, pub, pubDir} = await attachFixture()

    const res = await runMonosplice(mono.dir, ['attach', 'packages/lib', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('packages/lib')

    expect(mono.read('packages/lib/README.md')).toBe('# upstream core\n')
    expect(await mono.treeSha('HEAD', 'packages/lib')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('monosplice.config.ts')).toContain(`path: 'packages/lib'`)
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/lib: in sync/)
  })

  it('honors --name and --branch', async () => {
    const {mono, pubDir, root} = await attachFixture()
    const up = await cloneRemote(root, pubDir, 'contributor')
    await up.git(['checkout', '-b', 'release'])
    await up.commit('upstream: release only', {'release.txt': 'r\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'release'])

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--name', 'kernel', '--branch', 'release'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('kernel')

    expect(mono.exists('core/release.txt')).toBe(true)
    const config = mono.read('monosplice.config.ts')
    expect(config).toContain(`name: 'kernel'`)
    expect(config).toContain(`branch: 'release'`)
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/kernel: in sync/)
  })
})

describe('S121: attach a folder with content to an EMPTY remote', () => {
  const monoFiles = {'core/README.md': '# core\n', 'core/src/index.ts': 'export const hello = 1\n'}

  it('commits the config entry alone, then refuses the first publish without --yes', async () => {
    const {mono, pub, pubDir} = await attachFixture({emptyRemote: true, monoFiles})
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)

    // The config commit still landed, on its own.
    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Attach core: track ${pubDir} (main)`)
    expect(await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('monosplice.config.ts')
    expect(mono.read('monosplice.config.ts')).toContain(`remote: '${pubDir}'`)
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    // Nothing was published.
    expect(await remoteBranch(pub)).toBe('')

    // The named command converges.
    const push = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(await pub.subjects()).toEqual(['Initial import of core'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
  })

  it('--yes publishes the baseline in the same run', async () => {
    const {mono, pub, pubDir} = await attachFixture({emptyRemote: true, monoFiles})
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--yes'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/published/i)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Attach core: track ${pubDir} (main)`)

    expect(await pub.subjects()).toEqual(['Initial import of core'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    const pubMessages = await pub.messages()
    expect(pubMessages[0]).toContain(`Monosplice-Source: ${await mono.head()}`)
    // the private tree never crosses the boundary
    expect((await pub.treeEntries('HEAD')).some((e) => e.includes('private/'))).toBe(false)

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)
  })

  it('--export-history replays every commit that touched the folder', async () => {
    const {mono, pub, pubDir} = await attachFixture({emptyRemote: true, monoFiles})
    await mono.commit('feat: more core', {'core/src/util.ts': 'export const n = 1\n'})
    await mono.commit('chore: private churn', {'private/notes.md': 'nope\n'})

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--yes', '--export-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    expect(await pub.subjects()).toEqual(['chore: initial monorepo', 'feat: more core'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
  })
})

describe('S122: attach a folder whose tree MATCHES the remote', () => {
  it('records config plus the adopt baseline in one commit and shares history afterwards', async () => {
    const {mono, pub, pubDir, pubHead} = await attachFixture({
      monoFiles: {'core/README.md': '# same\n'},
      upFiles: {'README.md': '# same\n'},
      commits: 3,
      upTail: {'file-1.txt': null, 'file-2.txt': null},
    })
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toContain('Adopt core')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    // Only the config moved: the tree already matched.
    expect(await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('monosplice.config.ts')
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['pull'])).stdout).toMatch(/up to date/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)

    // A later mono commit exports parented on the EXISTING pub head.
    await mono.commit('feat: after attaching', {'core/new.txt': 'n\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/exported 1 commit/)
    expect(await pub.git(['rev-parse', 'HEAD~1'])).toBe(pubHead)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S123: attach a folder whose tree DIFFERS from the remote', () => {
  const differing = {
    monoFiles: {'core/README.md': '# mono side\n', 'core/only-mono.txt': 'm\n'},
    upFiles: {'README.md': '# pub side\n', 'only-pub.txt': 'p\n'},
  }

  it('refuses listing the differing paths, leaving the config byte-identical', async () => {
    const {mono, pub, pubDir, pubHead} = await attachFixture(differing)
    const before = configBytes(mono)
    const headBefore = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('README.md')
    expect(res.stderr).toContain('only-mono.txt')
    expect(res.stderr).toContain('only-pub.txt')
    expect(res.stderr).toMatch(/--theirs/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.read('core/README.md')).toBe('# mono side\n')
    expect(await pub.head()).toBe(pubHead)
  })

  it('--theirs takes the remote tree in the same single commit', async () => {
    const {mono, pub, pubDir, pubHead} = await attachFixture(differing)
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--theirs'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toContain('Adopt core')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    const changed = (await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).split('\n').sort()
    expect(changed).toEqual(['core/README.md', 'core/only-mono.txt', 'core/only-pub.txt', 'monosplice.config.ts'])

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('core/README.md')).toBe('# pub side\n')
    expect(mono.exists('core/only-mono.txt')).toBe(false)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    // the pre-attach content is still in monorepo history
    expect(await mono.fileAt('HEAD~1', 'core/only-mono.txt')).toBe('m')

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })
})

describe('S124: attach refusals leave the config byte-identical and make no commit', () => {
  /** A monorepo with `core` already attached, plus a second unrelated remote to attach. */
  async function attachedFixture(): Promise<Fixture & {otherDir: string}> {
    const fx = await attachFixture()
    expect((await runMonosplice(fx.mono.dir, ['attach', 'core', fx.pubDir])).exitCode).toBe(0)
    const otherDir = await makeBareRemote(fx.root, 'other')
    const src = await makeRepo(fx.root, 'other-src')
    await src.commit('other: initial', {'a.txt': 'a\n'}, UP_AUTHOR)
    await src.git(['remote', 'add', 'origin', otherDir])
    await src.git(['push', 'origin', 'main'])
    return {...fx, otherDir}
  }

  it('refuses a name that is already configured', async () => {
    const {mono, otherDir} = await attachedFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'other', otherDir, '--name', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/already/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('other')).toBe(false)
  })

  it('refuses a path that is already configured', async () => {
    const {mono, otherDir} = await attachedFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', otherDir, '--name', 'other'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/already/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
  })

  it('refuses a path nesting inside a configured subrepo', async () => {
    const {mono, otherDir} = await attachedFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core/inner', otherDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nest/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
  })

  it('refuses a dirty working tree before fetching or writing anything', async () => {
    const {mono, pubDir} = await attachFixture()
    mono.write('app/main.ts', 'export const app = "wip"\n')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/uncommitted|staged/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core')).toBe(false)
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/core/remote']).catch(() => '')).toBe('')
  })

  it('refuses staged changes anywhere', async () => {
    const {mono, pubDir} = await attachFixture()
    mono.write('private/secrets.md', 'staged elsewhere\n')
    await mono.git(['add', 'private/secrets.md'])
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/staged|uncommitted/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(await mono.git(['diff', '--cached', '--name-only'])).toBe('private/secrets.md')
  })

  it('refuses while a pull sequencer is in progress', async () => {
    // A real conflicted pull, so the sequencer on disk is the one monosplice wrote.
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const corePub = await makeBareRemote(root, 'core-pub')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(corePub)} }`])
    await mono.commit('chore: initial', {'core/README.md': '# core\n', 'private/secrets.md': 'x\n'})
    expect((await runMonosplice(mono.dir, ['push', 'core', '--yes'])).exitCode).toBe(0)

    const contributor = await cloneRemote(root, corePub, 'contributor')
    await contributor.commit('pub: their edit', {'README.md': '# core\n\ntheirs\n'}, UP_AUTHOR)
    await contributor.git(['push', 'origin', 'main'])
    await mono.commit('mono: our edit', {'core/README.md': '# core\n\nours\n'})

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)

    const otherDir = await makeBareRemote(root, 'other')
    const src = await makeRepo(root, 'other-src')
    await src.commit('other: initial', {'a.txt': 'a\n'}, UP_AUTHOR)
    await src.git(['remote', 'add', 'origin', otherDir])
    await src.git(['push', 'origin', 'main'])
    const before = configBytes(mono)

    const res = await runMonosplice(mono.dir, ['attach', 'docs', otherDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/in progress/i)
    expect(res.stderr).toMatch(/monosplice pull --continue/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(mono.exists('docs')).toBe(false)
  })
})

describe('S125: nothing to attach to', () => {
  it('reports an unreachable URL cleanly and writes nothing', async () => {
    const {mono, root} = await attachFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', `${root}/gone.git`])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('cannot reach remote')
    expect(res.stderr).toContain('gone.git')

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core')).toBe(false)
  })

  it('gives the shared "nothing exists yet" error when both sides are empty', async () => {
    const {mono, pubDir} = await attachFixture({emptyRemote: true})
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nothing exists yet/i)
    expect(res.stderr).toMatch(/core/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
  })
})

describe('S126: a config shape the inserter cannot handle', () => {
  const spread =
    'const shared: Array<{path: string; remote: string}> = []\n\nexport default {\n  subrepos: [...shared],\n}\n'

  it('changes nothing, prints the snippet, and names the url-less attach when the remote has history', async () => {
    const {mono, pubDir} = await attachFixture()
    mono.write('monosplice.config.ts', spread)
    await mono.commit('chore: config built from a spread')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)

    expect(res.stdout).toContain(`path: 'core'`)
    expect(res.stdout).toContain(`remote: '${pubDir}'`)
    expect(res.stdout).toMatch(/monosplice\.config\.ts/)
    expect(res.stderr).toMatch(/monosplice attach core/)
    expect(res.stderr).not.toMatch(/monosplice (adopt|vendor)/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core')).toBe(false)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
  })

  it('names `push --yes` when the remote is empty', async () => {
    const {mono, pubDir} = await attachFixture({emptyRemote: true, monoFiles: {'core/README.md': '# core\n'}})
    mono.write('monosplice.config.ts', spread)
    await mono.commit('chore: config built from a spread')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode).not.toBe(0)

    expect(res.stdout).toContain(`path: 'core'`)
    expect(res.stderr).toMatch(/monosplice push core --yes/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
  })
})

describe('S131: attach --import-history on a new entry', () => {
  it('commits the config entry on its own, then replays every public commit', async () => {
    const {mono, pub, pubDir, pubHead, pubSubjects} = await attachFixture({commits: 5})
    const monoBefore = await mono.subjects()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--import-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await mono.subjects()
    expect(subjects).toEqual([...monoBefore, `Attach core: track ${pubDir} (main)`, ...pubSubjects])
    // the config commit stands alone
    expect(await mono.git(['diff', '--name-only', `HEAD~${pubSubjects.length + 1}`, `HEAD~${pubSubjects.length}`])).toBe(
      'monosplice.config.ts',
    )

    const authors = await mono.authors()
    expect(authors.slice(-5)).toEqual(Array.from({length: 5}, () => 'Up Stream <up@example.test>'))
    expect((await mono.messages()).at(-1)).toContain(`Monosplice-Origin: ${pubHead}`)

    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
    expect((await runMonosplice(mono.dir, ['push'])).stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })

  it('refuses when the folder already has committed files, leaving the config byte-identical', async () => {
    const {mono, pubDir} = await attachFixture({monoFiles: {'core/README.md': '# mono side\n'}})
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--import-history'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/--import-history/)
    expect(res.stderr).toMatch(/already has committed files/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
  })
})

describe('S138: attach --fork refusals', () => {
  it('refuses a fork url equal to the url being attached', async () => {
    const {mono, pubDir} = await attachFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--fork', pubDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/--fork/)
    expect(res.stderr).toContain(pubDir)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core')).toBe(false)
  })

  it('refuses --fork on a folder that is already configured, naming the config edit', async () => {
    const {mono, pubDir, root} = await attachFixture()
    expect((await runMonosplice(mono.dir, ['attach', 'core', pubDir])).exitCode).toBe(0)
    const forkDir = await makeBareRemote(root, 'core-fork')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--fork', forkDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/upstream/)
    expect(res.stderr).toMatch(/monosplice\.config\.ts/)
    expect(res.stderr).toContain(forkDir)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
  })
})

describe('S139: write-access probe', () => {
  it('says nothing when the remote accepts pushes', async () => {
    const {mono, pubDir} = await attachFixture()

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stderr).toBe('')
  })

  it('still attaches, but warns and names the --fork re-run when the remote refuses pushes', async () => {
    const {mono, pub, pubDir, pubHead} = await attachFixture()
    await denyPushes(pubDir)
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir])
    // Advisory only: the attach itself succeeded.
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stderr).toMatch(/warning/i)
    expect(res.stderr).toMatch(/monosplice attach core .*--fork/)
    expect(res.stderr).toMatch(/monosplice push core/)

    expect((await mono.subjects()).length).toBe(monoBefore + 1)
    expect(await mono.treeSha('HEAD', 'core')).toBe(await pub.treeSha('HEAD'))
    expect((await mono.messages()).at(-1)).toContain(`Monosplice-Origin: ${pubHead}`)
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/core: in sync/)
  })

  it('does not probe when the remote is empty — the first publish proves write access itself', async () => {
    const {mono, pubDir} = await attachFixture({emptyRemote: true, monoFiles: {'core/README.md': '# core\n'}})
    await denyPushes(pubDir)

    const res = await runMonosplice(mono.dir, ['attach', 'core', pubDir, '--yes'])
    // The real push fails, but it fails as a push error — never as the advisory.
    expect(res.stderr).not.toMatch(/warning/i)
  })
})

describe('S140: adopt and vendor are gone', () => {
  for (const gone of ['adopt', 'vendor']) {
    it(`\`monosplice ${gone}\` is an unknown command`, async () => {
      const {mono} = await attachFixture()
      const res = await runMonosplice(mono.dir, [gone])
      expect(res.exitCode).not.toBe(0)
      const out = `${res.stdout}\n${res.stderr}`.replace(/\s+/g, ' ')
      expect(out).toMatch(new RegExp(`command ${gone} not found`, 'i'))
    })
  }

  it('no user-facing string in the built CLI names either command', async () => {
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.name.endsWith('.js')) {
          const text = fs.readFileSync(abs, 'utf8')
          for (const line of text.split('\n')) {
            if (/monosplice (adopt|vendor)/.test(line)) offenders.push(`${abs}: ${line.trim()}`)
          }
        }
      }
    }
    walk(dist)
    expect(offenders).toEqual([])
  })
})

describe('attach --help', () => {
  it('documents the flags', async () => {
    const {mono} = await attachFixture()
    const res = await runMonosplice(mono.dir, ['attach', '--help'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/--name/)
    expect(res.stdout).toMatch(/--branch/)
    expect(res.stdout).toMatch(/--theirs/)
    expect(res.stdout).toMatch(/--export-history/)
    expect(res.stdout).toMatch(/--import-history/)
    expect(res.stdout).toMatch(/--fork/)
  })
})
