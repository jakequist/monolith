import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createJiti} from 'jiti'
import {z} from 'zod'
import {normalizeSubrepoPath} from './core/paths.js'

/** A file's content + mode, as seen by transform/scan hooks. Keyed by subrepo-relative path. */
export interface FileEntry {
  mode: string
  data: Buffer
}
export type FileMap = Map<string, FileEntry>

export interface ExportContext {
  /** Subrepo name from config. */
  subrepo: string
  /** The monorepo commit being exported. */
  monoSha: string
  /** Original (pre-rewrite) commit message. */
  message: string
}

export interface SubrepoConfig {
  /** Defaults to the last segment of `path`. */
  name?: string
  /** Directory inside the monorepo, relative to the config file (e.g. "taka-core"). */
  path: string
  /** Git URL of the public repo. */
  remote: string
  /** Branch to sync on both sides. Defaults to "main". */
  branch?: string
  /** Globs (relative to the subrepo dir) that must never be exported. */
  exclude?: string[]
  /** Rewrite an outgoing commit message (trailers are appended after this runs). */
  rewriteMessage?: (message: string, ctx: ExportContext) => string
  /** Mutate the outgoing tree. Return a new FileMap or mutate in place. */
  transform?: (files: FileMap, ctx: ExportContext) => FileMap | void | Promise<FileMap | void>
  /** Inspect the outgoing tree; throw to block the export of this commit. */
  scan?: (files: FileMap, ctx: ExportContext) => void | Promise<void>
}

export interface MonolithConfig {
  subrepos: SubrepoConfig[]
}

/** Identity helper that provides types in monolith.config.ts. */
export function defineConfig(config: MonolithConfig): MonolithConfig {
  return config
}

export interface ResolvedSubrepo {
  name: string
  path: string
  remote: string
  branch: string
  exclude: string[]
  rewriteMessage?: SubrepoConfig['rewriteMessage']
  transform?: SubrepoConfig['transform']
  scan?: SubrepoConfig['scan']
}

export interface Project {
  /** Directory containing monolith.config.* (treated as the monorepo root). */
  root: string
  configPath: string
  subrepos: ResolvedSubrepo[]
}

export const CONFIG_FILENAMES = ['monolith.config.ts', 'monolith.config.mts', 'monolith.config.js', 'monolith.config.mjs']

/** Walk up from startDir looking for a monolith config file. */
export function findConfig(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const subrepoSchema = z.object({
  name: z.string().min(1).optional(),
  path: z.string({required_error: 'path is required'}).min(1, 'path may not be empty'),
  remote: z.string({required_error: 'remote is required'}).min(1, 'remote may not be empty'),
  branch: z.string().min(1).optional(),
  exclude: z.array(z.string().min(1)).optional(),
  rewriteMessage: z.custom<SubrepoConfig['rewriteMessage']>((v) => v === undefined || typeof v === 'function', 'rewriteMessage must be a function').optional(),
  transform: z.custom<SubrepoConfig['transform']>((v) => v === undefined || typeof v === 'function', 'transform must be a function').optional(),
  scan: z.custom<SubrepoConfig['scan']>((v) => v === undefined || typeof v === 'function', 'scan must be a function').optional(),
})

const configSchema = z.object({
  subrepos: z.array(subrepoSchema, {required_error: 'subrepos is required'}),
})

export class ConfigError extends Error {
  constructor(configPath: string, detail: string) {
    super(`Invalid config at ${configPath}:\n${detail}`)
    this.name = 'ConfigError'
  }
}

/** Validate a raw config value (already loaded). Exported for unit tests. */
export function resolveConfig(raw: unknown, configPath: string): ResolvedSubrepo[] {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.length > 0 ? i.path.join('.') : '(root)'} — ${i.message}`)
      .join('\n')
    throw new ConfigError(configPath, detail)
  }
  const resolved: ResolvedSubrepo[] = parsed.data.subrepos.map((s, idx) => {
    let normPath: string
    try {
      normPath = normalizeSubrepoPath(s.path)
    } catch (err) {
      throw new ConfigError(configPath, `  subrepos.${idx}.path — ${(err as Error).message}`)
    }
    return {
      name: s.name ?? path.posix.basename(normPath),
      path: normPath,
      remote: s.remote,
      branch: s.branch ?? 'main',
      exclude: s.exclude ?? [],
      rewriteMessage: s.rewriteMessage,
      transform: s.transform,
      scan: s.scan,
    }
  })
  const seenNames = new Set<string>()
  const seenPaths = new Set<string>()
  for (const s of resolved) {
    if (seenNames.has(s.name)) throw new ConfigError(configPath, `  duplicate subrepo name: ${s.name}`)
    if (seenPaths.has(s.path)) throw new ConfigError(configPath, `  duplicate subrepo path: ${s.path}`)
    for (const other of seenPaths) {
      if (s.path.startsWith(`${other}/`) || other.startsWith(`${s.path}/`)) {
        throw new ConfigError(configPath, `  subrepo paths may not nest: ${other} vs ${s.path}`)
      }
    }
    seenNames.add(s.name)
    seenPaths.add(s.path)
  }
  return resolved
}

/** Load and validate the project config starting from `startDir` (cwd). */
export async function loadProject(startDir: string): Promise<Project | null> {
  const configPath = findConfig(startDir)
  if (!configPath) return null
  const jiti = createJiti(pathToFileURL(configPath).href, {interopDefault: true})
  let raw: unknown
  try {
    raw = await jiti.import(configPath, {default: true})
  } catch (err) {
    throw new ConfigError(configPath, `  failed to load: ${(err as Error).message}`)
  }
  return {
    root: path.dirname(configPath),
    configPath,
    subrepos: resolveConfig(raw, configPath),
  }
}
