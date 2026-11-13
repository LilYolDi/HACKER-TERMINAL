
const $ = id => document.getElementById(id);

const terminal = $("terminal");

const isGuest = /^\/connect\/[a-f0-9]{32}$/.test(
  window.location.pathname
);

const isIpVisitor = /^\/ip\/[a-f0-9]{32}$/.test(
  window.location.pathname
);

const isLocationVisitor = /^\/location\/[a-f0-9]{32}$/.test(
  window.location.pathname
);

const roomId = isGuest
  ? window.location.pathname.split("/").pop()
  : null;

const ipLinkId = isIpVisitor
  ? window.location.pathname.split("/").pop()
  : null;

const locationLinkId = isLocationVisitor
  ? window.location.pathname.split("/").pop()
  : null;

let socket = null;
let peer = null;
let localStream = null;
let ownerToken = "";
let roomCode = "";
let candidateQueue = [];
let activeMode = "ip";
let ipLinkRefreshTimer = null;

// LOCATION TRACKER: independent credentials and state
let locationOwnerToken = "";
let locationRoomCode = "";
let locationRefreshTimer = null;
let displayedLocationIds = new Set();

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
  if (isGuest || isIpVisitor || isLocationVisitor) return;

  activeMode = mode;

  const panels = {
    ip: $("ipPanel"),
    phone: $("hostPanel"),
    location: $("locationPanel")
  };

  const buttons = {
    ip: $("ipModeButton"),
    phone: $("phoneModeButton"),
    location: $("locationModeButton")
  };

  Object.entries(panels).forEach(([name, panel]) => {
    if (panel) {
      panel.classList.toggle("hidden", name !== mode);
    }
  });

  Object.entries(buttons).forEach(([name, button]) => {
    if (button) {
      button.classList.toggle("active", name === mode);
    }
  });

  const messages = {
    ip: "IP ADDRESS LOOKUP mode activated.",
    phone: "PHONE CONNECTION mode activated.",
    location: "LOCATION TRACKER mode activated."
  };

  log(messages[mode] || "Unknown mode.");
}

$("ipModeButton")?.addEventListener("click", () => {
  switchMode("ip");
});

$("phoneModeButton")?.addEventListener("click", () => {
  switchMode("phone");
});

$("locationModeButton")?.addEventListener("click", () => {
  switchMode("location");
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

// CREATE IP LINK
async function createIpLink() {
  const button = $("createIpLink");
  const area = $("ipLinkArea");
  const message = $("ipLinkMessage");

  button.disabled = true;
  button.textContent = "СОЗДАНИЕ...";

  try {
    const response = await fetch("/api/ip-link/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not create IP link.");
    }

    ownerToken = data.ownerToken;
    roomCode = data.linkId;

    $("ipConnectionLink").value = data.link;

    area.classList.remove("hidden");

    message.textContent =
      "ССЫЛКА СОЗДАНА. СРОК ДЕЙСТВИЯ: " + data.expiresIn;

    log("Unique IP link created.", "green");
    log("Link is ready to share.", "green");

    button.textContent = "СОЗДАТЬ ЕЩЁ ССЫЛКУ";
    button.disabled = false;

    await loadVisitorIps();

    if (ipLinkRefreshTimer) {
      clearInterval(ipLinkRefreshTimer);
    }

    ipLinkRefreshTimer = setInterval(loadVisitorIps, 5000);

  } catch (error) {
    message.textContent = "ERROR: " + error.message;

    log(error.message, "error");

    button.disabled = false;
    button.textContent = "СОЗДАТЬ ССЫЛКУ";
  }
}

$("createIpLink")?.addEventListener("click", createIpLink);

// COPY IP LINK
$("copyIpLink")?.addEventListener("click", async () => {
  const input = $("ipConnectionLink");
  const button = $("copyIpLink");

  try {
    await navigator.clipboard.writeText(input.value);

    button.textContent = "COPIED!";
    log("IP link copied.", "green");

    setTimeout(() => {
      button.textContent = "КОПИРОВАТЬ";
    }, 1500);

  } catch {
    input.select();
    document.execCommand("copy");

    button.textContent = "COPIED!";

    setTimeout(() => {
      button.textContent = "КОПИРОВАТЬ";
    }, 1500);
  }
});

// LOAD VISITOR IP LIST
async function loadVisitorIps() {
  if (!roomCode || !ownerToken) return;

  try {
    const response = await fetch(
      "/api/ip-link/" + roomCode + "/visitors",
      {
        headers: {
          "Authorization": "Bearer " + ownerToken
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load visitor list.");
    }

    const list = $("visitorIpList");
    if (!list) return;

    if (!data.visitors || data.visitors.length === 0) {
      list.textContent = "ОЖИДАНИЕ ПОСЕТИТЕЛЕЙ...";
      return;
    }

    list.replaceChildren();

    data.visitors.slice().reverse().forEach(visitor => {
      const entry = document.createElement("div");
      entry.className = "visitor-entry";

      const ip = document.createElement("strong");
      ip.textContent = "IP: " + visitor.ip;

      const date = document.createElement("div");
      date.textContent =
        "TIME: " + new Date(visitor.timestamp).toLocaleString();

      entry.appendChild(ip);
      entry.appendChild(date);

      list.appendChild(entry);
    });

    if (data.visitors.length > 0) {
      log(
        "Visitor IP list updated. Total: " + data.visitors.length,
        "green"
      );
    }

  } catch (error) {
    log("Visitor list: " + error.message, "error");
  }
}

// VISITOR: GIVE IP CONSENT
async function allowIpShare() {
  const button = $("allowIpShare");
  const decline = $("declineIpShare");
  const result = $("visitorIpResult");

  button.disabled = true;
  decline.disabled = true;

  result.className = "device-info";
  result.textContent = "SENDING CONSENTED NETWORK INFORMATION...";

  try {
    const response = await fetch(
      "/api/ip-link/" + ipLinkId + "/consent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          consent: true
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not send IP information.");
    }

    result.className = "device-info success";
    result.textContent =
      "ПЕРЕДАЧА ПОДТВЕРЖДЕНА\n" +
      "ВАШ ПУБЛИЧНЫЙ IP: " + data.ip +
      "\nВРЕМЯ: " + new Date(data.timestamp).toLocaleString();

    $("allowIpShare").classList.add("hidden");
    $("declineIpShare").classList.add("hidden");

  } catch (error) {
    result.className = "device-info error";
    result.textContent = "ERROR: " + error.message;

    button.disabled = false;
    decline.disabled = false;
  }
}

$("allowIpShare")?.addEventListener("click", allowIpShare);

// VISITOR: DECLINE IP
$("declineIpShare")?.addEventListener("click", () => {
  $("visitorIpResult").className = "device-info";
  $("visitorIpResult").textContent =
    "ВЫ ОТКАЗАЛИСЬ ОТ ПЕРЕДАЧИ IP-АДРЕСА.";

  $("allowIpShare").disabled = true;
  $("declineIpShare").disabled = true;

  log("Visitor declined IP sharing.");
});

// ======================================================
// LOCATION TRACKER v2.5
// ======================================================

// OWNER: CREATE LOCATION LINK
async function createLocationLink() {
  const button = $("createLocationLink");
  const area = $("locationLinkArea");
  const message = $("locationLinkMessage");

  if (!button || !area || !message) return;

  button.disabled = true;
  button.textContent = "CREATING LOCATION LINK...";

  try {
    const response = await fetch("/api/location-link/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Could not create location link."
      );
    }

    locationOwnerToken = data.ownerToken;
    locationRoomCode = data.linkId;

    $("locationConnectionLink").value = data.link;

    area.classList.remove("hidden");

    message.textContent =
      "ССЫЛКА СОЗДАНА. СРОК ДЕЙСТВИЯ: " +
      (data.expiresIn || "указан сервером");

    $("visitorLocationList").textContent =
      "ОЖИДАНИЕ РАЗРЕШЕНИЯ ПОСЕТИТЕЛЯ...";

    $("locationMapInfo").textContent =
      "ОЖИДАНИЕ GPS-КООРДИНАТ...";

    $("locationMapLink").classList.add("hidden");

    displayedLocationIds.clear();

    log("LOCATION LINK CREATED.", "green");
    log("Waiting for visitor's explicit permission.", "green");

    button.textContent = "CREATE ANOTHER LINK";
    button.disabled = false;

    await loadVisitorLocations();

    if (locationRefreshTimer) {
      clearInterval(locationRefreshTimer);
    }

    locationRefreshTimer = setInterval(
      loadVisitorLocations,
      5000
    );

  } catch (error) {
    message.textContent = "ERROR: " + error.message;

    log("Location link: " + error.message, "error");

    button.disabled = false;
    button.textContent = "CREATE LOCATION LINK";
  }
}

$("createLocationLink")?.addEventListener(
  "click",
  createLocationLink
);

// COPY LOCATION LINK
$("copyLocationLink")?.addEventListener(
  "click",
  async () => {
    const input = $("locationConnectionLink");
    const button = $("copyLocationLink");

    if (!input || !button) return;

    try {
      await navigator.clipboard.writeText(input.value);

      button.textContent = "COPIED!";
      log("LOCATION LINK COPIED.", "green");

      setTimeout(() => {
        button.textContent = "КОПИРОВАТЬ";
      }, 1500);

    } catch {
      input.select();
      document.execCommand("copy");

      button.textContent = "COPIED!";

      setTimeout(() => {
        button.textContent = "КОПИРОВАТЬ";
      }, 1500);
    }
  }
);

// OWNER: LOAD LOCATION VISITORS
async function loadVisitorLocations() {
  if (!locationRoomCode || !locationOwnerToken) return;

  try {
    const response = await fetch(
      "/api/location-link/" +
      encodeURIComponent(locationRoomCode) +
      "/visitors",
      {
        headers: {
          "Authorization": "Bearer " + locationOwnerToken
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Could not load location data."
      );
    }

    const list = $("visitorLocationList");

    if (!list) return;

    const visitors = Array.isArray(data.visitors)
      ? data.visitors
      : [];

    if (visitors.length === 0) {
      list.textContent =
        "ОЖИДАНИЕ ДАННЫХ О МЕСТОПОЛОЖЕНИИ...";
      return;
    }

    list.replaceChildren();

    visitors.slice().reverse().forEach(visitor => {
      const entry = document.createElement("div");
      entry.className = "visitor-entry";

      const title = document.createElement("strong");
      title.textContent = "LOCATION RECEIVED";

      const details = document.createElement("div");

      const latitude = Number(visitor.latitude);
      const longitude = Number(visitor.longitude);

      const validCoordinates =
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180;

      const rows = [];

      if (visitor.country) {
        rows.push("СТРАНА: " + visitor.country);
      }

      if (visitor.region) {
        rows.push("ОБЛАСТЬ: " + visitor.region);
      }

      if (visitor.city) {
        rows.push("ГОРОД: " + visitor.city);
      }

      if (visitor.district) {
        rows.push("РАЙОН: " + visitor.district);
      }

      if (visitor.address) {
        rows.push("АДРЕС: " + visitor.address);
      }

      if (validCoordinates) {
        rows.push("LATITUDE: " + latitude);
        rows.push("LONGITUDE: " + longitude);
      }

      if (visitor.accuracy !== undefined) {
        rows.push("GPS ACCURACY: " + visitor.accuracy + " m");
      }

      rows.push(
        "TIME: " +
        new Date(visitor.timestamp).toLocaleString()
      );

      details.textContent = rows.join("\n");

      entry.appendChild(title);
      entry.appendChild(details);

      if (validCoordinates) {
        const mapLink = document.createElement("a");

        mapLink.href =
          "https://www.google.com/maps?q=" +
          encodeURIComponent(latitude + "," + longitude);

        mapLink.target = "_blank";
        mapLink.rel = "noopener noreferrer";
        mapLink.textContent = "OPEN ON MAP";

        entry.appendChild(mapLink);

        $("locationMapInfo").textContent =
          "LATITUDE: " + latitude +
          "\nLONGITUDE: " + longitude +
          "\nACCURACY: " +
          (visitor.accuracy ?? "UNKNOWN") + " m";

        const mainMapLink = $("locationMapLink");

        mainMapLink.href = mapLink.href;
        mainMapLink.classList.remove("hidden");
      }

      list.appendChild(entry);

      const visitorId =
        visitor.id ||
        String(visitor.timestamp) + ":" +
        String(visitor.latitude) + ":" +
        String(visitor.longitude);

      if (!displayedLocationIds.has(visitorId)) {
        displayedLocationIds.add(visitorId);

        log("NEW CONSENTED LOCATION RECEIVED.", "green");

        if (visitor.city) {
          log("CITY: " + visitor.city, "green");
        }

        if (visitor.address) {
          log("ADDRESS: " + visitor.address, "green");
        }

        if (validCoordinates) {
          log(
            "GPS: " + latitude + ", " + longitude,
            "green"
          );
        }
      }
    });

  } catch (error) {
    log("Location list: " + error.message, "error");
  }
}

// VISITOR: REQUEST LOCATION AFTER CONSENT
async function allowLocationShare() {
  const button = $("allowLocationShare");
  const decline = $("declineLocationShare");
  const result = $("visitorLocationResult");

  if (!button || !decline || !result) return;

  if (!navigator.geolocation) {
    result.className = "device-info error";
    result.textContent =
      "ГЕОЛОКАЦИЯ НЕ ПОДДЕРЖИВАЕТСЯ ЭТИМ БРАУЗЕРОМ.";

    return;
  }

  button.disabled = true;
  decline.disabled = true;

  result.className = "device-info";
  result.textContent =
    "ОЖИДАНИЕ РАЗРЕШЕНИЯ ГЕОЛОКАЦИИ БРАУЗЕРОМ...";

  log("Visitor requested GPS permission.");

  navigator.geolocation.getCurrentPosition(
    async position => {
      try {
        result.textContent =
          "РАЗРЕШЕНИЕ ПОЛУЧЕНО. ОТПРАВКА КООРДИНАТ...";

        const response = await fetch(
          "/api/location-link/" +
          encodeURIComponent(locationLinkId) +
          "/consent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              consent: true,
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Could not send location."
          );
        }

        result.className = "device-info success";

        result.textContent =
          "МЕСТОПОЛОЖЕНИЕ УСПЕШНО ПЕРЕДАНО.\n" +
          "LATITUDE: " + position.coords.latitude +
          "\nLONGITUDE: " + position.coords.longitude +
          "\nACCURACY: " + position.coords.accuracy + " m" +
          "\nTIME: " + new Date().toLocaleString();

        button.classList.add("hidden");
        decline.classList.add("hidden");

        log("Location voluntarily shared.", "green");

      } catch (error) {
        result.className = "device-info error";
        result.textContent = "ERROR: " + error.message;

        button.disabled = false;
        decline.disabled = false;
      }
    },

    error => {
      result.className = "device-info error";

      const messages = {
        1: "ВЫ ОТКАЗАЛИ В ДОСТУПЕ К ГЕОЛОКАЦИИ.",
        2: "МЕСТОПОЛОЖЕНИЕ НЕДОСТУПНО.",
        3: "ВРЕМЯ ОЖИДАНИЯ ГЕОЛОКАЦИИ ИСТЕКЛО."
      };

      result.textContent =
        messages[error.code] ||
        "НЕ УДАЛОСЬ ПОЛУЧИТЬ МЕСТОПОЛОЖЕНИЕ.";

      button.disabled = false;
      decline.disabled = false;

      log(result.textContent, "error");
    },

    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    }
  );
}

$("allowLocationShare")?.addEventListener(
  "click",
  allowLocationShare
);

// VISITOR: DECLINE LOCATION
$("declineLocationShare")?.addEventListener(
  "click",
  () => {
    const result = $("visitorLocationResult");

    result.className = "device-info";
    result.textContent =
      "ВЫ ОТКАЗАЛИСЬ ОТ ПЕРЕДАЧИ МЕСТОПОЛОЖЕНИЯ.";

    $("allowLocationShare").disabled = true;
    $("declineLocationShare").disabled = true;

    log("Visitor declined location sharing.");
  }
);

// SERVER STATUS
async function checkServer() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();

    if ($("serverStatus")) {
      $("serverStatus").textContent = data.status.toUpperCase();
    }

    if ($("status")) {
      $("status").innerHTML =
        '<span class="online-dot"></span> SYSTEM ONLINE';
    }

  } catch {
    if ($("serverStatus")) {
      $("serverStatus").textContent = "OFFLINE";
    }

    if ($("status")) {
      $("status").textContent = "SERVER OFFLINE";
    }
  }
}

// SOCKET CONNECTION
function connectSocket(role, token = "") {
  return new Promise((resolve, reject) => {
    socket = io({
      auth: {
        roomId: isGuest ? roomId : roomCode,
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

// WEBRTC
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

// COMPUTER: CREATE PHONE SESSION
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

// COPY PHONE INVITATION LINK
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

// ANDROID: ACCEPT CONNECTION
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

// ANDROID: VOLUNTARILY SHARE LOCATION
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

// DISCONNECT
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

// UPTIME
const startTime = Date.now();

if ($("uptime")) {
  setInterval(() => {
    const seconds = Math.floor((Date.now() - startTime) / 1000);

    $("uptime").textContent = [
      Math.floor(seconds / 3600),
      Math.floor((seconds % 3600) / 60),
      seconds % 60
    ].map(n => String(n).padStart(2, "0")).join(":");

  }, 1000);
}

// INITIAL PAGE SETUP
if (isLocationVisitor) {
  $("modeSelector")?.classList.add("hidden");
  $("ipPanel")?.classList.add("hidden");
  $("hostPanel")?.classList.add("hidden");
  $("guestPanel")?.classList.add("hidden");
  $("visitorPanel")?.classList.add("hidden");
  $("locationPanel")?.classList.add("hidden");

  $("locationVisitorPanel")?.classList.remove("hidden");

  if ($("status")) {
    $("status").innerHTML =
      '<span class="online-dot"></span> LOCATION CONSENT REQUEST';
  }

  log("LOCATION invitation opened.");
  log("Waiting for visitor's explicit permission.");

} else if (isIpVisitor) {
  $("modeSelector")?.classList.add("hidden");
  $("ipPanel")?.classList.add("hidden");
  $("hostPanel")?.classList.add("hidden");
  $("guestPanel")?.classList.add("hidden");
  $("locationPanel")?.classList.add("hidden");
  $("locationVisitorPanel")?.classList.add("hidden");

  $("visitorPanel")?.classList.remove("hidden");

  if ($("status")) {
    $("status").innerHTML =
      '<span class="online-dot"></span> IP CONSENT REQUEST';
  }

  log("IP information request opened.");
  log("Waiting for visitor consent.");

} else if (isGuest) {
  $("modeSelector")?.classList.add("hidden");
  $("ipPanel")?.classList.add("hidden");
  $("hostPanel")?.classList.add("hidden");
  $("visitorPanel")?.classList.add("hidden");
  $("locationPanel")?.classList.add("hidden");
  $("locationVisitorPanel")?.classList.add("hidden");

  $("guestPanel")?.classList.remove("hidden");

  $("status").innerHTML =
    '<span class="online-dot"></span> CONNECTION INVITATION';

  log("Android connection invitation opened.");
  log("Waiting for the device owner's approval.");

} else {
  $("visitorPanel")?.classList.add("hidden");
  $("locationVisitorPanel")?.classList.add("hidden");

  switchMode("ip");

  checkServer();

  log("HACKER TERMINAL v2.5");
  log("MULTI MODE SYSTEM initialized.", "green");
  log("LOCATION TRACKER module loaded.", "green");
  log("Select an operation mode.");
}
