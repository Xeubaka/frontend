const API_BASE = "/api";

document.getElementById("createBtn").addEventListener("click", async () => {
  const name = document.getElementById("createName").value || "Player 1";
  const timeControlMinutes = Number(document.getElementById("createTimeControl").value);
  const res = await fetch(`${API_BASE}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeControlMinutes })
  });
  const room = await res.json();

  const joinRes = await fetch(`${API_BASE}/rooms/${room.id}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerName: name })
  });
  const { you } = await joinRes.json();

  document.getElementById("createResult").innerHTML =
    `Room created: <strong>${room.id}</strong> — share this code. Redirecting...`;

  sessionStorage.setItem("playerName", name);
  sessionStorage.setItem("playerColor", you.color);
  sessionStorage.setItem("timeControlMs", room.timeControlMs);
  sessionStorage.removeItem("vsBot");
  window.location.href = `game.html?room=${room.id}`;
});

document.getElementById("joinBtn").addEventListener("click", async () => {
  const code = document.getElementById("joinCode").value.trim().toUpperCase();
  const name = document.getElementById("joinName").value || "Player 2";
  const errorEl = document.getElementById("joinError");
  errorEl.textContent = "";

  try {
    const joinRes = await fetch(`${API_BASE}/rooms/${code}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName: name })
    });
    if (!joinRes.ok) throw new Error("Room not found");
    const { room, you } = await joinRes.json();

    sessionStorage.setItem("playerName", name);
    sessionStorage.setItem("playerColor", you.color);
    sessionStorage.setItem("timeControlMs", room.timeControlMs);
    sessionStorage.removeItem("vsBot");
    window.location.href = `game.html?room=${code}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// Bot games skip room-service entirely — there's never a second human to
// join, so a client-generated id is all game-service needs as a Map key.
document.getElementById("playBotBtn").addEventListener("click", () => {
  const name = document.getElementById("botName").value || "Player 1";
  const color = document.getElementById("botColor").value;
  const difficulty = document.getElementById("botDifficulty").value;
  const roomId = `bot-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  sessionStorage.setItem("playerName", name);
  sessionStorage.setItem("playerColor", color);
  sessionStorage.setItem("vsBot", "1");
  sessionStorage.setItem("botDifficulty", difficulty);
  window.location.href = `game.html?room=${roomId}`;
});
