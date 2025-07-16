import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Interaction {
  /** Raw interaction score from the API (may be missing). */
  interactionScore?: number;
  /** Any additional fields returned by the API. */
  [key: string]: unknown;
}

export interface GeneNode {
  /** Gene (or molecular profile) name. */
  name: string;
  /** Array of interaction objects. */
  interactions: Interaction[];
  /** Any other fields returned by the API. */
  [key: string]: unknown;
}

/* ---------- 1. filterInteractionScore ---------- */

/**
 * Return the top N interactions sorted by highest `interactionScore`.
 *
 * @param interactions - Array of interaction objects.
 * @param N            - Maximum number to return (default 20).
 */
export function filterInteractionScore(
  interactions: Interaction[],
  N = 20
): Interaction[] {
  return [...interactions]                                  // copy so caller’s array stays untouched
    .sort(
      (a, b) =>
        (b.interactionScore ?? 0) - (a.interactionScore ?? 0)
    )
    .slice(0, N);
}

/* ---------- 2. findBestNode ---------- */

/**
 * Pick the “best” node, preferring an exact (case‑insensitive) name match;
 * otherwise return the node with the most interactions.
 *
 * @param nodes - Array of gene nodes.
 * @param term  - Name to match against `node.name`.
 * @returns     - The best‐matching node, or `undefined` if `nodes` is empty.
 */
export function findBestNode(
  nodes: GeneNode[],
  term: string
): GeneNode | undefined {
  if (nodes.length === 0) return undefined;

  const lowerTerm = term.toLowerCase();
  let bestNode: GeneNode = nodes[0];
  let largestSize = bestNode.interactions.length;

  for (const node of nodes) {
    // 1) Exact case‑insensitive match wins immediately
    if (node.name.toLowerCase() === lowerTerm) return node;

    // 2) Otherwise keep track of the node with the most interactions
    if (node.interactions.length > largestSize) {
      bestNode = node;
      largestSize = node.interactions.length;
    }
  }
  return bestNode;
}

// ========================================
// API CONFIGURATION - Customize for your GraphQL API
// ========================================

export const API_CONFIG = {
  name:        "DGIdbExplorer",
  version:     "0.1.0",
  description: "Fixed‑schema MCP tools for the DGI GraphQL API",
  mcpSpecVersion: "2025-06-18",
  features: {
    structuredToolOutput: true,
    metaFields:           true,
    protocolVersionHeaders: true,
    titleFields:          true,
    toolAnnotations:      true,
  },
  headers: {
    "User-Agent": "MCPDGIdbServer/0.1.0"
  },
} as const;


/** -----------------------------------------------------------------
 *  Tool definitions
 *  ---------------------------------------------------------------- */

export const tools = {
  getGeneInteractionsForDrug: {
    name: "get_gene_interactions_for_drug",
    description:
      "Return up to 20 genes that interact with the provided drug",
    inputSchema: {drugName: z.string()},
    annotations: {
      destructive: false,
      idempotent:  true,
      cacheable:   false,
      world_interaction: "open",
      side_effects: ["external_api_calls"],
      resource_usage: "network_io_heavy",
    },

    async handler(
  		{ drugName }: { drugName: string }  // <- matches schema
	) {

		const query = /* GraphQL */ `
			query drugs($name: String!) {
				drugs(name: $name) {
				nodes {
					name
					interactions {
						gene {
							name
						}
						interactionScore
						interactionTypes {
							type
							directionality
						}
					}
				}
			}
			}`;

			const res = await fetch("https://dgidb.org/api/graphql", {
					method: "POST",
					headers: { "Content-Type": "application/json", ...API_CONFIG.headers },
					body: JSON.stringify({ query, variables: { name: drugName } })
				}).then(r => r.json()) as {
					data?: { drugs?: { nodes: { name: string; interactions: any[] }[] } };
					errors?: unknown[];
				};

			// ✅ If no data, wrap in a content-based return for MCP compliance
			if (!res.data?.drugs) {
				return {
				isError: true,
				content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }]
				};
			}

			const nodes = res.data.drugs.nodes ?? [];
			const selectedNode = findBestNode(nodes, drugName);

			if (!selectedNode) {
				return {
				isError: true,
				content: [
					{ type: "text" as const, text: `No drug node found for "${drugName}".` }
			]
			};
		}

		const filtered = filterInteractionScore(selectedNode.interactions, 10);

		//selectedNode.interactions = filterInteractionScore(selectedNode.interactions, 10);

		return {
			content: [
			{ type: "text" as const, text: JSON.stringify({
				drug:        selectedNode.name, // keep if you want the name
				interactions: filtered          // just the top‑10 interactions
				}, null, 2) }
			],
			_meta: {
			interaction_count: selectedNode.interactions.length,
			total_nodes: nodes.length
			}
		};
	},
}, 

  getDrugInteractionsForGene: {
    name: "get_drug_interactions_for_gene",
    description:
      "Return up to 20 drugs that interact with the provided gene",
    inputSchema: {geneName: z.string()},
    annotations: {
      destructive: false,
      idempotent:  true,
      cacheable:   false,
      world_interaction: "open",
      side_effects: ["external_api_calls"],
      resource_usage: "network_io_heavy",
    },

    async handler(
  		{ geneName }: { geneName: string }  // <- matches schema
	) {

		const query = /* GraphQL */ `
			query genes($name: String!) {
				genes(name: $name) {
					nodes {
						name
						interactions {
							drug {
								name
							}
							interactionScore
							interactionTypes {
								type
								directionality
							}
						}
					}
				}
			}`;

			const res = await fetch("https://dgidb.org/api/graphql", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...API_CONFIG.headers },
				body: JSON.stringify({ query, variables: { name: geneName } })
			}).then(r => r.json()) as {
				data?: { genes?: { nodes: { name: string; interactions: any[] }[] } };
				errors?: unknown[];
			};

		// ✅ If no data, wrap in a content-based return for MCP compliance
		if (!res.data?.genes) {
			return {
			isError: true,
			content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }]
			};
		}

		const nodes = res.data.genes.nodes ?? [];
		const selectedNode = findBestNode(nodes, geneName);

		if (!selectedNode) {
			return {
			isError: true,
			content: [
				{ type: "text" as const, text: `No gene node found for "${geneName}".` }
		]
		};
	}

	//selectedNode.interactions = filterInteractionScore(selectedNode.interactions, 10);

	const filtered = filterInteractionScore(selectedNode.interactions, 10);

	return {
		content: [
		{ type: "text" as const, text: JSON.stringify({
          gene:        selectedNode.name, // keep if you want the name
          interactions: filtered          // just the top‑10 interactions
        }, null, 2) }
		],
		_meta: {
		interaction_count: selectedNode.interactions.length,
		total_nodes: nodes.length
		}
	};
	},
	},

} as const;



// -------------------------------------------------------------
// MCP SERVER (only the two fixed tools)
// -------------------------------------------------------------
class DgidbMCP extends McpAgent {
  server = new McpServer({
    name:        API_CONFIG.name,
    version:     API_CONFIG.version,
    description: API_CONFIG.description,},
    
    {
    instructions: `
	Use the tools to find drug-gene interactions with the Drug-Gene Interaction Database (DGIdb).
    `,
  });

  async init() {
    /* register fixed-schema tools */
    const { getGeneInteractionsForDrug, getDrugInteractionsForGene } = tools;

    this.server.tool(
      getGeneInteractionsForDrug.name,
      getGeneInteractionsForDrug.description,
      getGeneInteractionsForDrug.inputSchema,
      getGeneInteractionsForDrug.handler,
    );

    this.server.tool(
      getDrugInteractionsForGene.name,
      getDrugInteractionsForGene.description,
      getDrugInteractionsForGene.inputSchema,
      getDrugInteractionsForGene.handler,
    );
  }
}

// -------------------------------------------------------------
// CLOUDFLARE WORKER RUNTIME (SSE only)
// -------------------------------------------------------------
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}



export default {
  async fetch(
    request: Request,
    env: Env,               // keep the typed Env like before
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    console.log(Object.keys(env));

    /* ────────────────────────────────────────────────
       SSE transport (Claude Desktop, Cursor, etc.)
    ─────────────────────────────────────────────────*/
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      // MCP 2025-06-18: client may send its protocol version
      const protocolVersion = request.headers.get("MCP-Protocol-Version");

      // @ts-ignore – serveSSE helper is mixed-in by DgidbMCP
      const response = await DgidbMCP.serveSSE("/sse").fetch(request, env, ctx);

      // Mirror the header back so the client sees what the server supports
      if (protocolVersion && response instanceof Response) {
        const headers = new Headers(response.headers);
        headers.set("MCP-Protocol-Version", protocolVersion);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      return response; // unchanged fallback
    }

    return new Response(
      `${API_CONFIG.name} – MCP Server ${API_CONFIG.version}. Use /sse for MCP transport.`,
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  }
};

// Export the class for tests if you like
export { DgidbMCP };