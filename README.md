# Snore Timeline Ratings Tracker

Hourly App Store ratings dashboard for [Snore Timeline](https://snoretimeline.com): a GitHub Action fetches lifetime rating counts for all 175 storefronts and GitHub Pages serves the results. No server, no database.

**Dashboard**: https://mtuck063.github.io/snore-ratings-tracker/

## Keyword tracking

A second daily Action (`scripts/keywords.mjs`) tracks App Store search performance for the keywords in `scripts/keywords.json`, per market:

- **Rank**: the app's position in iTunes Search API results, the public proxy for App Store search.
- **Popularity**: a 5–100 demand score derived from Apple's search-hints (autocomplete) endpoint. The shorter the prefix at which a phrase surfaces in the suggestions and the higher its position, the more people search it. Ordinal, not calibrated; comparable day over day.
- **Discovery**: the suggestion lists under a few watch prefixes, so new terms Apple starts suggesting get logged as events.

Edit `scripts/keywords.json` to change tracked keywords or markets. History lives in `docs/data/keywords.json` and renders as the "Keyword rankings" dashboard section.
