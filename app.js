
const terminal = document.getElementById("terminal");
const input = document.getElementById("commandInput");
const form = document.getElementById("commandForm");
const progressBar = document.getElementById("progressBar");
const progressValue = document.getElementById("progressValue");
const operationName = document.getElementById("operationName");

let busy = false;
let matrixMode = false;
let started = Date.now();
let audioEnabled = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message, type = "") {
  const line = document.createElement("div");
  line.className = "line " + type;
  line.textContent = "> " + message;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function beep(frequency = 600) {
  if (!audioEnabled) return;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001, ctx.currentTime + 0.08
    );

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.08);
    oscillator.onended = () => ctx.close();
  } catch {}
}

async function progress(name, duration = 4000) {
  busy = true;
  operationName.textContent = name;
  progressBar.style.width = "0%";
  progressValue.textContent = "0%";

  const steps = 40;

  for (let i = 1; i <= steps; i++) {
    await sleep(duration / steps);
    const percent = Math.round(i / steps * 100);

    progressBar.style.width = percent + "%";
    progressValue.textContent = percent + "%";

    if (i % 5 === 0) beep(400 + i * 10);
  }

  log(name + " COMPLETED", "green");
  busy = false;
}

async function hack() {
  log("Starting simulated access sequence...");
  log("Loading virtual environment...");
  await progress("ACCESS SIMULATION", 4000);
  log("Virtual access granted.", "green");
  log("No external system was accessed.", "warning");
}

async function scan() {
  log("Scanning simulated network...");
  await sleep(500);

  const addresses = [
    "192.0.2.10",
    "192.0.2.25",
    "198.51.100.12",
    "198.51.100.44",
    "203.0.113.20"
  ];

  await progress("NETWORK SCAN", 3500);

  addresses.forEach((ip, index) => {
    log("HOST " + ip + " | STATUS: " +
      (index % 2 === 0 ? "ONLINE" : "FILTERED"), "green");
  });

  log("5 simulated hosts discovered.");
}

async function trace() {
  log("Starting simulated IP trace...");
  await progress("IP TRACE SIMULATION", 3000);

  log("ROUTE 01: LOCAL GATEWAY");
  log("ROUTE 02: VIRTUAL NODE");
  log("ROUTE 03: TEST SERVER");
  log("DESTINATION: 203.0.113.10", "green");
  log("All addresses are demonstration examples.", "warning");
}

async function decrypt() {
  log("Loading virtual encrypted file...");
  await progress("DECRYPTION SIMULATION", 4500);

  log("Encryption: AES-256 (simulated)");
  log("Virtual key generated.", "green");
  log("DECRYPTION SUCCESSFUL.", "green");
  log("Demo file: SYSTEM_DATA.txt");
}

async function firewall() {
  log("Starting virtual firewall test...");
  await progress("FIREWALL TEST", 3000);

  log("TEST 01: INPUT FILTER — PASS", "green");
  log("TEST 02: ACCESS RULES — PASS", "green");
  log("TEST 03: CONNECTION FILTER — PASS", "green");
  log("SIMULATION COMPLETE.");
}

async function matrix() {
  matrixMode = !matrixMode;

  if (matrixMode) {
    document.body.style.setProperty("--green", "#00ff66");
    document.querySelector(".hero h1").textContent = "MATRIX MODE";
    log("MATRIX VISUAL MODE ENABLED.", "green");
  } else {
    document.querySelector(".hero h1").textContent = "HACKER_TERMINAL";
    log("MATRIX VISUAL MODE DISABLED.");
  }
}

async function execute(command) {
  command = command.trim().toLowerCase();

  if (!command) return;

  log("root@terminal:~$ " + command);

  if (busy) {
    log("Wait for the current operation to finish.", "warning");
    return;
  }

  switch (command) {
    case "help":
      log("AVAILABLE COMMANDS:");
      log("help - show commands");
      log("hack - start access simulation");
      log("scan - scan virtual network");
      log("trace - simulate IP tracing");
      log("decrypt - simulate decryption");
      log("firewall - virtual firewall test");
      log("matrix - toggle Matrix mode");
      log("clear - clear terminal");
      log("sound - enable/disable sound");
      log("status - system status");
      break;

    case "hack":
      await hack();
      break;

    case "scan":
      await scan();
      break;

    case "trace":
      await trace();
      break;

    case "decrypt":
      await decrypt();
      break;

    case "firewall":
      await firewall();
      break;

    case "matrix":
      await matrix();
      break;

    case "clear":
      terminal.innerHTML = "";
      log("TERMINAL CLEARED.", "green");
      break;

    case "sound":
      audioEnabled = !audioEnabled;
      log("SOUND " + (audioEnabled ? "ENABLED" : "DISABLED"), "green");
      beep();
      break;

    case "status":
      log("SYSTEM: ONLINE");
      log("MODE: SIMULATION");
      log("NETWORK: LOCAL DEMO");
      break;

    default:
      log("UNKNOWN COMMAND. TYPE HELP.", "error");
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  const command = input.value;
  input.value = "";

  await execute(command);
});

document.querySelectorAll("[data-command]").forEach(button => {
  button.addEventListener("click", () => {
    execute(button.dataset.command);
  });
});

document.getElementById("fullscreenBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

setInterval(() => {
  const seconds = Math.floor((Date.now() - started) / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(seconds % 3600 / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");

  document.getElementById("uptime").textContent =
    `${hours}:${minutes}:${secs}`;
}, 1000);

setTimeout(() => {
  log("Virtual security protocols loaded.", "green");
  log("Awaiting operator command...");
}, 1000);
