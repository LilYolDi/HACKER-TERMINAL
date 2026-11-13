const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const rooms = new Map();
const ROOM_TTL = 60 * 60 * 1000;

function cleanupRooms() {
  const now = Date.now();

  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL) {
      if (room.hostSocket) {
        io.to(room.hostSocket).emit("room-expired");
      }
      if (room.guestSocket) {
        io.to(room.guestSocket).emit("room-expired");
      }
      rooms.delete(id);
    }
  }
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    version: "2.2.0",
    mode: "web-remote-connect"
  });
});

// Create a private connection room.
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

// Socket authentication.
io.use((socket, next) => {
  cleanupRooms();

  const { roomId, role, token } = socket.handshake.auth || {};
  const room = rooms.get(roomId);

  if (!room) {
    return next(new Error("Room not found or expired"));
  }

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

  // Relay WebRTC offer, answer and ICE candidates.
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

  // Relay voluntarily shared location.
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

// Serve the main application and phone connection page.
app.get("/connect/:roomId", (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.roomId)) {
    return res.status(404).send("Invalid connection link");
  }

  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HACKER TERMINAL v2.2 running on port ${PORT}`);
});