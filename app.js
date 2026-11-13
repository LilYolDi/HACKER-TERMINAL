const $ = id => document.getElementById(id);

const terminal = $("terminal");
const results = $("results");

let target = "";
let busy = false;
let currentTrackerId = "";
let ownerToken = "";
let pollTimer = null;

const start = Date.now();

function log(message, type = "") {
  const line = document.createElement("div");
  line.className = "line " + type;
  line.textContent = "> " + message;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function print(data) {
  results.textContent = JSON.stringify(data, null, 2);
}

async function api(endpoint) {
  if (!target) {
    throw new Error("Set an authorized target domain first.");
  }

  const response = await fetch("/api/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: target })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function run(command) {
  command = command.toLowerCase().trim();

  if (!command) return;

  log("root@hacker:~$ " + command);

  if (busy) {
    log("Wait for the current check.", "warning");
    return;
  }

  if (command === "help") {
    log("dns     - real DNS analysis");
    log("ssl     - SSL certificate check");
    log("headers - HTTP security headers");
    log("ports   - check selected TCP ports");
    log("status  - server status");
    log("clear   - clear terminal");
    log("tracker - generate a tracking link");
    return;
  }

  if (command === "clear") {
    terminal.textContent = "";
    results.textContent = "Waiting for command...";
    return;
  }

  if (command === "tracker") {
    await generateTrackingLink();
    return;
  }

  if (command === "status") {
    log("Checking server...");

    try {
      const response = await fetch("/api/status");
      const data = await response.json();

      print(data);
      log("Server: " + data.status, "green");
    } catch (error) {
      log(error.message, "error");
    }

    return;
  }

  if (!["dns", "ssl", "headers", "ports"].includes(command)) {
    log("Unknown command. Type help.", "error");
    return;
  }

  busy = true;
  log("Running real " + command.toUpperCase() + " check...");

  try {
    const data = await api(command);
    print(data);
    log(command.toUpperCase() + " completed successfully.", "green");
  } catch (error) {
    print({ error: error.message });
    log(error.message, "error");
  } finally {
    busy = false;
  }
}

// Select target domain
$("setTarget").addEventListener("click", () => {
  const value = $("host").value.trim().toLowerCase();

  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(value)) {
    log("Enter a valid domain name.", "error");
    return;
  }

  target = value;

  log("Target selected: " + target, "green");
  log("Server authorization is still required.", "warning");
});

// Terminal form
$("commandForm").addEventListener("submit", event => {
  event.preventDefault();

  const value = $("command").value;
  $("command").value = "";

  run(value);
});

// Operation buttons
document.querySelectorAll("[data-cmd]").forEach(button => {
  button.addEventListener("click", () => {
    run(button.dataset.cmd);
  });
});

// Generate tracking link
async function generateTrackingLink() {
  const button = $("generateLink");

  button.disabled = true;
  button.textContent = "GENERATING...";

  try {
    const response = await fetch("/api/track/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not create link");
    }

    const url = new URL(data.link);
    currentTrackerId = url.pathname.split("/").pop();
    ownerToken = data.ownerToken;

    sessionStorage.setItem("hackerTrackerId", currentTrackerId);
    sessionStorage.setItem("hackerOwnerToken", ownerToken);

    $("trackingLink").value = data.link;
    $("linkExpiry").textContent = "Link expires in " + data.expiresIn;
    $("linkArea").classList.remove("hidden");

    $("visitorLog").innerHTML =
      '<p class="empty-log">Waiting for visitors...</p>';

    $("visitorCount").textContent = "0 VISITS";

    log("Unique tracking link generated.", "green");
    log("Visitor consent is required before IP recording.", "warning");

    startPolling();
  } catch (error) {
    log(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "GENERATE LINK";
  }
}

$("generateLink").addEventListener("click", generateTrackingLink);

// Copy tracking link
$("copyLink").addEventListener("click", async () => {
  const value = $("trackingLink").value;

  try {
    await navigator.clipboard.writeText(value);
    $("copyLink").textContent = "COPIED!";
    setTimeout(() => {
      $("copyLink").textContent = "COPY";
    }, 1500);
  } catch {
    $("trackingLink").select();
    document.execCommand("copy");
    $("copyLink").textContent = "COPIED!";
  }
});

// Poll visitor events using the private owner token
async function loadEvents() {
  if (!currentTrackerId || !ownerToken) return;

  try {
    const response = await fetch(
      "/api/track/" + encodeURIComponent(currentTrackerId) + "/events",
      {
        headers: {
          Authorization: "Bearer " + ownerToken
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load visitor log");
    }

    renderEvents(data.events || []);
  } catch (error) {
    log("Tracker update: " + error.message, "error");
    stopPolling();
  }
}

function renderEvents(events) {
  $("visitorCount").textContent =
    events.length + (events.length === 1 ? " VISIT" : " VISITS");

  const container = $("visitorLog");
  container.textContent = "";

  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "empty-log";
    empty.textContent = "No visitors yet.";
    container.appendChild(empty);
    return;
  }

  events.slice().reverse().forEach(event => {
    const entry = document.createElement("div");
    entry.className = "visitor-entry";

    const ip = document.createElement("div");
    ip.textContent = "IP: " + event.ip;

    const time = document.createElement("div");
    time.textContent = "TIME: " + new Date(event.time).toLocaleString();

    const status = document.createElement("div");
    status.textContent = "STATUS: " + event.status;

    entry.append(ip, time, status);
    container.appendChild(entry);
  });

  log("Visitor log updated: " + events.length + " consented visit(s).", "green");
}

function startPolling() {
  stopPolling();
  loadEvents();
  pollTimer = setInterval(loadEvents, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Restore current tracker after page refresh in this browser tab
function restoreTracker() {
  const savedId = sessionStorage.getItem("hackerTrackerId");
  const savedToken = sessionStorage.getItem("hackerOwnerToken");

  if (!savedId || !savedToken) return;

  currentTrackerId = savedId;
  ownerToken = savedToken;

  $("trackingLink").value =
    window.location.origin + "/t/" + currentTrackerId;

  $("linkArea").classList.remove("hidden");

  log("Previous tracking session restored.", "green");
  startPolling();
}

// Server status
async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();

    $("serverStatus").textContent = data.status.toUpperCase();
    $("status").innerHTML =
      '<span class="online-dot"></span> SYSTEM ONLINE';
  } catch {
    $("serverStatus").textContent = "OFFLINE";
    $("status").textContent = "SERVER OFFLINE";
  }
}

// Uptime counter
setInterval(() => {
  const seconds = Math.floor((Date.now() - start) / 1000);

  $("uptime").textContent = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60
  ].map(number => String(number).padStart(2, "0")).join(":");
}, 1000);

// Initialize
checkStatus();
restoreTracker();

log("HACKER TERMINAL v2.1");
log("Real diagnostic modules initialized.", "green");
log("LINK TRACKER initialized.", "green");
log("Type HELP to see available commands.");