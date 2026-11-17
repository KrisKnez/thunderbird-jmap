# thunderbird-jmap

Thunderbird add-on that adds a JMAP account type (Experiment + JsAccount).
Design: `docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`.
Plans: `docs/superpowers/plans/`. Spike evidence: `docs/spikes/`.

## Versioning — required before every commit

- One `major.minor.patch` version for the whole repo, in the root `package.json`.
- Before **every** commit, bump it according to the commit's Conventional
  Commit type, and include the bumped files in that same commit:
  - breaking change (`type!:` or a `BREAKING CHANGE:` footer) → `major`
  - `feat` → `minor`
  - anything else (`fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `build`, `ci`) → `patch`
- Bump with `node scripts/bump-version.mjs <major|minor|patch>`; it copies the
  version into every workspace `package.json` and `apps/*/manifest.json`.

## Commits

- Conventional Commits (`feat(scope): …`, `fix: …`, `docs: …`).
- Work on a feature branch, not `main`.
