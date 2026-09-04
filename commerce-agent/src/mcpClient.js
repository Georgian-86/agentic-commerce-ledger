// Thin wrapper around a real MCP client connection to catalog-server.
// The Shopper Agent never talks to the catalog over plain REST — it
// goes through this MCP client, exactly as an external agent would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CATALOG_URL = process.env.CATALOG_SERVER_URL || "http://localhost:4100/mcp";

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "commerce-agent", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(CATALOG_URL));
      await client.connect(transport);
      return client;
    })();
  }
  return clientPromise;
}

async function callTool(name, args) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : null;
  if (result.isError) {
    const err = new Error(parsed?.error || "mcp_tool_error");
    err.details = parsed;
    throw err;
  }
  return parsed;
}

export const catalog = {
  search: (args) => callTool("search_products", args),
  getProduct: (product_id) => callTool("get_product", { product_id }),
  checkInventory: (product_id, qty = 1) => callTool("check_inventory", { product_id, qty }),
  getPolicy: (topic) => callTool("get_policies", { topic }),
  getRelated: (product_id) => callTool("get_related_products", { product_id }),
};

/** Admin-only path to the catalog's plain debug endpoint — never exposed as an LLM tool. */
export async function debugSetStock(product_id, qty) {
  const base = CATALOG_URL.replace(/\/mcp$/, "");
  const res = await fetch(`${base}/debug/set-stock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product_id, qty }),
  });
  return res.json();
}
