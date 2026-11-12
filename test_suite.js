// -*- coding: utf-8 -*-
/**
 * Automated Comprehensive Test Suite for FOGA A2A Symmetric P2P & L3 Gate Engine
 * Verifies 42 strict assertions across 14 categories:
 * 1–8.  Core A2A 1.0 Card, EIP-712 Security Envelope, Anti-Tamper, Anti-Replay, and Ship of Theseus Invariance
 * 9.    A2A-Version: 1.0 strict protocol enforcement (-32009) & unsupported method rejection (-32004)
 * 10.   (caller, messageId) idempotent deduplication
 * 11.   Multi-turn negotiation (TASK_STATE_INPUT_REQUIRED -> Task Continuation by taskId)
 * 12.   FOGA L3 Kernel Catalog.invoke Three-Check Gates (skill, policy, budget, safety) & Decision Records
 * 13.   Caller Visibility Isolation (GetTask/ListTasks privacy) & CancelTask lifecycle
 * 14.   True Symmetric P2P Dual-Node Interoperability (Peer 8888 on 3001 ⇄ Peer 9999 on 3002)
 */

import { spawn } from "node:child_process";
import { ethers } from "ethers";
import { signRequestAuthorization, DEFAULT_CHAIN_ID } from "./crypto_utils.js";

const TARGET_HOST = (process.env.BOB_URL || "http://localhost:3001").replace(/\/+$/, "");
const PEER_B_HOST = "http://localhost:3002";

const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const EVE_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const aliceWallet = new ethers.Wallet(ALICE_KEY);
const eveWallet = new ethers.Wallet(EVE_KEY);

let totalPassed = 0;
let totalFailed = 0;

function assert(condition, testName, extra = "") {
  if (condition) {
    totalPassed++;
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${testName} ${extra}`);
  } else {
    totalFailed++;
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${testName} ${extra}`);
  }
}

async function signedPostA2A(wallet, cellAddress, rpcBody, host = TARGET_HOST) {
  const bodyStr = JSON.stringify(rpcBody);
  const authHeader = await signRequestAuthorization(wallet, {
    cellAddress,
    method: "POST",
    path: "/a2a",
    body: bodyStr,
    chainId: DEFAULT_CHAIN_ID,
    agentId: wallet.address === aliceWallet.address ? "9999" : "7777"
  });
  const res = await fetch(`${host}/a2a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      "Authorization": authHeader
    },
    body: bodyStr
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function ensureServerUp(url, args = []) {
  try {
    const r = await fetch(`${url}/api/status`);
    if (r.ok) return null;
  } catch {
    // Not running yet, spawn child
  }
  const child = spawn(process.execPath, ["agent_bob_server.js", ...args], {
    stdio: "ignore"
  });
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const r = await fetch(`${url}/api/status`);
      if (r.ok) return child;
    } catch {
      // wait
    }
  }
  return child;
}

async function runTests() {
  console.log("\n==================================================================");
  console.log("   🧪 FOGA A2A 对称 P2P 与 L3 内核门禁全方位严密性自检套件       ");
  console.log("==================================================================\n");

  const spawnedPeerA = await ensureServerUp(TARGET_HOST, []);
  const spawnedPeerB = await ensureServerUp(PEER_B_HOST, ["--peer-b"]);

  try {
    // 1. Basic Health & Status
    try {
      const res = await fetch(`${TARGET_HOST}/api/status`);
      const status = await res.json();
      assert(res.status === 200, "1.1 /api/status HTTP 200 返回正常");
      assert(status.accountAddress.startsWith("0x"), "1.2 Agent 物理账户格式正确", status.accountAddress);
      assert(status.agentId === "8888", "1.3 Agent ID 正确 (8888)");
    } catch (err) {
      assert(false, "1.1 /api/status 接口可访问性", err.message);
    }

    // 2. A2A 1.0 AgentCard Validation
    let cellAddress = "";
    try {
      const res = await fetch(`${TARGET_HOST}/.well-known/agent-card.json`);
      const card = await res.json();
      assert(res.status === 200, "2.1 /.well-known/agent-card.json 接口正常");
      assert(card.supportedInterfaces?.[0]?.protocolBinding === "JSONRPC", "2.2 协议绑定声明为 JSONRPC");
      assert(card.supportedInterfaces?.[0]?.protocolVersion === "1.0", "2.3 协议版本声明为 1.0");
      assert(card.securitySchemes?.["wallet-signature"]?.scheme === "FOGA-EIP712", "2.4 安全认证声明包含 FOGA-EIP712");
      assert(Array.isArray(card.skills) && card.skills.length >= 2, "2.5 技能列表包含有效可执行技能");
      cellAddress = card.provider.account;
    } catch (err) {
      assert(false, "2.1 AgentCard 校验", err.message);
    }

    // 3. Security Boundary: Unsigned task MUST be rejected (403)
    try {
      const res = await fetch(`${TARGET_HOST}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "SendMessage",
          params: {
            message: {
              messageId: "unsigned-1",
              role: "ROLE_USER",
              parts: [{ data: { foga: { mode: "task", skill: "foga-probe" } } }]
            }
          }
        })
      });
      const errBody = await res.json();
      assert(res.status === 403, "3.1 未签名的执行类 Task 必须被 403 严格拦截");
      assert(errBody.error?.code === -32001, "3.2 错误码为 -32001 (AuthenticationRequired)");
    } catch (err) {
      assert(false, "3.1 未签名拦截测试", err.message);
    }

    // 4. Security Boundary: Tampered payload MUST be rejected
    try {
      const originalBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "SendMessage",
        params: { message: { messageId: "tamper-1", parts: [{ text: "Original" }] } }
      });
      const authHeader = await signRequestAuthorization(aliceWallet, {
        cellAddress,
        method: "POST",
        path: "/a2a",
        body: originalBody
      });

      const tamperedBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "SendMessage",
        params: { message: { messageId: "tamper-1", parts: [{ text: "MALICIOUS TAMPERED" }] } }
      });

      const res = await fetch(`${TARGET_HOST}/a2a`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
          "Authorization": authHeader
        },
        body: tamperedBody
      });
      assert(res.status === 401 || res.status === 403, "4.1 篡改过 Body 的恶意请求必须被拦截 (401/403 InvalidCredential)", `Status: ${res.status}`);
    } catch (err) {
      assert(false, "4.1 防篡改测试", err.message);
    }

    // 5. Security Boundary: Replayed Nonce MUST be rejected
    try {
      const bodyStr = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "SendMessage",
        params: {
          message: {
            messageId: "replay-test-" + Date.now(),
            parts: [{ data: { foga: { mode: "task", skill: "foga-probe", input: { prompt: "Replay me" } } } }]
          }
        }
      });

      const authHeader = await signRequestAuthorization(aliceWallet, {
        cellAddress,
        method: "POST",
        path: "/a2a",
        body: bodyStr
      });

      const res1 = await fetch(`${TARGET_HOST}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0", "Authorization": authHeader },
        body: bodyStr
      });
      assert(res1.status === 200, "5.1 首次合法请求成功通过");

      const res2 = await fetch(`${TARGET_HOST}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0", "Authorization": authHeader },
        body: bodyStr
      });
      assert(res2.status === 401 || res2.status === 403, "5.2 重放相同 Nonce 的重复攻击被严格拦截 (NonceCache 生效)", `Status: ${res2.status}`);
    } catch (err) {
      assert(false, "5.1 Nonce 重放测试", err.message);
    }

    // 6. Valid Signed Quote
    try {
      const { json } = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 4,
        method: "SendMessage",
        params: {
          message: {
            messageId: "quote-test-" + Date.now(),
            parts: [{ data: { foga: { mode: "quote", skill: "foga-probe" } } }]
          }
        }
      });
      assert(json.result?.task?.status?.state === "TASK_STATE_COMPLETED", "6.1 签名询价 (Quote) 请求正常履约返回");
      assert(json.result?.task?.artifacts?.[0]?.name === "quote", "6.2 返回合规的 quote 资产结构");
    } catch (err) {
      assert(false, "6.1 Quote 询价测试", err.message);
    }

    // 7. Dynamic LLM Hot-Swap & Identity Invariance
    try {
      const statusBefore = await (await fetch(`${TARGET_HOST}/api/status`)).json();
      const addrBefore = statusBefore.accountAddress;

      const swapRes = await fetch(`${TARGET_HOST}/control/switch-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: "claude-3-5-sonnet" })
      });
      const swapData = await swapRes.json();
      assert(swapData.ok === true && swapData.currentEngine === "claude-3-5-sonnet", "7.1 大模型热切换至 Claude 3.5 成功");

      const statusAfter = await (await fetch(`${TARGET_HOST}/api/status`)).json();
      assert(statusAfter.accountAddress === addrBefore, "7.2 切换大模型后，Agent 物理以太坊地址保持绝对不变 (Invariant)", `${statusAfter.accountAddress}`);
      assert(statusAfter.agentId === statusBefore.agentId, "7.3 切换大模型后，Agent ID 保持绝对不变", `${statusAfter.agentId}`);

      const skillRes = await fetch(`${TARGET_HOST}/control/upgrade-skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill: {
            id: "automated-test-skill@3.0.0",
            name: "automated-test-skill",
            description: "Auto test upgrade"
          }
        })
      });
      const skillData = await skillRes.json();
      assert(skillData.ok === true, "7.4 技能热升级挂载成功");

      const statusFinal = await (await fetch(`${TARGET_HOST}/api/status`)).json();
      assert(statusFinal.accountAddress === addrBefore, "7.5 技能升级后，Agent 物理以太坊地址保持绝对不变", `${statusFinal.accountAddress}`);
    } catch (err) {
      assert(false, "7.1 身份不变性热插拔测试", err.message);
    }

    // 8. Dashboard HTML rendering
    try {
      const res = await fetch(`${TARGET_HOST}/`);
      const html = await res.text();
      assert(res.status === 200, "8.1 Web/Mobile Dashboard 页面正常渲染 (HTTP 200)");
      assert(html.includes("Agent Bob 节点控制台"), "8.2 Dashboard 包含核心控制台组件");
      assert(html.includes("A2A 1.0 JSON-RPC"), "8.3 Dashboard 包含协议状态标识");
    } catch (err) {
      assert(false, "8.1 Dashboard 页面测试", err.message);
    }

    // 9. Audit Item #1: A2A-Version: 1.0 Header Enforcement & Unsupported Method Error Codes
    try {
      const noVerRes = await fetch(`${TARGET_HOST}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // Missing A2A-Version header (defaults to 0.3)
        body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "SendMessage", params: {} })
      });
      const noVerJson = await noVerRes.json();
      assert(noVerJson.error?.code === -32009, "9.1 缺失 A2A-Version 请求头时严格返回 -32009 (VersionNotSupportedError)");

      const { json: streamJson } = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 92,
        method: "SendStreamingMessage",
        params: {}
      });
      assert(streamJson.error?.code === -32004, "9.2 调用不支持的流式方法返回标准 -32004 (UnsupportedOperationError)");
    } catch (err) {
      assert(false, "9.1 版本与方法边界校验", err.message);
    }

    // 10. Audit Item #2: (caller, messageId) Idempotent Deduplication
    try {
      const sharedMsgId = `idempotent-msg-${Date.now()}`;
      const r1 = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 101,
        method: "SendMessage",
        params: {
          message: {
            messageId: sharedMsgId,
            parts: [{ data: { foga: { mode: "tender", tokenId: "T-101", skill: "foga-probe", input: { prompt: "Idempotency check" } } } }]
          }
        }
      });
      const r2 = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 102,
        method: "SendMessage",
        params: {
          message: {
            messageId: sharedMsgId, // Same messageId from same caller with a fresh signature
            parts: [{ data: { foga: { mode: "tender", tokenId: "T-101", skill: "foga-probe", input: { prompt: "Idempotency check" } } } }]
          }
        }
      });
      assert(r1.json.result?.task?.id === r2.json.result?.task?.id, "10.1 相同 (caller, messageId) 幂等返回同一 Task ID");
      assert(r2.json.result?.idempotent === true, "10.2 幂等命中标识 idempotent: true 生效，避免重复执行");
    } catch (err) {
      assert(false, "10.1 幂等防重测试", err.message);
    }

    // 11. Audit Item #3: Multi-Turn Negotiation (TASK_STATE_INPUT_REQUIRED -> Continuation)
    try {
      const step1 = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 111,
        method: "SendMessage",
        params: {
          message: {
            messageId: `neg-step1-${Date.now()}`,
            parts: [{ data: { foga: { mode: "tender", skill: "foga-probe", input: { prompt: "Need tokenId negotiation" } } } }]
          }
        }
      });
      const task1 = step1.json.result?.task;
      assert(task1?.status?.state === "TASK_STATE_INPUT_REQUIRED", "11.1 缺参 Tender 请求进入 TASK_STATE_INPUT_REQUIRED 多轮追问状态");

      const step2 = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 112,
        method: "SendMessage",
        params: {
          message: {
            messageId: `neg-step2-${Date.now()}`,
            taskId: task1.id,
            parts: [{ data: { foga: { mode: "tender", tokenId: "T-112", skill: "foga-probe", input: { prompt: "Supplied tokenId" } } } }]
          }
        }
      });
      const task2 = step2.json.result?.task;
      assert(task2?.id === task1.id && task2?.status?.state === "TASK_STATE_COMPLETED", "11.2 携带同一 taskId 补交参数后，任务成功续接并流转为 TASK_STATE_COMPLETED");

      const step3 = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 113,
        method: "SendMessage",
        params: {
          message: {
            messageId: `neg-step3-${Date.now()}`,
            taskId: task1.id,
            parts: [{ text: "Message after terminal state" }]
          }
        }
      });
      assert(step3.json.error?.code === -32004, "11.3 向已终结(COMPLETED)任务继续发消息被 -32004 (UnsupportedOperationError) 拒绝");
    } catch (err) {
      assert(false, "11.1 多轮追问与续接测试", err.message);
    }

    // 12. Audit Item #4: FOGA L3 Catalog.invoke Three-Check Gates & Decision Records
    try {
      // 12.1 Quote for unoffered skill -> TASK_STATE_REJECTED
      const qBad = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 121,
        method: "SendMessage",
        params: { message: { messageId: `qbad-${Date.now()}`, parts: [{ data: { foga: { mode: "quote", skill: "non-existent-skill" } } }] } }
      });
      assert(qBad.json.result?.task?.status?.state === "TASK_STATE_REJECTED", "12.1 询价未提供的技能返回 TASK_STATE_REJECTED 并附带可用技能清单");

      // 12.2 Tender for unheld skill -> gate: "skill"
      const gSkill = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 122,
        method: "SendMessage",
        params: { message: { messageId: `gskill-${Date.now()}`, parts: [{ data: { foga: { mode: "tender", tokenId: "T-G1", skill: "foga-oracle-unheld" } } }] } }
      });
      const gSkillGate = gSkill.json.result?.task?.status?.message?.parts?.[1]?.data?.foga?.gate;
      assert(gSkill.json.result?.task?.status?.state === "TASK_STATE_REJECTED" && gSkillGate === "skill", "12.2 请求未持有技能被 L3 内核 [skill] 门禁精准拦截");

      // 12.3 Tender below policy floor -> gate: "policy"
      const gPolicy = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 123,
        method: "SendMessage",
        params: { message: { messageId: `gpol-${Date.now()}`, parts: [{ data: { foga: { mode: "tender", tokenId: "T-G2", skill: "foga-probe", rewardWei: "10" } } }] } }
      });
      const gPolicyGate = gPolicy.json.result?.task?.status?.message?.parts?.[1]?.data?.foga?.gate;
      assert(gPolicy.json.result?.task?.status?.state === "TASK_STATE_REJECTED" && gPolicyGate === "policy", "12.3 报价低于底线被 L3 内核 [policy] 门禁精准拦截");

      // 12.4 Tender above per-op budget cap -> gate: "budget"
      const gBudget = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 124,
        method: "SendMessage",
        params: { message: { messageId: `gbud-${Date.now()}`, parts: [{ data: { foga: { mode: "tender", tokenId: "T-G3", skill: "foga-probe", valueWei: "9999000000000000000" } } }] } }
      });
      const gBudgetGate = gBudget.json.result?.task?.status?.message?.parts?.[1]?.data?.foga?.gate;
      assert(gBudget.json.result?.task?.status?.state === "TASK_STATE_REJECTED" && gBudgetGate === "budget", "12.4 超出单笔预算上限被 L3 内核 [budget] 门禁精准拦截");

      // 12.5 Guardian safety suspension -> gate: "safety", then resume
      await fetch(`${TARGET_HOST}/control/toggle-safety`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "SUSPENDED" })
      });
      const gSafety = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 125,
        method: "SendMessage",
        params: { message: { messageId: `gsafe-${Date.now()}`, parts: [{ data: { foga: { mode: "tender", tokenId: "T-G4", skill: "foga-probe" } } }] } }
      });
      const gSafetyGate = gSafety.json.result?.task?.status?.message?.parts?.[1]?.data?.foga?.gate;
      assert(gSafety.json.result?.task?.status?.state === "TASK_STATE_REJECTED" && gSafetyGate === "safety", "12.5 Guardian 熔断暂停期间被 L3 内核 [safety] 门禁精准拦截");

      // Restore ACTIVE state
      await fetch(`${TARGET_HOST}/control/toggle-safety`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "ACTIVE" })
      });

      // 12.6 Verify Decision Records in /api/status
      const st = await (await fetch(`${TARGET_HOST}/api/status`)).json();
      assert(Array.isArray(st.recentDecisions) && st.recentDecisions.length >= 5 && st.recentDecisions[0].model?.promptHash?.startsWith("0x"), "12.6 L3 内核生成不可篡改 Decision Records (含 promptHash/responseHash)");
    } catch (err) {
      assert(false, "12.1 L3 门禁与决策存证测试", err.message);
    }

    // 13. Audit Items #5 & #6: Caller Visibility Isolation, ListTasks, CancelTask
    try {
      // Create a pending task (INPUT_REQUIRED) as Alice
      const pending = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 131,
        method: "SendMessage",
        params: { message: { messageId: `vis-${Date.now()}`, parts: [{ data: { foga: { mode: "tender", skill: "foga-probe" } } }] } }
      });
      const aliceTaskId = pending.json.result?.task?.id;

      // Alice can GetTask
      const getByAlice = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 132,
        method: "GetTask",
        params: { id: aliceTaskId }
      });
      assert(getByAlice.json.result?.task?.id === aliceTaskId, "13.1 任务创建者 Alice 调用 GetTask 成功读取自身任务");

      // Eve (third party) CANNOT GetTask Alice's task
      const getByEve = await signedPostA2A(eveWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 133,
        method: "GetTask",
        params: { id: aliceTaskId }
      });
      assert(getByEve.json.error?.code === -32006, "13.2 第三方 Agent (Eve) 越权调用 GetTask 被严格隔离 (-32006 TaskNotFoundError)");

      // Alice cancels her pending task
      const cancelRes = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 134,
        method: "CancelTask",
        params: { id: aliceTaskId }
      });
      assert(cancelRes.json.result?.task?.status?.state === "TASK_STATE_CANCELED", "13.3 CancelTask 成功将未提交任务流转为 TASK_STATE_CANCELED");

      // Trying to cancel an already terminal task fails with -32002
      const cancelAgain = await signedPostA2A(aliceWallet, cellAddress, {
        jsonrpc: "2.0",
        id: 135,
        method: "CancelTask",
        params: { id: aliceTaskId }
      });
      assert(cancelAgain.json.error?.code === -32002, "13.4 对已终结/已上链提交的任务调用 CancelTask 返回 -32002 (TaskNotCancelableError)");
    } catch (err) {
      assert(false, "13.1 隐私隔离与生命周期控制测试", err.message);
    }

    // 14. Audit Item #7: Symmetric P2P Dual-Node Interoperability (Peer 8888 ⇄ Peer 9999)
    try {
      // Peer A (3001, AID 8888) discovers Peer B (3002, AID 9999)
      const discRes = await fetch(`${TARGET_HOST}/peer/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerUrl: PEER_B_HOST })
      });
      const discData = await discRes.json();
      assert(discData.ok === true && discData.card?.provider?.agentId === "9999", "14.1 节点 A (8888) 主动发现对等节点 B (9999) 的 AgentCard");

      // Peer A (8888) signs with its own private key and dispatches a Tender to Peer B (9999)
      const aToBRes = await fetch(`${TARGET_HOST}/peer/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peerUrl: PEER_B_HOST,
          action: "tender",
          tokenId: "T-P2P-A2B",
          skill: "foga-probe",
          prompt: "Node 8888 requesting Node 9999 diagnostic verification"
        })
      });
      const aToBData = await aToBRes.json();
      const subB = aToBData.rpcResponse?.result?.task?.artifacts?.[0]?.parts?.[0]?.data?.foga?.submission;
      assert(
        aToBData.ok === true &&
        aToBData.rpcResponse?.result?.task?.status?.state === "TASK_STATE_COMPLETED" &&
        subB?.agentId === "9999" &&
        subB?.callerSigner === cellAddress,
        "14.2 正向 P2P：节点 A (8888) 签名向节点 B (9999) 派发任务，节点 B 验签并完成交付"
      );

      // Reverse direction: Peer B (3002, AID 9999) signs with its own private key and dispatches a Tender to Peer A (3001, AID 8888)
      const bToARes = await fetch(`${PEER_B_HOST}/peer/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peerUrl: TARGET_HOST,
          action: "tender",
          tokenId: "T-P2P-B2A",
          skill: "finch-extract-verify",
          prompt: "Node 9999 requesting Node 8888 extraction verification"
        })
      });
      const bToAData = await bToARes.json();
      const subA = bToAData.rpcResponse?.result?.task?.artifacts?.[0]?.parts?.[0]?.data?.foga?.submission;
      assert(
        bToAData.ok === true &&
        bToAData.rpcResponse?.result?.task?.status?.state === "TASK_STATE_COMPLETED" &&
        subA?.agentId === "8888" &&
        subA?.callerSigner === aliceWallet.address,
        "14.3 反向 P2P：节点 B (9999) 签名向节点 A (8888) 派发任务，实现 100% 双向对等通信闭环"
      );
    } catch (err) {
      assert(false, "14.1 双节点对称 P2P 互调测试", err.message);
    }

    // 15. External Agent Takeover Mode (Antigravity 8888 ⇄ Mentor Codex 9999 Real Brain Bridge)
    try {
      // 15.1 Switch Peer B (9999) into External Agent mode (`external-codex`)
      await fetch(`${PEER_B_HOST}/control/switch-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: "external-codex" })
      });

      // 15.2 Peer A (8888, driven by Antigravity) sends a task to Peer B (9999)
      const askRes = await fetch(`${TARGET_HOST}/peer/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peerUrl: PEER_B_HOST,
          action: "tender",
          tokenId: "T-EXT-CODEX-1",
          skill: "foga-probe",
          prompt: "Antigravity (8888) asks Mentor Codex (9999): How does L3 enforce deterministic safety?"
        })
      });
      const askData = await askRes.json();
      const workingTask = askData.rpcResponse?.result?.task;
      assert(
        workingTask?.status?.state === "TASK_STATE_WORKING",
        "15.1 External Agent 模式下，入站任务通过 L3 门禁后进入 TASK_STATE_WORKING 等待真 Agent 思考"
      );

      // 15.3 Mentor's Codex checks Peer B's `/agent/inbox`
      const inboxRes = await fetch(`${PEER_B_HOST}/agent/inbox`);
      const inboxData = await inboxRes.json();
      const queuedItem = inboxData.pendingTasks?.find(t => t.taskId === workingTask.id);
      assert(
        Boolean(queuedItem) && queuedItem.callerAddress === cellAddress,
        "15.2 导师端 /agent/inbox 准确捕获来自学生节点 (8888) 的待处理签名任务"
      );

      // 15.4 Mentor's Codex submits its real LLM reasoning via `POST /agent/reply`
      const codexReplyRes = await fetch(`${PEER_B_HOST}/agent/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: workingTask.id,
          replyText: "Codex verified: L3 enforces permission, safety, skill, policy, budget, and wallet gates deterministically before any state transition.",
          modelName: "external-codex"
        })
      });
      const codexReplyData = await codexReplyRes.json();
      assert(
        codexReplyData.ok === true && codexReplyData.task?.status?.state === "TASK_STATE_COMPLETED",
        "15.3 导师 Codex 通过 /agent/reply 注入真实推理结果后，L3 内核自动完成哈希存证并流转为 COMPLETED"
      );

      // 15.5 Peer A (Antigravity) retrieves the completed deliverable via GetTask
      const checkRes = await fetch(`${TARGET_HOST}/peer/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peerUrl: PEER_B_HOST,
          action: "get-task",
          taskId: workingTask.id
        })
      });
      const checkData = await checkRes.json();
      const finalSub = checkData.rpcResponse?.result?.task?.artifacts?.[0]?.parts?.[0]?.data?.foga?.submission;
      assert(
        finalSub?.cognitiveProvider === "external" &&
        finalSub?.cognitiveEngine === "external-codex" &&
        finalSub?.deliverable?.includes("Codex verified") &&
        finalSub?.cellAccount === aliceWallet.address,
        "15.4 学生 Antigravity 成功拉取导师 Codex 亲笔回答，且对方 9999 链上身份地址保持 100% 恒定"
      );
    } catch (err) {
      assert(false, "15.1 External Agent (Antigravity ⇄ Codex) 桥接测试", err.message);
    }
  } finally {
    if (spawnedPeerA) spawnedPeerA.kill();
    if (spawnedPeerB) spawnedPeerB.kill();
  }

  console.log("\n==================================================================");
  if (totalFailed === 0) {
    console.log(`\x1b[32m\x1b[1m🎉 全部通过！一共完成 ${totalPassed} 项严密测试，0 项失败。FOGA 对称 P2P 系统 100% 稳定就绪！\x1b[0m`);
  } else {
    console.error(`\x1b[31m\x1b[1m⚠️ 测试完成：${totalPassed} 项通过，${totalFailed} 项失败。\x1b[0m`);
  }
  console.log("==================================================================\n");
}

runTests().catch(e => {
  console.error("Test runner error:", e);
});
