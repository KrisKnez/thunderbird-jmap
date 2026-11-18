# thunderbird-jmap

A Thunderbird add-on that adds a JMAP account type (Thunderbird 153 ESR to 160).
Design: `docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`.

## Roadmap

### Phase 1: read-only account (done)

- [x] Add a JMAP account from the account menu; the session URL is found
      from the address (`/.well-known/jmap` or a `_jmap._tcp` SRV record)
- [x] Mailboxes become folders, with their hierarchy and special folders
      (Inbox, Sent, Drafts, Trash, Junk, Archive)
- [x] Messages and bodies are stored locally, so offline reading and local
      search work
- [x] Kept up to date by polling and Get Messages; changes made by other
      apps show up in Thunderbird

### Phase 2: everyday use (done)

- [x] Sending through JMAP: the account gets its own outgoing server, never
      another account's SMTP; Send Later works; the server puts the sent
      copy in Sent
- [x] Identities come from the server
- [x] Read, flagged, tags and junk reach the server
- [x] Moving messages between folders of the account
- [x] Delete (to Trash), Delete in Trash, Shift+Delete, Empty Trash,
      retention and other automatic deletions
- [x] Drafts are saved on the server
- [x] Changes made while the server is unreachable are kept and sent when
      it is back, also after a restart
- [x] A change the server refuses is undone, with a notice saying why

### Phase 3: complete mail (next)

- [ ] Push: new mail shows up without waiting for the next poll
      (polling stays as the fallback)
- [ ] New-mail alerts and message filters
- [ ] Copying messages (today refused with a notice)
- [ ] Moving messages to and from other accounts (today moving out fails
      and the message stays where it is)
- [ ] Creating, renaming and deleting folders

### Phase 4: hardening

- [ ] Large mailboxes
- [ ] Network errors
- [ ] Disabling and removing the add-on cleanly
- [ ] Testing against Fastmail (needs a test account)

### Later

- [ ] Redirect
- [ ] Contacts (JMAP for Contacts)
- [ ] Calendars (JMAP for Calendars)
- [ ] OAuth sign-in
- [ ] Publishing on addons.thunderbird.net

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
