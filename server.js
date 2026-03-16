#!/usr/bin/env node
// server.js  — SSH terminal backend
// deps: npm i ws ssh2 ssh-config express

import { createServer } from "http";
import { WebSocketServer } from "ws";
import { Client } from "ssh2";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import express from "express";
import SSHConfig from "ssh-config";

const PORT = process.env.PORT ?? 3001;
const HOME = homedir();

// ── Parse ~/.ssh/config ───────────────────────────────────────────────────────
function loadSSHConfig() {
  const path = join(HOME, ".ssh", "config");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const cfg = SSHConfig.parse(raw);
  const hosts = [];
  for (const entry of cfg) {
    if (entry.param !== "Host") continue;
    const host = entry.value;
    if (!host || host === "*") continue;
    const resolved = cfg.compute(host);
    hosts.push({
      name: host,
      host: resolved.HostName ?? host,
      port: Number(resolved.Port ?? 22),
      user: resolved.User ?? process.env.USER ?? "user",
      identityFile: resolved.IdentityFile
        ? resolved.IdentityFile.replace("~", HOME)
        : join(HOME, ".ssh", "id_rsa"),
    });
  }
  return hosts;
}

// ── Express REST ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Serve built frontend when running as a packaged Electron app
const distPath = join(__dirname, "client", "dist");
if (existsSync(distPath)) app.use(express.static(distPath));

app.get("/hosts", (_, res) => {
  try { res.json(loadSSHConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/commands", (_, res) => {
  try {
    const p = join(__dirname, "commands.json");
    res.json(existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/terminal" });

wss.on("connection", (ws) => {
  let ssh = null;
  let stream = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ── Connect ─────────────────────────────────────────────────────────────
      case "connect": {
        const { host, port, user, identityFile } = msg;
        ssh = new Client();

        const connOpts = {
          host, port: port ?? 22, username: user,
          // Try agent first, fall back to identity file
          agent: process.env.SSH_AUTH_SOCK,
          tryKeyboard: false,
          readyTimeout: 10_000,
        };

        // Load identity file if agent isn't available / configured
        const keyPath = identityFile ?? join(HOME, ".ssh", "id_rsa");
        if (!process.env.SSH_AUTH_SOCK && existsSync(keyPath)) {
          connOpts.privateKey = readFileSync(keyPath);
        }

        ssh.on("ready", () => {
          ws.send(JSON.stringify({ type: "status", status: "connected" }));

          ssh.shell({ term: "xterm-256color", cols: msg.cols ?? 80, rows: msg.rows ?? 24 }, (err, s) => {
            if (err) {
              ws.send(JSON.stringify({ type: "error", message: err.message }));
              return;
            }
            stream = s;
            stream.on("data", (d) => ws.send(JSON.stringify({ type: "data", data: d.toString("base64") })));
            stream.stderr.on("data", (d) => ws.send(JSON.stringify({ type: "data", data: d.toString("base64") })));
            stream.on("close", () => ws.send(JSON.stringify({ type: "status", status: "disconnected" })));
          });
        });

        ssh.on("error", (e) => ws.send(JSON.stringify({ type: "error", message: e.message })));
        ssh.connect(connOpts);
        break;
      }

      // ── Keyboard input ───────────────────────────────────────────────────────
      case "data": {
        stream?.write(Buffer.from(msg.data, "base64"));
        break;
      }

      // ── Terminal resize ──────────────────────────────────────────────────────
      case "resize": {
        stream?.setWindow(msg.rows, msg.cols, 0, 0);
        break;
      }

      // ── Disconnect ───────────────────────────────────────────────────────────
      case "disconnect": {
        stream?.close();
        ssh?.end();
        break;
      }
    }
  });

  ws.on("close", () => {
    stream?.close();
    ssh?.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SSH terminal backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Hosts found in ~/.ssh/config: ${loadSSHConfig().map(h => h.name).join(", ") || "none"}`);
});