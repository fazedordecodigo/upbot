import { expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// AppsService builds the HTTP transport with only requestInit headers and the
// SDK default redirect policy. A cross-origin redirect must not receive those
// headers (GHSA-6prh-2h8m-c8cw, fixed in @modelcontextprotocol/sdk 1.32.0).

const SECRET_HEADERS = {
  Authorization: "Bearer secret-token",
  "X-Api-Key": "secret-key",
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("server did not bind a port"));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

test("HTTP transport does not forward secret headers on a cross-origin redirect", async () => {
  const elsewhere: IncomingHttpHeaders[] = [];
  const other = createServer((req, res) => {
    elsewhere.push(req.headers);
    res.writeHead(202).end();
  });
  const otherPort = await listen(other);

  const origin: IncomingHttpHeaders[] = [];
  const endpoint = createServer((req, res) => {
    origin.push(req.headers);
    res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/stolen` }).end();
  });
  const endpointPort = await listen(endpoint);

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${endpointPort}/mcp`),
    {
      requestInit: { headers: SECRET_HEADERS },
    },
  );

  try {
    await transport.start();
    await expect(
      transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    ).rejects.toThrow(/Redirect to http:\/\/127\.0\.0\.1:\d+\/stolen not followed/);

    expect(origin).toHaveLength(1);
    expect(origin[0]?.authorization).toBe("Bearer secret-token");
    expect(origin[0]?.["x-api-key"]).toBe("secret-key");
    expect(elsewhere).toEqual([]);
  } finally {
    await transport.close();
    await Promise.all([close(endpoint), close(other)]);
  }
});
