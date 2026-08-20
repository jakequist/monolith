import fs from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {TestRepo, cloneRemote, runMonolith, standardFixture, writeConfig} from './harness.js'

/** Seed the fixture and return a TestRepo view of the bare public remote. */
async function seeded(opts: {configExtra?: string} = {}): Promise<{
  root: string
  mono: TestRepo
  pubDir: string
  pub: TestRepo
}> {
  const {root, mono, pubDir} = await standardFixture(opts)
  const res = await runMonolith(mono.dir, ['seed', 'core'])
  expect(res.exitCode, res.stderr).toBe(0)
  return {root, mono, pubDir, pub: new TestRepo(pubDir)}
}

describe('S10: one new mono commit touching core', () => {
  it('creates one pub commit with the same message, author, subtree and a source trailer', async () => {
    const {mono, pub} = await seeded()
    const monoSha = await mono.commit(
      'feat: add greeter',
      {'core/src/greet.ts': 'export const greet = () => "hi"\n'},
      {authorName: 'Ada Lovelace', authorEmail: 'ada@example.test'},
    )

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/exported 1 commit/)

    const subjects = await pub.subjects()
    expect(subjects).toHaveLength(2)
    expect(subjects[1]).toBe('feat: add greeter')

    const authors = await pub.authors()
    expect(authors[1]).toBe('Ada Lovelace <ada@example.test>')

    const messages = await pub.messages()
    expect(messages[1]).toContain(`Monolith-Source: ${monoSha}`)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S11: commits touching only private dirs', () => {
  it('exports nothing', async () => {
    const {mono, pub} = await seeded()
    const before = await pub.head()
    await mono.commit('chore: website copy', {'website/index.html': '<p>hi</p>\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(before)
  })
})

describe('S12: commit spanning core and private dirs', () => {
  it('exports only the core subtree and never ships private blobs', async () => {
    const {mono, pub} = await seeded()
    const privateContent = 'super private payload 4f2a\n'
    await mono.commit('feat: cross-cutting change', {
      'core/src/shared.ts': 'export const shared = true\n',
      'private/plan.md': privateContent,
    })

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)

    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).toContain('src/shared.ts')
    expect(paths.some((p) => p?.includes('plan.md'))).toBe(false)

    const privateBlob = await mono.git(['hash-object', '--stdin'], {input: privateContent})
    // sanity: the blob really is in the monorepo
    await mono.git(['cat-file', '-e', privateBlob])
    await expect(pub.git(['cat-file', '-e', privateBlob])).rejects.toThrow()
  })
})

describe('S13: multiple pending commits', () => {
  it('exports in monorepo order', async () => {
    const {mono, pub} = await seeded()
    await mono.commit('feat: one', {'core/one.txt': '1\n'})
    await mono.commit('chore: private churn', {'private/x.md': 'x\n'})
    await mono.commit('feat: two', {'core/two.txt': '2\n'})
    await mono.commit('feat: three', {'core/three.txt': '3\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/exported 3 commit/)

    expect(await pub.subjects()).toEqual(['Initial import of core', 'feat: one', 'feat: two', 'feat: three'])
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S14: push twice', () => {
  it('is a no-op the second time', async () => {
    const {mono, pub} = await seeded()
    await mono.commit('feat: one', {'core/one.txt': '1\n'})

    const first = await runMonolith(mono.dir, ['push'])
    expect(first.exitCode, first.stderr).toBe(0)
    const head = await pub.head()
    const count = (await pub.subjects()).length

    const second = await runMonolith(mono.dir, ['push'])
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(head)
    expect((await pub.subjects()).length).toBe(count)
  })
})

describe('S15: excluded files on push', () => {
  it('skips commits that only touch excluded files and never exports them', async () => {
    const {mono, pub} = await seeded({configExtra: `exclude: ['INTERNAL.md']`})
    const before = await pub.head()

    await mono.commit('chore: internal notes', {'core/INTERNAL.md': 'v1\n'})
    const onlyExcluded = await runMonolith(mono.dir, ['push'])
    expect(onlyExcluded.exitCode, onlyExcluded.stderr).toBe(0)
    expect(onlyExcluded.stdout).toMatch(/up to date/)
    expect(await pub.head()).toBe(before)

    await mono.commit('chore: update internal notes', {'core/INTERNAL.md': 'v2\n'})
    const stillExcluded = await runMonolith(mono.dir, ['push'])
    expect(stillExcluded.exitCode, stillExcluded.stderr).toBe(0)
    expect(await pub.head()).toBe(before)

    await mono.commit('feat: real change', {'core/INTERNAL.md': 'v3\n', 'core/real.txt': 'real\n'})
    const mixed = await runMonolith(mono.dir, ['push'])
    expect(mixed.exitCode, mixed.stderr).toBe(0)
    expect(mixed.stdout).toMatch(/exported 1 commit/)
    expect(await pub.subjects()).toEqual(['Initial import of core', 'feat: real change'])
    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).toContain('real.txt')
    expect(paths).not.toContain('INTERNAL.md')
  })
})

describe('S16: rewriteMessage hook', () => {
  it('applies the hook to exported commit messages', async () => {
    const {mono, pub} = await seeded({
      configExtra: `rewriteMessage: (message) => message.replace(/\\n[\\s\\S]*$/, '') + ' [oss]'`,
    })
    await mono.commit('feat: hooked', {'core/hooked.txt': 'yes\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)

    const subjects = await pub.subjects()
    expect(subjects[subjects.length - 1]).toBe('feat: hooked [oss]')
    const messages = await pub.messages()
    expect(messages[messages.length - 1]).toContain('Monolith-Source: ')
  })
})

describe('S17: commits carrying Monolith-Origin', () => {
  it('are skipped on push (no ping-pong duplicates)', async () => {
    const {root, mono, pubDir, pub} = await seeded()

    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('external: add EXTERNAL.md', {'EXTERNAL.md': 'from outside\n'})
    const externalPubSha = await ext.head()
    await ext.git(['push', 'origin', 'main'])

    // hand-craft the monorepo side of an import
    await mono.commit(`external: add EXTERNAL.md\n\nMonolith-Origin: ${externalPubSha}`, {
      'core/EXTERNAL.md': 'from outside\n',
    })
    await mono.commit('feat: local work', {'core/local.txt': 'local\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/exported 1 commit/)

    const subjects = await pub.subjects()
    expect(subjects).toEqual(['Initial import of core', 'external: add EXTERNAL.md', 'feat: local work'])
    expect(subjects.filter((s) => s === 'external: add EXTERNAL.md')).toHaveLength(1)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S18: binary files, renames and deletions', () => {
  it('replay with exact tree fidelity', async () => {
    const {mono, pub} = await seeded()

    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f, 0x00, 0xc3, 0x28])
    await mono.commit('feat: add binary asset', {'core/assets/logo.bin': binary})
    let res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))

    await mono.git(['mv', 'core/README.md', 'core/DOCS.md'])
    await mono.commit('refactor: rename readme')
    res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))

    await mono.commit('chore: drop index', {'core/src/index.ts': null})
    res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))

    const paths = (await pub.treeEntries('HEAD')).map((e) => e.split(' ')[2])
    expect(paths).toContain('DOCS.md')
    expect(paths).toContain('assets/logo.bin')
    expect(paths).not.toContain('src/index.ts')
  })
})

describe('S19: executable bit and symlinks', () => {
  it('are preserved in exported trees', async () => {
    const {mono, pub} = await seeded()

    mono.write('core/bin/tool.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(mono.dir, 'core/bin/tool.sh'), 0o755)
    fs.symlinkSync('bin/tool.sh', path.join(mono.dir, 'core/tool-link'))
    await mono.commit('feat: tool and link')

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)

    const entries = await pub.treeEntries('HEAD')
    expect(entries.some((e) => e.startsWith('100755 ') && e.endsWith('bin/tool.sh'))).toBe(true)
    expect(entries.some((e) => e.startsWith('120000 ') && e.endsWith('tool-link'))).toBe(true)
    expect(await pub.treeSha('HEAD')).toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S20: unimported external commit in pub', () => {
  it('refuses to push and tells the user to pull first', async () => {
    const {root, mono, pubDir, pub} = await seeded()

    const ext = await cloneRemote(root, pubDir, 'ext')
    await ext.commit('external: drive-by fix', {'EXTERNAL.md': 'from outside\n'})
    await ext.git(['push', 'origin', 'main'])
    const pubHeadBefore = await pub.head()

    await mono.commit('feat: local work', {'core/local.txt': 'local\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/pull/i)
    expect(res.stderr).toMatch(/1/)
    expect(await pub.head()).toBe(pubHeadBefore)
    expect(await pub.subjects()).toEqual(['Initial import of core', 'external: drive-by fix'])
  })
})

describe('S21: scan hook rejects a commit', () => {
  it('aborts before any ref update on pub and names the offending commit and file', async () => {
    const {mono, pub} = await seeded({
      configExtra: `scan: (files, ctx) => {
        for (const [p, f] of files) {
          if (f.data.toString('utf8').includes('SECRET')) {
            throw new Error('possible secret in ' + p)
          }
        }
      }`,
    })
    const before = await pub.head()

    await mono.commit('feat: safe change', {'core/safe.txt': 'fine\n'})
    const leak = await mono.commit('feat: oops', {'core/config.ts': 'export const token = "SECRET-abc"\n'})
    await mono.commit('feat: after the leak', {'core/after.txt': 'later\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain('possible secret in config.ts')
    expect(res.stderr).toContain(leak)

    // nothing partial: not even the safe commit preceding the leak was pushed
    expect(await pub.head()).toBe(before)
    expect(await pub.subjects()).toEqual(['Initial import of core'])
  })
})

describe('S22: transform hook', () => {
  it('mutates the exported tree without affecting the monorepo', async () => {
    const {mono, pub} = await seeded({
      configExtra: `transform: (files) => {
        const readme = files.get('README.md')
        if (readme) {
          files.set('README.md', {
            mode: readme.mode,
            data: Buffer.from('<!-- published by monolith -->\\n' + readme.data.toString('utf8')),
          })
        }
      }`,
    })
    await mono.commit('docs: update readme', {'core/README.md': '# core\n\ninternal wording\n'})

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toMatch(/exported 1 commit/)

    expect(await pub.fileAt('HEAD', 'README.md')).toBe('<!-- published by monolith -->\n# core\n\ninternal wording')
    expect(mono.read('core/README.md')).toBe('# core\n\ninternal wording\n')
    expect(await mono.fileAt('HEAD', 'core/README.md')).toBe('# core\n\ninternal wording')
    expect(await pub.treeSha('HEAD')).not.toBe(await mono.treeSha('HEAD', 'core'))
  })
})

describe('S82: unreachable remote', () => {
  it('surfaces the git error cleanly', async () => {
    const {root, mono} = await seeded()
    writeConfig(mono, [`    { name: 'core', path: 'core', remote: ${JSON.stringify(path.join(root, 'nope.git'))} }`])

    const res = await runMonolith(mono.dir, ['push'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/nope\.git/)
  })
})
