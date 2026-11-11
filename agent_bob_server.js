// -*- coding: utf-8 -*-
/**
 * Agent Bob - Service Provider Cell (FOGA Protocol Reference Node)
 * Implements:
 * 1. A2A 1.0 JSON-RPC Specification (GET /.well-known/agent-card.json, POST /a2a)
 * 2. EIP-712 Request Envelope Authentication (FOGA-EIP712)
 * 3. Dynamic Cognitive Engine (LLM) Hot-Swapping & Skill Hot-Plugging (Ship of Theseus)
 * 4. Interactive Web & Mobile Dashboard
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import {
  SIGNED_SCHEME,
  verifyRequestAuthorization,
  NonceCache,
  DEFAULT_CHAIN_ID
} from "./crypto_utils.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const HOST = "0.0.0.0"; // Listen on all interfaces so mobile phone can connect via LAN IP

// 1. Bob's Cryptographic Identity & Cell Account
// Private key for Bob's Cell Account (Hardened deterministic key for demo)
const BOB_PRIVATE_KEY = process.env.BOB_PRIVATE_KEY || "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
export const bobWallet = new ethers.Wallet(BOB_PRIVATE_KEY);
export const bobCellAddress = bobWallet.address;
export const bobAgentId = "8888";

// 2. Bob's Dynamic State (Theseus's Ship Testbed)
let currentLlmEngine = "heuristic-rule-engine"; // Default: deterministic rule engine
let taskCounter = 0;
const nonceCache = new NonceCache();
const recentLogs = [];
const tasksStore = new Map();

let heldSkills = [
  {
    id: "foga-probe@1.0.0",
    name: "foga-probe",
    description: "Ten-ERC protocol onchain state and live health diagnosis probe",
    tags: ["erc8338", "diagnostic", "foga"]
  },
  {
    id: "data-hash-verifier@1.0.0",
    name: "data-hash-verifier",
    description: "Cryptographic payload integrity and consistency validation",
    tags: ["erc8338", "cryptography", "verifier"]
  }
];

function logEvent(type, message, details = {}) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = { id: Date.now(), timestamp, type, message, details };
  recentLogs.unshift(entry);
  if (recentLogs.length > 50) recentLogs.pop();

  const colorMap = {
    A2A: "\x1b[36m", // Cyan
    AUTH: "\x1b[32m", // Green
    WARN: "\x1b[33m", // Yellow
    ERROR: "\x1b[31m", // Red
    STATE: "\x1b[35m"  // Magenta
  };
  const color = colorMap[type] || "\x1b[0m";
  console.log(`${color}[${type} ${timestamp}]\x1b[0m ${message}`, Object.keys(details).length ? details : "");
}

// 3. Execution Engines (Simulating Different LLMs / Cognitive Adapters)
function executeWithCognitiveEngine(promptText, skillName) {
  const tId = ++taskCounter;
  if (currentLlmEngine === "heuristic-rule-engine") {
    return {
      engine: "heuristic-rule-engine",
      architecture: "Deterministic Decision Table (No LLM)",
      output: `[Rule-v1] Processed task #${tId} for skill [${skillName}]. Status: Verified OK. Input analysis: "${promptText}". Execution deterministic hash: 0x${ethers.keccak256(ethers.toUtf8Bytes(promptText + tId)).slice(2, 18)}`
    };
  } else if (currentLlmEngine === "claude-3-5-sonnet") {
    return {
      engine: "claude-3-5-sonnet",
      architecture: "Anthropic Claude 3.5 Sonnet (Advanced Reasoning Adapter)",
      output: `[Claude-3.5] Comprehensive analysis completed for task #${tId}. Deconstructed request: "${promptText}". Identified optimal multi-step resolution plan under ${skillName} standards with formal verification confidence 99.8%.`
    };
  } else if (currentLlmEngine === "deepseek-r1") {
    return {
      engine: "deepseek-r1",
      architecture: "DeepSeek-R1 (Chain-of-Thought Cognitive Adapter)",
      output: `[DeepSeek-R1 CoT] <think>Evaluating boundary conditions for ${skillName} with prompt: "${promptText}"</think> Rigorous execution finalized for task #${tId}. Mathematical invariants verified.`
    };
  } else {
    return {
      engine: currentLlmEngine,
      architecture: "Custom External LLM Adapter",
      output: `[${currentLlmEngine}] Executed task #${tId} successfully for ${skillName}.`
    };
  }
}

// 4. A2A 1.0 AgentCard Builder
function buildAgentCard(baseUrl) {
  return {
    name: "Agent Bob (Data & Compute Cell)",
    description: "Autonomous service provider cell running on FOGA protocol (ERC-8434 / ERC-8004 / ERC-8338)",
    version: "1.0.0",
    provider: {
      organization: "Finch Research Lab",
      account: bobCellAddress,
      agentId: bobAgentId
    },
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0"
      }
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      cognitiveEngine: currentLlmEngine
    },
    securitySchemes: {
      "wallet-signature": {
        scheme: SIGNED_SCHEME,
        description: "EIP-712 request-bound typed signature envelope over domain { name: 'FOGA', version: '1', chainId, verifyingContract }."
      }
    },
    skills: heldSkills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      examples: [
        `{"foga":{"mode":"quote","skill":"${s.name}"}}`,
        `{"foga":{"mode":"task","skill":"${s.name}","input":{"prompt":"..."}}}`
      ]
    }))
  };
}

// 5. HTTP Server Handling A2A, Status and Dashboard
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost:3001"}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, A2A-Version, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Helper to read JSON body
  const readBody = () => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  // A. A2A 1.0 Agent Card
  if (pathname === "/.well-known/agent-card.json" && method === "GET") {
    const card = buildAgentCard(url.origin);
    logEvent("A2A", "Agent Card requested by client", { clientIp: req.socket.remoteAddress });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(card, null, 2));
    return;
  }

  // B. A2A 1.0 JSON-RPC Protocol Endpoint
  if (pathname === "/a2a" && method === "POST") {
    const bodyStr = await readBody();
    let body;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: Invalid JSON" } }));
      return;
    }

    const { jsonrpc, id, method: rpcMethod, params } = body;
    if (jsonrpc !== "2.0") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: id || null, error: { code: -32600, message: "Invalid Request: expected jsonrpc 2.0" } }));
      return;
    }

    // 1. Verify EIP-712 Request Signature Header (if present)
    const authHeader = req.headers["authorization"];
    let authVerdict = { ok: false, reason: "Anonymous (No Authorization header provided)" };
    if (authHeader) {
      authVerdict = verifyRequestAuthorization(authHeader, {
        cellAddress: bobCellAddress,
        method: "POST",
        path: "/a2a",
        body: bodyStr,
        chainId: DEFAULT_CHAIN_ID,
        nonceCache
      });

      // If a credential was supplied but failed verification (tampered body, expired, or bad sig)
      if (!authVerdict.ok) {
        logEvent("WARN", `Rejected invalid/tampered EIP-712 credential: ${authVerdict.reason}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: id || null,
          error: {
            code: -32002,
            message: `InvalidCredential: ${authVerdict.reason}`
          }
        }));
        return;
      }

      logEvent("AUTH", `EIP-712 Signature Verified! Signer: ${authVerdict.signer}`, {
        nonce: authVerdict.envelope.nonce.slice(0, 10) + "..."
      });
    }

    // 2. Handle Methods
    if (rpcMethod === "SendMessage") {
      const message = params?.message;
      const parts = message?.parts || [];

      // Extract request mode
      let mode = "quote";
      let requestedSkill = heldSkills[0].name;
      let promptText = "General task inquiry";

      for (const p of parts) {
        if (p.data?.foga) {
          const f = p.data.foga;
          if (f.mode === "task") mode = "task";
          if (f.skill) requestedSkill = f.skill;
          if (f.input?.prompt) promptText = f.input.prompt;
        } else if (p.text) {
          promptText = p.text;
        }
      }

      const taskId = randomUUID();
      const contextId = randomUUID();

      if (mode === "quote") {
        logEvent("A2A", `Handled Quote request for skill: ${requestedSkill}`, { caller: authVerdict.signer || "Anonymous" });
        const quoteResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            task: {
              id: taskId,
              contextId,
              status: {
                state: "TASK_STATE_COMPLETED",
                timestamp: new Date().toISOString(),
                message: {
                  messageId: randomUUID(),
                  role: "ROLE_AGENT",
                  parts: [{
                    text: `Agent Bob offers ${heldSkills.length} skills. Quote generated. Escrow terms attached.`
                  }]
                }
              },
              artifacts: [{
                name: "quote",
                description: "What Agent Bob can do and on what terms",
                parts: [{
                  data: {
                    foga: {
                      quote: {
                        cell: "Bob",
                        account: bobCellAddress,
                        agentId: bobAgentId,
                        activeCognitiveEngine: currentLlmEngine,
                        skills: heldSkills,
                        terms: {
                          acceptance: "hashlock",
                          asset: "native",
                          minRewardWei: "100000000000000"
                        }
                      }
                    }
                  },
                  mediaType: "application/json"
                }]
              }],
              metadata: {
                caller: authVerdict.signer || "anonymous",
                cell: "Bob"
              }
            }
          }
        };
        tasksStore.set(taskId, quoteResponse.result.task);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(quoteResponse, null, 2));
        return;
      }

      if (mode === "task") {
        // Task requires valid EIP-712 signer
        if (!authVerdict.ok) {
          logEvent("WARN", `Rejected unsigned task request (Signature required for execution)`);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32001,
              message: "AuthenticationRequired: Executing tasks on Bob requires a valid FOGA-EIP712 signature envelope",
              data: [authVerdict.reason]
            }
          }));
          return;
        }

        // Execute task with Bob's active brain!
        logEvent("A2A", `Executing Task #${taskCounter + 1} with [${currentLlmEngine}] for ${authVerdict.signer}`, { skill: requestedSkill });
        const executionResult = executeWithCognitiveEngine(promptText, requestedSkill);

        const taskResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            task: {
              id: taskId,
              contextId,
              status: {
                state: "TASK_STATE_COMPLETED",
                timestamp: new Date().toISOString(),
                message: {
                  messageId: randomUUID(),
                  role: "ROLE_AGENT",
                  parts: [{ text: executionResult.output }]
                }
              },
              artifacts: [
                {
                  name: "submission",
                  description: "Task execution deliverable",
                  parts: [{
                    data: {
                      foga: {
                        submission: {
                          cellAccount: bobCellAddress,
                          agentId: bobAgentId,
                          callerSigner: authVerdict.signer,
                          skill: requestedSkill,
                          cognitiveEngine: executionResult.engine,
                          engineArchitecture: executionResult.architecture,
                          deliverable: executionResult.output,
                          decisionId: "dec-" + randomUUID().slice(0, 8),
                          verifiedAt: new Date().toISOString()
                        }
                      }
                    },
                    mediaType: "application/json"
                  }]
                }
              ],
              metadata: {
                caller: authVerdict.signer,
                cell: "Bob",
                cellIdentityInvariant: true
              }
            }
          }
        };
        tasksStore.set(taskId, taskResponse.result.task);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(taskResponse, null, 2));
        return;
      }
    }

    if (rpcMethod === "GetTask") {
      const taskId = params?.taskId;
      const task = tasksStore.get(taskId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32004, message: "TaskNotFoundError: Task does not exist" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { task } }));
      return;
    }

    // Default: method not found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `MethodNotFoundError: Method ${rpcMethod} is not supported` } }));
    return;
  }

  // C. Dynamic Control APIs (Theseus's Ship Demonstration)
  if (pathname === "/control/switch-llm" && method === "POST") {
    const raw = await readBody();
    const data = JSON.parse(raw || "{}");
    const oldEngine = currentLlmEngine;
    currentLlmEngine = data.llm || "claude-3-5-sonnet";
    logEvent("STATE", `Hot-Swapped LLM Engine: ${oldEngine} -> ${currentLlmEngine} (Bob's Ethereum Address stays ${bobCellAddress})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      message: "LLM switched successfully",
      previousEngine: oldEngine,
      currentEngine: currentLlmEngine,
      identityInvariance: {
        agentAccount: bobCellAddress,
        agentId: bobAgentId,
        invariant: true
      }
    }));
    return;
  }

  if (pathname === "/control/upgrade-skill" && method === "POST") {
    const raw = await readBody();
    const data = JSON.parse(raw || "{}");
    const newSkill = data.skill || {
      id: "market-sentiment-analyzer@2.0.0",
      name: "market-sentiment-analyzer",
      description: "Advanced multi-agent onchain order flow and sentiment scoring",
      tags: ["erc8338", "ai-finance", "v2"]
    };
    heldSkills.push(newSkill);
    logEvent("STATE", `Hot-Plugged New Skill: ${newSkill.id} (Bob's Ethereum Address stays ${bobCellAddress})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      message: "Skill upgraded successfully",
      newSkill,
      totalSkills: heldSkills.length,
      identityInvariance: {
        agentAccount: bobCellAddress,
        agentId: bobAgentId,
        invariant: true
      }
    }));
    return;
  }

  // D. Status API
  if (pathname === "/api/status" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      agentName: "Agent Bob (Data & Compute Cell)",
      accountAddress: bobCellAddress,
      agentId: bobAgentId,
      currentLlmEngine,
      skills: heldSkills,
      tasksCompleted: taskCounter,
      uptimeSeconds: Math.floor(process.uptime()),
      recentLogs: recentLogs.slice(0, 10)
    }, null, 2));
    return;
  }

  // E. Interactive Mobile-Friendly Web Dashboard
  if ((pathname === "/" || pathname === "/dashboard") && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboardHtml());
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Bob - A2A Cell & Identity Dashboard</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #151c2d;
      --accent: #2563eb;
      --accent-glow: #3b82f6;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --success: #10b981;
      --border: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 20px; }
    .title-group h1 { font-size: 1.5rem; color: #fff; display: flex; align-items: center; gap: 8px; }
    .badge-live { background: rgba(16, 185, 129, 0.2); color: var(--success); font-size: 0.75rem; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--success); }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 680px) { .grid { grid-template-columns: 1fr 1fr; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .card-title { font-size: 0.95rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; justify-content: space-between; }
    .code-box { background: #070a12; border: 1px solid #1a2234; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 0.85rem; word-break: break-all; color: #38bdf8; }
    .stat-val { font-size: 1.4rem; font-weight: bold; color: #fff; margin: 6px 0; }
    .btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 14px; font-size: 0.85rem; cursor: pointer; transition: 0.2s; font-weight: 500; }
    .btn:hover { background: var(--accent-glow); }
    .btn-group { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .btn-secondary { background: #26334d; }
    .btn-secondary:hover { background: #334466; }
    .log-container { background: #070a12; border: 1px solid #1a2234; border-radius: 8px; height: 260px; overflow-y: auto; padding: 10px; font-family: monospace; font-size: 0.8rem; }
    .log-item { margin-bottom: 6px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; }
    .log-time { color: var(--text-muted); margin-right: 6px; }
    .log-tag-A2A { color: #38bdf8; }
    .log-tag-AUTH { color: #4ade80; }
    .log-tag-STATE { color: #c084fc; }
    .log-tag-WARN { color: #facc15; }
    .full-width { grid-column: 1 / -1; }
    .skill-pill { display: inline-block; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; margin: 3px 2px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1><span>🤖</span> Agent Bob 节点控制台</h1>
        <span class="badge-live">A2A 1.0 JSON-RPC 运行中</span>
      </div>
      <div><button class="btn btn-secondary" onclick="fetchStatus()">刷新数据</button></div>
    </header>

    <div class="grid">
      <!-- 身份核心区 (不可变锚点) -->
      <div class="card">
        <div class="card-title">
          <span>法定身份锚点 (不可变)</span>
          <span style="color:#4ade80">● ERC-8434 / 8004</span>
        </div>
        <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">以太坊智能合约账户 (Cell Body):</p>
        <div class="code-box" id="cellAddress">${bobCellAddress}</div>
        <div style="display:flex; justify-content:space-between; margin-top:10px;">
          <div><span style="color:var(--text-muted); font-size:0.8rem;">Agent ID: </span><b id="agentId">${bobAgentId}</b></div>
          <div><span style="color:var(--text-muted); font-size:0.8rem;">累积完成任务: </span><b id="taskCount">${taskCounter}</b></div>
        </div>
      </div>

      <!-- 动态认知引擎 (忒修斯之船) -->
      <div class="card">
        <div class="card-title">
          <span>当前认知大脑 (可热插拔)</span>
          <span style="color:#c084fc">★ L4 Cognition</span>
        </div>
        <div class="stat-val" id="currentLlm" style="color:#c084fc;">${currentLlmEngine}</div>
        <p style="font-size:0.8rem; color:var(--text-muted);">现场切换认知引擎（身份地址绝不改变）：</p>
        <div class="btn-group">
          <button class="btn btn-secondary" onclick="switchLlm('heuristic-rule-engine')">规则确定性</button>
          <button class="btn btn-secondary" onclick="switchLlm('claude-3-5-sonnet')">Claude 3.5</button>
          <button class="btn btn-secondary" onclick="switchLlm('deepseek-r1')">DeepSeek R1</button>
        </div>
      </div>

      <!-- 技能与服务包 -->
      <div class="card full-width">
        <div class="card-title">
          <span>持有可执行技能包 (ERC-8338 Token-Bound Skills)</span>
          <button class="btn" style="padding:4px 8px; font-size:0.75rem;" onclick="upgradeSkill()">+ 升级新技能</button>
        </div>
        <div id="skillsList">
          ${heldSkills.map(s => `<span class="skill-pill">⚡ ${s.id}</span>`).join("")}
        </div>
      </div>

      <!-- 实时 A2A 协议日志监控 -->
      <div class="card full-width">
        <div class="card-title">
          <span>A2A 实时通信与 EIP-712 验签报文流</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">自动轮询 (2s)</span>
        </div>
        <div class="log-container" id="logBox">
          ${recentLogs.map(l => `
            <div class="log-item">
              <span class="log-time">[${l.timestamp}]</span>
              <span class="log-tag-${l.type}">[${l.type}]</span>
              <span>${l.message}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  </div>

  <script>
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('currentLlm').innerText = data.currentLlmEngine;
        document.getElementById('taskCount').innerText = data.tasksCompleted;
        const skillsHtml = data.skills.map(s => '<span class="skill-pill">⚡ ' + s.id + '</span>').join('');
        document.getElementById('skillsList').innerHTML = skillsHtml;

        const logBox = document.getElementById('logBox');
        if (data.recentLogs && data.recentLogs.length > 0) {
          logBox.innerHTML = data.recentLogs.map(l => 
            '<div class="log-item">' +
              '<span class="log-time">[' + l.timestamp + ']</span> ' +
              '<span class="log-tag-' + l.type + '">[' + l.type + ']</span> ' +
              '<span>' + l.message + '</span>' +
            '</div>'
          ).join('');
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function switchLlm(name) {
      await fetch('/control/switch-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: name })
      });
      fetchStatus();
    }

    async function upgradeSkill() {
      const v = Math.floor(Math.random() * 100);
      await fetch('/control/upgrade-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill: {
            id: 'auto-analysis@2.' + v + '.0',
            name: 'auto-analysis',
            description: 'Dynamic upgraded skill module'
          }
        })
      });
      fetchStatus();
    }

    setInterval(fetchStatus, 2000);
  </script>
</body>
</html>`;
}

// 6. Start Server
server.listen(PORT, HOST, () => {
  console.log("\n==================================================================");
  console.log(`🚀 Agent Bob (FOGA Cell Provider) Successfully Started!`);
  console.log(`==================================================================`);
  console.log(`• Local Endpoint  : http://localhost:${PORT}`);
  console.log(`• LAN Mobile Access: http://172.20.10.3:${PORT}`);
  console.log(`• A2A AgentCard   : http://localhost:${PORT}/.well-known/agent-card.json`);
  console.log(`• A2A Service URL : http://localhost:${PORT}/a2a`);
  console.log(`• Cell Account    : ${bobCellAddress}`);
  console.log(`• ERC-8004 AID    : ${bobAgentId}`);
  console.log(`• Active Cognitive: ${currentLlmEngine}`);
  console.log(`==================================================================\n`);
});
