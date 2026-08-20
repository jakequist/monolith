import {describe, expect, it} from 'vitest'
import {runMonolith, sandbox} from './harness.js'

describe('update', () => {
  it('refuses to self-update when the CLI is running from a source checkout', async () => {
    const res = await runMonolith(sandbox(), ['update'])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/running .*from source/i)
    expect(res.stderr).toMatch(/git .*pull/)
    // The refusal must come before any registry lookup, so it works offline.
    expect(res.stderr).not.toMatch(/registry/i)
  })

  it('is listed in the top-level help alongside the other commands', async () => {
    const res = await runMonolith(sandbox(), ['--help'])
    expect(res.exitCode, res.stderr).toBe(0)
    const all = `${res.stdout}\n${res.stderr}`
    for (const cmd of ['init', 'seed', 'push', 'pull', 'sync', 'status', 'doctor', 'tag', 'update']) {
      expect(all, `help should list ${cmd}`).toMatch(new RegExp(`^\\s*${cmd}\\b`, 'm'))
    }
  })
})
