import {describe, expect, it} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {makeRepo, runMonosplice, sandbox} from './harness.js'

describe('S01: init', () => {
  it('scaffolds monosplice.config.ts and is a safe no-op when re-run', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')

    const first = await runMonosplice(mono.dir, ['init'])
    expect(first.exitCode).toBe(0)
    expect(mono.exists('monosplice.config.ts')).toBe(true)
    expect(mono.read('monosplice.config.ts')).toContain('subrepos')

    const before = mono.read('monosplice.config.ts')
    const second = await runMonosplice(mono.dir, ['init'])
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toMatch(/already initialized/i)
    expect(mono.read('monosplice.config.ts')).toBe(before)
  })

  it('refuses to init outside a git repository', async () => {
    const root = sandbox()
    const dir = path.join(root, 'not-a-repo')
    fs.mkdirSync(dir)

    const res = await runMonosplice(dir, ['init'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/git repository/i)
    expect(fs.existsSync(path.join(dir, 'monosplice.config.ts'))).toBe(false)
  })
})
