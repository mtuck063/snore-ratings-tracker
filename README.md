# Snore Timeline Ratings Tracker

App Store ratings and keyword-rank dashboard for [Snore Timeline](https://snoretimeline.com): GitHub Actions collect the data, GitHub Pages serves it. No server, no database.

**Dashboard**: https://mtuck063.github.io/snore-ratings-tracker/

## Health

[![Collect ratings](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/collect.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/collect.yml)
[![Track keywords](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/keywords.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/keywords.yml)
[![Watchdog](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/watchdog.yml/badge.svg)](https://github.com/mtuck063/snore-ratings-tracker/actions/workflows/watchdog.yml)

Each badge shows that workflow's last run. The watchdog is the one that matters:
the collectors carry previous values forward rather than fail, so a run that
fetched nothing still passes. The watchdog checks that
[`status-ratings.json`](docs/data/status-ratings.json) and
[`status-keywords.json`](docs/data/status-keywords.json) are actually advancing —
ratings within 12 hours, keywords within 16 — and opens an issue if not. One
heartbeat file per collector, because a shared one gave the two workflows a
rebase conflict the first time they overlapped.

The dashboard shows the same thing, and says nothing at all while healthy: a
red "Collector stalled" appears in the header line only when a heartbeat has
gone quiet or fetches are failing.

Failures raise a GitHub issue rather than only an email, one open issue per
failure kind with repeat occurrences as comments. Closing the issue is how you
acknowledge it; the next failure opens a fresh one.

Known gap: the watchdog is itself a scheduled workflow, so it can't report
Actions being disabled for the repo. Nothing inside GitHub can.
