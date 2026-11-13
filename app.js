
const $ = id => document.getElementById(id);

const terminal = $("terminal");

const isGuest = /^\/connect\/[a-f0-9]{32}$/.test(
  window.location.pathname
);

const roomId = isGuest
  ? window.location.pathname.split("/").pop()
  : null;

let socket = null;
let peer = null;
let localStream = null;
let ownerToken = "";
let roomCode = "";
let candidateQueue = [];
let activeMode = "ip";

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function log(message, type = "") {
  if (!terminal) return;

  const line = document.createElement("div");
  line.className = "line " + type;
  line.textContent = "> " + message;

  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function setStatus(value) {
  if ($("connectionStatus")) {
    $("connectionStatus").textContent = value;
  }
}

function showMessage(id, message) {
  if ($(id)) $(id).textContent = message;
}

// MODE SWITCHING
function switchMode(mode) {
  if (isGuest) return;

  activeMode = mode;

  const ipPanel = $("ipPanel");
  const hostPanel = $("hostPanel");
  const ipButton = $("ipModeButton");
  const phoneButton = $("phoneModeButton");

  if (mode === "ip") {
    ipPanel.classList.remove("hidden");
    hostPanel.classList.add("hidden");

    ipButton.classList.add("active");
    phoneButton.classList.remove("active");

    log("IP ADDRESS LOOKUP mode activated.", "green");
  } else {
    ipPanel.classList.add("hidden");
    hostPanel.classList.remove("hidden");

    ipButton.classList.remove("active");
    phoneButton.classList.add("active");

    log("PHONE CONNECTION mode activated.", "green");
  }
}

$("ipModeButton")?.addEventListener("click", () => {
  switchMode("ip");
});

$("phoneModeButton")?.addEventListener("click", () => {
  switchMode("phone");
});

// IP LOOKUP
async function lookupIp() {
  const input = $("ipTarget");
  const result = $("ipResult");
  const button = $("lookupIp");

  const target = input.value.trim();

  if (!target) {
    result.textContent = "ENTER DOMAIN OR IP ADDRESS.";
    result.className = "device-info error";
    return;
  }

  button.disabled = true;
  button.textContent = "SEARCHING...";

  result.className = "device-info";
  result.textContent = "RESOLVING ADDRESS...";

  log("Starting IP lookup: " + target);

  try {
    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ target })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "IP lookup failed.");
    }

    result.className = "device-info success";

    result.textContent =
      "TARGET: " + data.target +
      "\nTYPE: " + data.type +
      "\nIP ADDRESSES:\n" +
      data.addresses.join("\n");

    log("Lookup completed successfully.", "green");

    data.addresses.forEach(address => {
      log("RESOLVED IP: " + address, "green");
    });

  } catch (error) {
    result.className = "device-info error";
    result.textContent = "ERROR: " + error.message;

    log(error.message, "error");

  } finally {
    button.disabled = false;
    button.textContent = "ВЫЧИСЛИТЬ IP";
  }
}

$("lookupIp")?.addEventListener("click", lookupIp);

$("ipTarget")?.addEventListener("keydown", event => {
  if (event.key === "Enter") lookupIp();
});

async function checkServer() {
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

function connectSocket(role, token = "") {
  return new Promise((resolve, reject) => {
    socket = io({
      auth: {
        roomId,
        role,
        token
      }
    });

    socket.once("connect", () => resolve());

    socket.once("connect_error", error => {
      reject(error);
    });

    socket.on("disconnect", () => {
      log("Signaling connection disconnected.", "error");
      setStatus("DISCONNECTED");
    });

    socket.on("room-expired", () => {
      log("Connection room expired.", "error");
      disconnectEverything();
    });

    socket.on("host-disconnected", () => {
      log("Computer disconnected.", "error");
      showMessage("guestMessage", "Computer disconnected.");
      disconnectEverything();
    });

    socket.on("device-disconnected", () => {
      log("Phone disconnected.", "error");
      setStatus("DEVICE OFFLINE");
      closePeer();
    });
  });
}

function createPeer() {
  closePeer();

  peer = new RTCPeerConnection(rtcConfig);

  peer.onicecandidate = event => {
    if (event.candidate && socket?.connected) {
      socket.emit("signal", {
        type: "ice",
        candidate: event.candidate
      });
    }
  };

  peer.onconnectionstatechange = () => {
    if (!peer) return;

    log("WebRTC: " + peer.connectionState);

    if (peer.connectionState === "connected") {
      setStatus("CONNECTED");
      $("disconnect").disabled = false;
    }

    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected"
    ) {
      setStatus("CONNECTION LOST");
    }
  };

  return peer;
}

async function addQueuedCandidates() {
  if (!peer || !peer.remoteDescription) return;

  for (const candidate of candidateQueue) {
    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      log("ICE candidate error: " + error.message, "error");
    }
  }

  candidateQueue = [];
}

async function receiveSignal(data) {
  if (!data || !peer) return;

  try {
    if (data.type === "ice") {
      if (peer.remoteDescription) {
        await peer.addIceCandidate(data.candidate);
      } else {
        candidateQueue.push(data.candidate);
      }
      return;
    }

    if (data.type === "offer" && !isGuest) {
      await peer.setRemoteDescription(data.description);
      await addQueuedCandidates();

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      socket.emit("signal", {
        type: "answer",
        description: peer.localDescription
      });

      log("WebRTC answer sent.", "green");
    }

    if (data.type === "answer" && isGuest) {
      await peer.setRemoteDescription(data.description);
      await addQueuedCandidates();

      log("WebRTC connection established.", "green");
    }
  } catch (error) {
    log("Signal error: " + error.message, "error");
  }
}

// COMPUTER: create a new session
async function createSession() {
  const button = $("createSession");

  button.disabled = true;
  button.textContent = "CREATING...";

  try {
    const response = await fetch("/api/remote/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not create session");
    }

    roomCode = data.roomId;
    ownerToken = data.ownerToken;

    const link = window.location.origin + "/connect/" + roomCode;

    $("connectionLink").value = link;
    $("sessionExpiry").textContent =
      "Session expires in " + data.expiresIn;

    $("sessionArea").classList.remove("hidden");

    setStatus("WAITING FOR PHONE");

    log("Private session created.", "green");
    log("Send the connection link to your Android phone.");

    await connectSocket("host", ownerToken);

    socket.on("signal", receiveSignal);

    socket.on("guest-ready", () => {
      log("Android device accepted the session.", "green");
      setStatus("DEVICE CONNECTING");
    });

    socket.on("device-location", data => {
      $("locationInfo").textContent =
        "LATITUDE: " + data.latitude +
        " | LONGITUDE: " + data.longitude +
        " | ACCURACY: " + (data.accuracy || "unknown") + " m";

      log("Location voluntarily shared by phone.", "green");
    });

    socket.on("device-disconnected", () => {
      $("deviceInfo").textContent = "NO DEVICE CONNECTED";
      $("remoteVideo").srcObject = null;
      $("videoPlaceholder").classList.remove("hidden");
      $("disconnect").disabled = true;
    });

    createPeer();

    peer.ontrack = event => {
      $("remoteVideo").srcObject = event.streams[0];
      $("videoPlaceholder").classList.add("hidden");
      $("deviceInfo").textContent = "ANDROID DEVICE STREAM ACTIVE";
      log("Remote camera stream received.", "green");
    };

    $("sessionMessage").textContent =
      "Waiting for phone connection...";

    button.textContent = "SESSION CREATED";

  } catch (error) {
    log(error.message, "error");
    button.disabled = false;
    button.textContent = "CREATE CONNECTION";
  }
}

$("createSession")?.addEventListener("click", createSession);

// Copy invitation link
$("copyLink")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      $("connectionLink").value
    );

    $("copyLink").textContent = "COPIED!";

    setTimeout(() => {
      $("copyLink").textContent = "COPY";
    }, 1500);

  } catch {
    $("connectionLink").select();
    document.execCommand("copy");
  }
});

// ANDROID: accept the connection
async function acceptConnection() {
  const button = $("acceptConnection");

  button.disabled = true;
  button.textContent = "REQUESTING PERMISSIONS...";

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera access requires a supported browser and HTTPS."
      );
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    $("localVideo").srcObject = localStream;

    showMessage(
      "guestMessage",
      "Camera and microphone enabled. Connecting..."
    );

    await connectSocket("guest");

    socket.on("signal", receiveSignal);

    createPeer();

    localStream.getTracks().forEach(track => {
      peer.addTrack(track, localStream);
    });

    const offer = await peer.createOffer();

    await peer.setLocalDescription(offer);

    socket.emit("signal", {
      type: "offer",
      description: peer.localDescription
    });

    $("guestControls").classList.remove("hidden");

    showMessage(
      "guestMessage",
      "Connection request sent. You can disconnect at any time."
    );

    button.textContent = "CONNECTED";

    log("Device connection accepted.", "green");

  } catch (error) {
    button.disabled = false;
    button.textContent = "ACCEPT CONNECTION";

    showMessage("guestMessage", error.message);
    log(error.message, "error");

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
  }
}

$("acceptConnection")?.addEventListener(
  "click",
  acceptConnection
);

// ANDROID: voluntarily share location
$("shareLocation")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showMessage(
      "guestMessage",
      "Geolocation is not supported by this browser."
    );
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      if (!socket?.connected) return;

      socket.emit("device-location", {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      });

      showMessage(
        "guestMessage",
        "Location shared with the connected computer."
      );

      log("Location shared.", "green");
    },
    () => {
      showMessage(
        "guestMessage",
        "Location permission denied or unavailable."
      );
    },
    {
      enableHighAccuracy: true,
      timeout: 15000
    }
  );
});

function closePeer() {
  if (peer) {
    peer.ontrack = null;
    peer.close();
    peer = null;
  }

  candidateQueue = [];

  if ($("remoteVideo")) {
    $("remoteVideo").srcObject = null;
    $("videoPlaceholder").classList.remove("hidden");
  }

  if ($("localVideo")) {
    $("localVideo").srcObject = null;
  }
}

function disconnectEverything() {
  closePeer();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  setStatus("DISCONNECTED");

  if ($("disconnect")) {
    $("disconnect").disabled = true;
  }

  if ($("guestControls")) {
    $("guestControls").classList.add("hidden");
  }
}

$("disconnect")?.addEventListener("click", () => {
  disconnectEverything();

  $("deviceInfo").textContent = "NO DEVICE CONNECTED";

  log("Session disconnected.", "green");
});

$("stopConnection")?.addEventListener("click", () => {
  disconnectEverything();

  showMessage("guestMessage", "You disconnected the session.");
  $("acceptConnection").disabled = false;
  $("acceptConnection").textContent = "ACCEPT CONNECTION";
});

// Uptime
const startTime = Date.now();

setInterval(() => {
  const seconds = Math.floor((Date.now() - startTime) / 1000);

  $("uptime").textContent = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60
  ].map(n => String(n).padStart(2, "0")).join(":");

}, 1000);

// Initial page setup
if (isGuest) {
  $("modeSelector").classList.add("hidden");
  $("ipPanel").classList.add("hidden");

  $("hostPanel").classList.add("hidden");
  $("guestPanel").classList.remove("hidden");

  $("status").innerHTML =
    '<span class="online-dot"></span> CONNECTION INVITATION';

  log("Android connection invitation opened.");
  log("Waiting for the device owner's approval.");

} else {
  switchMode("ip");

  checkServer();

  log("HACKER TERMINAL v2.3");
  log("MULTI MODE SYSTEM initialized.", "green");
  log("Select an operation mode.");
}
