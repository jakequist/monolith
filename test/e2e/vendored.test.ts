import fs from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {TestRepo, makeBareRemote, makeRepo, runMonosplice, sandbox, writeConfig} from './harness.js'

const UP_AUTHOR = {authorName: 'Lo Dash', authorEmail: 'lodash@example.test'}

interface Fixture {
  root: string
  mono: TestRepo
  /** Bare "lodash.git" acting as the third-party remote. */
  upDir: string
  up: TestRepo
  pub: TestRepo
  pubHead: string
}

/**
 * A monorepo with NO subrepo configured at all, plus a separate third-party repo that has
 * its own history — the situation the retired `vendor` command existed for, now reached
 * with `monosplice attach vendor/lodash <url>`.
 */
async function vendorFixture(): Promise<Fixture> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  writeConfig(mono, [])
  await mono.commit('chore: initial monorepo', {
    'app/main.ts': 'export const app = true\n',
    'private/secrets.md': 'internal only\n',
  })

  const upDir = await makeBareRemote(root, 'lodash')
  const up = await makeRepo(root, 'lodash-src')
  await up.commit('lodash: initial', {'README.md': '# lodash\n', 'index.js': 'module.exports = {}\n'}, UP_AUTHOR)
  await up.commit('lodash: add chunk', {'chunk.js': 'exports.chunk = 1\n'}, UP_AUTHOR)
  await up.commit('lodash: add map', {'map.js': 'exports.map = 1\n'}, UP_AUTHOR)
  await up.git(['remote', 'add', 'origin', upDir])
  await up.git(['push', 'origin', 'main'])

  const pub = new TestRepo(upDir)
  return {root, mono, upDir, up, pub, pubHead: await pub.head()}
}

/** Attach the fixture's remote and assert it worked, so later scenarios start from sync. */
async function vendored(): Promise<Fixture> {
  const fx = await vendorFixture()
  const res = await runMonosplice(fx.mono.dir, ['attach', 'vendor/lodash', fx.upDir])
  expect(res.exitCode, res.stderr).toBe(0)
  return fx
}

function configBytes(mono: TestRepo): Buffer {
  return fs.readFileSync(path.join(mono.dir, 'monosplice.config.ts'))
}

describe('S100: attach a third-party repo into vendor/', () => {
  it('creates the tree and the config entry in ONE commit and lands in sync', async () => {
    const {mono, pub, upDir, pubHead} = await vendorFixture()
    const monoBefore = (await mono.subjects()).length

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('✓ attached lodash at vendor/lodash')
    expect(res.stdout).toContain(`${upDir}#main`)
    expect(res.stdout).toMatch(/push and pull/)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(monoBefore + 1)
    expect(subjects[subjects.length - 1]).toBe(`Adopt lodash from ${upDir} @ ${pubHead.slice(0, 10)}`)

    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${pubHead}`)

    // The config edit and the vendored tree land in the SAME commit.
    const changed = (await mono.git(['diff', '--name-only', 'HEAD~1', 'HEAD'])).split('\n').sort()
    expect(changed).toEqual([
      'monosplice.config.ts',
      'vendor/lodash/README.md',
      'vendor/lodash/chunk.js',
      'vendor/lodash/index.js',
      'vendor/lodash/map.js',
    ])

    expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await pub.treeSha('HEAD'))
    expect(mono.read('vendor/lodash/README.md')).toBe('# lodash\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')
    expect(mono.read('monosplice.config.ts')).toContain(`path: 'vendor/lodash'`)
    expect(mono.read('monosplice.config.ts')).toContain(`remote: '${upDir}'`)

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toMatch(/lodash: in sync/)
    expect(status.stdout).not.toMatch(/to pull/)

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toMatch(/up to date/)

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(pubHead)
  })

  it('honors an explicit folder, --name and --branch', async () => {
    const {mono, up, upDir} = await vendorFixture()
    await up.git(['checkout', '-b', 'release'])
    await up.commit('lodash: release only', {'release.txt': 'r\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'release'])

    const res = await runMonosplice(mono.dir, [
      'attach',
      'third_party/lodash-lib',
      upDir,
      '--name',
      'ld',
      '--branch',
      'release',
    ])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('✓ attached ld at third_party/lodash-lib')
    expect(mono.exists('third_party/lodash-lib/release.txt')).toBe(true)

    const config = mono.read('monosplice.config.ts')
    expect(config).toContain(`name: 'ld'`)
    expect(config).toContain(`path: 'third_party/lodash-lib'`)
    expect(config).toContain(`branch: 'release'`)

    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/ld: in sync/)
  })
})

describe('S101: upstream advances after attaching', () => {
  it('imports the new commits into vendor/<name>/ per-commit with authors preserved', async () => {
    const {mono, up} = await vendored()

    await up.commit('lodash: fix chunk', {'chunk.js': 'exports.chunk = 2\n'}, UP_AUTHOR)
    await up.commit('lodash: add zip', {'zip.js': 'exports.zip = 1\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])

    const before = (await mono.subjects()).length
    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 2 commit/)

    const subjects = await mono.subjects()
    expect(subjects).toHaveLength(before + 2)
    expect(subjects.slice(-2)).toEqual(['lodash: fix chunk', 'lodash: add zip'])
    expect((await mono.authors()).slice(-2)).toEqual([
      'Lo Dash <lodash@example.test>',
      'Lo Dash <lodash@example.test>',
    ])

    expect(mono.read('vendor/lodash/chunk.js')).toBe('exports.chunk = 2\n')
    expect(mono.read('vendor/lodash/zip.js')).toBe('exports.zip = 1\n')
    expect((await runMonosplice(mono.dir, ['status'])).stdout).toMatch(/lodash: in sync/)
  })
})

describe('S102: local patch plus a non-conflicting upstream change', () => {
  it('three-way merges cleanly and leaves the local patch to push', async () => {
    const {mono, up, pub} = await vendored()

    await mono.commit('patch: local tweak to index', {'vendor/lodash/index.js': 'module.exports = {patched: true}\n'})
    await up.commit('lodash: touch map', {'map.js': 'exports.map = 2\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1 commit/)

    expect(mono.read('vendor/lodash/index.js')).toBe('module.exports = {patched: true}\n')
    expect(mono.read('vendor/lodash/map.js')).toBe('exports.map = 2\n')
    expect(await mono.git(['status', '--porcelain'])).toBe('')

    // Nothing left to pull, and the local patch is pending. The count is 2, not 1, for the
    // reason S43 already locks in: both sides moved, so the import sits on top of the local
    // patch and its tree differs from the public tip — it must be re-exported or the public
    // repo would never see the patch merged with upstream's change.
    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toMatch(/lodash: 2 to push/)
    expect(status.stdout).not.toMatch(/to pull/)

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'vendor/lodash'))
  })
})

describe('S103: local patch conflicting with an upstream edit', () => {
  it('leaves conflict markers under vendor/<name>/ and converges after --continue and push', async () => {
    const {mono, up, pub} = await vendored()

    await mono.commit('patch: local README line', {'vendor/lodash/README.md': '# lodash\n\nlocal patch\n'})
    await up.commit('lodash: upstream README line', {'README.md': '# lodash\n\nupstream edit\n'}, UP_AUTHOR)
    const upSha = await up.head()
    await up.git(['push', 'origin', 'main'])

    const conflicted = await runMonosplice(mono.dir, ['pull'])
    expect(conflicted.exitCode).not.toBe(0)
    expect(conflicted.stderr).toContain('vendor/lodash/README.md')
    expect(conflicted.stderr).toContain('monosplice pull --continue')

    const markers = mono.read('vendor/lodash/README.md')
    expect(markers).toContain('<<<<<<<')
    expect(markers).toContain('local patch')
    expect(markers).toContain('upstream edit')

    mono.write('vendor/lodash/README.md', '# lodash\n\nlocal patch and upstream edit\n')
    await mono.git(['add', 'vendor/lodash/README.md'])

    const resumed = await runMonosplice(mono.dir, ['pull', '--continue'])
    expect(resumed.exitCode, resumed.stderr).toBe(0)
    expect(resumed.stdout).toMatch(/imported 1 commit/)
    const messages = await mono.messages()
    expect(messages[messages.length - 1]).toContain(`Monosplice-Origin: ${upSha}`)

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'vendor/lodash'))
    expect(await pub.fileAt('HEAD', 'README.md')).toBe('# lodash\n\nlocal patch and upstream edit')
  })
})

describe('S104: attaching the same repo twice', () => {
  it('refuses on the name/path collision leaving the config byte-identical', async () => {
    const {mono, root, upDir} = await vendored()
    const before = configBytes(mono)
    const logBefore = await mono.subjects()

    // Same folder, same url: the entry now exists, so this is first contact — and the two
    // are already connected by trailers.
    const again = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(again.exitCode).not.toBe(0)
    expect(again.stderr).toMatch(/already/i)

    // A different folder under the same name is a plain slot collision.
    const other = await makeBareRemote(root, 'other')
    const src = await makeRepo(root, 'other-src')
    await src.commit('other: initial', {'a.txt': 'a\n'}, UP_AUTHOR)
    await src.git(['remote', 'add', 'origin', other])
    await src.git(['push', 'origin', 'main'])

    const collide = await runMonosplice(mono.dir, ['attach', 'vendor/other', other, '--name', 'lodash'])
    expect(collide.exitCode).not.toBe(0)
    expect(collide.stderr).toMatch(/lodash/)
    expect(collide.stderr).toMatch(/already/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.subjects()).toEqual(logBefore)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
  })

  it('refuses when only the path collides', async () => {
    const {mono, root} = await vendored()
    const other = await makeBareRemote(root, 'other')
    const src = await makeRepo(root, 'other-src')
    await src.commit('other: initial', {'a.txt': 'a\n'}, UP_AUTHOR)
    await src.git(['remote', 'add', 'origin', other])
    await src.git(['push', 'origin', 'main'])
    const before = configBytes(mono)

    // The path resolves to the configured `lodash` entry, so this is the repoint refusal.
    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', other])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/vendor\/lodash/)
    expect(configBytes(mono).equals(before)).toBe(true)
  })
})

describe('S105: attach preconditions on a new entry', () => {
  it('refuses a dirty working tree before fetching or writing anything', async () => {
    const {mono, upDir} = await vendorFixture()
    mono.write('app/main.ts', 'export const app = "wip"\n')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/uncommitted|staged/i)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('vendor')).toBe(false)
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/lodash/remote']).catch(() => '')).toBe('')
  })

  it('refuses staged changes anywhere', async () => {
    const {mono, upDir} = await vendorFixture()
    mono.write('private/secrets.md', 'staged elsewhere\n')
    await mono.git(['add', 'private/secrets.md'])
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/staged|uncommitted/i)
    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(await mono.git(['diff', '--cached', '--name-only'])).toBe('private/secrets.md')
  })

  it('refuses an untracked directory sitting at the target path', async () => {
    const {mono, upDir} = await vendorFixture()
    mono.write('vendor/lodash/leftover.txt', 'from a previous attempt\n')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/vendor\/lodash/)
    expect(res.stderr).toMatch(/exists/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.read('vendor/lodash/leftover.txt')).toBe('from a previous attempt\n')
    expect(await mono.git(['rev-parse', '--verify', '--quiet', 'refs/monosplice/lodash/remote']).catch(() => '')).toBe('')
  })

  it('refuses a path that nests inside an existing subrepo', async () => {
    const {mono, root} = await vendored()
    const other = await makeBareRemote(root, 'nested')
    const src = await makeRepo(root, 'nested-src')
    await src.commit('nested: initial', {'a.txt': 'a\n'}, UP_AUTHOR)
    await src.git(['remote', 'add', 'origin', other])
    await src.git(['push', 'origin', 'main'])
    const before = configBytes(mono)

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash/inner', other])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nest/i)
    expect(configBytes(mono).equals(before)).toBe(true)
  })
})

describe('S106: unreachable remote or missing branch', () => {
  it('reports an unreachable URL cleanly and changes nothing', async () => {
    const {mono, root} = await vendorFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', `${root}/gone.git`])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('cannot reach remote')
    expect(res.stderr).toContain('gone.git')

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('vendor')).toBe(false)
  })

  it('names the missing branch and changes nothing', async () => {
    const {mono, upDir} = await vendorFixture()
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir, '--branch', 'nope'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('nope')
    expect(res.stderr).toContain(upDir)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('vendor')).toBe(false)
  })
})

describe('S107: a config shape the inserter cannot handle', () => {
  it('changes nothing and prints a paste-able snippet on stdout', async () => {
    const {mono, upDir} = await vendorFixture()
    mono.write(
      'monosplice.config.ts',
      'const shared: Array<{path: string; remote: string}> = []\n\nexport default {\n  subrepos: [...shared],\n}\n',
    )
    await mono.commit('chore: config built from a spread')
    const before = configBytes(mono)
    const head = await mono.head()

    const res = await runMonosplice(mono.dir, ['attach', 'vendor/lodash', upDir])
    expect(res.exitCode).not.toBe(0)

    expect(res.stdout).toContain(`path: 'vendor/lodash'`)
    expect(res.stdout).toContain(`remote: '${upDir}'`)
    expect(res.stdout).toMatch(/monosplice\.config\.ts/)

    expect(configBytes(mono).equals(before)).toBe(true)
    expect(await mono.head()).toBe(head)
    expect(mono.exists('vendor')).toBe(false)
    expect(await mono.git(['status', '--porcelain'])).toBe('')
  })
})
