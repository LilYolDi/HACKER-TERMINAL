
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const rooms = new Map();
const ipLinks = new Map();
const locationLinks = new Map();

const ROOM_TTL = 60 * 60 * 1000;
const IP_LINK_TTL = 24 * 60 * 60 * 1000;
const LOCATION_LINK_TTL = 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function cleanupRooms() {
  const now = Date.now();

  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL) {
      if (room.hostSocket) io.to(room.hostSocket).emit("room-expired");
      if (room.guestSocket) io.to(room.guestSocket).emit("room-expired");
      rooms.delete(id);
    }
  }
}

function cleanupIpLinks() {
  const now = Date.now();

  for (const [id, link] of ipLinks) {
    if (now - link.createdAt > IP_LINK_TTL) {
      ipLinks.delete(id);
    }
  }
}

function cleanupLocationLinks() {
  const now = Date.now();

  for (const [id, link] of locationLinks) {
    if (now - link.createdAt > LOCATION_LINK_TTL) {
      locationLinks.delete(id);
    }
  }
}

function validLinkId(id) {
  return /^[a-f0-9]{32}$/.test(String(id || ""));
}

// Reverse geocoding is performed only after explicit visitor consent.
async function reverseGeocode(latitude, longitude) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");

  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "HACKER-TERMINAL-LOCATION-TRACKER/2.5"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("Geocoding service unavailable.");
    }

    const data = await response.json();
    const address = data.address || {};

    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      "";

    const region =
      address.state ||
      address.region ||
      address.province ||
      address.state_district ||
      "";

    const district =
      address.city_district ||
      address.district ||
      address.suburb ||
      address.neighbourhood ||
      address.county ||
      "";

    return {
      country: address.country || "",
      region,
      city,
      district,
      address: data.display_name || ""
    };

  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    version: "2.5.0",
    mode: "multi-mode-system"
  });
});

// DNS / IP LOOKUP
app.post("/api/lookup", async (req, res) => {
  try {
    let target = String(req.body.target || "").trim();

    if (!target || target.length > 253) {
      return res.status(400).json({
        error: "Enter a valid domain or IP address."
      });
    }

    if (target.includes("://") || /[/\\\s@]/.test(target)) {
      return res.status(400).json({
        error: "Enter only a domain or IP address."
      });
    }

    if (net.isIP(target)) {
      return res.json({
        success: true,
        target,
        addresses: [target],
        type: "IP ADDRESS"
      });
    }

    target = target.replace(/\.$/, "").toLowerCase();

    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(target)
    ) {
      return res.status(400).json({
        error: "Invalid domain name."
      });
    }

    const records = await dns.lookup(target, {
      all: true,
      verbatim: true
    });

    const addresses = [...new Set(records.map(item => item.address))];

    if (!addresses.length) {
      throw new Error("No IP addresses found.");
    }

    res.json({
      success: true,
      target,
      addresses,
      type: "DNS LOOKUP"
    });

  } catch (error) {
    res.status(404).json({
      error: "Could not resolve domain. Check the address and try again."
    });
  }
});

// CREATE IP LINK
app.post("/api/ip-link/create", (req, res) => {
  cleanupIpLinks();

  if (ipLinks.size >= 300) {
    return res.status(429).json({
      error: "Too many active links. Try again later."
    });
  }

  const linkId = crypto.randomBytes(16).toString("hex");
  const ownerToken = crypto.randomBytes(32).toString("hex");

  ipLinks.set(linkId, {
    ownerToken,
    createdAt: Date.now(),
    visitors: []
  });

  res.json({
    success: true,
    linkId,
    ownerToken,
    link: `${req.protocol}://${req.get("host")}/ip/${linkId}`,
    expiresIn: "24 hours"
  });
});

// VISITOR CONSENT AND IP RECEIPT
app.post("/api/ip-link/:linkId/consent", (req, res) => {
  cleanupIpLinks();

  const link = ipLinks.get(req.params.linkId);

  if (!link) {
    return res.status(404).json({
      error: "Link not found or expired."
    });
  }

  if (link.visitors.length >= 100) {
    return res.status(429).json({
      error: "Visitor limit reached."
    });
  }

  // IP is collected only after the visitor explicitly presses consent.
  const visitorIp = String(req.ip || "").slice(0, 100);

  if (!visitorIp) {
    return res.status(400).json({
      error: "Could not determine network IP."
    });
  }

  const visitor = {
    id: crypto.randomBytes(8).toString("hex"),
    ip: visitorIp,
    timestamp: new Date().toISOString()
  };

  link.visitors.push(visitor);

  console.log(
    `[IP LINK] Consent received. IP: ${visitorIp}`
  );

  res.json({
    success: true,
    ip: visitorIp,
    timestamp: visitor.timestamp
  });
});

// OWNER: GET VISITOR IP LOG
app.get("/api/ip-link/:linkId/visitors", (req, res) => {
  cleanupIpLinks();

  const link = ipLinks.get(req.params.linkId);

  if (!link) {
    return res.status(404).json({
      error: "Link not found or expired."
    });
  }

  const token = req.get("Authorization") || "";
  const ownerToken = token.startsWith("Bearer ")
    ? token.slice(7)
    : "";

  if (!safeEqual(ownerToken, link.ownerToken)) {
    return res.status(403).json({
      error: "Owner authorization failed."
    });
  }

  res.json({
    success: true,
    visitors: link.visitors
  });
});

// ============================================
// LOCATION TRACKER
// ============================================

// CREATE LOCATION LINK
app.post("/api/location-link/create", (req, res) => {
  cleanupLocationLinks();

  if (locationLinks.size >= 300) {
    return res.status(429).json({
      error: "Too many active location links. Try again later."
    });
  }

  const linkId = crypto.randomBytes(16).toString("hex");
  const ownerToken = crypto.randomBytes(32).toString("hex");

  locationLinks.set(linkId, {
    ownerToken,
    createdAt: Date.now(),
    visitors: []
  });

  res.json({
    success: true,
    linkId,
    ownerToken,
    link: `${req.protocol}://${req.get("host")}/location/${linkId}`,
    expiresIn: "24 hours"
  });

  console.log(`[LOCATION] New location link created: ${linkId}`);
});

// VISITOR: EXPLICIT CONSENT AND GPS SUBMISSION
app.post("/api/location-link/:id/consent", async (req, res) => {
  cleanupLocationLinks();

  const linkId = req.params.id;

  if (!validLinkId(linkId)) {
    return res.status(400).json({
      error: "Invalid location link."
    });
  }

  const link = locationLinks.get(linkId);

  if (!link) {
    return res.status(404).json({
      error: "Link not found or expired."
    });
  }

  // Consent must be explicitly confirmed by the visitor.
  if (req.body.consent !== true) {
    return res.status(403).json({
      error: "Location sharing consent is required."
    });
  }

  const latitude = req.body.latitude;
  const longitude = req.body.longitude;
  const accuracy = req.body.accuracy;

  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({
      error: "Invalid GPS coordinates."
    });
  }

  if (
    typeof accuracy !== "number" ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  ) {
    return res.status(400).json({
      error: "Invalid GPS accuracy."
    });
  }

  if (link.visitors.length >= 100) {
    return res.status(429).json({
      error: "Visitor limit reached."
    });
  }

  // Coordinates are retained even if reverse geocoding fails.
  let geographicData = {
    country: "",
    region: "",
    city: "",
    district: "",
    address: ""
  };

  try {
    geographicData = await reverseGeocode(latitude, longitude);
  } catch (error) {
    console.error(
      "[LOCATION] Reverse geocoding failed:",
      error.message
    );
  }

  const visitor = {
    id: crypto.randomBytes(8).toString("hex"),
    country: geographicData.country,
    region: geographicData.region,
    city: geographicData.city,
    district: geographicData.district,
    address: geographicData.address,
    latitude,
    longitude,
    accuracy,
    timestamp: new Date().toISOString()
  };

  link.visitors.push(visitor);

  console.log(
    `[LOCATION] Visitor consent received. Coordinates: ${latitude}, ${longitude}`
  );

  res.json({
    success: true,
    ...visitor
  });
});

// OWNER: GET VISITOR LOCATION LOG
app.get("/api/location-link/:id/visitors", (req, res) => {
  cleanupLocationLinks();

  const linkId = req.params.id;

  if (!validLinkId(linkId)) {
    return res.status(400).json({
      error: "Invalid location link."
    });
  }

  const link = locationLinks.get(linkId);

  if (!link) {
    return res.status(404).json({
      error: "Link not found or expired."
    });
  }

  const token = req.get("Authorization") || "";
  const ownerToken = token.startsWith("Bearer ")
    ? token.slice(7)
    : "";

  if (!safeEqual(ownerToken, link.ownerToken)) {
    return res.status(403).json({
      error: "Owner authorization failed."
    });
  }

  res.json({
    success: true,
    visitors: link.visitors
  });
});

// ============================================
// END LOCATION TRACKER
// ============================================

// CREATE A PRIVATE PHONE CONNECTION ROOM
app.post("/api/remote/create", (req, res) => {
  cleanupRooms();

  if (rooms.size >= 300) {
    return res.status(429).json({
      error: "Too many active rooms. Try again later."
    });
  }

  const roomId = crypto.randomBytes(16).toString("hex");
  const ownerToken = crypto.randomBytes(32).toString("hex");

  rooms.set(roomId, {
    ownerToken,
    createdAt: Date.now(),
    hostSocket: null,
    guestSocket: null
  });

  res.json({
    success: true,
    roomId,
    ownerToken,
    link: `${req.protocol}://${req.get("host")}/connect/${roomId}`,
    expiresIn: "1 hour"
  });
});

// SOCKET AUTHENTICATION
io.use((socket, next) => {
  cleanupRooms();

  const { roomId, role, token } = socket.handshake.auth || {};
  const room = rooms.get(roomId);

  if (!room) return next(new Error("Room not found or expired"));

  if (role !== "host" && role !== "guest") {
    return next(new Error("Invalid connection role"));
  }

  if (role === "host" && !safeEqual(token, room.ownerToken)) {
    return next(new Error("Owner authorization failed"));
  }

  if (role === "guest" && room.guestSocket) {
    return next(new Error("A phone is already connected"));
  }

  socket.roomId = roomId;
  socket.role = role;

  next();
});

io.on("connection", socket => {
  const room = rooms.get(socket.roomId);

  if (!room) {
    socket.disconnect(true);
    return;
  }

  if (socket.role === "host") {
    room.hostSocket = socket.id;

    socket.emit("connection-status", {
      status: room.guestSocket ? "device-connected" : "waiting"
    });

    if (room.guestSocket) {
      io.to(room.guestSocket).emit("host-ready");
    }
  }

  if (socket.role === "guest") {
    room.guestSocket = socket.id;

    socket.emit("connection-status", {
      status: "connected"
    });

    if (room.hostSocket) {
      io.to(room.hostSocket).emit("guest-ready");
      socket.emit("host-ready");
    }
  }

  socket.on("signal", data => {
    const currentRoom = rooms.get(socket.roomId);

    if (!currentRoom || !data || typeof data !== "object") return;
    if (!["offer", "answer", "ice"].includes(data.type)) return;

    const destination = socket.role === "host"
      ? currentRoom.guestSocket
      : currentRoom.hostSocket;

    if (destination) {
      io.to(destination).emit("signal", data);
    }
  });

  socket.on("device-location", data => {
    if (socket.role !== "guest") return;

    const currentRoom = rooms.get(socket.roomId);
    if (!currentRoom || !currentRoom.hostSocket) return;

    if (
      !data ||
      typeof data.latitude !== "number" ||
      typeof data.longitude !== "number"
    ) return;

    io.to(currentRoom.hostSocket).emit("device-location", {
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: Number(data.accuracy) || null
    });
  });

  socket.on("disconnect", () => {
    const currentRoom = rooms.get(socket.roomId);
    if (!currentRoom) return;

    if (socket.role === "host" && currentRoom.hostSocket === socket.id) {
      currentRoom.hostSocket = null;

      if (currentRoom.guestSocket) {
        io.to(currentRoom.guestSocket).emit("host-disconnected");
      }
    }

    if (socket.role === "guest" && currentRoom.guestSocket === socket.id) {
      currentRoom.guestSocket = null;

      if (currentRoom.hostSocket) {
        io.to(currentRoom.hostSocket).emit("device-disconnected");
      }
    }
  });
});

// PHONE CONNECTION PAGE
app.get("/connect/:roomId", (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.roomId)) {
    return res.status(404).send("Invalid connection link");
  }

  res.sendFile(path.join(__dirname, "index.html"));
});

// IP LINK VISITOR PAGE
app.get("/ip/:linkId", (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.linkId)) {
    return res.status(404).send("Invalid IP link");
  }

  cleanupIpLinks();

  if (!ipLinks.has(req.params.linkId)) {
    return res.status(404).send("Link not found or expired");
  }

  res.sendFile(path.join(__dirname, "index.html"));
});

// LOCATION TRACKER VISITOR PAGE
app.get("/location/:id", (req, res) => {
  if (!validLinkId(req.params.id)) {
    return res.status(404).send("Invalid location link");
  }

  cleanupLocationLinks();

  if (!locationLinks.has(req.params.id)) {
    return res.status(404).send("Link not found or expired");
  }

  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HACKER TERMINAL v2.5 running on port ${PORT}`);
});
