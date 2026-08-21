import {describe, expect, it} from 'vitest'
import {
  TestRepo,
  cloneRemote,
  makeBareRemote,
  makeRepo,
  runMonosplice,
  sandbox,
  standardFixture,
  writeConfig,
} from './harness.js'

const UP_AUTHOR = {authorName: 'Lo Dash', authorEmail: 'lodash@example.test'}
const EXT_AUTHOR = {authorName: 'Ext Contributor', authorEmail: 'ext@example.test'}

interface Tri {
  root: string
  mono: TestRepo
  /** Bare repo standing in for the upstream project (never written to by monosplice). */
  upDir: string
  /** Working clone used to move upstream forward, like a maintainer would. */
  up: TestRepo
  upstream: TestRepo
  /** Bare repo standing in for our fork (the push destination). */
  forkDir: string
  fork: TestRepo
}

interface TriOptions {
  pushBranch?: string
  /** Overrides for the config entry, e.g. a deliberately broken URL. */
  remote?: string
  upstream?: string
}

/**
 * Three repos: upstream (someone else's), our fork, and the monorepo that vendors upstream
 * and pushes patches to the fork.
 */
async function triFixture(opts: TriOptions = {}): Promise<Tri> {
  const root = sandbox()
  const upDir = await makeBareRemote(root, 'lodash')
  const forkDir = await makeBareRemote(root, 'lodash-fork')

  const up = await makeRepo(root, 'lodash-src')
  await up.commit('lodash: initial', {'README.md': '# lodash\n', 'index.js': 'module.exports = {}\n'}, UP_AUTHOR)
  await up.commit('lodash: add chunk', {'chunk.js': 'exports.chunk = 1\n'}, UP_AUTHOR)
  await up.git(['remote', 'add', 'origin', upDir])
  await up.git(['push', 'origin', 'main'])

  const mono = await makeRepo(root, 'mono')
  const fields = [
    `name: 'lodash'`,
    `path: 'vendor/lodash'`,
    `remote: ${JSON.stringify(opts.remote ?? forkDir)}`,
    `upstream: ${JSON.stringify(opts.upstream ?? upDir)}`,
    ...(opts.pushBranch ? [`pushBranch: ${JSON.stringify(opts.pushBranch)}`] : []),
  ]
  writeConfig(mono, [`    { ${fields.join(', ')} }`])
  await mono.commit('chore: initial monorepo', {
    'app/main.ts': 'export const app = true\n',
    'private/secrets.md': 'internal only\n',
  })

  return {root, mono, upDir, up, upstream: new TestRepo(upDir), forkDir, fork: new TestRepo(forkDir)}
}

/** Fixture + `adopt`, i.e. the monorepo now tracks upstream at its current head. */
async function adopted(opts: TriOptions = {}): Promise<Tri> {
  const fx = await triFixture(opts)
  const res = await runMonosplice(fx.mono.dir, ['adopt', 'lodash'])
  expect(res.exitCode, res.stderr).toBe(0)
  return fx
}

/** Adopted + one local patch, pushed to the fork branch. */
async function patched(opts: TriOptions = {}): Promise<Tri & {forkHead: string; upstreamHead: string}> {
  const fx = await adopted(opts)
  fx.mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
  await fx.mono.commit('fix(lodash): guard against a null prototype')

  const res = await runMonosplice(fx.mono.dir, ['push'])
  expect(res.exitCode, res.stderr).toBe(0)
  expect(res.stdout).toContain('exported 1 commit(s)')

  const branch = opts.pushBranch ?? 'main'
  return {
    ...fx,
    forkHead: await fx.fork.git(['rev-parse', `refs/heads/${branch}`]),
    upstreamHead: await fx.upstream.git(['rev-parse', 'refs/heads/main']),
  }
}

/** Every ref a bare repo has, as `<sha> <ref>` lines — proof that nothing was written. */
async function refs(repo: TestRepo): Promise<string[]> {
  const out = await repo.git(['for-each-ref', '--format=%(objectname) %(refname)'])
  return out === '' ? [] : out.split('\n').sort()
}

async function firstParents(repo: TestRepo, ref: string): Promise<string[]> {
  const out = await repo.git(['log', '--first-parent', '--reverse', '--format=%s', ref])
  return out === '' ? [] : out.split('\n')
}

describe('S110: import decisions come from upstream, never from the fork', () => {
  it('pulls upstream commits while the fork remote is still empty', async () => {
    const {mono, up, fork, upstream} = await adopted()

    await up.commit('lodash: add map', {'map.js': 'exports.map = 1\n'}, UP_AUTHOR)
    await up.commit('lodash: add zip', {'zip.js': 'exports.zip = 1\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('imported 2 commit(s)')

    expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await upstream.treeSha('refs/heads/main'))
    expect(mono.exists('vendor/lodash/zip.js')).toBe(true)

    // The fork was never touched: no branch there, and no fork tracking ref locally.
    expect(await refs(fork)).toEqual([])
    await expect(mono.git(['rev-parse', '--verify', 'refs/monosplice/lodash/fork'])).rejects.toThrow()

    const again = await runMonosplice(mono.dir, ['pull'])
    expect(again.stdout).toContain('up to date')
  })

  it('ignores a stale fork branch when deciding what to import', async () => {
    const {mono, up, fork, forkHead, upstream} = await patched()

    await up.commit('lodash: add map', {'map.js': 'exports.map = 1\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])

    const res = await runMonosplice(mono.dir, ['pull'])
    expect(res.exitCode, res.stderr).toBe(0)
    // Exactly the one upstream commit — the fork's own patch commit is not import material.
    expect(res.stdout).toContain('imported 1 commit(s)')
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)

    expect(mono.read('vendor/lodash/index.js')).toBe('module.exports = {patched: true}\n')
    expect(mono.exists('vendor/lodash/map.js')).toBe(true)
    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).not.toBe(forkHead)
  })
})

describe('S111: push builds the fork branch on the upstream head', () => {
  it('exports patches to the fork, parented on upstream, leaving upstream untouched', async () => {
    const {mono, fork, upstream, upDir, forkDir} = await adopted()
    const upstreamRefs = await refs(upstream)
    const upstreamHead = await upstream.git(['rev-parse', 'refs/heads/main'])

    mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
    const patchSha = await mono.commit('fix(lodash): guard against a null prototype')

    const res = await runMonosplice(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('exported 1 commit(s)')
    expect(res.stdout).toContain(forkDir)

    // Upstream is never written to.
    expect(await refs(upstream)).toEqual(upstreamRefs)

    const forkHead = await fork.git(['rev-parse', 'refs/heads/main'])
    expect(await fork.git(['rev-parse', 'refs/heads/main~1'])).toBe(upstreamHead)
    expect(await firstParents(fork, 'refs/heads/main')).toEqual([
      'lodash: initial',
      'lodash: add chunk',
      'fix(lodash): guard against a null prototype',
    ])
    expect(await fork.git(['log', '-1', '--format=%B', forkHead])).toContain(`Monosplice-Source: ${patchSha}`)
    expect(await fork.treeSha(forkHead)).toBe(await mono.treeSha('HEAD', 'vendor/lodash'))

    // Nothing was pushed to upstream, and a second push is a no-op on the fork.
    const again = await runMonosplice(mono.dir, ['push'])
    expect(again.exitCode, again.stderr).toBe(0)
    expect(again.stdout).toContain('up to date')
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)
    expect(await refs(upstream)).toEqual(upstreamRefs)
    expect(upDir).not.toBe(forkDir)
  })

  it('honors pushBranch', async () => {
    const {mono, fork} = await adopted({pushBranch: 'monosplice/patches'})
    mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
    await mono.commit('fix(lodash): guard against a null prototype')

    const res = await runMonosplice(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('monosplice/patches')

    expect((await refs(fork)).map((l) => l.split(' ')[1])).toEqual(['refs/heads/monosplice/patches'])
    expect(await firstParents(fork, 'refs/heads/monosplice/patches')).toEqual([
      'lodash: initial',
      'lodash: add chunk',
      'fix(lodash): guard against a null prototype',
    ])
  })
})

describe('S112: upstream advances while local patches exist', () => {
  it('sync rebuilds the fork branch on the new upstream head with force-with-lease', async () => {
    const {mono, up, fork, upstream, forkHead: oldForkHead} = await patched()

    await up.commit('lodash: upstream tweak', {'chunk.js': 'exports.chunk = 2\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])
    const newUpstreamHead = await up.git(['rev-parse', 'HEAD'])

    const res = await runMonosplice(mono.dir, ['sync'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/imported 1, exported \d+/)

    const forkHead = await fork.git(['rev-parse', 'refs/heads/main'])
    expect(forkHead).not.toBe(oldForkHead)

    // The old fork tip is gone from the branch: it was rebuilt, not appended to.
    await expect(
      fork.git(['merge-base', '--is-ancestor', oldForkHead, forkHead]),
    ).rejects.toThrow()

    const chain = await firstParents(fork, 'refs/heads/main')
    expect(chain.slice(0, 3)).toEqual(['lodash: initial', 'lodash: add chunk', 'lodash: upstream tweak'])
    expect(chain).toContain('fix(lodash): guard against a null prototype')
    expect(await fork.git(['rev-list', '--count', `${newUpstreamHead}..refs/heads/main`])).toBe(
      String(chain.length - 3),
    )
    // Upstream's own commit is the base of the fork branch, and nothing was lost.
    expect(await fork.git(['merge-base', '--is-ancestor', newUpstreamHead, forkHead])).toBe('')
    expect(await fork.treeSha(forkHead)).toBe(await mono.treeSha('HEAD', 'vendor/lodash'))
    expect(await fork.fileAt(forkHead, 'chunk.js')).toBe('exports.chunk = 2')
    expect(await fork.fileAt(forkHead, 'index.js')).toBe('module.exports = {patched: true}')
    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).toBe(newUpstreamHead)

    const settle = await runMonosplice(mono.dir, ['sync'])
    expect(settle.exitCode, settle.stderr).toBe(0)
    expect(settle.stdout).toContain('up to date')
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)
  })
})

describe('S113: no upstream configured — behavior is unchanged', () => {
  it('first push, external commit, pull and a plain non-force push still work', async () => {
    const {root, mono, pubDir} = await standardFixture()
    const pub = new TestRepo(pubDir)
    // A force push would be rejected outright, so anything that passes here is fast-forward.
    await pub.git(['config', 'receive.denyNonFastForwards', 'true'])

    const first = await runMonosplice(mono.dir, ['push', 'core', '--yes'])
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stdout).toContain(`✓ core: published core/ to ${pubDir} (main) — one baseline commit`)

    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('feat: external contribution', {'CONTRIB.md': 'thanks\n'}, EXT_AUTHOR)
    await ext.git(['push', 'origin', 'main'])

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toBe('✓ core: imported 1 commit(s)')

    await mono.commit('feat: local work', {'core/src/index.ts': 'export const hello = () => "hi"\n'})
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toBe('✓ core: exported 1 commit(s)')

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toBe('core: in sync')
    expect(status.stdout).not.toContain('awaiting')

    const json = JSON.parse((await runMonosplice(mono.dir, ['status', '--json'])).stdout) as {
      subrepos: Array<Record<string, unknown>>
    }
    expect(Object.keys(json.subrepos[0]!).sort()).toEqual([
      'ahead',
      'behind',
      'branch',
      'inSync',
      'name',
      'path',
      'pullInProgress',
      'remote',
      'seeded',
    ])

    // No fork machinery anywhere near a plain subrepo.
    await expect(mono.git(['rev-parse', '--verify', 'refs/monosplice/core/fork'])).rejects.toThrow()
    expect(await pub.treeSha('refs/heads/main')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S114: unreachable upstream vs unreachable fork', () => {
  it('blames the upstream URL when upstream is unreachable', async () => {
    const fx = await adopted()
    const missing = `${fx.root}/nope-upstream.git`
    writeConfig(fx.mono, [
      `    { name: 'lodash', path: 'vendor/lodash', remote: ${JSON.stringify(fx.forkDir)}, upstream: ${JSON.stringify(missing)} }`,
    ])

    for (const args of [['status'], ['pull'], ['push'], ['doctor']]) {
      const res = await runMonosplice(fx.mono.dir, args)
      const out = `${res.stdout}\n${res.stderr}`
      expect(res.exitCode, `${args[0]}: ${out}`).not.toBe(0)
      expect(out, args[0]).toContain('cannot reach upstream')
      expect(out, args[0]).toContain(missing)
      expect(out, args[0]).not.toContain('fork remote')
    }
  })

  it('blames the fork URL when only the fork is unreachable', async () => {
    const fx = await adopted()
    const missing = `${fx.root}/nope-fork.git`
    writeConfig(fx.mono, [
      `    { name: 'lodash', path: 'vendor/lodash', remote: ${JSON.stringify(missing)}, upstream: ${JSON.stringify(fx.upDir)} }`,
    ])

    // Pull only ever talks to upstream, so an unreachable fork cannot break it.
    await fx.up.commit('lodash: add map', {'map.js': 'exports.map = 1\n'}, UP_AUTHOR)
    await fx.up.git(['push', 'origin', 'main'])
    const pull = await runMonosplice(fx.mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toContain('imported 1 commit(s)')

    fx.mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
    await fx.mono.commit('fix(lodash): guard against a null prototype')

    const push = await runMonosplice(fx.mono.dir, ['push'])
    const pushOut = `${push.stdout}\n${push.stderr}`
    expect(push.exitCode).not.toBe(0)
    expect(pushOut).toContain('fork')
    expect(pushOut).toContain(missing)
    expect(pushOut).not.toContain('cannot reach upstream')

    const doctor = await runMonosplice(fx.mono.dir, ['doctor'])
    const doctorOut = `${doctor.stdout}\n${doctor.stderr}`
    expect(doctor.exitCode).not.toBe(0)
    expect(doctorOut).toContain('cannot reach fork remote')
    expect(doctorOut).toContain(missing)
    expect(doctorOut).not.toContain('cannot reach upstream')

    // status still answers, measured against upstream, and says which side it could not see.
    const status = await runMonosplice(fx.mono.dir, ['status'])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain('1 to push')
    expect(status.stdout).toContain('cannot reach fork')
  })
})

describe('S115: vendor --fork', () => {
  it('writes upstream + fork into the config, pulls upstream and pushes to the fork', async () => {
    const root = sandbox()
    const upDir = await makeBareRemote(root, 'lodash')
    const forkDir = await makeBareRemote(root, 'lodash-fork')
    const up = await makeRepo(root, 'lodash-src')
    await up.commit('lodash: initial', {'README.md': '# lodash\n', 'index.js': 'module.exports = {}\n'}, UP_AUTHOR)
    await up.commit('lodash: add chunk', {'chunk.js': 'exports.chunk = 1\n'}, UP_AUTHOR)
    await up.git(['remote', 'add', 'origin', upDir])
    await up.git(['push', 'origin', 'main'])

    const mono = await makeRepo(root, 'mono')
    writeConfig(mono, [])
    await mono.commit('chore: initial monorepo', {'app/main.ts': 'export const app = true\n'})

    const upstream = new TestRepo(upDir)
    const fork = new TestRepo(forkDir)
    const upstreamRefs = await refs(upstream)

    const res = await runMonosplice(mono.dir, ['vendor', upDir, '--fork', forkDir])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('✓ vendored lodash at vendor/lodash')
    expect(res.stdout).toContain(upDir)
    expect(res.stdout).toContain(forkDir)

    const config = mono.read('monosplice.config.ts')
    expect(config).toContain(`remote: '${forkDir}'`)
    expect(config).toContain(`upstream: '${upDir}'`)
    expect(config).not.toContain('pushBranch')

    // The vendored tree came from upstream, and the anchor commit names upstream.
    expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await upstream.treeSha('refs/heads/main'))
    const message = (await mono.messages()).at(-1)!
    expect(message).toContain(`Monosplice-Origin: ${await upstream.git(['rev-parse', 'refs/heads/main'])}`)
    expect(message).toContain(upDir)

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toContain('lodash: in sync')
    expect((await runMonosplice(mono.dir, ['pull'])).stdout).toContain('up to date')
    expect(await refs(fork)).toEqual([])

    mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
    await mono.commit('fix(lodash): guard against a null prototype')
    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toContain('exported 1 commit(s)')
    expect(await refs(upstream)).toEqual(upstreamRefs)
    expect(await fork.treeSha('refs/heads/main')).toBe(await mono.treeSha('HEAD', 'vendor/lodash'))
  })

  it('refuses to tag a subrepo that has an upstream', async () => {
    const {mono, forkDir} = await patched()
    const res = await runMonosplice(mono.dir, ['tag', 'lodash', 'v1.0.0'])
    expect(res.exitCode).not.toBe(0)
    const out = `${res.stdout}\n${res.stderr}`
    expect(out).toContain('upstream')
    expect(out).toContain(forkDir)
  })
})

describe('S116: the PR is merged upstream as a fast-forward', () => {
  it('pull is a no-op, push reports up to date and the fixed point holds', async () => {
    const {mono, up, fork, upstream, forkHead} = await patched()

    // The maintainer merges our fork branch: the exported commits land in upstream verbatim.
    await up.git(['fetch', fork.dir, 'main'])
    await up.git(['merge', '--ff-only', 'FETCH_HEAD'])
    await up.git(['push', 'origin', 'main'])
    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toContain('up to date')

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toContain('up to date')

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toContain('lodash: in sync')

    const sync = await runMonosplice(mono.dir, ['sync'])
    expect(sync.exitCode, sync.stderr).toBe(0)
    expect(sync.stdout).toContain('up to date')

    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)
    expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await upstream.treeSha('refs/heads/main'))
  })
})

describe('S117: the PR is squash-merged upstream', () => {
  it('imports the squash commit and then stays up to date on both sides', async () => {
    const {mono, up, fork, upstream, forkHead} = await patched()
    const monoCommitsBefore = (await mono.subjects()).length

    // A squash merge: one brand-new upstream commit with our tree and none of our trailers.
    await up.git(['fetch', fork.dir, 'main'])
    const tree = await up.git(['rev-parse', 'FETCH_HEAD^{tree}'])
    const squash = await up.git([
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      'Guard against a null prototype (#42)',
    ])
    await up.git(['reset', '--hard', squash])
    await up.git(['push', 'origin', 'main'])
    const upstreamHead = await upstream.git(['rev-parse', 'refs/heads/main'])
    expect(await up.git(['log', '-1', '--format=%B', 'HEAD'])).not.toContain('Monosplice-')

    const pull = await runMonosplice(mono.dir, ['pull'])
    expect(pull.exitCode, pull.stderr).toBe(0)
    expect(pull.stdout).toContain('imported 1 commit(s)')
    expect((await mono.subjects()).length).toBe(monoCommitsBefore + 1)
    expect((await mono.messages()).at(-1)).toContain(`Monosplice-Origin: ${upstreamHead}`)
    expect(await mono.treeSha('HEAD', 'vendor/lodash')).toBe(await upstream.treeSha('refs/heads/main'))

    const push = await runMonosplice(mono.dir, ['push'])
    expect(push.exitCode, push.stderr).toBe(0)
    expect(push.stdout).toContain('up to date')

    // Neither remote moved, and the whole thing is a fixed point.
    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).toBe(upstreamHead)
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)

    const sync = await runMonosplice(mono.dir, ['sync'])
    expect(sync.exitCode, sync.stderr).toBe(0)
    expect(sync.stdout).toContain('up to date')
    expect(await upstream.git(['rev-parse', 'refs/heads/main'])).toBe(upstreamHead)
    expect(await fork.git(['rev-parse', 'refs/heads/main'])).toBe(forkHead)

    const status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toContain('lodash: in sync')
  })
})

describe('S118: status and doctor with an upstream', () => {
  it('measures ahead/behind against upstream and reports both remotes', async () => {
    const {mono, up, upDir, forkDir} = await adopted()

    mono.write('vendor/lodash/index.js', 'module.exports = {patched: true}\n')
    await mono.commit('fix(lodash): guard against a null prototype')

    // Before the fork has them: a plain "to push".
    let status = await runMonosplice(mono.dir, ['status'])
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain('lodash: 1 to push')
    expect(status.stdout).not.toContain('awaiting')

    let json = JSON.parse((await runMonosplice(mono.dir, ['status', '--json'])).stdout) as {
      subrepos: Array<Record<string, unknown>>
    }
    expect(Object.keys(json.subrepos[0]!).sort()).toEqual([
      'ahead',
      'behind',
      'branch',
      'inSync',
      'name',
      'path',
      'pullInProgress',
      'remote',
      'seeded',
    ])
    expect(json.subrepos[0]).toMatchObject({ahead: 1, behind: 0, remote: forkDir})

    expect((await runMonosplice(mono.dir, ['push'])).exitCode).toBe(0)

    // Once the fork carries them, the count is waiting on the maintainer, not on us.
    status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toContain('1 to push (awaiting upstream merge)')

    await up.commit('lodash: add map', {'map.js': 'exports.map = 1\n'}, UP_AUTHOR)
    await up.git(['push', 'origin', 'main'])

    // Upstream moved, so the fork branch no longer matches what push would build: the note
    // drops and the honest report is "pull first, then I will rebuild your branch".
    status = await runMonosplice(mono.dir, ['status'])
    expect(status.stdout).toContain('lodash: 1 to push, 1 to pull')
    expect(status.stdout).not.toContain('awaiting')

    json = JSON.parse((await runMonosplice(mono.dir, ['status', '--json'])).stdout) as {
      subrepos: Array<Record<string, unknown>>
    }
    expect(json.subrepos[0]).toMatchObject({ahead: 1, behind: 1, inSync: false})

    const doctor = await runMonosplice(mono.dir, ['doctor'])
    expect(doctor.exitCode, doctor.stderr).toBe(0)
    expect(doctor.stdout).toContain(`upstream:`)
    expect(doctor.stdout).toContain(upDir)
    expect(doctor.stdout).toContain(forkDir)
    expect(doctor.stdout).toContain('fork head:')
    expect(doctor.stdout).toContain('to push: 1, to pull: 1')
    expect(doctor.stdout).toContain('✓ all checks passed')
  })
})
