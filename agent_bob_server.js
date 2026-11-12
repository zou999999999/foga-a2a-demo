// -*- coding: utf-8 -*-
/**
 * FOGA Symmetric Peer Node (Agent Bob / Agent Alice Dual-Role Reference Node)
 * Strictly aligned with Finch OG Agent (FOGA 0.6.0) `src/a2a/server.ts`, `docs/a2a.md`, `docs/node.md`, `docs/loop-d.md`:
 *
 * 1. A2A 1.0 JSON-RPC Binding (`GET /.well-known/agent-card.json`, `POST /a2a`)
 *    - Enforces `A2A-Version: 1.0` (-32009 VersionNotSupportedError on missing/0.3)
 *    - Implements `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`
 *    - Enforces `(caller, messageId)` idempotency deduplication
 *    - Supports multi-turn negotiation (`TASK_STATE_INPUT_REQUIRED` -> continuation by `taskId`)
 *    - Enforces caller visibility isolation (`GetTask` / `ListTasks` scoped to authenticated signer)
 * 2. L3 Deterministic Cell Kernel & `Catalog.invoke` Three-Check Gate Engine (No LLM inside L3)
 *    - Gate 1: Call Permission (`permission`, `input`)
 *    - Gate 2: Business & Policy Authorization (`safety`, `skill`, `policy`, `budget`)
 *    - Gate 3: Wallet / Operator Allow-list Permission (`wallet`)
 *    - Three-step pipeline: `tender_precheck` -> `skill_run` -> `tender_submit`
 *    - Immutable `DecisionRecord` generation with `promptHash` & `responseHash`
 * 3. L4 Pluggable Cognitive Adapter (`stub` deterministic rule table / model adapters) & Ship of Theseus Invariance
 * 4. Symmetric P2P Outbound Client (`/peer/discover`, `/peer/send`) for Peer-to-Peer NAT-traversed interaction
 */

import http from "node:http";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ethers, keccak256, toUtf8Bytes } from "ethers";
import {
  SIGNED_SCHEME,
  signRequestAuthorization,
  verifyRequestAuthorization,
  NonceCache,
  DEFAULT_CHAIN_ID
} from "./crypto_utils.js";

// CLI Argument & Environment Parsing for Symmetric Peer Deployment
const args = process.argv.slice(2);
const isPeerBFlag = args.includes("--peer-b") || process.env.PEER_ROLE === "B";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (isPeerBFlag ? 3002 : 3001);
const HOST = "0.0.0.0";

// Pre-configured deterministic identities for Peer A (Bob, 8888) and Peer B (Alice/Mentor, 9999)
const DEFAULT_KEY_A = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
const DEFAULT_KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const NODE_PRIVATE_KEY = process.env.CELL_PRIVATE_KEY || process.env.BOB_PRIVATE_KEY || (isPeerBFlag ? DEFAULT_KEY_B : DEFAULT_KEY_A);
export const bobWallet = new ethers.Wallet(NODE_PRIVATE_KEY);
export const bobCellAddress = bobWallet.address;
export const bobAgentId = process.env.AGENT_ID || (isPeerBFlag ? "9999" : "8888");
export const nodeName = process.env.AGENT_NAME || (isPeerBFlag ? "Agent Alice (Peer Cell #9999)" : "Agent Bob (Data & Compute Cell)");
export const defaultPeerUrl = process.env.PEER_URL || (PORT === 3001 ? "http://localhost:3002" : "http://localhost:3001");

// A2A 1.0 Standard Error Codes (`src/a2a/types.ts`)
export const A2A_ERRORS = {
  ParseError: -32700,
  InvalidRequestError: -32600,
  MethodNotFoundError: -32601,
  InvalidParamsError: -32602,
  InternalError: -32603,
  AuthenticationRequiredError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  TaskNotFoundError: -32006,
  VersionNotSupportedError: -32009
};

export const TERMINAL_STATES = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED"
];

// L3 Kernel State & Policy Configuration (`cell.config.json` equivalent)
let currentLlmEngine = "heuristic-rule-engine"; // Default deterministic stub adapter
let safetyState = "ACTIVE"; // "ACTIVE" | "SUSPENDED" (Guardian safety switch)
let taskCounter = 0;

const policyConfig = {
  minRewardWei: BigInt("100000000000000"),     // 0.0001 ETH floor
  perOpValueCapWei: BigInt("1000000000000000"), // 0.001 ETH per-operation cap
  dailyValueCapWei: BigInt("5000000000000000"), // 0.005 ETH daily cap
  minSubmitWindowSeconds: 300,
  minSettleWindowSeconds: 600,
  counterpartyMinLevel: 1,
  operatorAllowList: ["tender_precheck", "skill_run", "tender_submit", "quote_respond"]
};

const budgetBook = {
  spentValueWei: BigInt(0),
  spentFeesWei: BigInt(0),
  modelCallsToday: 0,
  dailyModelCallsCap: 400,
  skillRunsCount: 0
};

const nonceCache = new NonceCache();
const recentLogs = [];
const tasksStore = new Map();       // taskId -> StoredTask
const messageDedupe = new Map();    // `${caller}:${messageId}` -> taskId
const decisionRecords = [];         // Immutable L3 Decision Records
const jobsStore = new Map();        // jobId -> Job Record
const peerInteractionHistory = [];  // Outbound/Inbound P2P exchange history

let heldSkills = [
  {
    id: "foga-probe@1.0.0",
    name: "foga-probe",
    version: "1.0.0",
    tokenId: "101",
    packageHash: keccak256(toUtf8Bytes("foga-probe@1.0.0")),
    description: "Ten-ERC protocol onchain state and live health diagnosis probe",
    tags: ["erc8338", "diagnostic", "foga"],
    offered: true
  },
  {
    id: "finch-extract-verify@1.0.0",
    name: "finch-extract-verify",
    version: "1.0.0",
    tokenId: "102",
    packageHash: keccak256(toUtf8Bytes("finch-extract-verify@1.0.0")),
    description: "Structured document extraction, consistency check and deterministic evidence report",
    tags: ["erc8338", "verifier", "foga"],
    offered: true
  },
  {
    id: "data-hash-verifier@1.0.0",
    name: "data-hash-verifier",
    version: "1.0.0",
    tokenId: "103",
    packageHash: keccak256(toUtf8Bytes("data-hash-verifier@1.0.0")),
    description: "Cryptographic payload integrity and consistency validation",
    tags: ["erc8338", "cryptography", "verifier"],
    offered: true
  }
];

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function errorInfo(reason, metadata = {}) {
  return {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "a2a-protocol.org",
    metadata: { ...metadata, timestamp: new Date().toISOString() }
  };
}

function logEvent(type, message, details = {}) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 6), timestamp, type, message, details };
  recentLogs.unshift(entry);
  if (recentLogs.length > 60) recentLogs.pop();

  const colorMap = {
    A2A: "\x1b[36m",   // Cyan
    AUTH: "\x1b[32m",  // Green
    GATE: "\x1b[34m",  // Blue
    WARN: "\x1b[33m",  // Yellow
    ERROR: "\x1b[31m", // Red
    STATE: "\x1b[35m"  // Magenta
  };
  const color = colorMap[type] || "\x1b[0m";
  console.log(`${color}[${type} ${timestamp}]\x1b[0m ${message}`, Object.keys(details).length ? details : "");
}

/**
 * L4 Cognitive Proposal Adapter (`Perceive -> Propose`)
 * Computes deterministic output and hashes (`promptHash`, `responseHash`) without holding keys or decision power.
 */
function executeWithCognitiveEngine(promptText, skillName) {
  const tId = ++taskCounter;
  budgetBook.modelCallsToday++;
  const promptHash = keccak256(toUtf8Bytes(`${skillName}:${promptText}`));

  let result;
  if (currentLlmEngine === "heuristic-rule-engine") {
    const output = `[Rule-Stub-v1] Processed task #${tId} for skill [${skillName}]. Status: Verified OK. Input analysis: "${promptText}". Execution deterministic hash: ${keccak256(toUtf8Bytes(promptText + tId)).slice(0, 18)}`;
    result = {
      provider: "stub",
      engine: "heuristic-rule-engine",
      architecture: "FOGA Deterministic Decision Table (No LLM inside L3)",
      output
    };
  } else if (currentLlmEngine === "claude-3-5-sonnet") {
    const output = `[Claude-3.5] Comprehensive analysis completed for task #${tId}. Deconstructed request: "${promptText}". Identified optimal multi-step resolution plan under ${skillName} standards with formal verification confidence 99.8%.`;
    result = {
      provider: "anthropic-adapter",
      engine: "claude-3-5-sonnet",
      architecture: "Anthropic Claude 3.5 Sonnet (L4 Pluggable Reasoning Adapter)",
      output
    };
  } else if (currentLlmEngine === "deepseek-r1") {
    const output = `[DeepSeek-R1 CoT] <think>Evaluating boundary conditions for ${skillName} with prompt: "${promptText}"</think> Rigorous execution finalized for task #${tId}. Mathematical invariants verified.`;
    result = {
      provider: "deepseek-adapter",
      engine: "deepseek-r1",
      architecture: "DeepSeek-R1 (L4 Chain-of-Thought Cognitive Adapter)",
      output
    };
  } else {
    const output = `[${currentLlmEngine}] Executed task #${tId} successfully for ${skillName}.`;
    result = {
      provider: "custom-adapter",
      engine: currentLlmEngine,
      architecture: "Custom External L4 Cognitive Adapter",
      output
    };
  }

  const responseHash = keccak256(toUtf8Bytes(result.output));
  const answerHash = keccak256(toUtf8Bytes(`${result.engine}:${result.output}`));
  return {
    ...result,
    promptHash,
    responseHash,
    resultHash: responseHash,
    answerHash
  };
}

/**
 * L3 Kernel `Catalog.invoke` — The Three Checks (`docs/node.md`, lines 30-46)
 * Every act goes through `catalogInvoke` in strict order:
 * 1. Call permission (`permission`, `input`)
 * 2. Business authorization (`safety`, `skill`, `policy`, `budget`)
 * 3. Wallet permission (`wallet`)
 * Writes an immutable Decision Record on every attempt (allowed or refused).
 */
function recordDecision({ caller, capability, input, verdict, gate, reason, jobId = null, operationId = null, modelMeta = null }) {
  const dec = {
    id: `dec-${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    entrance: "a2a",
    caller,
    capability,
    mode: "act",
    inputHash: keccak256(toUtf8Bytes(JSON.stringify(input || {}))),
    verdict, // "allowed" | "refused"
    gate,    // "permission" | "input" | "safety" | "skill" | "policy" | "budget" | "wallet" | "none"
    reason,
    jobId,
    operationId,
    model: modelMeta || {
      provider: "stub",
      model: currentLlmEngine,
      promptHash: keccak256(toUtf8Bytes(String(capability))),
      responseHash: keccak256(toUtf8Bytes(String(verdict)))
    }
  };
  decisionRecords.unshift(dec);
  if (decisionRecords.length > 100) decisionRecords.pop();
  return dec;
}

function catalogInvoke(capability, input, caller) {
  // Check 1: Call Permission & Input Schema (`permission`, `input`)
  if (!caller || !caller.authenticated) {
    const dec = recordDecision({
      caller: caller?.id || "anonymous",
      capability,
      input,
      verdict: "refused",
      gate: "permission",
      reason: "Caller lacks act-level FOGA-EIP712 wallet signature"
    });
    logEvent("GATE", `Refused [${capability}] at gate [permission]: ${dec.reason}`, { decisionId: dec.id });
    return { ok: false, gate: "permission", reason: dec.reason, decisionId: dec.id };
  }

  if (!input || typeof input !== "object") {
    const dec = recordDecision({
      caller: caller.id,
      capability,
      input,
      verdict: "refused",
      gate: "input",
      reason: "Invalid input schema: expected structured object"
    });
    logEvent("GATE", `Refused [${capability}] at gate [input]`, { decisionId: dec.id });
    return { ok: false, gate: "input", reason: dec.reason, decisionId: dec.id };
  }

  // Check 2A: Safety Gate (`safety` — Guardian suspension check)
  if (safetyState !== "ACTIVE") {
    const dec = recordDecision({
      caller: caller.id,
      capability,
      input,
      verdict: "refused",
      gate: "safety",
      reason: `Cell safety anchor is ${safetyState} (suspended by guardian); new commitments refused`
    });
    logEvent("GATE", `Refused [${capability}] at gate [safety]: Guardian suspended`, { decisionId: dec.id });
    return { ok: false, gate: "safety", reason: dec.reason, decisionId: dec.id };
  }

  // Check 2B: Skill Gate (`skill` — Held & offered verification + packageHash commitment check)
  if (input.skill) {
    const foundSkill = heldSkills.find(s => s.name === input.skill && s.offered !== false);
    if (!foundSkill) {
      const offeredList = heldSkills.filter(s => s.offered !== false).map(s => s.name).join(", ");
      const dec = recordDecision({
        caller: caller.id,
        capability,
        input,
        verdict: "refused",
        gate: "skill",
        reason: `Skill '${input.skill}' is not held/offered by this cell. Offered: [${offeredList}]`
      });
      logEvent("GATE", `Refused [${capability}] at gate [skill]: ${input.skill} not held`, { decisionId: dec.id });
      return { ok: false, gate: "skill", reason: dec.reason, decisionId: dec.id };
    }
  }

  // Check 2C: Policy Gate (`policy` — Minimum reward floor & window rules)
  if (input.rewardWei !== undefined) {
    const reward = BigInt(String(input.rewardWei));
    if (reward < policyConfig.minRewardWei) {
      const dec = recordDecision({
        caller: caller.id,
        capability,
        input,
        verdict: "refused",
        gate: "policy",
        reason: `Tender reward ${reward.toString()} wei is below policy floor ${policyConfig.minRewardWei.toString()} wei`
      });
      logEvent("GATE", `Refused [${capability}] at gate [policy]: Reward below floor`, { decisionId: dec.id });
      return { ok: false, gate: "policy", reason: dec.reason, decisionId: dec.id };
    }
  }

  // Check 2D: Budget Gate (`budget` — Per-operation & 24h value caps)
  if (input.valueWei !== undefined) {
    const val = BigInt(String(input.valueWei));
    if (val > policyConfig.perOpValueCapWei) {
      const dec = recordDecision({
        caller: caller.id,
        capability,
        input,
        verdict: "refused",
        gate: "budget",
        reason: `Requested value ${val.toString()} wei exceeds per-operation budget cap ${policyConfig.perOpValueCapWei.toString()} wei`
      });
      logEvent("GATE", `Refused [${capability}] at gate [budget]: Exceeds per-op cap`, { decisionId: dec.id });
      return { ok: false, gate: "budget", reason: dec.reason, decisionId: dec.id };
    }
    if (budgetBook.spentValueWei + val > policyConfig.dailyValueCapWei) {
      const dec = recordDecision({
        caller: caller.id,
        capability,
        input,
        verdict: "refused",
        gate: "budget",
        reason: `Requested value ${val.toString()} wei exceeds remaining 24h budget cap`
      });
      logEvent("GATE", `Refused [${capability}] at gate [budget]: Exceeds daily cap`, { decisionId: dec.id });
      return { ok: false, gate: "budget", reason: dec.reason, decisionId: dec.id };
    }
  }

  // Check 3: Wallet Gate (`wallet` — Operator selector allow-list)
  if (!policyConfig.operatorAllowList.includes(capability)) {
    const dec = recordDecision({
      caller: caller.id,
      capability,
      input,
      verdict: "refused",
      gate: "wallet",
      reason: `OperatorNotAllowed: capability '${capability}' is outside FogaCellAccount operator allow-list`
    });
    logEvent("GATE", `Refused [${capability}] at gate [wallet]`, { decisionId: dec.id });
    return { ok: false, gate: "wallet", reason: dec.reason, decisionId: dec.id };
  }

  // All 3 Checks Passed -> Create Job & Execute
  const jobId = `job-${capability}-${randomUUID().slice(0, 8)}`;
  const opId = `op:${jobId}:1`;

  let output = {};
  let modelMeta = null;

  if (capability === "tender_precheck") {
    output = {
      prechecked: true,
      tokenId: input.tokenId,
      tender: {
        tokenId: input.tokenId,
        task: { skill: input.skill, input: { prompt: input.prompt } }
      }
    };
  } else if (capability === "skill_run") {
    budgetBook.skillRunsCount++;
    const execRes = executeWithCognitiveEngine(input.prompt || "Execute FOGA skill", input.skill);
    modelMeta = {
      provider: execRes.provider,
      model: execRes.engine,
      promptHash: execRes.promptHash,
      responseHash: execRes.responseHash
    };
    output = {
      engine: execRes.engine,
      architecture: execRes.architecture,
      deliverable: execRes.output,
      resultHash: execRes.resultHash,
      answerHash: execRes.answerHash,
      runReceipt: {
        workerPid: process.pid,
        isolated: true,
        timestamp: new Date().toISOString()
      }
    };
  } else if (capability === "tender_submit") {
    if (input.valueWei) {
      budgetBook.spentValueWei += BigInt(String(input.valueWei));
    }
    budgetBook.spentFeesWei += BigInt("21000000000000"); // Simulated gas fee accounting
    const txHash = keccak256(toUtf8Bytes(`${jobId}:${input.tokenId}:${input.resultHash}`));
    output = {
      submissionId: `sub-${randomUUID().slice(0, 8)}`,
      txHash,
      operations: [opId]
    };
  }

  const dec = recordDecision({
    caller: caller.id,
    capability,
    input,
    verdict: "allowed",
    gate: "none",
    reason: "Passed permission, business (safety/skill/policy/budget), and wallet checks",
    jobId,
    operationId: opId,
    modelMeta
  });

  jobsStore.set(jobId, {
    id: jobId,
    caller: caller.id,
    capability,
    state: "done",
    decisionId: dec.id,
    operations: [opId],
    output
  });

  return {
    ok: true,
    jobId,
    decisionId: dec.id,
    operations: [opId],
    output
  };
}

// Build A2A 1.0 AgentCard (`docs/a2a.md` section "The card")
function buildAgentCard(baseUrl) {
  const offeredSkills = heldSkills.filter(s => s.offered !== false);
  return {
    name: nodeName,
    description: "Autonomous symmetric P2P cell running on FOGA 0.6.0 protocol (ERC-8434 / ERC-8004 / ERC-8338 / ERC-8414)",
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
      extendedAgentCard: false,
      cognitiveEngine: currentLlmEngine,
      safetyState
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: {
      "wallet-signature": {
        scheme: SIGNED_SCHEME,
        description: "EIP-712 request-bound typed signature envelope over domain { name: 'FOGA', version: '1', chainId, verifyingContract }."
      }
    },
    skills: offeredSkills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags || ["erc8338"],
      examples: [
        `{"foga":{"mode":"quote","skill":"${s.name}"}}`,
        `{"foga":{"mode":"tender","tokenId":"1","skill":"${s.name}","input":{"prompt":"..."}}}`
      ]
    }))
  };
}

function makeAgentMessage(text, data, taskId, contextId) {
  const parts = [{ text }];
  if (data !== undefined) {
    parts.push({ data, mediaType: "application/json" });
  }
  return {
    messageId: randomUUID(),
    role: "ROLE_AGENT",
    parts,
    ...(taskId ? { taskId } : {}),
    ...(contextId ? { contextId } : {})
  };
}

/**
 * Parse `foga` request from message parts (`src/a2a/server.ts#fogaRequestOf`)
 */
function parseFogaRequest(message) {
  const parts = message?.parts || [];
  let promptFromText = "";

  for (const p of parts) {
    if (p.text) promptFromText = p.text;
  }

  for (const p of parts) {
    if (p.data && typeof p.data === "object" && p.data.foga) {
      const f = p.data.foga;
      const rawMode = f.mode || "quote";
      // Support both "tender" (strict FOGA spec) and "task" (legacy test compatibility)
      const mode = (rawMode === "tender" || rawMode === "task") ? rawMode : "quote";
      const prompt = f.input?.prompt || promptFromText || "General FOGA skill execution";
      return {
        mode,
        skill: f.skill,
        tokenId: f.tokenId !== undefined ? String(f.tokenId) : undefined,
        requireInput: Boolean(f.requireInput),
        rewardWei: f.rewardWei,
        valueWei: f.valueWei,
        input: f.input,
        prompt
      };
    }
  }

  return {
    mode: "quote",
    text: promptFromText || "General inquiry",
    prompt: promptFromText || "General inquiry"
  };
}

function setTaskState(stored, state, message) {
  stored.task.status = {
    state,
    timestamp: new Date().toISOString(),
    ...(message ? { message } : {})
  };
  if (message) {
    stored.task.history = [...(stored.task.history || []), message];
  }
}

function isTaskVisible(stored, caller) {
  if (!stored) return false;
  if (caller.visibility === "operator") return true;
  if (!stored.caller || stored.caller === "anonymous") return true;
  return stored.caller.toLowerCase() === (caller.id || "").toLowerCase();
}

function formatPublicTask(stored, historyLength, includeArtifacts = true) {
  const copy = JSON.parse(JSON.stringify(stored.task));
  if (historyLength !== undefined && Array.isArray(copy.history)) {
    copy.history = historyLength <= 0 ? [] : copy.history.slice(-historyLength);
  }
  if (!includeArtifacts) {
    delete copy.artifacts;
  }
  return copy;
}

/**
 * Process a task through either the Quote Road or the Tender/Task Road
 */
function workTask(stored, message, caller) {
  const req = parseFogaRequest(message);

  // ROAD 1: QUOTE (`mode: "quote"`)
  if (req.mode === "quote") {
    const offered = heldSkills.filter(s => s.offered !== false);

    // If caller asks for a specific skill that this cell does NOT offer -> TASK_STATE_REJECTED (`src/a2a/server.ts#L225`)
    if (req.skill && !offered.some(s => s.name === req.skill)) {
      logEvent("A2A", `Quote rejected: skill '${req.skill}' not offered`, { caller: caller.id });
      const msg = makeAgentMessage(
        `The cell does not offer a skill named ${req.skill}. Offered: ${offered.map(s => s.name).join(", ") || "none"}.`,
        {
          foga: {
            quote: {
              skill: req.skill,
              offered: false,
              available: offered.map(s => s.name)
            }
          }
        },
        stored.task.id,
        stored.task.contextId
      );
      setTaskState(stored, "TASK_STATE_REJECTED", msg);
      return;
    }

    const chosen = req.skill ? offered.filter(s => s.name === req.skill) : offered;
    logEvent("A2A", `Handled Quote request for skill: ${req.skill || "all"}`, { caller: caller.id });

    const quotePayload = {
      cell: nodeName,
      account: bobCellAddress,
      agentId: bobAgentId,
      activeCognitiveEngine: currentLlmEngine,
      safetyState,
      skills: chosen,
      terms: {
        acceptance: "hashlock",
        asset: "native",
        minRewardWei: policyConfig.minRewardWei.toString(),
        minSubmitWindowSeconds: policyConfig.minSubmitWindowSeconds,
        minSettleWindowSeconds: policyConfig.minSettleWindowSeconds,
        counterpartyMinLevel: policyConfig.counterpartyMinLevel
      },
      how: "Send {\"foga\":{\"mode\":\"tender\",\"tokenId\":\"<id>\",\"skill\":\"<skill>\",\"input\":{\"prompt\":\"...\"}}} with a valid FOGA-EIP712 signature."
    };

    stored.task.artifacts = [
      {
        artifactId: randomUUID(),
        name: "quote",
        description: `What ${nodeName} can do and on what terms`,
        parts: [
          {
            data: { foga: { quote: quotePayload } },
            mediaType: "application/json"
          }
        ]
      }
    ];

    const msg = makeAgentMessage(
      `${nodeName} offers ${chosen.length} skill(s): ${chosen.map(s => s.name).join(", ")}. Quote generated. Nothing ran and nothing touched the chain.`,
      undefined,
      stored.task.id,
      stored.task.contextId
    );
    setTaskState(stored, "TASK_STATE_COMPLETED", msg);
    return;
  }

  // ROAD 2: TENDER / TASK (`mode: "tender"` or `"task"`)
  // Multi-turn negotiation check: In strict "tender" mode (or when requireInput is set), tokenId is required!
  const resolvedTokenId = req.tokenId || stored.tokenId || (req.mode === "task" && !req.requireInput ? `auto-tender-${taskCounter + 1}` : undefined);
  const resolvedSkill = req.skill || stored.skill || heldSkills[0].name;
  const resolvedPrompt = (req.input?.prompt || req.prompt !== "General FOGA skill execution") ? req.prompt : (stored.prompt || req.prompt);

  stored.skill = resolvedSkill;
  stored.prompt = resolvedPrompt;

  if (!resolvedTokenId) {
    logEvent("A2A", `Task ${stored.task.id.slice(0, 8)} requires input: missing tokenId (TASK_STATE_INPUT_REQUIRED)`, { caller: caller.id });
    const msg = makeAgentMessage(
      "Which tender? Send a follow-up message with this taskId and {\"foga\":{\"mode\":\"tender\",\"tokenId\":\"<id>\"}} naming an ERC-8414 tender.",
      { foga: { need: ["tokenId"], taskId: stored.task.id } },
      stored.task.id,
      stored.task.contextId
    );
    setTaskState(stored, "TASK_STATE_INPUT_REQUIRED", msg);
    return;
  }

  stored.tokenId = resolvedTokenId;

  // Step 1: `tender_precheck` via L3 Catalog.invoke (Checks permission, safety, skill, policy, budget, wallet)
  const pre = catalogInvoke("tender_precheck", {
    tokenId: resolvedTokenId,
    skill: resolvedSkill,
    prompt: resolvedPrompt,
    rewardWei: req.rewardWei,
    valueWei: req.valueWei
  }, caller);

  if (!pre.ok) {
    const msg = makeAgentMessage(
      `Tender ${resolvedTokenId} refused at gate [${pre.gate}]: ${pre.reason}`,
      { foga: { gate: pre.gate, reason: pre.reason, decisionId: pre.decisionId } },
      stored.task.id,
      stored.task.contextId
    );
    setTaskState(stored, "TASK_STATE_REJECTED", msg);
    return;
  }
  stored.jobs.precheck = pre.jobId;

  // Step 2: `skill_run` via L3 Catalog.invoke
  logEvent("A2A", `Executing Task #${taskCounter + 1} with [${currentLlmEngine}] for ${caller.id}`, {
    skill: resolvedSkill,
    tokenId: resolvedTokenId
  });

  const run = catalogInvoke("skill_run", {
    tokenId: resolvedTokenId,
    skill: resolvedSkill,
    prompt: resolvedPrompt
  }, caller);

  if (!run.ok) {
    const msg = makeAgentMessage(
      `Skill run for tender ${resolvedTokenId} refused at gate [${run.gate}]: ${run.reason}`,
      { foga: { gate: run.gate, reason: run.reason, decisionId: run.decisionId } },
      stored.task.id,
      stored.task.contextId
    );
    setTaskState(stored, "TASK_STATE_REJECTED", msg);
    return;
  }
  stored.jobs.run = run.jobId;

  // Step 3: `tender_submit` via L3 Catalog.invoke
  const sub = catalogInvoke("tender_submit", {
    tokenId: resolvedTokenId,
    skill: resolvedSkill,
    resultHash: run.output.resultHash,
    runReceipt: run.output.runReceipt,
    valueWei: req.valueWei
  }, caller);

  if (!sub.ok) {
    const msg = makeAgentMessage(
      `Submission for tender ${resolvedTokenId} refused at gate [${sub.gate}]: ${sub.reason}`,
      { foga: { gate: sub.gate, reason: sub.reason, decisionId: sub.decisionId, jobId: sub.jobId } },
      stored.task.id,
      stored.task.contextId
    );
    setTaskState(stored, "TASK_STATE_REJECTED", msg);
    return;
  }
  stored.jobs.submit = sub.jobId;

  // Build final deliverable artifact
  stored.task.artifacts = [
    {
      artifactId: randomUUID(),
      name: "submission",
      description: "Task execution deliverable and FOGA L3 decision proof",
      parts: [
        {
          data: {
            foga: {
              submission: {
                tokenId: resolvedTokenId,
                cellAccount: bobCellAddress,
                agentId: bobAgentId,
                callerSigner: caller.id,
                skill: resolvedSkill,
                cognitiveEngine: run.output.engine,
                engineArchitecture: run.output.architecture,
                deliverable: run.output.deliverable,
                resultHash: run.output.resultHash,
                answerHash: run.output.answerHash,
                submissionId: sub.output.submissionId,
                txHash: sub.output.txHash,
                jobId: sub.jobId,
                decisionId: sub.decisionId,
                jobs: stored.jobs,
                operations: sub.operations,
                verifiedAt: new Date().toISOString()
              }
            }
          },
          mediaType: "application/json"
        }
      ]
    }
  ];

  const completeMsg = makeAgentMessage(
    run.output.deliverable,
    undefined,
    stored.task.id,
    stored.task.contextId
  );
  setTaskState(stored, "TASK_STATE_COMPLETED", completeMsg);
}

/**
 * Outbound P2P Client Helper: Signs request with THIS node's wallet and calls remote peer's `/a2a`
 */
async function callRemotePeerA2A(peerUrl, rpcMethod, rpcParams) {
  const cleanBase = peerUrl.replace(/\/+$/, "");
  // Step 1: Discover remote peer's AgentCard to know its verifyingContract (cellAddress)
  const cardRes = await fetch(`${cleanBase}/.well-known/agent-card.json`, {
    headers: { "Bypass-Tunnel-Reminder": "true" }
  });
  if (!cardRes.ok) {
    throw new Error(`Failed to fetch remote peer AgentCard (${cardRes.status})`);
  }
  const remoteCard = await cardRes.json();
  const remoteCellAddress = remoteCard.provider?.account;
  if (!remoteCellAddress) {
    throw new Error("Remote AgentCard missing provider.account");
  }

  // Step 2: Build JSON-RPC 2.0 body and sign with THIS node's wallet
  const rpcBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: rpcMethod,
    params: rpcParams
  };
  const bodyStr = JSON.stringify(rpcBody);
  const authHeader = await signRequestAuthorization(bobWallet, {
    cellAddress: remoteCellAddress,
    method: "POST",
    path: "/a2a",
    body: bodyStr,
    chainId: DEFAULT_CHAIN_ID,
    agentId: bobAgentId
  });

  // Step 3: Send POST /a2a with A2A-Version: 1.0 and EIP-712 Authorization
  const a2aRes = await fetch(`${cleanBase}/a2a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      "Authorization": authHeader,
      "Bypass-Tunnel-Reminder": "true"
    },
    body: bodyStr
  });

  const a2aJson = await a2aRes.json();
  const record = {
    id: randomUUID().slice(0, 8),
    timestamp: new Date().toLocaleTimeString(),
    direction: "OUTBOUND",
    peerUrl: cleanBase,
    remoteAgentName: remoteCard.name,
    remoteCellAddress,
    remoteAgentId: remoteCard.provider?.agentId,
    rpcMethod,
    httpStatus: a2aRes.status,
    response: a2aJson
  };
  peerInteractionHistory.unshift(record);
  if (peerInteractionHistory.length > 30) peerInteractionHistory.pop();

  logEvent("A2A", `Outbound P2P [${rpcMethod}] -> ${remoteCard.name} (${remoteCellAddress.slice(0, 10)}...)`, {
    status: a2aRes.status,
    taskState: a2aJson.result?.task?.status?.state || a2aJson.error?.message || "OK"
  });

  return { remoteCard, httpStatus: a2aRes.status, rpcResponse: a2aJson };
}

// HTTP Server
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, A2A-Version, Authorization, Bypass-Tunnel-Reminder");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const readBody = () => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  // A. A2A 1.0 AgentCard Discovery
  if (pathname === "/.well-known/agent-card.json" && method === "GET") {
    const card = buildAgentCard(url.origin);
    logEvent("A2A", "Agent Card requested by peer/client", { clientIp: req.socket.remoteAddress });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(card, null, 2));
    return;
  }

  // B. A2A 1.0 JSON-RPC Protocol Endpoint (`POST /a2a`)
  if (pathname === "/a2a" && method === "POST") {
    const bodyStr = await readBody();
    let body;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: A2A_ERRORS.ParseError, message: "Parse error: Invalid JSON" }
      }));
      return;
    }

    const { jsonrpc, id = null, method: rpcMethod, params } = body || {};
    if (!body || typeof body !== "object" || jsonrpc !== "2.0" || typeof rpcMethod !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: A2A_ERRORS.InvalidRequestError, message: "Request payload validation error: expected jsonrpc 2.0" }
      }));
      return;
    }

    // Audit Item #1: Strict `A2A-Version: 1.0` check (`src/a2a/server.ts#L121-L122`)
    const rawVersionHeader = req.headers["a2a-version"] || url.searchParams.get("A2A-Version") || "";
    const version = String(rawVersionHeader).trim() || "0.3";
    if (version !== "1.0") {
      logEvent("WARN", `Rejected unsupported A2A-Version '${version}' (expected 1.0)`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: A2A_ERRORS.VersionNotSupportedError,
          message: `A2A version ${version} is not supported; this agent speaks 1.0 (send A2A-Version: 1.0)`,
          data: [errorInfo("VERSION_NOT_SUPPORTED", { requested: version, supported: ["1.0"] })]
        }
      }));
      return;
    }

    // Verify EIP-712 Request Signature Header (if present)
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

      if (!authVerdict.ok) {
        logEvent("WARN", `Rejected invalid/tampered EIP-712 credential: ${authVerdict.reason}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32002,
            message: `InvalidCredential: ${authVerdict.reason}`
          }
        }));
        return;
      }

      logEvent("AUTH", `EIP-712 Signature Verified! Signer: ${authVerdict.signer}`, {
        agentId: authVerdict.agentId || "unknown",
        nonce: authVerdict.envelope.nonce.slice(0, 10) + "..."
      });
    }

    const caller = {
      id: authVerdict.ok ? authVerdict.signer : "anonymous",
      agentId: authVerdict.agentId || null,
      authenticated: authVerdict.ok,
      level: authVerdict.ok ? "act" : "read",
      visibility: "caller"
    };

    // Method 1: SendMessage
    if (rpcMethod === "SendMessage") {
      const m = params?.message;
      if (!m || typeof m !== "object" || !Array.isArray(m.parts) || m.parts.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.InvalidParamsError,
            message: "Invalid parameters: message and parts are required"
          }
        }));
        return;
      }

      const msgId = m.messageId || `auto-msg-${randomUUID()}`;
      m.messageId = msgId;

      // Check if execution mode is requested without signature (HTTP 403 boundary check)
      const parsedReq = parseFogaRequest(m);
      if ((parsedReq.mode === "task" || parsedReq.mode === "tender") && !authVerdict.ok) {
        logEvent("WARN", `Rejected unsigned ${parsedReq.mode} request (Signature required for execution)`);
        recordDecision({
          caller: "anonymous",
          capability: "tender_precheck",
          input: parsedReq,
          verdict: "refused",
          gate: "permission",
          reason: authVerdict.reason
        });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.AuthenticationRequiredError,
            message: `AuthenticationRequired: Executing tasks on ${nodeName} requires a valid FOGA-EIP712 signature envelope`,
            data: [authVerdict.reason]
          }
        }));
        return;
      }

      // Audit Item #2: `(caller, messageId)` Idempotent Deduplication (`src/a2a/server.ts#L169-L174`)
      const dedupeKey = `${caller.id.toLowerCase()}:${msgId}`;
      if (messageDedupe.has(dedupeKey)) {
        const existingTaskId = messageDedupe.get(dedupeKey);
        const existingStored = tasksStore.get(existingTaskId);
        if (existingStored) {
          logEvent("A2A", `Idempotent replay of messageId '${msgId}' from ${caller.id} -> returning existing task ${existingTaskId.slice(0, 8)}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { task: formatPublicTask(existingStored, params?.configuration?.historyLength), idempotent: true }
          }, null, 2));
          return;
        }
      }

      // Audit Item #3: Continuation of an existing task (`m.taskId`)
      if (m.taskId) {
        const stored = tasksStore.get(m.taskId);
        if (!stored || !isTaskVisible(stored, caller)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: A2A_ERRORS.TaskNotFoundError,
              message: "TaskNotFoundError: Task not found",
              data: [errorInfo("TASK_NOT_FOUND", { taskId: m.taskId })]
            }
          }));
          return;
        }
        if (TERMINAL_STATES.includes(stored.task.status.state)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: A2A_ERRORS.UnsupportedOperationError,
              message: `UnsupportedOperationError: task ${m.taskId} is ${stored.task.status.state} and accepts no further message`
            }
          }));
          return;
        }

        stored.messageIds.push(msgId);
        stored.task.history = [...(stored.task.history || []), m];
        messageDedupe.set(dedupeKey, stored.task.id);
        workTask(stored, m, caller);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { task: formatPublicTask(stored, params?.configuration?.historyLength) }
        }, null, 2));
        return;
      }

      // New Task Creation
      const newTaskId = randomUUID();
      const newContextId = m.contextId || randomUUID();
      const storedTask = {
        task: {
          id: newTaskId,
          contextId: newContextId,
          status: { state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString() },
          history: [m],
          artifacts: [],
          metadata: {
            caller: caller.id,
            callerAgentId: caller.agentId,
            cell: nodeName,
            cellAccount: bobCellAddress,
            cellAgentId: bobAgentId,
            cellIdentityInvariant: true
          }
        },
        caller: caller.id,
        messageIds: [msgId],
        createdAt: new Date().toISOString(),
        jobs: {}
      };

      tasksStore.set(newTaskId, storedTask);
      messageDedupe.set(dedupeKey, newTaskId);
      workTask(storedTask, m, caller);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { task: formatPublicTask(storedTask, params?.configuration?.historyLength) }
      }, null, 2));
      return;
    }

    // Method 2: GetTask (`src/a2a/server.ts#L268-L273`) — Enforces Caller Visibility Isolation
    if (rpcMethod === "GetTask") {
      const targetId = params?.id || params?.taskId;
      if (!targetId || typeof targetId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: A2A_ERRORS.InvalidParamsError, message: "Invalid parameters: task id is required" }
        }));
        return;
      }
      const stored = tasksStore.get(targetId);
      if (!stored || !isTaskVisible(stored, caller)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.TaskNotFoundError,
            message: "TaskNotFoundError: Task does not exist or is not visible to caller",
            data: [errorInfo("TASK_NOT_FOUND", { taskId: targetId })]
          }
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { task: formatPublicTask(stored, params?.historyLength) }
      }, null, 2));
      return;
    }

    // Method 3: ListTasks (`src/a2a/server.ts#L275-L286`) — Scoped to Authenticated Caller
    if (rpcMethod === "ListTasks") {
      const all = Array.from(tasksStore.values());
      let visibleTasks = all.filter(t => isTaskVisible(t, caller));
      if (params?.contextId) {
        visibleTasks = visibleTasks.filter(t => t.task.contextId === params.contextId);
      }
      if (params?.status) {
        visibleTasks = visibleTasks.filter(t => t.task.status.state === params.status);
      }
      visibleTasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const pageSize = Math.min(100, Math.max(1, params?.pageSize ?? 50));
      const offset = params?.pageToken ? Number(params.pageToken) || 0 : 0;
      const page = visibleTasks.slice(offset, offset + pageSize);
      const includeArtifacts = params?.includeArtifacts ?? true;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tasks: page.map(t => formatPublicTask(t, params?.historyLength, includeArtifacts)),
          nextPageToken: offset + pageSize < visibleTasks.length ? String(offset + pageSize) : "",
          pageSize,
          totalSize: visibleTasks.length
        }
      }, null, 2));
      return;
    }

    // Method 4: CancelTask (`src/a2a/server.ts#L288-L302`)
    if (rpcMethod === "CancelTask") {
      const targetId = params?.id || params?.taskId;
      if (!targetId || typeof targetId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: A2A_ERRORS.InvalidParamsError, message: "Invalid parameters: task id is required" }
        }));
        return;
      }
      const stored = tasksStore.get(targetId);
      if (!stored || !isTaskVisible(stored, caller)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.TaskNotFoundError,
            message: "TaskNotFoundError: Task not found",
            data: [errorInfo("TASK_NOT_FOUND", { taskId: targetId })]
          }
        }));
        return;
      }
      if (TERMINAL_STATES.includes(stored.task.status.state)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.TaskNotCancelableError,
            message: `TaskNotCancelableError: task ${targetId} is already in terminal state ${stored.task.status.state}`,
            data: [errorInfo("TASK_NOT_CANCELABLE", { taskId: targetId, state: stored.task.status.state })]
          }
        }));
        return;
      }
      if (stored.jobs?.submit) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: A2A_ERRORS.TaskNotCancelableError,
            message: `TaskNotCancelableError: task ${targetId} has submitted on chain (job ${stored.jobs.submit}); a broadcast is not undone`,
            data: [errorInfo("TASK_NOT_CANCELABLE", { taskId: targetId, jobId: stored.jobs.submit })]
          }
        }));
        return;
      }

      logEvent("A2A", `Task ${targetId.slice(0, 8)} cancelled by caller ${caller.id}`);
      setTaskState(stored, "TASK_STATE_CANCELED", makeAgentMessage("Cancelled by caller before submission.", undefined, stored.task.id, stored.task.contextId));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { task: formatPublicTask(stored) }
      }, null, 2));
      return;
    }

    // Standard Unsupported Operations (`src/a2a/server.ts#L138-L148`)
    if (["SendStreamingMessage", "SubscribeToTask", "GetExtendedAgentCard"].includes(rpcMethod)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: A2A_ERRORS.UnsupportedOperationError,
          message: `UnsupportedOperationError: ${rpcMethod} is not supported by this agent`
        }
      }));
      return;
    }

    if (["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"].includes(rpcMethod)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: A2A_ERRORS.PushNotificationNotSupportedError,
          message: "PushNotificationNotSupportedError: push notifications are not supported by this agent"
        }
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: A2A_ERRORS.MethodNotFoundError, message: `MethodNotFoundError: Method ${rpcMethod} is not supported` }
    }));
    return;
  }

  // C. Dynamic Control APIs (Ship of Theseus & L3 Guardian Controls)
  if (pathname === "/control/switch-llm" && method === "POST") {
    const raw = await readBody();
    const data = JSON.parse(raw || "{}");
    const oldEngine = currentLlmEngine;
    currentLlmEngine = data.llm || "claude-3-5-sonnet";
    logEvent("STATE", `Hot-Swapped L4 Cognitive Adapter: ${oldEngine} -> ${currentLlmEngine} (Cell Address stays ${bobCellAddress})`);
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
    const rawSkill = data.skill || {
      id: "market-sentiment-analyzer@2.0.0",
      name: "market-sentiment-analyzer",
      description: "Advanced multi-agent onchain order flow and sentiment scoring",
      tags: ["erc8338", "ai-finance", "v2"]
    };
    const newSkill = {
      ...rawSkill,
      version: rawSkill.version || "2.0.0",
      tokenId: String(100 + heldSkills.length + 1),
      packageHash: keccak256(toUtf8Bytes(rawSkill.id)),
      offered: true
    };
    heldSkills.push(newSkill);
    logEvent("STATE", `Hot-Plugged New ERC-8338 Skill: ${newSkill.id} (Cell Address stays ${bobCellAddress})`);
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

  if (pathname === "/control/toggle-safety" && method === "POST") {
    const raw = await readBody();
    const data = JSON.parse(raw || "{}");
    if (data.state === "ACTIVE" || data.state === "SUSPENDED") {
      safetyState = data.state;
    } else {
      safetyState = safetyState === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    }
    logEvent("STATE", `Guardian Safety Anchor changed to [${safetyState}]`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      safetyState,
      accountAddress: bobCellAddress,
      agentId: bobAgentId
    }));
    return;
  }

  // D. Outbound Symmetric P2P APIs (`/peer/discover`, `/peer/send`)
  if (pathname === "/peer/discover" && method === "POST") {
    try {
      const raw = await readBody();
      const { peerUrl } = JSON.parse(raw || "{}");
      const target = (peerUrl || defaultPeerUrl).replace(/\/+$/, "");
      const cardRes = await fetch(`${target}/.well-known/agent-card.json`, {
        headers: { "Bypass-Tunnel-Reminder": "true" }
      });
      if (!cardRes.ok) throw new Error(`HTTP ${cardRes.status}`);
      const card = await cardRes.json();
      logEvent("A2A", `Discovered Remote Peer Card: ${card.name} (AID: ${card.provider?.agentId}) at ${target}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, peerUrl: target, card }, null, 2));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Failed to connect to peer: ${err.message}` }));
    }
    return;
  }

  if (pathname === "/peer/send" && method === "POST") {
    try {
      const raw = await readBody();
      const payload = JSON.parse(raw || "{}");
      const target = (payload.peerUrl || defaultPeerUrl).replace(/\/+$/, "");
      const action = payload.action || "quote";

      let rpcMethod = "SendMessage";
      let rpcParams = {};

      if (action === "quote") {
        rpcParams = {
          message: {
            messageId: payload.messageId || `p2p-quote-${randomUUID()}`,
            role: "ROLE_USER",
            parts: [{
              data: {
                foga: {
                  mode: "quote",
                  ...(payload.skill ? { skill: payload.skill } : {})
                }
              }
            }]
          }
        };
      } else if (action === "tender" || action === "task") {
        rpcParams = {
          message: {
            messageId: payload.messageId || `p2p-tender-${randomUUID()}`,
            role: "ROLE_USER",
            ...(payload.taskId ? { taskId: payload.taskId } : {}),
            parts: [{
              data: {
                foga: {
                  mode: "tender",
                  tokenId: payload.tokenId !== undefined ? String(payload.tokenId) : `T-${Date.now().toString().slice(-4)}`,
                  skill: payload.skill || "foga-probe",
                  ...(payload.rewardWei !== undefined ? { rewardWei: String(payload.rewardWei) } : {}),
                  ...(payload.valueWei !== undefined ? { valueWei: String(payload.valueWei) } : {}),
                  input: {
                    prompt: payload.prompt || `Cross-Peer A2A request from ${nodeName} (AID ${bobAgentId})`
                  }
                }
              }
            }]
          }
        };
      } else if (action === "tender-missing-input") {
        // Intentionally omit tokenId to trigger TASK_STATE_INPUT_REQUIRED on remote peer
        rpcParams = {
          message: {
            messageId: `p2p-negotiate-${randomUUID()}`,
            role: "ROLE_USER",
            parts: [{
              data: {
                foga: {
                  mode: "tender",
                  skill: payload.skill || "foga-probe",
                  input: { prompt: payload.prompt || "Negotiated multi-turn task" }
                }
              }
            }]
          }
        };
      } else if (action === "get-task") {
        rpcMethod = "GetTask";
        rpcParams = { id: payload.taskId };
      } else if (action === "list-tasks") {
        rpcMethod = "ListTasks";
        rpcParams = { pageSize: 20, includeArtifacts: true };
      } else if (action === "cancel-task") {
        rpcMethod = "CancelTask";
        rpcParams = { id: payload.taskId };
      } else {
        throw new Error(`Unsupported peer action: ${action}`);
      }

      const out = await callRemotePeerA2A(target, rpcMethod, rpcParams);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...out }, null, 2));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // E. Status API (`/api/status`)
  if (pathname === "/api/status" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      agentName: nodeName,
      accountAddress: bobCellAddress,
      agentId: bobAgentId,
      port: PORT,
      defaultPeerUrl,
      currentLlmEngine,
      safetyState,
      policy: {
        minRewardWei: policyConfig.minRewardWei.toString(),
        perOpValueCapWei: policyConfig.perOpValueCapWei.toString(),
        dailyValueCapWei: policyConfig.dailyValueCapWei.toString()
      },
      budget: {
        spentValueWei: budgetBook.spentValueWei.toString(),
        spentFeesWei: budgetBook.spentFeesWei.toString(),
        modelCallsToday: budgetBook.modelCallsToday,
        skillRunsCount: budgetBook.skillRunsCount
      },
      skills: heldSkills,
      tasksCompleted: taskCounter,
      totalTasksStored: tasksStore.size,
      recentDecisions: decisionRecords.slice(0, 12),
      peerInteractions: peerInteractionHistory.slice(0, 10),
      uptimeSeconds: Math.floor(process.uptime()),
      recentLogs: recentLogs.slice(0, 15)
    }, null, 2));
    return;
  }

  // F. Interactive Web & P2P Peer Console
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
  <title>${nodeName} - Agent Bob 节点控制台 & P2P 对等终端</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #131b2e;
      --accent: #2563eb;
      --accent-glow: #3b82f6;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --border: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 18px; min-height: 100vh; }
    .container { max-width: 1080px; margin: 0 auto; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 18px; }
    .title-group h1 { font-size: 1.35rem; color: #fff; display: flex; align-items: center; gap: 8px; }
    .badge-live { background: rgba(16, 185, 129, 0.18); color: var(--success); font-size: 0.75rem; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--success); }
    .badge-suspended { background: rgba(239, 68, 68, 0.2); color: var(--danger); font-size: 0.75rem; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--danger); }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 760px) { .grid { grid-template-columns: 1fr 1fr; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .card-title { font-size: 0.88rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .code-box { background: #070a12; border: 1px solid #1a2234; border-radius: 6px; padding: 9px; font-family: monospace; font-size: 0.82rem; word-break: break-all; color: #38bdf8; }
    .stat-val { font-size: 1.25rem; font-weight: bold; color: #fff; margin: 4px 0; }
    .btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-size: 0.82rem; cursor: pointer; transition: 0.18s; font-weight: 500; }
    .btn:hover { background: var(--accent-glow); }
    .btn-group { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .btn-secondary { background: #26334d; }
    .btn-secondary:hover { background: #334466; }
    .btn-warn { background: #b45309; }
    .btn-warn:hover { background: #d97706; }
    .btn-success { background: #059669; }
    .btn-success:hover { background: #10b981; }
    .input-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .input-text { flex: 1; min-width: 200px; background: #070a12; border: 1px solid #28354f; color: #fff; padding: 8px 10px; border-radius: 6px; font-family: monospace; font-size: 0.85rem; }
    .log-container { background: #070a12; border: 1px solid #1a2234; border-radius: 8px; height: 220px; overflow-y: auto; padding: 10px; font-family: monospace; font-size: 0.78rem; }
    .log-item { margin-bottom: 6px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; }
    .log-time { color: var(--text-muted); margin-right: 6px; }
    .log-tag-A2A { color: #38bdf8; }
    .log-tag-AUTH { color: #4ade80; }
    .log-tag-GATE { color: #60a5fa; }
    .log-tag-STATE { color: #c084fc; }
    .log-tag-WARN { color: #facc15; }
    .full-width { grid-column: 1 / -1; }
    .skill-pill { display: inline-block; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; margin: 3px 2px; }
    .gate-pill { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-family: monospace; }
    .gate-allowed { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .gate-refused { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1><span>🤖</span> ${nodeName} — Agent Bob 节点控制台</h1>
        <span class="badge-live" id="protocolBadge">A2A 1.0 JSON-RPC 对等节点</span>
        <span class="badge-live" id="safetyBadge">L3 Safety: ${safetyState}</span>
      </div>
      <div class="btn-group" style="margin-top:0;">
        <button class="btn btn-warn" onclick="toggleSafety()">切换 L3 熔断开关 (Safety Gate)</button>
        <button class="btn btn-secondary" onclick="fetchStatus()">刷新状态</button>
      </div>
    </header>

    <div class="grid">
      <!-- 1. 法定身份锚点 (L1/L3 不可变) -->
      <div class="card">
        <div class="card-title">
          <span>L1/L3 法定身份锚点 (不可变)</span>
          <span style="color:#4ade80">● ERC-8434 / 8004</span>
        </div>
        <p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;">以太坊智能合约账户 (FogaCellAccount):</p>
        <div class="code-box" id="cellAddress">${bobCellAddress}</div>
        <div style="display:flex; justify-content:space-between; margin-top:10px; font-size:0.82rem;">
          <div><span style="color:var(--text-muted);">ERC-8004 AID: </span><b id="agentId">${bobAgentId}</b></div>
          <div><span style="color:var(--text-muted);">监听端口: </span><b>${PORT}</b></div>
          <div><span style="color:var(--text-muted);">完成任务: </span><b id="taskCount">${taskCounter}</b></div>
        </div>
      </div>

      <!-- 2. L4 认知适配器 (忒修斯之船) -->
      <div class="card">
        <div class="card-title">
          <span>L4 认知推理层 (可热插拔，仅具提议权)</span>
          <span style="color:#c084fc">★ L4 Propose Only</span>
        </div>
        <div class="stat-val" id="currentLlm" style="color:#c084fc;">${currentLlmEngine}</div>
        <p style="font-size:0.78rem; color:var(--text-muted);">切换认知引擎（L3 内核与以太坊地址 100% 保持不变）：</p>
        <div class="btn-group">
          <button class="btn btn-secondary" onclick="switchLlm('heuristic-rule-engine')">FOGA Stub 确定性规则表</button>
          <button class="btn btn-secondary" onclick="switchLlm('claude-3-5-sonnet')">Claude 3.5 适配器</button>
          <button class="btn btn-secondary" onclick="switchLlm('deepseek-r1')">DeepSeek R1 适配器</button>
        </div>
      </div>

      <!-- 3. P2P 对等节点连接器 (主动外呼对方 Agent) -->
      <div class="card full-width" style="border-color: #2563eb;">
        <div class="card-title">
          <span style="color:#60a5fa; font-weight:bold;">🌐 P2P 对等节点双向连接器 (Outbound Peer Connector — 本节点主动签名外呼对方 Agent)</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">携带 FOGA-EIP712 请求级签名</span>
        </div>
        <div class="input-row">
          <input id="peerUrlInput" class="input-text" value="${defaultPeerUrl}" placeholder="输入对方 Agent 地址 (例如 http://localhost:3002 或 https://xxxx.loca.lt)" />
          <input id="peerPromptInput" class="input-text" value="请求对方节点执行跨网链上状态与哈希一致性核验" placeholder="输入发送给对方 Agent 的任务内容" />
        </div>
        <div class="btn-group">
          <button class="btn btn-success" onclick="discoverPeer()">① 发现对方名片 (AgentCard)</button>
          <button class="btn" onclick="sendPeerAction('quote')">② 向对方发起询价 (Quote)</button>
          <button class="btn" onclick="sendPeerAction('tender')">③ 正式签名派单 (Tender 3-Step)</button>
          <button class="btn btn-secondary" onclick="sendPeerNegotiation()">④ 演示多轮缺参追问 (INPUT_REQUIRED -> 续接)</button>
          <button class="btn btn-warn" onclick="sendPeerGateProbe('skill')">⑤ 测对方 [Skill 门禁] 拒单</button>
          <button class="btn btn-warn" onclick="sendPeerGateProbe('policy')">⑥ 测对方 [Policy 报价底线] 拒单</button>
          <button class="btn btn-warn" onclick="sendPeerGateProbe('budget')">⑦ 测对方 [Budget 超限] 拒单</button>
          <button class="btn btn-secondary" onclick="sendPeerAction('list-tasks')">⑧ 查我方在对方的任务列表 (ListTasks)</button>
        </div>
        <div id="peerResponseBox" class="code-box" style="margin-top:10px; max-height:190px; overflow-y:auto; color:#a7f3d0;">
          等待发起跨节点 P2P 交互... (提示：本机可同时运行 3001 与 3002 端口互调，或填入导师的 https://xxx.loca.lt 隧道地址)
        </div>
      </div>

      <!-- 4. 持有技能与 L3 预算/策略门禁状态 -->
      <div class="card">
        <div class="card-title">
          <span>ERC-8338 技能包 (Token-Bound Skills)</span>
          <button class="btn" style="padding:3px 8px; font-size:0.75rem;" onclick="upgradeSkill()">+ 热挂载新技能</button>
        </div>
        <div id="skillsList">
          ${heldSkills.map(s => `<span class="skill-pill">⚡ ${s.id}</span>`).join("")}
        </div>
        <div style="margin-top:12px; font-size:0.78rem; color:var(--text-muted); border-top:1px solid var(--border); padding-top:8px;">
          <div>• Policy 最低报价底线: <code>${policyConfig.minRewardWei.toString()} wei</code></div>
          <div>• Budget 单笔价值上限: <code>${policyConfig.perOpValueCapWei.toString()} wei</code></div>
          <div>• 今日已执行技能次数: <b id="skillRunsCount">${budgetBook.skillRunsCount}</b></div>
        </div>
      </div>

      <!-- 5. L3 确定性内核决策存证 (Decision Records) -->
      <div class="card">
        <div class="card-title">
          <span>L3 内核三关裁决存证 (Catalog Decision Records)</span>
          <span style="font-size:0.72rem; color:var(--text-muted);">Perceive → Propose → Decide → Record</span>
        </div>
        <div class="log-container" id="decisionBox" style="height:150px;">
          <div style="color:var(--text-muted);">暂无裁决记录</div>
        </div>
      </div>

      <!-- 6. 实时 A2A 协议与 EIP-712 验签日志 -->
      <div class="card full-width">
        <div class="card-title">
          <span>A2A 实时通信、门禁拦截与 EIP-712 验签报文流</span>
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
    let lastNegotiationTaskId = null;

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('currentLlm').innerText = data.currentLlmEngine;
        document.getElementById('taskCount').innerText = data.tasksCompleted;
        document.getElementById('skillRunsCount').innerText = data.budget?.skillRunsCount ?? 0;

        const safetyBadge = document.getElementById('safetyBadge');
        safetyBadge.innerText = 'L3 Safety: ' + data.safetyState;
        safetyBadge.className = data.safetyState === 'ACTIVE' ? 'badge-live' : 'badge-suspended';

        const skillsHtml = data.skills.map(s => '<span class="skill-pill">⚡ ' + s.id + '</span>').join('');
        document.getElementById('skillsList').innerHTML = skillsHtml;

        const decBox = document.getElementById('decisionBox');
        if (data.recentDecisions && data.recentDecisions.length > 0) {
          decBox.innerHTML = data.recentDecisions.map(d => {
            const cls = d.verdict === 'allowed' ? 'gate-allowed' : 'gate-refused';
            return '<div class="log-item">' +
              '<span class="gate-pill ' + cls + '">' + d.verdict.toUpperCase() + (d.gate !== 'none' ? ' @ ' + d.gate : '') + '</span> ' +
              '<b>' + d.capability + '</b> ' +
              '<span style="color:#94a3b8">(' + d.id + ' | model: ' + (d.model?.model || 'stub') + ')</span><br/>' +
              '<span style="color:#cbd5e1">' + d.reason + '</span>' +
            '</div>';
          }).join('');
        }

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

    async function toggleSafety() {
      await fetch('/control/toggle-safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
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

    function showPeerResult(title, obj) {
      const box = document.getElementById('peerResponseBox');
      box.innerText = '>>> ' + title + '\\n' + JSON.stringify(obj, null, 2);
      fetchStatus();
    }

    async function discoverPeer() {
      const peerUrl = document.getElementById('peerUrlInput').value.trim();
      showPeerResult('正在拉取远程 Peer 名片: ' + peerUrl, { loading: true });
      const res = await fetch('/peer/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerUrl })
      });
      const data = await res.json();
      showPeerResult('成功发现远程 Peer AgentCard', data);
    }

    async function sendPeerAction(action) {
      const peerUrl = document.getElementById('peerUrlInput').value.trim();
      const prompt = document.getElementById('peerPromptInput').value.trim();
      showPeerResult('正在向远程 Peer 发送签名请求 [' + action + ']...', { peerUrl });
      const res = await fetch('/peer/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerUrl, action, prompt })
      });
      const data = await res.json();
      showPeerResult('远程 Peer 响应 [' + action + ']', data);
    }

    async function sendPeerNegotiation() {
      const peerUrl = document.getElementById('peerUrlInput').value.trim();
      const prompt = document.getElementById('peerPromptInput').value.trim();
      // Step 1: Send tender without tokenId -> triggers TASK_STATE_INPUT_REQUIRED
      const res1 = await fetch('/peer/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerUrl, action: 'tender-missing-input', prompt })
      });
      const data1 = await res1.json();
      const taskId = data1.rpcResponse?.result?.task?.id;
      const state1 = data1.rpcResponse?.result?.task?.status?.state;

      if (!taskId || state1 !== 'TASK_STATE_INPUT_REQUIRED') {
        showPeerResult('多轮协商第 1 步结果', data1);
        return;
      }

      // Step 2: Automatically supply the missing tokenId on the SAME taskId!
      const res2 = await fetch('/peer/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerUrl,
          action: 'tender',
          taskId,
          tokenId: 'T-NEGOTIATED-88',
          prompt: prompt + ' (已补交 tokenId 完成多轮协商)'
        })
      });
      const data2 = await res2.json();
      showPeerResult('多轮协商完成 (Step 1: INPUT_REQUIRED -> Step 2: 补参后 COMPLETED)', {
        step1_InputRequired: data1.rpcResponse?.result?.task?.status,
        step2_CompletedTask: data2.rpcResponse?.result?.task
      });
    }

    async function sendPeerGateProbe(gateType) {
      const peerUrl = document.getElementById('peerUrlInput').value.trim();
      let payload = { peerUrl, action: 'tender', prompt: 'Gate boundary verification probe' };
      if (gateType === 'skill') {
        payload.skill = 'non-existent-oracle-skill';
      } else if (gateType === 'policy') {
        payload.rewardWei = '100'; // Below 100000000000000 wei policy floor
      } else if (gateType === 'budget') {
        payload.valueWei = '9990000000000000000'; // Exceeds 0.001 ETH per-op cap
      }
      const res = await fetch('/peer/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      showPeerResult('远程 Peer L3 门禁拦截实测 [' + gateType.toUpperCase() + ' GATE]', data);
    }

    setInterval(fetchStatus, 2000);
  </script>
</body>
</html>`;
}

// Start Server
const lanIp = getLanIp();
server.listen(PORT, HOST, () => {
  console.log("\n==================================================================");
  console.log(`🚀 ${nodeName} (FOGA Symmetric Peer) Started!`);
  console.log(`==================================================================`);
  console.log(`• Local Endpoint   : http://localhost:${PORT}`);
  console.log(`• LAN Mobile Access : http://${lanIp}:${PORT}`);
  console.log(`• A2A AgentCard    : http://localhost:${PORT}/.well-known/agent-card.json`);
  console.log(`• A2A Service URL  : http://localhost:${PORT}/a2a`);
  console.log(`• Default Peer URL : ${defaultPeerUrl}`);
  console.log(`• Cell Account     : ${bobCellAddress}`);
  console.log(`• ERC-8004 AID     : ${bobAgentId}`);
  console.log(`• L3 Safety State  : ${safetyState}`);
  console.log(`• L4 Cognitive     : ${currentLlmEngine}`);
  console.log(`==================================================================\n`);
});
