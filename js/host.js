// Host / projector screen. The host page drives the game: it starts questions,
// runs the countdown, and at reveal time is the only place that writes the
// correct answer, explanation and scores into Firebase.
import { HOST_PIN, GAME } from "./firebase-config.js";
import {
  initFirebase, ConfigError, ref, get, set, update, remove, onValue, serverTimestamp, increment,
} from "./fb.js";
import {
  $, h, showScreen, fmtPoints, fmtSeconds, rankPlayers, Sound, confetti, watchConnection, showFatal, toast,
  LETTERS, SHAPES,
} from "./common.js";

const LS_GAME = "kq_host_game";
const SS_PIN = "kq_host_unlocked";
const LOW_TIME_MS = 10_000;
const RING = 2 * Math.PI * 44; // circumference of the timer ring (r=44)

let fb;        // Firebase handle from initFirebase()
let bank;      // contents of data/questions.json
let code = null;
const live = { meta: null, state: null, players: {}, online: {}, scores: {}, answers: {}, reveal: null, results: {} };
let gameSubs = [];
let questionSubs = [];
let pickerChoice = "all";
let revealing = false;
let revealRetryAt = 0;
let autoRevealTimer = null;
let lastTickSecond = null;
let seenPlayers = new Set();
let playersLoaded = false;

const g = (path = "") => ref(fb.db, `games/${code}${path ? "/" + path : ""}`);
const roundOf = (n) => bank.rounds.find((r) => r.round === n);
const fmtCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

// ───────────────────────── boot ─────────────────────────

$("#mute-btn").addEventListener("click", () => {
  Sound.muted = !Sound.muted;
  $("#mute-btn").textContent = Sound.muted ? "🔇" : "🔊";
  $("#mute-btn").setAttribute("aria-pressed", String(Sound.muted));
});
document.addEventListener("pointerdown", () => Sound.unlock());

$("#pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("#pin-input").value.trim() === String(HOST_PIN)) {
    sessionStorage.setItem(SS_PIN, "1");
    afterPin();
  } else {
    $("#pin-error").hidden = false;
    $("#pin-input").select();
  }
});

if (sessionStorage.getItem(SS_PIN) === "1") afterPin();
else showScreen("pin");

async function afterPin() {
  showScreen("boot");
  try {
    fb = await initFirebase("host");
  } catch (e) {
    return showFatal(e instanceof ConfigError ? e.message : `Could not connect to Firebase: ${e.message}`);
  }
  watchConnection(fb);
  bank = await loadBank();
  const total = bank.rounds.reduce((n, r) => n + r.questions.length, 0);
  $("#bank-summary").textContent = `${total} questions across ${bank.rounds.length} lectures · ${questionMs() / 1000}s per question · up to ${GAME.maxPlayers} players`;
  setInterval(loop, 200);
  showSetup();
}

async function loadBank() {
  try {
    const res = await fetch("data/questions.json", { cache: "no-store" });
    if (res.ok) return validateBank(await res.json());
  } catch { /* fall through to the file picker */ }
  // questions.json isn't deployed (see README → hiding the answers): load it from disk.
  showScreen("setup");
  $("#setup-actions").hidden = true;
  $("#loadq-box").hidden = false;
  return new Promise((resolve) => {
    $("#loadq-input").addEventListener("change", async (e) => {
      try {
        const data = validateBank(JSON.parse(await e.target.files[0].text()));
        $("#loadq-box").hidden = true;
        $("#setup-actions").hidden = false;
        resolve(data);
      } catch (err) {
        $("#loadq-error").textContent = `That file doesn't look right: ${err.message}`;
        $("#loadq-error").hidden = false;
      }
    });
  });
}

function validateBank(data) {
  if (!data || !Array.isArray(data.rounds) || !data.rounds.length) throw new Error("no rounds found");
  for (const r of data.rounds) {
    if (!Array.isArray(r.questions) || !r.questions.length) throw new Error(`round ${r.round} has no questions`);
    for (const q of r.questions) {
      if (!q.id || !q.question || !Array.isArray(q.options) || q.options.length !== 4 || !(q.correct >= 0 && q.correct <= 3)) {
        throw new Error(`question ${q.id || "?"} is malformed`);
      }
    }
  }
  return data;
}

// Only in emulator mode: ?seconds=15 shortens the countdown for quick local tests.
function questionMs() {
  const override = fb.emulator && Number(new URLSearchParams(location.search).get("seconds"));
  return (override > 0 ? override : GAME.questionSeconds) * 1000;
}

// ───────────────────────── create / resume ─────────────────────────

async function showSetup() {
  $("#topbar").hidden = true;
  showScreen("setup");
  const saved = localStorage.getItem(LS_GAME);
  const resumeBtn = $("#resume-btn");
  resumeBtn.hidden = true;
  if (!saved) return;
  try {
    const meta = (await get(ref(fb.db, `games/${saved}/meta`))).val();
    if (meta && meta.hostUid === fb.uid) {
      resumeBtn.textContent = `Resume game ${fmtCode(saved)}`;
      resumeBtn.hidden = false;
      resumeBtn.onclick = () => openGame(saved);
      return;
    }
  } catch { /* ignore */ }
  localStorage.removeItem(LS_GAME);
}

$("#create-btn").addEventListener("click", createGame);

async function createGame() {
  const btn = $("#create-btn");
  btn.disabled = true;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      try {
        // Rules only allow this write if the code is unused, and make us its host.
        await set(ref(fb.db, `games/${c}/meta`), {
          hostUid: fb.uid, createdAt: serverTimestamp(), maxPlayers: GAME.maxPlayers, questionMs: questionMs(),
        });
      } catch {
        continue; // code already taken — try another
      }
      await update(ref(fb.db, `games/${c}`), { state: { phase: "lobby" }, playerCount: 0 });
      localStorage.setItem(LS_GAME, c);
      pickerChoice = "all";
      return openGame(c);
    }
    alert("Couldn't create a game. Check your Firebase setup and database rules.");
  } catch (e) {
    alert(`Couldn't create a game: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function openGame(c) {
  gameSubs.forEach((u) => u());
  questionSubs.forEach((u) => u());
  gameSubs = [];
  questionSubs = [];
  Object.assign(live, { meta: null, state: null, players: {}, online: {}, scores: {}, answers: {}, reveal: null, results: {} });
  seenPlayers = new Set();
  playersLoaded = false;
  code = c;

  $("#topbar").hidden = false;
  $("#topbar-code").textContent = `Code ${fmtCode(code)}`;
  $("#lobby-code").textContent = fmtCode(code);
  renderQR();

  gameSubs.push(onValue(g("meta"), (s) => {
    live.meta = s.val();
    if (!live.meta) { closeGame(); }
  }));
  gameSubs.push(onValue(g("players"), (s) => {
    live.players = s.val() || {};
    onPlayers();
    playersLoaded = true;
  }));
  gameSubs.push(onValue(g("online"), (s) => { live.online = s.val() || {}; onPlayers(); }));
  gameSubs.push(onValue(g("scores"), (s) => { live.scores = s.val() || {}; rerender(); }));
  gameSubs.push(onValue(g("state"), (s) => { const prev = live.state; live.state = s.val(); onState(prev); }));
}

function closeGame() {
  gameSubs.forEach((u) => u());
  questionSubs.forEach((u) => u());
  gameSubs = [];
  questionSubs = [];
  code = null;
  localStorage.removeItem(LS_GAME);
  showSetup();
}

function joinUrl() {
  const u = new URL("join.html", location.href);
  u.search = "";
  u.searchParams.set("game", code);
  if (fb.emulator) u.searchParams.set("emulator", "1");
  return u.href;
}

function renderQR() {
  const url = joinUrl();
  $("#join-url").textContent = url.replace(/^https?:\/\//, "");
  const box = $("#qr");
  box.replaceChildren();
  if (window.QRCode) {
    new window.QRCode(box, { text: url, width: 480, height: 480, correctLevel: window.QRCode.CorrectLevel.M });
    box.removeAttribute("title"); // qrcodejs sets title=url, which shows as a tooltip
  } else {
    box.append(h("p", { class: "muted", text: "QR code library failed to load — share the link below." }));
  }
}

// ───────────────────────── state → screens ─────────────────────────

function onState(prev) {
  const st = live.state;
  if (!st) return;
  if (!prev || prev.qid !== st.qid) subscribeQuestion(st.qid);
  if (prev?.phase !== st.phase || prev?.qid !== st.qid) {
    clearTimeout(autoRevealTimer);
    autoRevealTimer = null;
    lastTickSecond = null;
    if (prev) {
      if (st.phase === "reveal") Sound.reveal();
      if (st.phase === "final") { Sound.fanfare(); confetti(4500); }
    }
  }
  rerender();
}

function subscribeQuestion(qid) {
  questionSubs.forEach((u) => u());
  questionSubs = [];
  Object.assign(live, { answers: {}, reveal: null, results: {} });
  if (!qid) return;
  questionSubs.push(onValue(g(`answers/${qid}`), (s) => { live.answers = s.val() || {}; onAnswers(); }));
  questionSubs.push(onValue(g(`reveal/${qid}`), (s) => { live.reveal = s.val(); rerender(); }));
  questionSubs.push(onValue(g(`results/${qid}`), (s) => { live.results = s.val() || {}; rerender(); }));
}

function rerender() {
  const st = live.state;
  if (!st || !code) return;
  $("#topbar-players").textContent = `👥 ${Object.keys(live.players).length}`;
  switch (st.phase) {
    case "lobby": return renderLobby();
    case "question": return renderQuestion();
    case "reveal": return renderReveal();
    case "roundEnd": return renderRoundEnd();
    case "final": return renderFinal();
  }
}

function onPlayers() {
  const ids = Object.keys(live.players);
  const newcomers = ids.filter((id) => !seenPlayers.has(id));
  if (newcomers.length && playersLoaded && live.state?.phase === "lobby") Sound.join();
  rerender();
  ids.forEach((id) => seenPlayers.add(id));
  checkAllAnswered();
}

// ───────────────────────── lobby ─────────────────────────

function renderLobby() {
  showScreen("lobby");
  const list = Object.entries(live.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const max = live.meta?.maxPlayers ?? GAME.maxPlayers;
  $("#player-count").textContent = `${list.length} / ${max}`;
  $("#player-count").classList.toggle("is-full", list.length >= max);
  $("#players-hint").hidden = list.length > 0;
  $("#kick-hint").hidden = list.length === 0;
  $("#player-chips").replaceChildren(...list.map(([uid, p]) => h("li", {},
    h("button", {
      type: "button",
      class: `chip${seenPlayers.has(uid) ? "" : " is-new"}${live.online[uid] ? "" : " is-offline"}`,
      title: `Remove ${p.name}`,
      onclick: () => kick(uid),
    }, p.name),
  )));
  renderPicker($("#lobby-rounds"), $("#lobby-start"));
}

async function kick(uid) {
  const p = live.players[uid];
  if (!p || !confirm(`Remove "${p.name}" from the game?`)) return;
  await update(g(), {
    [`players/${uid}`]: null,
    [`names/${p.key}`]: null,
    [`online/${uid}`]: null,
    [`scores/${uid}`]: null,
    playerCount: increment(-1),
  });
}

function unplayedRounds() {
  const played = live.state?.played || {};
  return bank.rounds.map((r) => r.round).filter((n) => !played[n]);
}

/** Round choice buttons (lobby and between rounds) + the label of the start button. */
function renderPicker(container, startBtn) {
  const played = live.state?.played || {};
  const unplayed = unplayedRounds();
  const valid = (c) => (c === "all" ? unplayed.length > 1 : unplayed.includes(c));
  if (!valid(pickerChoice)) pickerChoice = unplayed.length > 1 ? "all" : unplayed[0] ?? null;

  const opts = [];
  if (unplayed.length > 1) {
    const everything = unplayed.length === bank.rounds.length;
    opts.push({
      value: "all",
      title: everything ? `All ${unplayed.length} rounds in order` : `All remaining rounds (${unplayed.length})`,
      sub: unplayed.map((n) => `L${n}`).join(" → "),
    });
  }
  for (const r of bank.rounds) {
    opts.push({ value: r.round, title: `Lecture ${r.round}`, sub: played[r.round] ? "Played ✓" : r.title, disabled: !!played[r.round] });
  }
  container.replaceChildren(...opts.map((o) => h("button", {
    type: "button",
    class: `pick${o.value === "all" ? " pick-all" : ""}${pickerChoice === o.value ? " is-selected" : ""}`,
    disabled: o.disabled,
    "aria-pressed": String(pickerChoice === o.value),
    onclick: () => { pickerChoice = o.value; rerender(); },
  }, h("strong", { text: o.title }), h("span", { text: o.sub }))));

  const next = pickerChoice === "all" ? unplayed[0] : pickerChoice;
  startBtn.disabled = next == null;
  startBtn.textContent = next == null ? "All rounds played" : `▶ Start Lecture ${next}`;
}

function startSelected() {
  const next = pickerChoice === "all" ? unplayedRounds()[0] : pickerChoice;
  if (next != null) startQuestion(next, 0);
}

$("#lobby-start").addEventListener("click", startSelected);
$("#re-start").addEventListener("click", startSelected);

// ───────────────────────── question ─────────────────────────

async function startQuestion(round, qIndex) {
  const rd = roundOf(round);
  const q = rd.questions[qIndex];
  // Note: `correct` and `explanation` are deliberately NOT written here.
  await update(g("state"), {
    phase: "question",
    round,
    roundTitle: rd.title,
    qIndex,
    qCount: rd.questions.length,
    qid: q.id,
    question: q.question,
    options: q.options,
    startAt: serverTimestamp(),
    durationMs: live.meta?.questionMs || questionMs(),
    [`played/${round}`]: true,
  });
}

function optionTile(i, text, extra) {
  return h("div", { class: `opt opt-${i}` },
    h("span", { class: "opt-shape", "aria-hidden": "true", text: SHAPES[i] }),
    h("span", { class: "opt-letter", text: LETTERS[i] }),
    h("span", { class: "opt-text", text }),
    extra,
  );
}

let renderedQid = null;
function renderQuestion() {
  const st = live.state;
  showScreen("question");
  $("#q-round").textContent = `Lecture ${st.round} · ${st.roundTitle}`;
  $("#q-num").textContent = `Question ${st.qIndex + 1} of ${st.qCount}`;
  if (renderedQid !== st.qid) {
    renderedQid = st.qid;
    $("#q-text").textContent = st.question;
    $("#q-options").replaceChildren(...st.options.map((o, i) => optionTile(i, o)));
  }
  updateAnswered();
  drawTimer();
}

function onlinePlayers() {
  return Object.keys(live.players).filter((uid) => live.online[uid]);
}

function answeredCount() {
  return Object.keys(live.answers).filter((uid) => live.players[uid]).length;
}

function updateAnswered() {
  const n = answeredCount();
  const el = $("#q-answered");
  if (el.textContent !== String(n)) {
    el.textContent = n;
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  $("#q-answered-of").textContent = `of ${onlinePlayers().length} players answered`;
}

function onAnswers() {
  if (live.state?.phase === "question") updateAnswered();
  checkAllAnswered();
}

/** Every connected player has answered → reveal early. */
function checkAllAnswered() {
  if (live.state?.phase !== "question" || autoRevealTimer) return;
  const active = onlinePlayers();
  if (active.length && active.every((uid) => live.answers[uid])) {
    autoRevealTimer = setTimeout(() => { autoRevealTimer = null; revealNow(); }, 900);
  }
}

function remainingMs() {
  const st = live.state;
  if (!st?.startAt) return st?.durationMs ?? 0;
  return st.startAt + st.durationMs - fb.serverNow();
}

function drawTimer() {
  const st = live.state;
  if (st?.phase !== "question") return;
  const left = Math.max(0, remainingMs());
  const frac = Math.min(1, left / st.durationMs);
  $("#q-timer-fill").style.strokeDasharray = `${RING}`;
  $("#q-timer-fill").style.strokeDashoffset = `${RING * (1 - frac)}`;
  $("#q-timer-num").textContent = Math.ceil(left / 1000);
  $("#q-timer").classList.toggle("is-low", left <= LOW_TIME_MS);
}

function loop() {
  const st = live.state;
  if (!code || st?.phase !== "question" || !st.startAt) return;
  drawTimer();
  const left = remainingMs();
  const sec = Math.ceil(left / 1000);
  if (left > 0 && left <= LOW_TIME_MS && sec !== lastTickSecond) {
    lastTickSecond = sec;
    Sound.tick(sec <= 5);
  }
  if (left <= 0 && !revealing && Date.now() >= revealRetryAt) {
    Sound.timeUp();
    revealNow();
  }
}

$("#q-skip").addEventListener("click", () => revealNow());

// ───────────────────────── reveal + scoring ─────────────────────────

async function revealNow() {
  const st = live.state;
  if (revealing || st?.phase !== "question") return;
  revealing = true;
  try {
    const q = roundOf(st.round).questions[st.qIndex];
    const updates = { "state/phase": "reveal" };
    const already = await get(g(`reveal/${st.qid}`));
    if (!already.exists()) {
      const answers = (await get(g(`answers/${st.qid}`))).val() || {};
      for (const uid of Object.keys(live.players)) {
        const a = answers[uid];
        const ms = a ? Math.max(0, a.at - st.startAt) : -1;
        const correct = !!a && a.choice === q.correct;
        const points = correct
          ? GAME.basePoints + Math.round(GAME.speedBonus * Math.max(0, 1 - ms / st.durationMs))
          : 0;
        updates[`results/${st.qid}/${uid}`] = { choice: a ? a.choice : -1, correct, points, ms };
        if (points) {
          updates[`scores/${uid}/total`] = increment(points);
          updates[`scores/${uid}/r${st.round}`] = increment(points);
        }
      }
      // The correct answer reaches Firebase (and the phones) only now.
      updates[`reveal/${st.qid}`] = { correct: q.correct, explanation: q.explanation };
    }
    await update(g(), updates); // one atomic write: results, scores, reveal and phase together
  } catch (e) {
    revealRetryAt = Date.now() + 5000;
    toast(`Reveal failed (${e.message}). Retrying…`);
  } finally {
    revealing = false;
  }
}

function renderReveal() {
  const st = live.state;
  const rv = live.reveal;
  showScreen("reveal");
  $("#r-round").textContent = `Lecture ${st.round} · ${st.roundTitle}`;
  $("#r-num").textContent = `Question ${st.qIndex + 1} of ${st.qCount}`;
  $("#r-text").textContent = st.question;

  const results = Object.entries(live.results).filter(([uid]) => live.players[uid]);
  const counts = [0, 0, 0, 0];
  for (const [, r] of results) if (r.choice >= 0) counts[r.choice]++;
  const answered = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);

  $("#r-options").replaceChildren(...st.options.map((o, i) => {
    const tile = optionTile(i, o,
      h("span", { class: "opt-count", title: `${counts[i]} chose ${LETTERS[i]}` }, String(counts[i])),
      );
    tile.append(h("span", { class: "opt-bar", style: `width:${(counts[i] / max) * 100}%`, "aria-hidden": "true" }));
    if (rv) tile.classList.add(i === rv.correct ? "is-correct" : "is-wrong");
    return tile;
  }));
  $("#r-expl").textContent = rv ? rv.explanation : "…";

  const correct = results.filter(([, r]) => r.correct).sort((a, b) => a[1].ms - b[1].ms);
  $("#r-summary").textContent = rv ? `✓ ${correct.length} of ${results.length} correct · ${answered} answered` : "Revealing…";
  $("#r-correct").replaceChildren(...(correct.length
    ? correct.map(([uid, r], i) => lbRow(i + 1, live.players[uid].name, `+${fmtPoints(r.points)}`, fmtSeconds(r.ms)))
    : [h("li", { class: "empty", text: rv ? "Nobody got this one right." : "…" })]));
  renderBoard($("#r-top"), rankPlayers(live.players, live.scores).slice(0, 10));

  const last = st.qIndex + 1 >= st.qCount;
  $("#r-next").textContent = last ? "Show round results ▶" : "Next question ▶";
}

function lbRow(rank, name, score, meta) {
  return h("li", { class: rank <= 3 ? `top-${rank}` : "" },
    h("span", { class: "lb-rank", text: rank }),
    h("span", { class: "lb-name", text: name }),
    meta ? h("span", { class: "lb-meta", text: meta }) : null,
    h("span", { class: "lb-score", text: score }),
  );
}

function renderBoard(ol, rows) {
  ol.replaceChildren(...(rows.length
    ? rows.map((r) => lbRow(r.rank, r.name, fmtPoints(r.score)))
    : [h("li", { class: "empty", text: "No players yet." })]));
}

$("#r-next").addEventListener("click", async () => {
  const st = live.state;
  if (st.qIndex + 1 < st.qCount) await startQuestion(st.round, st.qIndex + 1);
  else await update(g("state"), { phase: "roundEnd" });
});

// ───────────────────────── round end ─────────────────────────

function renderRoundEnd() {
  const st = live.state;
  showScreen("roundend");
  $("#re-title").textContent = `Round ${st.round} complete!`;
  $("#re-sub").textContent = `Lecture ${st.round}: ${st.roundTitle}`;
  $("#re-round-h").textContent = `Lecture ${st.round} leaderboard`;
  renderBoard($("#re-round"), rankPlayers(live.players, live.scores, `r${st.round}`));
  renderBoard($("#re-overall"), rankPlayers(live.players, live.scores));

  const left = unplayedRounds();
  $("#re-rounds").hidden = left.length === 0;
  $("#re-start").hidden = left.length === 0;
  $("#re-next-h").textContent = left.length ? "Up next" : "All rounds played!";
  $("#re-end").textContent = left.length ? "End game & show winners" : "🏆 Show final results";
  $("#re-end").className = left.length ? "btn btn-ghost-dark" : "btn btn-primary btn-lg";
  if (left.length) renderPicker($("#re-rounds"), $("#re-start"));
}

// ───────────────────────── end of game ─────────────────────────

async function endGame(ask = true) {
  if (ask && !confirm("End the game now and show the winners?")) return;
  await update(g("state"), { phase: "final" });
}
$("#lobby-end").addEventListener("click", () => endGame());
$("#q-end").addEventListener("click", () => endGame());
$("#r-end").addEventListener("click", () => endGame());
$("#re-end").addEventListener("click", () => endGame(unplayedRounds().length > 0));

function renderFinal() {
  showScreen("final");
  const rows = rankPlayers(live.players, live.scores);
  $("#final-sub").textContent = `${rows.length} player${rows.length === 1 ? "" : "s"} · ${Object.keys(live.state.played || {}).length} of ${bank.rounds.length} rounds played`;

  const places = [rows[1], rows[0], rows[2]];
  $("#podium").replaceChildren(...places.map((r, i) => {
    const place = [2, 1, 3][i];
    return h("div", { class: `podium-col place-${place}${r ? "" : " is-empty"}` },
      h("div", { class: "podium-name", text: r ? r.name : "—" }),
      h("div", { class: "podium-score", text: r ? `${fmtPoints(r.score)} pts` : "" }),
      h("div", { class: "podium-block" }, h("span", { text: ["🥇", "🥈", "🥉"][(r ? r.rank : place) - 1] })),
    );
  }));

  const head = h("tr", {}, h("th", { text: "#" }), h("th", { text: "Name" }),
    ...bank.rounds.map((r) => h("th", { title: r.title, text: `L${r.round}` })), h("th", { text: "Total" }));
  const body = rows.map((r) => h("tr", {},
    h("td", { text: r.rank }), h("td", { class: "name", text: r.name }),
    ...bank.rounds.map((b) => h("td", { text: fmtPoints(live.scores[r.uid]?.[`r${b.round}`]) })),
    h("td", { class: "total", text: fmtPoints(r.score) })));
  $("#final-table").replaceChildren(h("thead", {}, head), h("tbody", {}, ...body));
}

$("#csv-btn").addEventListener("click", () => {
  const rows = rankPlayers(live.players, live.scores);
  const lines = [
    ["Rank", "Name", ...bank.rounds.map((r) => `Round ${r.round} - ${r.title}`), "Total"],
    ...rows.map((r) => [r.rank, r.name, ...bank.rounds.map((b) => live.scores[r.uid]?.[`r${b.round}`] || 0), r.score]),
  ];
  const csv = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const a = h("a", { href: url, download: `quiz-results-${code}-${date}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection via player names
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

$("#new-game-btn").addEventListener("click", () => {
  if (!confirm("Start a brand-new game? Players will need to scan the new QR code.")) return;
  closeGame();
  createGame();
});

$("#delete-game-btn").addEventListener("click", async () => {
  if (!confirm("Permanently delete this game's players, answers and scores from Firebase? Export the CSV first if you need it.")) return;
  await remove(g());
});
