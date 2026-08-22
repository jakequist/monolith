import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  makeBareRemote,
  makeRepo,
  multiFixture,
  runMonosplice,
  sandbox,
  standardFixture,
  writeConfig,
} from './harness.js'

/** A monorepo whose `core/` directory has no committed files and whose remote is empty. */
async function deadEndFixture(): Promise<{root: string; mono: TestRepo; pubDir: string}> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  const pubDir = await makeBareRemote(root, 'core-pub')
  writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)} }`])
  await mono.commit('chore: initial', {'private/secrets.md': 'internal only\n'})
  return {root, mono, pubDir}
}

describe('S02: first `push --yes` (baseline)', () => {
  it('creates exactly one baseline commit whose tree equals the core subtree', async () => {
    const {mono, pubDir} = await standardFixture()
    await mono.commit('feat: more core', {'core/src/util.ts': 'export const n = 1\n'})
    await mono.commit('chore: private churn', {'private/notes.md': 'nope\n'})
    const monoHead = await mono.head()

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/published/i)

    const pub = new TestRepo(pubDir)
    const subjects = await pub.subjects()
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toContain('Initial import')

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha(monoHead, 'core'))

    const messages = await pub.messages()
    expect(messages[0]).toContain(`Monosplice-Source: ${monoHead}`)

    // the private tree never crosses the boundary
    const entries = await pub.treeEntries('HEAD')
    expect(entries.some((e) => e.includes('private/'))).toBe(false)
  })

  it('also works without naming the subrepo', async () => {
    const {mono, pubDir} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['push', '--yes'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect((await new TestRepo(pubDir).subjects())).toHaveLength(1)
  })
})

describe('S03: first `push --yes --export-history`', () => {
  it('replays every commit touching core with messages, authors and trailers preserved', async () => {
    const {mono, pubDir} = await standardFixture()
    await mono.commit('feat: add util', {'core/src/util.ts': 'export const n = 1\n'}, {
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.test',
    })
    await mono.commit('chore: private only', {'private/notes.md': 'nope\n'})
    await mono.commit('fix: tweak readme', {'core/README.md': '# core\n\nmore\n'})

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes', '--export-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const monoCoreShas = (await mono.git(['rev-list', '--reverse', '--topo-order', 'HEAD', '--', 'core'])).split('\n')
    const monoSubjects = await Promise.all(monoCoreShas.map((s) => mono.git(['show', '-s', '--format=%s', s])))

    const pub = new TestRepo(pubDir)
    expect(await pub.subjects()).toEqual(monoSubjects)

    const pubMessages = await pub.messages()
    for (const [i, sha] of monoCoreShas.entries()) {
      expect(pubMessages[i]).toContain(`Monosplice-Source: ${sha}`)
    }

    const monoAuthors = await Promise.all(monoCoreShas.map((s) => mono.git(['show', '-s', '--format=%an <%ae>', s])))
    expect(await pub.authors()).toEqual(monoAuthors)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })

  it('refuses once the subrepo is already published', async () => {
    const {mono, pubDir} = await standardFixture()
    expect((await runMonosplice(mono.dir, ['push', 'core', '--yes'])).exitCode).toBe(0)
    const pub = new TestRepo(pubDir)
    const before = await pub.head()

    await mono.commit('feat: later', {'core/later.txt': 'l\n'})
    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes', '--export-history'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/--export-history/)
    expect(res.stderr).toMatch(/already/i)
    expect(await pub.head()).toBe(before)
  })
})

describe('S04: first push honors exclude patterns', () => {
  it('omits excluded files from the baseline tree', async () => {
    const {mono, pubDir} = await standardFixture({configExtra: `exclude: ['INTERNAL.md', 'src/**/*.secret.ts']`})
    await mono.commit('feat: internal notes', {
      'core/INTERNAL.md': 'do not publish\n',
      'core/src/keys.secret.ts': 'export const k = "x"\n',
      'core/src/public.ts': 'export const p = 1\n',
    })

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(res.exitCode, res.stderr).toBe(0)

    const pub = new TestRepo(pubDir)
    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).toContain('src/public.ts')
    expect(paths).not.toContain('INTERNAL.md')
    expect(paths).not.toContain('src/keys.secret.ts')
  })

  it('omits excluded files with --export-history too', async () => {
    const {mono, pubDir} = await standardFixture({configExtra: `exclude: ['INTERNAL.md']`})
    await mono.commit('feat: internal notes', {'core/INTERNAL.md': 'do not publish\n'})
    await mono.commit('feat: public thing', {'core/src/public.ts': 'export const p = 1\n'})

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes', '--export-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const pub = new TestRepo(pubDir)
    const allEntries = await pub.treeEntries('HEAD')
    expect(allEntries.some((e) => e.includes('INTERNAL.md'))).toBe(false)
    // the commit that only touched an excluded file produced no pub commit
    expect(await pub.subjects()).toEqual(['chore: initial monorepo', 'feat: public thing'])
  })
})

describe('S05: push against a pub with unrelated history', () => {
  it('refuses, points at `monosplice attach`, and leaves the remote untouched', async () => {
    const {root, mono, pubDir} = await standardFixture()

    const ext = await makeRepo(root, 'ext')
    await ext.commit('external: hello', {'HELLO.md': 'hi\n'})
    await ext.git(['remote', 'add', 'origin', pubDir])
    await ext.git(['push', 'origin', 'main'])

    const pub = new TestRepo(pubDir)
    const before = await pub.head()

    for (const args of [['push'], ['push', 'core', '--yes']]) {
      const res = await runMonosplice(mono.dir, args)
      expect(res.exitCode, `${args.join(' ')} should have failed`).not.toBe(0)
      expect(res.stderr).toMatch(/monosplice attach core/)
      expect(await pub.head()).toBe(before)
      expect(await pub.subjects()).toEqual(['external: hello'])
    }
  })
})

describe('S06: first push when the subrepo path has no committed files', () => {
  it('errors clearly and pushes nothing', async () => {
    const {mono, pubDir} = await deadEndFixture()

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/no committed files|nothing to publish|nothing exists yet/i)

    const pub = new TestRepo(pubDir)
    expect(await pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')
  })
})

describe('S90: non-interactive first push without --yes', () => {
  it('refuses with the exact command, keeps the remote empty, and still pushes the others', async () => {
    const {mono, corePubDir, corePub, libPub} = await multiFixture()

    // core is already published; lib is not.
    expect((await runMonosplice(mono.dir, ['push', 'core', '--yes'])).exitCode).toBe(0)
    await mono.commit('feat: both', {
      'core/new.txt': 'c\n',
      'packages/lib/new.txt': 'l\n',
    })

    const res = await runMonosplice(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push lib --yes/)
    expect(res.stderr).toMatch(/first/i)

    // the refusal did not abort the run: core still exported
    expect(res.stdout).toMatch(/core: exported 1 commit/)
    expect(await corePub.subjects()).toEqual(['Initial import of core', 'feat: both'])
    expect(corePubDir).toBeTruthy()

    // lib's remote is still empty
    expect(await libPub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')
  })

  it('refuses a single unpublished subrepo too', async () => {
    const {mono, pubDir} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
    const pub = new TestRepo(pubDir)
    expect(await pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')
  })
})

describe('S91: `push --yes` baseline then normal exports', () => {
  it('reports the baseline distinctly, is idempotent, and exports later commits per-commit', async () => {
    const {mono, pubDir} = await standardFixture()
    const pub = new TestRepo(pubDir)

    const first = await runMonosplice(mono.dir, ['push', '--yes'])
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/published/i)
    expect(first.stdout).not.toMatch(/exported/i)
    expect(await pub.subjects()).toEqual(['Initial import of core'])

    const again = await runMonosplice(mono.dir, ['push'])
    expect(again.exitCode, again.stderr).toBe(0)
    expect(again.stdout).toMatch(/up to date/)
    expect(await pub.subjects()).toEqual(['Initial import of core'])

    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    await mono.commit('feat: two', {'core/two.txt': '2\n'})
    const later = await runMonosplice(mono.dir, ['push'])
    expect(later.exitCode, later.stderr).toBe(0)
    expect(later.stdout).toMatch(/exported 2 commit/)
    expect(await pub.subjects()).toEqual(['Initial import of core', 'feat: one', 'feat: two'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toMatch(/core: in sync/)
  })
})

describe('S92: `push --yes --export-history` runs scan hooks per replayed commit', () => {
  it('aborts with nothing pushed when a hook throws on a historical commit', async () => {
    const {mono, pubDir} = await standardFixture({
      configExtra: `scan: (files, ctx) => {
        for (const [p, f] of files) {
          if (f.data.toString('utf8').includes('SECRET')) {
            throw new Error('possible secret in ' + p)
          }
        }
      }`,
    })
    await mono.commit('feat: safe', {'core/safe.txt': 'fine\n'})
    // a secret that was committed and later removed: only --export-history sees it
    const leak = await mono.commit('feat: oops', {'core/config.ts': 'export const token = "SECRET-abc"\n'})
    await mono.commit('fix: remove the secret', {'core/config.ts': null})

    const res = await runMonosplice(mono.dir, ['push', 'core', '--yes', '--export-history'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('possible secret in config.ts')
    expect(res.stderr).toContain(leak)

    const pub = new TestRepo(pubDir)
    expect(await pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')

    // the baseline (current tree, secret already gone) still publishes fine
    const baseline = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(baseline.exitCode, baseline.stderr).toBe(0)
    expect(await pub.subjects()).toEqual(['Initial import of core'])
  })
})

describe('S99: empty subrepo dir and empty remote', () => {
  it('gives the same "nothing exists yet" error from every command', async () => {
    const {mono} = await deadEndFixture()

    for (const args of [['push', 'core', '--yes'], ['push'], ['pull'], ['sync'], ['attach', 'core']]) {
      const res = await runMonosplice(mono.dir, args)
      expect(res.exitCode, `${args.join(' ')} should have failed`).not.toBe(0)
      expect(res.stderr, args.join(' ')).toMatch(/nothing exists yet/i)
      expect(res.stderr, args.join(' ')).toMatch(/core/)
    }
  })
})
