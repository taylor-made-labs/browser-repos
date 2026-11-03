# Contributing to browser-repos

## Git workflow

- `main` is the repository's birth branch and its protected, always-green trunk.
- **Never** force-push or rewrite `main`.
- All work after the seed happens on a **feature branch** and lands through a **pull
  request** that passes CI.

```bash
git checkout -b <type>/<short-topic>   # e.g. feat/git-core, chore/deps
# ...commit work...
git push -u origin <branch>
gh pr create                           # non-draft, so CI runs
```

Branch name prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `test/`.

## Verifying locally

The CI pipeline is `npm ci` → typecheck → lint → test → build. Run the same steps before
opening a PR:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The dev sandbox has no public network, so CI (GitHub Actions) is the source of truth for
"it builds and tests pass."

## Scope & boundaries

Read [`.kiro/steering/`](.kiro/steering/) before contributing. In short: the library core
stays **free of UI, LLM calls, and app logic**; it is **IndexedDB-only** and
**MV3-compatible** (bundled deps, no runtime CDN, no `eval`); and `.kiro/` is **tracked and
never gitignored**.

## Licensing

By contributing you agree your contribution is dual-licensed under **MIT OR Apache-2.0**,
matching the repository. See [NOTICE](NOTICE) for third-party attribution rules.
