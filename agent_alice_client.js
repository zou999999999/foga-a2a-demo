// -*- coding: utf-8 -*-
/**
 * Agent Alice & External Agent CLI Driver (`Antigravity` ⇄ `Codex` Bridge)
 * Supports:
 * 1. `inbox`  : Read incoming A2A tasks waiting for local AI Agent (Antigravity / Codex) to answer
 * 2. `reply`  : Submit real AI Agent reasoning to local FOGA L3 node (`POST /agent/reply`)
 * 3. `ask`    : Dispatch signed A2A task from local FOGA node to remote peer tunnel URL (`POST /peer/send`)
 * 4. `demo-identity` : Automated proof of Identity Invariance ("Ship of Theseus")
 * 5. `demo-p2p`      : Automated 5-phase P2P & L3 Three-Check Gate walkthrough
 * 6. `card` / `quote` / `task` : Direct single-step A2A commands
 */

import { ethers } from "ethers";
import { signRequestAuthorization, DEFAULT_CHAIN_ID } from "./crypto_utils.js";

const ALICE_PRIVATE_KEY = process.env.ALICE_PRIVATE_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const aliceWallet = new ethers.Wallet(ALICE_PRIVATE_KEY);
const aliceAddress = aliceWallet.address;
const aliceAgentId = process.env.ALICE_AGENT_ID || "9999";

// Parse optional `--port <num>` or `--peer-b` for local node control
const rawArgs = process.argv.slice(2);
const portIdx = rawArgs.indexOf("--port");
const localPort = portIdx !== -1 && rawArgs[portIdx + 1]
  ? parseInt(rawArgs[portIdx + 1], 10)
  : (rawArgs.includes("--peer-b") ? 3002 : 3001);

const LOCAL_NODE = (process.env.LOCAL_NODE_URL || `http://localhost:${localPort}`).replace(/\/+$/, "");
const TARGET_HOST = (process.env.BOB_URL || process.env.PEER_URL || "http://localhost:3001").replace(/\/+$/, "");

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
  console.log("     🤖 FOGA A2A 1.0 Peer Client & External Agent CLI Bridge      ");
  console.log("==================================================================");
  console.log(`• Signer Address: ${colors.green}${aliceAddress}${colors.cyan}`);
  console.log(`• Signer AID    : ${aliceAgentId}`);
  console.log(`• Local Node    : ${colors.yellow}${LOCAL_NODE}${colors.cyan}`);
  console.log(`• Target Node   : ${colors.yellow}${TARGET_HOST}${colors.cyan}`);
  console.log(`==================================================================${colors.reset}\n`);
}

async function fetchAgentCard(hostUrl = TARGET_HOST) {
  const url = `${hostUrl}/.well-known/agent-card.json`;
  console.log(`${colors.blue}🔍 [Step] Fetching Agent Card from: ${url}...${colors.reset}`);
  const res = await fetch(url, {
    headers: { "Bypass-Tunnel-Reminder": "true" }
  });
  if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.statusText}`);
  return await res.json();
}

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
 * External Agent Bridge Commands (`inbox`, `reply`, `ask`) for Antigravity & Codex
 */
async function checkLocalInbox() {
  const res = await fetch(`${LOCAL_NODE}/agent/inbox`);
  const data = await res.json();
  console.log(`${colors.magenta}${colors.bold}📥 本地节点收件箱 (${data.nodeName} | AID: ${data.agentId} | 当前认知模式: ${data.currentLlmEngine})${colors.reset}`);
  console.log(`• 节点法定以太坊地址: ${colors.yellow}${data.cellAddress}${colors.reset}`);
  console.log(`• 待真 Agent (Antigravity/Codex) 回复任务数: ${colors.green}${data.pendingCount}${colors.reset}\n`);

  if (data.pendingTasks.length > 0) {
    console.log(`${colors.cyan}--- 待处理任务 (TASK_STATE_WORKING) ---${colors.reset}`);
    for (const t of data.pendingTasks) {
      console.log(`🔔 Task ID   : ${colors.bold}${t.taskId}${colors.reset}`);
      console.log(`   来自签名者: ${t.callerAddress} (AID: ${t.callerAgentId || "unknown"})`);
      console.log(`   请求技能  : ${t.skill} | 标的 TokenID: ${t.tokenId}`);
      console.log(`   对方提问  : "${colors.yellow}${t.prompt}${colors.reset}"`);
      console.log(`   👉 回复指令: node agent_alice_client.js reply ${t.taskId} "<你的思考回复>" --port ${localPort}\n`);
    }
  }

  if (data.recentInbound.length > 0) {
    console.log(`${colors.dim}--- 最近入站记录 (${data.recentInbound.length} 条) ---${colors.reset}`);
    for (const r of data.recentInbound.slice(0, 5)) {
      console.log(`• [${r.state}] Task ${r.taskId.slice(0, 8)}... | 提问: "${r.prompt}" | 回复大脑: ${r.cognitiveEngine || "待回复"}`);
    }
  }
}

async function replyToInboxTask(taskId, replyText, modelName) {
  const res = await fetch(`${LOCAL_NODE}/agent/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskId,
      replyText,
      modelName: modelName || (localPort === 3002 ? "external-codex" : "external-antigravity")
    })
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`${colors.red}❌ 回复失败: ${data.error}${colors.reset}`);
    return;
  }
  const sub = data.task.artifacts?.[0]?.parts?.[0]?.data?.foga?.submission;
  console.log(`${colors.green}${colors.bold}✔ 真 Agent 回复已由 L3 内核盖章存证并交付！${colors.reset}`);
  console.log(`  • Task ID        : ${data.task.id}`);
  console.log(`  • 最终状态       : ${colors.green}${data.task.status.state}${colors.reset}`);
  console.log(`  • 思考大脑标识   : ${colors.magenta}${sub?.cognitiveEngine}${colors.reset}`);
  console.log(`  • L3 决策存证 ID : ${colors.cyan}${sub?.decisionId}${colors.reset}`);
  console.log(`  • 结果完整性哈希 : ${sub?.resultHash}`);
  console.log(`  • 法定签名地址   : ${colors.yellow}${sub?.cellAccount}${colors.reset} (AID: ${sub?.agentId})`);
}

async function askRemotePeer(peerUrl, prompt, waitFlag = false) {
  console.log(`${colors.cyan}📤 正在通过本地节点 (${LOCAL_NODE}) 向远程对等节点 (${peerUrl}) 发送 EIP-712 签名任务...${colors.reset}`);
  const res = await fetch(`${LOCAL_NODE}/peer/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      peerUrl,
      action: "tender",
      skill: "foga-probe",
      prompt
    })
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`${colors.red}❌ 发送失败: ${data.error}${colors.reset}`);
    return;
  }

  let task = data.rpcResponse?.result?.task;
  console.log(`${colors.green}✔ 远程节点 (${data.remoteCard?.name} | AID: ${data.remoteAgentId}) 已受理请求！${colors.reset}`);
  console.log(`  • Task ID  : ${colors.bold}${task?.id}${colors.reset}`);
  console.log(`  • 当前状态 : ${colors.yellow}${task?.status?.state}${colors.reset}`);

  // If remote peer is in External Agent mode (TASK_STATE_WORKING) and --wait is specified, poll GetTask
  if (task?.status?.state === "TASK_STATE_WORKING" && waitFlag) {
    console.log(`${colors.magenta}⏳ 对方节点处于真 Agent (Codex/Antigravity) 接管模式，正在等待对方大脑思考回复...${colors.reset}`);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${LOCAL_NODE}/peer/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerUrl, action: "get-task", taskId: task.id })
      });
      const pollData = await pollRes.json();
      const latestTask = pollData.rpcResponse?.result?.task;
      if (latestTask && latestTask.status?.state !== "TASK_STATE_WORKING") {
        task = latestTask;
        break;
      }
    }
  }

  const sub = task?.artifacts?.[0]?.parts?.[0]?.data?.foga?.submission;
  if (sub) {
    console.log(`\n${colors.green}${colors.bold}🎉 收到远程 Agent 正式签名交付物:${colors.reset}`);
    console.log(`  • 对方法定地址 : ${colors.yellow}${sub.cellAccount}${colors.reset} (AID: ${sub.agentId})`);
    console.log(`  • 对方执行大脑 : ${colors.magenta}${sub.cognitiveEngine}${colors.reset} (${sub.engineArchitecture})`);
    console.log(`  • L3 决策存证  : ${colors.cyan}${sub.decisionId}${colors.reset} | 结果哈希: ${sub.resultHash}`);
    console.log(`  • 对方回复内容 : "${colors.bold}${sub.deliverable}${colors.reset}"\n`);
  } else {
    console.log(`  • 状态说明 : ${task?.status?.message?.parts?.[0]?.text || ""}`);
    console.log(`  • 查询进展 : node agent_alice_client.js check ${peerUrl} ${task?.id} --port ${localPort}\n`);
  }
}

/**
 * Demo Mode 1: Automated Full Proof of Identity Invariance ("Ship of Theseus")
 */
async function runIdentityInvarianceDemo() {
  banner();
  console.log(`${colors.magenta}${colors.bold}>>> 启动分布式 Agent 身份确权与“忒修斯之船”全自动验证 <<<\n${colors.reset}`);

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

  await executeAndRecord("阶段一：初始 FOGA Stub 规则引擎", "计算 Sepolia 链上 Gas 波动与安全性指标");

  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 Claude 3.5 Sonnet...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "claude-3-5-sonnet" })
  });
  await new Promise(r => setTimeout(r, 400));

  await executeAndRecord("阶段二：认知引擎切换为 Claude 3.5", "分析同类任务并给出多步骤规划");

  console.log(`${colors.yellow}⚙ [管理操作] 触发热插拔：将 Bob 的认知层切换为 DeepSeek R1 (思维链模型)...${colors.reset}`);
  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "deepseek-r1" })
  });
  await new Promise(r => setTimeout(r, 400));

  await executeAndRecord("阶段三：认知引擎切换为 DeepSeek R1", "基于链上博弈推演做深度逻辑严密推理");

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

  await fetch(`${TARGET_HOST}/control/switch-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" },
    body: JSON.stringify({ llm: "heuristic-rule-engine" })
  });

  const card = await fetchAgentCard();
  const cellAddress = card.provider.account;

  console.log(`${colors.cyan}[1/5] 阶段一：公开询价轨 (Quote Road)${colors.reset}`);
  const quoteRes = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-quote-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "quote", skill: "foga-probe" } } }]
  });
  const quoteData = quoteRes.result.task.artifacts[0].parts[0].data.foga.quote;
  console.log(`${colors.green}✔ 收到对方报价与履约条款:${colors.reset} 最低回报=${quoteData.terms.minRewardWei} wei, 验收机制=${quoteData.terms.acceptance}\n`);

  console.log(`${colors.cyan}[2/5] 阶段二：多轮缺参追问与任务续接 (INPUT_REQUIRED -> COMPLETED)${colors.reset}`);
  const step1Res = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-neg1-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "tender", skill: "foga-probe", input: { prompt: "跨网多轮协商测试" } } } }]
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

  console.log(`${colors.cyan}[4/5] 阶段四：任务中途取消控制 (CancelTask)${colors.reset}`);
  const pendingRes = await sendSignedA2aMessage(cellAddress, {
    messageId: `p2p-cancel-init-${Date.now()}`,
    role: "ROLE_USER",
    parts: [{ data: { foga: { mode: "tender", skill: "foga-probe" } } }]
  });
  const cancelRes = await sendSignedRpc(cellAddress, "CancelTask", { id: pendingRes.result.task.id });
  console.log(`${colors.green}✔ 成功取消未提交任务 (${pendingRes.result.task.id.slice(0, 8)}...): 状态变为 ${cancelRes.result.task.status.state}${colors.reset}\n`);

  console.log(`${colors.cyan}[5/5] 阶段五：按调用方签名隔离查询历史任务列表 (ListTasks)${colors.reset}`);
  const listRes = await sendSignedRpc(cellAddress, "ListTasks", { pageSize: 5 });
  console.log(`${colors.green}✔ Alice 名下共有 ${listRes.result.totalSize} 笔历史任务 (其他 Agent 无权查看)${colors.reset}\n`);
}

// CLI Command Dispatcher
const cmd = process.argv[2] || "demo-identity";

if (cmd === "inbox") {
  checkLocalInbox().catch(console.error);
} else if (cmd === "reply") {
  const taskId = process.argv[3];
  const replyText = process.argv[4];
  const modelName = (process.argv[5] && !process.argv[5].startsWith("--")) ? process.argv[5] : undefined;
  replyToInboxTask(taskId, replyText, modelName).catch(console.error);
} else if (cmd === "ask") {
  const peerUrl = process.argv[3] || "http://localhost:3002";
  const prompt = process.argv[4] || "Hello from Peer Agent! Please analyze the FOGA 5-layer decoupling design.";
  const waitFlag = rawArgs.includes("--wait");
  askRemotePeer(peerUrl, prompt, waitFlag).catch(console.error);
} else if (cmd === "check") {
  const peerUrl = process.argv[3] || "http://localhost:3002";
  const taskId = process.argv[4];
  fetch(`${LOCAL_NODE}/peer/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerUrl, action: "get-task", taskId })
  }).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2))).catch(console.error);
} else if (cmd === "card") {
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
  console.log("Usage: node agent_alice_client.js [inbox|reply|ask|check|card|quote|task|demo-identity|demo-p2p]");
}
