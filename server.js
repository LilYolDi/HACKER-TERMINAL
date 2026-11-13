
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

const ROOM_TTL = 60 * 60 * 1000;
const IP_LINK_TTL = 24 * 60 * 60 * 1000;

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

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    version: "2.4.0",
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HACKER TERMINAL v2.4 running on port ${PORT}`);
});
