import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "http";
import net from "net";
import { WebSocket } from "ws";
import express from "express";
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { setupWsProxy } from "../src/services/wsProxy.js";

let httpServer: Server | null = null;
let serverPort: number;

async function startServer() {
  const app = express();
  httpServer = createServer(app);
  setupWsProxy(httpServer);

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, () => {
      serverPort = (httpServer!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

async function stopServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("Wisp Proxy", () => {
  // Regression: PR #89's SAP setup failed because these hosts were blocked.
  it.each(['s.mzstatic.com', 'fpinit.itunes.apple.com', 'uclient-api.itunes.apple.com'])(
    'allows signing and catalog connections to %s',
    (host) => {
      expect(wisp.options.hostname_whitelist.some((entry) =>
        entry instanceof RegExp ? entry.test(host) : entry === host,
      )).toBe(true);
    },
  );

  it.each(['other.mzstatic.com', 's.mzstatic.com.example.com', 'fpinit.itunes.apple.com.example.com', 'uclient-api.itunes.apple.com.example.com'])(
    'rejects unlisted signing or catalog hostname %s',
    (host) => {
      expect(wisp.options.hostname_whitelist.some((entry) =>
        entry instanceof RegExp ? entry.test(host) : entry === host,
      )).toBe(false);
    },
  );

  afterEach(async () => {
    await stopServer();
  });

  it("should accept WebSocket connections on /wisp/ path", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/wisp/`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it("should reject connections on non-wisp paths", async () => {
    await startServer();

    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/proxy?host=buy.itunes.apple.com&port=443`,
    );

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });

  it("should reject connections on random paths", async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/other`);

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("close", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });
});
