import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  cloneRemote,
  makeBareRemote,
  makeRepo,
  multiFixture,
  runMonosplice,
  sandbox,
  standardFixture,
} from './harness.js'

const CONFIG = 'monosplice.config.ts'
const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

/** Fixture + a published core subrepo, so detach has real trailers to leave inert. */
async function published(): Promise<{root: string; mono: TestRepo; pubDir: string}> {
  const {root, mono, pubDir} = await standardFixture()
  const res = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {root, mono, pubDir}
}

// ---------------------------------------------------------------------------------------
// S161: detach
// ---------------------------------------------------------------------------------------

describe('S161: detach removes the config entry and nothing else', () => {
  it('drops the entry in one commit, keeping every file and every commit', async () => {
    const {mono, pubDir} = await published()
    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    const before = await mono.subjects()
    const tree = await mono.treeSha('HEAD', 'core')

    const res = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    // The config no longer tracks it.
    expect(mono.read(CONFIG)).not.toContain(pubDir)
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toContain('no subrepos configured')

    // Files kept, history kept.
    expect(mono.exists('core/README.md')).toBe(true)
    expect(mono.exists('core/one.txt')).toBe(true)
    expect(await mono.treeSha('HEAD', 'core')).toBe(tree)
    expect((await mono.subjects()).slice(0, before.length)).toEqual(before)

    // Exactly one new commit, and it only touches the config file.
    const added = (await mono.subjects()).slice(before.length)
    expect(added).toEqual([`Detach core: stop tracking ${pubDir}`])
    expect(await mono.git(['show', '--name-only', '--format=', 'HEAD'])).toBe(CONFIG)
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    // The output has to say all of that, and name the way back.
    const out = res.stdout
    expect(out).toMatch(/kept/i)
    expect(out).toMatch(/histor/i)
    expect(out).toContain(`monosplice attach core ${pubDir}`)
  })

  it('leaves the other subrepos alone', async () => {
    const {mono, corePubDir, libPubDir} = await multiFixture()
    expect((await runMonosplice(mono.dir, ['push', '--yes'])).exitCode).toBe(0)

    const res = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).not.toMatch(/^core:/m)
    expect(status.stdout).toMatch(/^lib: in sync$/m)
    expect(mono.read(CONFIG)).toContain(libPubDir)
    expect(mono.read(CONFIG)).not.toContain(corePubDir)
  })

  it('never contacts the network', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const unreachable = path.join(root, 'nowhere.git')
    mono.write(
      CONFIG,
      `export default {\n  subrepos: [\n    { path: 'core', remote: ${JSON.stringify(unreachable)} },\n  ],\n}\n`,
    )
    await mono.commit('chore: initial monorepo', {'core/README.md': '# core\n'})

    const res = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(mono.read(CONFIG)).not.toContain(unreachable)
  })
})

describe('S161: detach refusals leave everything untouched', () => {
  it('refuses an unknown subrepo', async () => {
    const {mono} = await published()
    const config = mono.read(CONFIG)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['detach', 'nope'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nope/)
    expect(res.stderr).toMatch(/core/)
    expect(mono.read(CONFIG)).toBe(config)
    expect(await mono.head()).toBe(head)
  })

  it('refuses a dirty working tree and staged changes', async () => {
    const {mono} = await published()
    const config = mono.read(CONFIG)
    const head = await mono.head()

    mono.write('core/README.md', '# core\n\nedited\n')
    const dirty = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(dirty.exitCode).not.toBe(0)
    expect(dirty.stderr).toMatch(/uncommitted changes/)
    expect(mono.read(CONFIG)).toBe(config)

    await mono.git(['checkout', '--', 'core/README.md'])
    mono.write('staged.txt', 'x\n')
    await mono.git(['add', 'staged.txt'])
    const staged = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(staged.exitCode).not.toBe(0)
    expect(staged.stderr).toMatch(/staged changes/)
    expect(mono.read(CONFIG)).toBe(config)
    expect(await mono.head()).toBe(head)
  })

  it('refuses while a pull of that subrepo is unfinished', async () => {
    const {root, mono, pubDir} = await published()
    // Drive a conflict: both sides edit README.md.
    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('docs: ext wording', {'README.md': '# core\n\next wording\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])
    await mono.commit('docs: mono wording', {'core/README.md': '# core\n\nmono wording\n'})
    expect((await runMonosplice(mono.dir, ['pull'])).exitCode).not.toBe(0)

    const config = mono.read(CONFIG)
    const res = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/pull of core/)
    expect(mono.read(CONFIG)).toBe(config)
  })

  it('restores a config it cannot edit and says exactly what to delete', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')
    const pubDir = await makeBareRemote(root, 'core-pub')
    mono.write(
      CONFIG,
      [
        `const shared = [{ path: 'core', remote: ${JSON.stringify(pubDir)} }]`,
        'export default {',
        '  subrepos: [...shared],',
        '}',
        '',
      ].join('\n'),
    )
    await mono.commit('chore: initial monorepo', {'core/README.md': '# core\n'})
    const config = mono.read(CONFIG)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['detach', 'core'])
    expect(res.exitCode).not.toBe(0)
    expect(mono.read(CONFIG)).toBe(config)
    expect(await mono.head()).toBe(head)
    expect(`${res.stdout}${res.stderr}`).toMatch(/core/)
    expect(`${res.stdout}${res.stderr}`).toMatch(/by hand|yourself|delete/i)
  })
})
