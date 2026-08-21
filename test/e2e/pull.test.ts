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

describe('S30: external commit in pub', () => {
  it('imports it under core/ with the original author and an origin trailer', async () => {
    const {mono, ext} = await seededWithExternal()

    await ext.commit('external: add CONTRIBUTING.md', {'CONTRIBUTING.md': 'be nice\n'}, EXT_AUTHOR)
    const extPubSha = await ext.head()
    await ext.git(['push', 'origin', 'main'])

    const monoBefore = (await mono.subjects()).length
    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1 commit/)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe('external: add CONTRIBUTING.md')

    const authors = await mono.authors()
    expect(authors[authors.length - 1]).toBe('Ext Contributor <ext@example.test>')

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${extPubSha}`)

    expect(mono.read('core/CONTRIBUTING.md')).toBe('be nice\n')
    expect(await mono.fileAt('HEAD', 'core/CONTRIBUTING.md')).toBe('be nice')
    expect(await mono.treeSha('HEAD', 'core')).toBe(await ext.treeSha(extPubSha))
    // The private side of the monorepo is untouched by an import.
    expect(mono.exists('private/secrets.md')).toBe(true)
  })
})

describe('S31: multiple upstream commits', () => {
  it('imports them oldest first', async () => {
    const {mono, ext} = await seededWithExternal()

    await ext.commit('external: one', {'one.txt': '1\n'}, EXT_AUTHOR)
    await ext.commit('external: two', {'two.txt': '2\n'}, EXT_AUTHOR)
    await ext.commit('external: three', {'three.txt': '3\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 3 commit/)

    const subjects = await mono.subjects()
    expect(subjects.slice(-3)).toEqual(['external: one', 'external: two', 'external: three'])
    expect(await mono.treeSha('HEAD', 'core')).toBe(await ext.treeSha('HEAD'))
  })
})

describe('S32: pull twice', () => {
  it('is a no-op the second time', async () => {
    const {mono, ext} = await seededWithExternal()

    await ext.commit('external: drive-by', {'DRIVEBY.md': 'hi\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const first = await runMonosplice(mono.dir, ['pull'])
    expect(first.exitCode, first.stderr).toBe(0)
    const head = await mono.head()

    const second = await runMonosplice(mono.dir, ['pull'])
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/up to date/)
    expect(await mono.head()).toBe(head)
  })
})

describe('S33: pub commits carrying Monosplice-Source', () => {
  it('are skipped on pull (our own exports never come back)', async () => {
    const {mono} = await seededWithExternal()

    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    await mono.commit('feat: two', {'core/two.txt': '2\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)

    const head = await mono.head()
    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/up to date/)
    expect(await mono.head()).toBe(head)
  })
})

describe('S34: dirty working tree', () => {
  it('refuses before touching anything when core/ has uncommitted changes', async () => {
    const {mono, ext} = await seededWithExternal()

    await ext.commit('external: drive-by', {'DRIVEBY.md': 'hi\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    mono.write('core/README.md', '# core\n\nwork in progress\n')
    const head = await mono.head()
    const subjects = await mono.subjects()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/core/)
    expect(await mono.head()).toBe(head)
    expect(await mono.subjects()).toEqual(subjects)
    expect(mono.read('core/README.md')).toBe('# core\n\nwork in progress\n')
    expect(mono.exists('core/DRIVEBY.md')).toBe(false)
  })

  it('refuses when an untracked file sits under core/', async () => {
    const {mono, ext} = await seededWithExternal()
    await ext.commit('external: drive-by', {'DRIVEBY.md': 'hi\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    mono.write('core/scratch.tmp', 'scratch\n')
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core/DRIVEBY.md')).toBe(false)
  })

  it('refuses when changes are staged outside core/', async () => {
    const {mono, ext} = await seededWithExternal()
    await ext.commit('external: drive-by', {'DRIVEBY.md': 'hi\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    mono.write('private/secrets.md', 'staged elsewhere\n')
    await mono.git(['add', 'private/secrets.md'])
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/staged/i)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('core/DRIVEBY.md')).toBe(false)
    // the stray staged change was neither committed nor unstaged
    expect(await mono.git(['diff', '--cached', '--name-only'])).toBe('private/secrets.md')
  })
})

describe('S35: conflicting edits on both sides', () => {
  it('stops with conflict markers and completes after `pull --continue`', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    const extPubSha = await ext.head()
    await ext.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)
    expect(conflicted.stderr).toContain('core/README.md')
    expect(conflicted.stderr).toContain('monosplice pull --continue')

    const withMarkers = mono.read('core/README.md')
    expect(withMarkers).toContain('<<<<<<<')
    expect(withMarkers).toContain('=======')
    expect(withMarkers).toContain('>>>>>>>')
    expect(withMarkers).toContain('mono wording')
    expect(withMarkers).toContain('ext wording')

    mono.write('core/README.md', '# core\n\nmono wording and ext wording\n')
    await mono.git(['add', 'core/README.md'])

    const resumed = await runMonosplice(mono.dir, ['pull', '--continue'])
    expect(resumed.exitCode, resumed.stderr).toBe(0)
    expect(resumed.stdout).toMatch(/imported 1 commit/)

    const subjects = await mono.subjects()
    expect(subjects[subjects.length - 1]).toBe('docs: ext wording')
    const authors = await mono.authors()
    expect(authors[authors.length - 1]).toBe('Ext Contributor <ext@example.test>')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${extPubSha}`)
    expect(mono.read('core/README.md')).toBe('# core\n\nmono wording and ext wording\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    // Round-trip fidelity: the resolution must reach pub, or the two sides diverge forever.
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect(await pub.fileAt('HEAD', 'README.md')).toBe('# core\n\nmono wording and ext wording')
  })

  it('refuses to continue while unmerged paths remain, and refuses a fresh pull mid-conflict', async () => {
    const {mono, ext} = await seededWithExternal()

    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)

    const early = await runMonosplice(mono.dir, ['pull', '--continue'])
    expect(early.exitCode).not.toBe(0)
    expect(early.stderr).toContain('core/README.md')

    const restart = await runMonosplice(mono.dir, ['pull'])
    expect(restart.exitCode).not.toBe(0)
    expect(restart.stderr).toMatch(/--continue/)
  })

  it('errors when --continue is used with no pull in progress', async () => {
    const {mono} = await seededWithExternal()
    const res = await runMonosplice(mono.dir, ['pull', '--continue'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/no pull/i)
  })
})

describe('S36: imported file matching an exclude pattern', () => {
  it('imports it but warns that the next push will delete it from pub', async () => {
    const {mono, pub, ext} = await seededWithExternal({configExtra: `exclude: ['INTERNAL.md']`})

    await ext.commit(
      'external: add notes',
      {'INTERNAL.md': 'external notes\n', 'PUBLIC.md': 'public notes\n'},
      EXT_AUTHOR,
    )
    await ext.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1 commit/)
    expect(res.stderr).toContain('INTERNAL.md')
    expect(res.stderr).toMatch(/exclude/i)
    expect(res.stderr).not.toContain('PUBLIC.md')

    expect(mono.exists('core/INTERNAL.md')).toBe(true)
    expect(await mono.fileAt('HEAD', 'core/INTERNAL.md')).toBe('external notes')

    // Documented consequence: the exclude wins, so pushing removes it from pub.
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).not.toContain('INTERNAL.md')
    expect(paths).toContain('PUBLIC.md')
    // The file survives in mono, so pub is filtered(core/) here rather than core/ itself.
    expect(mono.exists('core/INTERNAL.md')).toBe(true)
    expect(await pub.fileAt('HEAD', 'PUBLIC.md')).toBe('public notes')
  })
})

describe('pull against an unseeded or unreachable remote', () => {
  it('tells the user to publish when the public branch does not exist', async () => {
    const {mono} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
  })
})
