import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { isTrustedWanxRequest } from "../src/trust";

const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);

describe("isTrustedWanxRequest", () => {
  it("放行本机同源访问", () => {
    expect(isTrustedWanxRequest(req({ host: "127.0.0.1:8788" }))).toBe(true);
    expect(isTrustedWanxRequest(req({ host: "localhost:8788", origin: "http://localhost:8788" }))).toBe(true);
    expect(isTrustedWanxRequest(req({ host: "127.0.0.1:8788", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("挡住 DNS rebinding：Host 不是回环", () => {
    expect(isTrustedWanxRequest(req({ host: "evil.com" }))).toBe(false);
    expect(isTrustedWanxRequest(req({ host: "attacker.com:8788", origin: "http://attacker.com" }))).toBe(false);
    // 攻击者把 evil.com rebind 到 127.0.0.1，但 Host 头仍是 evil.com
    expect(isTrustedWanxRequest(req({ host: "evil.com:8788" }))).toBe(false);
  });

  it("挡住跨站 CSRF：sec-fetch-site=cross-site", () => {
    expect(isTrustedWanxRequest(req({ host: "127.0.0.1:8788", "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("挡住跨站 fetch：origin 与 host 不符", () => {
    expect(isTrustedWanxRequest(req({ host: "127.0.0.1:8788", origin: "http://evil.com" }))).toBe(false);
  });

  it("缺 Host 头拒绝", () => {
    expect(isTrustedWanxRequest(req({}))).toBe(false);
  });

  it("畸形 origin 拒绝", () => {
    expect(isTrustedWanxRequest(req({ host: "127.0.0.1:8788", origin: "%%%" }))).toBe(false);
  });
});
