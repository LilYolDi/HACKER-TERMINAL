
const express = require("express");
const dns = require("dns").promises;
const tls = require("tls");
const net = require("net");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

function validateHost(value) {
  if (typeof value !== "string" || value.length > 253) {
    throw new Error("Invalid hostname");
  }

  const host = value.trim().toLowerCase();

  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new Error("Enter a valid domain name");
  }

  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) {
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
      ip === "::1" || ip === "::" ||
      /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip) ||
      /^::ffff:/i.test(ip);

    if (privateV4 || privateV6) {
      throw new Error("Private or reserved IP address is not allowed");
    }
  }

  return records;
}

function checkAllowed(req, host) {
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

app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    mode: "real-diagnostics",
    version: "2.0.0"
  });
});

app.post("/api/dns", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(req, host);
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

app.post("/api/ssl", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(req, host);
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
        const authorized = socket.authorized;
        const error = socket.authorizationError;

        resolve({
          authorized,
          authorizationError: error || null,
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
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/headers", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(req, host);
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
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/ports", async (req, res) => {
  try {
    const host = validateHost(req.body.host);
    checkAllowed(req, host);
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
          resolve({ port, status: open ? "OPEN" : "CLOSED" });
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
