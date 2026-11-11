// -*- coding: utf-8 -*-
/**
 * FOGA Protocol Compliant EIP-712 Signing and Verification Utilities
 * Strictly follows Finch OG Agent (FOGA) 0.6.0 specification:
 * - Domain: { name: "FOGA", version: "1", chainId, verifyingContract }
 * - PrimaryType: "Request" (method, path, bodyHash, issuedAt, expiresAt, nonce)
 * - Header Scheme: Authorization: FOGA-EIP712 <base64url(JSON envelope)>
 */

import { ethers, keccak256, toUtf8Bytes, getAddress, randomBytes } from "ethers";

export const SIGNED_SCHEME = "FOGA-EIP712";
export const REQUEST_MAX_SECONDS = 120;
export const DEFAULT_CHAIN_ID = 11155111; // Sepolia testnet ID

export const SIGNED_TYPES = {
  Request: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
  Session: [
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ]
};

export function signedDomain(chainId, cellAddress) {
  return {
    name: "FOGA",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: getAddress(cellAddress)
  };
}

export function bodyHashOf(body) {
  if (body === null || body === undefined || body === "") {
    return keccak256(new Uint8Array());
  }
  return keccak256(typeof body === "string" ? toUtf8Bytes(body) : body);
}

/**
 * Sign an HTTP request using an Ethers wallet (Caller: Agent Alice)
 */
export async function signRequestAuthorization(wallet, { cellAddress, method, path, body, chainId = DEFAULT_CHAIN_ID, ttl = REQUEST_MAX_SECONDS, agentId }) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = "0x" + Buffer.from(randomBytes(32)).toString("hex");
  const bHash = bodyHashOf(body);
  const upperMethod = method.toUpperCase();

  const domain = signedDomain(chainId, cellAddress);
  const types = { Request: SIGNED_TYPES.Request };
  const value = {
    method: upperMethod,
    path: path,
    bodyHash: bHash,
    issuedAt: now,
    expiresAt: now + ttl,
    nonce: nonce
  };

  const signature = await wallet.signTypedData(domain, types, value);
  const envelope = {
    v: 1,
    signer: getAddress(wallet.address),
    ...(agentId ? { agentId: String(agentId) } : {}),
    issuedAt: now,
    expiresAt: now + ttl,
    nonce: nonce,
    request: {
      method: upperMethod,
      path: path,
      bodyHash: bHash
    },
    signature: signature
  };

  const base64url = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${SIGNED_SCHEME} ${base64url}`;
}

/**
 * Nonce Cache to prevent replay attacks (Receiver: Agent Bob)
 */
export class NonceCache {
  constructor() {
    this.seen = new Map();
  }

  take(signer, nonce, expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    // Cleanup expired
    for (const [k, exp] of this.seen.entries()) {
      if (exp < now) this.seen.delete(k);
    }
    const key = `${signer.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.seen.has(key)) {
      return false; // Replayed!
    }
    this.seen.set(key, expiresAt);
    return true;
  }
}

/**
 * Verify an Authorization header (Receiver: Agent Bob)
 */
export function verifyRequestAuthorization(authHeader, { cellAddress, method, path, body, chainId = DEFAULT_CHAIN_ID, nonceCache }) {
  if (!authHeader || !authHeader.startsWith(SIGNED_SCHEME + " ")) {
    return { ok: false, reason: "Missing or invalid Authorization scheme (expected FOGA-EIP712)" };
  }

  try {
    const rawB64 = authHeader.slice(SIGNED_SCHEME.length + 1).trim();
    const envelope = JSON.parse(Buffer.from(rawB64, "base64url").toString("utf8"));

    if (envelope.v !== 1 || !envelope.signer || !envelope.signature || !envelope.request) {
      return { ok: false, reason: "Malformed SignedEnvelope" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > envelope.expiresAt) {
      return { ok: false, reason: "Signature expired" };
    }

    // Verify request attributes
    const expectedUpperMethod = method.toUpperCase();
    if (envelope.request.method !== expectedUpperMethod) {
      return { ok: false, reason: `Method mismatch: expected ${expectedUpperMethod}, got ${envelope.request.method}` };
    }
    if (envelope.request.path !== path) {
      return { ok: false, reason: `Path mismatch: expected ${path}, got ${envelope.request.path}` };
    }

    const expectedBodyHash = bodyHashOf(body);
    if (envelope.request.bodyHash !== expectedBodyHash) {
      return { ok: false, reason: `Body hash mismatch: expected ${expectedBodyHash}, got ${envelope.request.bodyHash}` };
    }

    // Verify Nonce replay
    if (nonceCache && !nonceCache.take(envelope.signer, envelope.nonce, envelope.expiresAt)) {
      return { ok: false, reason: "Nonce replayed (duplicate request detected)" };
    }

    // EIP-712 Cryptographic verification
    const domain = signedDomain(chainId, cellAddress);
    const types = { Request: SIGNED_TYPES.Request };
    const value = {
      method: envelope.request.method,
      path: envelope.request.path,
      bodyHash: envelope.request.bodyHash,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      nonce: envelope.nonce
    };

    const recoveredSigner = ethers.verifyTypedData(domain, types, value, envelope.signature);
    if (recoveredSigner.toLowerCase() !== envelope.signer.toLowerCase()) {
      return { ok: false, reason: `Signature signer mismatch: recovered ${recoveredSigner}, declared ${envelope.signer}` };
    }

    return {
      ok: true,
      signer: getAddress(recoveredSigner),
      agentId: envelope.agentId,
      envelope: envelope
    };
  } catch (err) {
    return { ok: false, reason: "Signature verification exception: " + err.message };
  }
}

