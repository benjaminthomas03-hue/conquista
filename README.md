# Conquista

An online territory-conquest strategy game for 2–6 friends. You divide a 42-territory world map, reinforce, roll dice to attack, and hold continents for bonus armies. Everyone plays in their browser through a shared link, and nothing needs to be installed.

## Features

- Live multiplayer for 2–6 players. Rooms use a 5-letter code and an invite link.
- **World domination** mode (conquer all 42 territories) or **Secret missions** mode (each player gets a hidden objective).
- Classic rules: reinforcements (territories ÷ 3, minimum 3, plus continent bonuses), card sets (4, 6, 8, 10, 12, 15, then +5 each time), +2 bonus armies for a traded territory you own, attacker rolls up to 3 dice and defender up to 2 with ties going to the defender, blitz attacks, one fortify move per turn, and taking an eliminated player's cards.
- Optional turn timer from 60 seconds to 5 minutes. When time runs out, remaining armies are placed automatically and the turn ends.
- Reconnection: refresh or lose Wi-Fi and you rejoin the same seat. The host can skip the turn of a player who has gone offline.
- Table chat and a running log of battles.
- Readable at a glance: troop badges in each owner's colour that grow with army size, red rings on your territories facing a bigger enemy stack, continents outlined in the holder's colour, a balance-of-power bar, and hovering a player highlights their territories.
- Live cursors: see where the other players are pointing, with the territory under their cursor outlined in their colour.
- Each continent has its own colour; troop badges show the owner's colour.
- Live animations for everyone: attack arrows, troop losses, captures, reinforcements and troop movements.
- A real world map built from Natural Earth country borders. Zoom with the scroll wheel or the +/− buttons, and drag to pan.

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

**Free-tier note:** Render puts free apps to sleep after about 15 minutes with no visitors. The first person to open the link waits around 30–60 seconds while it wakes up, and then it's fast. Games live in memory, so a game in progress is lost if the server sleeps or restarts. During a live session it stays awake.

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
server/game.js      Rules engine. Server-authoritative, so every move is validated here
server/missions.js  Secret mission definitions and win checks
server/index.js     Web server, rooms, Socket.IO events, turn timer
public/             Browser client (index.html, style.css, js/board.js, js/app.js)
test/               Bot players and automated full-game simulations (npm test)
```

To change rules, edit `server/game.js`. Connections between territories live in `shared/map.js`. Which real countries make up each territory, badge positions and label placement are set in `tools/build-map.js`; run `npm run build:map` after editing it. Map data: [Natural Earth](https://www.naturalearthdata.com) (public domain), via the `world-atlas` package.
