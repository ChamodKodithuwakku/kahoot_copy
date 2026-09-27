// Student / phone page. Each tab signs in anonymously with sessionStorage
// persistence, so the Firebase UID is the player ID: it survives a refresh
// (same player, same score) but a new tab or phone is a new player.
import {
  initFirebase, ConfigError, ref, get, set, remove, onValue, onDisconnect, runTransaction, serverTimestamp,
} from "./fb.js";
import {
  $, h, showScreen, fmtPoints, rankPlayers, ordinal, confetti, watchConnection, showFatal, toast,
  LETTERS, SHAPES,
} from "./common.js";

const SS_PLAYER = "kq_player";
const LOW_TIME_MS = 10_000;

let fb;
let code = "";
let meta = null;
const live = { me: null, state: null, players: {}, scores: {}, myAnswer: undefined, reveal: null, result: null };
let subs = [];
let questionSubs = [];
let pendingChoice = null; // shown instantly while the answer write is in flight
let builtQuestion = null;

const g = (path = "") => ref(fb.db, `games/${code}${path ? "/" + path : ""}`);
const fmtCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

boot();

async function boot() {
  const params = new URLSearchParams(location.search);
  code = (params.get("game") || "").replace(/\D/g, "").slice(0, 6);
  if (!code) {
    try { code = JSON.parse(sessionStorage.getItem(SS_PLAYER))?.game || ""; } catch { /* ignore */ }
  }
  try {
    fb = await initFirebase("player");
  } catch (e) {
    return showFatal(e instanceof ConfigError ? e.message : `Could not connect: ${e.message}`);
  }
  watchConnection(fb);
  if (code.length === 6) enterGame();
  else showScreen("code");
}

// ───────────────────────── entering a game ─────────────────────────

$("#code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = $("#code-input").value.replace(/\D/g, "");
  if (c.length !== 6) {
    $("#code-error").textContent = "Game codes have 6 digits.";
    $("#code-error").hidden = false;
    return;
  }
  code = c;
  const url = new URL(location.href);
  url.searchParams.set("game", code);
  history.replaceState(null, "", url);
  enterGame();
});

async function enterGame() {
  showScreen("loading");
  try {
    const metaSnap = await get(g("meta"));
    if (!metaSnap.exists()) return message("🔍", "Game not found", `There's no game with code ${fmtCode(code)}. Check the code on the big screen.`, "Enter a different code", resetToCode);
    meta = metaSnap.val();

    // Refresh / rejoin: this tab's player ID is already in the game.
    const me = await get(g(`players/${fb.uid}`));
    if (me.exists()) return startPlaying(me.val());

    const state = (await get(g("state"))).val();
    if (state?.phase === "final") return message("🏁", "This game has ended", "Ask your teacher for the new game code.");
    const count = (await get(g("playerCount"))).val() || 0;
    if (count >= meta.maxPlayers) return gameFull();

    $("#name-code").textContent = fmtCode(code);
    showScreen("name");
    $("#name-input").focus();
  } catch (e) {
    showFatal(`Couldn't open the game: ${e.message}`);
  }
}

function resetToCode() {
  const url = new URL(location.href);
  url.searchParams.delete("game");
  history.replaceState(null, "", url);
  sessionStorage.removeItem(SS_PLAYER);
  code = "";
  $("#code-input").value = "";
  showScreen("code");
}

function gameFull() {
  message("🚫", "Game is full", `This game already has ${meta?.maxPlayers ?? 50} players. Ask your teacher for help.`);
}

function nameError(msg) {
  $("#name-error").textContent = msg;
  $("#name-error").hidden = false;
  $("#name-btn").disabled = false;
  $("#name-input").focus();
}

$("#name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#name-error").hidden = true;
  // eslint-disable-next-line no-control-regex
  const name = $("#name-input").value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return nameError("Please enter your name.");
  if (name.length > 20) return nameError("Please keep your name to 20 characters.");
  if (/[.#$[\]/]/.test(name)) return nameError("Names can't contain . # $ [ ] or /");
  const key = name.toLowerCase();
  $("#name-btn").disabled = true;

  // 1. Claim the name. Rules only allow this if nobody else holds it.
  try {
    const holder = (await get(g(`names/${key}`))).val();
    if (holder && holder !== fb.uid) return nameError("That name is already taken — try another.");
    if (!holder) await set(g(`names/${key}`), fb.uid);
  } catch {
    return nameError("That name is already taken — try another.");
  }

  // 2. Take one of the player slots (max 50) atomically.
  let tx;
  try {
    tx = await runTransaction(g("playerCount"), (n) => {
      n = n || 0;
      return n >= meta.maxPlayers ? undefined : n + 1;
    });
  } catch (err) {
    await remove(g(`names/${key}`)).catch(() => {});
    return nameError(`Couldn't join: ${err.message}`);
  }
  if (!tx.committed) {
    await remove(g(`names/${key}`)).catch(() => {});
    return gameFull();
  }

  // 3. Create the player.
  try {
    await set(g(`players/${fb.uid}`), { name, key, joinedAt: serverTimestamp() });
  } catch (err) {
    return nameError(`Couldn't join: ${err.message}`);
  }
  startPlaying({ name, key });
});

// ───────────────────────── playing ─────────────────────────

function startPlaying(me) {
  live.me = me;
  sessionStorage.setItem(SS_PLAYER, JSON.stringify({ game: code, uid: fb.uid, name: me.name }));
  $("#player-bar").hidden = false;
  $("#bar-name").textContent = me.name;
  $("#wait-name").textContent = me.name;
  showScreen("wait");

  // Presence: lets the host skip waiting for players who closed the page.
  subs.push(fb.onConnection((online) => {
    if (!online || !live.me) return;
    const r = g(`online/${fb.uid}`);
    onDisconnect(r).remove().then(() => set(r, true)).catch(() => {});
  }));
  subs.push(onValue(g(`players/${fb.uid}`), (s) => {
    if (s.exists()) { live.me = s.val(); rerender(); return; }
    if (!live.me) return;
    // Our player node vanished: either the host removed us, or deleted the whole game.
    get(g("meta")).then((m) => (m.exists() ? kicked() : stop("🏁", "The game has closed", "Thanks for playing!")))
      .catch(() => stop("🏁", "The game has closed", "Thanks for playing!"));
  }));
  subs.push(onValue(g("meta"), (s) => { if (!s.exists()) stop("🏁", "The game has closed", "Thanks for playing!"); }));
  subs.push(onValue(g("players"), (s) => { live.players = s.val() || {}; rerender(); }));
  subs.push(onValue(g("scores"), (s) => { live.scores = s.val() || {}; updateBar(); rerender(); }));
  subs.push(onValue(g("state"), (s) => { const prev = live.state; live.state = s.val(); onState(prev); }));
  setInterval(tick, 250);
}

function stop(icon, title, text) {
  subs.forEach((u) => u());
  questionSubs.forEach((u) => u());
  subs = [];
  questionSubs = [];
  live.me = null;
  sessionStorage.removeItem(SS_PLAYER);
  $("#player-bar").hidden = true;
  message(icon, title, text);
}

function kicked() {
  onDisconnect(g(`online/${fb.uid}`)).cancel().catch(() => {});
  stop("👋", "You were removed from the game", "The host removed your name. You can join again with a different name.");
  $("#msg-btn").hidden = false;
  $("#msg-btn").textContent = "Join again";
  $("#msg-btn").onclick = () => location.reload();
}

function message(icon, title, text, btnLabel, onBtn) {
  $("#msg-icon").textContent = icon;
  $("#msg-title").textContent = title;
  $("#msg-text").textContent = text;
  $("#msg-btn").hidden = !btnLabel;
  if (btnLabel) {
    $("#msg-btn").textContent = btnLabel;
    $("#msg-btn").onclick = onBtn;
  }
  showScreen("message");
}

function onState(prev) {
  const st = live.state;
  if (!st || !live.me) return;
  if (!prev || prev.qid !== st.qid) subscribeQuestion(st.qid);
  if (prev && prev.phase !== st.phase) {
    if (st.phase === "reveal" && navigator.vibrate) navigator.vibrate(120);
    if (st.phase === "final") confetti();
  }
  rerender();
}

function subscribeQuestion(qid) {
  questionSubs.forEach((u) => u());
  questionSubs = [];
  Object.assign(live, { myAnswer: undefined, reveal: null, result: null });
  pendingChoice = null;
  if (!qid) return;
  questionSubs.push(onValue(g(`answers/${qid}/${fb.uid}`), (s) => { live.myAnswer = s.val(); rerender(); }));
  questionSubs.push(onValue(g(`reveal/${qid}`), (s) => { live.reveal = s.val(); rerender(); }));
  questionSubs.push(onValue(g(`results/${qid}/${fb.uid}`), (s) => { live.result = s.val(); rerender(); }));
}

function rerender() {
  const st = live.state;
  if (!st || !live.me) return;
  switch (st.phase) {
    case "lobby": return showScreen("wait");
    case "question": return renderQuestion();
    case "reveal": return renderReveal();
    case "roundEnd": return renderRoundEnd();
    case "final": return renderFinal();
  }
}

function updateBar() {
  $("#bar-score").textContent = `${fmtPoints(live.scores[fb.uid]?.total)} pts`;
}

function myRank(field = "total") {
  const rows = rankPlayers(live.players, live.scores, field);
  const row = rows.find((r) => r.uid === fb.uid);
  return { rows, rank: row?.rank ?? rows.length, score: row?.score ?? 0 };
}

// ───────────────────────── question ─────────────────────────

function remainingMs() {
  const st = live.state;
  if (!st?.startAt) return st?.durationMs ?? 0;
  return st.startAt + st.durationMs - fb.serverNow();
}

const fmtClock = (ms) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function renderQuestion() {
  const st = live.state;
  const answered = live.myAnswer || (pendingChoice != null ? { choice: pendingChoice } : null);
  if (answered) {
    const c = answered.choice;
    $("#pa-choice").replaceChildren(h("div", { class: `opt opt-${c}` },
      h("span", { class: "opt-shape", "aria-hidden": "true", text: SHAPES[c] }),
      h("span", { class: "opt-letter", text: LETTERS[c] }),
      h("span", { class: "opt-text", text: st.options[c] })));
    showScreen("answered");
    tick();
    return;
  }
  if (remainingMs() <= 0) return showScreen("timeup");

  if (builtQuestion !== st.qid) {
    builtQuestion = st.qid;
    $("#pq-meta").textContent = `L${st.round} · Q${st.qIndex + 1}/${st.qCount}`;
    $("#pq-text").textContent = st.question;
    $("#pq-options").replaceChildren(...st.options.map((o, i) => h("button", {
      type: "button",
      class: `answer-btn opt-${i}`,
      onclick: () => submitAnswer(i),
    },
    h("span", { class: "opt-shape", "aria-hidden": "true", text: SHAPES[i] }),
    h("span", { class: "opt-letter", text: LETTERS[i] }),
    h("span", { class: "opt-text", text: o }))));
  }
  // Until we know whether this tab already answered (e.g. after a refresh), keep buttons locked.
  const ready = live.myAnswer !== undefined;
  document.querySelectorAll(".answer-btn").forEach((b) => { b.disabled = !ready; });
  showScreen("question");
  tick();
}

async function submitAnswer(choice) {
  const st = live.state;
  if (pendingChoice != null || live.myAnswer || st?.phase !== "question" || remainingMs() <= 0) return;
  pendingChoice = choice;
  document.querySelectorAll(".answer-btn").forEach((b) => { b.disabled = true; });
  if (navigator.vibrate) navigator.vibrate(30);
  rerender();
  try {
    // Rules: only our own answer, only once, only while this question is open.
    await set(g(`answers/${st.qid}/${fb.uid}`), { choice, at: serverTimestamp() });
  } catch {
    pendingChoice = null;
    builtQuestion = null;
    toast("Your answer wasn't accepted — time may be up.");
    rerender();
  }
}

function tick() {
  const st = live.state;
  if (st?.phase !== "question") return;
  const left = remainingMs();
  const clock = fmtClock(left);
  $("#pq-timer").textContent = clock;
  $("#pa-timer").textContent = clock;
  $("#pq-timer").classList.toggle("is-low", left <= LOW_TIME_MS);
  $("#pq-bar").style.width = `${Math.max(0, Math.min(1, left / st.durationMs)) * 100}%`;
  $("#pq-bar").classList.toggle("is-low", left <= LOW_TIME_MS);
  if (left <= 0 && !$("#question").hidden) rerender();
}

// ───────────────────────── reveal ─────────────────────────

function renderReveal() {
  const st = live.state;
  const rv = live.reveal;
  if (!rv) return showScreen("timeup");
  const res = live.result;
  // Joined after this question started (so never saw it): just wait for the next one.
  if (!res && live.myAnswer == null && live.me.joinedAt > st.startAt) return showScreen("wait");
  const choice = res?.choice ?? live.myAnswer?.choice ?? -1;
  const correct = res ? res.correct : choice === rv.correct;
  const kind = correct ? "good" : choice >= 0 ? "bad" : "none";

  $("#pr-banner").className = `result-banner is-${kind}`;
  $("#pr-icon").textContent = { good: "✓", bad: "✗", none: "⏱" }[kind];
  $("#pr-title").textContent = { good: "Correct!", bad: "Not quite", none: "No answer" }[kind];
  $("#pr-points").textContent = correct && res ? `+${fmtPoints(res.points)} points` : "+0 points";

  $("#pr-correct").replaceChildren(h("div", { class: `opt opt-${rv.correct} is-correct` },
    h("span", { class: "opt-shape", "aria-hidden": "true", text: SHAPES[rv.correct] }),
    h("span", { class: "opt-letter", text: LETTERS[rv.correct] }),
    h("span", { class: "opt-text", text: st.options[rv.correct] })));
  $("#pr-yours").hidden = kind !== "bad";
  if (kind === "bad") $("#pr-yours").textContent = `You chose ${LETTERS[choice]}: ${st.options[choice]}`;
  $("#pr-expl").textContent = rv.explanation;

  const { rows, rank, score } = myRank();
  $("#pr-standing").textContent = `Total ${fmtPoints(score)} pts · ${ordinal(rank)} of ${rows.length}`;
  showScreen("reveal");
}

// ───────────────────────── round end / final ─────────────────────────

function renderRoundEnd() {
  const st = live.state;
  const round = myRank(`r${st.round}`);
  const total = myRank();
  $("#pre-title").textContent = `Lecture ${st.round}: ${st.roundTitle}`;
  $("#pre-round").textContent = fmtPoints(round.score);
  $("#pre-round-rank").textContent = `${ordinal(round.rank)} of ${round.rows.length}`;
  $("#pre-total").textContent = fmtPoints(total.score);
  $("#pre-total-rank").textContent = `${ordinal(total.rank)} of ${total.rows.length}`;
  $("#pre-top").replaceChildren(...total.rows.slice(0, 5).map((r) => h("li", { class: r.uid === fb.uid ? "is-me" : "" },
    h("span", { class: "lb-rank", text: r.rank }),
    h("span", { class: "lb-name", text: r.name }),
    h("span", { class: "lb-score", text: fmtPoints(r.score) }))));
  showScreen("roundend");
}

function renderFinal() {
  const { rows, rank, score } = myRank();
  $("#pf-rank").textContent = ordinal(rank);
  $("#pf-of").textContent = `place out of ${rows.length} player${rows.length === 1 ? "" : "s"}`;
  $("#pf-points").textContent = `${fmtPoints(score)} points`;
  $("#pf-podium").replaceChildren(...rows.slice(0, 3).map((r) => h("div", { class: `mini-place${r.uid === fb.uid ? " is-me" : ""}` },
    h("span", { class: "medal", text: ["🥇", "🥈", "🥉"][r.rank - 1] || "🏅" }),
    h("span", { class: "lb-name", text: r.name }),
    h("span", { class: "lb-score", text: fmtPoints(r.score) }))));
  const played = Object.keys(live.state.played || {}).map(Number).sort((a, b) => a - b);
  const mine = live.scores[fb.uid] || {};
  $("#pf-rounds").replaceChildren(...(played.length
    ? played.map((n) => h("li", {}, h("span", { text: `Lecture ${n}` }), h("strong", { text: fmtPoints(mine[`r${n}`]) })))
    : [h("li", { class: "empty", text: "No rounds were played." })]));
  showScreen("final");
}
