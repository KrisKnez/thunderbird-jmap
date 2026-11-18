# thunderbird-jmap

A Thunderbird add-on that adds a JMAP account type (Thunderbird 153 ESR to 160).
Design: `docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`.

## What works

- **Setup:** add a JMAP account from the account menu; the session URL is
  found from the address (`/.well-known/jmap` or a `_jmap._tcp` SRV record).
- **Reading:** folders, messages and bodies, kept up to date by polling and
  Get Messages; changes made by other apps show up in Thunderbird.
- **Sending:** through JMAP (the account gets its own outgoing server,
  never another account's SMTP); Send Later works; the sent copy is put in
  Sent by the server. Identities come from the server.
- **Changes reach the server:** read, flagged, tags and junk; moving
  messages; Delete (to Trash), Delete in Trash, Shift+Delete, Empty Trash,
  retention and other automatic deletions; drafts. Changes made while the
  server is unreachable are kept and sent when it is back, also after a
  restart. If the server refuses a change, Thunderbird shows it as it is
  on the server and tells you why.
- **Not yet:** copying messages (refused with a notice), moving messages
  to another account (they are copied instead), creating, renaming or
  deleting folders, push, Redirect.

## Mailflare

[Mailflare](https://github.com/hieunc229/mailflare) works, with its limits:

- Use an API key as the password (its JMAP accepts only API keys).
- Each address is its own folder tree; moving a message between two
  addresses' trees is refused and undone.
- Only read and flagged are stored on the server; tags and junk stay in
  Thunderbird.
- New messages can only be created in Drafts, so saving a template is
  refused (it stays in Thunderbird only).
- Shift+Delete outside Trash lands in that address's Trash (its rule for
  deleting outside Trash); delete it there, or Empty Trash, to remove it.

## Development

Requires [mise](https://mise.jdx.dev) and Podman.

```sh
mise install          # pinned node + pnpm
mise run install      # workspace dependencies
mise run check        # type-check + tests (tests start throwaway Stalwart containers)
mise run tb:test      # headless Thunderbird tests on 153 ESR, 158 and 160
                      # (Stalwart, plus a local Mailflare built from a pinned commit)
mise run build        # dist/thunderbird-jmap.xpi
mise run stalwart:up  # dev JMAP server on http://127.0.0.1:18080 (admin / jmap-dev-password)
```

License: MPL-2.0.
