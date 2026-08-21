import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonosplice, standardFixture} from './harness.js'

async function seeded(): Promise<{root: string; mono: TestRepo; pubDir: string; pub: TestRepo}> {
  const {root, mono, pubDir} = await standardFixture()
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {root, mono, pubDir, pub: new TestRepo(pubDir)}
}

/** Tag shas advertised by the bare remote, as `<sha> <ref>` lines. */
async function remoteTags(mono: TestRepo, pubDir: string): Promise<string[]> {
  const out = await mono.git(['ls-remote', '--tags', pubDir])
  return out === '' ? [] : out.split('\n').map((l) => l.replace('\t', ' '))
}

describe('S70: tag a subrepo', () => {
  it('tags the public commit matching mono HEAD and makes it visible on the remote', async () => {
    const {mono, pubDir, pub} = await seeded()
    await mono.commit('feat: ship it', {'core/ship.txt': 'ready\n'})

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    const pubHead = await pub.head()

    const res = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('✓ core: tagged v1.0.0')
    expect(res.stdout).toContain(pubHead.slice(0, 10))

    expect(await remoteTags(mono, pubDir)).toEqual([`${pubHead} refs/tags/v1.0.0`])
  })

  it('refuses a tag name that already exists on the remote', async () => {
    const {mono, pubDir, pub} = await seeded()
    const first = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(first.exitCode, first.stderr).toBe(0)
    const pubHead = await pub.head()

    await mono.commit('feat: more', {'core/more.txt': 'more\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)

    const res = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/v1\.0\.0/)
    expect(res.stderr).toMatch(/already exists/i)

    // still pointing at the original commit
    expect(await remoteTags(mono, pubDir)).toEqual([`${pubHead} refs/tags/v1.0.0`])
  })
})

describe('S71: tagging with unexported commits', () => {
  it('refuses because the tag would not match mono HEAD, and creates no tag', async () => {
    const {mono, pubDir} = await seeded()
    await mono.commit('feat: not pushed yet', {'core/pending.txt': 'pending\n'})

    const res = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/1 commit/)
    expect(res.stderr).toMatch(/monosplice push core/)
    expect(await remoteTags(mono, pubDir)).toEqual([])
  })

  it('refuses while unimported public commits exist, pointing at pull', async () => {
    const {root, mono, pubDir} = await seeded()
    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('external: drive-by', {'EXTERNAL.md': 'outside\n'})
    await ext.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice pull core/)
    expect(await remoteTags(mono, pubDir)).toEqual([])
  })

  it('refuses when the subrepo has never been seeded', async () => {
    const {mono} = await standardFixture()
    const res = await runMonosplice(mono.dir, ['tag', 'core', 'v1.0.0'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/monosplice push core --yes/)
  })
})
