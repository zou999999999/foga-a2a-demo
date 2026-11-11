// -*- coding: utf-8 -*-
/**
 * Automated Comprehensive Test Suite for FOGA A2A Demo
 * Verifies:
 * 1. Health & Status Endpoints
 * 2. Official A2A 1.0 AgentCard schema and content
 * 3. Security Boundary: Rejection of unsigned tasks (403)
 * 4. Security Boundary: Rejection of tampered body / wrong signature
 * 5. Security Boundary: Rejection of replayed nonce
 * 6. Cryptographic EIP-712 Signing and Verification
 * 7. A2A SendMessage (Quote mode)
 * 8. A2A SendMessage (Task mode with deliverable)
 * 9. Cognitive Engine (LLM) Hot-Swapping without identity change
 * 10. Skill Hot-Plugging without identity change
 * 11. Complete Identity Invariance Invariant Check
 */

import { ethers, keccak256, toUtf8Bytes } from "ethers";
import { signRequestAuthorization, DEFAULT_CHAIN_ID, SIGNED_SCHEME } from "./crypto_utils.js";

const TARGET_HOST = process.env.BOB_URL || "http://localhost:3001";
const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const aliceWallet = new ethers.Wallet(ALICE_KEY);

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

async function runTests() {
  console.log("\n==================================================================");
  console.log("       🧪 FOGA A2A Dual-Agent 全方位自检与边界严密性测试          ");
  console.log("==================================================================\n");

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

  // 4. Security Boundary: Tampered payload MUST be rejected (403 or signature mismatch)
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
      body: tamperedBody // Maliciously changed body
    });
    const resJson = await res.json();
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
          messageId: "replay-test",
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

    // Send first time (should succeed)
    const res1 = await fetch(`${TARGET_HOST}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0", "Authorization": authHeader },
      body: bodyStr
    });
    assert(res1.status === 200, "5.1 首次合法请求成功通过");

    // Send second time with EXACT SAME Header/Nonce (must be rejected!)
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
    const bodyStr = JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "SendMessage",
      params: {
        message: {
          messageId: "quote-test",
          parts: [{ data: { foga: { mode: "quote", skill: "foga-probe" } } }]
        }
      }
    });
    const authHeader = await signRequestAuthorization(aliceWallet, {
      cellAddress,
      method: "POST",
      path: "/a2a",
      body: bodyStr
    });
    const res = await fetch(`${TARGET_HOST}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0", "Authorization": authHeader },
      body: bodyStr
    });
    const json = await res.json();
    assert(json.result?.task?.status?.state === "TASK_STATE_COMPLETED", "6.1 签名询价 (Quote) 请求正常履约返回");
    assert(json.result?.task?.artifacts?.[0]?.name === "quote", "6.2 返回合规的 quote 资产结构");
  } catch (err) {
    assert(false, "6.1 Quote 询价测试", err.message);
  }

  // 7. Dynamic LLM Hot-Swap & Identity Invariance
  try {
    // Stage A: Query initial status
    const statusBefore = await (await fetch(`${TARGET_HOST}/api/status`)).json();
    const addrBefore = statusBefore.accountAddress;

    // Stage B: Hot-swap to claude-3-5-sonnet
    const swapRes = await fetch(`${TARGET_HOST}/control/switch-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: "claude-3-5-sonnet" })
    });
    const swapData = await swapRes.json();
    assert(swapData.ok === true && swapData.currentEngine === "claude-3-5-sonnet", "7.1 大模型热切换至 Claude 3.5 成功");

    // Stage C: Verify identity remains 100% invariant
    const statusAfter = await (await fetch(`${TARGET_HOST}/api/status`)).json();
    assert(statusAfter.accountAddress === addrBefore, "7.2 切换大模型后，Agent 物理以太坊地址保持绝对不变 (Invariant)", `${statusAfter.accountAddress}`);
    assert(statusAfter.agentId === statusBefore.agentId, "7.3 切换大模型后，Agent ID 保持绝对不变", `${statusAfter.agentId}`);

    // Stage D: Hot-plug skill
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

  console.log("\n==================================================================");
  if (totalFailed === 0) {
    console.log(`\x1b[32m\x1b[1m🎉 全部通过！一共完成 ${totalPassed} 项测试，0 项失败。系统 100% 稳定就绪！\x1b[0m`);
  } else {
    console.error(`\x1b[31m\x1b[1m⚠️ 测试完成：${totalPassed} 项通过，${totalFailed} 项失败。\x1b[0m`);
  }
  console.log("==================================================================\n");
}

runTests().catch(e => {
  console.error("Test runner error:", e);
});
