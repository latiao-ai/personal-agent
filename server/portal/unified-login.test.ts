import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprovalHost } from "../approvals/host.ts";
import { createIsolationHost } from "../isolation/host.ts";
import { createMemorySkillHost } from "../memory-skill/host.ts";
import { createPatrolHost } from "../patrol/host.ts";
import { createTicketHost } from "../tickets/host.ts";
import { createPortalHost, type PortalHost } from "./host.ts";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}

async function sendReq(
  baseUrl: string,
  method: string,
  path: string,
  options?: { body?: unknown; cookie?: string; accept?: string; auth?: string },
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(options?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options?.cookie ? { cookie: options.cookie } : {}),
      ...(options?.accept ? { accept: options.accept } : {}),
      ...(options?.auth ? { authorization: options.auth } : {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON response (redirect / html).
  }
  const headers: http.IncomingHttpHeaders = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }
  return { status: res.status, headers, body: text, json: parsed };
}

function extractCookies(headers: http.IncomingHttpHeaders): string {
  const raw = headers["set-cookie"];
  if (!raw) return "";
  const list: string[] = Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*[a-zA-Z0-9_-]+=)/);
  return list
    .map((item) => item.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair && !pair.endsWith("="))
    .join("; ");
}

describe("add-unified-login: unified auth, route guard, admin provisioning & tenant isolation", () => {
  let tmpDir: string;
  let portal: PortalHost;
  let server: http.Server;
  let baseUrl: string;
  let cleanupFns: Array<() => void>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-unified-login-"));
    const tickets = createTicketHost(tmpDir);
    const approvals = createApprovalHost(tmpDir);
    const patrol = createPatrolHost(tmpDir, { tickets: tickets.engine, approvals: approvals.engine });
    const memorySkill = createMemorySkillHost(tmpDir);
    const isolation = createIsolationHost(tmpDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
    portal = createPortalHost(tmpDir, {
      tickets: tickets.engine,
      approvals: approvals.engine,
      patrol: patrol.engine,
      memorySkill: memorySkill.engine,
      isolation: isolation.engine,
      autoStartGateway: false,
    });
    portal.engine.createAdminAccount("bootstrap", {
      username: "ops_root",
      password: "RootPassword#123",
      displayName: "超管",
    });

    cleanupFns = [
      () => portal.close(),
      () => isolation.close(),
      () => memorySkill.close(),
      () => patrol.close(),
      () => approvals.close(),
      () => tickets.close(),
    ];

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const method = req.method ?? "GET";
      if (method === "GET" && portal.pageGuard(req, res, path)) return;
      const json = (r: http.ServerResponse, status: number, payload: unknown) => {
        r.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        r.end(JSON.stringify(payload));
      };
      const readBody = async (r: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const c of r) chunks.push(Buffer.from(c));
        if (chunks.length === 0) return {};
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      };
      if (
        await portal.dispatch({
          req,
          res,
          url,
          path,
          method,
          auth: { kind: "loopback", scopes: [], trust: "service" },
          json,
          readBody,
        })
      ) {
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>SPA:${path}</body></html>`);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const fn of cleanupFns) fn();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enforces server-side route guards for unauthenticated, customer, and admin roles", async () => {
    // 1. Unauthenticated direct access to /portal and /admin -> 302 to /login
    const unauthPortal = await sendReq(baseUrl, "GET", "/portal");
    expect(unauthPortal.status).toBe(302);
    expect(unauthPortal.headers.location).toBe("/login?next=%2Fportal");

    const unauthAdmin = await sendReq(baseUrl, "GET", "/admin");
    expect(unauthAdmin.status).toBe(302);
    expect(unauthAdmin.headers.location).toBe("/login?next=%2Fadmin");

    // Direct API without session -> 401
    expect((await sendReq(baseUrl, "GET", "/api/portal/bots")).status).toBe(401);
    expect((await sendReq(baseUrl, "GET", "/api/admin/tenants")).status).toBe(401);

    // 2. Self-registration is always rejected (403)
    const regRes = await sendReq(baseUrl, "POST", "/api/auth/register", {
      body: { username: "hacker", password: "Password123" },
    });
    expect(regRes.status).toBe(403);
    expect(regRes.json.error).toBe("self_registration_disabled");

    // 3. Admin logs in via unified /api/auth/login -> redirectTo /admin
    const adminLogin = await sendReq(baseUrl, "POST", "/api/auth/login", {
      body: { username: "ops_root", password: "RootPassword#123" },
    });
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.json.kind).toBe("admin");
    expect(adminLogin.json.redirectTo).toBe("/admin");
    const adminCookie = extractCookies(adminLogin.headers);

    // Admin accessing /admin -> 200 SPA; Admin accessing /portal -> 302 /admin
    expect((await sendReq(baseUrl, "GET", "/admin", { cookie: adminCookie })).status).toBe(200);
    const adminOnPortal = await sendReq(baseUrl, "GET", "/portal", { cookie: adminCookie });
    expect(adminOnPortal.status).toBe(302);
    expect(adminOnPortal.headers.location).toBe("/admin");

    // 4. Admin creates test account `tanghaonan` -> auto-switches to customer session & returns /portal
    const sampleSecret = "TestSample#9988";
    const createRes = await sendReq(baseUrl, "POST", "/api/admin/users", {
      cookie: adminCookie,
      body: {
        username: "tanghaonan",
        password: sampleSecret,
        displayName: "唐浩南",
        role: "customer",
        legacyLocalAccount: true,
        autoSwitchSession: true,
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.json.autoRedirectTo).toBe("/portal");
    expect(createRes.json.switchedToCustomerSession).toBe(true);
    expect(createRes.body).not.toContain(sampleSecret);
    const customerCookie = extractCookies(createRes.headers);

    // New test account can immediately open /portal without re-logging in
    expect((await sendReq(baseUrl, "GET", "/portal", { cookie: customerCookie })).status).toBe(200);
    const meRes = await sendReq(baseUrl, "GET", "/api/portal/auth/me", { cookie: customerCookie });
    expect(meRes.status).toBe(200);

    // Customer trying to access /admin -> 302 /portal (HTML) or 403 (JSON)
    const custOnAdminHtml = await sendReq(baseUrl, "GET", "/admin", { cookie: customerCookie });
    expect(custOnAdminHtml.status).toBe(302);
    expect(custOnAdminHtml.headers.location).toBe("/portal");

    const custOnAdminJson = await sendReq(baseUrl, "GET", "/admin", {
      cookie: customerCookie,
      accept: "application/json",
    });
    expect(custOnAdminJson.status).toBe(403);
    expect((await sendReq(baseUrl, "GET", "/api/admin/tenants", { cookie: customerCookie })).status).toBe(403);

    // Password is stored hashed, never plaintext in DB or audit logs
    const stored = portal.engine.store.getPortalUserByUsername("tanghaonan");
    expect(stored).not.toBeNull();
    expect(stored!.passwordHash).not.toContain(sampleSecret);
    expect(stored!.legacyLocalAccount).toBe(true);
    const auditDump = JSON.stringify(portal.engine.listAllAudit());
    expect(auditDump).not.toContain(sampleSecret);
  });

  it("supports password reset, immediate session revocation on disable, and strict tenant isolation", async () => {
    const adminLogin = await sendReq(baseUrl, "POST", "/api/auth/login", {
      body: { username: "ops_root", password: "RootPassword#123" },
    });
    const adminCookie = extractCookies(adminLogin.headers);

    // Create two separate tenant customer accounts
    const resA = await sendReq(baseUrl, "POST", "/api/admin/users", {
      cookie: adminCookie,
      body: {
        username: "cust_a",
        password: "PasswordA#1",
        role: "customer",
        tenantId: "tenant_a",
        autoSwitchSession: false,
      },
    });
    const resB = await sendReq(baseUrl, "POST", "/api/admin/users", {
      cookie: adminCookie,
      body: {
        username: "cust_b",
        password: "PasswordB#1",
        role: "customer",
        tenantId: "tenant_b",
        autoSwitchSession: false,
      },
    });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const userAId = (resA.json.user as { id: string }).id;

    // Login as A and B via unified /api/auth/login
    const loginA = await sendReq(baseUrl, "POST", "/api/auth/login", {
      body: { username: "cust_a", password: "PasswordA#1" },
    });
    const loginB = await sendReq(baseUrl, "POST", "/api/auth/login", {
      body: { username: "cust_b", password: "PasswordB#1" },
    });
    const cookieA = extractCookies(loginA.headers);
    const cookieB = extractCookies(loginB.headers);

    // Tenant A cannot read Tenant B's bots (403)
    const crossTenant = await sendReq(baseUrl, "GET", "/api/portal/bots?tenantId=tenant_b", { cookie: cookieA });
    expect(crossTenant.status).toBe(403);
    expect((await sendReq(baseUrl, "GET", "/api/portal/bots", { cookie: cookieB })).status).toBe(200);

    // Admin disables user A -> existing session immediately invalid & re-login fails
    const disableRes = await sendReq(baseUrl, "POST", `/api/admin/users/${encodeURIComponent(userAId)}/disable`, {
      cookie: adminCookie,
      body: {},
    });
    expect(disableRes.status).toBe(200);
    expect((await sendReq(baseUrl, "GET", "/api/portal/bots", { cookie: cookieA })).status).toBe(401);
    const reloginA = await sendReq(baseUrl, "POST", "/api/auth/login", {
      body: { username: "cust_a", password: "PasswordA#1" },
    });
    expect(reloginA.status).toBe(401);
    expect(reloginA.json.error).toBe("account_disabled");
  });
});
