const express = require("express");
const dns = require("dns").promises;
const tls = require("tls");
const net = require("net");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

const trackers = new Map();
const MAX_TRACKERS = 500;
const MAX_EVENTS = 100;
const TRACKER_TTL = 7 * 24 * 60 * 60 * 1000;

function validateHost(value) {
  if (typeof value !== "string" || value.length > 253) {
    throw new Error("Invalid hostname");
  }

  const host = value.trim().toLowerCase();

  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new Error("Enter a valid domain name");
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Private hostnames are not supported");
  }

  return host;
}

async function resolvePublicHost(host) {
  const records = await dns.lookup(host, { all: true });

  if (!records.length) throw new Error("DNS lookup failed");

  for (const record of records) {
    const ip = record.address;

    const privateV4 =
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|192\.0\.0\.|198\.18\.|198\.19\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip) ||
      ip === "255.255.255.255";

    const privateV6 =
      ip === "::1" ||
      ip === "::" ||
      /^f[cd]/i.test(ip) ||
      /^fe[89ab]/i.test(ip) ||
      /^::ffff:/i.test(ip);

    if (privateV4 || privateV6) {
      throw new Error("Private or reserved IP address is not allowed");
    }
  }

  return records;
}

function checkAllowed(host) {
  const allowed = (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  if (!allowed.includes(host)) {
    const error = new Error(
      "Domain not authorized. Add it to ALLOWED_HOSTS in Render."
    );
    error.status = 403;
    throw error;
  }
}

function cleanupTrackers() {
  const now = Date.now();

  for (const [id, item] of trackers) {
    if (now - item.createdAt > TRACKER_TTL) {
      trackers.delete(id);
    }
  }
}

function getBearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function ownerAuthorized(req, expected) {
  const received = Buffer.from(getBearer(req));
  const correct = Buffer.from(expected);

  return received.length === correct.length &&
    crypto.timingSafeEqual(received, correct);
}

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    mode: "real-diagnostics",
    version: "2.1.0"
  });
});

// Create a unique consent-based tracking link.
app.post("/api/track/create", (req, res) => {
  cleanupTrackers();

  if (trackers.size >= MAX_TRACKERS) {
    return res.status(429).json({
      error: "Too many active links. Try again later."
    });
  }

  const id = crypto.randomBytes(18).toString("hex");
  const ownerToken = crypto.randomBytes(32).toString("hex");

  trackers.set(id, {
    ownerToken,
    createdAt: Date.now(),
    events: []
  });

  const base = `${req.protocol}://${req.get("host")}`;

  res.json({
    success: true,
    link: `${base}/t/${id}`,
    ownerToken,
    expiresIn: "7 days"
  });
});

// Consent page. A page visit alone does not save the visitor IP.
app.get("/t/:id", (req, res) => {
  cleanupTrackers();

  if (!trackers.has(req.params.id)) {
    return res.status(404).send("Link not found or expired.");
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visitor consent</title>
</head>
<body style="margin:0;background:#020603;color:#00ff66;font:16px Consolas,monospace;display:grid;min-height:100vh;place-items:center">
<main style="max-width:520px;padding:28px;border:1px solid #00a844;background:#07100a">
<h2>VISIT NOTICE</h2>
<p>The person who shared this link requests permission to record your public IP address and visit time for a visit log.</p>
<p>An IP address does not reveal your exact home address.</p>
<p>Your IP will be recorded only if you press "I AGREE". If you decline, this tracker will not save your IP address.</p>
<button id="yes" style="padding:12px;background:#00ff66;border:0;cursor:pointer">I AGREE</button>
<button id="no" style="padding:12px;background:#111;color:#00ff66;border:1px solid #00a844;cursor:pointer">DECLINE</button>
<p id="msg" aria-live="polite"></p>
</main>
<script>
const id = ${JSON.stringify(req.params.id)};
const msg = document.getElementById("msg");

async function choose(agree) {
  document.getElementById("yes").disabled = true;
  document.getElementById("no").disabled = true;

  if (!agree) {
    msg.textContent = "You declined. No visit IP was saved.";
    return;
  }

  try {
    const response = await fetch("/api/track/" + id + "/consent", {
      method: "POST"
    });

    const data = await response.json();

    msg.textContent = response.ok
      ? "Consent recorded. Thank you."
      : (data.error || "Unable to record consent.");
  } catch {
    msg.textContent = "Connection error. No confirmation received.";
  }
}

document.getElementById("yes").onclick = () => choose(true);
document.getElementById("no").onclick = () => choose(false);
</script>
</body>
</html>`);
});

// Record IP only after the visitor explicitly agrees.
app.post("/api/track/:id/consent", (req, res) => {
  cleanupTrackers();

  const item = trackers.get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: "Link not found or expired" });
  }

  if (item.events.length >= MAX_EVENTS) {
    return res.status(429).json({ error: "Visit limit reached" });
  }

  const ip = String(req.ip || "unknown").replace(/^::ffff:/, "");

  item.events.push({
    ip,
    time: new Date().toISOString(),
    status: "CONSENTED"
  });

  res.json({ success: true });
});

// Only the link creator can access the visit log.
app.get("/api/track/:id/events", (req, res) => {
  cleanupTrackers();

  const item = trackers.get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: "Link not found or expired" });
  }

  if (!ownerAuthorized(req, item.ownerToken)) {
    return res.status(403).json({
      error: "Owner authorization required"
    });
  }

  res.json({
    success: true,
    events: item.events
  });
});

// DNS analysis
app.post("/api/dns", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(host);

    const addresses = await resolvePublicHost(host);

    const [mx, ns, txt] = await Promise.allSettled([
      dns.resolveMx(host),
      dns.resolveNs(host),
      dns.resolveTxt(host)
    ]);

    res.json({
      success: true,
      host,
      addresses,
      mx: mx.status === "fulfilled" ? mx.value : [],
      ns: ns.status === "fulfilled" ? ns.value : [],
      txt: txt.status === "fulfilled" ? txt.value : []
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// SSL certificate check
app.post("/api/ssl", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(host);
    await resolvePublicHost(host);

    const result = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: false,
        timeout: 8000
      }, () => {
        const cert = socket.getPeerCertificate();

        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError || null,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          fingerprint: cert.fingerprint256
        });

        socket.end();
      });

      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("SSL connection timeout"));
      });

      socket.on("error", reject);
    });

    res.json({ success: true, host, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// HTTP security headers
app.post("/api/headers", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(host);
    await resolvePublicHost(host);

    const result = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: host,
        path: "/",
        method: "HEAD",
        timeout: 8000
      }, response => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers
        });
      });

      request.on("timeout", () => {
        request.destroy(new Error("Request timeout"));
      });

      request.on("error", reject);
      request.end();
    });

    const securityHeaders = [
      "strict-transport-security",
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy"
    ];

    const checks = {};

    for (const header of securityHeaders) {
      checks[header] = Boolean(result.headers[header]);
    }

    res.json({
      success: true,
      host,
      statusCode: result.statusCode,
      checks,
      headers: result.headers
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Selected TCP port check
app.post("/api/ports", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(host);
    await resolvePublicHost(host);

    const ports = [80, 443, 8080, 8443];

    const results = await Promise.all(
      ports.map(port => new Promise(resolve => {
        const socket = new net.Socket();
        let finished = false;

        function done(open) {
          if (finished) return;
          finished = true;
          socket.destroy();

          resolve({
            port,
            status: open ? "OPEN" : "CLOSED"
          });
        }

        socket.setTimeout(2500);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        socket.connect(port, host);
      }))
    );

    res.json({ success: true, host, results });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HACKER TERMINAL running on ${PORT}`);
});