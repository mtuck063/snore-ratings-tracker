# Snore Timeline Ratings Tracker

Hourly App Store ratings dashboard for [Snore Timeline](https://snoretimeline.com): a GitHub Action fetches lifetime rating counts for all 175 storefronts and GitHub Pages serves the results. No server, no database.

**Dashboard**: https://mtuck063.github.io/snore-ratings-tracker/

## Keyword tracking

A second Action (`scripts/keywords.mjs`, four runs a day) tracks App Store search performance for the keywords in `scripts/keywords.json`, per market. Ranks jitter a few positions between runs, so each day's history row keeps a running average plus the min–max range:

- **Rank**: the app's position in iTunes Search API results, the public proxy for App Store search.
- **Popularity**: a 5–100 demand score derived from Apple's search-hints (autocomplete) endpoint. The shorter the prefix at which a phrase surfaces in the suggestions and the higher its position, the more people search it. Ordinal, not calibrated; comparable day over day.
- **Discovery**: the suggestion lists under a few watch prefixes. A new suggestion containing one of the market's seed tokens is auto-added to the tracked list (capped at 5 per market per run) and measured from the next run; anything else is just logged as an event.

Edit `scripts/keywords.json` to change tracked keywords, watch prefixes, seed tokens, or markets. History lives in `docs/data/keywords.json` and renders as the "Keyword rankings" dashboard section.
