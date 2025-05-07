import { McpAgent } from "agents/mcp"; // Assuming McpAgent is available via this path as per the example.
                                        // This might be a project-local base class or an alias to an SDK import.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our DGIdb MCP agent
export class DGIdbMCP extends McpAgent {
	server = new McpServer({
		name: "DGIdbExplorer",
		version: "0.1.0",
		description: "MCP Server for querying the DGIdb (Drug Gene Interaction Database) GraphQL API. DGIdb provides data on drug-gene interactions, drug attributes, and gene druggability annotations, aggregated from multiple sources."
	});

	// DGIdb API Configuration
	private readonly DGIDB_GRAPHQL_ENDPOINT = 'https://dgidb.org/api/graphql';

	async init() {
		console.error("DGIdb MCP Server initialized.");

		// Register the GraphQL execution tool
		this.server.tool(
			"dgidb_graphql_query",
			"Executes a GraphQL query against the Drug Gene Interaction Database (DGIdb) API (https://dgidb.org/api/graphql). " +
			"DGIdb consolidates information on drug-gene interactions and gene druggability from over 40 sources. Use this tool to:\n" +
			"1. Identify drug-gene interactions: Find genes interacting with specific drugs or drugs interacting with specific genes.\n" +
			"   Example for drugs: '{ drugs(names: [\"DOVITINIB\"]) { nodes { interactions { gene { name } interactionScore interactionTypes { type } } } } }'\n" +
			"   Example for genes: '{ genes(names: [\"BRAF\"]) { nodes { interactions { drug { name } interactionScore interactionTypes { type } } } } }'\n" +
			"2. Retrieve drug attributes: Get information about drugs, including approval status, aliases, and other attributes.\n" +
			"   Example: '{ drugs(names: [\"IMATINIB\"]) { nodes { name approved drugAttributes { name value } } } }'\n" +
			"3. Explore gene annotations: Find annotations for genes related to druggability and clinical actionability.\n" +
			"   Example: '{ genes(names: [\"BRAF\"]) { nodes { longName geneCategoriesWithSources { name sourceNames } } } }'\n" +
			"4. Paginate through records: Use cursor-based pagination for drugs or genes.\n" +
			"   Example: '{ drugs(first:10, after:\"someCursor\") { pageInfo { endCursor hasNextPage } edges { node { name } } } }'\n" +
			"Use GraphQL introspection for schema discovery: '{ __schema { queryType { name } types { name kind description fields { name args { name type { name ofType { name } } } } } } }'. " +
			"Refer to the DGIdb API documentation (schema provided via GraphiQL at the endpoint) for more details. If a query fails, check the syntax and retry with introspection.",
			{
				query: z.string().describe(
					"The GraphQL query string to execute against the DGIdb API. " +
					"Example: '{ genes(names: [\"BRAF\"]) { nodes { interactions { drug { name conceptId } } } } }'. " +
					"Use introspection queries like '{ __schema { queryType { name } types { name kind } } }' to discover the schema."
				),
				variables: z.record(z.any()).optional().describe(
					"Optional dictionary of variables for the GraphQL query. " +
					"Example: { \"geneNamesArray\": [\"BRAF\", \"EGFR\"] } to be used in a query like 'query($geneNamesArray: [String!]) { genes(names: $geneNamesArray) { ... } }'."
				),
			},
			async ({ query, variables }: { query: string; variables?: Record<string, any> }) => {
				console.error(`Executing dgidb_graphql_query with query: ${query.slice(0, 200)}...`);
				if (variables) {
					console.error(`With variables: ${JSON.stringify(variables).slice(0,150)}...`);
				}

				const result = await this.executeDGIdbGraphQLQuery(query, variables);

				return {
					content: [{
						type: "text",
						// Pretty print JSON for easier reading by humans, and parsable by LLMs.
						text: JSON.stringify(result, null, 2)
					}]
				};
			}
		);
	}

	// Helper function to execute DGIdb GraphQL queries
	private async executeDGIdbGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": "MCPDGIdbServer/0.1.0 (ModelContextProtocol; +https://modelcontextprotocol.io)"
			};

			const bodyData: Record<string, any> = { query };
			if (variables) {
				bodyData.variables = variables;
			}

			console.error(`Making GraphQL request to: ${this.DGIDB_GRAPHQL_ENDPOINT}`);
			// console.error(`Request body: ${JSON.stringify(bodyData)}`); // Potentially too verbose for production logs

			const response = await fetch(this.DGIDB_GRAPHQL_ENDPOINT, {
				method: 'POST',
				headers,
				body: JSON.stringify(bodyData),
			});

			console.error(`DGIdb API response status: ${response.status}`);

			let responseBody;
			try {
				responseBody = await response.json();
			} catch (e) {
				// If JSON parsing fails, try to get text for error reporting
				const errorText = await response.text();
				console.error(`DGIdb API response is not JSON. Status: ${response.status}, Body: ${errorText.slice(0,500)}`);
				return {
					errors: [{
						message: `DGIdb API Error ${response.status}: Non-JSON response.`,
						extensions: {
							statusCode: response.status,
							responseText: errorText.slice(0, 1000) // Truncate long non-JSON responses
						}
					}]
				};
			}

			if (!response.ok) {
				console.error(`DGIdb API HTTP Error ${response.status}: ${JSON.stringify(responseBody)}`);
				// Structure this similar to a GraphQL error response
				return {
					errors: [{
						message: `DGIdb API HTTP Error ${response.status}`,
						extensions: {
							statusCode: response.status,
							responseBody: responseBody
						}
					}]
				};
			}

			// If response.ok, responseBody contains the GraphQL result (which might include a `data` and/or `errors` field)
			return responseBody;

		} catch (error) {
			// This catch block handles network errors or other issues with the fetch call itself
			console.error(`Client-side error during DGIdb GraphQL request: ${error instanceof Error ? error.message : String(error)}`);
			let errorMessage = "An unexpected client-side error occurred while attempting to query the DGIdb GraphQL API.";
			if (error instanceof Error) {
					errorMessage = error.message;
			} else {
					errorMessage = String(error);
			}
			return {
				errors: [{
					message: errorMessage,
                    extensions: {
                        clientError: true // Custom extension to indicate client-side nature of the error
                    }
				}]
			};
		}
	}
}

// Define the Env interface for environment variables, if any.
// For this server, no specific environment variables are strictly needed for DGIdb API access.
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
}

// Dummy ExecutionContext for type compatibility, usually provided by the runtime environment.
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

// Export the fetch handler, standard for environments like Cloudflare Workers or Deno Deploy.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// SSE transport is primary as requested
		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// The static `serveSSE` method is assumed to be provided by McpAgent or a similar mechanism
			// It typically initializes an agent instance (calling its async init) and returns
			// an object (like an McpServer instance or a handler) with a .fetch method.
            // @ts-ignore - This pattern is from the example, assuming McpAgent or the SDK handles it.
			return DGIdbMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		// Fallback for unhandled paths
		console.error(`DGIdb MCP Server. Requested path ${url.pathname} not found. Listening for SSE on /sse.`);

		return new Response(
			`DGIdb MCP Server - Path not found.\nAvailable MCP paths:\n- /sse (for Server-Sent Events transport)`,
			{
				status: 404,
				headers: { "Content-Type": "text/plain" }
			}
		);
	},
};

// Export the Durable Object class (or main class for other environments)
// This follows the pattern in the DataCite example (e.g., for Cloudflare Workers Durable Objects).
export { DGIdbMCP as MyMCP };