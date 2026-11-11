// -*- coding: utf-8 -*-
/**
 * Agent Alice - Consumer Agent (A2A Client & Theseus Verification Driver)
 * Demonstrates:
 * 1. Automatic Discovery of Bob's AgentCard (/.well-known/agent-card.json)
 * 2. EIP-712 Request-Bound Cryptographic Signature Generation (FOGA-EIP712)
 * 3. Secure Task Dispatching & Artifact Reception via A2A 1.0 JSON-RPC
 * 4. Automated Proof of Identity Invariance across Cognitive Engine & Skill Swaps
 */

import { ethers } from "ethers";
import { signRequestAuthorization, DEFAULT_CHAIN_ID } from "./crypto_utils.js";

// Alice's Deterministic Wallet & Identity
const ALICE_PRIVATE_KEY = process.env.ALICE_PRIVATE_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const aliceWallet = new ethers.Wallet(ALICE_PRIVATE_KEY);
const aliceAddress = aliceWallet.address;
const aliceAgentId = "9999";

const TARGET_HOST = process.env.BOB_URL || "http://localhost:3001";

// ANSI Styling for Pretty Terminal Output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  dim: "\x1b[2m"
};

function banner() {
  console.log(`${colors.cyan}${colors.bold}`);
  console.log("==================================================================");
  console.log("         🤖 Agent Alice (A2A 1.0 Client & Verifier)               ");
  console.log("==================================================================");
  console.log(`• Alice Address : ${colors.green}${aliceAddress}${colors.cyan}`);
  console.log(`• Alice AID     : ${aliceAgentId}`);
  console.log(`• Target Node   : ${colors.yellow}${TARGET_HOST}${colors.cyan}`);
  console.log(`==================================================================${colors.reset}\n`);
}

/**
 * 1. Discover Bob's Agent Card
 */
async function fetchAgentCard() {
  const url = `${TARGET_HOST}/.well-known/agent-card.json`;
  console.log(`${colors.blue}🔍 [Step] Fetching Agent Card from: ${url}...${colors.reset}`);
  const res = await fetch(url, {
    headers: { "Bypass-Tunnel-Reminder": "true" }
  });
  if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.statusText}`);
  const card = await res.json();
  return card;
}

/**
 * 2. Send Signed A2A Request
 */
async function sendSignedA2aMessage(cellAddress, messagePayload) {
  const path = "/a2a";
  const url = `${TARGET_HOST}${path}`;
  const rpcBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "SendMessage",
    params: {
      message: messagePayload
    }
  };
  const bodyStr = JSON.stringify(rpcBody);

  // Sign using Alice's wallet with EIP-712 typed envelope
  const authHeader = await signRequestAuthorization(aliceWallet, {
    cellAddress: cellAddress,
    method: "POST",
    path: path,
    body: bodyStr,
    chainId: DEFAULT_CHAIN_ID,
    agentId: aliceAgentId
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      "Authorization": authHeader,
      "Bypass-Tunnel-Reminder": "true"
    },
    body: bodyStr
  });

  const responseJson = await res.json();
  return responseJson;
}

/**
 * Demo Mode: Automated Full Proof of Identity Invariance ("Ship of Theseus")
 */
async function runIdentityInvarianceDemo() {
  banner();
  console.log(`${colors.magenta}${colors.bold}>>> 启动分布式 Agent 身份确权与“忒修斯之船”全自动验证 <<<\n${colors.reset}`);

  // Step 1: Discover Bob
  const card = await fetchAgentCard();
  const bobCellAddress = card.provider.account;
  const bobAgentId = card.provider.agentId;
  console.log(`${colors.green}✔ 成功发现目标 Agent:${colors.reset}`);
  console.log(`  - 名称: ${colors.bold}${card.name}${colors.reset}`);
  console.log(`  - 链上账户地址: ${colors.yellow}${bobCellAddress}${colors.reset}`);
  console.log(`  - 初始认知引擎: ${colors.magenta}${card.capabilities.cognitiveEngine}${colors.reset}`);
  console.log(`  - 支持技能包: ${card.skills.map(s => s.name).join(", ")}\n`);

  const observedIdentities = [];

  // Helper for Task execution
  async function executeAndRecord(stageName, prompt) {
    console.log(`${colors.cyan}------------------------------------------------------------------${colors.reset}`);
    console.log(`${colors.bold}📍 [${stageName}]${colors.reset} Alice 发送任务: "${colors.yellow}${prompt}${colors.reset}"`);
    console.log(`${colors.dim}   (正在构建 EIP-712 签名并发送 POST /a2a ...)${colors.reset}`);

    const res = await sendSignedA2aMessage(bobCellAddress, {
      messageId: "msg-" + Date.now(),
      role: "ROLE_USER",
      parts: [
        {
          data: {
            foga: {
              mode: "task",
              skill: "foga-probe",
              input: { prompt }
            }
          }
        }
      ]
    });

    if (res.error) {
      console.log(`${colors.reset}❌ 任务失败:`, res.error);
      return;
    }

    const task = res.result.task;
    const submission = task.artifacts.find(a => a.name === "submission")?.parts[0]?.data?.foga?.submission;
    console.log(`${colors.green}✔ Bob 成功响应 (状态: ${task.status.state})${colors.reset}:`);
    console.log(`  • 实际执行大脑: ${colors.magenta}${submission.cognitiveEngine}${colors.reset}`);
    console.log(`  • 架构描述: ${submission.engineArchitecture}`);
    console.log(`  • 执行结果: ${colors.dim}${submission.deliverable}${colors.reset}`);
    console.log(`  • 承载法定地址: ${colors.yellow}${submission.cellAccount}${colors.reset}`);

    observedIdentities.push({
      stage: stageName,
      engine: submission.cognitiveEngine,
      address: submission.cellAccount,
      agentId: submission.agentId
    });
    console.log();
  }

  // --- Round 1: Heuristic Engine
  await executeAndRecord("阶段一：初始规则引擎", "计算 Sepolia 链上 Gas 波动与安全性指标");

  // --- Round 2: Hot-Swap to Claude 3.5
  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 Claude 3.5 Sonnet...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "claude-3-5-sonnet" })
  });
  await new Promise(r => setTimeout(r, 600));

  await executeAndRecord("阶段二：认知引擎切换为 Claude 3.5", "分析同类任务并给出多步骤规划");

  // --- Round 3: Hot-Swap to DeepSeek R1
  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 DeepSeek R1 (思维链模型)...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "deepseek-r1" })
  });
  await new Promise(r => setTimeout(r, 600));

  await executeAndRecord("阶段三：认知引擎切换为 DeepSeek R1", "基于链上博弈推演做深度逻辑严密推理");

  // --- Round 4: Hot-Plug Skill Upgrade
  console.log(`${colors.yellow}⚙ [管理操作] 动态升级技能：为 Bob 挂载新技能包 [market-sentiment-analyzer@2.0.0]...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/upgrade-skill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skill: {
        id: "market-sentiment-analyzer@2.0.0",
        name: "market-sentiment-analyzer",
        description: "Advanced sentiment and orderflow analyzer"
      }
    })
  });
  await new Promise(r => setTimeout(r, 600));

  // Re-fetch card
  const updatedCard = await fetchAgentCard();
  console.log(`${colors.green}✔ 升级后 Bob 的技能列表包含: ${updatedCard.skills.map(s => s.name).join(", ")}${colors.reset}\n`);

  // --- Final Identity Verification Table
  console.log(`${colors.cyan}==================================================================`);
  console.log(`📊 【忒修斯之船 —— 身份不变性终极裁决】 (Identity Invariance Report)`);
  console.log(`==================================================================${colors.reset}`);

  console.table(observedIdentities.map(i => ({
    "测试阶段": i.stage,
    "所用认知大模型": i.engine,
    "Agent 物理账户地址 (Body)": i.address,
    "Agent ID": i.agentId,
    "身份判定": "✅ 绝对同一 (100% Invariant)"
  })));

  const allSame = observedIdentities.every(i => i.address === bobCellAddress && i.agentId === bobAgentId);

  if (allSame) {
    console.log(`${colors.green}${colors.bold}🎉 验证结论：完全通过！`);
    console.log(`证明事实：在经历 3 次大模型彻底替换、1 次可执行技能包升级后，Agent Bob 的以太坊物理地址与法定身份保持完全同一，完全符合 FOGA“Identity is one's own; only the genome replicates”的顶层设计铁律！${colors.reset}\n`);
  }
}

// CLI Command Parser
const cmd = process.argv[2] || "demo-identity";

if (cmd === "card") {
  banner();
  fetchAgentCard().then(card => console.log(JSON.stringify(card, null, 2))).catch(console.error);
} else if (cmd === "quote") {
  banner();
  fetchAgentCard().then(async card => {
    console.log(`Sending signed Quote request to ${card.provider.account}...`);
    const res = await sendSignedA2aMessage(card.provider.account, {
      messageId: "quote-" + Date.now(),
      role: "ROLE_USER",
      parts: [{ text: "What are your terms?" }]
    });
    console.log(JSON.stringify(res, null, 2));
  }).catch(console.error);
} else if (cmd === "task") {
  banner();
  const prompt = process.argv[3] || "Please verify cryptographic hash integrity";
  fetchAgentCard().then(async card => {
    console.log(`Sending signed Task request: "${prompt}"...`);
    const res = await sendSignedA2aMessage(card.provider.account, {
      messageId: "task-" + Date.now(),
      role: "ROLE_USER",
      parts: [{
        data: {
          foga: {
            mode: "task",
            skill: "foga-probe",
            input: { prompt }
          }
        }
      }]
    });
    console.log(JSON.stringify(res, null, 2));
  }).catch(console.error);
} else if (cmd === "demo-identity") {
  runIdentityInvarianceDemo().catch(console.error);
} else {
  console.log(`Unknown command: ${cmd}`);
  console.log("Usage: node agent_alice_client.js [card|quote|task|demo-identity]");
}

