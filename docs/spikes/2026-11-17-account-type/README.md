# Spike: JMAP account type via Experiment + JsAccount (throwaway)

Reference material only — not product code. Evidence for the design in
`docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`
(Appendix A).

- `addon/` — throwaway add-on: registers a `jmap` account type (JsAccount
  server + folder), protocol info, and a `jmap-message` message service;
  creates guarded/unguarded accounts, stores one message, checks restart
  survival, opens the message, writes JSON reports + screenshots.
- `run.sh <thunderbird-binary> <label>` — packages the add-on, makes a
  throwaway profile, runs headless Thunderbird three times.
- `both.sh` — runs `run.sh` against 160.0 and 153.7.0esr tarballs (expects
  them in `../tb-dl/<version>/thunderbird/`; paths are from the original
  scratch location and need adjusting).
- `fetch-probe/` — proves `fetch` + streaming bodies work in a privileged
  ES module loaded from the `.xpi`; `server/sse.py` is a local SSE server.
- `tb160-after-restart.png` — Thunderbird 160 after two restarts.
