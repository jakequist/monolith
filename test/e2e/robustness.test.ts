import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  cloneRemote,
  makeRepo,
  runMonolith,
  sandbox,
  standardFixture,
  writeConfig,
} from './harness.js'

async function seeded(): Promise<{root: string; mono: TestRepo; pubDir: string; pub: TestRepo}> {
  const {root, mono, pubDir} = await standardFixture()
  const res = await runMonolith(mono.dir, ['push', 'core', '--yes'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {root, mono, pubDir, pub: new TestRepo(pubDir)}
}

describe('S80: running outside a monolith-configured repo', () => {
  it('fails with a helpful error naming the config file and `monolith init`', async () => {
    const root = sandbox()
    const plain = await makeRepo(root, 'plain')

    for (const args of [['status'], ['push'], ['pull'], ['doctor']]) {
      const res = await runMonolith(plain.dir, args)
      expect(res.exitCode, `${args[0]} should have failed`).not.toBe(0)
      expect(res.stderr).toContain('monolith.config')
      expect(res.stderr).toContain('monolith init')
    }
  })

  it('fails the same way in a directory that is not a git repo at all', async () => {
    const root = sandbox()
    const res = await runMonolith(root, ['status'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('monolith.config')
    expect(res.stderr).toContain('monolith init')
  })
})

describe('S81: invalid config', () => {
  it('rejects a subrepo path of "/" and names the field and file', async () => {
    const {mono, pubDir} = await seeded()
    writeConfig(mono, [`    { name: 'core', path: '/', remote: ${JSON.stringify(pubDir)} }`])

    const res = await runMonolith(mono.dir, ['status'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('subrepos.0.path')
    expect(res.stderr).toContain(path.join(mono.dir, 'monolith.config.ts'))
    expect(res.stderr).toMatch(/repo root/)
  })

  it('rejects a missing remote and names subrepos.0.remote and the file', async () => {
    const {mono} = await seeded()
    writeConfig(mono, [`    { name: 'core', path: 'core' }`])

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('subrepos.0.remote')
    expect(res.stderr).toContain('remote is required')
    expect(res.stderr).toContain(path.join(mono.dir, 'monolith.config.ts'))
  })

  it('rejects a malformed exclude entry and names it', async () => {
    const {mono, pubDir} = await seeded()
    writeConfig(mono, [
      `    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)}, exclude: [''] }`,
    ])

    const res = await runMonolith(mono.dir, ['status'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('subrepos.0.exclude.0')
  })

  it('reports a config that throws on load as "failed to load", naming the file', async () => {
    const {mono} = await seeded()
    mono.write('monolith.config.ts', 'export default {subrepos: [ this is not valid ts ,,, ]\n')

    const res = await runMonolith(mono.dir, ['status'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('failed to load')
    expect(res.stderr).toContain(path.join(mono.dir, 'monolith.config.ts'))
  })
})

describe('S82: unreachable remote', () => {
  it('is reported cleanly by pull, status and doctor, with no partial state', async () => {
    const {root, mono} = await seeded()
    const missing = path.join(root, 'gone.git')
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(missing)} }`])
    const headBefore = await mono.head()

    for (const args of [['pull'], ['status']]) {
      const res = await runMonolith(mono.dir, args)
      expect(res.exitCode, `${args[0]} should have failed`).not.toBe(0)
      expect(res.stderr).toContain('cannot reach remote')
      expect(res.stderr).toContain('gone.git')
    }

    const doctor = await runMonolith(mono.dir, ['doctor'])
    expect(doctor.exitCode).not.toBe(0)
    expect(doctor.stdout).toContain('gone.git')

    // Only the config edit this test made; nothing was written under the subrepo.
    expect(await mono.head()).toBe(headBefore)
    expect(await mono.git(['status', '--porcelain', '--', 'core'])).toBe('')
  })
})

describe('S83: .gitignore handling', () => {
  it('exports the subrepo .gitignore and ignored-but-tracked files, never the root one', async () => {
    const {mono, pub} = await seeded()

    await mono.commit('chore: ignore rules', {
      '.gitignore': '*.log\nnode_modules/\n',
      'core/.gitignore': 'dist/\n*.tmp\n',
    })

    // Ignored by the ROOT rule, but tracked on purpose — it must still be published.
    mono.write('core/debug.log', 'captured output\n')
    await mono.git(['add', '-f', 'core/debug.log'])
    await mono.commit('chore: keep a sample log')

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)

    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2]).sort()
    expect(paths).toContain('.gitignore')
    expect(paths).toContain('debug.log')

    // The pub `.gitignore` is core's, not the monorepo root's.
    expect(await pub.fileAt('HEAD', '.gitignore')).toBe('dist/\n*.tmp')
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S84: unicode round-trip', () => {
  const fileName = 'ünïcødé-文件.md'
  const content = '# Ünïcødé 文件\n\nrésumé — naïve — 世界 🌍\n'

  it('exports unicode filenames, contents and messages intact', async () => {
    const {mono, pub} = await seeded()
    await mono.commit('feat: 追加 émoji 🎉 support', {[`core/${fileName}`]: content})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    expect(await pub.fileAt('HEAD', fileName)).toBe(content.trimEnd())

    const subjects = await pub.subjects()
    expect(subjects[subjects.length - 1]).toBe('feat: 追加 émoji 🎉 support')
  })

  it('imports unicode filenames, contents and messages intact', async () => {
    const {root, mono, pubDir} = await seeded()
    const extFile = 'døcs/naïve-テスト.txt'
    const extContent = 'contribución externa — 貢献 ✨\n'

    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('外部: añadir 🚀 docs', {[extFile]: extContent})
    await ext.git(['push', 'origin', 'main'])
    const extSha = await ext.head()

    const res = await runMonolith(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1 commit/)

    expect(mono.read(`core/${extFile}`)).toBe(extContent)
    const subjects = await mono.subjects()
    expect(subjects[subjects.length - 1]).toBe('外部: añadir 🚀 docs')
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monolith-Origin: ${extSha}`)

    // …and the round trip back out is a no-op, byte for byte.
    const back = await runMonolith(mono.dir, ['push'])
    expect(back.exitCode, back.stderr).toBe(0)
    expect(back.stdout).toMatch(/up to date/)
    expect(await new TestRepo(pubDir).treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})
