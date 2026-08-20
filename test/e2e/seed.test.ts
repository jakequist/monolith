import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  makeBareRemote,
  makeRepo,
  runMonolith,
  sandbox,
  standardFixture,
  writeConfig,
} from './harness.js'

describe('S02: seed (default squash)', () => {
  it('creates exactly one Initial import commit whose tree equals the core subtree', async () => {
    const {mono, pubDir} = await standardFixture()
    await mono.commit('feat: more core', {'core/src/util.ts': 'export const n = 1\n'})
    await mono.commit('chore: private churn', {'private/notes.md': 'nope\n'})
    const monoHead = await mono.head()

    const res = await runMonolith(mono.dir, ['seed', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    const pub = new TestRepo(pubDir)
    const subjects = await pub.subjects()
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toContain('Initial import')

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha(monoHead, 'core'))

    const messages = await pub.messages()
    expect(messages[0]).toContain(`Monolith-Source: ${monoHead}`)

    // the private tree never crosses the boundary
    const entries = await pub.treeEntries('HEAD')
    expect(entries.some((e) => e.includes('private/'))).toBe(false)
  })
})

describe('S03: seed --full-history', () => {
  it('replays every commit touching core with messages, authors and trailers preserved', async () => {
    const {mono, pubDir} = await standardFixture()
    await mono.commit('feat: add util', {'core/src/util.ts': 'export const n = 1\n'}, {
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.test',
    })
    await mono.commit('chore: private only', {'private/notes.md': 'nope\n'})
    await mono.commit('fix: tweak readme', {'core/README.md': '# core\n\nmore\n'})

    const res = await runMonolith(mono.dir, ['seed', 'core', '--full-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const monoCoreShas = (await mono.git(['rev-list', '--reverse', '--topo-order', 'HEAD', '--', 'core'])).split('\n')
    const monoSubjects = await Promise.all(monoCoreShas.map((s) => mono.git(['show', '-s', '--format=%s', s])))

    const pub = new TestRepo(pubDir)
    expect(await pub.subjects()).toEqual(monoSubjects)

    const pubMessages = await pub.messages()
    for (const [i, sha] of monoCoreShas.entries()) {
      expect(pubMessages[i]).toContain(`Monolith-Source: ${sha}`)
    }

    const monoAuthors = await Promise.all(monoCoreShas.map((s) => mono.git(['show', '-s', '--format=%an <%ae>', s])))
    expect(await pub.authors()).toEqual(monoAuthors)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S04: seed honors exclude patterns', () => {
  it('omits excluded files from the seeded tree', async () => {
    const {mono, pubDir} = await standardFixture({configExtra: `exclude: ['INTERNAL.md', 'src/**/*.secret.ts']`})
    await mono.commit('feat: internal notes', {
      'core/INTERNAL.md': 'do not publish\n',
      'core/src/keys.secret.ts': 'export const k = "x"\n',
      'core/src/public.ts': 'export const p = 1\n',
    })

    const res = await runMonolith(mono.dir, ['seed', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    const pub = new TestRepo(pubDir)
    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).toContain('src/public.ts')
    expect(paths).not.toContain('INTERNAL.md')
    expect(paths).not.toContain('src/keys.secret.ts')
  })

  it('omits excluded files with --full-history too', async () => {
    const {mono, pubDir} = await standardFixture({configExtra: `exclude: ['INTERNAL.md']`})
    await mono.commit('feat: internal notes', {'core/INTERNAL.md': 'do not publish\n'})
    await mono.commit('feat: public thing', {'core/src/public.ts': 'export const p = 1\n'})

    const res = await runMonolith(mono.dir, ['seed', 'core', '--full-history'])
    expect(res.exitCode, res.stderr).toBe(0)

    const pub = new TestRepo(pubDir)
    const allEntries = await pub.treeEntries('HEAD')
    expect(allEntries.some((e) => e.includes('INTERNAL.md'))).toBe(false)
    // the commit that only touched an excluded file produced no pub commit
    expect(await pub.subjects()).toEqual(['chore: initial monorepo', 'feat: public thing'])
  })
})

describe('S05: seed against a non-empty pub', () => {
  it('refuses with guidance and exits non-zero', async () => {
    const {root, mono, pubDir} = await standardFixture()

    const ext = await makeRepo(root, 'ext')
    await ext.commit('external: hello', {'HELLO.md': 'hi\n'})
    await ext.git(['remote', 'add', 'origin', pubDir])
    await ext.git(['push', 'origin', 'main'])

    const pub = new TestRepo(pubDir)
    const before = await pub.head()

    const res = await runMonolith(mono.dir, ['seed', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/already/i)
    expect(res.stderr).toMatch(/push|pull/i)
    expect(await pub.head()).toBe(before)
    expect(await pub.subjects()).toEqual(['external: hello'])
  })
})

describe('S06: seed when the subrepo path has no committed files', () => {
  it('errors clearly and pushes nothing', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const pubDir = await makeBareRemote(root, 'core-pub')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)} }`])
    await mono.commit('chore: initial', {'private/secrets.md': 'internal only\n'})

    const res = await runMonolith(mono.dir, ['seed', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(res.stderr).toMatch(/no committed files|nothing to publish/i)

    const pub = new TestRepo(pubDir)
    expect(await pub.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).toBe('')
  })
})
