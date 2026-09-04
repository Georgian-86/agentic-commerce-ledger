// Catalog & Policy MCP Server
// Makes the merchant "agent-readable": a real MCP server (JSON-RPC 2.0
// over Streamable HTTP), not a REST API pretending to be one. Any
// standard MCP client (including the MCP Inspector) can connect to
// http://localhost:<port>/mcp and call these tools directly.
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  products,
  getProduct,
  searchProducts,
  checkInventory,
  getPolicy,
  getRelatedProducts,
  setStock,
} from "./catalog-data.js";

const PORT = Number(process.env.CATALOG_SERVER_PORT || 4100);

function buildServer() {
  const server = new McpServer({ name: "catalog-server", version: "0.1.0" });

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the merchant's catalog by free-text query, optional category, and optional max price (in paise). Returns matching products with id, name, price_paise, stock_qty and a short description.",
      inputSchema: {
        query: z.string().default("").describe("Free text search, e.g. 'earbuds' or 'gift under 1500'"),
        category: z.enum(["audio", "home", "apparel", "gifting"]).optional(),
        max_price_paise: z.number().int().positive().optional(),
      },
    },
    async ({ query, category, max_price_paise }) => {
      const results = searchProducts({ query, category, max_price_paise }).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        price_paise: p.price_paise,
        stock_qty: p.stock_qty,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, results }) }] };
    }
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product detail",
      description: "Fetch full detail for one product by id, including its related SKUs.",
      inputSchema: { product_id: z.string() },
    },
    async ({ product_id }) => {
      const product = getProduct(product_id);
      if (!product) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "not_found", product_id }) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(product) }] };
    }
  );

  server.registerTool(
    "check_inventory",
    {
      title: "Check inventory",
      description: "Check whether a given quantity of a product is currently in stock.",
      inputSchema: { product_id: z.string(), qty: z.number().int().positive().default(1) },
    },
    async ({ product_id, qty }) => {
      const result = checkInventory(product_id, qty);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "get_policies",
    {
      title: "Get merchant policy",
      description: "Get the merchant's plain-text policy for a topic: returns, shipping, or warranty.",
      inputSchema: { topic: z.enum(["returns", "shipping", "warranty"]) },
    },
    async ({ topic }) => {
      const text = getPolicy(topic);
      if (!text) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "unknown_topic", topic }) }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify({ topic, policy: text }) }] };
    }
  );

  server.registerTool(
    "get_related_products",
    {
      title: "Get related products",
      description: "Get up to 3 products related to a given product id, each with a short reason — used for upsell/cross-sell suggestions.",
      inputSchema: { product_id: z.string() },
    },
    async ({ product_id }) => {
      const related = getRelatedProducts(product_id);
      return { content: [{ type: "text", text: JSON.stringify({ product_id, related }) }] };
    }
  );

  server.registerResource(
    "full-catalog",
    "catalog://full",
    { title: "Full catalog", description: "The entire product catalog as structured JSON.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(products, null, 2) }],
    })
  );

  return server;
}

/** Build the catalog Express app. Exported so the commerce-agent can
 *  run it in-process for a single-service deployment (EMBED_CATALOG),
 *  while `npm run dev` still starts it as its own process. */
export function buildCatalogApp() {
  const app = express();
  app.use(express.json());

  // Stateless Streamable HTTP MCP endpoint: one transport per request,
  // per the SDK's documented stateless pattern. Simple, and enough for
  // a hackathon-scale demo (no cross-request session state needed).
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[catalog-server] MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  // Plain debug/admin route — deliberately NOT an MCP tool, so the
  // shopper-facing LLM can never call it. Used to trigger the
  // stock-out scenario live during the demo.
  app.post("/debug/set-stock", (req, res) => {
    const { product_id, qty } = req.body || {};
    if (!product_id || typeof qty !== "number") {
      return res.status(400).json({ error: "product_id and numeric qty are required" });
    }
    const ok = setStock(product_id, qty);
    if (!ok) return res.status(404).json({ error: "unknown_product", product_id });
    console.log(`[catalog-server] DEBUG: stock for ${product_id} set to ${qty}`);
    res.json({ ok: true, product_id, qty });
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "catalog-server", skus: products.length }));

  return app;
}

/**
 * Start the catalog server on its own listener. In embedded mode the
 * commerce-agent calls this bound to 127.0.0.1 (loopback only — the
 * catalog is reached through the public commerce-agent, never directly
 * in a single-service deploy).
 */
export function startCatalogServer({ port = PORT, host = process.env.CATALOG_HOST || "0.0.0.0" } = {}) {
  return new Promise((resolve) => {
    const app = buildCatalogApp();
    const server = app.listen(port, host, () => {
      console.log(`[catalog-server] listening on http://${host}:${port}`);
      console.log(`[catalog-server] MCP endpoint:   http://${host}:${port}/mcp`);
      console.log(`[catalog-server] ${products.length} SKUs loaded`);
      resolve(server);
    });
  });
}

// Run standalone when invoked directly (`node src/index.js` / `npm run dev`).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) startCatalogServer();
