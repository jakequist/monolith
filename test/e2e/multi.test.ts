import {describe, expect, it} from 'vitest'
import {type TestRepo, cloneRemote, multiFixture, runMonolith} from './harness.js'

/** Seed both subrepos of the multi fixture. */
async function seededPair(): Promise<Awaited<ReturnType<typeof multiFixture>>> {
  const fixture = await multiFixture()
  for (const name of ['core', 'lib']) {
    const res = await runMonolith(fixture.mono.dir, ['seed', name])
    expect(res.exitCode, res.stderr).toBe(0)
  }
  return fixture
}

/** Assert a blob with exactly this content is absent from `repo`'s object db. */
async function assertBlobAbsent(repo: TestRepo, mono: TestRepo, content: string): Promise<void> {
  const blob = await mono.git(['hash-object', '--stdin'], {input: content})
  // sanity: the monorepo really does have it
  await mono.git(['cat-file', '-e', blob])
  await expect(repo.git(['cat-file', '-e', blob])).rejects.toThrow()
}

describe('S60: two subrepos with separate remotes', () => {
  it('exports each to its own remote only', async () => {
    const {mono, corePub, libPub} = await seededPair()

    const coreContent = 'export const greet = () => "hi from core"\n'
    const libContent = 'export const helper = () => "hi from lib"\n'
    await mono.commit('feat(core): add greeter', {'core/src/greet.ts': coreContent})
    await mono.commit('feat(lib): add helper', {'packages/lib/src/helper.ts': libContent})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/core: exported 1 commit/)
    expect(res.stdout).toMatch(/lib: exported 1 commit/)

    expect(await corePub.subjects()).toEqual(['Initial import of core', 'feat(core): add greeter'])
    expect(await libPub.subjects()).toEqual(['Initial import of lib', 'feat(lib): add helper'])

    expect(await corePub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect(await libPub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'packages/lib'))

    // The nested path must not leak into the public tree: pub sees `src/helper.ts`,
    // never `packages/lib/src/helper.ts`.
    const libPaths = (await libPub.treeEntries('HEAD')).map((e) => e.split(' ')[2]).sort()
    expect(libPaths).toEqual(['README.md', 'src/helper.ts', 'src/lib.ts'])

    await assertBlobAbsent(corePub, mono, libContent)
    await assertBlobAbsent(libPub, mono, coreContent)
    await assertBlobAbsent(libPub, mono, 'internal only\n')
  })

  it('imports external commits back into the nested subrepo path', async () => {
    const {root, mono, libPubDir} = await seededPair()

    const ext = await cloneRemote(root, libPubDir, 'lib-ext')
    await ext.commit('external: document the lib', {'docs/usage.md': 'usage\n'})
    await ext.git(['push', 'origin', 'main'])
    const extSha = await ext.head()

    const res = await runMonolith(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/lib: imported 1 commit/)

    expect(mono.read('packages/lib/docs/usage.md')).toBe('usage\n')
    expect(await mono.fileAt('HEAD', 'packages/lib/docs/usage.md')).toBe('usage')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monolith-Origin: ${extSha}`)

    // The import must not have created a `docs/` directory at the monorepo root.
    expect(mono.exists('docs/usage.md')).toBe(false)

    const after = await runMonolith(mono.dir, ['push'])
    expect(after.exitCode, after.stderr).toBe(0)
    expect(after.stdout).toMatch(/lib: up to date/)
  })
})

describe('S61: named push', () => {
  it('touches only that subrepo, leaving the other behind until it is pushed too', async () => {
    const {mono, corePub, libPub} = await seededPair()
    const libHeadBefore = await libPub.head()

    await mono.commit('feat(core): core work', {'core/a.txt': 'a\n'})
    await mono.commit('feat(lib): lib work', {'packages/lib/b.txt': 'b\n'})

    const first = await runMonolith(mono.dir, ['push', 'core'])
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/core: exported 1 commit/)
    expect(first.stdout).not.toMatch(/lib:/)

    expect(await corePub.subjects()).toEqual(['Initial import of core', 'feat(core): core work'])
    expect(await libPub.head()).toBe(libHeadBefore)
    expect(await libPub.subjects()).toEqual(['Initial import of lib'])

    const status = await runMonolith(mono.dir, ['status', '--json'])
    expect(status.exitCode, status.stderr).toBe(0)
    const rows = (JSON.parse(status.stdout) as {subrepos: Array<{name: string; ahead: number}>}).subrepos
    expect(rows.find((r) => r.name === 'core')?.ahead).toBe(0)
    expect(rows.find((r) => r.name === 'lib')?.ahead).toBe(1)

    const second = await runMonolith(mono.dir, ['push', 'lib'])
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/lib: exported 1 commit/)
    expect(await libPub.subjects()).toEqual(['Initial import of lib', 'feat(lib): lib work'])
    expect(await libPub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'packages/lib'))
  })
})

describe('S62: one commit touching both subrepos', () => {
  it('exports one commit to each pub, each carrying only its own subtree', async () => {
    const {mono, corePub, libPub} = await seededPair()

    const monoSha = await mono.commit('feat: cross-cutting rename', {
      'core/version.txt': '2.0.0\n',
      'packages/lib/version.txt': '2.0.0\n',
      'private/notes.md': 'do not publish 91af\n',
    })

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/core: exported 1 commit/)
    expect(res.stdout).toMatch(/lib: exported 1 commit/)

    expect(await corePub.subjects()).toEqual(['Initial import of core', 'feat: cross-cutting rename'])
    expect(await libPub.subjects()).toEqual(['Initial import of lib', 'feat: cross-cutting rename'])

    // Same mono commit is the source on both sides.
    for (const pub of [corePub, libPub]) {
      const messages = await pub.messages()
      expect(messages[messages.length - 1]).toContain(`Monolith-Source: ${monoSha}`)
    }

    expect(await corePub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect(await libPub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'packages/lib'))

    const corePaths = (await corePub.treeEntries('HEAD')).map((e) => e.split(' ')[2]).sort()
    expect(corePaths).toEqual(['README.md', 'src/index.ts', 'version.txt'])
    const libPaths = (await libPub.treeEntries('HEAD')).map((e) => e.split(' ')[2]).sort()
    expect(libPaths).toEqual(['README.md', 'src/lib.ts', 'version.txt'])

    await assertBlobAbsent(corePub, mono, 'do not publish 91af\n')
    await assertBlobAbsent(libPub, mono, 'do not publish 91af\n')
    await assertBlobAbsent(corePub, mono, 'export const lib = true\n')
    await assertBlobAbsent(libPub, mono, 'export const hello = () => "hello"\n')
  })
})
