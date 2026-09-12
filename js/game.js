// chess.js is ESM-only on every version cdnjs currently serves (the old
// UMD/global build no longer exists there) — imported directly rather than
// relying on a window global from a <script> tag.
import { Chess } from "https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.13.4/chess.min.js";
import { PIECE_SVG } from "./pieces.js";

const params = new URLSearchParams(window.location.search);
const roomId = params.get("room");
const playerName = sessionStorage.getItem("playerName") || "Anonymous";
const myColor = sessionStorage.getItem("playerColor") || "spectator";
const vsBot = sessionStorage.getItem("vsBot") === "1";
const botDifficulty = sessionStorage.getItem("botDifficulty") || "medium";
// Room-configurable time control (room-service#2/game-service#2): the room
// host's chosen per-player clock, read back from room-service's room object
// at create/join time (frontend/js/lobby.js). Bot games have no clock at all
// (see game-service), so there's nothing to read for them.
const timeControlMs = Number(sessionStorage.getItem("timeControlMs")) || undefined;

document.getElementById("roomTitle").textContent = vsBot
  ? `vs. Bot (${botDifficulty}) — you are ${myColor}`
  : `Room ${roomId} — you are ${myColor}`;

const resignBtn = document.getElementById("resignBtn");
if (myColor === "white" || myColor === "black") {
  resignBtn.classList.remove("hidden");
}

// Chess.com always shows the viewing player's own side at the bottom of the
// board — mirror both axes for a black player. Spectators keep white's view.
const flipped = myColor === "black";
// The vertical win-probability bar mirrors the same orientation as the
// player bars (self at bottom) — flex-direction reverses once at load,
// segment color stays fixed to the actual side regardless (see style.css).
if (flipped) document.getElementById("probBarVertical").classList.add("flipped");

let chess = new Chess();
let selectedSquare = null;
// Legal destinations for the currently selected piece, chess.com-style
// (dot markers for quiet moves, rings for captures) — computed once on
// selection via chess.js's own move generator, not re-derived per render.
let legalTargets = [];
// {from, to} of the most recent move, from the server's serialize() output —
// drives the last-move highlight.
let lastMove = null;
// Guards against two rapid clicks racing: once a move has been emitted,
// board clicks are ignored until the server authoritatively resolves it
// (a fresh "game-state" broadcast) or rejects it ("move-rejected") — the
// local `chess` instance isn't optimistically mutated, so accepting more
// clicks in between would build a second move against the same stale FEN.
let moveInFlight = false;
// True once the game has a final outcome (resignation, checkmate, or draw) —
// gates both board clicks and the resign button so neither works after the
// game is over.
let gameOver = false;
// null until the first "game-state" arrives — distinguishes "just joined an
// in-progress game" (no move sound for moves already on the board) from a
// genuinely new move landing.
let prevMoveCount = null;
// Win-probability swing per move (frontend#9): moveIndex -> rounded delta
// (positive = swung toward white) since the previous analysis-update.
// Frontend-only, not persisted — analysis-service's payload carries no move
// index, so each swing is attached to whichever move this client's own
// prevMoveCount says was just played when the update lands (recordMoveSwing).
const moveSwings = new Map();
let lastWinPctForSwing = 50; // baseline before any moves/analysis have landed
let lastRenderedMoves = []; // so recordMoveSwing can re-render without a fresh game-state
// "Highlight pieces on danger" setting (frontend#7) — client-side only,
// persisted in localStorage, read once at load. Gates the in-check king
// highlight in renderBoard().
let highlightCheckSetting = localStorage.getItem("highlightCheck") === "1";
const highlightCheckToggle = document.getElementById("highlightCheckToggle");
highlightCheckToggle.checked = highlightCheckSetting;
highlightCheckToggle.addEventListener("change", () => {
  highlightCheckSetting = highlightCheckToggle.checked;
  localStorage.setItem("highlightCheck", highlightCheckSetting ? "1" : "0");
  renderBoard();
});
// Latest clock snapshot from the server ({clocks, turnStartedAt, turn}), or
// null when the clock hasn't started yet (waiting for an opponent) or this
// is a bot game (game-service never starts one). The side to move's time is
// rendered as a local countdown between these resync points instead of the
// server ticking every second over the socket — see docs/SCOPE.md's design
// note on this item.
let clockState = null;
// Pending rematch offer from the server ({requestedBy, expiresAt}) or null.
let rematchState = null;
// True once this room has been finalized after a declined/expired rematch —
// game-service tells room-service to close it; the frontend just stops
// offering a rematch button once that happens (no further server checks).
let roomClosed = false;

renderCoordLabels();

// game-service socket. Path matches the nginx strip-prefix rule.
const gameSocket = io("/", { path: "/socket/game/socket.io/" });
gameSocket.emit("join-room", { roomId, color: myColor, name: playerName, vsBot, difficulty: botDifficulty, timeControlMs });

// Fetch whatever analysis already exists for this room (e.g. rejoining a
// game already in progress, or the page loading after moves were already
// made) via the REST route instead of the socket, so the win-probability
// bar isn't stuck at a blank/default 50% until the *next* move triggers a
// fresh "analysis-update". 404 just means no move has landed yet (fresh
// room) — that's expected and not an error.
fetch(`/api/analysis/${roomId}/analysis`)
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (data) {
      applyAnalysis(data);
      // Seed the swing baseline (but don't attach a badge to any move) so a
      // rejoining player's first real analysis-update doesn't compute a
      // misleading delta against the 50% default.
      lastWinPctForSwing = data.white_win_pct;
    }
  })
  .catch((err) => console.error("initial analysis fetch failed", err));

gameSocket.on("game-state", (state) => {
  moveInFlight = false;
  const wasGameOver = gameOver;
  gameOver = Boolean(state.result) || state.isCheckmate || state.isDraw;
  lastMove = state.lastMove || null;
  clockState = state.clocks ? { clocks: state.clocks, turnStartedAt: state.turnStartedAt, turn: state.turn } : null;
  rematchState = state.rematch || null;
  chess.load(state.fen);
  renderBoard();
  const statusText =
    state.result && state.result.reason === "resignation"
      ? `${state.result.resignedBy} resigned — ${state.result.winner} wins`
      : state.result && state.result.reason === "flagfall"
      ? `${state.result.loser} ran out of time — ${state.result.winner} wins`
      : state.isCheckmate ? `Checkmate — ${state.turn === "white" ? "black" : "white"} wins` :
    state.isDraw ? "Draw" :
    state.isCheck ? `${state.turn} to move — check!` :
    `${state.turn} to move`;
  document.getElementById("status").textContent = statusText;
  renderMoveLog(state.moves);
  updatePlayerBars(state);

  const newMoveCount = state.moves.length;
  if (prevMoveCount !== null && newMoveCount > prevMoveCount) {
    playMoveSound(state.moves[newMoveCount - 1].includes("x"));
  }
  prevMoveCount = newMoveCount;
  if (gameOver && !wasGameOver) playGameEndSound();

  if (gameOver) {
    resignBtn.classList.add("hidden");
    selectedSquare = null;
    legalTargets = [];
    // Bot games have no second human to run the accept/decline rematch flow
    // against — just offer an immediate replay instead (frontend#5).
    if (vsBot) document.getElementById("playAgainBtn").classList.remove("hidden");
    if (!wasGameOver) showEndGameModal(statusText);
  } else {
    document.getElementById("playAgainBtn").classList.add("hidden");
    // A rematch was accepted (or this is a fresh game): clear any leftover
    // rematch-panel state from the previous game.
    roomClosed = false;
    document.getElementById("rematchStatus").textContent = "";
    document.getElementById("endGameModal").classList.add("hidden");
  }
  renderRematchPanel();
});

gameSocket.on("move-rejected", ({ reason }) => {
  moveInFlight = false;
  document.getElementById("moveError").textContent = `Illegal move: ${reason}`;
  playIllegalSound();
  setTimeout(() => (document.getElementById("moveError").textContent = ""), 2000);
});

gameSocket.on("rematch-offered", (rematch) => {
  rematchState = rematch;
  renderRematchPanel();
});

gameSocket.on("rematch-closed", ({ reason }) => {
  rematchState = null;
  roomClosed = true;
  document.getElementById("rematchStatus").textContent =
    reason === "declined" ? "Opponent declined the rematch — room closed." : "Rematch offer expired — room closed.";
  renderRematchPanel();
});

function renderRematchPanel() {
  const requestBtn = document.getElementById("rematchRequestBtn");
  const offer = document.getElementById("rematchOffer");
  const offerText = document.getElementById("rematchOfferText");
  const status = document.getElementById("rematchStatus");
  const isPlayer = myColor === "white" || myColor === "black";

  if (!gameOver || vsBot || !isPlayer) {
    requestBtn.classList.add("hidden");
    offer.classList.add("hidden");
    return;
  }

  if (roomClosed) {
    requestBtn.classList.add("hidden");
    offer.classList.add("hidden");
    return; // status text already set by the rematch-closed handler
  }

  if (!rematchState) {
    requestBtn.classList.remove("hidden");
    offer.classList.add("hidden");
    status.textContent = "";
    return;
  }

  const secondsLeft = Math.max(0, Math.ceil((rematchState.expiresAt - Date.now()) / 1000));
  requestBtn.classList.add("hidden");
  if (rematchState.requestedBy === myColor) {
    offer.classList.add("hidden");
    status.textContent = `Rematch offer sent — waiting for opponent (${secondsLeft}s)...`;
  } else {
    offer.classList.remove("hidden");
    offerText.textContent = `Opponent wants a rematch (${secondsLeft}s)`;
    status.textContent = "";
  }
}

document.getElementById("rematchRequestBtn").addEventListener("click", () => {
  gameSocket.emit("rematch-request", { roomId });
});
document.getElementById("rematchAcceptBtn").addEventListener("click", () => {
  gameSocket.emit("rematch-response", { roomId, accept: true });
});
document.getElementById("rematchDeclineBtn").addEventListener("click", () => {
  gameSocket.emit("rematch-response", { roomId, accept: false });
});

function playAgainVsBot() {
  // sessionStorage's playerName/playerColor/vsBot/botDifficulty are already
  // correct for this session (unchanged) — a "new" bot game is just a fresh
  // room id, same bootstrap frontend/js/lobby.js's playBotBtn uses.
  const newRoomId = `bot-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  window.location.href = `game.html?room=${newRoomId}`;
}

document.getElementById("playAgainBtn").addEventListener("click", playAgainVsBot);

// End-of-game modal (frontend#8) — pops up once per game-over, same pattern
// as showPromotionPicker()'s one-shot modal. Its Rematch button just
// triggers whichever flow the standalone buttons above already provide
// (bot replay, or a human rematch request); the ongoing offer/accept/
// decline state itself is still shown via #rematchPanel underneath once
// this modal is dismissed, not duplicated inside the modal.
function showEndGameModal(text) {
  const isPlayer = myColor === "white" || myColor === "black";
  document.getElementById("endGameText").textContent = text;
  const rematchBtn = document.getElementById("endGameRematchBtn");
  rematchBtn.classList.toggle("hidden", !isPlayer);
  document.getElementById("endGameModal").classList.remove("hidden");
}

document.getElementById("endGameRematchBtn").addEventListener("click", () => {
  document.getElementById("endGameModal").classList.add("hidden");
  if (vsBot) playAgainVsBot();
  else gameSocket.emit("rematch-request", { roomId });
});

document.getElementById("endGameCloseBtn").addEventListener("click", () => {
  document.getElementById("endGameModal").classList.add("hidden");
});

function applyAnalysis({ white_win_pct, black_win_pct }) {
  document.getElementById("whiteProb").style.height = `${white_win_pct}%`;
  document.getElementById("blackProb").style.height = `${black_win_pct}%`;
  document.getElementById("whiteProb").textContent = `White ${white_win_pct}%`;
  document.getElementById("blackProb").textContent = `Black ${black_win_pct}%`;
}

gameSocket.on("analysis-update", (data) => {
  applyAnalysis(data);
  recordMoveSwing(data.white_win_pct);
});

// Attaches this update's win% swing to whichever move was on the board when
// it landed, inferred from this client's own last-known move count — the
// analysis-update payload itself carries no move index to key off of.
function recordMoveSwing(newWhitePct) {
  if (prevMoveCount) {
    moveSwings.set(prevMoveCount - 1, Math.round(newWhitePct - lastWinPctForSwing));
  }
  lastWinPctForSwing = newWhitePct;
  renderMoveLog(lastRenderedMoves);
}

// Which color renders in the bottom ("self") vs. top ("opponent") player bar
// — the board already flips per-viewer (see `flipped` above), so which side
// is physically on top/bottom varies by who's looking, not by white/black.
function viewColors() {
  const isSpectator = myColor !== "white" && myColor !== "black";
  const bottomColor = isSpectator ? "white" : myColor;
  const topColor = bottomColor === "white" ? "black" : "white";
  return { bottomColor, topColor, isSpectator };
}

function updatePlayerBars(state) {
  const { bottomColor, topColor, isSpectator } = viewColors();

  const label = (color) => {
    if (vsBot && color !== myColor) return `Bot (${botDifficulty})`;
    const player = state.players[color];
    if (isSpectator) return player ? `${player.name} (${color})` : color;
    return color === myColor ? `${playerName} (you)` : (player ? player.name : color);
  };

  document.getElementById("opponentName").textContent = label(topColor);
  document.getElementById("selfName").textContent = label(bottomColor);
  document.getElementById("opponentDot").classList.toggle("active", state.turn === topColor);
  document.getElementById("selfDot").classList.toggle("active", state.turn === bottomColor);
}

const LOW_TIME_DISPLAY_MS = 10000;

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Renders both clocks from the last server resync, locally counting down the
// side to move between resyncs rather than polling/ticking over the socket.
function renderClocks() {
  const { bottomColor, topColor } = viewColors();
  const bottomEl = document.getElementById("selfClock");
  const topEl = document.getElementById("opponentClock");

  if (!clockState) {
    bottomEl.textContent = "";
    topEl.textContent = "";
    return;
  }

  const remaining = (color) => {
    // Once the game is over, clocks are frozen exactly as the server sent
    // them (including a flag-fall's final 0) — don't keep counting down.
    if (!gameOver && color === clockState.turn) {
      return Math.max(0, clockState.clocks[color] - (Date.now() - clockState.turnStartedAt));
    }
    return clockState.clocks[color];
  };

  const bottomMs = remaining(bottomColor);
  const topMs = remaining(topColor);
  bottomEl.textContent = formatClock(bottomMs);
  topEl.textContent = formatClock(topMs);
  bottomEl.classList.toggle("clock-low", !gameOver && bottomColor === clockState.turn && bottomMs < LOW_TIME_DISPLAY_MS);
  topEl.classList.toggle("clock-low", !gameOver && topColor === clockState.turn && topMs < LOW_TIME_DISPLAY_MS);
}

setInterval(() => {
  renderClocks();
  renderRematchPanel(); // keeps the accept-window countdown live between server events
}, 250);

function renderCoordLabels() {
  const filesEl = document.getElementById("fileLabels");
  const ranksEl = document.getElementById("rankLabels");
  const files = flipped ? "hgfedcba" : "abcdefgh";

  for (let c = 0; c < 8; c++) {
    const span = document.createElement("span");
    span.textContent = files[c];
    filesEl.appendChild(span);
  }
  for (let r = 0; r < 8; r++) {
    const span = document.createElement("span");
    span.textContent = flipped ? r + 1 : 8 - r;
    ranksEl.appendChild(span);
  }
}

// chess.js has no direct "find king" helper — scan the board for the side to
// move's king, only while that side is actually in check.
function checkedKingSquare(board) {
  // The frontend vendors chess.js 0.13.4 (cdnjs has no browser-global build
  // for any newer version — see the ESM-import note at the top of this
  // file), which predates the 1.x camelCase rename: it's in_check(), not
  // isCheck(), unlike game-service's own (newer) chess.js dependency.
  if (!chess.in_check()) return null;
  const turn = chess.turn();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && piece.type === "k" && piece.color === turn) {
        return `${"abcdefgh"[col]}${8 - row}`;
      }
    }
  }
  return null;
}

function renderBoard() {
  const boardEl = document.getElementById("board");
  boardEl.innerHTML = "";
  const board = chess.board(); // 8x8, board[0] = rank 8, board[row][0] = file a
  const legalSquares = new Set(legalTargets.map((t) => t.square));
  const captureSquares = new Set(legalTargets.filter((t) => t.capture).map((t) => t.square));
  const inCheckSquare = highlightCheckSetting ? checkedKingSquare(board) : null;

  for (let visRow = 0; visRow < 8; visRow++) {
    for (let visCol = 0; visCol < 8; visCol++) {
      const rank = flipped ? visRow + 1 : 8 - visRow;
      const fileIndex = flipped ? 7 - visCol : visCol;
      const file = "abcdefgh"[fileIndex];
      const squareName = `${file}${rank}`;
      const boardRow = 8 - rank;
      const boardCol = fileIndex;

      const squareEl = document.createElement("div");
      // Square color is tied to the real square identity, not visual
      // position, so it never changes when the board is flipped.
      squareEl.className = `square ${(boardRow + boardCol) % 2 === 0 ? "light" : "dark"}`;
      squareEl.dataset.square = squareName;

      const piece = board[boardRow][boardCol];
      if (piece) {
        const symbol = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
        squareEl.innerHTML = PIECE_SVG[symbol];
      }
      if (squareName === selectedSquare) squareEl.classList.add("selected");
      if (lastMove && (squareName === lastMove.from || squareName === lastMove.to)) squareEl.classList.add("last-move");
      if (captureSquares.has(squareName)) squareEl.classList.add("legal-capture");
      else if (legalSquares.has(squareName)) squareEl.classList.add("legal-move");
      if (squareName === inCheckSquare) squareEl.classList.add("in-check");

      squareEl.addEventListener("click", () => onSquareClick(squareName));
      boardEl.appendChild(squareEl);
    }
  }
}

// Dots/rings for a selected piece's legal destinations, chess.com-style.
function legalMoveTargets(square) {
  return chess.moves({ square, verbose: true }).map((m) => ({
    square: m.to,
    capture: m.flags.includes("c") || m.flags.includes("e")
  }));
}

function onSquareClick(squareName) {
  if (myColor !== "white" && myColor !== "black") return; // spectators can't move
  if (gameOver) return; // nothing left to play
  if (moveInFlight) return; // a previous click's move is still awaiting server resolution

  if (!selectedSquare) {
    const piece = chess.get(squareName);
    if (piece && piece.color === myColor[0]) {
      selectedSquare = squareName;
      legalTargets = legalMoveTargets(squareName);
    }
    renderBoard();
    return;
  }

  if (selectedSquare === squareName) {
    selectedSquare = null;
    legalTargets = [];
    renderBoard();
    return;
  }

  if (!legalTargets.some((t) => t.square === squareName)) {
    // Not a legal destination for the selected piece. Re-select if it's
    // another of the player's own pieces (chess.com-style); otherwise this
    // is an out-of-range click — just clear the selection instead of
    // emitting a move the server would only have to reject.
    const piece = chess.get(squareName);
    if (piece && piece.color === myColor[0]) {
      selectedSquare = squareName;
      legalTargets = legalMoveTargets(squareName);
    } else {
      selectedSquare = null;
      legalTargets = [];
    }
    renderBoard();
    return;
  }

  const from = selectedSquare;
  selectedSquare = null;
  legalTargets = [];

  // chess.js flags a move "p" when it's a pawn reaching the back rank — ask
  // which piece to promote to instead of always defaulting to a queen.
  const candidateMoves = chess.moves({ square: from, verbose: true });
  const promotionMove = candidateMoves.find((m) => m.to === squareName && m.flags.includes("p"));

  if (promotionMove) {
    renderBoard();
    showPromotionPicker((piece) => {
      moveInFlight = true;
      gameSocket.emit("move", { roomId, from, to: squareName, promotion: piece });
    });
    return;
  }

  moveInFlight = true;
  gameSocket.emit("move", { roomId, from, to: squareName, promotion: "q" });
  renderBoard();
}

function showPromotionPicker(onChoose) {
  const modal = document.getElementById("promotionModal");
  const buttons = modal.querySelectorAll("button[data-piece]");
  const svgFor = (piece) => PIECE_SVG[myColor === "white" ? piece.toUpperCase() : piece];

  buttons.forEach((btn) => {
    btn.innerHTML = svgFor(btn.dataset.piece);
  });

  function handleClick(event) {
    cleanup();
    onChoose(event.currentTarget.dataset.piece);
  }

  function cleanup() {
    modal.classList.add("hidden");
    buttons.forEach((btn) => btn.removeEventListener("click", handleClick));
  }

  buttons.forEach((btn) => btn.addEventListener("click", handleClick));
  modal.classList.remove("hidden");
}

resignBtn.addEventListener("click", () => {
  if (gameOver) return;
  if (!window.confirm("Resign this game?")) return;
  gameSocket.emit("resign", { roomId });
});

function renderMoveLog(moves) {
  lastRenderedMoves = moves;
  const list = document.getElementById("moveLog");
  list.innerHTML = "";
  for (let i = 0; i < moves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-row";

    const num = document.createElement("span");
    num.className = "move-num";
    num.textContent = `${i / 2 + 1}.`;

    const white = document.createElement("span");
    white.textContent = moves[i] || "";
    appendSwingBadge(white, i);

    const black = document.createElement("span");
    black.textContent = moves[i + 1] || "";
    appendSwingBadge(black, i + 1);

    row.append(num, white, black);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

// Small +/- badge next to a move showing the win-probability swing (positive
// = toward white) analysis-service reported once this move landed. Skipped
// when there's no move in this cell or no swing was ever recorded for it
// (frontend#9 — frontend-only, not persisted, so a rejoining player's
// earlier moves just won't have one).
function appendSwingBadge(cell, moveIndex) {
  if (!cell.textContent) return;
  const delta = moveSwings.get(moveIndex);
  if (delta === undefined) return;
  const badge = document.createElement("span");
  badge.className = `move-swing ${delta > 0 ? "swing-white" : delta < 0 ? "swing-black" : ""}`;
  badge.textContent = ` ${delta > 0 ? "+" : ""}${delta}`;
  cell.appendChild(badge);
}

// --- Sound effects (Web Audio API tones — no audio assets to ship/license) ---
let audioCtx = null;
function playTone(freq, duration, type) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}
const playMoveSound = (isCapture) => playTone(isCapture ? 330 : 440, isCapture ? 0.15 : 0.1, isCapture ? "square" : "sine");
const playGameEndSound = () => playTone(220, 0.4, "sawtooth");
const playIllegalSound = () => playTone(140, 0.15, "square");

// --- Chat (separate service, separate socket connection) ---
// Bot games never touch chat-service — there's no second player to talk to,
// and the room id was never registered anywhere chat-service would know it.
if (vsBot) {
  document.querySelector(".chat-block").classList.add("hidden");
}
const chatSocket = vsBot ? null : io("/", { path: "/socket/chat/socket.io/" });
if (chatSocket) {
  chatSocket.emit("join-room", { roomId, name: playerName });
  chatSocket.on("chat-history", (messages) => messages.forEach(renderChatMessage));
  chatSocket.on("chat-message", renderChatMessage);
}

function renderChatMessage({ name, text, ts }) {
  const el = document.createElement("div");
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<strong>${name}</strong> <span style="opacity:0.5">${time}</span>: ${text}`;
  const container = document.getElementById("chatMessages");
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

document.getElementById("chatSend").addEventListener("click", sendChat);
document.getElementById("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const input = document.getElementById("chatInput");
  if (!input.value.trim()) return;
  chatSocket.emit("chat-message", { roomId, text: input.value.trim() });
  input.value = "";
}
