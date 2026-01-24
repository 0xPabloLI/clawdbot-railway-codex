import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR = process.env.CLAWDBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".clawdbot");
const WORKSPACE_DIR = process.env.CLAWDBOT_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects Clawdbot gateway + Control UI). If not provided, generate one.
const CLAWDBOT_GATEWAY_TOKEN =
  process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");
process.env.CLAWDBOT_GATEWAY_TOKEN = CLAWDBOT_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const CLAWDBOT_BIN = process.env.CLAWDBOT_BIN?.trim() || "clawdbot";

function configPath() {
  return process.env.CLAWDBOT_CONFIG_PATH?.trim() || path.join(STATE_DIR, "clawdbot.json");
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;

function startGatewayIfNeeded() {
  if (gatewayProc) return;
  if (!isConfigured()) return;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Run gateway on internal port; wrapper owns the public $PORT.
  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    CLAWDBOT_GATEWAY_TOKEN,
    "--allow-unconfigured"
  ];

  gatewayProc = childProcess.spawn(CLAWDBOT_BIN, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAWDBOT_STATE_DIR: STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR
    }
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

function stopGateway() {
  if (!gatewayProc) return;
  try {
    gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Clawdbot Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Clawdbot Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawdbot Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>Clawdbot Setup</h1>
  <p class="muted">This wizard configures Clawdbot by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside Clawdbot, but this helps you get messaging working immediately.</p>
    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Backup / Export</h2>
    <p class="muted">After setup, export your state to migrate off Railway without losing config or memory.</p>
    <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const authGroupEl = document.getElementById('authGroup');
    const authChoiceEl = document.getElementById('authChoice');

    async function refreshStatus() {
      const res = await fetch('/setup/api/status', { credentials: 'same-origin' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        statusEl.textContent = 'Error loading status (' + res.status + '): ' + (text || res.statusText);
        return;
      }
      const j = await res.json();
      statusEl.textContent = j.configured ? 'Configured - open /clawdbot' : 'Not configured - run setup below';
      renderAuth(j.authGroups);
    }

    function renderAuth(groups) {
      authGroupEl.innerHTML = '';
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = g.value;
        opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
        authGroupEl.appendChild(opt);
      }
      authGroupEl.onchange = () => {
        const sel = groups.find(x => x.value === authGroupEl.value);
        authChoiceEl.innerHTML = '';
        for (const o of (sel?.options ?? [])) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label + (o.hint ? ' - ' + o.hint : '');
          authChoiceEl.appendChild(opt);
        }
      };
      authGroupEl.onchange();
    }

    document.getElementById('run').onclick = async () => {
      const payload = {
        flow: document.getElementById('flow').value,
        authChoice: authChoiceEl.value,
        authSecret: document.getElementById('authSecret').value,
        telegramToken: document.getElementById('telegramToken').value,
        discordToken: document.getElementById('discordToken').value,
        slackBotToken: document.getElementById('slackBotToken').value,
        slackAppToken: document.getElementById('slackAppToken').value
      };
      const log = document.getElementById('log');
      log.textContent = 'Running...\n';
      const res = await fetch('/setup/api/run', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { ok: false, output: text }; }
      log.textContent += j.output || JSON.stringify(j, null, 2);
      await refreshStatus();
    };

    refreshStatus().catch(e => { statusEl.textContent = 'Error: ' + e; });
  </script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  // We reuse Clawdbot's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" }
    ]},
    { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" }
    ]},
    { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
    ]},
    { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" }
    ]},
    { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
    ]},
    { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" }
    ]},
    { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
    ]},
    { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
    ]},
    { value: "qwen", label: "Qwen", hint: "OAuth", options: [
      { value: "qwen-portal", label: "Qwen OAuth" }
    ]},
    { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" }
    ]},
    { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" }
    ]},
    { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
    ]}
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    authGroups
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "lan",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    CLAWDBOT_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        CLAWDBOT_STATE_DIR: STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  if (isConfigured()) {
    startGatewayIfNeeded();
    return res.json({ ok: true, output: "Already configured.\n" });
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(CLAWDBOT_BIN, onboardArgs);

  let extra = "";

  // Optional channel setup.
  if (payload.telegramToken?.trim()) {
    const r = await runCmd(CLAWDBOT_BIN, [
      "channels",
      "add",
      "--channel",
      "telegram",
      "--token",
      payload.telegramToken.trim()
    ]);
    extra += `\n[telegram] exit=${r.code}\n${r.output}`;
  }
  if (payload.discordToken?.trim()) {
    const r = await runCmd(CLAWDBOT_BIN, [
      "channels",
      "add",
      "--channel",
      "discord",
      "--token",
      payload.discordToken.trim()
    ]);
    extra += `\n[discord] exit=${r.code}\n${r.output}`;
  }
  if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
    const args = ["channels", "add", "--channel", "slack"];
    if (payload.slackBotToken?.trim()) args.push("--bot-token", payload.slackBotToken.trim());
    if (payload.slackAppToken?.trim()) args.push("--app-token", payload.slackAppToken.trim());
    const r = await runCmd(CLAWDBOT_BIN, args);
    extra += `\n[slack] exit=${r.code}\n${r.output}`;
  }

  const ok = onboard.code === 0 && isConfigured();
  if (ok) {
    startGatewayIfNeeded();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: `${onboard.output}${extra}`
  });
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="clawdbot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  const stateParent = path.resolve(STATE_DIR);
  const workspaceParent = path.resolve(WORKSPACE_DIR);

  // Stream a tar.gz containing the persisted state + workspace.
  // We set cwd=/ and pass relative paths so the archive contains e.g. data/.clawdbot and data/workspace.
  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd: "/",
      onwarn: () => {},
    },
    [stateParent, workspaceParent].map((p) => p.replace(/^\//, "")),
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use((req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }
  startGatewayIfNeeded();
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${CLAWDBOT_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  startGatewayIfNeeded();
});

server.on("upgrade", (req, socket, head) => {
  // Same rule: if not configured, reject upgrades.
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  startGatewayIfNeeded();
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  stopGateway();
  process.exit(0);
});
