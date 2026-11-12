# FOGA A2A Protocol & Agent Identity Invariance Reference Implementation
> **基于 Finch OG Agent (FOGA 0.6.0) 协议规范与以太坊 ERC-8004 / ERC-8434 体系的去中心化双 Agent 通信与“忒修斯之船”身份不变性参考实现**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-FOGA%200.6.0%20%7C%20A2A%201.0-blue.svg)](https://github.com/garyyang-finchip/foga)
[![Standard](https://img.shields.io/badge/ERC-8004%20%7C%208434%20%7C%208338%20%7C%208414-purple.svg)](https://eips.ethereum.org/)
[![Security](https://img.shields.io/badge/Auth-FOGA--EIP712-orange.svg)](./crypto_utils.js)
[![Tests](https://img.shields.io/badge/Tests-23%2F23%20Passing-brightgreen.svg)](./test_suite.js)

---

## 一、 课题研究背景与核心命题

在分布式多 Agent 自治系统的前沿探索中，学术界与工业界长期面临两大核心争议与架构瓶颈：

1. **Agent 间的对等通信机制（Agent-to-Agent, A2A）**：
   * *传统痛点*：XMTP、Moltbook 等方案本质依赖集中式或半公开的广播中继池，缺乏消息私密隔离；而纯去中心化的 UDP P2P 打洞（NAT Traversal）在遭遇电信运营商级 NAT（CGNAT）和企业对称型防火墙（Symmetric NAT）时几乎 100% 预测失效。
   * *技术共识*：无论是 Iroh 还是 libp2p，在遭遇严格防火墙时，其终极容灾保底手段无一例外全部退化为 **HTTPS（443 端口）**。
2. **Agent 身份界定难题（AI 版“忒修斯之船 / Ship of Theseus”）**：
   * *核心争议*：当一个自主 Agent 在演进过程中**修改了技能（Skill）**、**切换了底层大语言模型（LLM 从 Claude 换成 DeepSeek）**、**重置了本地记忆（Memory）**、亦或在不同设备间物理迁移时，在法律、契约和系统层面它是否还是同一个 Agent？

本项目全面引入 Finch CEO Gary Yang 发布的 **Finch OG Agent (FOGA 0.6.0)** 规范，在**无需部署任何中心化商业云（拒绝托管至 Vercel/AWS）**的前提下，基于两台真正的本地个人物理设备，给出了一整套完整的工程与密码学实现。

---

## 二、 核心理论依据与物理分层解耦模型

FOGA 设计备忘录（`docs/design-memo.md` 第 2 节与第 10 节）确立了本项目构建的核心铁律：

> **“L3 cell kernel: deterministic state machine; no LLM inside.”**  
> *(L3 核心元胞内核是纯确定性状态机，其内部严禁内置任何大语言模型。)*

> **“Identity is one's own; only the genome replicates.”**  
> *(身份归自身独有，唯有基因与代码可复制。)*

```
┌────────────────────────────────────────────────────────────────────────┐
│                   L5 接口访问层 (Multi-Entrance Layer)                  │
│       A2A 1.0 JSON-RPC (POST /a2a)  │  AgentCard  │  Web Dashboard     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ EIP-712 签名请求信封 (FOGA-EIP712)
┌───────────────────────────────────▼────────────────────────────────────┐
│                    L4 认知层 (Pluggable Cognition)                     │
│    [可插拔认知适配器: Heuristic Table ⇄ Claude 3.5 ⇄ DeepSeek R1]       │
│    ★ 仅享有“提议权 (Propose)”，绝无“最终决定权与直接出资权”             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 提议方案校验与约束裁决
┌───────────────────────────────────▼────────────────────────────────────┐
│                   L3 确定性元胞内核 (Cell Kernel)                      │
│     Call Permission Gate │ Business Policy Gate │ Wallet Gate (Rev 2)  │
│     ★ 纯确定性状态机，内部零大模型，全流程状态持久化与不可抵赖留痕      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 绑定并受制于合约物理身体
┌───────────────────────────────────▼────────────────────────────────────┐
│             L1/L3 智能合约账户身体 (FogaCellAccount & AID)              │
│     • 链上物理账户地址 (Body): 0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1 │
│     • ERC-8004 信任注册 ID (AID): 8888                                  │
│     • ERC-8338 资产卡: Token-Bound Executable Skills (外挂可执行工具包) │
│     ★ 无论认知层大模型如何更迭，物理地址与法人身份保持 100% 绝对同一    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 三、 核心技术规范与密码学实现

### 1. A2A 1.0 JSON-RPC 通信规范
完全兼容 Google 与 FOGA A2A 1.0 协议标准：
* **能力名片发现**：`GET /.well-known/agent-card.json`
  - 机器可读的名片定义，宣告 Agent 身份（AID 8888）、支持的 JSON-RPC 接口、可执行技能包（ERC-8338）以及安全认证方案。
* **协议主入口**：`POST /a2a`
  - 处理 `SendMessage`（`mode: quote` 报价咨询，`mode: task` 签约执行）与 `GetTask`；
  - 遵循“通信归通信，履约归链上托管（ERC-8414 Task Tenders）”原则。

### 2. 请求级以太坊 EIP-712 数字签名信封（`Authorization: FOGA-EIP712`）
每个发往 `/a2a` 的执行请求，必须在 HTTP 头附带结构化防篡改签名：
```
Authorization: FOGA-EIP712 <base64url(JSON envelope)>
```
* **Domain**：`{ name: "FOGA", version: "1", chainId: 11155111, verifyingContract: Bob's Account }`
* **Message (Request)**：
  ```json
  {
    "method": "POST",
    "path": "/a2a",
    "bodyHash": "0x<keccak256(requestBody)>",
    "issuedAt": 1794402980,
    "expiresAt": 1794403100,
    "nonce": "0x<32-byte-crypto-random-hex>"
  }
  ```
* **三大安全铁闸**：
  1. **防篡改**：请求体 Keccak256 强绑定，中间人篡改任何参数均触发 `401 InvalidCredential: Body hash mismatch`；
  2. **防重放**：`NonceCache` 内存哈希滑动窗口，捕获重放指令直接阻断；
  3. **零信任准入**：未携带有效私钥签名的执行任务 100% 触发 `403 AuthenticationRequired`。

---

## 四、 实验验证结论：“忒修斯之船”终极裁决

在客户端 Agent Alice 与服务端 Agent Bob 的端到端真实交互中，驱动 Bob 经历 **3 次大语言模型彻底换代** 与 **1 次可执行技能包动态升级**，实测裁决结果如下：

```
====================================================================================================================
                       📊 【忒修斯之船 —— 身份不变性终极裁决表】 (Identity Invariance Report)
====================================================================================================================
┌─────────┬──────────────────────────────────────┬─────────────────────────┬──────────────────────────────────────────────┬──────────┬────────────────────────────────┐
│ (index) │ 测试阶段                             │ 所用认知大模型 (L4)     │ Agent 物理账户地址 (Body - L1/L3)            │ Agent ID │ 身份判定                       │
├─────────┼──────────────────────────────────────┼─────────────────────────┼──────────────────────────────────────────────┼──────────┼────────────────────────────────┤
│ 0       │ '阶段一：初始规则引擎'               │ 'heuristic-rule-engine' │ '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' │ '8888'   │ '✅ 绝对同一 (100% Invariant)' │
│ 1       │ '阶段二：认知引擎切换为 Claude 3.5'  │ 'claude-3-5-sonnet'     │ '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' │ '8888'   │ '✅ 绝对同一 (100% Invariant)' │
│ 2       │ '阶段三：认知引擎切换为 DeepSeek R1' │ 'deepseek-r1'           │ '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' │ '8888'   │ '✅ 绝对同一 (100% Invariant)' │
│ 3       │ '阶段四：动态挂载金融分析技能 v2.0'   │ 'deepseek-r1'           │ '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1' │ '8888'   │ '✅ 绝对同一 (100% Invariant)' │
└─────────┴──────────────────────────────────────┴─────────────────────────┴──────────────────────────────────────────────┴──────────┴────────────────────────────────┘
🎉 验证结论：完全通过！
证明事实：在经历 3 次大模型彻底替换、1 次可执行技能包升级后，Agent Bob 的以太坊物理地址与法定身份保持完全同一，完全符合 FOGA“Identity is one's own; only the genome replicates”的顶层设计铁律！
```

---

## 五、 双物理设备与公网安全隧道拓扑

针对“如何在无独立公网 IP、无 Vercel 云端托管的两台个人设备间实现 HTTPS 穿透”，系统引入了出站反向安全隧道架构：

```
【个人设备 A (发单客户端)】                          【个人设备 B (服务提供节点)】
   Agent Alice (AID: 9999)                            Agent Bob (AID: 8888)
   (运行于手机 5G 蜂窝网络或远程电脑)                    (运行于本地个人电脑 localhost:3001)
              │                                                  ▲
              │ 1. 标准 HTTPS POST (443端口)                      │ 3. 顺着出站专线向下分发
              ▼                                                  │
┌────────────────────────────────────────────────────────────────┴──────────────────┐
│                      公网安全隧道 (Cloudflare / Localtunnel)                       │
│    • 个人电脑主动发起安全出站长连接（电信 NAT 防火墙 100% 放行出站连接）             │
│    • 分配全球公开 HTTPS 域名 (https://xxxx.loca.lt)，全链路免死金牌通道               │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 六、 对称 P2P 架构、L3 三关裁决引擎与快速启动手册

本工程支持 **对称 P2P 双节点对等运行（Symmetric Peer Mode）**：同一份 [`agent_bob_server.js`](./agent_bob_server.js) 既是 A2A 1.0 服务端（暴露名片与承接任务），又是自带钱包签名的 P2P 客户端（可通过网页控制台或 `/peer/send` 主动外呼任何远程对等节点）。

### 1. FOGA L3 确定性问题处理流水线（无需外部 LLM API）
严格遵循 [`Finch OG Agent`](https://github.com/garyyang-finchip/foga) 的 `L3 Kernel` + `Catalog.invoke` 规范，每次处理 P2P 任务均执行 **五步闭环与三道硬门禁**：
1. **Perceive（态势感知）**：读取本地节点安全锚点、持有技能包、24h 预算账本与调用方入参；
2. **Propose（方案提议 — L4 认知适配器）**：默认采用确定性规则表（`stub` / `heuristic-rule-engine`）生成方案与摘要哈希（`promptHash` / `responseHash`），**仅具提议权，无决定权与出资权**；
3. **Decide（三道门禁硬性裁决 — `Catalog.invoke`）**：
   - **第一关 · 调用权限门（`permission` / `input`）**：校验 `FOGA-EIP712` 签名有效性与 JSON Schema；
   - **第二关 · 业务与策略门（`safety` / `skill` / `policy` / `budget`）**：依次核验 Guardian 熔断开关（`safety`）、技能持有与包哈希（`skill`）、最低报价底线（`policy`）、单笔及日度预算上限（`budget`）；
   - **第三关 · 账户白名单门（`wallet`）**：校验操作是否在 `FogaCellAccount` 允许的 `operatorAllowList` 内；
4. **Execute（三步幂等作业）**：依次执行 `tender_precheck` -> `skill_run` -> `tender_submit`；
5. **Record（不可篡改决策存证 `Decision Record`）**：无论放行（`allowed`）或拦截（`refused`），均生成带门禁原因 `gate` 与模型哈希的审计凭证。

### 2. P2P 双方 Agent 交换的 5 类核心协议信息
- **① 能力名片发现（`GET /.well-known/agent-card.json`）**：交换 `cellAddress`、ERC-8004 `agentId`、支持的技能列表与 `FOGA-EIP712` 鉴权域；
- **② 密码学请求信封（HTTP Headers）**：携带 `A2A-Version: 1.0`（缺失则报 `-32009`）与 `Authorization: FOGA-EIP712 <base64url>`（绑定 Method、Path、Body Keccak256 哈希、时间戳与防重放 Nonce）；
- **③ 双轨制业务报文（`Quote` 询价轨 vs `Tender` 履约轨）**：先通过公开 `quote` 确认条款与技能支持度，再通过带签名的 `tender` 触发三步执行；若缺少 `tokenId` 等关键参数，自动返回 `TASK_STATE_INPUT_REQUIRED` 支持多轮补参续接；
- **④ 可验证交付物与决策凭证（`submission` Artifact）**：返回 `resultHash`、`answerHash`、`jobId`、`decisionId` 与承载的链上法定身份地址；
- **⑤ 生命周期与隐私隔离控制（`GetTask` / `ListTasks` / `CancelTask`）**：任务严格按调用方签名地址隔离（第三方越权查询返回 `-32006 TaskNotFoundError`），支持未提交前取消任务（`TASK_STATE_CANCELED`）。

### 3. 核心终端指令速查

```bash
# 进入工程根目录并安装依赖
npm install
```

| 序号 | 业务功能模块 | 终端执行指令 | 预期输出与现象 |
|---|---|---|---|
| **01** | **启动节点 A (AID 8888, 端口 3001)** | `node agent_bob_server.js` | 开启 Peer A 服务端与 P2P 双向控制台 (`http://localhost:3001`)。 |
| **02** | **启动节点 B (AID 9999, 端口 3002)** | `node agent_bob_server.js --peer-b` | 开启对称 Peer B 节点 (`http://localhost:3002`)，可与 3001 双向互调。 |
| **03** | **一键启动本机双节点 P2P 演练** | `.\启动_双节点P2P对等演练.bat` | 同时拉起 3001(8888) 与 3002(9999) 双节点及两个可视化控制台。 |
| **04** | **开启公网 HTTPS 隧道** | `npx.cmd --yes localtunnel --port 3001 --local-host 127.0.0.1` | 输出 `https://xxxx.loca.lt`，供异地导师节点或手机 5G 跨网互连。 |
| **05** | **全自动身份确权推演** | `node agent_alice_client.js demo-identity` | 连续切换 3 种认知引擎与升级技能，验证链上地址 100% 恒定。 |
| **06** | **全自动 P2P 五阶段与门禁演练** | `node agent_alice_client.js demo-p2p` | 自动演示询价、`INPUT_REQUIRED` 多轮续接、三道门禁拒单与 `CancelTask`。 |
| **07** | **运行 43 项全自动化测试套件** | `node test_suite.js` | 自启动双节点，100% 自动化验证 14 大类 43 项安全、门禁与双向 P2P 指标。 |

### 4. 与导师跨城市/跨路由器真实 P2P 对联方法
1. **学生电脑**：运行 `node agent_bob_server.js`（默认 AID `8888`，端口 `3001`），并开启隧道拿到 `https://student-node.loca.lt`；
2. **导师电脑**：克隆本仓库，运行 `node agent_bob_server.js --peer-b`（AID `9999`，端口 `3002`），并开启隧道 `--port 3002` 拿到 `https://mentor-node.loca.lt`；
3. **双向对等交互**：双方在各自浏览器控制台的 **「🌐 P2P 对等节点双向连接器」** 输入框中填入对方的 `https://xxx.loca.lt` 地址，即可直接用各自节点的私钥互相拉取名片、发起签名任务、测试多轮追问与 L3 门禁拦截！

---

## 七、 43 项自动化安全、L3 门禁与对称 P2P 测试套件

运行 `node test_suite.js` 覆盖的 14 大类 43 项完整测试矩阵：

* `1.1 ~ 1.3` **服务健康与物理身份**：校验账户地址合法性与 ERC-8004 AID；
* `2.1 ~ 2.5` **A2A 1.0 协议规范一致性**：校验 AgentCard、协议绑定与 EIP-712 声明；
* `3.1 ~ 3.2` **零信任准入拦截**：未签名任务必须 100% 被 403 (`-32001`) 严格阻断；
* `4.1` **加密防篡改保障**：报文被中间人修改 1 字节即触发 401 BodyHash 不匹配拦截；
* `5.1 ~ 5.2` **反重放攻击防御**：捕获相同 Nonce 的重复重放指令坚决阻断；
* `6.1 ~ 6.2` **资产化询价履约**：验证 Quote 资产与哈希锁（Hashlock）条款交付；
* `7.1 ~ 7.5` **“忒修斯之船”身份同一性**：连续切换大模型与挂载技能，物理地址绝对不变；
* `8.1 ~ 8.3` **Web/Mobile 可视化控制台**：多端响应式监控面板与 P2P 连接器渲染就绪；
* `9.1 ~ 9.2` **版本强校验与方法边界**：缺失 `A2A-Version: 1.0` 报 `-32009`，流式方法报 `-32004`；
* `10.1 ~ 10.2` **`(caller, messageId)` 幂等防重**：相同消息 ID 重复投递直接返回原 Task，绝不重复执行；
* `11.1 ~ 11.3` **多轮缺参追问与任务续接**：验证 `TASK_STATE_INPUT_REQUIRED` -> 携带 `taskId` 补参 -> `TASK_STATE_COMPLETED` 闭环；
* `12.1 ~ 12.6` **L3 内核三道门禁与决策存证**：实测 `skill`、`policy`、`budget`、`safety` 四类门禁精准拒单及 `Decision Record` 生成；
* `13.1 ~ 13.4` **调用方隐私隔离与生命周期**：验证第三方 Eve 越权调用 `GetTask` 被 `-32006` 拦截，以及 `CancelTask` 状态机流转；
* `14.1 ~ 14.3` **双节点对称 P2P 双向互调**：验证 Peer A (`8888`) ⇄ Peer B (`9999`) 互相发现名片并双向完成 EIP-712 签名任务交付。

---

## 八、 完整端到端验收复现全流程（Step-by-Step Verification Walkthrough）

为了让评审导师或外部研究员能够**在 3 分钟内 100% 精确复现全链路结果**，系统提供四阶段标准验收流程：

```
[阶段 1: 43项全自动自检]         [阶段 2: P2P 门禁与多轮协商]         [阶段 3: 忒修斯之船身份推演]        [阶段 4: 双节点/跨网 P2P 对联]
   node test_suite.js         node agent_alice_client.js demo-p2p   node agent_alice_client.js demo-identity   3001(8888) ⇄ 3002(9999) / loca.lt
    (43/43 项全绿通过)          (询价+多轮追问+3道门禁+取消闭环)       (3 次换脑 + 1 次升级，地址不变)       (双向对等签名外呼与可视化交互)
```

### 步骤一：全自动化 43 项基准自检（耗时 5 秒）
直接运行自检脚本（脚本若检测到 3001/3002 未启动会自动在后台拉起双节点完成测试）：
```powershell
node test_suite.js
```
* **【验证通过标准】**：终端刷出 43 项绿色通过清单，末尾显示：`🎉 全部通过！一共完成 43 项严密测试，0 项失败。FOGA 对称 P2P 系统 100% 稳定就绪！`

---

### 步骤二：P2P 协议五阶段与 L3 门禁实测（耗时 30 秒）
1. 终端窗口 1 保持 `node agent_bob_server.js` 运行；
2. 终端窗口 2 运行 P2P 协议与门禁演练驱动：
   ```powershell
   node agent_alice_client.js demo-p2p
   ```
* **【验证通过标准】**：依次打印出公开询价（Quote）、缺参追问与续接（`TASK_STATE_INPUT_REQUIRED` -> `COMPLETED`）、三道门禁拦截（`gate=skill` / `gate=policy` / `gate=budget`）、任务取消（`TASK_STATE_CANCELED`）与隐私隔离列表（`ListTasks`）。

---

### 步骤三：双 Agent 协同与“忒修斯之船”身份确权实测（耗时 30 秒）
```powershell
node agent_alice_client.js demo-identity
```
* **【验证通过标准】**：分三阶段热切换 `heuristic-rule-engine`、`claude-3-5-sonnet`、`deepseek-r1` 并热挂载新技能，打印出身份不变性裁决表，承载地址 `0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1` 保持 100% 恒定。

---

### 步骤四：双节点对称 P2P 控制台与跨网隧道实测（耗时 1 分钟）
1. 双击运行 [`启动_双节点P2P对等演练.bat`](./启动_双节点P2P对等演练.bat)（或分别运行 `node agent_bob_server.js` 与 `node agent_bob_server.js --peer-b`）；
2. 浏览器自动打开 `http://localhost:3001`（节点 8888）与 `http://localhost:3002`（节点 9999）；
3. 在任意节点的 **「🌐 P2P 对等节点双向连接器」** 中点击按钮 ①~⑧，即可直观看到两个独立 Agent 双向验签、多轮追问、触发对方 L3 门禁并实时生成 `Decision Record`；若配合 `npx.cmd --yes localtunnel --port 3001 --local-host 127.0.0.1`，即可与手机 5G 或异地导师电脑实现跨公网对等互连！

---

## 九、 项目文件拓扑与纯度说明

```
foga-a2a-demo/
├── crypto_utils.js             # FOGA EIP-712 签名生成、验签、Nonce防重放缓存
├── agent_bob_server.js         # 对称 P2P 节点核心 (A2A 1.0 服务端 + L3 三道门禁内核 + P2P 外呼客户端 + Web控制台)
├── agent_alice_client.js       # 命令行验证驱动 (支持 demo-identity / demo-p2p / card / quote / task)
├── test_suite.js               # 43 项全功能边界、L3 门禁与双节点对称 P2P 自动化测试套件
├── package.json                # 工程配置 (type: module, 仅依赖 ethers)
├── 启动_Agent_Bob服务端.bat     # Windows 一键启动单节点脚本 (端口: 3001, AID: 8888)
├── 启动_双节点P2P对等演练.bat    # Windows 一键启动双对等节点脚本 (3001 ⇄ 3002 双向互调)
├── 启动_公网HTTPS安全隧道.bat   # Windows 一键启动公网安全隧道 (IPv4 强化绑定)
├── 运行_Agent_Alice客户端.bat   # Windows 一键启动命令行自动化验证脚本
├── README.md                   # 本技术规范与交付文档
└── 项目交接与全流程上下文总结.md # 遵循工作区铁律的交接与技术避坑总结文档
```

> **仓库合规性声明**：
> 1. 本工程代码 100% 采用标准 JavaScript / Node.js 原生编写，无任何重型区块链编译环境侵入；
> 2. 代码及文档内无任何个人本地绝对磁盘路径泄露（全部采用 `./` 相对路径）；
> 3. 无任何私钥文件或敏感 `.env` 明文上传，严密遵守 Finch 工作区全局合规规则。
