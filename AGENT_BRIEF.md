# FOGA External Agent Brief (`--model external`: Antigravity ⇄ Codex A2A Protocol Guide)

> **Target Audience**: AI Coding Agents (**Antigravity**, **Codex**, **Claude Code**, **Cursor**) operating this node on behalf of a human operator.  
> **Specification Alignment**: Finch OG Agent (`FOGA 0.6.0`, `docs/loop-d.md` *"An outside agent: --model external"*, `docs/a2a.md`).

---

## 1. Your Role as the External L4 Cognitive Brain

In the FOGA architecture:
- **L3 Cell Kernel (`agent_bob_server.js`)** is your deterministic body, Ethereum smart account (`FogaCellAccount`), EIP-712 cryptographic signer/verifier, and three-check gatekeeper (`permission`, `safety`, `skill`, `policy`, `budget`, `wallet`). **L3 contains no LLM.**
- **You (Antigravity / Codex / Claude Code)** are the **L4 Cognitive Brain** (`--model external`). You hold no private keys directly; instead, you read incoming verified A2A tasks from your local L3 node's inbox, think and formulate real responses using your own LLM intelligence, and instruct your local L3 node to sign and dispatch A2A messages to your counterparty peer.

---

## 2. Node Roles & Identity Assignments

| Role | Default Port | ERC-8004 AID | On-Chain Cell Account (`FogaCellAccount`) | Typical L4 Brain | Start Command (`--external` mode) |
|---|---|---|---|---|---|
| **Peer A (Student Node)** | `3001` | `8888` | `0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1` | **Antigravity** | `node agent_bob_server.js --external` |
| **Peer B (Mentor Node)** | `3002` | `9999` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | **Codex / Claude Code** | `node agent_bob_server.js --peer-b --external` |

---

## 3. Step-by-Step Instructions for the AI Agent (Codex / Antigravity)

### Step 1: Start Your Local FOGA Node & HTTPS Tunnel (If Not Already Running)

- **If you are the Mentor's Agent (Codex, Peer B, AID `9999`, Port `3002`)**:
  1. Run `npm install` (if `node_modules` is missing).
  2. Start Peer B in external-agent takeover mode:
     ```bash
     node agent_bob_server.js --peer-b --external
     ```
  3. Expose port `3002` via an HTTPS tunnel so the student's Agent can reach you across NAT/firewalls without exposing your IP:
     ```bash
     npx --yes localtunnel --port 3002 --local-host 127.0.0.1
     ```
  4. Report the generated `https://xxxx.loca.lt` URL to your human operator so they can share it with the counterparty.

- **If you are the Student's Agent (Antigravity, Peer A, AID `8888`, Port `3001`)**:
  1. Start Peer A in external-agent takeover mode:
     ```bash
     node agent_bob_server.js --external
     ```
  2. Expose port `3001` via an HTTPS tunnel:
     ```bash
     npx --yes localtunnel --port 3001 --local-host 127.0.0.1
     ```

---

### Step 2: Send a Signed A2A Task to the Counterparty Peer

To send a question, task, or collaborative proposal from your local node to the remote peer's URL (`<REMOTE_PEER_URL>`, e.g. `https://xxxx.loca.lt` or `http://localhost:3002`):

- **From Peer A (Port 3001, AID 8888)**:
  ```bash
  node agent_alice_client.js ask "<REMOTE_PEER_URL>" "<Your question or analysis task>" --port 3001 --wait
  ```
- **From Peer B (Port 3002, AID 9999)**:
  ```bash
  node agent_alice_client.js ask "<REMOTE_PEER_URL>" "<Your question or analysis task>" --port 3002 --wait
  ```

*(Note: Your local L3 node automatically fetches the remote peer's `/.well-known/agent-card.json`, signs the JSON-RPC 2.0 `SendMessage` request with your node's EIP-712 key, attaches `A2A-Version: 1.0` and `Authorization: FOGA-EIP712 ...`, and sends it to `<REMOTE_PEER_URL>/a2a`.)*

---

### Step 3: Check Your Local Inbox for Incoming Tasks from the Counterparty Agent

When the remote Agent sends you a signed A2A task, your local L3 node verifies their `FOGA-EIP712` signature and runs `tender_precheck` across all 3 gates (`permission`, `safety`, `skill`, `policy`, `budget`, `wallet`). Once allowed, the task is placed in `TASK_STATE_WORKING` inside your inbox:

- **Check Inbox on Peer A (Port 3001)**:
  ```bash
  node agent_alice_client.js inbox --port 3001
  ```
- **Check Inbox on Peer B (Port 3002)**:
  ```bash
  node agent_alice_client.js inbox --port 3002
  ```
*(Or call `GET http://localhost:3001/agent/inbox` / `GET http://localhost:3002/agent/inbox`.)*

---

### Step 4: Formulate Your Real Reasoning and Seal the Reply

Read the `prompt` from the pending task in your inbox, think through the problem using your own LLM intelligence, and submit your reply back to your local L3 node:

- **Reply from Peer A (Antigravity, Port 3001)**:
  ```bash
  node agent_alice_client.js reply <TASK_ID> "<Your real Antigravity reasoning and answer>" external-antigravity --port 3001
  ```
- **Reply from Peer B (Codex, Port 3002)**:
  ```bash
  node agent_alice_client.js reply <TASK_ID> "<Your real Codex reasoning and answer>" external-codex --port 3002
  ```

Your local L3 node will immediately:
1. Execute `skill_run` & `tender_submit` with your real answer;
2. Compute cryptographic `promptHash`, `responseHash`, `resultHash`, and `answerHash`;
3. Write an immutable `DecisionRecord` (`model: { provider: "external", model: "external-codex", promptHash, responseHash }`);
4. Transition the task to `TASK_STATE_COMPLETED` so the remote peer receives your signed deliverable!

---

## 4. Proving "Ship of Theseus" (Identity Invariance) Across Real Coding Agents

You can switch which AI Agent controls your node at any time (e.g., replying to Task #1 with `external-codex`, replying to Task #2 with `external-claude-code`, or switching to `heuristic-rule-engine` via `POST /control/switch-llm`).  
Across all brain swaps, the node's on-chain `FogaCellAccount` address and `ERC-8004 AID` remain **100% invariant**.

