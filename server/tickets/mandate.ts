import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SignedMandateCopy, TicketMandate } from "../../shared/tickets.ts";

/** Produces a deterministic JSON representation so mandate hashes are stable across key orderings. */
export function canonicalizeMandate(mandate: TicketMandate): string {
  const normalized = {
    approver: mandate.approver ?? null,
    budgetLimit: {
      businessLimit: mandate.budgetLimit.businessLimit,
      ...(mandate.budgetLimit.currency !== undefined ? { currency: mandate.budgetLimit.currency } : {}),
      tokenLimit: mandate.budgetLimit.tokenLimit,
    },
    goal: mandate.goal,
    initiator: mandate.initiator,
    scope: mandate.scope,
    toolAllowlist: [...mandate.toolAllowlist],
    validUntil: mandate.validUntil,
  };
  return JSON.stringify(normalized);
}

export function hashMandate(mandate: TicketMandate): string {
  return createHash("sha256").update(canonicalizeMandate(mandate), "utf8").digest("hex");
}

export function signMandateCopy(
  ticketId: string,
  mandate: TicketMandate,
  mandateHash: string,
  signingSecret: string,
  issuedAt: number,
): SignedMandateCopy {
  const payload = `${ticketId}:${mandateHash}:${issuedAt}`;
  const signature = createHmac("sha256", signingSecret).update(payload, "utf8").digest("hex");
  const frozenMandate: Readonly<TicketMandate> = Object.freeze({
    ...mandate,
    toolAllowlist: Object.freeze([...mandate.toolAllowlist]) as unknown as string[],
    budgetLimit: Object.freeze({ ...mandate.budgetLimit }),
  });
  return Object.freeze({
    ticketId,
    mandate: frozenMandate,
    mandateHash,
    signature,
    readonly: true as const,
    issuedAt,
  });
}

export function verifySignedMandateCopy(copy: SignedMandateCopy, signingSecret: string): boolean {
  const expectedHash = hashMandate(copy.mandate);
  if (expectedHash !== copy.mandateHash) return false;
  const payload = `${copy.ticketId}:${copy.mandateHash}:${copy.issuedAt}`;
  const expectedSig = createHmac("sha256", signingSecret).update(payload, "utf8").digest("hex");
  const actualBuf = Buffer.from(copy.signature, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}
