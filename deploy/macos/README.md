# macOS-only

Everything in this folder runs on macOS and nowhere else. That is architecture rather than
accident: ADR 0006 puts the service on one always-on machine behind one tailnet hostname, and
these are that machine's deployment.

What makes each one macOS-bound:

| file | why |
|---|---|
| `optionality-api.launchd.plist.template` | launchd, `~/Library/LaunchAgents` |
| `optionality-ui.launchd.plist.template` | the same |
| `optionality-backup.launchd.plist.template` | the same |
| `optionality-opend.launchd.plist.template` | the same, plus `StartInterval` rather than a cron |
| `opend.sh` | zsh (`${0:A:h}`), BSD `lsof` and `pgrep -f`, and OpenD at a macOS app path |

`deploy/Caddyfile` deliberately stayed OUTSIDE this folder: it is Caddy configuration with no
macOS paths in it, and it would work unchanged anywhere Caddy runs. The split is the point — it
says which part of the deployment is bound to this operating system and which part is not.

A third of the `Makefile` belongs to the same constraint (`launchctl`, `plutil`,
`~/Library/LaunchAgents`); it is not moved because a Makefile is one file and splitting it would
cost more than it explains.

## The two copies of `opend.sh`

`opend.sh` here is committed and is the copy the launchd agent runs. `~/openD.sh` is the owner's
and must keep working with **no repository cloned at all**, which is why it is a copy rather than
a symlink — a symlink into an uncloned repo is a dead link.

They are byte-identical apart from one line: the account. This copy has none and refuses to start
without `OPEND_LOGIN_ACCOUNT`; `~/openD.sh` keeps a literal default so it runs with nothing
configured. `make check-opend` fails when they otherwise differ and is part of `make check`;
`make opend-sync` copies this one over the other, keeping its account line.
