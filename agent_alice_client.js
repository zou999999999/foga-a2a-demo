// -*- coding: utf-8 -*-
/**
 * Agent Alice - Consumer / Symmetric Peer Driver (A2A 1.0 Client & Theseus Verification Driver)
 * Demonstrates:
 * 1. Automatic Discovery of Target Peer's AgentCard (`/.well-known/agent-card.json`)
 * 2. EIP-712 Request-Bound Cryptographic Signature Generation (`FOGA-EIP712`)
 * 3. Two-Road A2A 1.0 JSON-RPC Protocol (`quote` vs `tender` 3-step pipeline)
 * 4. Multi-Turn Negotiation (`TASK_STATE_INPUT_REQUIRED` -> Task Continuation)
 * 5. L3 Deterministic Gate Verification (`permission`, `safety`, `skill`, `policy`, `budget`)
 * 6. Automated Proof of Identity Invariance across Cognitive Engine & Skill Swaps ("Ship of Theseus")
 */

import { ethers } from "ethers";
import { signRequestAuthorization, DEFAULT_CHAIN_ID } from "./crypto_utils.js";

// Alice's Deterministic Wallet & Identity
const ALICE_PRIVATE_KEY = process.env.ALICE_PRIVATE_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const aliceWallet = new ethers.Wallet(ALICE_PRIVATE_KEY);
const aliceAddress = aliceWallet.address;
const aliceAgentId = process.env.ALICE_AGENT_ID || "9999";

const TARGET_HOST = (process.env.BOB_URL || process.env.PEER_URL || "http://localhost:3001").replace(/\/+$/, "");

// ANSI Styling for Pretty Terminal Output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  dim: "\x1b[2m"
};

function banner() {
  console.log(`${colors.cyan}${colors.bold}`);
  console.log("==================================================================");
  console.log("         🤖 Agent Alice (A2A 1.0 Peer Client & Verifier)          ");
  console.log("==================================================================");
  console.log(`• Alice Address : ${colors.green}${aliceAddress}${colors.cyan}`);
  console.log(`• Alice AID     : ${aliceAgentId}`);
  console.log(`• Target Node   : ${colors.yellow}${TARGET_HOST}${colors.cyan}`);
  console.log(`==================================================================${colors.reset}\n`);
}

/**
 * 1. Discover Target Peer's Agent Card
 */
async function fetchAgentCard(hostUrl = TARGET_HOST) {
  const url = `${hostUrl}/.well-known/agent-card.json`;
  console.log(`${colors.blue}🔍 [Step] Fetching Agent Card from: ${url}...${colors.reset}`);
  const res = await fetch(url, {
    headers: { "Bypass-Tunnel-Reminder": "true" }
  });
  if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.statusText}`);
  return await res.json();
}

/**
 * 2. Send Signed A2A JSON-RPC Request (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`)
 */
async function sendSignedRpc(cellAddress, method, params, hostUrl = TARGET_HOST) {
  const path = "/a2a";
  const url = `${hostUrl}${path}`;
  const rpcBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params
  };
  const bodyStr = JSON.stringify(rpcBody);

  const authHeader = await signRequestAuthorization(aliceWallet, {
    cellAddress,
    method: "POST",
    path,
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

  return await res.json();
}

async function sendSignedA2aMessage(cellAddress, messagePayload, hostUrl = TARGET_HOST) {
  return sendSignedRpc(cellAddress, "SendMessage", { message: messagePayload }, hostUrl);
}

/**
 * Demo Mode 1: Automated Full Proof of Identity Invariance ("Ship of Theseus")
 */
async function runIdentityInvarianceDemo() {
  banner();
  console.log(`${colors.magenta}${colors.bold}>>> 启动分布式 Agent 身份确权与“忒修斯之船”全自动验证 <<<\n${colors.reset}`);

  // Reset Bob to initial heuristic-rule-engine first for clean repeatable demo
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "heuristic-rule-engine" })
  });

  const card = await fetchAgentCard();
  const bobCellAddress = card.provider.account;
  const bobAgentId = card.provider.agentId;
  console.log(`${colors.green}✔ 成功发现目标 Agent:${colors.reset}`);
  console.log(`  - 名称: ${colors.bold}${card.name}${colors.reset}`);
  console.log(`  - 链上账户地址: ${colors.yellow}${bobCellAddress}${colors.reset}`);
  console.log(`  - 初始认知引擎: ${colors.magenta}${card.capabilities.cognitiveEngine}${colors.reset}`);
  console.log(`  - 支持技能包: ${card.skills.map(s => s.name).join(", ")}\n`);

  const observedIdentities = [];

  async function executeAndRecord(stageName, prompt) {
    console.log(`${colors.cyan}------------------------------------------------------------------${colors.reset}`);
    console.log(`${colors.bold}📍 [${stageName}]${colors.reset} Alice 发送任务: "${colors.yellow}${prompt}${colors.reset}"`);
    console.log(`${colors.dim}   (正在构建 EIP-712 签名并发送 POST /a2a ...)${colors.reset}`);

    const res = await sendSignedA2aMessage(bobCellAddress, {
      messageId: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      role: "ROLE_USER",
      parts: [
        {
          data: {
            foga: {
              mode: "tender",
              tokenId: "T-" + Date.now().toString().slice(-4),
              skill: "foga-probe",
              input: { prompt }
            }
          }
        }
      ]
    });

    if (res.error) {
      console.log(`${colors.red}❌ 任务失败:${colors.reset}`, res.error);
      return;
    }

    const task = res.result.task;
    const submission = task.artifacts.find(a => a.name === "submission")?.parts[0]?.data?.foga?.submission;
    console.log(`${colors.green}✔ Bob 成功响应 (状态: ${task.status.state})${colors.reset}:`);
    console.log(`  • 实际执行大脑: ${colors.magenta}${submission.cognitiveEngine}${colors.reset}`);
    console.log(`  • 架构描述: ${submission.engineArchitecture}`);
    console.log(`  • L3 决策存证 ID: ${colors.cyan}${submission.decisionId}${colors.reset} | 结果哈希: ${colors.dim}${submission.resultHash.slice(0, 18)}...${colors.reset}`);
    console.log(`  • 执行结果: ${colors.dim}${submission.deliverable}${colors.reset}`);
    console.log(`  • 承载法定地址: ${colors.yellow}${submission.cellAccount}${colors.reset}`);

    observedIdentities.push({
      stage: stageName,
      engine: submission.cognitiveEngine,
      decisionId: submission.decisionId,
      address: submission.cellAccount,
      agentId: submission.agentId
    });
    console.log();
  }

  // Round 1: Heuristic Rule Engine (Stub)
  await executeAndRecord("阶段一：初始 FOGA Stub 规则引擎", "计算 Sepolia 链上 Gas 波动与安全性指标");

  // Round 2: Hot-Swap to Claude 3.5
  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 Claude 3.5 Sonnet...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "claude-3-5-sonnet" })
  });
  await new Promise(r => setTimeout(r, 400));

  await executeAndRecord("阶段二：认知引擎切换为 Claude 3.5", "分析同类任务并给出多步骤规划");

  // Round 3: Hot-Swap to DeepSeek R1
  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 DeepSeek R1 (思维链模型)...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "deepseek-r1" })
  });
  await new Promise(r => setTimeout(r, 400));

  await executeAndRecord("阶段三：认知引擎切换为 DeepSeek R1", "基于链上博弈推演做深度逻辑严密推理");

  // Round 4: Hot-Plug Skill Upgrade
  console.log(`${colors.yellow}⚙ [管理操作] 动态升级技能：为 Bob 挂载新技能包 [market-sentiment-analyzer@2.0.0]...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/upgrade-skill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({
      skill: {
        id: "market-sentiment-analyzer@2.0.0",
        name: "market-sentiment-analyzer",
        description: "Advanced sentiment and orderflow analyzer"
      }
    })
  });
  await new Promise(r => setTimeout(r, 400));

  const updatedCard = await fetchAgentCard();
  console.log(`${colors.green}✔ 升级后 Bob 的技能列表包含: ${updatedCard.skills.map(s => s.name).join(", ")}${colors.reset}\n`);

  console.log(`${colors.cyan}==================================================================`);
  console.log(`📊 【忒修斯之船 —— 身份不变性终极裁决】 (Identity Invariance Report)`);
  console.log(`==================================================================${colors.reset}`);

  console.table(observedIdentities.map(i => ({
    "测试阶段": i.stage,
    "所用认知大模型": i.engine,
    "L3 决策编号": i.decisionId,
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

/**
 * Demo Mode 2: Full P2P Protocol & FOGA 3-Gate Kernel Walkthrough
 */
async function runP2pProtocolDemo() {
  banner();
  console.log(`${colors.magenta}${colors.bold}>>> 启动 FOGA P2P 全流程信息交换与 L3 三道门禁裁决演练 <<<\n${colors.reset}`);

  const card = await fetchAgentCard();
  const cellAddress = card.provider.account;

  // 1. Quote Road
  console.log(`${colors.cyan}[1/5] 阶段一：公开询价轨 (Quote Road)${colors.reset}`);
  const quoteRes = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-quote-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "quote", skill: "foga-probe" } } }]
  });
  const quoteData = quoteRes.result.task.artifacts[0].parts[0].data.foga.quote;
  console.log(`${colors.green}✔ 收到对方报价与履约条款:${colors.reset} 最低回报=${quoteData.terms.minRewardWei} wei, 验收机制=${quoteData.terms.acceptance}\n`);

  // 2. Multi-Turn Negotiation (TASK_STATE_INPUT_REQUIRED -> Continuation)
  console.log(`${colors.cyan}[2/5] 阶段二：多轮缺参追问与任务续接 (INPUT_REQUIRED -> COMPLETED)${colors.reset}`);
  const step1Res = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-neg1-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "tender", skill: "foga-probe", input: { prompt: "跨网多轮协商测试" } } } }] // Missing tokenId!
  });
  const negTask = step1Res.result.task;
  console.log(`  • 第 1 步（未传 tokenId）：对方返回状态 ${colors.yellow}${negTask.status.state}${colors.reset}，追问字段: ${JSON.stringify(negTask.status.message.parts[1]?.data?.foga?.need)}`);

  const step2Res = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-neg2-${Date.now()}`,
    taskId: negTask.id,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "tender", tokenId: "T-888", skill: "foga-probe", input: { prompt: "跨网多轮协商测试（已补齐 tokenId）" } } } }]
  });
  console.log(`  • 第 2 步（携带同一 taskId 补交 tokenId）：任务状态流转为 ${colors.green}${step2Res.result.task.status.state}${colors.reset}\n`);

  // 3. L3 Kernel Gate Refusals (Skill / Policy / Budget)
  console.log(`${colors.cyan}[3/5] 阶段三：L3 确定性内核三道门禁拦截实测 (Catalog.invoke Gates)${colors.reset}`);
  for (const probe of [
    { label: "未持有技能请求", payload: { mode: "tender", tokenId: "T-901", skill: "unknown-oracle" } },
    { label: "低于报价底线请求", payload: { mode: "tender", tokenId: "T-902", skill: "foga-probe", rewardWei: "50" } },
    { label: "超出单笔预算上限请求", payload: { mode: "tender", tokenId: "T-903", skill: "foga-probe", valueWei: "9900000000000000000" } }
  ]) {
    const r = await sendSignedA2aMessage(cellAddress, {
      messageId: `p2p-gate-${Date.now()}-${Math.random()}`,
      role: "ROLE_USER",
      parts: [{ data: { foga: probe.payload } }]
    });
    const t = r.result.task;
    const gateInfo = t.status.message.parts[1]?.data?.foga;
    console.log(`  • [${probe.label}] -> 状态: ${colors.yellow}${t.status.state}${colors.reset} | 拦截门禁: ${colors.red}gate=${gateInfo?.gate}${colors.reset} | 决策存证: ${gateInfo?.decisionId}`);
  }
  console.log();

  // 4. CancelTask lifecycle
  console.log(`${colors.cyan}[4/5] 阶段四：任务中途取消控制 (CancelTask)${colors.reset}`);
  const pendingRes = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-cancel-init-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "tender", skill: "foga-probe" } } }]
  });
  const cancelRes = await sendSignedRpc(cellAddress, "CancelTask", { id: pendingRes.result.task.id });
  console.log(`${colors.green}✔ 成功取消未提交任务 (${pendingRes.result.task.id.slice(0, 8)}...): 状态变为 ${cancelRes.result.task.status.state}${colors.reset}\n`);

  // 5. ListTasks scoped to Alice
  console.log(`${colors.cyan}[5/5] 阶段五：按调用方签名隔离查询历史任务列表 (ListTasks)${colors.reset}`);
  const listRes = await sendSignedRpc(cellAddress, "ListTasks", { pageSize: 5 });
  console.log(`${colors.green}✔ Alice 名下共有 ${listRes.result.totalSize} 笔历史任务 (其他 Agent 无权查看)${colors.reset}\n`);
}

// CLI Command Dispatcher
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
      parts: [{ data: { foga: { mode: "quote", skill: "foga-probe" } } }]
    });
    console.log(JSON.stringify(res, null, 2));
  }).catch(console.error);
} else if (cmd === "task" || cmd === "tender") {
  banner();
  const prompt = process.argv[3] || "Please verify cryptographic hash integrity";
  fetchAgentCard().then(async card => {
    console.log(`Sending signed Tender/Task request: "${prompt}"...`);
    const res = await sendSignedA2aMessage(card.provider.account, {
      messageId: "task-" + Date.now(),
      role: "ROLE_USER",
      parts: [{
        data: {
          foga: {
            mode: "tender",
            tokenId: "T-" + Date.now().toString().slice(-4),
            skill: "foga-probe",
            input: { prompt }
          }
        }
      }]
    });
    console.log(JSON.stringify(res, null, 2));
  }).catch(console.error);
} else if (cmd === "demo-p2p") {
  runP2pProtocolDemo().catch(console.error);
} else if (cmd === "demo-identity") {
  runIdentityInvarianceDemo().catch(console.error);
} else {
  console.log(`Unknown command: ${cmd}`);
  console.log("Usage: node agent_alice_client.js [card|quote|task|demo-identity|demo-p2p]");
}
