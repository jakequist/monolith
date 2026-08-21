import fs from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonosplice, standardFixture} from './harness.js'

const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

async function seededWithExternal(opts: {configExtra?: string} = {}): Promise<{
  root: string
  mono: TestRepo
  pub: TestRepo
  pubDir: string
  ext: TestRepo
}> {
  const {root, mono, pubDir} = await standardFixture(opts)
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  const ext = await cloneRemote(root, pubDir, 'ext')
  return {root, mono, pub: new TestRepo(pubDir), pubDir, ext}
}

/** Every tracked-or-untracked file in the work tree, ignoring .git. */
function workTreeFiles(dir: string, prefix = '', out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === '.git') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) workTreeFiles(path.join(dir, entry.name), rel, out)
    else out.push(rel)
  }
  return out
}

describe('S51: cursors derive from trailers, not from state on disk', () => {
  it('reports the derived sync points and passes after several push/pull cycles', async () => {
    const {mono, pub, ext} = await seededWithExternal()

    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)

    await ext.git(['fetch', 'origin'])
    await ext.git(['reset', '--hard', 'origin/main'])
    await ext.commit('external: two', {'two.txt': '2\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    expect((await runMonosplice(mono.dir, ['pull'])).exitCode).toBe(0)

    await mono.commit('feat: three', {'core/three.txt': '3\n'})
    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)

    const monoHead = await mono.head()
    const pubHead = await pub.head()

    const doc = await runMonosplice(mono.dir, ['doctor'])
    expect(doc.exitCode, `${doc.stdout}\n${doc.stderr}`).toBe(0)
    expect(doc.stdout).toMatch(/all checks passed/)
    expect(doc.stdout).toContain('core')
    // the derived sync points, and they match reality
    expect(doc.stdout).toContain(pubHead)
    expect(doc.stdout).toContain(monoHead)
    expect(doc.stdout).toMatch(/to push: 0/)
    expect(doc.stdout).toMatch(/to pull: 0/)

    // no state file, by design
    const files = workTreeFiles(mono.dir)
    expect(files).not.toContain('.monosplice')
    expect(files.some((f) => f.startsWith('.monosplice/'))).toBe(false)
    expect(files.some((f) => path.basename(f) === 'state.json')).toBe(false)
    expect(fs.existsSync(path.join(mono.dir, '.monosplice'))).toBe(false)
  })
})

describe('S52: broken commit mapping', () => {
  it('is detected by doctor and blocks push instead of exporting garbage', async () => {
    const {mono, pub, ext} = await seededWithExternal()
    const ghost = 'ab'.repeat(20)

    await ext.commit(
      `external: forged mapping\n\nMonosplice-Source: ${ghost}`,
      {'forged.txt': 'from nowhere\n'},
      EXT_AUTHOR,
    )
    const forgedPubSha = await ext.head()
    await ext.git(['push', 'origin', 'main'])
    const pubHeadBefore = await pub.head()
    const pubSubjectsBefore = await pub.subjects()

    const doc = await runMonosplice(mono.dir, ['doctor'])
    expect(doc.exitCode).toBe(1)
    expect(doc.stdout).toContain(ghost)
    expect(doc.stdout).toContain(forgedPubSha)
    expect(doc.stdout).toMatch(/Monosplice-Source/)
    expect(doc.stdout).toMatch(/does not exist/i)

    // A pending local commit must NOT be exported on top of a mapping we cannot trust.
    await mono.commit('feat: local work', {'core/local.txt': 'local\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode).not.toBe(0)
    expect(push.stderr).toContain(ghost)
    expect(push.stderr).toMatch(/doctor/)
    expect(await pub.head()).toBe(pubHeadBefore)
    expect(await pub.subjects()).toEqual(pubSubjectsBefore)
    // the external content was neither reverted nor duplicated
    expect(await pub.fileAt('HEAD', 'forged.txt')).toBe('from nowhere')
  })
})

describe('S53: fresh clone on a second machine', () => {
  it('works immediately with no state to restore', async () => {
    const {root, mono, pub, pubDir, ext} = await seededWithExternal()

    // The config is committed, which is what makes a fresh clone self-sufficient.
    expect(await mono.fileAt('HEAD', 'monosplice.config.ts')).toContain('subrepos')

    await mono.commit('feat: first machine', {'core/first.txt': '1\n'})
    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)

    await ext.git(['fetch', 'origin'])
    await ext.git(['reset', '--hard', 'origin/main'])
    await ext.commit('external: before the clone', {'before.txt': 'b\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    expect((await runMonosplice(mono.dir, ['pull'])).exitCode).toBe(0)
    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)

    // "Second machine": a plain clone of the monorepo, no monosplice state carried over.
    const mono2 = await cloneRemote(root, mono.dir, 'mono2')
    expect(fs.existsSync(path.join(mono2.dir, '.monosplice'))).toBe(false)

    const st = await runMonosplice(mono2.dir, ['status'])
    expect(st.exitCode, st.stderr).toBe(0)
    expect(st.stdout).toMatch(/core: in sync/)

    const doc = await runMonosplice(mono2.dir, ['doctor'])
    expect(doc.exitCode, `${doc.stdout}\n${doc.stderr}`).toBe(0)

    // A full round from the fresh clone.
    const ext2 = await cloneRemote(root, pubDir, 'ext2')
    await ext2.commit('external: after the clone', {'after.txt': 'a\n'}, EXT_AUTHOR)
    await ext2.git(['push', 'origin', 'main'])

    const pull = await runMonosplice(mono2.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toMatch(/imported 1/)

    await mono2.commit('feat: second machine', {'core/second.txt': '2\n'})
    const push = await runMonosplice(mono2.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/exported/)

    expect(await pub.treeSha('HEAD')).toBe(await mono2.treeSha('HEAD', 'core'))
    expect(await pub.subjects()).toContain('feat: second machine')
  })
})

describe('S54: rewritten monorepo history', () => {
  it('refuses to push and doctor names the problem', async () => {
    const {mono, pub} = await seededWithExternal()

    await mono.commit('feat: exported', {'core/x.txt': 'x\n'})
    const first = await runMonosplice(mono.dir, ['push'])
    expect(first.exitCode, first.stderr).toBe(0)
    const exportedMonoSha = await mono.head()
    const pubHead = await pub.head()
    const pubSubjects = await pub.subjects()

    // rebase/amend/force-push equivalent: drop the exported commit, put a different one back
    await mono.git(['reset', '--hard', 'HEAD~1'])
    await mono.commit('feat: rewritten', {'core/y.txt': 'y\n'})

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode).not.toBe(0)
    expect(push.stderr).toContain(exportedMonoSha)
    expect(push.stderr).toMatch(/rewritten/i)
    expect(push.stderr).toMatch(/doctor/)
    expect(await pub.head()).toBe(pubHead)
    expect(await pub.subjects()).toEqual(pubSubjects)

    const doc = await runMonosplice(mono.dir, ['doctor'])
    expect(doc.exitCode).toBe(1)
    expect(doc.stdout).toContain(exportedMonoSha)
    expect(doc.stdout).toMatch(/rewritten|ancestor/i)
  })
})

describe('doctor housekeeping', () => {
  it('flags an unfinished pull', async () => {
    const {mono, ext} = await seededWithExternal()
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)

    const doc = await runMonosplice(mono.dir, ['doctor'])
    expect(doc.exitCode).toBe(1)
    expect(doc.stdout).toMatch(/pull/i)
    expect(doc.stdout).toMatch(/--continue/)
  })

  it('flags a subrepo that was never seeded', async () => {
    const {mono} = await standardFixture()
    const doc = await runMonosplice(mono.dir, ['doctor'])
    expect(doc.exitCode).toBe(1)
    expect(doc.stdout).toMatch(/not published yet/)
    expect(doc.stdout).toMatch(/monosplice push core --yes/)
  })
})
