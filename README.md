# monolith

> Work in your private monorepo. Publish parts of it as real open-source repos. Pull contributions back. No submodules.

Status: early development. See `docs/e2e-scenarios.md` for the test-driven roadmap.

## The idea

Your monorepo stays a completely normal git repo — subproject directories are just directories. `monolith` replays commits across the boundary between your monorepo and each subproject's public repo, in both directions, and never forgets which commits it has already moved.

```ts
// monolith.config.ts
import {defineConfig} from 'monolith-git'

export default defineConfig({
  subrepos: [
    {
      name: 'taka-core',
      path: 'taka-core',
      remote: 'git@github.com:jakequist/taka-core.git',
    },
  ],
})
```

```sh
monolith status   # per-subrepo: unexported / unimported commit counts
monolith push     # replay new monorepo commits out to public repos
monolith pull     # import external contributions into the monorepo
monolith sync     # pull, then push
```

MIT.
