const API_BASE = "/api";

function playerSummary(players) {
  if (!players) return "";
  return ["white", "black"]
    .filter((color) => players[color])
    .map((color) => `${players[color].name} (${color})`)
    .join(", ");
}

function renderRow(game) {
  const tr = document.createElement("tr");
  const cell = (text) => {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  };

  tr.append(
    cell(game.roomId),
    cell(game.status),
    cell(game.outcome),
    cell(game.moveCount),
    cell(playerSummary(game.players)),
    cell(new Date(game.updatedAt).toLocaleString())
  );
  return tr;
}

fetch(`${API_BASE}/admin/games`)
  .then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  })
  .then((games) => {
    const rowsEl = document.getElementById("adminRows");
    if (games.length === 0) {
      document.getElementById("adminEmpty").classList.remove("hidden");
      return;
    }
    games.forEach((game) => rowsEl.appendChild(renderRow(game)));
  })
  .catch((err) => {
    document.getElementById("adminError").textContent = `Couldn't load game history: ${err.message}`;
  });
