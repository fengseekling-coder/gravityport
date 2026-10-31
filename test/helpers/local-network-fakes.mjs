// Test helpers for local fake services (task 324).
// All listeners bind strictly to 127.0.0.1. No external dependencies.
import http from "node:http";
import net from "node:net";

export async function startFakeFeedbackCollector(options = {}) {
  const requests = [];
  let redirectUrl = options.redirectUrl || null;
  let setCookie = Boolean(options.setCookie);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}

      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw,
        body,
      });

      if (redirectUrl) {
        res.writeHead(302, {
          Location: redirectUrl,
          Connection: "close",
        });
        res.end();
        return;
      }

      const headers = { "Content-Type": "application/json" };
      if (setCookie) {
        headers["Set-Cookie"] = "mosa_fb_cookie=secret123; Path=/; HttpOnly";
      }
      res.writeHead(201, headers);
      res.end(JSON.stringify({ ok: true, id: "fb_fake_id_123" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/api/feedback`,
    requests,
    setRedirectUrl(url) {
      redirectUrl = url;
    },
    setCookieEnabled(enabled) {
      setCookie = enabled;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startFakePinterestServer(options = {}) {
  const requests = [];
  let setCookie = Boolean(options.setCookie);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
          body = Object.fromEntries(new URLSearchParams(raw));
        } else if (raw) {
          body = JSON.parse(raw);
        }
      } catch {}

      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        raw,
        body,
      });

      const parsedUrl = new URL(req.url, "http://127.0.0.1");
      const headers = { "Content-Type": "application/json" };
      if (setCookie) {
        headers["Set-Cookie"] = "pin_cookie=secret_pin_456; Path=/; HttpOnly";
      }

      if (parsedUrl.pathname === "/v5/oauth/token" && req.method === "POST") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          access_token: "fake_access_token_123",
          refresh_token: "fake_refresh_token_456",
          token_type: "bearer",
          expires_in: 2592000,
          refresh_token_expires_in: 5184000,
          scope: "boards:read,user_accounts:read,pins:read",
        }));
        return;
      }

      if (parsedUrl.pathname === "/v5/user_account" && req.method === "GET") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          username: "fake_pinterest_user",
          profile_image: "",
        }));
        return;
      }

      if (parsedUrl.pathname === "/v5/boards" && req.method === "GET") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          items: [
            { id: "fake_board_1", name: "Inspirations", pin_count: 5 },
          ],
          bookmark: null,
        }));
        return;
      }

      if (parsedUrl.pathname.startsWith("/v5/boards/") && parsedUrl.pathname.endsWith("/pins") && req.method === "GET") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          items: [],
          bookmark: null,
        }));
        return;
      }

      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: "Not found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    tokenUrl: `http://127.0.0.1:${port}/v5/oauth/token`,
    apiBase: `http://127.0.0.1:${port}/v5`,
    requests,
    setCookieEnabled(enabled) {
      setCookie = enabled;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startRedirectTarget() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("redirect target reached");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/target`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startHttpProxy() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    });

    let targetUrl;
    try {
      targetUrl = new URL(req.url);
    } catch {
      targetUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    }

    const connectHost = (targetUrl.hostname === "feedback.test" || targetUrl.hostname.endsWith(".test") || targetUrl.hostname === "localhost")
      ? "127.0.0.1"
      : targetUrl.hostname;

    const proxyReq = http.request({
      protocol: targetUrl.protocol,
      hostname: connectHost,
      port: targetUrl.port,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy error: ${err.message}`);
    });

    req.pipe(proxyReq);
  });

  server.on("connect", (req, clientSocket, head) => {
    requests.push({
      method: "CONNECT",
      url: req.url,
      headers: { ...req.headers },
    });

    const [rawHost, portStr] = req.url.split(":");
    const port = Number(portStr);
    const host = (rawHost === "feedback.test" || rawHost.endsWith(".test") || rawHost === "localhost")
      ? "127.0.0.1"
      : rawHost;
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => serverSocket.destroy());
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startAuthProxy() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    });
    res.writeHead(407, {
      "Proxy-Authenticate": 'Basic realm="Fake Proxy Auth"',
      "Connection": "close",
    });
    res.end("Proxy Authentication Required");
  });

  server.on("connect", (req, clientSocket) => {
    requests.push({
      method: "CONNECT",
      url: req.url,
      headers: { ...req.headers },
    });
    clientSocket.write(
      "HTTP/1.1 407 Proxy Authentication Required\r\n" +
      "Proxy-Authenticate: Basic realm=\"Fake Proxy Auth\"\r\n" +
      "Connection: close\r\n\r\n"
    );
    clientSocket.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startSocks5Proxy() {
  const requests = [];
  const server = net.createServer((socket) => {
    let state = "HANDSHAKE";

    socket.on("data", (data) => {
      try {
        if (state === "HANDSHAKE") {
          if (data[0] !== 0x05) {
            socket.destroy();
            return;
          }
          socket.write(Buffer.from([0x05, 0x00]));
          state = "REQUEST";
          return;
        }

        if (state === "REQUEST") {
          if (data[0] !== 0x05 || data[1] !== 0x01) {
            socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }

          let host;
          let offset = 4;

          if (data[3] === 0x01) {
            host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
            offset = 8;
          } else if (data[3] === 0x03) {
            const len = data[4];
            host = data.subarray(5, 5 + len).toString("utf8");
            offset = 5 + len;
          } else if (data[3] === 0x04) {
            const parts = [];
            for (let i = 0; i < 16; i += 2) {
              parts.push(data.readUInt16BE(4 + i).toString(16));
            }
            host = parts.join(":");
            offset = 20;
          } else {
            socket.destroy();
            return;
          }

          const port = data.readUInt16BE(offset);
          requests.push({
            cmd: "CONNECT",
            host,
            port,
          });

          const target = net.connect(port, host, () => {
            const resp = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff]);
            socket.write(resp);
            socket.pipe(target);
            target.pipe(socket);
          });

          target.on("error", () => {
            try {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            } catch {}
            socket.destroy();
          });

          socket.on("error", () => target.destroy());
          state = "CONNECTED";
        }
      } catch {
        socket.destroy();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startPacServer(initialReturn = "DIRECT") {
  let pacReturn = initialReturn;
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const pacScript = `function FindProxyForURL(url, host) { return "${pacReturn}"; }`;
    res.writeHead(200, {
      "Content-Type": "application/x-ns-proxy-autoconfig",
      "Cache-Control": "no-cache, no-store",
    });
    res.end(pacScript);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    pacUrl: `http://127.0.0.1:${port}/proxy.pac`,
    requests,
    setPacReturn(value) {
      pacReturn = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function getDeadPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}
