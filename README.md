# Classroom Quiz

A real-time, Kahoot-style multiplayer quiz for the classroom. The teacher shows `host.html` on the projector. Students scan a QR code and play on their phones. Each of the 6 lectures is one round of 10 questions.

- Plain HTML, CSS and vanilla JavaScript. No framework and no build step.
- Firebase Realtime Database (free Spark plan) for live sync, with Firebase Anonymous Auth so the database rules can tell players apart.
- Deploys to Vercel as a static site.

```
host.html               Projector screen (PIN protected)
join.html               Student page (index.html redirects here)
css/styles.css          All styling (colours are CSS variables at the top)
js/firebase-config.js   ← the only file you need to edit
js/fb.js                Firebase bootstrap
js/host.js              Host logic: timer, reveal, scoring
js/join.js              Student logic
js/common.js            Shared helpers, sounds, confetti
data/questions.json     60 questions (6 rounds × 10)
database.rules.json     Realtime Database security rules
firebase.json           Used by the Firebase CLI / local emulator
```

---

## 1. Firebase setup (free Spark plan)

1. **Create a project.** Go to <https://console.firebase.google.com>, click **Create a project**, give it a name (e.g. `classroom-quiz`) and click **Create**. Google Analytics is not needed. New projects start on the free Spark plan.
2. **Register a web app.** On the project overview, click the **Web** icon (`</>`), enter a nickname, and click **Register app**. You don't need Firebase Hosting. Firebase then shows a `firebaseConfig` object. Copy its values into `js/firebase-config.js`.
3. **Turn on Anonymous sign-in.** Go to **Build → Authentication → Get started → Sign-in method → Anonymous**, then click **Enable** and **Save**.
   Every phone signs in anonymously, and that anonymous ID is the player ID. The rules rely on it.
4. **Create the Realtime Database.** Go to **Build → Realtime Database → Create Database**, pick a location close to you (for Sri Lanka, `asia-southeast1` in Singapore), choose **Start in locked mode**, and click **Enable**.
   Copy the database URL shown at the top of the Data tab into `databaseURL` in `js/firebase-config.js`. Outside the US it looks like `https://<project>-default-rtdb.asia-southeast1.firebasedatabase.app`, not `…firebaseio.com`.
5. **Publish the security rules.** Open the **Rules** tab, replace everything with the contents of [`database.rules.json`](database.rules.json), and click **Publish**.
   *(CLI alternative: `npx firebase-tools login`, then `npx firebase-tools deploy --only database --project <your-project-id>`.)*
6. **Set your host PIN** in `js/firebase-config.js` (`HOST_PIN`).
7. **Authorized domain (recommended).** After deploying, add your Vercel domain (e.g. `my-quiz.vercel.app`) under **Authentication → Settings → Authorized domains**.

Your `js/firebase-config.js` should end up looking like this:

```js
export const firebaseConfig = {
  apiKey: "AIza…",
  authDomain: "classroom-quiz.firebaseapp.com",
  databaseURL: "https://classroom-quiz-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "classroom-quiz",
  storageBucket: "classroom-quiz.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123",
};
export const HOST_PIN = "choose-a-pin";
```

> The Firebase `apiKey` is not a secret; every Firebase web app ships it to the browser. Access is controlled by the database rules.

### What the database rules enforce

| Who | Can | Cannot |
|---|---|---|
| Host (the anonymous account that created the game) | Everything inside its own game | Touch other games |
| Student | Claim a free name, take one of the 50 slots (+1 only), create **their own** player record once, write **their own** answer **once** while the current question is open (server-timestamped), set their own online flag | Answer for someone else, change an answer, answer a question that isn't live or after time is up, fake the answer time, write scores/results/reveal/state, rename themselves, read other players' answers, list games |

`correct` and `explanation` are never in the question data sent to phones. The host writes them to `games/<code>/reveal/<questionId>` in the same atomic update that ends the question.

---

## 2. Local testing

### Against your real Firebase project

```bash
npx serve .
```

- Host: <http://localhost:3000/host.html>
- Players: open <http://localhost:3000/join.html?game=CODE> in **new tabs** (Ctrl+T). Each tab is a separate player.
  Don't use "Duplicate tab": it copies the tab's session, so you'd get the same player twice.
- Phones on the same Wi-Fi: open the host page using your computer's LAN address, e.g. `http://192.168.1.20:3000/host.html`. The QR code uses whatever address the host page was opened with, and phones can't reach `localhost`.

### Fully offline with the Firebase Emulator (no Firebase project needed)

This needs Java 11 or newer. Run these in two terminals:

```bash
npx firebase-tools emulators:start --only auth,database --project demo-kahoot
```

```bash
npx serve .
```

Then open <http://localhost:3000/host.html?emulator=1>. The QR code and join links carry `emulator=1` automatically.
In emulator mode you can shorten the timer for quick tests: `host.html?emulator=1&seconds=20`. Emulator mode only switches on for `localhost`.

---

## 3. Deploy to Vercel

The project is a plain static site. `.vercelignore` keeps the ~600 MB lecture decks out of the upload.

**Option A: Vercel CLI**

```bash
npx vercel
```

Answer the prompts: link to a new project, framework **Other**, no build command, output directory `.`. Then publish to production:

```bash
npx vercel --prod
```

**Option B: GitHub.** Push this folder to a GitHub repo, then at <https://vercel.com/new> import it. Use Framework Preset **Other** and leave the build command empty. Click **Deploy**.

Open `https://<your-app>.vercel.app/host.html` on the classroom computer.

---

## 4. Running a game

1. Open `host.html` on the projector and enter the PIN, then click **Create new game**.
2. Students scan the QR code, or go to `/join.html` and type the 6-digit code, then enter their name. The lobby shows `joined / 50`. Click a name to remove a player. The 51st player sees **Game is full**, and duplicate names are rejected (ignoring upper/lower case).
3. Choose **All 6 rounds in order** or a single lecture, then click **Start**.
4. Each question has a 2-minute countdown synced to Firebase server time. It ends when time runs out, when every connected player has answered, or when you click **Skip timer / Reveal now**.
5. The reveal shows the correct answer in green with its explanation, how many chose A/B/C/D, who got it right (fastest first) and the top 10. Each phone shows correct/wrong, points earned, and total and rank.
6. After 10 questions you get the round leaderboard and the overall leaderboard. Pick the next round, or end the game.
7. At the end: a podium for the top 3, the full scoreboard, and **Export CSV** (rank, name, score per round, total). Each phone shows its final rank.

**Scoring:** a correct answer earns 500 points plus a speed bonus of up to 500 (answering instantly = 1000, answering at the last second ≈ 500). Wrong answers and no answer earn 0. Speed is measured with Firebase server timestamps, so phone clocks don't matter.

**Keep `host.html` open.** The host page runs the timer and the scoring. If it's closed or refreshed, open `host.html` again and click **Resume game**. Students who refresh their phone return as the same player with the same score.

---

## 5. Notes and limitations

- **The host PIN is a simple gate, not strong security.** It lives in `js/firebase-config.js`, which anyone can download. What actually protects the game is the database rules: only the browser that created a game can control it.
- **`data/questions.json` is public once deployed.** Phones never receive the correct answer before the reveal, but a student who guesses the URL could open the file directly. To close that gap, add `data/questions.json` to `.vercelignore`. `host.html` will then ask you to choose the questions file from your laptop each time it opens.
- **"Everyone answered"** counts players whose phones are currently connected, so a student who closes the page doesn't hold up the question.
- **Free Spark plan limits** (100 simultaneous connections, 1 GB stored, 10 GB/month downloaded) are plenty for 50 students.
- **Cleaning up:** game data stays in the database until you click **Delete this game's data** on the final screen, or delete the `games` node in the Firebase console. Export the CSV first.

## 6. Customising

- **Questions:** edit `data/questions.json`. Each question is `{ "id", "question", "options": [4 strings], "correct": 0-3, "explanation" }`. Question IDs must be unique.
- **Settings:** `GAME` in `js/firebase-config.js` sets max players, seconds per question and points.
- **Colours:** CSS variables at the top of `css/styles.css`. `--opt-0` to `--opt-3` are the four answer colours; green is reserved for "correct".
