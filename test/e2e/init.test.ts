import {describe, expect, it} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {makeRepo, runMonolith, sandbox} from './harness.js'

describe('S01: init', () => {
  it('scaffolds monolith.config.ts and is a safe no-op when re-run', async () => {
    const root = sandbox()
    const mono = await makeRepo(root, 'mono')

    const first = await runMonolith(mono.dir, ['init'])
    expect(first.exitCode).toBe(0)
    expect(mono.exists('monolith.config.ts')).toBe(true)
    expect(mono.read('monolith.config.ts')).toContain('subrepos')

    const before = mono.read('monolith.config.ts')
    const second = await runMonolith(mono.dir, ['init'])
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toMatch(/already initialized/i)
    expect(mono.read('monolith.config.ts')).toBe(before)
  })

  it('refuses to init outside a git repository', async () => {
    const root = sandbox()
    const dir = path.join(root, 'not-a-repo')
    fs.mkdirSync(dir)

    const res = await runMonolith(dir, ['init'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/git repository/i)
    expect(fs.existsSync(path.join(dir, 'monolith.config.ts'))).toBe(false)
  })
})
