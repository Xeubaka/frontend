const API_BASE = "/api";

document.getElementById("createBtn").addEventListener("click", async () => {
  const name = document.getElementById("createName").value || "Player 1";
  const res = await fetch(`${API_BASE}/rooms`, { method: "POST" });
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
    const { you } = await joinRes.json();

    sessionStorage.setItem("playerName", name);
    sessionStorage.setItem("playerColor", you.color);
    window.location.href = `game.html?room=${code}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
