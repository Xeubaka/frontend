// chess.js is ESM-only on every version cdnjs currently serves (the old
// UMD/global build no longer exists there) — imported directly rather than
// relying on a window global from a <script> tag.
import { Chess } from "https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.13.4/chess.min.js";

const params = new URLSearchParams(window.location.search);
const roomId = params.get("room");
const playerName = sessionStorage.getItem("playerName") || "Anonymous";
const myColor = sessionStorage.getItem("playerColor") || "spectator";
const vsBot = sessionStorage.getItem("vsBot") === "1";
const botDifficulty = sessionStorage.getItem("botDifficulty") || "medium";

document.getElementById("roomTitle").textContent = vsBot
  ? `vs. Bot (${botDifficulty}) — you are ${myColor}`
  : `Room ${roomId} — you are ${myColor}`;

const resignBtn = document.getElementById("resignBtn");
if (myColor === "white" || myColor === "black") {
  resignBtn.classList.remove("hidden");
}

const PIECE_UNICODE = {
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔"
};

let chess = new Chess();
let selectedSquare = null;
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

// game-service socket. Path matches the nginx strip-prefix rule.
const gameSocket = io("/", { path: "/socket/game/socket.io/" });
gameSocket.emit("join-room", { roomId, color: myColor, name: playerName, vsBot, difficulty: botDifficulty });

// Fetch whatever analysis already exists for this room (e.g. rejoining a
// game already in progress, or the page loading after moves were already
// made) via the REST route instead of the socket, so the win-probability
// bar isn't stuck at a blank/default 50% until the *next* move triggers a
// fresh "analysis-update". 404 just means no move has landed yet (fresh
// room) — that's expected and not an error.
fetch(`/api/analysis/${roomId}/analysis`)
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (data) applyAnalysis(data);
  })
  .catch((err) => console.error("initial analysis fetch failed", err));

gameSocket.on("game-state", (state) => {
  moveInFlight = false;
  gameOver = Boolean(state.result) || state.isCheckmate || state.isDraw;
  chess.load(state.fen);
  renderBoard();
  document.getElementById("status").textContent =
    state.result && state.result.reason === "resignation"
      ? `${state.result.resignedBy} resigned — ${state.result.winner} wins`
      : state.isCheckmate ? `Checkmate — ${state.turn === "white" ? "black" : "white"} wins` :
    state.isDraw ? "Draw" :
    state.isCheck ? `${state.turn} to move — check!` :
    `${state.turn} to move`;
  renderMoveLog(state.moves);
  if (gameOver) {
    resignBtn.classList.add("hidden");
    selectedSquare = null;
  }
});

gameSocket.on("move-rejected", ({ reason }) => {
  moveInFlight = false;
  document.getElementById("moveError").textContent = `Illegal move: ${reason}`;
  setTimeout(() => (document.getElementById("moveError").textContent = ""), 2000);
});

function applyAnalysis({ white_win_pct, black_win_pct }) {
  document.getElementById("whiteProb").style.width = `${white_win_pct}%`;
  document.getElementById("blackProb").style.width = `${black_win_pct}%`;
  document.getElementById("whiteProb").textContent = `White ${white_win_pct}%`;
  document.getElementById("blackProb").textContent = `Black ${black_win_pct}%`;
}

gameSocket.on("analysis-update", applyAnalysis);

function renderBoard() {
  const boardEl = document.getElementById("board");
  boardEl.innerHTML = "";
  const board = chess.board(); // 8x8, board[0] = rank 8

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const squareEl = document.createElement("div");
      const file = "abcdefgh"[col];
      const rank = 8 - row;
      const squareName = `${file}${rank}`;

      squareEl.className = `square ${(row + col) % 2 === 0 ? "light" : "dark"}`;
      squareEl.dataset.square = squareName;

      const piece = board[row][col];
      if (piece) {
        const symbol = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
        squareEl.textContent = PIECE_UNICODE[symbol];
      }
      if (squareName === selectedSquare) squareEl.classList.add("selected");

      squareEl.addEventListener("click", () => onSquareClick(squareName));
      boardEl.appendChild(squareEl);
    }
  }
}

function onSquareClick(squareName) {
  if (myColor !== "white" && myColor !== "black") return; // spectators can't move
  if (gameOver) return; // nothing left to play
  if (moveInFlight) return; // a previous click's move is still awaiting server resolution

  if (!selectedSquare) {
    const piece = chess.get(squareName);
    if (piece && piece.color === myColor[0]) selectedSquare = squareName;
    renderBoard();
    return;
  }

  if (selectedSquare === squareName) {
    selectedSquare = null;
    renderBoard();
    return;
  }

  const from = selectedSquare;
  selectedSquare = null;

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
  const symbolFor = (piece) => PIECE_UNICODE[myColor === "white" ? piece.toUpperCase() : piece];

  buttons.forEach((btn) => {
    btn.textContent = symbolFor(btn.dataset.piece);
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
  const list = document.getElementById("moveLog");
  list.innerHTML = "";
  moves.forEach((san) => {
    const li = document.createElement("li");
    li.textContent = san;
    list.appendChild(li);
  });
}

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
