import { McpAgent } from "agents/mcp"; // Assuming McpAgent is available
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js"; // Import the shared Durable Object

// ========================================
// API CONFIGURATION - DGIdb Specific
// ========================================
const API_CONFIG = {
	name: "DGIdbExplorer",
	version: "0.1.1", // Version updated
	description: "MCP Server for querying the DGIdb GraphQL API, converting responses to queryable SQLite tables, and executing SQL against them.",
	
	// GraphQL API settings
	endpoint: 'https://dgidb.org/api/graphql',
	headers: {
		// DGIdb doesn't require a specific Accept header for versioning.
		// Content-Type will be added by executeGraphQLQuery.
		"User-Agent": "MCPDGIdbServer/0.1.1 (ModelContextProtocol; +https://modelcontextprotocol.io)"
	},
	
	// Tool names and descriptions
	tools: {
		graphql: {
			name: "dgidb_graphql_query",
			description: "Executes GraphQL queries against the DGIdb API, processes responses into SQLite tables, and returns metadata for subsequent SQL querying. Returns a data_access_id and schema information. " +
			"DGIdb consolidates information on drug-gene interactions and gene druggability. Use this tool to:\n" +
			"1. Identify drug-gene interactions.\n" +
			"2. Retrieve drug attributes.\n" +
			"3. Explore gene annotations.\n" +
			"4. Paginate through records.\n" +
			"Use GraphQL introspection for schema discovery: '{ __schema { ... } }'. Refer to DGIdb API documentation (GraphiQL at the endpoint)."
		},
		sql: {
			name: "dgidb_query_sql", 
			description: "Execute read-only SQL queries against staged data from DGIdb. Use the data_access_id from dgidb_graphql_query to query the SQLite tables."
		}
	}
};

// ========================================
// CORE MCP SERVER CLASS - Adapted for DGIdb
// ========================================

// Environment storage for tool access
let currentEnvironment: Env | null = null;

function setGlobalEnvironment(env: Env) {
	currentEnvironment = env;
}

function getGlobalEnvironment(): Env | null {
	return currentEnvironment;
}

export class DGIdbMCP extends McpAgent {
	server = new McpServer({
		name: API_CONFIG.name,
		version: API_CONFIG.version,
		description: API_CONFIG.description
	});

	async init() {
		console.log(`${API_CONFIG.name} MCP Server initializing...`);

		// Tool #1: GraphQL to SQLite staging
		this.server.tool(
			API_CONFIG.tools.graphql.name,
			API_CONFIG.tools.graphql.description,
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
			async ({ query, variables }) => {
				try {
					console.log(`Executing ${API_CONFIG.tools.graphql.name} with query: ${query.slice(0, 200)}...`);
					if (variables) {
						console.log(`With variables: ${JSON.stringify(variables).slice(0,150)}...`);
					}

					const graphqlResult = await this.executeGraphQLQuery(query, variables);
					
					// If GraphQL response indicates errors and no data, return that directly.
					// DGIdb might return errors alongside partial data, so only block if *no* data.
					if (graphqlResult.errors && !graphqlResult.data) {
						console.error("GraphQL query returned errors and no data:", JSON.stringify(graphqlResult.errors, null, 2));
						return { content: [{ type: "text" as const, text: JSON.stringify(graphqlResult, null, 2) }] };
					}
					
					// Proceed to stage data. The DO can handle jsonData.data or jsonData directly.
					const stagingResult = await this.stageDataInDurableObject(graphqlResult);
					return { content: [{ type: "text" as const, text: JSON.stringify(stagingResult, null, 2) }] };
					
				} catch (error) {
					console.error(`Error in ${API_CONFIG.tools.graphql.name}:`, error);
					return this.createErrorResponse("GraphQL execution or data staging failed", error);
				}
			}
		);

		// Tool #2: SQL querying against staged data
		this.server.tool(
			API_CONFIG.tools.sql.name,
			API_CONFIG.tools.sql.description,
			{
				data_access_id: z.string().describe("Data access ID obtained from the GraphQL query tool execution."),
				sql: z.string().describe("SQL SELECT query to execute against the staged data."),
				// params: z.array(z.string()).optional().describe("Optional query parameters (currently not used by DO, pass directly in SQL string)"),
			},
			async ({ data_access_id, sql }) => { 
				try {
					console.log(`Executing ${API_CONFIG.tools.sql.name} for data_access_id: ${data_access_id}`);
					const queryResult = await this.executeSQLQuery(data_access_id, sql);
					return { content: [{ type: "text" as const, text: JSON.stringify(queryResult, null, 2) }] };
				} catch (error) {
					console.error(`Error in ${API_CONFIG.tools.sql.name}:`, error);
					return this.createErrorResponse("SQL execution failed", error);
				}
			}
		);
		console.log(`${API_CONFIG.name} MCP Server initialized with tools.`);
	}

	// ========================================
	// GRAPHQL CLIENT - Using API_CONFIG
	// ========================================
	private async executeGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		const headers = {
			"Content-Type": "application/json",
			...API_CONFIG.headers // Includes User-Agent from API_CONFIG
		};
		
		const body = { query, ...(variables && { variables }) };
		
		console.log(`Making GraphQL request to: ${API_CONFIG.endpoint}`);
		const response = await fetch(API_CONFIG.endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		
		console.log(`DGIdb API response status: ${response.status}`);

		let responseBody: { errors?: any[]; data?: any } = {};
		const contentType = response.headers.get("content-type");

		if (contentType && contentType.includes("application/json")) {
			try {
				responseBody = await response.json();
			} catch (e) {
				const errorText = await response.text(); // Attempt to get text if JSON parsing failed
				console.error(`DGIdb API response: JSON parsing failed despite content-type. Status: ${response.status}, Body: ${errorText.slice(0,500)}`);
				// This indicates a severe issue with the API response or network. Throw an error.
				throw new Error(`HTTP ${response.status}: Failed to parse JSON response. Body (truncated): ${errorText.slice(0, 200)}`);
			}
		} else {
			// Handle non-JSON responses by returning an error object similar to GraphQL errors
			const errorText = await response.text();
			console.error(`DGIdb API response is not JSON. Status: ${response.status}, Content-Type: ${contentType}, Body: ${errorText.slice(0,500)}`);
			return { 
				errors: [{ 
					message: `DGIdb API Error ${response.status}: Expected JSON response, got ${contentType || 'unknown'}.`,
					extensions: {
						statusCode: response.status,
						responseText: errorText.slice(0, 1000) // Truncate long non-JSON responses
					}
				}]
			};
		}

		if (!response.ok) {
			// responseBody here would be the parsed JSON error from the API (if it sent one)
			console.error(`DGIdb API HTTP Error ${response.status}: ${JSON.stringify(responseBody)}`);
            // Return the body as it might contain GraphQL error details.
            // Ensure it's structured with an 'errors' array if possible for consistency.
            if (responseBody && responseBody.errors) {
                return responseBody; // API returned a valid GraphQL error structure
            }
			return { 
				errors: [{ 
					message: `DGIdb API HTTP Error ${response.status}`,
					extensions: {
						statusCode: response.status,
						responseBody: responseBody || "No error body from API or body was not parseable JSON."
					}
				}]
			};
		}
		
		// If response.ok, responseBody contains the GraphQL result (which might include data and/or errors field)
		return responseBody; 
	}
	// ========================================
	// DURABLE OBJECT INTEGRATION - Reusable methods
	// ========================================
	private async stageDataInDurableObject(graphqlResult: any): Promise<any> {
		const env = this.env as Env;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available in environment. Check Cloudflare worker configuration (e.g., wrangler.toml).");
		}
		
		const accessId = crypto.randomUUID();
		const doId = env.JSON_TO_SQL_DO.idFromName(accessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		console.log(`Staging data in Durable Object for data_access_id: ${accessId}`);
		const doResponse = await stub.fetch("http://do/process", { // Fixed internal URL for the DO's process endpoint
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(graphqlResult) // Send the whole GraphQL result
		});
		
		if (!doResponse.ok) {
			const errorText = await doResponse.text();
			console.error(`Durable Object data staging failed with status ${doResponse.status}: ${errorText}`);
			throw new Error(`Durable Object data staging failed: ${errorText}`);
		}
		
		const processingResult = await doResponse.json();
		console.log("Durable Object processing successful. Details:", JSON.stringify(processingResult, null, 2));
		return {
			data_access_id: accessId,
			processing_details: processingResult // This will contain schemas, counts, etc., from the DO
		};
	}

	private async executeSQLQuery(dataAccessId: string, sql: string): Promise<any> {
		const env = this.env as Env;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available in environment. Check Cloudflare worker configuration (e.g., wrangler.toml).");
		}
		
		const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId); // Use data_access_id to target the correct DO instance
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		console.log(`Executing SQL query in Durable Object for data_access_id: ${dataAccessId}`);
		const doResponse = await stub.fetch("http://do/query", { // Fixed internal URL for DO's query endpoint
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql }) // The DO's /query endpoint expects an object with a 'sql' key
		});
		
		if (!doResponse.ok) {
			const errorText = await doResponse.text();
			console.error(`Durable Object SQL execution failed with status ${doResponse.status}: ${errorText}`);
			throw new Error(`Durable Object SQL execution failed: ${errorText}`);
		}
		
		return await doResponse.json();
	}

	// ========================================
	// ERROR HANDLING - Reusable method
	// ========================================
	private createErrorResponse(message: string, error: unknown) {
		const details = error instanceof Error ? error.message : String(error);
		// Log the full error server-side for diagnostics
		if (error instanceof Error && error.stack) {
			console.error(`Error Response Created: ${message} - Details: ${details}\nStack: ${error.stack}`);
		} else {
			console.error(`Error Response Created: ${message} - Details: ${details}`);
		}
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					error: message,
					details: details
				}, null, 2)
			}]
		};
	}
}

// ========================================
// CLOUDFLARE WORKERS BOILERPLATE - Adapted for DGIdb
// ========================================
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
	JSON_TO_SQL_DO: DurableObjectNamespace; // Crucial: Durable Object binding
}

// ExecutionContext is typically provided by the Cloudflare Workers runtime
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		setGlobalEnvironment(env); // Make environment (including DO binding) accessible globally within this request context

		// Debug endpoint to check environment bindings
		if (url.pathname === "/debug") {
			const envInfo = {
				hasJSONToSQLDO: !!env.JSON_TO_SQL_DO,
				globalEnv: !!getGlobalEnvironment(),
				globalEnvHasBinding: !!getGlobalEnvironment()?.JSON_TO_SQL_DO,
				envKeys: Object.keys(env)
			};
			return new Response(JSON.stringify(envInfo, null, 2), {
				headers: { "Content-Type": "application/json" }
			});
		}

		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// @ts-ignore - Assuming McpAgent or SDK provides serveSSE and it handles its own instance creation
			return DGIdbMCP.serveSSE("/sse").fetch(request, env, ctx);
		}
		
		console.log(`${API_CONFIG.name} - Requested path ${url.pathname} not found. MCP Server listening for SSE on /sse.`);
		return new Response(
			`${API_CONFIG.name} - MCP Server. Path not found.\nAvailable MCP paths:\n- /sse (for Server-Sent Events transport)\n- /debug (for environment debugging)`, 
			{ status: 404, headers: { "Content-Type": "text/plain" } }
		);
	},
};

// Export the MCP Agent class (e.g., for direct instantiation or other uses if any)
export { DGIdbMCP as MyMCP };

// Export the Durable Object class. This is essential for Cloudflare Workers to recognize and manage the DO.
// This line assumes that 'do.ts' (which defines JsonToSqlDO) is in the same 'src' directory
// or that the module resolution path is configured correctly.
export { JsonToSqlDO };