# Conquista

An online territory-conquest strategy game for 2–6 friends. You divide a 42-territory world map, reinforce, roll dice to attack, and hold continents for bonus armies. Everyone plays in their browser through a shared link, and nothing needs to be installed.

## Features

**Game modes and rules (chosen by the host in the lobby)**
- **Victory:** World domination (conquer all 42 territories), Secret missions (a hidden objective each), or **Capitals**, an optional mode where everyone secretly picks a capital and you win by holding every capital.
- **Starting territories:** a random deal, or a **draft** where players take turns claiming territories.
- **Card sets:** escalating values (4, 6, 8, 10, 12, 15, then +5 each time) or fixed values (infantry 4, cavalry 6, artillery 8, mixed 10).
- **Fog of war (optional):** you only see troop counts on your own territories and the ones next to them.
- Classic rules otherwise: reinforcements (territories ÷ 3, minimum 3, plus continent bonuses), +2 bonus armies for a traded territory you own, attacker rolls up to 3 dice and defender up to 2 with ties going to the defender, blitz attacks, one fortify move per turn, and taking an eliminated player's cards.
- **Undo** a placement before you finish reinforcing.
- Optional turn timer from 60 seconds to 5 minutes.

**Players**
- 2–6 seats, filled by friends or by **AI bots** on Easy, Normal or Hard. Hard bots chase continents, missions and capitals.
- **Spectators:** anyone who opens the link after the game has started (or clicks **Watch**) can follow along and chat.
- **Saved games:** with a database connected, games survive server restarts and you can finish another day. Your games are listed on the start screen with a **Resume** button.

**At the table**
- **Battle odds:** before you roll, see your chance to conquer with a blitz and the odds for the next single roll.
- **Diplomacy:** private messages, plus truce offers for 1–5 rounds. Truces can be broken, but the betrayal is announced to everyone and marked with 🗡 next to the betrayer's name.
- **Live cursors** for everyone, the territory under each cursor outlined, and **emoji reactions** you can drop on the map (click one, then click the map, or press 1–8 while pointing).
- **Sound effects** for dice, captures and betrayals, and **turn alerts**: a chime, plus a browser notification when it's your turn and the tab is in the background.
- **Army figures:** each territory shows a painted miniature in the owner's colour (infantry for 1–4 armies, a horseman for 5–9, a cannon for 10+) with the count on a plaque, on an aged-parchment map.
- **Readable at a glance:** continent-coloured land, troop badges in each owner's colour that grow with army size, red rings on your territories facing a bigger enemy stack, continents outlined in the holder's colour, and a balance-of-power bar. Hovering a player highlights their territories.
- **Animations** for attacks, losses, captures, reinforcements and troop movements.
- **End-of-game recap:** a chart of each player's armies over time, the biggest battle, luckiest and unluckiest dice, most conquests, broken truces, and a turn-by-turn **replay** of the whole game.
- A real world map built from Natural Earth borders, with zoom (scroll, pinch or +/−) and drag-to-pan.

## Play locally (try it first)

You need [Node.js 18+](https://nodejs.org).

```bash
npm install
npm start
```

Open http://localhost:3000. To try multiplayer on your own machine, open a second **private/incognito window** (each window is its own player).

## Put it online for free (Render)

1. Create a free GitHub account if you don't have one, make a new repository, and upload this folder. GitHub Desktop or "Add file → Upload files" both work, but **don't upload `node_modules`**.
2. Go to https://render.com, sign up with GitHub, and click **New → Blueprint**.
3. Pick your repository. Render reads `render.yaml` and sets everything up. Click **Apply**.
4. After a minute or two you get a URL like `https://conquista-xxxx.onrender.com`. That's your game. Send it to your friends.

**Free-tier note:** Render puts free apps to sleep after about 15 minutes with no visitors. The first person to open the link waits around 30–60 seconds while it wakes up, and then it's fast.

### Saved games (recommended)

Without a database, games live in memory and are lost if the server sleeps or restarts. To keep them:

1. Create a free project at [supabase.com](https://supabase.com), choosing a US West region (Render's free servers run in Oregon).
2. Click **Connect** → **Connection string** → **Session pooler**, copy the URI and put your database password into it.
3. In Render, open the service → **Environment** → add `DATABASE_URL` with that URI. Render redeploys, and the logs show `saved games enabled`.

The game creates its own table (`conquista_rooms`) and removes rooms that have been idle for 21 days.

Alternatives: the app runs anywhere that supports Node and WebSockets, such as Railway, Fly.io or a small VPS. The start command is `npm start`, and the server listens on the `PORT` environment variable.

## How to play

1. One person clicks **Create a game**, then **Copy invite link** and sends it. Friends open the link, type a name and click **Join**.
2. The host picks the victory mode and the timer, then clicks **Start game**.
3. **Deployment:** territories are dealt at random. Everyone places their remaining starting armies at the same time (use +1, +5 or All, then click your territories).
4. **On your turn:**
   - **Reinforce:** click your territories to place armies. If you hold 5 or more cards, you must trade a set first.
   - **Attack:** click one of your territories (2+ armies), then an enemy neighbour. **Roll** attacks once; **Blitz** keeps rolling until you win or run out. After a conquest, choose how many armies to move in.
   - **Fortify:** optionally move armies once between two of your territories connected through your own land. This ends your turn. Or click **End turn**.
5. Conquer at least one territory in a turn to earn a card. Sets are 3 alike, 3 different, or any 2 plus a wild.

Territory names appear when you zoom in, or click **Names** to always show them. To quit a game, click **Leave** at the top right; refreshing the page puts you back into the game you were in. Dashed lines on the map are sea routes. Alaska connects to Kamchatka across the edge of the map. Scroll or use +/− to zoom into crowded areas like Europe, drag to pan, and click **Fit** to see the whole world again.

## Project layout

```
shared/map.js       Territories, continents and adjacency (used by server and browser)
shared/map-geo.js   Generated real-world territory shapes (built by tools/build-map.js)
tools/build-map.js  Builds the map shapes by merging and splitting Natural Earth countries
tools/build-figures.js + tools/figures/  Renders the army figure sprites (three.js) into public/figures
server/game.js      Rules engine. Server-authoritative, so every move is validated here
server/missions.js  Secret mission definitions and win checks
server/index.js     Web server, rooms, Socket.IO events, turn timer, bot driver, diplomacy, spectators
server/ai.js        AI bots (Easy / Normal / Hard)
server/store.js     Saved games in Postgres (enabled by DATABASE_URL)
shared/odds.js      Exact battle odds (used by the odds preview, bots and luck stats)
public/             Browser client (index.html, style.css, js/app.js, js/board.js, js/recap.js, js/sound.js)
test/               Rule checks, full bot games across every option, end-to-end socket games (npm test),
                    and a saved-games test (DATABASE_URL=... node test/persist-test.js)
```

To change rules, edit `server/game.js`. Connections between territories live in `shared/map.js`. Which real countries make up each territory, badge positions and label placement are set in `tools/build-map.js`; run `npm run build:map` after editing it. Map data: [Natural Earth](https://www.naturalearthdata.com) (public domain), via the `world-atlas` package.
