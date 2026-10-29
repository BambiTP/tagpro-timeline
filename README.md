# TagPro timeline

Turns TagPro replay recordings into readable files and stats.

**Website:** https://bambitp.github.io/tagpro-timeline/. Drop in your own replays or pick one of the NALTP
games. It runs in your browser and nothing is uploaded.

## The three scripts

| Script | What it makes |
|---|---|
| `extract.js` | For each replay, `games/<name>/events.csv` (every grab, cap, pop, boost, pup, ...), `keypresses.csv` and `positions.csv` (every player about 4 times a second). Use `--single` to get one file per game instead. |
| `eu-stats.js` | `eu-stats.csv`: one row per player per game with the getStatsFromEU stats (the same columns and definitions as [getStatsFromEU](https://github.com/BambiTP/getStatsFromEU), worked out from the replay). |
| `new-stats.js` | `new-stats.csv`: advanced stats based on the ideas in [behindthehoop's tagpro-analytics](https://github.com/behindthehoop/tagpro-analytics): where returns happen, carries, pulls, threats, defense, grab types, snipes, pup fights, last stands, defensive states. |

In all the files, `seconds` is game time (0 is when play starts) and positions are in tiles from the
map's top-left corner. A player who leaves and rejoins counts as one player.

## Doing lots of replays quickly

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else needs installing.

1. Put your replays (`.ndjson` or `.ndjson.gz`, from the TagPro replay page) in a folder, for example `my-replays/`.
   Subfolders are fine.
2. Run whichever you want, giving it the folder:

   ```
   node extract.js my-replays                     # CSVs for every game, in games/
   node eu-stats.js my-replays --out eu.csv       # one stats file for all of them
   node new-stats.js my-replays --out new.csv
   ```

   A 10-minute game takes about half a second to extract and about a second for each stats script.
   That works out to roughly 1,000 games in 10–20 minutes, and the stats files can be opened in any spreadsheet.
3. For thousands of games, run `extract.js` on several cores at once. Each game gets its own folder, so the
   runs don't collide:

   ```
   find my-replays -name '*.ndjson*' -print0 | xargs -0 -n 50 -P 4 node extract.js
   ```

   The stats scripts write one file for everything, so run each of them once on the whole folder.

Yellow-flag (neutral flag) games are skipped by `new-stats.js`, since there's no red and blue base.

## Checks

- `extract.js` matches the server's own grab, cap and return totals for every player, and its event times
  are within 2 frames of tagpro.eu for the same games.
- `eu-stats.js` matches `fetch-ctf-stats.js` (tagpro.eu data) exactly in 86 of 98 columns on the NALTP
  sample games. The rest differ by hundredths of a second, because replay timestamps are a frame or two off.
