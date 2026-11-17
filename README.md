# thunderbird-jmap

A Thunderbird add-on that adds a JMAP account type. Work in progress — see
`docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`.

## Development

Requires [mise](https://mise.jdx.dev) and Podman.

```sh
mise install          # pinned node + pnpm
mise run install      # workspace dependencies
mise run check        # type-check + tests (tests start throwaway Stalwart containers)
mise run stalwart:up  # dev JMAP server on http://127.0.0.1:18080 (admin / jmap-dev-password)
```

License: MPL-2.0.
